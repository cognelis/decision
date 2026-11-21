import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { LEGACY_SKILL, SKILL_FINGERPRINTS, type SkillFingerprint } from "./skill-fingerprints.js";

/** The clients Paraself ships its skills to: the two whose skill folders are documented and tested. */
export const SKILL_CLIENTS = ["codex", "claude-code"] as const;
export type SkillClient = (typeof SKILL_CLIENTS)[number];

export const isSkillClient = (id: string): id is SkillClient => (SKILL_CLIENTS as readonly string[]).includes(id);

/**
 * installed / updated / migrated: done (or, in a dry run, would be). unchanged: already this version. kept: a folder
 * by that name that is not a copy Paraself wrote (changed by the reader, another tool's, a link), left as it is.
 * legacy-kept: an old `decision-context` that cannot be told to be Paraself's, left beside the new one. failed: tried
 * and could not.
 */
export type SkillInstallStatus = "installed" | "updated" | "unchanged" | "kept" | "migrated" | "legacy-kept" | "failed";

export interface SkillInstallReport {
  client: SkillClient;
  skill: string;
  /** The folder, the home folder written as `~`. */
  path: string;
  status: SkillInstallStatus;
  detail?: string;
}

export interface SkillSyncOptions {
  /** The bundled skills folder: each skill a folder in it. */
  source: string;
  clients: readonly string[];
  mode: "dry-run" | "apply";
  environment?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
}

/** Where each client reads the reader's skills, and where an old copy of `decision-context` may have been put. */
export const skillLocations = (
  client: SkillClient,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { root: string; legacy: string[] } => {
  if (client === "codex") {
    const root = join(home, ".agents", "skills");
    return { root, legacy: [join(root, LEGACY_SKILL.from), join(environment.CODEX_HOME || join(home, ".codex"), "skills", LEGACY_SKILL.from)] };
  }
  const root = join(environment.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills");
  return { root, legacy: [join(root, LEGACY_SKILL.from)] };
};

// A skill holds a few small text files; anything larger in a folder by that name is not one of Paraself's.
const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 64;

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex");
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

type Inspection =
  | { state: "missing" }
  | { state: "files"; files: Record<string, string> }
  | { state: "foreign"; reason: string };

/** A folder's regular files by relative path (`/`-separated) and sha256; a link or anything else in it makes it foreign. */
const inspect = async (folder: string): Promise<Inspection> => {
  const top = await lstat(folder).catch((error: unknown) => (errorCode(error) === "ENOENT" ? null : Promise.reject(error)));
  if (top === null) return { state: "missing" };
  if (top.isSymbolicLink()) return { state: "foreign", reason: "是一个链接" };
  if (!top.isDirectory()) return { state: "foreign", reason: "不是文件夹" };
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<string | null> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) return "里面有链接";
      if (entry.isDirectory()) {
        const why = await walk(path);
        if (why !== null) return why;
        continue;
      }
      if (!entry.isFile()) return "里面有不是普通文件的条目";
      if (Object.keys(files).length >= MAX_SKILL_FILES) return "文件太多";
      const status = await lstat(path);
      if (status.size > MAX_SKILL_FILE_BYTES) return "里面有过大的文件";
      files[relative(folder, path).split(sep).join("/")] = sha256(await readFile(path));
    }
    return null;
  };
  const why = await walk(folder);
  return why === null ? { state: "files", files } : { state: "foreign", reason: why };
};

const sameFiles = (left: SkillFingerprint, right: SkillFingerprint): boolean => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

/** Paraself's own copy of one of its released versions: the same files, each with the same content, and nothing else. */
const isReleased = (skill: string, files: SkillFingerprint): boolean =>
  (SKILL_FINGERPRINTS[skill] ?? []).some((version) => sameFiles(version, files));

