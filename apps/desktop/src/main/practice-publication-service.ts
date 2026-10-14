import type {
  PracticeAssetRecord,
  PracticePublicationReceipt,
  PracticePublicationState,
  PracticePublicationStatus,
  PracticePublicationTarget,
} from "@cognelis/decision-core";
import { publishedPracticeAsset, publishedPracticeIdentity } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { atomicWrite } from "./atomic-write.js";

interface PracticeAssetSource {
  find(id: string): Promise<PracticeAssetRecord | null>;
  /** With the note as written, what the reader added in Obsidian is published too (see publishedPracticeAsset). */
  findNote?(id: string): Promise<{ record: PracticeAssetRecord; note: string } | null>;
}

interface PublicationVersion {
  version: number;
  publishedAt: string;
  sourceHash: string;
  publishedHash: string;
  previousExisted: boolean;
  /**
   * Where it was written. Worked out again from today's name and client folder, a skill renamed in Obsidian or a
   * client folder moved (CLAUDE_CONFIG_DIR) left its copy out of reach: reported missing, published a second
   * time beside it, never rolled back. Absent in manifests written before it was recorded (today's place then).
   */
  path?: string;
  /** The copy at an earlier place this version took over (backed up, removed): put back by its rollback. */
  movedFrom?: string;
}

interface PublicationHistory {
  assetId: string;
  target: PracticePublicationTarget;
  versions: PublicationVersion[];
}

interface PublicationManifest {
  version: 1;
  publications: Record<string, PublicationHistory>;
}

interface TargetInspection {
  state: "missing" | "file" | "unsafe";
  path: string;
  content: Buffer | null;
  reason: string | null;
}

interface PublicationSnapshot {
  asset: PracticeAssetRecord;
  note: string | null;
  sourceHash: string;
  history: PublicationHistory | null;
  latest: PublicationVersion | null;
  /** Where the skill goes now. */
  inspection: TargetInspection;
  /** Where the latest version was written, when that is somewhere else (see PublicationVersion.path). */
  recorded: TargetInspection | null;
  /** Decision's own copy of the next version, written by a publication cut short before its record was. */
  interrupted: boolean;
  status: PracticePublicationStatus;
}

export interface PracticePublicationServiceOptions {
  assets: PracticeAssetSource;
  stateRoot: string;
  targetRoots?: Partial<Record<PracticePublicationTarget, string>>;
  now?: () => Date;
  validateBeforePublish?: (asset: PracticeAssetRecord) => Promise<void>;
}

const TARGET_LABELS: Record<PracticePublicationTarget, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
};

/**
 * A refusal from the file system in the reader's words, naming the folder: Node's own read
 * "EACCES: permission denied, mkdir '…/.codex/skills'" (a client once run with sudo leaves its folder to root).
 */
const inReaderWords = (error: unknown): never => {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const path = typeof error === "object" && error !== null && "path" in error ? String(error.path) : "客户端文件夹";
  if (code === "EACCES" || code === "EPERM") {
    throw new Error(`没有权限写入 ${path}（比如曾用 sudo 运行过客户端，文件夹归了 root）。改好这个文件夹的权限后再试。`);
  }
  if (code === "EROFS") throw new Error(`${path} 所在的磁盘是只读的，无法写入。`);
  if (code === "ENOSPC" || code === "EDQUOT") throw new Error(`磁盘空间不足，无法写入 ${path}。清理空间后再试。`);
  throw error;
};

const defaultTargetRoots = (): Record<PracticePublicationTarget, string> => ({
  codex: join(homedir(), ".codex", "skills"),
  "claude-code": join(homedir(), ".claude", "skills"),
});

const emptyManifest = (): PublicationManifest => ({
  version: 1,
  publications: {},
});

const hash = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex");

const historyKey = (
  assetId: string,
  target: PracticePublicationTarget,
): string => `${target}:${assetId}`;

const backupStem = (key: string): string => hash(key).slice(0, 24);

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/**
 * One file under two spellings — a case-only difference on a case-insensitive volume (APFS), a linked folder above
 * the client root — is not two places: taken for a move, the publish took away the copy it had just written there.
 */
