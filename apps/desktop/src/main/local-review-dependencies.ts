import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, statfs, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { LocalReviewSettings, LocalReviewSession } from "@cognelis/decision-protocol";
import { localReviewPathSchema } from "@cognelis/decision-protocol";
import { atomicWrite } from "./atomic-write.js";
import { LocalReviewGit, type ReviewCopy } from "./local-review-git.js";
import { ReviewCommandSandbox } from "./local-review-command-sandbox.js";
import { createReviewSandboxFingerprint, reviewSandboxFingerprintSchema } from "./local-review-sandbox-fingerprint.js";
import { ReviewInstallProcesses } from "./local-review-install-processes.js";
import { ManagedChildProcessRunner } from "./model/cli/managed-child-process.js";

// ponytail: root node_modules only. Install: 20 min / 2 MiB combined output.
// Keep 3 keys/project, 5 GiB/project, 20 GiB total; running projects stay pinned.
// Artifact walks: 200000 entries / 64 levels. There is no hard disk quota during
// installation or group cloning; the before/after size checks are not a quota.
export const REVIEW_DEPENDENCY_LIMITS = { keys: 3, projectBytes: 5 * 1024 ** 3, totalBytes: 20 * 1024 ** 3 };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const idSchema = z.string().uuid(), keySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const runSchema = z.object({ id: idSchema, repositoryId: idSchema, fingerprint: reviewSandboxFingerprintSchema.optional() });
const stateSchema = z.object({ version: z.literal(2), runs: z.array(runSchema), obsolete: z.array(idSchema).default([]), errors: z.record(idSchema, z.string()) });
const markerSchema = z.object({ version: z.literal(2), key: keySchema, lastUsed: z.number().finite(), bytes: z.number().nonnegative().finite() });
const reason = (error: unknown) => (error instanceof Error ? error.message : "依赖缓存操作失败。").slice(0, 2000);
const beneath = (root: string, path: string) => { const r = relative(root, path); return !r || r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
export interface ReviewDependencies { key?: string; summary: string; log: string; possibleLaunchdLabels?: string[] }
interface ArtifactEntry { path: string; kind: "file" | "directory" | "link"; target?: string }
export function dependencyCacheKey(repositoryId: string, argv: string[], scripts: boolean, files: Array<[string, string]>, node: string, platform = `${process.platform}-${process.arch}`) {
  return hash(JSON.stringify([repositoryId, argv, scripts, [...files].sort(([a], [b]) => a.localeCompare(b)), node, platform]));
}
export function dependencyProxy(environment: NodeJS.ProcessEnv) {
  const value = environment.MODEL_PROXY_URL; if (!value) return undefined;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("依赖安装代理必须是无账号密码的 HTTP(S) 地址。");
  return value;
}
/** Never opens a special file, and never follows a link while traversing. */
async function artifact(root: string) {
  const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error("依赖产物不是规范的普通目录。");
  const entries: ArtifactEntry[] = []; let bytes = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 64) throw new Error("依赖产物超过 64 层目录。");
    for (const name of await readdir(directory)) {
      if (entries.length >= 200000) throw new Error("依赖产物超过 200000 项。");
      const path = join(directory, name), value = await lstat(path), pathInRoot = relative(root, path);
      if (value.isSymbolicLink()) {
        const link = await readlink(path), lexical = resolve(dirname(path), link);
        if (!beneath(root, lexical)) throw new Error("依赖符号链接逃逸产物目录。");
        const target = await realpath(path); if (!beneath(root, target)) throw new Error("依赖符号链接逃逸产物目录。");
        entries.push({ path: pathInRoot, kind: "link", target: relative(root, target) }); bytes += value.size;
      } else if (value.isDirectory()) { entries.push({ path: pathInRoot, kind: "directory" }); await walk(path, depth + 1); }
      else if (value.isFile()) { entries.push({ path: pathInRoot, kind: "file" }); bytes += value.size; }
      else throw new Error("依赖产物包含非常规文件。");
      if (bytes > REVIEW_DEPENDENCY_LIMITS.projectBytes) throw new Error("工程依赖超过 5 GiB 上限。");
    }
  };
  await walk(root, 0); return { entries, bytes };
}
async function cloneArtifact(source: string, target: string, inventory: Awaited<ReturnType<typeof artifact>>, signal: AbortSignal) {
  await mkdir(target, { mode: 0o700 });
  for (const entry of inventory.entries) {
    signal.throwIfAborted(); const destination = join(target, entry.path);
    if (entry.kind === "directory") await mkdir(destination, { mode: 0o700 });
    else if (entry.kind === "file") await copyFile(join(source, entry.path), destination, constants.COPYFILE_FICLONE);
    else await symlink(relative(dirname(destination), join(target, entry.target!)) || ".", destination);
  }
}
/** Reaped installers cannot race this walk. chmod directories only; never follow links. */
async function removeOwned(path: string) {
  let count = 0;
  const unlock = async (directory: string, depth: number) => {
    if (++count > 250000 || depth > 128) throw new Error("依赖清理超过遍历上限，保留隔离目录待重试。");
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    await chmod(directory, 0o700);
    for (const name of await readdir(directory)) await unlock(join(directory, name), depth + 1);
  };
  await unlock(path, 0); await rm(path, { recursive: true, force: true });
}