/** The bundle: each skill's files by relative path, as they are to be written. */
const readBundle = async (source: string): Promise<Map<string, Map<string, Buffer>>> => {
  const bundle = new Map<string, Map<string, Buffer>>();
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const files = new Map<string, Buffer>();
    const walk = async (directory: string): Promise<void> => {
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, child.name);
        if (child.isDirectory()) await walk(path);
        else if (child.isFile()) files.set(relative(join(source, entry.name), path).split(sep).join("/"), await readFile(path));
      }
    };
    await walk(join(source, entry.name));
    bundle.set(entry.name, files);
  }
  return bundle;
};

export const bundledSkillFingerprints = async (source: string): Promise<Record<string, SkillFingerprint>> =>
  Object.fromEntries([...(await readBundle(source))].map(([name, files]) => [name, Object.fromEntries([...files].map(([path, content]) => [path, sha256(content)]))]));

/**
 * Unlinks the files named, then the folders they were in, deepest first. It checks nothing itself: callers name only
 * files they wrote or have just verified (retire). Never a recursive removal: anything else in a folder makes its
 * rmdir fail, and that file and its folder stay.
 */
const removeKnown = async (folder: string, files: readonly string[]): Promise<void> => {
  const gone = (error: unknown) => (errorCode(error) === "ENOENT" ? undefined : Promise.reject(error));
  for (const file of files) await unlink(join(folder, ...file.split("/"))).catch(gone);
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    for (let depth = parts.length; depth > 0; depth -= 1) folders.add(parts.slice(0, depth).join("/"));
  }
  for (const inner of [...folders].sort((left, right) => right.split("/").length - left.split("/").length)) {
    await rmdir(join(folder, ...inner.split("/")));
  }
  await rmdir(folder);
};

const writeBundle = async (folder: string, files: Map<string, Buffer>): Promise<void> => {
  await mkdir(folder, { mode: 0o755 });
  for (const [path, content] of files) {
    const target = join(folder, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, content, { mode: 0o644, flag: "wx" });
  }
};

const tilde = (path: string, home: string): string =>
  home.length > 1 && (path === home || path.startsWith(`${home}${sep}`)) ? `~${path.slice(home.length)}` : path;

const inWords = (error: unknown): string => {
  switch (errorCode(error)) {
    case "EACCES":
    case "EPERM":
      return "没有写入这个文件夹的权限";
    case "EROFS":
      return "所在磁盘是只读的";
    case "ENOSPC":
    case "EDQUOT":
      return "磁盘空间不足";
    default:
      return error instanceof Error ? error.message : String(error);
  }
};

/**
 * A skill folder taken out of the way to be removed: moved first to a hidden name beside it, then checked there to be
 * exactly `expected`. Anything else (a file changed or added since it was first looked at) and it is moved back, or
 * left whole at the hidden name where its place was taken meanwhile: its contents are never removed unverified.
 * shortcut: a program still holding a file of it open and writing after the check (an editor's open buffer) is not
 * seen, and that write goes with the folder; no lock that editors honour exists to close this.
 */
const retire = async (folder: string, expected: SkillFingerprint): Promise<{ backup: string } | { kept: string }> => {
  const backup = join(dirname(folder), `.${folder.split(sep).at(-1)!}.paraself-old-${randomUUID()}`);
  await rename(folder, backup);
  const moved = await inspect(backup).catch((): Inspection => ({ state: "foreign", reason: "读不出来" }));
  if (moved.state === "files" && sameFiles(moved.files, expected)) return { backup };
  return rename(backup, folder).then(() => ({ kept: folder }), () => ({ kept: backup }));
};

/** The old copy's leftovers after it was verified: those that cannot go are said, never removed by force. */
const discard = async (backup: string, files: SkillFingerprint): Promise<string | undefined> =>
  removeKnown(backup, Object.keys(files)).then(() => undefined, () => `旧版本留在了 ${backup}，可以自行删除`);