const sameFile = async (left: string, right: string): Promise<boolean> => {
  const [one, other] = await Promise.all([lstat(left).catch(() => null), lstat(right).catch(() => null)]);
  return one !== null && other !== null && one.dev === other.dev && one.ino === other.ino;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** A recorded place: a client's SKILL.md by its full path, or none. */
const placeOf = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isAbsolute(value) || basename(value) !== "SKILL.md") {
    throw new Error("发布历史损坏：发布位置无效");
  }
  return value;
};

const parseVersion = (value: unknown): PublicationVersion => {
  if (!isObject(value)) throw new Error("发布历史损坏：版本记录无效");
  const { version, publishedAt, sourceHash, publishedHash, previousExisted } =
    value;
  const path = placeOf(value.path);
  const movedFrom = placeOf(value.movedFrom);
  if (
    !Number.isSafeInteger(version) ||
    (version as number) < 1 ||
    typeof publishedAt !== "string" ||
    Number.isNaN(Date.parse(publishedAt)) ||
    typeof sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(sourceHash) ||
    typeof publishedHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(publishedHash) ||
    typeof previousExisted !== "boolean"
  ) {
    throw new Error("发布历史损坏：版本字段无效");
  }
  return {
    version: version as number,
    publishedAt,
    sourceHash,
    publishedHash,
    previousExisted,
    ...(path === undefined ? {} : { path }),
    ...(movedFrom === undefined ? {} : { movedFrom }),
  };
};

const parseManifest = (value: unknown): PublicationManifest => {
  if (!isObject(value) || value.version !== 1 || !isObject(value.publications)) {
    throw new Error("发布历史损坏，已停止写入以保护现有客户端内容");
  }
  const publications: Record<string, PublicationHistory> = {};
  for (const [key, rawHistory] of Object.entries(value.publications)) {
    if (!isObject(rawHistory)) {
      throw new Error("发布历史损坏：资产记录无效");
    }
    const target = rawHistory.target;
    const assetId = rawHistory.assetId;
    if (
      (target !== "codex" && target !== "claude-code") ||
      typeof assetId !== "string" ||
      assetId.length === 0 ||
      !Array.isArray(rawHistory.versions)
    ) {
      throw new Error("发布历史损坏：资产字段无效");
    }
    const versions = rawHistory.versions.map(parseVersion);
    if (
      key !== historyKey(assetId, target) ||
      versions.some((version, index) => version.version !== index + 1)
    ) {
      throw new Error("发布历史损坏：版本顺序无效");
    }
    publications[key] = { assetId, target, versions };
  }
  return { version: 1, publications };
};

// Agent Skills' rule for a name, stricter than the vault's (it takes `a--b`): said as the note's `name` it is.
const assertSafeSlug = (slug: string): void => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 64) {
    throw new Error(`技能名称（笔记属性 name：${slug}）不符合客户端的要求：只能用小写字母、数字和单个连字符，不能以连字符开头或结尾，最多 64 个字符。请在 Obsidian 里改好后再发布。`);
  }
};

const MOVED = "技能名称（笔记属性 name）或客户端的技能目录变了";

const assertInside = (root: string, path: string): void => {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  if (
    normalizedPath !== normalizedRoot &&
    !normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new Error("发布目标超出客户端技能目录");
  }
};

const statusFor = (
  target: PracticePublicationTarget,
  state: PracticePublicationState,
  latest: PublicationVersion | null,
  message: string,
  overrides: Partial<PracticePublicationStatus> = {},
): PracticePublicationStatus => ({
  target,
  targetLabel: TARGET_LABELS[target],
  state,
  version: latest?.version ?? null,
  publishedAt: latest?.publishedAt ?? null,
  canPublish: state !== "up_to_date" && state !== "unsafe_target",
  canRollback:
    latest !== null &&
    (state === "up_to_date" || state === "update_available"),
  requiresOverwriteConfirmation:
    state === "occupied" || state === "target_modified",
  message,
  ...overrides,
});