export class LocalReviewDependencies {
  private readonly active = new Set<string>();
  private readonly runner = new ManagedChildProcessRunner();
  private state: z.infer<typeof stateSchema> = { version: 2, runs: [], obsolete: [], errors: {} };
  private writes: Promise<unknown> = Promise.resolve();
  private fault: string | undefined;
  runsRoot: string;
  constructor(public root: string, private readonly git: LocalReviewGit, private readonly environment: NodeJS.ProcessEnv = process.env) { this.runsRoot = join(dirname(root), "runs"); }
  private get statePath() { return join(dirname(this.root), "dependency-state.json"); }
  private save() {
    const content = JSON.stringify(this.state), pending = this.writes.then(() => atomicWrite(this.statePath, content));
    this.writes = pending.catch(() => undefined); return pending;
  }
  private async note(repositoryId: string, error: unknown) {
    this.state.errors[repositoryId] = reason(error);
    try { await this.save(); } catch (error) { this.fault = `依赖账本无法写入：${reason(error)}`; }
  }
  private async project(id: string) {
    idSchema.parse(id); const path = join(this.root, id); await mkdir(path, { recursive: true, mode: 0o700 });
    if (await realpath(path) !== path) throw new Error("依赖目录被符号链接重定向。");
    const published = join(path, "published"); await mkdir(published, { recursive: true, mode: 0o700 });
    if (await realpath(published) !== published) throw new Error("已发布依赖目录被重定向。");
    return published;
  }
  private async cleanupRun(run: z.infer<typeof runSchema>, clearUnattributed = false) {
    const path = join(this.runsRoot, run.id);
    if (!run.fingerprint && !clearUnattributed) throw new Error("旧安装缺少秘密指纹，不能安全归属；不发送信号并保留恢复记录。");
    // Filesystem cleanup remains confined to the recorded directory.
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (await realpath(path) !== path) throw new Error("安装目录被重定向，拒绝回收不明进程。");
    if (run.fingerprint) {
      await new ReviewInstallProcesses(path, run.fingerprint, this.runner, undefined, join(dirname(this.root), "install-controls", run.id)).reap();
    }
    await removeOwned(path); await removeOwned(join(dirname(this.root), "install-controls", run.id));
    this.state.runs = this.state.runs.filter(entry => entry.id !== run.id); await this.save();
    if (!run.fingerprint) console.info("local-review-dependencies", JSON.stringify({ action: "clear_unattributed_run", repositoryId: run.repositoryId, runId: run.id, message: "无指纹，未发送信号；只清理目录和记录。" }));
  }
  private async discardLegacy(repositoryId: string, clearUnattributed = false) {
    if (clearUnattributed) {
      await removeOwned(join(this.root, repositoryId)); this.state.obsolete = this.state.obsolete.filter(id => id !== repositoryId); await this.save();
      console.info("local-review-dependencies", JSON.stringify({ action: "clear_unattributed_legacy", repositoryId, message: "无指纹，未发送信号；只清理目录和记录。" })); return;
    }
    // No unsafe path-based fallback can attribute pre-fingerprint descendants.
    throw new Error("旧缓存安装没有随机指纹，不能安全回收；保留该工程并拒绝发布。");
  }
  async start() {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if ((await lstat(this.root)).isSymbolicLink()) throw new Error("依赖根目录不可为符号链接。");
      this.root = await realpath(this.root); this.runsRoot = join(dirname(this.root), "runs"); await mkdir(this.runsRoot, { recursive: true, mode: 0o700 });
      if (await realpath(this.runsRoot) !== this.runsRoot) throw new Error("安装根目录被重定向。");
      let legacy = false;
      try { this.state = stateSchema.parse(JSON.parse(await readFile(this.statePath, "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; legacy = true; }
      // Persist migration intent outside every old installer's writable root.
      if (legacy) this.state.obsolete = (await readdir(this.root)).filter(id => idSchema.safeParse(id).success);
      await this.save();
      for (const repositoryId of [...this.state.obsolete]) { try { await this.discardLegacy(repositoryId); } catch (error) { await this.note(repositoryId, error); } }
      for (const entry of await readdir(this.runsRoot)) {
        if (idSchema.safeParse(entry).success && !this.state.runs.some(run => run.id === entry)) this.state.runs.push({ id: entry, repositoryId: entry });
        else if (!idSchema.safeParse(entry).success) { try { await removeOwned(join(this.runsRoot, entry)); } catch { /* A probe's private canary does not grant an installer any access. */ } }
      }
      await this.save();
      for (const run of [...this.state.runs]) { try { await this.cleanupRun(run); } catch (error) { await this.note(run.repositoryId, error); } }
      await this.prune();
    } catch (error) { this.fault = `依赖恢复不可用，继续任务但不安装：${reason(error)}`; }
  }
  release(repositoryId: string) { this.active.delete(repositoryId); }
  async clear(repositoryId: string) {
    idSchema.parse(repositoryId);
    if (this.active.has(repositoryId)) throw new Error("工程任务正在使用依赖缓存，请等任务结束后清除。");
    for (const run of this.state.runs.filter(run => run.repositoryId === repositoryId)) await this.cleanupRun(run, true);
    if (this.state.obsolete.includes(repositoryId)) await this.discardLegacy(repositoryId, true);
    await removeOwned(join(this.root, repositoryId)); delete this.state.errors[repositoryId]; await this.save();
  }
  private async cache(path: string, key: string) {
    const directory = await lstat(path); if (!directory.isDirectory() || directory.isSymbolicLink() || await realpath(path) !== path) throw new Error("已发布缓存目录无效。");
    const markerPath = join(path, "complete.json"), info = await lstat(markerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("依赖完成标记无效。");
    const marker = markerSchema.parse(JSON.parse(await readFile(markerPath, "utf8"))); if (marker.key !== key) throw new Error("依赖完成标记不匹配。");
    const inventory = await artifact(join(path, "node_modules")); return { ...marker, bytes: inventory.bytes };
  }
  async prune() {
    const all: Array<{ repositoryId: string; path: string; lastUsed: number; bytes: number }> = [];
    let projects: string[]; try { projects = await readdir(this.root); } catch (error) { this.fault = reason(error); return; }
    for (const repositoryId of projects.filter(id => idSchema.safeParse(id).success)) {
      if (this.active.has(repositoryId) || this.state.obsolete.includes(repositoryId)) continue;
      try {
        const published = await this.project(repositoryId), projectEntries: typeof all = [];
        for (const key of await readdir(published)) {
          const path = join(published, key);
          try { keySchema.parse(key); const value = await this.cache(path, key); projectEntries.push({ repositoryId, path, lastUsed: value.lastUsed, bytes: value.bytes }); }
          catch (error) { await this.note(repositoryId, error); await removeOwned(path); }
        }
        all.push(...projectEntries);
      } catch (error) { await this.note(repositoryId, error); try { await removeOwned(join(this.root, repositoryId)); } catch (error) { await this.note(repositoryId, error); } }
    }
    let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
    const bytes = new Map<string, number>(), counts = new Map<string, number>();
    for (const entry of all) { bytes.set(entry.repositoryId, (bytes.get(entry.repositoryId) ?? 0) + entry.bytes); counts.set(entry.repositoryId, (counts.get(entry.repositoryId) ?? 0) + 1); }
    for (const entry of all.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (counts.get(entry.repositoryId)! <= REVIEW_DEPENDENCY_LIMITS.keys && bytes.get(entry.repositoryId)! <= REVIEW_DEPENDENCY_LIMITS.projectBytes && total <= REVIEW_DEPENDENCY_LIMITS.totalBytes) continue;
      try { await removeOwned(entry.path); counts.set(entry.repositoryId, counts.get(entry.repositoryId)! - 1); bytes.set(entry.repositoryId, bytes.get(entry.repositoryId)! - entry.bytes); total -= entry.bytes; }
      catch (error) { await this.note(entry.repositoryId, error); }
    }
  }
  async prepare(repositoryId: string, snapshot: LocalReviewSession["snapshot"], settings: LocalReviewSettings, createCopy: (directory: string) => Promise<ReviewCopy>, signal: AbortSignal, onLaunchdChange?: (labels: string[]) => Promise<void> | void): Promise<ReviewDependencies> {
    const config = settings.dependencies ?? { mode: "auto", argv: [], files: [], allowScripts: true };
    if (config.mode === "off") return { summary: "依赖安装已关闭。", log: "" };
    let run: z.infer<typeof runSchema> | undefined, publication: string | undefined, log = "";
    let possibleLaunchdLabels: string[] = [];
    let outcome: ReviewDependencies = { summary: "未准备依赖。", log };
    try {
      idSchema.parse(repositoryId); if (this.fault) throw new Error(this.fault);
      if (this.state.obsolete.includes(repositoryId)) throw new Error(`旧缓存回收尚未完成：${this.state.errors[repositoryId] ?? "恢复后再试"}`);
      if (this.state.runs.some(run => run.repositoryId === repositoryId)) throw new Error(`此工程仍有未回收安装：${this.state.errors[repositoryId] ?? "恢复后再试"}`);
      const tracked = await this.git.files(snapshot, "new", signal), locks = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].filter(path => tracked.some(f => f.path === path && ["100644", "100755"].includes(f.mode)));
      if (config.mode === "auto" && locks.length !== 1) return { summary: "未安装依赖：没有唯一的 Node lockfile。", log: "" };
      const argv = config.mode === "custom" ? [...config.argv] : locks[0] === "package-lock.json" ? ["npm", "ci"] : locks[0] === "pnpm-lock.yaml" ? ["pnpm", "install", "--frozen-lockfile"] : ["yarn", "install", "--immutable"];
      if (!argv.length) throw new Error("自定义安装 argv 不能为空。");
      if (!config.allowScripts) { if (!["npm", "pnpm", "yarn"].includes(argv[0]!)) throw new Error("关闭安装脚本时仅支持 npm、pnpm、yarn 安装命令。"); argv.push("--ignore-scripts"); }
      const files = config.mode === "custom" ? config.files : locks; if (!files.length) throw new Error("自定义缓存键文件不能为空。");
      const keyFiles = [...new Set([...files, ...(tracked.some(f => f.path === "package.json" && ["100644", "100755"].includes(f.mode)) ? ["package.json"] : [])])], contents: Array<[string, string]> = [];
      for (const path of keyFiles) { localReviewPathSchema.parse(path); if (!tracked.some(f => f.path === path && ["100644", "100755"].includes(f.mode))) throw new Error("缓存键文件必须是 headSha 中的普通文件。"); contents.push([path, hash(await this.git.readFile(snapshot, path, "new", signal))]); }
      this.active.add(repositoryId); const published = await this.project(repositoryId);
      run = { id: randomUUID(), repositoryId, fingerprint: createReviewSandboxFingerprint() }; this.state.runs.push(run); await this.save();
      const directory = join(this.runsRoot, run.id); await mkdir(directory, { mode: 0o700 });
      const copy = await createCopy(join(directory, "copy"));
      if (![copy.directory, copy.tree, copy.git].every(path => beneath(directory, path) && resolve(path) === path)) throw new Error("安装副本必须位于本次 runs 目录内。");
      const sandbox = new ReviewCommandSandbox(this.environment, { root: directory, proxy: dependencyProxy(this.environment), fingerprint: run.fingerprint!, controlDirectory: join(dirname(this.root), "install-controls", run.id), ledgerPath: this.statePath }, async labels => { possibleLaunchdLabels = [...new Set([...possibleLaunchdLabels, ...labels])]; await onLaunchdChange?.(labels); }); await sandbox.probe(copy, signal);
      if (!sandbox.available) throw new Error(`安装沙箱探测失败：${sandbox.reason}`);
      const key = dependencyCacheKey(repositoryId, argv, config.allowScripts, contents, sandbox.nodeVersion), path = join(published, key);
      try {
        const marker = await this.cache(path, key); await atomicWrite(join(path, "complete.json"), JSON.stringify({ ...marker, lastUsed: Date.now() }));
        outcome = { key, summary: "依赖缓存命中，跳过安装。", log: "" };
      } catch {
        await removeOwned(path);
        const disk = await statfs(directory); if (disk.bavail * disk.bsize < REVIEW_DEPENDENCY_LIMITS.projectBytes) throw new Error("空闲空间不足 5 GiB，跳过依赖安装。");
        const result = await sandbox.run(argv, signal); log = (result.stdout + "\n" + result.stderr).slice(0, 2 * 1024 * 1024);
        if (sandbox.possibleLaunchdLabels.length) throw new Error("可能新增宿主 launchd 任务，依赖不发布；请检查任务详情中的标签。");
        if (result.exitCode !== 0) throw new Error(`依赖安装失败（退出码 ${result.exitCode}）。`);
        // run() has already reaped every process carrying this sandbox grant.
        signal.throwIfAborted(); const source = join(copy.tree, "node_modules"), inventory = await artifact(source);
        publication = path; await mkdir(path, { mode: 0o700 }); await cloneArtifact(source, join(path, "node_modules"), inventory, signal); signal.throwIfAborted();
        await atomicWrite(join(path, "complete.json"), JSON.stringify({ version: 2, key, lastUsed: Date.now(), bytes: inventory.bytes }));
        publication = undefined; delete this.state.errors[repositoryId]; await this.save(); outcome = { key, summary: "依赖安装完成。", log };
      }
    } catch (error) { if (idSchema.safeParse(repositoryId).success) await this.note(repositoryId, error); outcome = { summary: `未准备依赖，继续修改：${reason(error)}`, log }; }
    finally {
      if (publication) { try { await removeOwned(publication); } catch (error) { await this.note(repositoryId, error); } }
      if (run) try { await this.cleanupRun(run); } catch (error) { await this.note(repositoryId, error); outcome = { summary: `未准备依赖，继续修改：${reason(error)}`, log }; }
    }
    signal.throwIfAborted(); return { ...outcome, ...(possibleLaunchdLabels.length ? { possibleLaunchdLabels } : {}) };
  }
  async clone(repositoryId: string, dependencies: ReviewDependencies, copy: ReviewCopy, signal: AbortSignal) {
    if (!dependencies.key) return dependencies.summary;
    if (!await this.git.dependenciesIgnored(copy, signal)) return "未克隆依赖：.gitignore 未覆盖 node_modules/，继续修改。";
    if (await lstat(join(copy.tree, "node_modules")).then(() => true, () => false)) return "未克隆依赖：工程已跟踪 node_modules。";
    const target = join(copy.tree, "node_modules");
    try {
      keySchema.parse(dependencies.key); const published = await this.project(repositoryId), path = join(published, dependencies.key); await this.cache(path, dependencies.key);
      const source = join(path, "node_modules");
      if (process.platform === "darwin") {
        try { await this.runner.run({ executable: "/bin/cp", args: ["-c", "-R", source, target], cwd: copy.directory, stdin: "", timeoutMs: 300000, maximumStdoutBytes: 16000, maximumStderrBytes: 16000, environment: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" }, signal }); return dependencies.summary; }
        catch { signal.throwIfAborted(); await removeOwned(target); }
      }
      await cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true }); signal.throwIfAborted(); return dependencies.summary;
    } catch (error) { await removeOwned(target); signal.throwIfAborted(); return `未克隆依赖，继续修改：${reason(error)}`; }
  }
}