const CHANGED_MEANWHILE = "检查之后它被改动过，这次没有写入，内容原样保留";

/**
 * One skill into one client's folder: written where none is, replaced where Paraself's own earlier version is, left
 * where the folder is anything else. The old version is replaced only once retire has checked it again, moved aside.
 */
const placeSkill = async (
  root: string,
  name: string,
  files: Map<string, Buffer>,
  mode: "dry-run" | "apply",
): Promise<{ status: SkillInstallStatus; detail?: string }> => {
  const target = join(root, name);
  const current = Object.fromEntries([...files].map(([path, content]) => [path, sha256(content)]));
  const before = await inspect(target);
  if (before.state === "foreign") return { status: "kept", detail: `${before.reason}，不是 Paraself 写入的，没有改动` };
  if (before.state === "files" && sameFiles(before.files, current)) return { status: "unchanged" };
  if (before.state === "files" && !isReleased(name, before.files)) {
    return { status: "kept", detail: "内容与 Paraself 发布过的任何版本都不同（被改过，或是别的同名技能），没有改动" };
  }
  const status = before.state === "missing" ? "installed" : "updated";
  if (mode === "dry-run") return { status };
  const staging = join(root, `.${name}.paraself-${randomUUID()}`);
  try {
    await writeBundle(staging, files);
  } catch (error) {
    await removeKnown(staging, [...files.keys()]).catch(() => undefined);
    throw error;
  }
  const dropStaging = () => removeKnown(staging, [...files.keys()]).catch(() => undefined);
  if (before.state === "missing") {
    try {
      // Onto nothing, or an empty folder made meanwhile; one with anything in it refuses the rename and stays.
      await rename(staging, target);
    } catch (error) {
      await dropStaging();
      if (errorCode(error) === "ENOTEMPTY" || errorCode(error) === "EEXIST") return { status: "kept", detail: CHANGED_MEANWHILE };
      throw error;
    }
    return { status };
  }
  let retired: Awaited<ReturnType<typeof retire>>;
  try {
    retired = await retire(target, before.files);
  } catch (error) {
    await dropStaging();
    throw error;
  }
  if ("kept" in retired) {
    await dropStaging();
    return { status: "kept", detail: retired.kept === target ? CHANGED_MEANWHILE : `${CHANGED_MEANWHILE}，原内容在 ${retired.kept}` };
  }
  try {
    await rename(staging, target);
  } catch (error) {
    await rename(retired.backup, target).catch(() => undefined);
    await dropStaging();
    throw error;
  }
  const left = await discard(retired.backup, before.files);
  return left === undefined ? { status } : { status, detail: left };
};

/**
 * Paraself's bundled skills into each named client's own skills folder (SKILL_CLIENTS only; any other client is
 * passed over). A dry run writes nothing and says what an apply would do. A legacy `decision-context` that is
 * byte for byte one Paraself shipped is taken away once its successor is in place; any other is left and said.
 */
