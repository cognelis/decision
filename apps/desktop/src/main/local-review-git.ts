import { ManagedChildProcessRunner, ManagedProcessError } from "./model/cli/managed-child-process.js";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class ReviewViewError extends Error {}

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const MAX_BYTES = 16 * 1024 * 1024;
export interface ReviewNetworkSnapshot { url: string; directory: string; credentialHelpers: string[]; sshCommand: string | null }
export interface ReviewCopy { directory: string; git: string; tree: string }
export interface ReviewChange { path: string; oldPath?: string; oldMode: string; newMode: string; status: string }
export interface ReviewArtifact { commitOid: string; changes: ReviewChange[]; diff: string; risks: string[] }
export interface ReviewRepository {
  path: string; headSha: string; baseSha: string; branch: string | null;
  dirty: boolean; author: { name: string; email: string };
}

export const reviewPath = (path: string): string => {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw new Error("文件路径无效。");
  return path;
};
const oid = (value: string): string => { if (!OID.test(value)) throw new Error("Git 提交标识无效。"); return value; };
export const reviewBranch = (branch: string): string => {
  if (!branch || branch.startsWith("-") || /[\s~^:?*\[\\\x00-\x1f\x7f]/u.test(branch) || branch.includes("..") || branch.includes("@{") || branch.endsWith(".") || branch.split("/").some(p => !p || p.startsWith(".") || p.endsWith(".lock"))) throw new Error("目标分支名无效。");
  return branch;
};

/** All reads are object reads. Never run a repository's filter, monitor, hook or diff driver. */
export class LocalReviewGit {
  private readonly runner = new ManagedChildProcessRunner();
  constructor(private readonly executable = "/usr/bin/git", private readonly source: NodeJS.ProcessEnv = process.env, private readonly allowFile = false) {}
  private async run(cwd: string, args: string[], signal?: AbortSignal, credentials = false, extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
    signal?.throwIfAborted();
    const env = this.env(args, credentials, extraEnv);
    try {
      return (await this.runner.run({ executable: this.executable, args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "submodule.recurse=false", "-c", "push.followTags=false", ...args], cwd, environment: env, stdin: "", timeoutMs: 300_000, maximumStdoutBytes: MAX_BYTES, maximumStderrBytes: 1024 * 1024, ...(signal ? { signal } : {}) })).stdout;
    } catch (error) {
      const code = error instanceof ManagedProcessError ? error.processExitCode ?? error.code : "unknown";
      throw new Error(`Git 操作失败（${args.find(a => !a.startsWith("-")) ?? "git"}，${String(code)}）。`);
    }
  }

  private env(args: string[], credentials: boolean, extraEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["HOME", "PATH", "USER", "LANG", "LC_ALL", "TMPDIR", "SystemRoot", "SSH_AUTH_SOCK"]) if (this.source[name] !== undefined) env[name] = this.source[name];
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: args.includes("check-ignore") ? "0" : "1", GIT_OPTIONAL_LOCKS: "0", GIT_SSH_VARIANT: "ssh" });
    if (!credentials) env.GIT_CONFIG_GLOBAL = "/dev/null";
    return Object.assign(env, extraEnv);
  }
  private copyRun(copy: ReviewCopy, args: string[], signal?: AbortSignal, credentials = false) {
    return this.run(copy.directory, [`--git-dir=${copy.git}`, `--work-tree=${copy.tree}`, ...args], signal, credentials);
  }
  async inspect(path: string, baseBranch?: string, signal?: AbortSignal): Promise<ReviewRepository> {
    const root = await realpath(path);
    if ((await this.run(root, ["rev-parse", "--show-toplevel"], signal)).trim() !== root) throw new Error("请选择 Git 工程根目录。");
    const headSha = oid((await this.run(root, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], signal)).trim());
    const branch = (await this.run(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal).catch(() => "")).trim() || null;
    if (!branch && !baseBranch) throw new Error("当前为 detached HEAD，请填写目标分支。");
    const target = reviewBranch(baseBranch ?? branch!);
    // ponytail: v1 uses origin/HEAD when available; unusual remote layouts need an explicit base.
    const defaultRef = baseBranch ?? ((await this.run(root, ["symbolic-ref", "refs/remotes/origin/HEAD"], signal).catch(() => "")).trim() || target);
    const base = oid((await this.run(root, ["rev-parse", "--verify", "--end-of-options", `${defaultRef}^{commit}`], signal)).trim());
    const baseSha = oid((await this.run(root, ["merge-base", headSha, base], signal)).trim());
    const name = (await this.run(root, ["config", "--get", "user.name"], signal, true)).trim();
    const email = (await this.run(root, ["config", "--get", "user.email"], signal, true)).trim();
    if (!name || !email || /[\r\n\0]/u.test(name + email)) throw new Error("请先配置 Git 提交身份。");
    // Even status may run a clean filter when attributes changed. Mask all configured
    // filter commands before inspecting dirtiness; --no-optional-locks alone is insufficient.
    const filterNames = (await this.run(root, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], signal).catch(() => "")).split("\0").filter(Boolean);
    const disableFilters = filterNames.flatMap(name => ["-c", `${name}=${name.endsWith(".required") ? "false" : ""}`]);
    return { path: root, headSha, baseSha, branch, author: { name, email }, dirty: !!(await this.run(root, [...disableFilters, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], signal)) };
  }
  async files(repository: ReviewRepository, side: "old" | "new", signal?: AbortSignal) {
    const output = await this.run(repository.path, ["ls-tree", "-r", "-z", oid(side === "old" ? repository.baseSha : repository.headSha)], signal);
    return output.split("\0").filter(Boolean).map(record => {
      const at = record.indexOf("\t"), [mode, type, hash] = record.slice(0, at).split(" ");
      return { path: record.slice(at + 1), mode: mode!, type: type!, oid: oid(hash!) };
    });
  }
  async readFile(repository: ReviewRepository, path: string, side: "old" | "new", signal?: AbortSignal) {
    reviewPath(path);
    const content = await this.run(repository.path, ["cat-file", "blob", `${oid(side === "old" ? repository.baseSha : repository.headSha)}:${path}`], signal);
    if (content.includes("\0") || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("此文件为二进制或超过 2 MiB，无法显示。");
    return content;
  }
  diff(repository: ReviewRepository, signal?: AbortSignal) { return this.run(repository.path, ["diff", "--no-ext-diff", "--no-textconv", repository.baseSha, repository.headSha, "--"], signal); }
  /* A review benchmark case's checks (review-benchmark-service.ts): any directory inside the repository will do. */
  async commitExists(directory: string, commit: string): Promise<boolean> {
    return (await this.run(directory, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${oid(commit)}^{commit}`]).catch(() => "")).trim() === commit;
  }
  /** Null when the two share no history. */
  async mergeBase(directory: string, first: string, second: string): Promise<string | null> {
    const found = (await this.run(directory, ["merge-base", oid(first), oid(second)]).catch(() => "")).trim();
    return OID.test(found) ? found : null;
  }
  async diffPaths(directory: string, base: string, head: string): Promise<string[]> {
    return (await this.run(directory, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", oid(base), oid(head), "--"])).split("\0").filter(Boolean);
  }
  /** The patch's size as a replay reads it (scripts/replay-pr-review.mjs); null past what one read holds. */
  async diffBytes(directory: string, base: string, head: string): Promise<number | null> {
    const diff = await this.run(directory, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=3", oid(base), oid(head), "--"]).catch(() => null);
    return diff === null ? null : Buffer.byteLength(diff);
  }
  /* A benchmark run's replay (review-benchmark-replay.ts): read-only, at fixed commits, never the working tree. */
  async topLevel(directory: string): Promise<string | null> { return (await this.run(directory, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim() || null; }
  /** The patch from `base` to `head`, or (nameStatus) its files with how each changed, NUL-separated. */
  treeDiff(directory: string, base: string, head: string, nameStatus = false): Promise<string> {
    return this.run(directory, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", ...(nameStatus ? ["--name-status", "-z"] : ["--unified=3"]), oid(base), oid(head), "--"]);
  }
  /** A file at a commit; null when the commit has no file there. */
  async blob(directory: string, commit: string, path: string): Promise<string | null> {
    reviewPath(path);
    return this.run(directory, ["cat-file", "blob", `${oid(commit)}:${path}`]).catch(() => null);
  }
  treeFiles(directory: string, commit: string): Promise<string> { return this.run(directory, ["ls-tree", "-r", "-z", oid(commit)]); }
  /** Null when the commit has no text file at that path. */
  async lineCount(directory: string, commit: string, path: string): Promise<number | null> {
    try { reviewPath(path); } catch { return null; }
    const content = await this.run(directory, ["cat-file", "blob", `${oid(commit)}:${path}`]).catch(() => null);
    if (content === null || content.includes("\0")) return null;
    return content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  }
  async pushUrl(repository: ReviewRepository, remote: string, signal?: AbortSignal) {
    if (!/^[\w.-]+$/u.test(remote) || remote.startsWith("-")) throw new Error("推送远端名无效。");
    const urls = (await this.run(repository.path, ["remote", "get-url", "--push", "--all", remote], signal, true)).split("\n").filter(Boolean);
    if (urls.length !== 1) throw new Error("推送远端必须只有一个 push URL。");
    return this.validateUrl(urls[0]!);
  }
  async originUrl(repository: ReviewRepository, signal?: AbortSignal) {
    return (await this.run(repository.path, ["remote", "get-url", "origin"], signal, true).catch(() => "")).trim() || null;
  }
  async captureNetwork(repository: ReviewRepository, remote: string, signal?: AbortSignal): Promise<ReviewNetworkSnapshot> {
    const url = await this.pushUrl(repository, remote, signal);
    const optional = (args: string[]) => this.run(repository.path, ["config", "--includes", ...args], signal, true).catch(error => { signal?.throwIfAborted(); if (error instanceof Error && error.message.endsWith("，1）。")) return ""; throw error; });
    const helpers = await optional(["--null", "--get-all", "credential.helper"]);
    const ssh = await optional(["--get", "core.sshCommand"]);
    return { url, directory: repository.path, credentialHelpers: helpers ? helpers.split("\0").slice(0, -1) : [], sshCommand: ssh ? ssh.replace(/\n$/u, "") : null };
  }
  private async network(snapshot: ReviewNetworkSnapshot, args: string[], signal?: AbortSignal, copy?: ReviewCopy) {
    this.validateUrl(snapshot.url);
    const config = ["-c", "credential.helper=", ...snapshot.credentialHelpers.flatMap(helper => ["-c", `credential.helper=${helper}`]), "-c", `core.sshCommand=${snapshot.sshCommand ?? "ssh"} -o BatchMode=yes`, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", ...(this.allowFile ? ["-c", "protocol.file.allow=always"] : [])];
    // Relative credential/SSH commands keep their original, model-inaccessible working tree.
    // Never reinterpret includes, rewrites or other user configuration in a model's copy.
    const temporary = copy ? null : await mkdtemp(join(tmpdir(), "paraself-git-network-"));
    try {
      const gitDirectory = copy?.git ?? join(temporary!, "git");
      if (temporary) await this.run(temporary, ["init", "--bare", "--template=", gitDirectory], signal);
      return await this.run(snapshot.directory, [`--git-dir=${gitDirectory}`, `--work-tree=${snapshot.directory}`, ...config, ...args], signal);
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
  async branchOid(snapshot: ReviewNetworkSnapshot, branch: string, signal?: AbortSignal) {
    const output = await this.network(snapshot, ["ls-remote", "--refs", "--", snapshot.url, `refs/heads/${reviewBranch(branch)}`], signal);
    return output ? oid(output.split("\t")[0]!) : null;
  }
  validateUrl(url: string): string {
    if (/\s|[\0-\x1f\x7f]/u.test(url) || /^[a-z][a-z0-9+.-]*::/iu.test(url)) throw new Error("不支持的推送协议。");
    if (this.allowFile && (isAbsolute(url) || url.startsWith("file://"))) return url;
    if (/^(?:[^/@:]+@)?[^/:]+:[^/].+$/u.test(url) && !url.includes("://")) return url;
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error("推送地址无效。"); }
    if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.password || (parsed.protocol === "https:" && parsed.username) || parsed.search || parsed.hash) throw new Error("推送仅支持无内嵌凭据的 SSH、HTTPS 地址。");
    return url;
  }
  async checkBase(snapshot: ReviewNetworkSnapshot, branch: string, signal?: AbortSignal) {
    if (!await this.branchOid(snapshot, branch, signal)) throw new Error("目标仓库不存在这个 baseBranch。");
  }
  async prepare(repository: ReviewRepository, directory: string, signal?: AbortSignal): Promise<ReviewCopy> {
    const copy = { directory, git: join(directory, "git"), tree: join(directory, "tree") };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.run(directory, ["clone", "--no-checkout", "--template=", `--separate-git-dir=${copy.git}`, "--", repository.path, copy.tree], signal);
    // clone carries a source remote; replace configuration before touching any working tree.
    await writeFile(join(copy.git, "config"), `[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\n`, { mode: 0o600 });
    await this.copyRun(copy, ["checkout", "--detach", oid(repository.headSha), "--"], signal);
    return copy;
  }
  async isClean(copy: ReviewCopy, signal?: AbortSignal) { return !(await this.copyRun(copy, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"], signal)); }
  async dependenciesIgnored(copy: ReviewCopy, signal?: AbortSignal) {
    try { await this.run(copy.tree, [`--git-dir=${copy.git}`, `--work-tree=${copy.tree}`, "check-ignore", "--quiet", "--", "node_modules/"], signal); return true; }
    catch { signal?.throwIfAborted(); return false; }
  }
  async changedPaths(copy: ReviewCopy, signal?: AbortSignal): Promise<string[]> {
    const records = (await this.copyRun(copy, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], signal)).split("\0"), paths = new Set<string>();
    for (let index = 0; index < records.length && records[index]; index++) {
      const row = records[index]!; paths.add(reviewPath(row.slice(3)));
      if (/[RC]/u.test(row.slice(0, 2))) paths.add(reviewPath(records[++index]!));
    }
    return [...paths];
  }
  async commit(copy: ReviewCopy, repository: ReviewRepository, title: string, changedFiles: readonly string[], signal?: AbortSignal): Promise<ReviewArtifact | null> {
    if (!title.trim() || title.length > 300 || /[\r\n\0]/u.test(title)) throw new Error("提交标题必须是单行文本。");
    const declared = new Set(changedFiles.map(reviewPath));
    await this.copyRun(copy, ["reset", "--mixed", "--no-refresh", "HEAD", "--"], signal);
    const selected = (await this.changedPaths(copy, signal)).filter(path => declared.has(path));
    if (!selected.length) return null;
    const tracked = new Set((await this.copyRun(copy, ["ls-files", "-z"], signal)).split("\0").filter(Boolean));
    const removed: string[] = [], leaves: string[] = [];
    for (const path of selected) {
      const file = await lstat(join(copy.tree, path)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (file?.isFile() || file?.isSymbolicLink()) leaves.push(path);
      else if (tracked.has(path)) removed.push(path);
    }
    // A deleted file may now be a directory. Remove only its exact index entry;
    // passing that path to add would recursively stage undeclared descendants.
    if (removed.length) await this.copyRun(copy, ["update-index", "--force-remove", "--", ...removed], signal);
    if (leaves.length) await this.copyRun(copy, ["add", "--", ...leaves], signal);
    const staged = (await this.copyRun(copy, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"], signal)).split("\0").filter(Boolean);
    if (staged.some(path => !selected.includes(path))) {
      // Rebuild from HEAD rather than retaining a partially trusted staging area.
      await this.copyRun(copy, ["reset", "--mixed", "--no-refresh", "HEAD", "--"]);
      throw new Error("暂存区包含未选择的路径，已从 HEAD 重建索引，未创建提交。");
    }
    if (!staged.length) return null;
    await this.copyRun(copy, ["-c", `user.name=${repository.author.name}`, "-c", `user.email=${repository.author.email}`, "-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", title, "--"], signal);
    const commitOid = oid((await this.copyRun(copy, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim());
    return this.artifact(copy, repository, commitOid, signal);
  }
  /** `base` is the commit the copy started from (the group's recorded commit when appending). */
  async recoverCommit(copy: ReviewCopy, repository: ReviewRepository, signal?: AbortSignal, base = repository.headSha): Promise<ReviewArtifact | null> {
    const commitOid = oid((await this.copyRun(copy, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim());
    return commitOid === base ? null : this.artifact(copy, repository, commitOid, signal);
  }
  private async artifact(copy: ReviewCopy, repository: ReviewRepository, commitOid: string, signal?: AbortSignal): Promise<ReviewArtifact> {
    const raw = await this.copyRun(copy, ["diff", "--no-ext-diff", "--no-textconv", "--raw", "--no-abbrev", "-z", "-M", repository.headSha, commitOid, "--"], signal);
    const chunks = raw.split("\0"), changes: ReviewChange[] = [];
    for (let i = 0; i < chunks.length && chunks[i];) {
      const meta = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z]\d*)$/u.exec(chunks[i++]!);
      if (!meta) throw new Error("无法解析 Git 改动清单。");
      const first = reviewPath(chunks[i++]!);
      const renamed = /^[RC]/u.test(meta[3]!);
      changes.push({ path: renamed ? reviewPath(chunks[i++]!) : first, ...(renamed ? { oldPath: first } : {}), oldMode: meta[1]!, newMode: meta[2]!, status: meta[3]! });
    }
    if (changes.length > 1000) throw new Error("变更超过 1000 个文件。");
    const diff = await this.copyRun(copy, ["diff", "--no-ext-diff", "--no-textconv", repository.headSha, commitOid, "--"], signal);
    if (Buffer.byteLength(diff) > 4 * 1024 * 1024) throw new Error("变更超过 4 MiB。");
    const paths = [...new Set(changes.flatMap(c => [c.path, ...(c.oldPath ? [c.oldPath] : [])]))];
    const sizes = await this.copyRun(copy, ["ls-tree", "-r", "-l", "-z", commitOid, "--", ...paths], signal);
    const total = sizes.split("\0").filter(Boolean).reduce((sum, record) => {
      const size = /^\d{6} \w+ [a-f0-9]+\s+(\d+|-)\t/u.exec(record)?.[1];
      return sum + (size === "-" ? 0 : Number(size ?? Number.POSITIVE_INFINITY));
    }, 0);
    if (total > 16 * 1024 * 1024) throw new Error("变更文件总大小超过 16 MiB。");
    const attr = await this.copyRun(copy, ["check-attr", `--source=${commitOid}`, "-z", "filter", "--", ...paths], signal);
    const baselineAttr = await this.copyRun(copy, ["check-attr", `--source=${repository.headSha}`, "-z", "filter", "--", ...paths], signal);
    const lfs = new Set<string>();
    for (const output of [attr, baselineAttr]) { const fields = output.split("\0"); for (let i = 0; i + 2 < fields.length; i += 3) if (fields[i + 2] === "lfs") lfs.add(fields[i]!); }
    return { commitOid, changes, diff, risks: reviewRisks(changes, lfs) };
  }
  /** `expected` is the OID the remote branch must still have (lease/CAS); empty means "must not exist". Not a fast-forward guarantee. */
  async push(copy: ReviewCopy, snapshot: ReviewNetworkSnapshot, commitOid: string, branch: string, signal?: AbortSignal, expected = "") {
    reviewBranch(branch);
    if (expected) oid(expected);
    await this.network(snapshot, ["-c", "push.recurseSubmodules=no", "push", "--porcelain", `--force-with-lease=refs/heads/${branch}:${expected}`, "--", snapshot.url, `${oid(commitOid)}:refs/heads/${branch}`], signal, copy);
  }
  /** Raw blob bytes for the given objects through one `cat-file --batch`: no filter, eol, export-subst or textconv ever applies. */
  private readBlobs(gitDir: string, oids: readonly string[], signal?: AbortSignal): Promise<Map<string, Buffer>> {
    // ponytail: a read view is held in memory while written; repositories above this size cannot be viewed.
    const LIMIT = 512 * 1024 * 1024;
    return new Promise((resolvePromise, reject) => {
      const args = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", `--git-dir=${gitDir}`, "cat-file", "--batch"];
      const child = spawn(this.executable, args, { env: this.env(args, false, { GIT_NO_LAZY_FETCH: "1" }), stdio: ["pipe", "pipe", "ignore"], signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000) });
      const chunks: Buffer[] = []; let total = 0, failed = false;
      child.stdout.on("data", (chunk: Buffer) => { total += chunk.length; if (total > LIMIT && !failed) { failed = true; child.kill("SIGKILL"); reject(new Error("读视图超过 512 MiB，无法生成。")); } else chunks.push(chunk); });
      child.on("error", error => { if (!failed) { failed = true; reject(error); } });
      child.on("close", () => {
        if (failed) return;
        const data = Buffer.concat(chunks), result = new Map<string, Buffer>(); let at = 0;
        try {
          for (const expected of oids) {
            const end = data.indexOf(0x0a, at); if (end < 0) throw new Error("Git 对象输出被截断。");
            const [name, type, size] = data.subarray(at, end).toString("utf8").split(" ");
            if (name !== expected || type !== "blob" || size === undefined) throw new Error("读视图中有缺失的对象。");
            const length = Number(size), start = end + 1; if (!Number.isInteger(length) || start + length > data.length) throw new Error("Git 对象输出被截断。");
            result.set(expected, data.subarray(start, start + length)); at = start + length + 1;
          }
          resolvePromise(result);
        } catch (error) { reject(error); }
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(`${oids.join("\n")}\n`);
    });
  }
  /**
   * Materialize raw objects only: links are target text, gitlinks are not expanded. Reject aliases before writing,
   * including directory prefixes (A/one and a/two), since Git names are case-sensitive and APFS commonly is not.
   */
  async checkoutView(gitDir: string, commitOid: string, target: string, signal?: AbortSignal): Promise<void> {
    oid(commitOid);
    const listing = await this.run(gitDir, [`--git-dir=${gitDir}`, "ls-tree", "-r", "-t", "-z", "--full-tree", commitOid], signal, false, { GIT_NO_LAZY_FETCH: "1" });
    const entries = listing.split("\0").filter(Boolean).flatMap(record => {
      const at = record.indexOf("\t"), [mode, type, hash] = record.slice(0, at).split(" "), path = record.slice(at + 1);
      if (at < 0 || !["blob", "tree", "commit"].includes(type ?? "") || !mode || !hash || !OID.test(hash)) return [];
      try { return [{ mode, type, hash, path: reviewPath(path) }]; } catch { return []; }
    });
    const names = new Map<string, string>(), paths = new Set<string>();
    for (const entry of entries) {
      if (paths.has(entry.path)) throw new ReviewViewError(`读视图条目重名：${entry.path}`);
      paths.add(entry.path);
      const parts = entry.path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const name = parts.slice(0, i).join("/");
        // Conservative Unicode folding also catches decomposed names, sharp-s and final sigma aliases.
        const folded = name.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD"), previous = names.get(folded);
        if (previous !== undefined && previous !== name) throw new ReviewViewError(`读视图条目大小写折叠后重名：${previous} / ${name}`);
        names.set(folded, name);
      }
    }
    // The caller owns the existing parent (0700 job directory). Canonicalize OS aliases such as /var before anchoring
    // the view; never recursively mkdir through a missing or symbolic-link view root.
    const parent = dirname(resolve(target));
    if ((await lstat(parent)).isSymbolicLink()) throw new ReviewViewError("读视图父目录不能是符号链接。");
    const root = join(await realpath(parent), basename(target));
    const stat = (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!await stat(root)) await mkdir(root, { mode: 0o700 });
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new ReviewViewError("读视图根必须是普通目录，不能是符号链接。");
    const rootReal = await realpath(root);
    const checkDirectory = async (path: string) => {
      signal?.throwIfAborted();
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ReviewViewError("读视图路径含符号链接或非目录父路径。");
      if (path === rootReal && (info.dev !== rootStat.dev || info.ino !== rootStat.ino)) throw new ReviewViewError("读视图根目录已变化。");
      const resolved = await realpath(path), inside = relative(rootReal, resolved);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new ReviewViewError("读视图父目录超出视图根。");
    };
    const parents = async (parts: string[], create: boolean): Promise<boolean> => {
      let directory = rootReal;
      await checkDirectory(directory);
      for (const part of parts) {
        // Check immediately before each mkdir, and recheck the created/existing directory before descending.
        await checkDirectory(directory);
        const next = join(directory, part);
        if (!await stat(next)) {
          if (!create) return false;
          await mkdir(next, { mode: 0o700 });
        }
        await checkDirectory(next); directory = next;
      }
      return true;
    };
    const files = entries.filter(entry => entry.type === "blob");
    // Validate existing parents/leaves for the entire view before materializing any object.
    for (const entry of files) {
      const parts = entry.path.split("/"); parts.pop();
      if (await parents(parts, false) && await stat(join(rootReal, entry.path))) throw new ReviewViewError(`读视图路径已经存在：${entry.path}`);
    }
    const blobs = files.length ? await this.readBlobs(gitDir, [...new Set(files.map(e => e.hash))], signal) : new Map<string, Buffer>();
    for (const entry of files) {
      const parts = entry.path.split("/"); parts.pop();
      await parents(parts, true);
      const destination = join(rootReal, entry.path);
      if (await stat(destination)) throw new ReviewViewError(`读视图路径已经存在：${entry.path}`);
      // No actual symlinks are ever created. O_EXCL prevents clobbering a leaf/alias; O_NOFOLLOW refuses a link leaf.
      const file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.mode === "100755" ? 0o755 : 0o644);
      try { await file.writeFile(blobs.get(entry.hash)!); } finally { await file.close(); }
    }
  }
  /** The git dir of a user repository, resolved without touching its worktree. */
  async gitDirectory(repository: ReviewRepository, signal?: AbortSignal): Promise<string> { return (await this.run(repository.path, ["rev-parse", "--absolute-git-dir"], signal)).trim(); }
  async hasCommit(gitDir: string, commitOid: string, signal?: AbortSignal): Promise<boolean> {
    try { await this.run(gitDir, [`--git-dir=${gitDir}`, "cat-file", "-e", `${oid(commitOid)}^{commit}`], signal); return true; } catch { signal?.throwIfAborted(); return false; }
  }
  /** A private copy positioned on `commitOid`, cloned from a retained group git dir (hard-linked objects, no network). */
  async prepareAt(source: string, commitOid: string, directory: string, signal?: AbortSignal): Promise<ReviewCopy> {
    const copy = { directory, git: join(directory, "git"), tree: join(directory, "tree") };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.run(directory, ["clone", "--no-checkout", "--template=", `--separate-git-dir=${copy.git}`, "--", source, copy.tree], signal);
    await writeFile(join(copy.git, "config"), `[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\n`, { mode: 0o600 });
    await this.copyRun(copy, ["cat-file", "-e", `${oid(commitOid)}^{commit}`], signal);
    await this.copyRun(copy, ["checkout", "--detach", commitOid, "--"], signal);
    return copy;
  }
  /** Fetch a remote branch through the managed network entry; the tip must be exactly `expected`. */
  async fetchTip(copy: ReviewCopy, snapshot: ReviewNetworkSnapshot, branch: string, expected: string, signal?: AbortSignal): Promise<boolean> {
    reviewBranch(branch);
    await this.network(snapshot, ["fetch", "--no-tags", "--", snapshot.url, `+refs/heads/${branch}:refs/paraself/target`], signal, copy);
    return (await this.copyRun(copy, ["rev-parse", "--verify", "refs/paraself/target^{commit}"], signal)).trim() === expected;
  }
  /** Parents of a commit in the copy. */
  async parents(copy: ReviewCopy, commitOid: string, signal?: AbortSignal): Promise<string[]> {
    return (await this.copyRun(copy, ["rev-list", "--parents", "-n", "1", oid(commitOid)], signal)).trim().split(" ").slice(1).map(oid);
  }
  async isAncestor(copy: ReviewCopy, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean> {
    try { await this.copyRun(copy, ["merge-base", "--is-ancestor", oid(ancestor), oid(descendant)], signal); return true; } catch { signal?.throwIfAborted(); return false; }
  }
  /**
   * Keep an appended commit in the group's retained object store: fetch the execution copy's HEAD into a pinned private ref
   * (creating a bare store if the group has none). Local object copy only, no network.
   */
  async adoptCommit(source: string, target: string, ref: string, commitOid: string, signal?: AbortSignal): Promise<void> {
    oid(commitOid);
    if (!/^refs\/paraself\/[\w.-]+$/u.test(ref)) throw new Error("保留引用名无效。");
    if (!await lstat(join(target, "HEAD")).then(() => true, () => false)) await this.run(source, ["init", "--bare", "--template=", target], signal);
    await this.run(target, [`--git-dir=${target}`, "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--", source, `+HEAD:${ref}`], signal);
    if (!await this.hasCommit(target, commitOid, signal)) throw new Error("新提交未能保留到组的对象库。");
  }
  async checkoutDetached(copy: ReviewCopy, commitOid: string, signal?: AbortSignal) { await this.copyRun(copy, ["checkout", "--detach", oid(commitOid), "--"], signal); }
  async headOid(copy: ReviewCopy, signal?: AbortSignal): Promise<string> { return oid((await this.copyRun(copy, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim()); }
  async ensureOwnedDirectory(jobsRoot: string, jobId: string, directory: string) {
    if (!/^[a-f0-9-]{36}$/u.test(jobId) || resolve(directory, "..") !== resolve(jobsRoot, jobId)) throw new Error("副本目录所有权无效。");
    const root = await realpath(jobsRoot), parent = join(root, jobId);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (await realpath(parent) !== parent) throw new Error("任务目录被符号链接重定向，已停止准备副本。");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const expected = resolve(root, relative(resolve(jobsRoot), resolve(directory)));
    if (await realpath(directory) !== expected || (await readdir(directory)).length) throw new Error("副本目录不是本次登记的空目录。");
  }
  async assertOwnedDirectory(jobsRoot: string, jobId: string, directory: string) {
    if (!/^[a-f0-9-]{36}$/u.test(jobId)) throw new Error("任务目录标识无效。");
    const rel = relative(resolve(jobsRoot, jobId), resolve(directory));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("目录不属于任务。");
    const root = await realpath(jobsRoot), parent = join(root, jobId);
    if (await realpath(parent) !== parent || await realpath(directory) !== resolve(parent, rel)) throw new Error("任务目录被符号链接重定向。");
  }
  async cleanupOrphan(jobsRoot: string, name: string) {
    if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name)) throw new Error("孤立任务目录名无效。");
    const root = await realpath(jobsRoot), expected = join(root, name);
    const target = await realpath(expected).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (target === null) return;
    if (target !== expected) throw new Error("拒绝清理被符号链接重定向的孤立目录。");
    await rm(target, { recursive: true, force: true });
  }
  async cleanup(jobsRoot: string, jobId: string, directory: string) {
    if (!/^[a-f0-9-]{36}$/u.test(jobId)) throw new Error("任务目录标识无效。");
    const relativePath = relative(resolve(jobsRoot, jobId), resolve(directory));
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("拒绝清理任务范围外的目录。");
    const root = await realpath(jobsRoot), expectedParent = join(root, jobId), expected = resolve(expectedParent, relativePath);
    const target = await realpath(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (target === null) return;
    if (await realpath(expectedParent) !== expectedParent || target !== expected) throw new Error("拒绝清理被符号链接重定向的副本目录。");
    await rm(target, { recursive: true, force: true });
  }
}

const GIT_BEHAVIOR_FILES = new Set([".gitattributes", ".gitmodules", ".gitconfig", ".gitmessage", ".git-blame-ignore-revs"]);
/** What every review and agent reads as the repository's rules (docs/review-collaboration-design.md: 改 REVIEW.md 与 AGENTS.md 属于高风险). */
const RULE_FILES = new Set(["review.md", "agents.md", "claude.md"]);
export function reviewRisks(changes: ReviewChange[], lfs = new Set<string>()): string[] {
  return [...new Set(changes.filter(c => {
    const paths = [c.path, c.oldPath].filter((p): p is string => !!p);
    return paths.some(p => lfs.has(p) || /^(?:\.github\/|\.gitlab(?:\/|-ci)|\.circleci\/|azure-pipelines|Jenkinsfile(?:$|\/)|bitbucket-pipelines\.yml$|\.husky\/|lefthook)/u.test(p) || GIT_BEHAVIOR_FILES.has(p.slice(p.lastIndexOf("/") + 1).toLowerCase()) || RULE_FILES.has(p.slice(p.lastIndexOf("/") + 1).toLowerCase())) || [c.oldMode, c.newMode].some(m => m === "120000" || m === "160000") || (c.newMode === "100755" && c.oldMode !== "100755");
  }).flatMap(c => [c.path, ...(c.oldPath ? [c.oldPath] : [])]))].sort();
}