/** Published at a place the skill no longer goes (renamed, or the client folder moved): what is there, and what next. */
const movedStatus = (
  target: PracticePublicationTarget,
  latest: PublicationVersion,
  recorded: TargetInspection,
  destination: TargetInspection,
): PracticePublicationStatus => {
  if (recorded.state === "unsafe") {
    return statusFor(target, "unsafe_target", latest, `${MOVED}；原位置${recorded.reason ?? "不安全"}`);
  }
  if (recorded.content === null) {
    return destination.state === "file"
      ? statusFor(target, "occupied", latest, `${MOVED}，原位置的副本已经不在；新位置已有同名技能，覆盖前需要确认`)
      : statusFor(target, "missing_target", latest, `${MOVED}，原位置的副本已经不在，可以重新发布到新位置`);
  }
  if (hash(recorded.content) !== latest.publishedHash) {
    return statusFor(target, "target_modified", latest, `${MOVED}，原位置的副本已在客户端外被修改；重新发布会写到新位置，原位置的副本保留不动`);
  }
  return destination.state === "file"
    ? statusFor(target, "occupied", latest, `${MOVED}；新位置已有同名技能，覆盖前需要确认，原位置的副本会在发布后移走`)
    : statusFor(target, "update_available", latest, `${MOVED}，客户端里的副本还在原位置；重新发布会把它移到新位置`);
};