export const syncBundledSkills = async (options: SkillSyncOptions): Promise<SkillInstallReport[]> => {
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const bundle = await readBundle(options.source);
  const reports: SkillInstallReport[] = [];
  for (const client of options.clients.filter(isSkillClient)) {
    const { root: given, legacy } = skillLocations(client, environment, home);
    // The folder itself may be the reader's link (dotfiles): followed once, to where it is; nothing under it is.
    // A folder that cannot be resolved (a link to itself, ELOOP) fails this client alone, in a dry run too: thrown,
    // the clients after it were not synced either.
    let root = given;
    try {
      root = await realpath(given).catch((error: unknown) => (errorCode(error) === "ENOENT" ? given : Promise.reject(error)));
      if (options.mode === "apply") await mkdir(root, { recursive: true, mode: 0o755 });
    } catch (error) {
      for (const name of bundle.keys()) reports.push({ client, skill: name, path: tilde(join(given, name), home), status: "failed", detail: inWords(error) });
      continue;
    }
    const placed = new Map<string, SkillInstallStatus>();
    for (const [name, files] of bundle) {
      const path = tilde(join(given, name), home);
      try {
        const result = await placeSkill(root, name, files, options.mode);
        placed.set(name, result.status);
        reports.push({ client, skill: name, path, ...result });
      } catch (error) {
        placed.set(name, "failed");
        reports.push({ client, skill: name, path, status: "failed", detail: inWords(error) });
      }
    }
    const successor = placed.get(LEGACY_SKILL.to);
    const successorReady = successor === "installed" || successor === "updated" || successor === "unchanged";
    for (const folder of [...new Set(legacy)]) {
      const path = tilde(folder, home);
      try {
        const found = await inspect(folder);
        if (found.state === "missing") continue;
        if (found.state === "files" && isReleased(LEGACY_SKILL.from, found.files) && successorReady) {
          if (options.mode === "apply") {
            const retired = await retire(folder, found.files);
            if ("kept" in retired) {
              reports.push({ client, skill: LEGACY_SKILL.from, path, status: "legacy-kept", detail: retired.kept === folder ? CHANGED_MEANWHILE : `${CHANGED_MEANWHILE}，原内容在 ${tilde(retired.kept, home)}` });
              continue;
            }
            const left = await discard(retired.backup, found.files);
            reports.push({ client, skill: LEGACY_SKILL.from, path, status: "migrated", detail: [`已由 ${LEGACY_SKILL.to} 取代`, ...(left === undefined ? [] : [left])].join("；") });
            continue;
          }
          reports.push({ client, skill: LEGACY_SKILL.from, path, status: "migrated", detail: `已由 ${LEGACY_SKILL.to} 取代` });
          continue;
        }
        reports.push({
          client,
          skill: LEGACY_SKILL.from,
          path,
          status: "legacy-kept",
          detail: found.state === "files" && isReleased(LEGACY_SKILL.from, found.files)
            ? `${LEGACY_SKILL.to} 没有装上，旧版先保留`
            : `核对不出是 Paraself 发布的版本（${found.state === "foreign" ? found.reason : "内容被改过"}），保留未动；它与 ${LEGACY_SKILL.to} 重复，不需要的话请自行删除`,
        });
      } catch (error) {
        reports.push({ client, skill: LEGACY_SKILL.from, path, status: "legacy-kept", detail: `读不出来（${inWords(error)}），保留未动` });
      }
    }
  }
  return reports;
};

/**
 * The clients these reports leave without this version's skills: one not written, or left as it was because it is no
 * longer exactly a Paraself release (changed by the reader, a file added to it, Finder's .DS_Store among them), or an
 * old decision-context that could not be taken away. Shown, never kept to a log.
 */
export const clientsBehindOnSkills = (reports: readonly SkillInstallReport[]): Set<SkillClient> =>
  new Set(reports.filter((report) => report.status === "failed" || report.status === "kept" || report.status === "legacy-kept").map((report) => report.client));

/** What a client's skills came to, for its line of the install report; nothing to say when every one is as it should be. */
export const skillSummary = (reports: readonly SkillInstallReport[], dryRun: boolean): string | undefined => {
  const verb: Partial<Record<SkillInstallStatus, string>> = dryRun
    ? { installed: "将安装", updated: "将更新", migrated: "将移除旧版" }
    : { installed: "已安装", updated: "已更新", migrated: "已移除旧版" };
  const parts = reports.flatMap((report) =>
    report.status === "unchanged" ? []
      : verb[report.status] !== undefined ? [`技能 ${report.skill} ${verb[report.status]!}${report.detail === undefined ? "" : `（${report.detail}）`}`]
      : [`技能 ${report.path} ${report.status === "failed" ? "没有写入" : "保留未动"}：${report.detail ?? "原因未知"}`]);
  return parts.length === 0 ? undefined : parts.join("；");
};