export class PracticePublicationService {
  readonly #assets: PracticeAssetSource;
  readonly #stateRoot: string;
  readonly #targetRoots: Partial<Record<PracticePublicationTarget, string>>;
  readonly #now: () => Date;
  readonly #validateBeforePublish: (
    asset: PracticeAssetRecord,
  ) => Promise<void>;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: PracticePublicationServiceOptions) {
    this.#assets = options.assets;
    this.#stateRoot = resolve(options.stateRoot);
    // Read at each publication, not here: where a client keeps its settings can be learned after startup.
    this.#targetRoots = options.targetRoots ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#validateBeforePublish =
      options.validateBeforePublish ?? (async () => undefined);
  }

  async listStatuses(assetId: string): Promise<PracticePublicationStatus[]> {
    return Promise.all(
      (["codex", "claude-code"] as const).map(async (target) =>
        (await this.#snapshot(assetId, target)).status,
      ),
    );
  }

  async publish(
    assetId: string,
    target: PracticePublicationTarget,
    options: { confirmOverwrite?: boolean } = {},
  ): Promise<PracticePublicationReceipt> {
    return this.#exclusive(() => this.#publish(assetId, target, options)).catch(inReaderWords);
  }

  async #publish(
    assetId: string,
    target: PracticePublicationTarget,
    options: { confirmOverwrite?: boolean },
  ): Promise<PracticePublicationReceipt> {
    const snapshot = await this.#snapshot(assetId, target);
    if (snapshot.asset.status !== "accepted" || snapshot.asset.acceptedAt === null) {
      throw new Error("只有已采纳的技能或工作流可以发布");
    }
    if (snapshot.status.state === "up_to_date") {
      return {
        target,
        action: "unchanged",
        version: snapshot.latest?.version ?? null,
        publishedAt: snapshot.latest?.publishedAt ?? null,
        restoredPreviousContent: false,
      };
    }
    await this.#validateBeforePublish(snapshot.asset);
    if (!snapshot.status.canPublish) {
      throw new Error(snapshot.status.message);
    }
    if (
      snapshot.status.requiresOverwriteConfirmation &&
      options.confirmOverwrite !== true
    ) {
      throw new Error("目标已有内容，请确认覆盖；原内容会保存为可回滚版本");
    }

    const manifest = await this.#loadManifest();
    const key = historyKey(assetId, target);
    const existing = manifest.publications[key];
    const version = (existing?.versions.at(-1)?.version ?? 0) + 1;
    const publishedAt = this.#now().toISOString();
    const publishedContent = publishedPracticeAsset(snapshot.asset, snapshot.note, { target, version });
    const previousContent = snapshot.inspection.content;
    const backupPath = this.#backupPath(key, version);
    const leftover = await readFile(backupPath).catch((error: unknown) => (isMissing(error) ? null : Promise.reject(error)));
    // Cut short before its record was written, a publication of this version left what it replaced backed up: the
    // version's backup still, not to be written over with Decision's own text now in the client (the reader's own
    // skill was lost so, and rollback brought back the interrupted copy). Any other backup found there is set aside.
    let wroteBackup = false;
    if (!snapshot.interrupted) {
      if (leftover !== null && (previousContent === null || !leftover.equals(previousContent))) {
        await rename(backupPath, this.#backupPath(key, version, `.kept-${Date.now()}`));
      }
      if (previousContent !== null) {
        await atomicWrite(backupPath, previousContent);
        wroteBackup = true;
      }
    }
    const backedUp = snapshot.interrupted ? leftover !== null : previousContent !== null;
    // The copy at the place it was published before, as published: taken over (kept to be put back by a rollback),
    // where it stayed beside the new one. One the reader changed there is left as it is.
    const recorded = snapshot.recorded;
    const moving = recorded !== null && recorded.content !== null && hash(recorded.content) === snapshot.latest?.publishedHash
      ? { path: recorded.path, content: recorded.content }
      : null;
    const movedBackup = this.#backupPath(key, version, ".moved");
    const pendingPath = this.#pendingPath(key);
    const forget = async (): Promise<void> => {
      if (wroteBackup) await unlink(backupPath).catch(() => undefined);
      if (moving !== null) await unlink(movedBackup).catch(() => undefined);
      await unlink(pendingPath).catch(() => undefined);
    };
    if (moving !== null) await atomicWrite(movedBackup, moving.content);

    await this.#ensureTargetDirectory(snapshot.asset, target);
    try {
      // Said here before the client's copy is written, and cleared once its record is: what proves a publication was
      // cut short, where the copy's own metadata did not (one synced from another Mac or restored from a backup
      // claimed the same, and was written over without confirmation or backup, then deleted by a rollback).
      await atomicWrite(pendingPath, JSON.stringify({ version, path: snapshot.inspection.path }));
      await atomicWrite(snapshot.inspection.path, publishedContent);
    } catch (error) {
      await forget();
      throw error;
    }

    const nextHistory: PublicationHistory = existing ?? {
      assetId,
      target,
      versions: [],
    };
    nextHistory.versions.push({
      version,
      publishedAt,
      sourceHash: snapshot.sourceHash,
      publishedHash: hash(publishedContent),
      previousExisted: backedUp,
      path: snapshot.inspection.path,
      ...(moving === null ? {} : { movedFrom: moving.path }),
    });
    manifest.publications[key] = nextHistory;
    try {
      await this.#saveManifest(manifest);
    } catch (error) {
      if (previousContent === null) {
        await unlink(snapshot.inspection.path).catch(() => undefined);
      } else {
        await atomicWrite(snapshot.inspection.path, previousContent);
      }
      await forget();
      throw error;
    }
    await unlink(pendingPath).catch(() => undefined);
    // Checked again at the last moment: the same file as the copy just written is never taken away as the old one.
    if (moving !== null && !(await sameFile(moving.path, snapshot.inspection.path))) {
      await unlink(moving.path).catch(() => undefined);
      await rmdir(dirname(moving.path)).catch(() => undefined);
    }

    return {
      target,
      action: "published",
      version,
      publishedAt,
      restoredPreviousContent: false,
    };
  }

  async rollback(
    assetId: string,
    target: PracticePublicationTarget,
  ): Promise<PracticePublicationReceipt> {
    return this.#exclusive(() => this.#rollback(assetId, target)).catch(inReaderWords);
  }

  async #rollback(
    assetId: string,
    target: PracticePublicationTarget,
  ): Promise<PracticePublicationReceipt> {
    const snapshot = await this.#snapshot(assetId, target);
    const latest = snapshot.latest;
    // Rolled back where it was written, renamed or moved since or not.
    const current = snapshot.recorded ?? snapshot.inspection;
    if (
      latest === null ||
      current.content === null ||
      hash(current.content) !== latest.publishedHash
    ) {
      throw new Error("当前目标已被修改或没有可回滚版本，为保护现有内容已停止回滚");
    }
    const manifest = await this.#loadManifest();
    const key = historyKey(assetId, target);
    const history = manifest.publications[key];
    const manifestLatest = history?.versions.at(-1);
    if (history === undefined || manifestLatest?.version !== latest.version) {
      throw new Error("发布历史已变化，请刷新后重试");
    }

    const publishedContent = current.content;
    const readBackup = (path: string): Promise<Buffer> =>
      readFile(path).catch((error: unknown) => {
        if (isMissing(error)) {
          throw new Error("回滚备份缺失，为保护当前内容已停止回滚");
        }
        throw error;
      });
    const backupPath = this.#backupPath(key, latest.version);
    const previousContent = latest.previousExisted ? await readBackup(backupPath) : null;
    // Taken over from an earlier place by this version: put back there, unless something else is there now.
    const movedBackup = this.#backupPath(key, latest.version, ".moved");
    const moved = latest.movedFrom === undefined ? null : { path: latest.movedFrom, content: await readBackup(movedBackup) };
    if (moved !== null) {
      const there = await this.#inspect(moved.path);
      if (there.state === "unsafe" || (there.content !== null && !there.content.equals(moved.content))) {
        throw new Error("这个版本移走的原位置副本处已有其它内容，为保护它已停止回滚");
      }
      await mkdir(dirname(moved.path), { recursive: true, mode: 0o700 });
    }

    if (previousContent === null) {
      await unlink(current.path);
    } else {
      await atomicWrite(current.path, previousContent);
    }
    if (moved !== null) await atomicWrite(moved.path, moved.content);
    history.versions.pop();
    if (history.versions.length === 0) delete manifest.publications[key];
    try {
      await this.#saveManifest(manifest);
    } catch (error) {
      await atomicWrite(current.path, publishedContent);
      if (moved !== null) await unlink(moved.path).catch(() => undefined);
      throw error;
    }

    await unlink(backupPath).catch(() => undefined);
    await unlink(movedBackup).catch(() => undefined);
    if (previousContent === null) {
      await rmdir(dirname(current.path)).catch(() => undefined);
    }
    const nextLatest = history.versions.at(-1) ?? null;
    return {
      target,
      action: "rolled_back",
      version: nextLatest?.version ?? null,
      publishedAt: nextLatest?.publishedAt ?? null,
      restoredPreviousContent: previousContent !== null,
    };
  }

  async #snapshot(
    assetId: string,
    target: PracticePublicationTarget,
  ): Promise<PublicationSnapshot> {
    const { asset, note } = await this.#find(assetId);
    const manifest = await this.#loadManifest();
    const history = manifest.publications[historyKey(assetId, target)] ?? null;
    const latest = history?.versions.at(-1) ?? null;
    const sourceHash = hash(publishedPracticeAsset(asset, note));
    const inspection = await this.#inspectTarget(asset, target);
    const recordedPath = latest?.path;
    const recorded = recordedPath !== undefined && resolve(recordedPath) !== resolve(inspection.path) &&
      !(await sameFile(recordedPath, inspection.path))
      ? await this.#inspect(recordedPath)
      : null;
    // Decision's own text of the next version, with no record of it: a publication cut short (a quit) between
    // writing the client's copy and its record. Called 非 Decision 管理的同名技能 and confirmed over, the reader's
    // skill it had backed up was written over with that copy.
    const identity = inspection.content === null ? null : publishedPracticeIdentity(inspection.content.toString("utf8"));
    const pending = identity === null ? null : await this.#pending(historyKey(assetId, target));
    const interrupted = recorded === null && identity !== null && identity.id === assetId && identity.target === target &&
      identity.version === (latest?.version ?? 0) + 1 &&
      (latest === null || hash(inspection.content ?? "") !== latest.publishedHash) &&
      pending !== null && pending.version === identity.version && resolve(pending.path) === resolve(inspection.path);
    let status: PracticePublicationStatus;

    if (inspection.state === "unsafe") {
      status = statusFor(
        target,
        "unsafe_target",
        latest,
        inspection.reason ?? "目标路径不安全，无法发布",
      );
    } else if (latest !== null && recorded !== null) {
      status = movedStatus(target, latest, recorded, inspection);
    } else if (interrupted) {
      status = statusFor(target, "update_available", latest, "上次发布在记下之前中断了，客户端里已是 Decision 写入的内容；重新发布即可补全，原有内容仍可回滚恢复", { canRollback: false });
    } else if (latest === null) {
      status =
        inspection.state === "file"
          ? statusFor(
              target,
              "occupied",
              null,
              "存在非 Decision 管理的同名技能，覆盖前需要确认",
            )
          : statusFor(target, "not_published", null, "尚未发布到此客户端");
    } else if (inspection.state === "missing") {
      status = statusFor(
        target,
        "missing_target",
        latest,
        "已发布文件不存在，可以重新发布",
      );
    } else if (hash(inspection.content ?? "") !== latest.publishedHash) {
      status = statusFor(
        target,
        "target_modified",
        latest,
        "客户端内容已被外部修改，覆盖前需要确认",
      );
    } else if (sourceHash === latest.sourceHash) {
      status = statusFor(target, "up_to_date", latest, "已是最新版本");
    } else {
      status = statusFor(
        target,
        "update_available",
        latest,
        "Obsidian 中的内容已有更新",
      );
    }
    // No longer adopted (dismissed, or so set in Obsidian), it is published no more, and what was published stays
    // withdrawable: refused here as well, the copy went on being loaded by the client with no way to take it back.
    if (asset.status !== "accepted" || asset.acceptedAt === null) {
      status = {
        ...status,
        canPublish: false,
        requiresOverwriteConfirmation: false,
        message: latest === null
          ? "只有已采纳的技能或工作流可以发布"
          : status.canRollback
            ? "这份资产已不是已采纳状态，不再发布；客户端里的副本可以回滚撤下"
            : `这份资产已不是已采纳状态，不再发布；${status.message}`,
      };
    }
    return { asset, note, sourceHash, history, latest, inspection, recorded, interrupted, status };
  }

  async #find(assetId: string): Promise<{ asset: PracticeAssetRecord; note: string | null }> {
    const found = this.#assets.findNote === undefined
      ? await this.#assets.find(assetId).then((asset) => (asset === null ? null : { record: asset, note: null }))
      : await this.#assets.findNote(assetId);
    if (found === null) throw new Error("技能或工作流不存在");
    assertSafeSlug(found.record.slug);
    return { asset: found.record, note: found.note };
  }

  async #inspectTarget(
    asset: PracticeAssetRecord,
    target: PracticePublicationTarget,
  ): Promise<TargetInspection> {
    const root = resolve(this.#targetRoots[target] ?? defaultTargetRoots()[target]);
    const path = join(root, asset.slug, "SKILL.md");
    assertInside(root, path);
    return this.#inspect(path);
  }

  /** A client's SKILL.md and the folders it sits in, none of them a link. */
  async #inspect(path: string): Promise<TargetInspection> {
    for (const [candidate, label] of [
      [dirname(dirname(path)), "客户端技能目录"],
      [dirname(path), "同名技能目录"],
    ] as const) {
      try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          return {
            state: "unsafe",
            path,
            content: null,
            reason: `${label}不是安全的普通目录`,
          };
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        return {
          state: "unsafe",
          path,
          content: null,
          reason: "同名目标不是安全的普通文件",
        };
      }
      return { state: "file", path, content: await readFile(path), reason: null };
    } catch (error) {
      if (!isMissing(error)) throw error;
      return { state: "missing", path, content: null, reason: null };
    }
  }

  async #ensureTargetDirectory(
    asset: PracticeAssetRecord,
    target: PracticePublicationTarget,
  ): Promise<void> {
    const root = resolve(this.#targetRoots[target] ?? defaultTargetRoots()[target]);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const rootStats = await lstat(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new Error("客户端技能目录不是安全的普通目录");
    }
    const directory = join(root, asset.slug);
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("同名技能目录不是安全的普通目录");
    }
  }

  async #loadManifest(): Promise<PublicationManifest> {
    const path = join(this.#stateRoot, "manifest.json");
    try {
      return parseManifest(JSON.parse(await readFile(path, "utf8")) as unknown);
    } catch (error) {
      if (isMissing(error)) return emptyManifest();
      if (error instanceof SyntaxError) {
        throw new Error("发布历史损坏，已停止写入以保护现有客户端内容");
      }
      throw error;
    }
  }

  async #saveManifest(manifest: PublicationManifest): Promise<void> {
    await atomicWrite(
      join(this.#stateRoot, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }

  /** Where a publication under way says what it is writing, until its record is written. */
  #pendingPath(key: string): string {
    const path = join(this.#stateRoot, "pending", `${backupStem(key)}.json`);
    assertInside(this.#stateRoot, path);
    return path;
  }

  async #pending(key: string): Promise<{ version: number; path: string } | null> {
    try {
      const value = JSON.parse(await readFile(this.#pendingPath(key), "utf8")) as { version?: unknown; path?: unknown } | null;
      return typeof value?.version === "number" && typeof value.path === "string" ? { version: value.version, path: value.path } : null;
    } catch {
      return null;
    }
  }

  #backupPath(key: string, version: number, suffix = ""): string {
    const path = join(
      this.#stateRoot,
      "backups",
      backupStem(key),
      `v${version}${suffix}.md`,
    );
    assertInside(this.#stateRoot, path);
    return path;
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release = (): void => undefined;
    this.#mutationTail = new Promise<void>((resolveMutation) => {
      release = resolveMutation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
