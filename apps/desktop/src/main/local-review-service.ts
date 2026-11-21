import { LocalReviewDependencies, type ReviewDependencies } from "./local-review-dependencies.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { localReviewFromPrSchema, prCommentTitle, prDescriptionWithRound, prResponseReply, prRoundChanges, type LocalReviewFromPr, type PrResponseKind } from "@cognelis/decision-protocol";
import { answeredIn } from "./pr-comment-responses.js";
import type { PrThread } from "./pr-platform-client.js";
import { localReviewStateSchema, localReviewJobSchema, localReviewGroupSchema, localReviewSettingsSchema, localReviewAnnotateSchema, localReviewActionSchema, localReviewSendMessageSchema, localReviewExecuteSchema, localReviewMarkReadSchema, localReviewConversationActionSchema, LOCAL_REVIEW_MAX_GROUPS, LOCAL_REVIEW_MESSAGE_SOFT_LIMIT, LOCAL_REVIEW_MAX_TURN_ATTEMPTS, LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS, type LocalReviewMessage, type LocalReviewTurn, type LocalReviewExecution, type LocalReviewState, type LocalReviewJob, type LocalReviewGroup, type LocalReviewSession, type LocalReviewSettings, type LocalReviewAction, type ModelProviderProfile, type PrConnection } from "@cognelis/decision-protocol";
import { reviewSecretFindings, scanReviewArtifact } from "./local-review-secret-scan.js";
import { atomicWrite } from "./atomic-write.js";
import { LocalReviewGit, ReviewViewError, reviewBranch, type ReviewCopy } from "./local-review-git.js";
import { createLocalReviewWorker } from "./local-review-workers.js";
import type { LocalReviewWorker } from "./local-review-worker.js";
import type { LocalReviewWorkerKind } from "@cognelis/decision-protocol";
import type { AssistantGatewayLike } from "./decision-assistant-service.js";
import type { PrConnections } from "./pr-connections.js";
import { prWebBase } from "./pr-platform-client.js";
import { buildDiscussionRequest, discussionBudget, discussionOverhead, DiscussionBudgetError, executionContext, validatePlan, type DiscussionView } from "./local-review-conversation.js";

const networkSnapshot = z.object({ url: z.string(), directory: z.string(), credentialHelpers: z.array(z.string()), sshCommand: z.string().nullable() });
const segment = z.string().min(1).refine(s => s !== "." && s !== ".." && !/[\\/\0]/u.test(s));
const ownerSchema = z.object({ jobId: segment, name: z.union([z.literal(""), segment]), kind: z.enum(["probe", "evaluation", "dependencies", "group", "orphan", "turn", "execution"]), createdAt: z.string().datetime(), touchedAt: z.string().datetime().optional(), state: z.enum(["preparing", "ready", "cleanup_failed"]), cleanup: z.enum(["tree", "all"]).nullable().default(null), error: z.string().nullable() });
// The internal ledger is version 2; the IPC state stays version 1. Old builds require version 1 and so refuse (never rewrite) a v2 file.
const ledgerSchema = localReviewStateSchema.extend({ version: z.literal(2), owners: z.array(ownerSchema).default([]), jobs: z.array(localReviewJobSchema.extend({ network: networkSnapshot.nullable().default(null), selectedGroupIds: z.array(z.string().uuid()).max(LOCAL_REVIEW_MAX_GROUPS).nullable().default(null) }).strict()) }).strict();
// The previous ledger shape, kept only to read and migrate version 1 files (and to prove an old reader rejects version 2).
const legacyGroupSchema = z.object(localReviewGroupSchema.omit({ origin: true, requirements: true, commits: true }).shape);
export const legacyLedgerSchemaV1 = z.object({ ...localReviewStateSchema.shape, owners: z.array(ownerSchema).default([]), jobs: z.array(z.object({ ...localReviewJobSchema.omit({ conversation: true, turns: true, executions: true, groups: true }).shape, groups: z.array(legacyGroupSchema).max(8), network: networkSnapshot.nullable().default(null), selectedGroupIds: z.array(z.string().uuid()).max(8).nullable().default(null) })) });
export const ledgerSchemaV2 = ledgerSchema;
export function migrateLedgerV1(legacy: z.infer<typeof legacyLedgerSchemaV1>): Ledger {
  return ledgerSchema.parse({ ...legacy, version: 2, jobs: legacy.jobs.map(job => ({ ...job, conversation: { messages: [], nextSeq: 1, readSeq: 0 }, turns: [], executions: [], groups: job.groups.map(g => ({ ...g, origin: "evaluation", requirements: "", commits: g.artifact ? [{ oid: g.artifact.commitOid, executionId: null }] : [] })) })) });
}
type Ledger = z.infer<typeof ledgerSchema>;
type StoredJob = Ledger["jobs"][number];
type DirectoryOwner = Ledger["owners"][number];
type StoredExecution = StoredJob["executions"][number];
// pending executions occupy their group; EXEC_ACTIVE are running; blocked waits for authorization or a discard.
const EXEC_ACTIVE = new Set(["fixing", "committed", "pushing", "commenting"]);
const EXEC_OCCUPYING = new Set(["pending", "fixing", "committed", "pushing", "commenting", "blocked"]);

const active = new Set(["fixing", "pushing", "opening_pr"]);
/** The PR's branch is no longer at the head its fix was made on: nothing is pushed over it, the fix is redone on the new head. */
class PrBranchMovedError extends Error {}
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 2000) : "操作失败。";
export const localReviewSummary = (job: LocalReviewJob) => ({
  counts: Object.fromEntries([...new Set(job.groups.map(g => g.state))].map(state => [state, job.groups.filter(g => g.state === state).length])),
  needsAttention: job.groups.filter(g => ["failed", "blocked", "interrupted", "pushed_no_pr"].includes(g.state) || (g.state === "pending" && job.state === "finished")).length + job.verdicts.filter(v => v.verdict === "needs_input").length,
  remoteEffects: job.groups.filter(g => g.pushObservedSha || g.pr).length,
});

export function localReviewNotification(job: LocalReviewJob) {
  if (job.possibleLaunchdLabels?.length) return { title: "可能出现新的 launchd 任务", body: `请检查可能新增的标签：${job.possibleLaunchdLabels.slice(0,3).map(label=>label.slice(0,80)).join("、")}。完整列表见任务详情，也可能来自宿主正常活动。` };
  const summary = localReviewSummary(job); return { title: "本地审阅已结束", body: `${job.groups.filter(g => g.state === "pr_opened").length} 个 PR，${summary.needsAttention} 项需要处理。` };
}

/** The path is interpreted only under the configured platform, including its context path. */
export function localReviewRemoteRepository(url: string, connection: PrConnection): string | null {
  let host: string, path: string;
  try {
    const remote = url.includes("://") ? new URL(url) : new URL(`ssh://${url.replace(":", "/")}`);
    host = remote.hostname; path = decodeURIComponent(remote.pathname).replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
    const base = new URL(prWebBase(connection));
    if (host !== base.hostname || (remote.protocol !== "ssh:" && remote.port !== base.port)) return null;
    const prefix = base.pathname.replace(/^\/+|\/+$/gu, "");
    if (remote.protocol !== "ssh:" && prefix && !path.startsWith(`${prefix}/`)) return null;
    if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length + 1);
    if (connection.platform === "bitbucket-server") path = path.replace(/^scm\//u, "");
    if (!path || path.split("/").some(p => !p || p === "." || p === "..") || (connection.platform !== "gitlab" && path.split("/").length !== 2)) return null;
    return path;
  } catch { return null; }
}

export class LocalReviewService {
  private data: Ledger = { version: 2, repositories: [], sessions: [], jobs: [], owners: [] };
  private writes: Promise<unknown> = Promise.resolve();
  private worker: Promise<void> | null = null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly completions = new Map<string, Promise<void>>();
  /** What the single worker slot is running for a job, so a cancel aborts only the operation it means. */
  private readonly operations = new Map<string, { kind: "job" | "turn" | "exec"; id: string }>();
  private readonly locks = new Set<string>();
  private readonly submissions = new Set<Promise<void>>();
  private closing = false;
  private storageFault: unknown;
  readonly jobsRoot: string;
  private readonly dependencies: LocalReviewDependencies;
  constructor(private readonly root: string, private readonly git: LocalReviewGit, private readonly connections: PrConnections, private readonly profiles: () => Promise<ModelProviderProfile[]>, private readonly environment: NodeJS.ProcessEnv = process.env, private readonly notify: (job: LocalReviewJob) => void = () => undefined, private readonly gateway?: AssistantGatewayLike) { this.jobsRoot = join(root, "jobs"); this.dependencies = new LocalReviewDependencies(join(root, "dependencies"), git, environment); }
  async start() {
    await mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
    let raw: string | null = null;
    try { raw = await readFile(join(this.root, "ledger.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("本地审阅账本无法读取，已保留原文件并停止队列。"); }
    if (raw !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { throw new Error("本地审阅账本无法读取，已保留原文件并停止队列。"); }
      const version = (parsed as { version?: unknown } | null)?.version;
      if (version === 1) {
        let legacy: z.infer<typeof legacyLedgerSchemaV1>;
        try { legacy = legacyLedgerSchemaV1.parse(parsed); } catch { throw new Error("本地审阅账本无法读取，已保留原文件并停止队列。"); }
        try { await this.backupLedger(raw); } catch (error) { throw new Error(`本地审阅账本备份失败，未迁移，已保留原文件并停止队列：${message(error)}`); }
        this.data = migrateLedgerV1(legacy);
        await atomicWrite(join(this.root, "ledger.json"), JSON.stringify(this.data));
      } else {
        try { this.data = ledgerSchema.parse(parsed); } catch { throw new Error("本地审阅账本无法读取，已保留原文件并停止队列。"); }
      }
    }
    await this.write(data => {
      for (const job of data.jobs) {
        if (["evaluating", "preparing_dependencies", "running_groups"].includes(job.state)) job.state = "interrupted";
        for (const group of job.groups) if (active.has(group.state) || (group.state === "committed" && job.executions.some(e => e.kind === "new" && e.groupId === group.id))) group.state = "interrupted";
        this.interruptConversation(job);
      }
    });
    for (const job of this.data.jobs) await this.settleNewExecutions(job.id);
    await this.recoverDirectories();
    await this.dependencies.start();
    this.kick();
  }
  /** Copy the v1 file verbatim before migrating. A different file already named .bak is never claimed as this backup. */
  private async backupLedger(raw: string) {
    const writeOnce = async (path: string) => {
      const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (existing === null) { await writeFile(path, raw, { flag: "wx", mode: 0o600 }); if (await readFile(path, "utf8") !== raw) throw new Error("备份内容校验失败。"); return true; }
      return existing === raw;
    };
    if (await writeOnce(join(this.root, "ledger.v1.bak.json"))) return;
    if (!await writeOnce(join(this.root, `ledger.v1.${createHash("sha256").update(raw).digest("hex").slice(0, 16)}.bak.json`))) throw new Error("已有的备份文件与当前账本不同，无法确认备份。");
  }
  state(): LocalReviewState { if (this.storageFault) throw new Error("本地审阅账本写入失败，队列已停止。"); const state = localReviewStateSchema.parse({ ...structuredClone(this.data), version: 1 });
    for (const job of state.jobs) for (const group of job.groups) if (group.artifact) {
      const findings = reviewSecretFindings(group.artifact.diff);
      if (findings.length) {
        group.artifact.secretFindings = findings; group.artifact.diff = "";
        group.fix = null; group.title = `变更组 ${group.ordinal}`;
        group.reason = "新增内容命中敏感形态规则，仅可丢弃。";
        group.error = "敏感形态扫描已阻止推送，仅可丢弃。";
      }
    }
    for (const job of state.jobs) for (const execution of job.executions) if (execution.artifact) {
      const findings = reviewSecretFindings(execution.artifact.diff);
      if (findings.length || execution.artifact.secretFindings?.length) {
        execution.artifact.secretFindings = findings.length ? findings : execution.artifact.secretFindings!; execution.artifact.diff = "";
        execution.fix = null; execution.comment = null; execution.excludedFiles = [];
        execution.error = "敏感形态扫描已阻止推送，仅可丢弃。";
      }
    }
    return state; }
  private write(change: (data: Ledger) => void): Promise<void> {
    const result = this.writes.then(async () => {
      if (this.storageFault) throw this.storageFault;
      const next = structuredClone(this.data); change(next);
      ledgerSchema.parse(next);
      try { await atomicWrite(join(this.root, "ledger.json"), JSON.stringify(next)); }
      catch (error) { this.storageFault = error; this.closing = true; for (const controller of this.controllers.values()) controller.abort(); throw error; }
      this.data = next;
    });
    this.writes = result.catch(() => undefined);
    return result;
  }
  private update(id: string, change: (job: StoredJob) => void) { return this.write(data => { const job = data.jobs.find(j => j.id === id); if (!job) throw new Error("审阅任务不存在。"); change(job); job.updatedAt = new Date().toISOString(); }); }
  private job(id: string) { const job = this.data.jobs.find(j => j.id === id); if (!job) throw new Error("审阅任务不存在。"); return job; }
  private session(repositoryId: string, sessionId: string): LocalReviewSession {
    const session = this.data.sessions.find(s => s.id === sessionId && s.repositoryId === repositoryId);
    if (!session) throw new Error("审阅会话不属于这个工程。"); return session;
  }
  private repository(id: string) { const repository = this.data.repositories.find(r => r.id === id); if (!repository) throw new Error("请先选择工程目录。"); return repository; }
  private copy(jobId: string, name: string): ReviewCopy { const directory = join(this.jobsRoot, jobId, name); return { directory, tree: join(directory, "tree"), git: join(directory, "git") }; }
  private async own(owner: DirectoryOwner) {
    await this.write(data => { if (!data.owners.some(o => o.jobId === owner.jobId && o.name === owner.name)) data.owners.push(owner); });
  }
  private async removeOwned(jobId: string, name: string, treeOnly = false) {
    const directory = this.copy(jobId, name).directory;
    try {
      if (!name) await this.git.cleanupOrphan(this.jobsRoot, jobId);
      else await this.git.cleanup(this.jobsRoot, jobId, treeOnly ? join(directory, "tree") : directory);
      if (!treeOnly && !this.data.jobs.some(j => j.id === jobId) && name) {
        await rmdir(join(this.jobsRoot, jobId)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; });
      }
      await this.write(data => { if (!treeOnly) data.owners = data.owners.filter(o => o.jobId !== jobId || o.name !== name); else { const owner = data.owners.find(o => o.jobId === jobId && o.name === name); if (owner) { owner.state = "ready"; owner.cleanup = null; owner.error = null; } } });
    } catch (error) {
      if (this.storageFault) throw error;
      await this.write(data => { const owner = data.owners.find(o => o.jobId === jobId && o.name === name); if (owner) { owner.state = "cleanup_failed"; owner.cleanup = treeOnly ? "tree" : "all"; owner.error = message(error); } });
      throw error;
    }
  }
  private ownerKind(name: string): DirectoryOwner["kind"] { return name === "probe" ? "probe" : name === "evaluation" ? "evaluation" : name === "dependencies" ? "dependencies" : name.startsWith("turn-") ? "turn" : name.startsWith("exec-") ? "execution" : "group"; }
  private async prepareOwned(jobId: string, name: string, snapshot: LocalReviewSession["snapshot"], signal?: AbortSignal, build?: (directory: string) => Promise<ReviewCopy>) {
    signal?.throwIfAborted();
    if (this.data.owners.some(o => o.jobId === jobId && o.name === name)) await this.removeOwned(jobId, name);
    await this.own({ jobId, name, kind: this.ownerKind(name), createdAt: new Date().toISOString(), state: "preparing", cleanup: null, error: null });
    try {
      const copy = this.copy(jobId, name);
      await this.git.ensureOwnedDirectory(this.jobsRoot, jobId, copy.directory);
      if (build) await build(copy.directory); else await this.git.prepare(snapshot, copy.directory, signal);
      await this.write(data => { data.owners.find(o => o.jobId === jobId && o.name === name)!.state = "ready"; });
      return copy;
    } catch (error) {
      if (this.storageFault) throw error;
      try { await this.removeOwned(jobId, name); } catch (cleanupError) { throw new Error(`${message(error)}；副本清理失败：${message(cleanupError)}`); }
      throw error;
    }
  }
  private async recoverDirectories() {
    // Enumerate only this application's jobs namespace, never a user repository/worktree registry.
    for (const entry of await readdir(this.jobsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const job = this.data.jobs.find(j => j.id === entry.name);
      if (!job) {
        await this.own({ jobId: entry.name, name: "", kind: "orphan", createdAt: new Date().toISOString(), state: "cleanup_failed", cleanup: "all", error: null });
        try { await this.removeOwned(entry.name, ""); await this.write(data => { data.owners = data.owners.filter(o => o.jobId !== entry.name); }); } catch (error) { if (this.storageFault) throw error; console.error("local-review orphan cleanup", message(error)); }
        continue;
      }
      try { await this.git.assertOwnedDirectory(this.jobsRoot, job.id, join(this.jobsRoot, job.id)); }
      catch (error) { await this.update(job.id, j => { j.error = message(error); }); continue; }
      // Old ledgers can have a known copy before ownership bookkeeping was introduced.
      const known = new Set(["probe", "evaluation", "dependencies", ...job.groups.map(g => g.id), ...job.executions.map(e => `exec-${e.id}`)]);
      for (const name of known) {
        if (!await lstat(this.copy(job.id, name).directory).then(() => true, () => false)) continue;
        await this.own({ jobId: job.id, name, kind: this.ownerKind(name), createdAt: job.updatedAt, state: "ready", cleanup: null, error: null });
      }
      for (const child of await readdir(join(this.jobsRoot, job.id), { withFileTypes: true })) {
        if (known.has(child.name) || (!child.isDirectory() && !child.isSymbolicLink())) continue;
        await this.own({ jobId: job.id, name: child.name, kind: "orphan", createdAt: job.updatedAt, state: "cleanup_failed", cleanup: "all", error: null });
      }
    }
    for (const owner of [...this.data.owners]) {
      const job = this.data.jobs.find(j => j.id === owner.jobId);
      if (!job) {
        try { await this.removeOwned(owner.jobId, owner.name); } catch (error) { if (this.storageFault) throw error; }
        continue;
      }
      const expired = Date.now() - Date.parse(owner.touchedAt ?? owner.createdAt) > 14 * 86400_000;
      const group = job.groups.find(g => g.id === owner.name);
      const execution = job.executions.find(e => `exec-${e.id}` === owner.name);
      // Published groups keep git/ (tree already removed) for conversation views and appends, until the 14-day expiry.
      const published = !!group && ["pr_opened", "pushed_no_pr"].includes(group.state);
      const terminal = (group && (["no_changes"].includes(group.state) || !group.retryable || (group.state === "cancelled" && !group.artifact && group.intent !== "commit"))) || (execution && (["done", "no_changes", "remote_changed"].includes(execution.state) || (["cancelled", "failed", "interrupted"].includes(execution.state) && !execution.newCommitOid && execution.intent !== "commit")));
      if (owner.name.startsWith("turn-")) { try { await this.removeOwned(owner.jobId, owner.name); } catch (error) { if (this.storageFault) throw error; } continue; }
      if (owner.name !== "probe" && owner.name !== "dependencies" && !expired && !terminal && owner.state !== "cleanup_failed") continue;
      if (expired && group && !["pr_opened", "pushed_no_pr", "no_changes"].includes(group.state)) await this.update(job.id, j => { const g = j.groups.find(g => g.id === group.id)!; g.state = "failed"; g.retryable = false; g.error = "产物已过期"; });
      try { await this.removeOwned(owner.jobId, owner.name, !expired && !terminal && !published && owner.cleanup === "tree"); } catch (error) { if (this.storageFault) throw error; if (group) await this.update(job.id, j => { j.groups.find(g => g.id === group.id)!.cleanupError = message(error); }); }
    }
  }
  async register(path: string, baseBranch?: string) {
    const snapshot = await this.git.inspect(path, baseBranch), existing = this.data.repositories.find(r => r.snapshot.path === snapshot.path);
    if (existing) return this.newSession(existing.id, baseBranch);
    const id = randomUUID(), sessionId = randomUUID();
    await this.write(data => { data.repositories.push({ id, name: basename(snapshot.path), snapshot, settings: { worker: "codex", pushRemote: "origin", baseBranch: baseBranch ?? snapshot.branch!, reviewers: [] } }); data.sessions.push({ id: sessionId, repositoryId: id, snapshot, annotations: [] }); });
    return sessionId;
  }
  async newSession(repositoryId: string, baseBranch?: string) {
    if (this.closing) throw new Error("本地审阅正在退出。");
    const repository = this.repository(repositoryId), snapshot = await this.git.inspect(repository.snapshot.path, baseBranch), id = randomUUID();
    await this.write(data => { data.sessions.push({ id, repositoryId, snapshot, annotations: [] }); }); return id;
  }
  async clearDependencies(repositoryId: string) { this.repository(repositoryId); await this.dependencies.clear(repositoryId); }
  async saveSettings(repositoryId: string, settings: LocalReviewSettings) {
    const parsed = localReviewSettingsSchema.parse(settings); reviewBranch(parsed.baseBranch); this.repository(repositoryId);
    await this.write(data => { data.repositories.find(r => r.id === repositoryId)!.settings = parsed; });
  }
  private async target(snapshot: LocalReviewSession["snapshot"], settings: LocalReviewSettings, signal?: AbortSignal) {
      const network = await this.git.captureNetwork(snapshot, settings.pushRemote, signal);
      const pushUrl = network.url;
      const origin = await this.git.originUrl(snapshot, signal), matches = (await this.connections.list()).flatMap(connection => {
        const sourceRepository = localReviewRemoteRepository(pushUrl, connection), destinationRepository = localReviewRemoteRepository(origin ?? pushUrl, connection);
        return sourceRepository && destinationRepository ? [{ id: connection.id, platform: connection.platform, baseUrl: connection.baseUrl, sourceRepository, destinationRepository }] : [];
      });
      const connection = matches.length === 1 ? matches[0]! : null;
      const prUnavailable = !connection ? "没有唯一匹配的代码平台链接，仅推送分支。" : connection.platform === "gitlab" && connection.sourceRepository !== connection.destinationRepository ? "暂不支持 GitLab 跨 fork PR，仅推送分支。" : null;
      return { pushUrl, network, connection, prUnavailable };
  }
  async files(repositoryId: string, sessionId: string) {
    const session = this.session(repositoryId, sessionId);
    const target = await this.target(session.snapshot, this.repository(repositoryId).settings).catch(error => ({ pushUrl: null, prUnavailable: message(error) }));
    return { files: await this.git.files(session.snapshot, "new"), diff: await this.git.diff(session.snapshot), pushUrl: target.pushUrl, prUnavailable: target.prUnavailable };
  }
  async read(repositoryId: string, sessionId: string, path: string, side: "old" | "new") { return this.git.readFile(this.session(repositoryId, sessionId).snapshot, path, side); }
  async annotate(input: z.infer<typeof localReviewAnnotateSchema>) {
    const request = localReviewAnnotateSchema.parse(input), session = this.session(request.repositoryId, request.sessionId);
    const text = await this.read(request.repositoryId, request.sessionId, request.path, request.side), lines = text.split("\n");
    if (request.endLine < request.startLine || request.endLine > lines.length) throw new Error("意见行号超出固定提交的文件范围。");
    if (request.annotationId && !session.annotations.some(a => a.id === request.annotationId)) throw new Error("意见不存在。");
    const id = request.annotationId ?? randomUUID(), { repositoryId: _, sessionId: __, annotationId: ___, ...fields } = request;
    const annotation = { ...fields, id, lineText: lines.slice(request.startLine - 1, request.endLine).join("\n") };
    await this.write(data => { const s = data.sessions.find(s => s.id === session.id)!; s.annotations = [...s.annotations.filter(a => a.id !== id), annotation]; }); return id;
  }
  async removeAnnotation(repositoryId: string, sessionId: string, annotationId: string) {
    this.session(repositoryId, sessionId);
    await this.write(data => { const session = data.sessions.find(s => s.id === sessionId)!; session.annotations = session.annotations.filter(a => a.id !== annotationId); });
  }
  async submit(repositoryId: string, sessionId: string, profileId: string, worker?: LocalReviewWorkerKind) {
    if (this.closing) throw new Error("本地审阅队列已关闭。");
    const key = `submit-${sessionId}`; if (this.locks.has(key)) throw new Error("此会话正在提交。"); this.locks.add(key);
    const id = randomUUID(), controller = new AbortController(); this.controllers.set(id, controller);
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; }); this.submissions.add(completion);
    try {
      const session = structuredClone(this.session(repositoryId, sessionId)), repository = structuredClone(this.repository(repositoryId));
      if (!session.annotations.length) throw new Error("请先添加审阅意见。");
      const profile = (await this.profiles()).find(p => p.profileId === profileId);
      if (!profile) throw new Error("审阅模型档案不存在。");
      const selectedWorker = worker ?? repository.settings.worker;
      const agent = createLocalReviewWorker(selectedWorker, profile, this.environment, this.gateway, id), signal = controller.signal;
      const { pushUrl, network, connection, prUnavailable } = await this.target(session.snapshot, repository.settings, signal);
      await this.git.checkBase(network, repository.settings.baseBranch, signal);
      const copy = await this.prepareOwned(id, "probe", session.snapshot, signal);
      try { await agent.capability(copy, signal); } finally { await this.removeOwned(id, "probe"); }
      signal.throwIfAborted(); if (this.closing) throw new Error("本地审阅正在退出。");
      const now = new Date().toISOString();
      await this.write(data => { data.repositories.find(r => r.id === repositoryId)!.settings.worker = selectedWorker; data.jobs.push({ worker: selectedWorker, id, repositoryId, sessionId, snapshot: session.snapshot, annotations: session.annotations, settings: { ...repository.settings, worker: selectedWorker }, profile, state: "queued", createdAt: now, updatedAt: now, pushUrl, network, selectedGroupIds: null, connection, prUnavailable, pr: null, verdicts: [], originalGroups: null, fallback: null, planVersion: 0, groups: [], rejectedPrGroupId: null, error: null, conversation: { messages: [], nextSeq: 1, readSeq: 0 }, turns: [], executions: [] }); data.sessions.find(s => s.id === sessionId)!.annotations = data.sessions.find(s => s.id === sessionId)!.annotations.filter(a => !session.annotations.some(original => JSON.stringify(original) === JSON.stringify(a))); });
      this.kick(); return id;
    } finally { if (this.controllers.get(id) === controller) this.controllers.delete(id); this.locks.delete(key); release(); this.submissions.delete(completion); }
  }
  /**
   * 修 (作者回应): comments on the user's own PR, handed to the local repository its branch is pushed from. The task fixes
   * them on the PR's head, as that repository has it (fetched there by the user: nothing is written into it here), and
   * pushes onto the PR's branch only once the author says so, while the branch is still at that head.
   */
  /** The added repository whose push remote is `repository` on the link (as a PR names it), if there is one. */
  async localPathFor(connectionId: string, repository: string): Promise<string | null> {
    const connection = (await this.connections.list()).find(c => c.id === connectionId);
    if (!connection) return null;
    for (const item of this.data.repositories) {
      const network = await this.git.captureNetwork(item.snapshot, item.settings.pushRemote).catch(() => null);
      if (network && localReviewRemoteRepository(network.url, connection) === repository) return item.snapshot.path;
    }
    return null;
  }
  async submitFromPr(input: LocalReviewFromPr): Promise<string> {
    const request = localReviewFromPrSchema.parse(input);
    if (this.closing) throw new Error("本地审阅队列已关闭。");
    const key = `submit-pr-${request.connectionId}-${request.reference}`; if (this.locks.has(key)) throw new Error("这个 PR 的意见正在提交。"); this.locks.add(key);
    const id = randomUUID(), controller = new AbortController(); this.controllers.set(id, controller);
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; }); this.submissions.add(completion);
    try {
      const signal = controller.signal;
      const connection = (await this.connections.list()).find(c => c.id === request.connectionId);
      if (!connection) throw new Error("代码平台链接不存在。");
      const client = await this.connections.client(connection.id);
      const [details, { threads }, url] = await Promise.all([client.get(request.reference, signal), client.threads(request.reference, signal), client.webUrl(request.reference)]);
      const context = await client.actionContext({ connectionId: connection.id, reference: request.reference, sourceCommit: details.source.commit, destinationCommit: details.destination.commit });
      if (context.state !== "open") throw new Error("PR 已合并或关闭，不再推送修复。");
      const chosen = request.commentIds.map(commentId => {
        const thread = threads.find(item => item.id === commentId);
        if (!thread) throw new Error("PR 上没有找到选中的意见，可能已被删除。");
        if (!thread.path || !thread.line) throw new Error(`「${prCommentTitle(thread.body)}」是整体评论，没有位置，不能交给本地审阅；可以不修或转后续。`);
        return thread as PrThread & { path: string; line: number };
      });
      // The local repository whose push remote is the PR's source repository: its branch is pushed from there.
      let found: { repository: Ledger["repositories"][number]; network: Awaited<ReturnType<LocalReviewGit["captureNetwork"]>> } | null = null;
      for (const repository of this.data.repositories.filter(r => !request.repositoryId || r.id === request.repositoryId)) {
        const network = await this.git.captureNetwork(repository.snapshot, repository.settings.pushRemote, signal).catch(() => null);
        if (network && localReviewRemoteRepository(network.url, connection) === details.source.repository) { found = { repository, network }; break; }
      }
      if (!found) throw new Error(`本地审阅里没有推送到 ${details.source.repository} 的工程：先在“本地审阅”里添加这个仓库的本地目录，推送远端要指向它。`);
      const { repository, network } = found, head = details.source.commit;
      if (!await this.git.commitExists(repository.snapshot.path, head)) throw new Error(`本地仓库里还没有 PR 的最新提交 ${head.slice(0, 12)}：先在本地拉取这个分支（git fetch），再交给本地审阅。`);
      const local = await this.git.inspect(repository.snapshot.path, repository.settings.baseBranch, signal);
      const snapshot = { ...local, headSha: head, baseSha: await this.git.mergeBase(local.path, head, details.destination.commit) ?? head, branch: context.sourceBranch, dirty: false };
      const profile = (await this.profiles()).find(p => p.profileId === request.profileId);
      if (!profile) throw new Error("审阅模型档案不存在。");
      const selectedWorker = request.worker ?? repository.settings.worker;
      const agent = createLocalReviewWorker(selectedWorker, profile, this.environment, this.gateway, id);
      const copy = await this.prepareOwned(id, "probe", local, signal);
      try { await agent.capability(copy, signal); } finally { await this.removeOwned(id, "probe"); }
      signal.throwIfAborted(); if (this.closing) throw new Error("本地审阅正在退出。");
      // Each comment as an annotation on its line of the PR's head: the comment's words, who said it.
      const annotations = await Promise.all(chosen.map(async thread => {
        const side = thread.side ?? "new";
        const lines = (await this.git.readFile(snapshot, thread.path, side, signal).catch(() => "")).split("\n");
        return { id: randomUUID(), path: thread.path, startLine: thread.line, endLine: thread.line, side, lineText: (lines[thread.line - 1] ?? "").slice(0, 100_000), body: `${thread.author || "审阅人"} 在 PR 上的意见：\n${thread.body}`.slice(0, 4000) };
      }));
      const now = new Date().toISOString();
      const pr = { connectionId: connection.id, reference: request.reference, url, sourceBranch: context.sourceBranch, headSha: head, replied: [], described: false, followUpError: null,
        comments: chosen.map((thread, index) => ({ annotationId: annotations[index]!.id, commentId: thread.id, author: thread.author.slice(0, 300), title: prCommentTitle(thread.body).slice(0, 200) })) };
      await this.write(data => { data.jobs.push({ worker: selectedWorker, id, repositoryId: repository.id, sessionId: randomUUID(), snapshot, annotations, settings: { ...repository.settings, worker: selectedWorker }, profile, state: "queued", createdAt: now, updatedAt: now, pushUrl: network.url, network, selectedGroupIds: null,
        connection: { id: connection.id, platform: connection.platform, baseUrl: connection.baseUrl, sourceRepository: details.source.repository, destinationRepository: details.destination.repository }, prUnavailable: null, pr,
        verdicts: [], originalGroups: null, fallback: null, planVersion: 0, groups: [], rejectedPrGroupId: null, error: null, conversation: { messages: [], nextSeq: 1, readSeq: 0 }, turns: [], executions: [] }); });
      this.kick(); return id;
    } finally { if (this.controllers.get(id) === controller) this.controllers.delete(id); this.locks.delete(key); release(); this.submissions.delete(completion); }
  }
  private kick() {
    if (this.worker || this.closing) return;
    this.worker = this.pump().catch(error => { console.error("local-review", message(error)); }).finally(() => { this.worker = null; if (!this.closing && this.hasWork()) this.kick(); });
  }
  async idle() { while (this.worker) await this.worker; await this.writes; }
  private hasWork() { return this.data.jobs.some(j => j.state === "queued" || j.turns.some(t => t.state === "queued") || j.executions.some(e => e.kind === "existing" && e.state === "pending")); }
  private async pump() {
    // ponytail: v1 runs one task, group, discussion turn or execution at a time.
    while (!this.closing) {
      const job = this.data.jobs.find(j => j.state === "queued");
      if (job) {
        await this.slot(job.id, { kind: "job", id: job.id }, async signal => {
          try { await this.runJob(job.id, signal); }
          catch (error) {
            if (this.storageFault) throw error;
            await this.update(job.id, j => { if (j.state !== "cancelled") j.state = this.closing ? "interrupted" : "failed"; j.error = message(error); });
          } finally {
            try {
              // Cancelling a single new group aborts this run without cancelling the task: it simply ends.
              await this.update(job.id, j => { if (signal.aborted && !this.closing && ["queued", "preparing_dependencies", "running_groups"].includes(j.state)) j.state = "finished"; });
              await this.settleNewExecutions(job.id);
            } catch (error) { if (this.storageFault) throw error; }
          }
        });
        continue;
      }
      const turnJob = this.data.jobs.find(j => j.turns.some(t => t.state === "queued"));
      if (turnJob) { const turn = turnJob.turns.find(t => t.state === "queued")!; await this.slot(turnJob.id, { kind: "turn", id: turn.id }, signal => this.runTurn(turnJob.id, turn.id, signal)); continue; }
      const execJob = this.data.jobs.find(j => j.executions.some(e => e.kind === "existing" && e.state === "pending"));
      if (execJob) { const e = execJob.executions.find(e => e.kind === "existing" && e.state === "pending")!; await this.slot(execJob.id, { kind: "exec", id: e.id }, signal => this.runExecution(execJob.id, e.id, signal)); continue; }
      return;
    }
  }
  private async recordLaunchdChange(id: string, labels: readonly string[]) {
    const added = labels.filter(label => !this.job(id).possibleLaunchdLabels?.includes(label)); if (!added.length) return;
    await this.update(id, job => { job.possibleLaunchdLabels = [...new Set([...(job.possibleLaunchdLabels ?? []), ...added])]; });
    try { this.notify(structuredClone(this.job(id))); } catch {}
  }
  private async runJob(id: string, signal: AbortSignal) {
    let job = this.job(id);
    if (signal.aborted || this.closing || job.state === "cancelled") return;
    if (!job.network || job.network.url !== job.pushUrl) throw new Error("任务缺少受管推送配置快照，请重新提交意见。");
    const agent = createLocalReviewWorker(job.worker, job.profile, this.environment, this.gateway, job.id);
    if (!job.planVersion) {
      await this.update(id, j => { if (j.state !== "cancelled") { j.state = "evaluating"; j.error = null; } });
      signal.throwIfAborted(); if (this.job(id).state === "cancelled") return;
      const copy = await this.prepareOwned(id, "evaluation", job.snapshot, signal);
      const plan = await agent.evaluate(copy, job.annotations, signal);
      signal.throwIfAborted();
      await this.update(id, j => {
        const cancelled = j.state === "cancelled";
        j.verdicts = plan.verdicts; j.originalGroups = plan.originalGroups; j.fallback = plan.fallback; j.planVersion = 1;
        // A PR task's fix is one commit on the PR's branch: what the evaluation split goes back together.
        const planned = j.pr ? (plan.groups.length ? [{ ...plan.groups[0]!, title: "回应 PR 上的意见", reason: plan.groups.map(g => g.reason).filter(Boolean).join("\n\n"), annotationIds: [...new Set(plan.groups.flatMap(g => g.annotationIds))] }] : []) : plan.groups;
        j.actualModel = plan.actualModel; j.actualBackend = plan.actualBackend; j.groups = planned.map((g, index) => ({ ...g, id: randomUUID(), ordinal: index + 1, branch: j.pr ? j.pr.sourceBranch : `paraself/review-${id}-${index + 1}`, state: cancelled ? "cancelled" : "pending", retryable: true, attemptId: randomUUID(), intent: null, artifact: null, excludedFiles: [], fix: null, pushObservedSha: null, pr: null, authorization: null, error: null, cleanupError: null, origin: "evaluation" as const, requirements: "", commits: [] }));
        j.selectedGroupIds = j.groups.map(g => g.id);
        j.state = cancelled ? "cancelled" : j.groups.length ? "running_groups" : "no_changes";
      });
      try { await this.removeOwned(id, "evaluation"); }
      catch (error) { await this.update(id, j => { j.error = `评估副本清理失败：${message(error)}`; }); }
    } else await this.update(id, j => { if (j.state !== "cancelled") j.state = "running_groups"; });
    job = this.job(id);
    if (!job.selectedGroupIds || job.selectedGroupIds.some(id => !job.groups.some(g => g.id === id))) throw new Error("任务调度范围缺失或无效，请明确选择要重试的变更组。");
    const selected = new Set(job.selectedGroupIds);
    let dependencies: ReviewDependencies = { summary: "未准备依赖。", log: "" };
    if (job.groups.some(g => selected.has(g.id) && g.state === "pending")) {
      await this.update(id, j => { if (j.state !== "cancelled") { j.state = "preparing_dependencies"; j.dependencies = { summary: "正在准备依赖。", log: "安装结束后显示输出。" }; } });
      signal.throwIfAborted();
      dependencies = await this.dependencies.prepare(job.repositoryId, job.snapshot, job.settings, directory => this.git.prepare(job.snapshot, directory, signal), signal, labels => this.recordLaunchdChange(id, labels));
      signal.throwIfAborted();
      await this.update(id, j => { j.dependencies = dependencies; if (j.state !== "cancelled") j.state = "running_groups"; });
    }
    for (const group of job.groups.filter(g => selected.has(g.id))) {
      if (signal.aborted || this.closing) break;
      if (group.state !== "pending") continue;
      await this.runGroup(id, group.id, agent, dependencies, signal);
    }
    // Products for every runnable group exist before publishing: overlap is complete.
    for (const group of this.job(id).groups.filter(g => selected.has(g.id))) {
      if (signal.aborted || this.closing) break;
      if (["committed", "pushing", "opening_pr", "pushed_no_pr"].includes(group.state)) await this.publish(id, group.id, signal);
    }
    if (signal.aborted || this.closing || this.job(id).state === "cancelled") return;
    await this.update(id, j => { if (j.state !== "no_changes" && j.state !== "cancelled") j.state = "finished"; });
    try { this.notify(structuredClone(this.job(id))); } catch {}
  }
  private group(id: string, groupId: string) { const group = this.job(id).groups.find(g => g.id === groupId); if (!group) throw new Error("变更组不存在。"); return group; }
  private updateGroup(id: string, groupId: string, attemptId: string, change: (group: LocalReviewGroup, job: StoredJob) => void) {
    return this.update(id, job => { const group = job.groups.find(g => g.id === groupId); if (!group || group.attemptId !== attemptId) throw new Error("旧的变更组回调已失效。"); change(group, job); if (group.artifact && !group.commits.length) group.commits.push({ oid: group.artifact.commitOid, executionId: null }); if (job.state === "cancelled" && (["pending", "committed"].includes(group.state) || active.has(group.state))) group.state = "cancelled"; });
  }
  private async runGroup(id: string, groupId: string, agent: LocalReviewWorker, dependencies: ReviewDependencies, signal: AbortSignal) {
    const attempt = this.group(id, groupId).attemptId, copy = this.copy(id, groupId), job = this.job(id);
    try {
      await this.updateGroup(id, groupId, attempt, g => { g.state = "fixing"; g.intent = "fix"; g.error = null; });
      await this.prepareOwned(id, groupId, job.snapshot, signal);
      // A restarted worker may need its full self-check again. Run it on the clean
      // checkout before adding ignored dependency artifacts to the workspace.
      if (dependencies.key) await agent.capability(copy, signal);
      const dependencySummary = await this.dependencies.clone(job.repositoryId, dependencies, copy, signal);
      const group = this.group(id, groupId), conversation = job.executions.find(e => e.kind === "new" && e.groupId === groupId);
      const fix = await agent.fix(copy, job.annotations.filter(a => group.annotationIds.includes(a.id)), signal, conversation ? { append: false, context: executionContext(this.job(id), conversation, this.job(id).conversation.messages.find(m => m.id === conversation.messageId)?.seq ?? Number.MAX_SAFE_INTEGER) } : undefined);
      signal.throwIfAborted();
      fix.verification = `${dependencySummary}\n${fix.verification}`.slice(0, 16000);
      const declared = new Set(fix.changedFiles), excludedFiles = (await this.git.changedPaths(copy, signal)).filter(path => !declared.has(path));
      await this.updateGroup(id, groupId, attempt, (g, j) => { g.fix = fix; if (fix.actualModel) j.actualModel = fix.actualModel; if (fix.actualBackend) j.actualBackend = fix.actualBackend; g.excludedFiles = excludedFiles; g.intent = "commit"; });
      // Critical section: cancellation cannot skip the commit receipt. Git is bounded,
      // and an app-wide process stop is reconciled from HEAD in the catch below.
      await this.git.assertOwnedDirectory(this.jobsRoot, id, copy.directory);
      const artifact = scanReviewArtifact(await this.git.commit(copy, job.snapshot, fix.commitTitle, fix.changedFiles));
      const finalExcludedFiles = await this.git.changedPaths(copy);
      await this.updateGroup(id, groupId, attempt, (g, j) => { g.artifact = artifact; g.excludedFiles = finalExcludedFiles; g.state = j.state === "cancelled" ? "cancelled" : this.closing ? "interrupted" : artifact ? "committed" : "no_changes"; g.intent = null; });
      if (artifact) await this.removeOwned(id, groupId, true);
      else await this.cleanup(id, groupId);
    } catch (error) {
      if (!this.storageFault && this.group(id, groupId).intent === "commit") {
        try {
          await this.git.assertOwnedDirectory(this.jobsRoot, id, copy.directory);
          const artifact = scanReviewArtifact(await this.git.recoverCommit(copy, job.snapshot));
          if (artifact) {
            const finalExcludedFiles = await this.git.changedPaths(copy);
            await this.updateGroup(id, groupId, attempt, g => { g.artifact = artifact; g.excludedFiles = finalExcludedFiles; g.intent = null; });
          }
        } catch { /* Keep git/ and the commit intent for explicit recovery, never delete it. */ }
      }
      await this.failGroup(id, groupId, attempt, signal, error);
    } finally {
      try { if (agent.possibleLaunchdLabels?.length) await this.recordLaunchdChange(id, agent.possibleLaunchdLabels); }
      catch { /* Warning persistence must not replace the group's original error. */ }
    }
  }
  private async failGroup(id: string, groupId: string, attempt: string, signal: AbortSignal, error: unknown) {
    if (this.storageFault) throw error;
    await this.updateGroup(id, groupId, attempt, (g, j) => { g.state = j.state === "cancelled" ? "cancelled" : this.closing ? "interrupted" : signal.aborted ? "cancelled" : g.pushObservedSha ? "pushed_no_pr" : "failed"; g.error = message(error); });
    if (this.group(id, groupId).state === "cancelled") await this.cleanup(id, groupId);
  }
  private async publish(id: string, groupId: string, signal: AbortSignal) {
    const attempt = this.group(id, groupId).attemptId;
    try {
      let group = this.group(id, groupId), job = this.job(id);
      signal.throwIfAborted(); if (job.state === "cancelled") return;
      if (!group.artifact) throw new Error("固定提交产物不存在，未推送。");
      const secretFindings = reviewSecretFindings(group.artifact.diff);
      if (secretFindings.length) {
        await this.updateGroup(id, groupId, attempt, g => {
          g.artifact!.secretFindings = secretFindings; g.state = "blocked"; g.retryable = false;
          g.authorization = null; g.error = "敏感形态扫描已阻止推送，仅可丢弃。";
        });
        return;
      }
      const authorization = { groupId, commitOid: group.artifact.commitOid, risks: group.artifact.risks, pushUrl: job.pushUrl };
      // A PR's own branch is the author's: their word starts every push to it, risky files or none.
      if (!group.pushObservedSha && (job.pr || group.artifact.risks.length) && JSON.stringify(group.authorization) !== JSON.stringify(authorization)) {
        await this.updateGroup(id, groupId, attempt, g => { g.state = "blocked"; }); return;
      }
      if (!group.pushObservedSha && job.pr) {
        await this.updateGroup(id, groupId, attempt, g => { g.state = "pushing"; g.intent = "push"; });
        await this.pushToPr(id, groupId, signal);
        await this.updateGroup(id, groupId, attempt, g => { g.pushObservedSha = g.artifact!.commitOid; g.intent = null; });
      }
      if (job.pr) {
        await this.updateGroup(id, groupId, attempt, g => { g.state = "pr_opened"; g.pr = { id: job.pr!.reference.slice(job.pr!.reference.lastIndexOf("#") + 1), url: job.pr!.url }; g.intent = null; g.error = null; });
        await this.answerPr(id);
        await this.cleanup(id, groupId, false, true); return;
      }
      if (!group.pushObservedSha) {
        await this.updateGroup(id, groupId, attempt, g => { g.state = "pushing"; g.intent = "push"; });
        const observed = await this.git.branchOid(job.network!, group.branch, signal);
        if (observed && observed !== group.artifact.commitOid) throw new Error("远端分支已被其它提交占用，未覆盖。");
        if (!observed) {
          await this.git.assertOwnedDirectory(this.jobsRoot, id, this.copy(id, groupId).directory);
          await this.git.push(this.copy(id, groupId), job.network!, group.artifact.commitOid, group.branch, signal);
        }
        await this.updateGroup(id, groupId, attempt, g => { g.pushObservedSha = g.artifact!.commitOid; g.intent = null; });
      }
      signal.throwIfAborted();
      job = this.job(id); group = this.group(id, groupId);
      if (!job.connection || job.prUnavailable) {
        await this.updateGroup(id, groupId, attempt, g => { g.state = "pushed_no_pr"; g.error = job.prUnavailable ?? "没有匹配的平台链接。"; });
        await this.cleanup(id, groupId, false, true); return;
      }
      const connection = (await this.connections.list()).find(c => c.id === job.connection!.id && c.platform === job.connection!.platform && c.baseUrl === job.connection!.baseUrl);
      if (!connection) throw new Error("平台链接已被修改或删除，未向新目标创建 PR。");
      const client = await this.connections.client(connection.id), target = { sourceRepository: job.connection.sourceRepository, destinationRepository: job.connection.destinationRepository, sourceBranch: group.branch, destinationBranch: job.settings.baseBranch };
      await this.updateGroup(id, groupId, attempt, g => { g.state = "opening_pr"; g.intent = "create_pr"; });
      const existing = await client.findPullRequest(target, signal);
      const pr = existing ?? await client.createPullRequest({ ...target, title: group.title, description: this.description(job, group), reviewers: job.settings.reviewers }, signal);
      await this.update(id, j => { const g = j.groups.find(g => g.id === groupId)!; if (g.attemptId !== attempt) throw new Error("旧回调失效。"); g.pr = pr; g.state = "pr_opened"; g.intent = null; g.error = null; j.rejectedPrGroupId ??= groupId; });
      await this.cleanup(id, groupId, false, true);
    } catch (error) {
      if (error instanceof PrBranchMovedError && !this.storageFault) { await this.updateGroup(id, groupId, attempt, g => { g.state = "failed"; g.retryable = false; g.intent = null; g.error = error.message; }); return; }
      await this.failGroup(id, groupId, attempt, signal, error);
    }
  }
  /** Onto the PR's own branch, only while it is still at the head the fix was made on: a fast-forward under a lease, never forced. */
  private async pushToPr(id: string, groupId: string, signal: AbortSignal) {
    const job = this.job(id), group = this.group(id, groupId), pr = job.pr!, commit = group.artifact!.commitOid;
    const moved = (now: string | null) => new PrBranchMovedError(`推送前远端分支头变了：${group.branch} ${now ? `现在是 ${now.slice(0, 12)}` : "已经不在了"}，不是修复时的 ${pr.headSha.slice(0, 12)}。已停止推送，没有覆盖；你的修改还在。在新提交上重做这组修改，再推送。`);
    const observed = await this.git.branchOid(job.network!, group.branch, signal);
    if (observed === commit) return;
    if (observed !== pr.headSha) throw moved(observed);
    await this.git.assertOwnedDirectory(this.jobsRoot, id, this.copy(id, groupId).directory);
    try { await this.git.push(this.copy(id, groupId), job.network!, commit, group.branch, signal, pr.headSha); }
    catch (error) {
      signal.throwIfAborted();
      const now = await this.git.branchOid(job.network!, group.branch, signal).catch(() => null);
      if (now === commit) return;
      if (now !== pr.headSha) throw moved(now);
      throw error;
    }
  }
  /**
   * After the push: 已修 under each comment the fix reports done (one answered already is left alone), then the
   * description's 本轮变化. What does not go out is kept to say, and sent again on follow_up; the push stands either way.
   */
  private async answerPr(id: string) {
    const job = this.job(id), group = job.groups[0], pr = job.pr;
    if (!pr || !group?.artifact) return;
    const commit = group.artifact.commitOid, problems: string[] = [], replied = new Set(pr.replied);
    const client = await this.connections.client(pr.connectionId);
    let threads: PrThread[] = [], me: string | null = null;
    try { [me, { threads }] = await Promise.all([client.account(), client.threads(pr.reference)]); }
    catch (error) { problems.push(`读不到 PR 上的评论：${message(error)}`); }
    const fixed: Array<{ title: string; author: string; partial: boolean }> = [];
    for (const link of pr.comments) {
      const outcome = group.fix?.outcomes.find(o => o.id === link.annotationId);
      if (!outcome || outcome.outcome === "skipped") continue;
      fixed.push({ title: link.title, author: link.author, partial: outcome.outcome === "partial" });
      if (replied.has(link.commentId) || problems.length && !threads.length) continue;
      const thread = threads.find(t => t.id === link.commentId);
      if (!thread) { problems.push(`「${link.title}」在 PR 上找不到了，没有回复`); continue; }
      if (answeredIn(thread, me)) { replied.add(link.commentId); continue; }
      try {
        await this.connections.exclusive(() => client.reply(pr.reference, thread, prResponseReply("fixed", `${outcome.outcome === "partial" ? "部分修复" : "已修复"}，见提交 ${commit.slice(0, 12)}。${outcome.summary.slice(0, 1500)}`)));
        replied.add(link.commentId);
      } catch (error) { problems.push(`「${link.title}」的回复没有发出：${message(error)}`); }
    }
    let described = pr.described;
    if (!described && fixed.length) {
      try {
        const answered: Partial<Record<PrResponseKind, number>> = {};
        for (const thread of threads) {
          if (pr.comments.some(c => c.commentId === thread.id)) continue;
          const said = answeredIn(thread, me);
          if (said) answered[said.kind] = (answered[said.kind] ?? 0) + 1;
        }
        const read = await client.readDescription(pr.reference);
        await this.connections.exclusive(() => client.updateDescription({ connectionId: pr.connectionId, reference: pr.reference, description: prDescriptionWithRound(read.description, prRoundChanges({ commit, fixed, answered })), baseVersion: read.version }));
        described = true;
      } catch (error) { problems.push(`本轮变化没有写进 PR 描述：${message(error)}`); }
    }
    await this.update(id, j => { j.pr!.replied = [...replied]; j.pr!.described = described; j.pr!.followUpError = problems.join("；").slice(0, 2000) || null; });
  }
  private description(job: LocalReviewJob, group: LocalReviewGroup) {
    const paths = new Set(group.artifact?.changes.flatMap(c => [c.path, c.oldPath].filter(Boolean)));
    const others = job.groups.filter(g => g.id !== group.id).map(g => { const overlap = g.artifact?.changes.flatMap(c => [c.path, c.oldPath]).filter(p => p && paths.has(p)); return `- ${g.ordinal}. ${g.title}（${g.id}，${g.state}）${g.pr ? ` ${g.pr.url}` : ""}${overlap?.length ? `；文件重叠：${[...new Set(overlap)].join("、")}` : ""}`; });
    const annotations = job.annotations.filter(a => group.annotationIds.includes(a.id));
    const conversation = group.origin === "conversation" ? job.executions.find(e => e.kind === "new" && e.groupId === group.id) : undefined;
    return [`本地审阅任务 ${job.id} / 变更组 ${group.ordinal}`, group.reason, ...(conversation ? [`### 对话中的要求\n${group.requirements || "无"}`, `### 预期改动\n${conversation.expectedChanges}`] : []), ...annotations.map(a => { const outcome = group.fix?.outcomes.find(o => o.id === a.id); return `### ${a.path}:${a.startLine}-${a.endLine} (${a.side})\n原文：\n\n\`\`\`\n${a.lineText}\n\`\`\`\n\n意见：${a.body}\n结论：${outcome?.outcome ?? "未报告"}\n${outcome?.summary ?? ""}`; }), `### 未提交的未声明文件\n${group.excludedFiles.join("\n") || "无"}`, `### 验证\n${group.fix?.verification ?? "未运行验证。"}`, `### 同任务其它组\n${others.join("\n") || "无"}`, ...(!job.rejectedPrGroupId ? [`### 未采纳与待确认\n${job.verdicts.filter(v => v.verdict !== "accept").map(v => { const a = job.annotations.find(a => a.id === v.id)!; return `- ${a.path}:${a.startLine} ${a.body}：${v.verdict}，${v.reason}`; }).join("\n") || "无"}`] : [])].join("\n\n");
  }
  private async cleanup(id: string, groupId: string, force = false, keepGit = false) {
    const group = this.group(id, groupId), copy = this.copy(id, groupId);
    const treeOnly = keepGit || (!force && group.state === "cancelled" && !!(group.artifact || group.intent === "commit"));
    try { await this.removeOwned(id, groupId, treeOnly); }
    catch (error) { if (this.storageFault) throw error; await this.update(id, j => { const group = j.groups.find(g => g.id === groupId); if (group) group.cleanupError = message(error); }); }
  }
  async action(input: LocalReviewAction) {
    const request = localReviewActionSchema.parse(input), job = this.job(request.jobId);
    if (job.repositoryId !== request.repositoryId) throw new Error("任务不属于这个工程。");
    const key = job.id;
    if (this.locks.has(key)) throw new Error("此变更组已有操作进行中。"); this.locks.add(key);
    try {
      if (request.action === "cancel") {
        await this.update(job.id, j => {
          if (this.jobBusy(j)) j.state = "cancelled";
          for (const g of j.groups) if (["pending", "committed"].includes(g.state) && (this.jobBusy(j) || j.state === "cancelled")) g.state = "cancelled";
          for (const t of j.turns) if (t.state === "queued") { t.state = "cancelled"; t.error = "已取消"; this.append(j, { role: "system", body: "讨论回合已取消。", turnId: t.id, attemptId: t.attemptId, event: "turn_cancelled" }); }
          for (const e of j.executions) if (e.kind === "existing" && e.state === "pending") { e.state = "cancelled"; e.error = "已取消"; e.updatedAt = new Date().toISOString(); this.append(j, { role: "system", body: "执行已取消。", executionId: e.id, attemptId: e.attemptId, event: "execution_cancelled" }); }
        });
        this.controllers.get(job.id)?.abort(); await this.completions.get(job.id);
        for (const g of this.job(job.id).groups) if (g.state === "cancelled") await this.cleanup(job.id, g.id);
        if (this.data.owners.some(o => o.jobId === job.id && o.name === "evaluation")) { try { await this.removeOwned(job.id, "evaluation"); } catch (error) { if (this.storageFault) throw error; await this.update(job.id, j => { j.error = `评估副本清理失败：${message(error)}`; }); } }
        return;
      }
      if (request.action === "follow_up") {
        if (!job.pr || !job.groups[0]?.pushObservedSha || !job.pr.followUpError) throw new Error("没有要补发的回复或描述。");
        await this.answerPr(job.id); return;
      }
      if (this.controllers.has(job.id)) throw new Error("请等待当前任务运行结束。");
      if (!request.groupId) {
        if (request.action !== "retry" || job.planVersion || !["failed", "interrupted", "cancelled"].includes(job.state)) throw new Error("请选择要处理的变更组。");
        await this.update(job.id, j => { j.state = "queued"; j.error = null; }); this.kick(); return;
      }
      const group = this.group(job.id, request.groupId);
      if (job.executions.some(e => e.kind === "existing" && e.groupId === group.id && EXEC_OCCUPYING.has(e.state))) throw new Error("这个组有待处理的追加执行，请先在对话里处理它。");
      if (["pr_opened", "no_changes"].includes(group.state)) throw new Error("此变更组已完成，不能重复运行。");
      if (request.action === "discard") { await this.update(job.id, j => { const g = j.groups.find(g => g.id === group.id)!; g.state = "cancelled"; g.retryable = false; g.error = "本地产物已丢弃"; }); await this.cleanup(job.id, group.id, true); return; }
      if (group.artifact && reviewSecretFindings(group.artifact.diff).length) throw new Error("敏感形态扫描命中，此产物只能丢弃，不能授权或重试推送。");
      if (!group.retryable) throw new Error(group.error ?? "此变更组已不可重试。");
      if (request.action === "approve") {
        if (group.state !== "blocked" || !group.artifact) throw new Error("此变更组无需授权。");
        const expected = { groupId: group.id, commitOid: group.artifact.commitOid, risks: group.artifact.risks, pushUrl: job.pushUrl };
        if (JSON.stringify(request.authorization) !== JSON.stringify(expected)) throw new Error("提交、文件清单或推送地址已变化，请重新审阅。");
      } else if (!["pending", "failed", "interrupted", "cancelled", "pushed_no_pr"].includes(group.state)) throw new Error("当前状态不能重试。");
      if (!group.artifact && group.intent === "commit" && group.fix) {
        await this.git.assertOwnedDirectory(this.jobsRoot, job.id, this.copy(job.id, group.id).directory);
        const artifact = scanReviewArtifact(await this.git.recoverCommit(this.copy(job.id, group.id), job.snapshot));
        if (artifact) {
          const finalExcludedFiles = await this.git.changedPaths(this.copy(job.id, group.id));
          await this.update(job.id, j => { const g = j.groups.find(g => g.id === group.id)!; g.artifact = artifact; g.excludedFiles = finalExcludedFiles; g.intent = null; });
        }
      }
      await this.update(job.id, j => {
        const g = j.groups.find(g => g.id === group.id)!;
        // Both the conversation action and the legacy group action enter here: one persisted retry budget, no bypass.
        const execution = j.executions.find(e => e.kind === "new" && e.groupId === g.id);
        if (execution) {
          if (execution.attempts >= LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS) throw new Error(`此执行已重试 ${LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS} 次，不能再重试。`);
          execution.attempts++; execution.attemptId = randomUUID(); execution.state = "pending"; execution.error = null; execution.updatedAt = new Date().toISOString();
        }
        g.attemptId = randomUUID(); g.state = g.pushObservedSha ? "pushed_no_pr" : g.artifact ? "committed" : "pending";
        if (request.authorization) g.authorization = request.authorization;
        g.error = null; j.selectedGroupIds = [g.id]; j.state = "queued";
      });
      this.kick();
    } finally { this.locks.delete(key); }
  }
  // ---------------------------------------------------------------- conversation
  /** Messages are only ever appended. Called inside a ledger write so seq is allocated under the write serialization. */
  private append(job: StoredJob, m: { role: LocalReviewMessage["role"]; body: string; references?: LocalReviewMessage["references"]; turnId?: string | null; plan?: LocalReviewMessage["plan"]; executionId?: string; attemptId?: string; event?: string }): LocalReviewMessage {
    const message: LocalReviewMessage = { id: randomUUID(), seq: job.conversation.nextSeq++, role: m.role, createdAt: new Date().toISOString(), body: (m.body.trim() || "（空）").slice(0, m.role === "user" ? 8000 : m.role === "worker" ? 16000 : 60000), references: m.references ?? [], turnId: m.turnId ?? null,
      ...(m.plan ? { plan: m.plan } : {}), ...(m.executionId ? { executionId: m.executionId } : {}), ...(m.attemptId ? { attemptId: m.attemptId } : {}), ...(m.event ? { event: m.event } : {}) };
    job.conversation.messages.push(message); return message;
  }
  private interruptConversation(job: StoredJob) {
    const now = new Date().toISOString();
    for (const turn of job.turns) if (turn.state === "running") { turn.state = "interrupted"; turn.error = "应用退出或重启，讨论回合被中断。"; this.append(job, { role: "system", body: "讨论回合被中断（应用退出或重启）。可以重试此回合。", turnId: turn.id, attemptId: turn.attemptId, event: "turn_interrupted" }); }
    for (const e of job.executions) if (e.kind === "existing" && EXEC_ACTIVE.has(e.state)) { e.state = "interrupted"; e.error = "应用退出或重启，执行被中断。"; e.updatedAt = now; this.append(job, { role: "system", body: "执行被中断（应用退出或重启）。可以重试；已推送或已提交的结果不会重复。", executionId: e.id, attemptId: e.attemptId, event: "execution_interrupted" }); }
  }
  private exec(jobId: string, id: string): StoredExecution { const e = this.job(jobId).executions.find(e => e.id === id); if (!e) throw new Error("执行记录不存在。"); return e; }
  private jobBusy(job: StoredJob) { return ["queued", "evaluating", "preparing_dependencies", "running_groups"].includes(job.state); }

  async sendMessage(input: z.infer<typeof localReviewSendMessageSchema>): Promise<string> {
    const request = localReviewSendMessageSchema.parse(input);
    if (this.closing) throw new Error("本地审阅正在退出。");
    const turnId = randomUUID();
    await this.write(data => {
      const job = data.jobs.find(j => j.id === request.jobId);
      if (!job || job.repositoryId !== request.repositoryId) throw new Error("审阅任务不存在。");
      // The soft gate: the only place the message count is checked. Replies, system results and recovery are never refused.
      if (job.conversation.messages.length >= LOCAL_REVIEW_MESSAGE_SOFT_LIMIT) throw new Error(`对话已达 ${LOCAL_REVIEW_MESSAGE_SOFT_LIMIT} 条，请新建任务继续。`);
      if (this.jobBusy(job)) throw new Error("任务正在运行，结束后可以继续对话。");
      if (job.turns.some(t => t.state === "queued" || t.state === "running") || job.executions.some(e => e.state === "pending" || EXEC_ACTIVE.has(e.state))) throw new Error("上一项操作尚未结束，请稍后再发送。");
      const seen = new Set<string>(), references = request.references.filter(r => { const key = `${r.kind}:${r.id}`; if (seen.has(key)) return false; seen.add(key); return true; });
      for (const ref of references) if (ref.kind === "annotation" ? !job.annotations.some(a => a.id === ref.id) : !job.groups.some(g => g.id === ref.id)) throw new Error("引用的意见或组不属于这个任务。");
      const message = this.append(job, { role: "user", body: request.body, references, turnId });
      job.turns.push({ id: turnId, userMessageId: message.id, state: "queued", attemptId: randomUUID(), attempts: 1, error: null, stats: null });
      job.updatedAt = new Date().toISOString();
    });
    this.kick(); return turnId;
  }
  async markRead(input: z.infer<typeof localReviewMarkReadSchema>) {
    const request = localReviewMarkReadSchema.parse(input);
    await this.write(data => {
      const job = data.jobs.find(j => j.id === request.jobId);
      if (!job || job.repositoryId !== request.repositoryId) throw new Error("审阅任务不存在。");
      job.conversation.readSeq = Math.max(job.conversation.readSeq, Math.min(request.seq, job.conversation.nextSeq - 1));
    });
  }

  /** Atomic claim: everything is checked and the execution record written inside one ledger write. */
  async execute(input: z.infer<typeof localReviewExecuteSchema>): Promise<string> {
    const request = localReviewExecuteSchema.parse(input);
    if (this.closing) throw new Error("本地审阅正在退出。");
    let executionId = "";
    await this.write(data => {
      const job = data.jobs.find(j => j.id === request.jobId);
      if (!job || job.repositoryId !== request.repositoryId) throw new Error("审阅任务不存在。");
      const existing = job.executions.find(e => e.messageId === request.messageId);
      if (existing) { executionId = existing.id; return; }
      const message = job.conversation.messages.find(m => m.id === request.messageId);
      if (!message || message.role !== "worker" || !message.plan) throw new Error("这条消息没有执行方案。");
      if (!message.plan.executable) throw new Error(message.plan.invalidReason ?? "方案不可执行。");
      if (this.jobBusy(job)) throw new Error("任务正在运行，结束后才能执行。");
      if (job.turns.some(t => t.state === "queued" || t.state === "running")) throw new Error("讨论回合进行中，请稍后再执行。");
      const plan = message.plan, check = validatePlan(job, plan);
      if (!check.executable) throw new Error(check.invalidReason ?? "方案不可执行。");
      const now = new Date().toISOString(), id = randomUUID(), attemptId = randomUUID();
      const base = { id, messageId: message.id, turnId: message.turnId ?? randomUUID(), annotationIds: plan.annotationIds, requirements: plan.requirements, expectedChanges: plan.expectedChanges, state: "pending" as const, intent: null, attemptId, attempts: 0, newCommitOid: null, fix: null, artifact: null, excludedFiles: [], pushed: false, comment: null, authorization: null, error: null, createdAt: now, updatedAt: now };
      if (plan.target.kind === "existing") {
        const group = job.groups.find(g => g.id === (plan.target as { groupId: string }).groupId)!;
        if (job.executions.some(e => e.groupId === group.id && EXEC_OCCUPYING.has(e.state))) throw new Error("这个组已有进行中或待处理的执行。");
        if (group.artifact?.commitOid !== plan.planBaseOid) throw new Error("方案已过期：组的提交已变化，请重新讨论。");
        job.executions.push({ ...base, groupId: group.id, kind: "existing", planBaseOid: plan.planBaseOid });
      } else {
        if (job.pr) throw new Error("这个任务来自 PR 上的意见：修改只能追加到原 PR 的分支，不能另开组。");
        if (job.groups.length >= LOCAL_REVIEW_MAX_GROUPS) throw new Error("任务组数已达上限。");
        const groupId = randomUUID(), ordinal = Math.max(0, ...job.groups.map(g => g.ordinal)) + 1;
        job.groups.push({ id: groupId, ordinal, title: plan.target.title.slice(0, 200), reason: plan.reason, annotationIds: plan.annotationIds, branch: `paraself/review-${job.id}-${ordinal}`, state: "pending", retryable: true, attemptId: randomUUID(), intent: null, artifact: null, excludedFiles: [], fix: null, pushObservedSha: null, pr: null, authorization: null, error: null, cleanupError: null, origin: "conversation", requirements: plan.requirements, commits: [] });
        job.executions.push({ ...base, groupId, kind: "new", planBaseOid: null });
        job.selectedGroupIds = [groupId]; job.state = "queued"; job.error = null;
      }
      executionId = id;
      this.append(job, { role: "system", body: `已开始执行：${plan.target.kind === "existing" ? "向已有组追加修改" : `新建组「${plan.target.title}」`}。`, executionId: id, attemptId, event: "execution_started" });
      job.updatedAt = now;
    });
    this.kick(); return executionId;
  }

  private slotCleanup(repositoryId: string) { this.dependencies.release(repositoryId); }
  private async slot(jobId: string, operation: { kind: "job" | "turn" | "exec"; id: string }, run: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController(); this.controllers.set(jobId, controller); this.operations.set(jobId, operation);
    let complete!: () => void; this.completions.set(jobId, new Promise<void>(resolve => { complete = resolve; }));
    const repositoryId = this.job(jobId).repositoryId;
    try { await run(controller.signal); }
    finally {
      this.operations.delete(jobId);
      this.slotCleanup(repositoryId);
      try { await this.dependencies.prune(); } catch (error) { console.error("local-review dependency cleanup", message(error)); }
      finally { this.controllers.delete(jobId); this.completions.delete(jobId); complete(); }
    }
  }

  private async prepareView(jobId: string, turnId: string, job: StoredJob, signal: AbortSignal) {
    const name = `turn-${turnId}`, views: DiscussionView[] = [];
    await this.prepareOwned(jobId, name, job.snapshot, signal, async directory => {
      const copy: ReviewCopy = { directory, tree: join(directory, "tree"), git: join(directory, "git") };
      // tree/ is a subdirectory; git/ and control files stay outside it, like every other copy.
      await mkdir(copy.tree, { mode: 0o700 }); await mkdir(copy.git, { mode: 0o700 });
      await this.git.checkoutView(await this.git.gitDirectory(job.snapshot, signal), job.snapshot.headSha, join(copy.tree, "base"), signal);
      views.push({ name: "base", groupId: null, ordinal: null, commitOid: job.snapshot.headSha, available: true });
      for (const group of job.groups) {
        const oid = group.artifact?.commitOid; if (!oid) continue;
        const source = this.copy(jobId, group.id), view = `group-${group.ordinal}`;
        // A product that hit the sensitive-shape scan is never materialized for the model: the view says so instead of "missing".
        if (group.artifact!.secretFindings?.length || reviewSecretFindings(group.artifact!.diff).length) { views.push({ name: view, groupId: group.id, ordinal: group.ordinal, commitOid: oid, available: false, hidden: true }); continue; }
        let available = false;
        try {
          if (await lstat(source.git).then(() => true, () => false)) { await this.git.assertOwnedDirectory(this.jobsRoot, jobId, source.directory); available = await this.git.hasCommit(source.git, oid, signal); }
          if (available) { await this.git.checkoutView(source.git, oid, join(copy.tree, view), signal); await this.touchOwner(jobId, group.id); }
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof ReviewViewError) throw error;
          // A failed checkout may already have written blobs. Unavailable must mean absent, not a partial view the worker can read.
          const groupPath = join(copy.tree, view), turnRoot = await realpath(directory);
          const partial = await realpath(groupPath).catch((failure: NodeJS.ErrnoException) => { if (failure.code === "ENOENT") return null; throw failure; });
          if (partial !== null) {
            const within = relative(turnRoot, partial);
            if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new ReviewViewError("部分组视图清理路径超出本回合目录。");
            await rm(groupPath, { recursive: true, force: true });
          }
          available = false;
        }
        views.push({ name: view, groupId: group.id, ordinal: group.ordinal, commitOid: oid, available });
      }
      return copy;
    });
    const directory = this.copy(jobId, name).directory;
    return { copy: { directory, tree: join(directory, "tree"), git: join(directory, "git") } as ReviewCopy, views, name };
  }
  private async touchOwner(jobId: string, name: string) { if (this.data.owners.some(o => o.jobId === jobId && o.name === name)) await this.write(data => { const o = data.owners.find(o => o.jobId === jobId && o.name === name); if (o) o.touchedAt = new Date().toISOString(); }); }

  private async runTurn(jobId: string, turnId: string, signal: AbortSignal) {
    const turn = this.job(jobId).turns.find(t => t.id === turnId && t.state === "queued"); if (!turn) return;
    const attempt = turn.attemptId, name = `turn-${turn.id}`;
    const change = (fn: (t: LocalReviewTurn, j: StoredJob) => void) => this.update(jobId, j => { const t = j.turns.find(t => t.id === turn.id); if (!t || t.attemptId !== attempt) throw new Error("旧的回合回调已失效。"); fn(t, j); });
    try {
      await change(t => { if (t.state !== "queued") throw new Error("回合不在队列中。"); t.state = "running"; t.error = null; });
      const job = this.job(jobId), agent = createLocalReviewWorker(job.worker, job.profile, this.environment, this.gateway, job.id);
      // The self-check needs a clean fixed checkout; Pi checks its file layer itself and offers no command tool here.
      if (job.worker !== "pi") { const probe = await this.prepareOwned(jobId, "probe", job.snapshot, signal); try { await agent.capability(probe, signal); } finally { await this.removeOwned(jobId, "probe"); } }
      signal.throwIfAborted();
      const view = await this.prepareView(jobId, turn.id, job, signal);
      const built = buildDiscussionRequest(this.job(jobId), turn.userMessageId, view.views, discussionBudget(job.worker, job.profile), discussionOverhead(job.worker));
      const answer = await agent.discuss(view.copy, built.request, signal);
      signal.throwIfAborted();
      const plan = answer.plan ? validatePlan(this.job(jobId), answer.plan) : null;
      await change((t, j) => { if (t.state !== "running") throw new Error("回合已结束。"); t.state = "answered"; t.stats = built.stats; this.append(j, { role: "worker", body: answer.reply, turnId: turn.id, attemptId: attempt, ...(plan ? { plan } : {}), event: "reply" }); });
    } catch (error) {
      if (this.storageFault) throw error;
      await this.update(jobId, j => {
        const t = j.turns.find(t => t.id === turn.id); if (!t || t.attemptId !== attempt || t.state === "cancelled" || t.state === "answered") return;
        const state = this.closing ? "interrupted" : signal.aborted ? "cancelled" : "failed";
        t.state = state; t.error = message(error);
        this.append(j, { role: "system", body: state === "cancelled" ? "讨论回合已取消。" : state === "interrupted" ? "讨论回合被中断。可以重试此回合。" : error instanceof DiscussionBudgetError ? message(error) : `讨论回合失败：${message(error)}。可以重试此回合。`, turnId: turn.id, attemptId: attempt, event: `turn_${state}` });
      });
    } finally { try { await this.removeOwned(jobId, name); } catch (error) { if (this.storageFault) throw error; console.error("local-review turn cleanup", message(error)); } }
  }

  // ---------------------------------------------------------------- execution (append to an existing group)
  private async finishExec(jobId: string, execId: string, attempt: string, state: LocalReviewExecution["state"], body: string, error: string | null = null, cleanup: "none" | "all" = "none") {
    let emitted = false;
    await this.update(jobId, j => {
      const e = j.executions.find(e => e.id === execId); if (!e || e.attemptId !== attempt) throw new Error("旧的执行回调已失效。");
      if (e.state === state && state === "cancelled") return;
      e.state = state; if (!(["failed", "interrupted", "cancelled"].includes(state) && e.intent === "commit" && !e.artifact)) e.intent = null; e.error = error; e.updatedAt = new Date().toISOString();
      this.append(j, { role: "system", body, executionId: execId, attemptId: attempt, event: `execution_${state}` }); emitted = true;
    });
    if (cleanup === "all") { try { await this.removeOwned(jobId, `exec-${execId}`); } catch (e) { if (this.storageFault) throw e; console.error("local-review exec cleanup", message(e)); } }
    return emitted;
  }
  private execSummary(job: StoredJob, e: StoredExecution, group: LocalReviewGroup) {
    const outcomes = (e.fix?.outcomes ?? []).slice(0, 20).map(o => `- ${o.id} ${o.outcome}：${o.summary.slice(0, 300)}`).join("\n") + ((e.fix?.outcomes.length ?? 0) > 20 ? `\n…另有 ${e.fix!.outcomes.length - 20} 条` : "");
    return [`新提交 \`${e.newCommitOid?.slice(0, 10) ?? "无"}\`，分支 \`${group.branch}\`${group.pr ? `，PR ${group.pr.url}` : ""}`, outcomes, e.fix ? `verification：\n${e.fix.verification}` : ""].filter(Boolean).join("\n\n");
  }
  private clip(text: string, limit: number) { return text.length > limit ? `${text.slice(0, limit)}…（已省略，原文见任务详情）` : text; }
  private commentBody(job: StoredJob, e: StoredExecution, group: LocalReviewGroup) {
    // Only verification must stay verbatim. Our own metadata is bounded so the whole body always fits the ledger.
    const all = job.annotations.filter(a => e.annotationIds.includes(a.id)), notes = all.slice(0, 20).map(a => { const o = e.fix?.outcomes.find(o => o.id === a.id); return `- ${a.path}:${a.startLine} ${this.clip(a.body, 120)}\n  结果：${o?.outcome ?? "未报告"} ${this.clip(o?.summary ?? "", 200)}`; });
    return [`Paraself 执行 ID：${e.id}`, `提交：${e.newCommitOid}`, `本次向分支 ${group.branch} 追加一个提交。`, e.requirements ? `对话中的要求：${this.clip(e.requirements, 500)}` : "", notes.length ? `涉及意见：\n${notes.join("\n")}${all.length > 20 ? `\n…另有 ${all.length - 20} 条` : ""}` : "", `预期改动：${this.clip(e.expectedChanges, 500)}`, `verification：\n${e.fix?.verification ?? "未运行验证。"}`].filter(Boolean).join("\n\n");
  }
  private async runExecution(jobId: string, execId: string, signal: AbortSignal) {
    const first = this.exec(jobId, execId); if (first.kind !== "existing" || first.state !== "pending") return;
    const attempt = first.attemptId, name = `exec-${execId}`;
    const change = (fn: (e: StoredExecution, j: StoredJob) => void) => this.update(jobId, j => { const e = j.executions.find(e => e.id === execId); if (!e || e.attemptId !== attempt) throw new Error("旧的执行回调已失效。"); fn(e, j); e.updatedAt = new Date().toISOString(); });
    const job = this.job(jobId), copy = this.copy(jobId, name);
    const change0 = change;
    let agent: LocalReviewWorker | undefined;
    try {
      let e = this.exec(jobId, execId); const group = this.group(jobId, e.groupId), planBase = e.planBaseOid!;
      // Re-validate at start: a group that was discarded, changed or moved on since the claim must not run an old plan.
      if (!e.pushed && !e.artifact && (!["pr_opened", "pushed_no_pr"].includes(group.state) || group.artifact?.commitOid !== planBase)) { await this.finishExec(jobId, execId, attempt, "failed", "方案已过期：组已被改动或丢弃，未执行。请重新讨论。", "方案已过期", "all"); return; }
      // Phase 1: fix + commit (skipped when the commit is already recorded).
      if (!e.artifact || !e.newCommitOid) {
        if (e.intent === "commit") {
          // A commit may exist without a receipt: reconcile from the copy's Git before anything else.
          try { await this.git.assertOwnedDirectory(this.jobsRoot, jobId, copy.directory); const recovered = scanReviewArtifact(await this.git.recoverCommit(copy, job.snapshot, signal, planBase)); if (recovered) await change(x => { x.artifact = recovered; x.newCommitOid = recovered.commitOid; x.intent = null; x.state = "committed"; }); } catch { /* keep the copy; the fix path below rebuilds it only when nothing was committed */ }
          e = this.exec(jobId, execId);
        }
      }
      if (!e.artifact || !e.newCommitOid) {
        await change(x => { x.state = "fixing"; x.intent = "fix"; x.error = null; });
        const source = this.copy(jobId, group.id);
        let retained = false;
        if (await lstat(source.git).then(() => true, () => false)) { try { await this.git.assertOwnedDirectory(this.jobsRoot, jobId, source.directory); retained = await this.git.hasCommit(source.git, planBase, signal); } catch { retained = false; } }
        let moved = false;
        await this.prepareOwned(jobId, name, job.snapshot, signal, async directory => {
          if (retained) return this.git.prepareAt(source.git, planBase, directory, signal);
          const fresh = await this.git.prepare(job.snapshot, directory, signal);
          if (!await this.git.fetchTip(fresh, job.network!, group.branch, planBase, signal)) { moved = true; return fresh; }
          await this.git.checkoutDetached(fresh, planBase, signal); return fresh;
        });
        if (moved) { await this.finishExec(jobId, execId, attempt, "remote_changed", "远端分支已不是记录的提交，未覆盖、未调用模型。请到平台处理后，在对话里重新讨论。", "远端分支已变化", "all"); return; }
        agent = createLocalReviewWorker(job.worker, job.profile, this.environment, this.gateway, job.id);
        signal.throwIfAborted();
        const dependencies = await this.dependencies.prepare(job.repositoryId, job.snapshot, job.settings, directory => this.git.prepare(job.snapshot, directory, signal), signal, labels => this.recordLaunchdChange(jobId, labels));
        signal.throwIfAborted();
        if (dependencies.key) await agent.capability(copy, signal);
        const dependencySummary = await this.dependencies.clone(job.repositoryId, dependencies, copy, signal);
        const fresh = this.job(jobId), plan = fresh.conversation.messages.find(m => m.id === e.messageId);
        const fix = await agent.fix(copy, fresh.annotations.filter(a => e.annotationIds.includes(a.id)), signal, { append: true, context: executionContext(fresh, e, plan?.seq ?? Number.MAX_SAFE_INTEGER) });
        signal.throwIfAborted();
        // The model's own verification text comes first so a cut at the schema limit never loses its words.
        fix.verification = `${fix.verification}\n${dependencySummary}`.slice(0, 16000);
        const declared = new Set(fix.changedFiles), excluded = (await this.git.changedPaths(copy, signal)).filter(path => !declared.has(path));
        await change((x, j) => { x.fix = fix; x.excludedFiles = excluded; x.intent = "commit"; if (fix.actualModel) j.actualModel = fix.actualModel; if (fix.actualBackend) j.actualBackend = fix.actualBackend; });
        await this.git.assertOwnedDirectory(this.jobsRoot, jobId, copy.directory);
        const artifact = scanReviewArtifact(await this.git.commit(copy, job.snapshot, fix.commitTitle, fix.changedFiles));
        const finalExcluded = await this.git.changedPaths(copy);
        await change(x => { x.artifact = artifact; x.newCommitOid = artifact?.commitOid ?? null; x.excludedFiles = finalExcluded; x.intent = null; x.state = artifact ? "committed" : "no_changes"; });
        if (!artifact) { await this.finishExec(jobId, execId, attempt, "no_changes", `没有产生可提交的改动。${fix.verification ? `\n\nverification：\n${fix.verification}` : ""}`, null, "all"); return; }
        await this.removeOwned(jobId, name, true);
        e = this.exec(jobId, execId);
      }
      const artifact = e.artifact!, newOid = e.newCommitOid!;
      // Sensitive shapes: only discarding is possible. The message names files and lines, never the content or the fix text.
      const findings = reviewSecretFindings(artifact.diff);
      if (findings.length) {
        await change(x => { x.artifact!.secretFindings = findings; x.authorization = null; });
        await this.finishExec(jobId, execId, attempt, "blocked", `敏感形态扫描阻止了推送，本次追加只能丢弃（原 PR 与提交不受影响）。命中位置：${findings.map(f => `${f.path}:${f.line}`).join("、")}`, "敏感形态扫描已阻止推送，仅可丢弃。");
        return;
      }
      // Phase 2: push (fast-forward only). Local assertions first; the lease only does remote compare-and-swap.
      if (!e.pushed) {
        await this.git.assertOwnedDirectory(this.jobsRoot, jobId, copy.directory);
        const parents = await this.git.parents(copy, newOid, signal);
        if (parents.length !== 1 || parents[0] !== planBase || !await this.git.isAncestor(copy, planBase, newOid, signal)) throw new Error("新提交不是记录提交之上的单父快进，未推送。");
        const authorization = { executionId: execId, groupId: group.id, commitOid: newOid, planBaseOid: planBase, risks: artifact.risks, pushUrl: job.pushUrl };
        if (artifact.risks.length && JSON.stringify(e.authorization) !== JSON.stringify(authorization)) {
          await this.finishExec(jobId, execId, attempt, "blocked", `追加的提交涉及高风险文件，需要你单独确认后才推送：${artifact.risks.join("、")}`, "高风险改动等待确认");
          return;
        }
        await change(x => { x.state = "pushing"; x.intent = "push"; });
        const remoteMoved = async (observed: string | null) => { await this.finishExec(jobId, execId, attempt, "remote_changed", `远端分支已被其它提交改动${observed ? `（现在是 ${observed.slice(0, 10)}）` : ""}，未覆盖也不会重试推送。请到平台处理后，在对话里重新讨论。`, "远端分支已变化", "all"); };
        let observed = await this.git.branchOid(job.network!, group.branch, signal);
        if (observed !== newOid) {
          if (observed !== planBase) { await remoteMoved(observed); return; }
          try { await this.git.push(copy, job.network!, newOid, group.branch, signal, planBase); }
          catch (error) { signal.throwIfAborted(); observed = await this.git.branchOid(job.network!, group.branch, signal).catch(() => null); if (observed === newOid) { /* receipt lost or raced to success */ } else if (observed && observed !== planBase) { await remoteMoved(observed); return; } else throw error; }
        }
        // Keep the new commit in the group's own object store before the execution copy is ever removed.
        await this.keepCommit(jobId, group.id, execId, newOid, copy, signal);
        await this.update(jobId, j => {
          const x = j.executions.find(x => x.id === execId); if (!x || x.attemptId !== attempt) throw new Error("旧的执行回调已失效。");
          const g = j.groups.find(g => g.id === x.groupId)!;
          g.artifact = x.artifact; g.pushObservedSha = newOid; g.excludedFiles = x.excludedFiles; if (!g.commits.some(c => c.oid === newOid)) g.commits.push({ oid: newOid, executionId: execId });
          x.pushed = true; x.intent = null; x.updatedAt = new Date().toISOString();
        });
        await this.touchOwner(jobId, group.id);
      }
      await this.commentStage(jobId, execId, attempt, signal);
    } catch (error) {
      if (this.storageFault) throw error;
      const e = this.job(jobId).executions.find(x => x.id === execId);
      if (!e || e.attemptId !== attempt || ["cancelled", "done", "done_comment_failed", "remote_changed", "no_changes", "blocked"].includes(e.state)) return;
      // A commit may exist whose receipt was lost: record it from the copy's Git now, and keep the intent otherwise (never rerun the model over it).
      if (e.intent === "commit" && !e.artifact) {
        try { await this.git.assertOwnedDirectory(this.jobsRoot, jobId, copy.directory); const recovered = scanReviewArtifact(await this.git.recoverCommit(copy, job.snapshot, undefined, e.planBaseOid!)); if (recovered) await change0(x => { x.artifact = recovered; x.newCommitOid = recovered.commitOid; x.intent = null; }); } catch { /* keep the copy and the commit intent for an explicit retry */ }
      }
      const state = this.closing ? "interrupted" : signal.aborted ? "cancelled" : "failed";
      await this.finishExec(jobId, execId, attempt, state, state === "cancelled" ? "执行已取消，已推送的内容保持原状。" : state === "interrupted" ? "执行被中断。可以重试；已提交或已推送的结果不会重复。" : `执行失败：${message(error)}。可以重试。`, message(error));
    } finally {
      try { if (agent?.possibleLaunchdLabels?.length) await this.recordLaunchdChange(jobId, agent.possibleLaunchdLabels); } catch { /* keep the original outcome */ }
    }
  }
  private async keepCommit(jobId: string, groupId: string, execId: string, newOid: string, execution: ReviewCopy, signal: AbortSignal) {
    const target = this.copy(jobId, groupId), exists = await lstat(target.directory).then(() => true, () => false);
    if (!exists) {
      if (!this.data.owners.some(o => o.jobId === jobId && o.name === groupId)) await this.own({ jobId, name: groupId, kind: "group", createdAt: new Date().toISOString(), state: "preparing", cleanup: null, error: null });
      await this.git.ensureOwnedDirectory(this.jobsRoot, jobId, target.directory);
      await this.write(data => { const o = data.owners.find(o => o.jobId === jobId && o.name === groupId); if (o) { o.state = "ready"; o.cleanup = null; o.error = null; } });
    } else await this.git.assertOwnedDirectory(this.jobsRoot, jobId, target.directory);
    await this.git.adoptCommit(execution.git, target.git, `refs/paraself/exec-${execId}`, newOid, signal);
    await this.touchOwner(jobId, groupId);
  }
  /** Comment with look-up-before-send: a lost receipt is searched for in the complete discussion, never blindly re-posted. */
  private async commentStage(jobId: string, execId: string, attempt: string, signal: AbortSignal) {
    const job = this.job(jobId), e = this.exec(jobId, execId), group = this.group(jobId, e.groupId);
    const change = (fn: (e: StoredExecution) => void) => this.update(jobId, j => { const x = j.executions.find(x => x.id === execId); if (!x || x.attemptId !== attempt) throw new Error("旧的执行回调已失效。"); fn(x); x.updatedAt = new Date().toISOString(); });
    const done = (note: string) => this.finishExec(jobId, execId, attempt, "done", `${note}\n\n${this.execSummary(job, e, group)}`, null, "all");
    if (!group.pr || !job.connection || job.prUnavailable) { await done(group.pr ? "追加已推送；没有可用的平台链接，未发评论。" : "追加已推送到分支；此组没有 PR，未发评论。"); return; }
    const body = e.comment?.body ?? this.commentBody(job, e, group);
    await change(x => { x.state = "commenting"; x.intent = "comment"; x.comment = { body, published: false, error: null }; });
    const failComment = async (reason: string) => {
      await change(x => { x.comment = { body, published: false, error: reason.slice(0, 2000) }; });
      await this.finishExec(jobId, execId, attempt, "done_comment_failed", `分支已推送，但**评论没有发布**：${reason}\n\n${this.execSummary(job, e, group)}\n\n将要发布的评论原文（可复制）：\n\n\`\`\`\n${body}\n\`\`\``, reason.slice(0, 2000), "all");
    };
    try {
      // ponytail: the readable receipt limit is 8000 characters (what the discussion reader accepts); longer text is never cut.
      if (body.length > 8000) {
        // A stable outcome, not a retry loop: the same text can never fit, so the retry button is exhausted and the text is kept to copy.
        await change(x => { x.attempts = LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS; });
        await failComment("评论超过 8000 字符上限，未发布，也不会截断 verification 原话。请复制下面的原文到平台手动发布。"); return;
      }
      const connection = (await this.connections.list()).find(c => c.id === job.connection!.id && c.platform === job.connection!.platform && c.baseUrl === job.connection!.baseUrl);
      if (!connection) { await failComment("平台链接已被修改或删除，未发布。"); return; }
      const client = await this.connections.client(connection.id), reference = `${job.connection.destinationRepository}#${group.pr.id}`;
      const pages = await client.commentPages(reference, 10, signal);
      const receipt = pages.comments.some(c => { const lines = c.body.split(/\r?\n/u).map(l => l.trim()); return lines.includes(`Paraself 执行 ID：${e.id}`) && lines.includes(`提交：${e.newCommitOid}`); });
      if (!receipt) {
        if (pages.more || pages.unparsed) { await failComment(pages.unparsed ? "平台返回的评论里有无法解析的条目，无法确认是否已经发布过，为避免重复没有发送。请到平台核对。" : "评论列表没有读完，无法确认是否已经发布过，为避免重复没有发送。请到平台核对。"); return; }
        const context = await client.currentCommits(connection.id, reference);
        await client.publishGeneralComment({ connectionId: connection.id, reference, sourceCommit: e.newCommitOid!, destinationCommit: context.destinationCommit, body });
      }
      await change(x => { x.comment = { body, published: true, error: null }; });
      await done(receipt ? "追加已推送；评论此前已发布。" : "追加已推送，评论已发布到 PR。");
    } catch (error) {
      signal.throwIfAborted();
      await failComment(message(error));
    }
  }

  async conversationAction(input: z.infer<typeof localReviewConversationActionSchema>) {
    const request = localReviewConversationActionSchema.parse(input), job = this.job(request.jobId);
    if (job.repositoryId !== request.repositoryId) throw new Error("任务不属于这个工程。");
    if (this.closing) throw new Error("本地审阅正在退出。");
    const find = () => { const e = job.executions.find(e => e.id === request.executionId); if (!e) throw new Error("执行记录不存在。"); return e; };
    if (request.action === "cancel_turn" || request.action === "retry_turn") {
      const turn = job.turns.find(t => t.id === request.turnId); if (!turn) throw new Error("回合不存在。");
      if (request.action === "retry_turn") {
        await this.write(data => {
          const j = data.jobs.find(j => j.id === job.id)!, t = j.turns.find(t => t.id === turn.id)!;
          if (!["failed", "cancelled", "interrupted"].includes(t.state)) throw new Error("当前回合不能重试。");
          if (t.attempts >= LOCAL_REVIEW_MAX_TURN_ATTEMPTS) throw new Error(`此回合已重试 ${LOCAL_REVIEW_MAX_TURN_ATTEMPTS} 次，请重新提问。`);
          if (this.jobBusy(j) || j.turns.some(o => o.id !== t.id && (o.state === "queued" || o.state === "running"))) throw new Error("有其它操作进行中，请稍后重试。");
          t.state = "queued"; t.attemptId = randomUUID(); t.attempts++; t.error = null;
        });
        this.kick(); return;
      }
      let outcome = "none" as "cancelled" | "abort" | "none";
      await this.write(data => {
        const j = data.jobs.find(j => j.id === job.id)!, t = j.turns.find(t => t.id === turn.id)!;
        // Decided inside the write: a pump that already took the turn sees an invalidated attempt and stops.
        if (t.state === "queued") { t.state = "cancelled"; t.error = "已取消"; this.append(j, { role: "system", body: "讨论回合已取消。", turnId: t.id, attemptId: t.attemptId, event: "turn_cancelled" }); t.attemptId = randomUUID(); outcome = "cancelled"; }
        else if (t.state === "running") outcome = "abort";
      });
      const operation = this.operations.get(job.id);
      if (outcome === "abort" && operation?.kind === "turn" && operation.id === turn.id) { this.controllers.get(job.id)?.abort(); await this.completions.get(job.id); }
      return;
    }
    const execution = find();
    if (request.action === "cancel_execution") {
      if (execution.kind === "new") {
        // Only this execution's group: other groups of the task and everything already pushed stay as they are.
        const operation = this.operations.get(job.id);
        if (operation?.kind === "job" && this.job(job.id).selectedGroupIds?.includes(execution.groupId)) { this.controllers.get(job.id)?.abort(); await this.completions.get(job.id); }
        await this.write(data => {
          const j = data.jobs.find(j => j.id === job.id)!, g = j.groups.find(g => g.id === execution.groupId)!;
          if (g.state === "pending" || g.state === "committed") { g.state = "cancelled"; g.error = "已取消"; g.attemptId = randomUUID(); if (j.state === "queued") j.state = "finished"; }
        });
        await this.settleNewExecutions(job.id); return;
      }
      let outcome = "none" as "cancelled" | "abort" | "none";
      await this.write(data => {
        const j = data.jobs.find(j => j.id === job.id)!, e = j.executions.find(e => e.id === execution.id)!;
        if (e.state === "pending") { e.state = "cancelled"; e.error = "已取消"; e.updatedAt = new Date().toISOString(); this.append(j, { role: "system", body: "执行已取消。", executionId: e.id, attemptId: e.attemptId, event: "execution_cancelled" }); e.attemptId = randomUUID(); outcome = "cancelled"; }
        else if (EXEC_ACTIVE.has(e.state)) outcome = "abort";
      });
      const operation = this.operations.get(job.id);
      if (outcome === "abort" && operation?.kind === "exec" && operation.id === execution.id) { this.controllers.get(job.id)?.abort(); await this.completions.get(job.id); }
      return;
    }
    if (execution.kind === "new") {
      const group = this.group(job.id, execution.groupId);
      if (request.action === "retry_execution") return this.action({ repositoryId: job.repositoryId, jobId: job.id, groupId: group.id, action: "retry" });
      if (request.action === "discard_execution") return this.action({ repositoryId: job.repositoryId, jobId: job.id, groupId: group.id, action: "discard" });
      if (request.action === "approve_execution" && group.artifact) {
        const expected = { executionId: execution.id, groupId: group.id, commitOid: group.artifact.commitOid, planBaseOid: job.snapshot.headSha, risks: group.artifact.risks, pushUrl: job.pushUrl };
        if (JSON.stringify(request.authorization) !== JSON.stringify(expected)) throw new Error("提交、文件清单或推送地址已变化，请重新审阅。");
        return this.action({ repositoryId: job.repositoryId, jobId: job.id, groupId: group.id, action: "approve", authorization: { groupId: group.id, commitOid: group.artifact.commitOid, risks: group.artifact.risks, pushUrl: job.pushUrl } });
      }
      throw new Error("此执行不支持这个操作。");
    }
    await this.write(data => {
      const j = data.jobs.find(j => j.id === job.id)!, e = j.executions.find(e => e.id === execution.id)!, now = new Date().toISOString();
      if (this.jobBusy(j) || j.turns.some(t => t.state === "queued" || t.state === "running")) throw new Error("有其它操作进行中，请稍后重试。");
      if (j.executions.some(o => o.id !== e.id && o.groupId === e.groupId && EXEC_OCCUPYING.has(o.state))) throw new Error("这个组已有其它进行中的执行。");
      const restart = () => { if (e.attempts >= LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS) throw new Error(`此执行已重试 ${LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS} 次，不能再重试。`); e.state = "pending"; e.attemptId = randomUUID(); e.attempts++; e.error = null; e.updatedAt = now; };
      const group = j.groups.find(g => g.id === e.groupId)!;
      switch (request.action) {
        case "retry_execution":
          if (!["failed", "interrupted", "cancelled"].includes(e.state)) throw new Error("当前状态不能重试。");
          if (!e.pushed && group.artifact?.commitOid !== e.planBaseOid) throw new Error("组的提交已变化，请重新讨论。");
          restart(); break;
        case "retry_comment":
          if (e.state !== "done_comment_failed" || !e.pushed) throw new Error("只有评论失败的执行可以重试评论。");
          restart(); break;
        case "approve_execution": {
          if (e.state !== "blocked" || !e.artifact || e.artifact.secretFindings?.length || reviewSecretFindings(e.artifact.diff).length) throw new Error("此执行无需授权，或命中敏感形态只能丢弃。");
          const expected = { executionId: e.id, groupId: e.groupId, commitOid: e.newCommitOid!, planBaseOid: e.planBaseOid!, risks: e.artifact.risks, pushUrl: j.pushUrl };
          if (JSON.stringify(request.authorization) !== JSON.stringify(expected)) throw new Error("提交、文件清单或推送地址已变化，请重新审阅。");
          e.authorization = expected; restart(); break;
        }
        case "discard_execution":
          if (!["blocked", "failed", "interrupted", "cancelled"].includes(e.state)) throw new Error("当前状态不能丢弃。");
          // Discarding makes the execution final: attempts are exhausted so no retry button remains. The group's PR and commit stay as they were.
          e.state = "cancelled"; e.attempts = LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS; e.error = "本次追加已丢弃"; e.intent = null; e.updatedAt = now;
          this.append(j, { role: "system", body: "本次追加已丢弃；组原有的 PR 和提交不受影响。", executionId: e.id, attemptId: e.attemptId, event: "execution_discarded" }); break;
        default: throw new Error("不支持的操作。");
      }
    });
    if (request.action === "discard_execution") { try { await this.removeOwned(job.id, `exec-${execution.id}`); } catch (error) { if (this.storageFault) throw error; } return; }
    this.kick();
  }

  /** New-group executions ride the normal group pipeline; mirror the group's state into the execution and report the outcome. */
  private async settleNewExecutions(jobId: string) {
    const map: Record<string, LocalReviewExecution["state"]> = { pending: "pending", fixing: "fixing", committed: "committed", pushing: "pushing", opening_pr: "pushing", pr_opened: "done", pushed_no_pr: "done", blocked: "blocked", no_changes: "no_changes", failed: "failed", cancelled: "cancelled", interrupted: "interrupted" };
    const final = new Set(["done", "no_changes", "blocked", "failed", "cancelled", "interrupted"]);
    for (const e of this.job(jobId).executions) {
      if (e.kind !== "new") continue;
      const group = this.job(jobId).groups.find(g => g.id === e.groupId); if (!group) continue;
      const mapped = map[group.state]!;
      if (mapped === e.state) continue;
      await this.update(jobId, j => {
        const x = j.executions.find(x => x.id === e.id)!, g = j.groups.find(g => g.id === x.groupId)!;
        x.state = mapped; x.updatedAt = new Date().toISOString(); x.error = g.error;
        if (!final.has(mapped)) return;
        const hidden = !!g.artifact && (!!g.artifact.secretFindings?.length || reviewSecretFindings(g.artifact.diff).length > 0);
        const body = hidden ? `敏感形态扫描阻止了推送，本组只能丢弃。命中位置：${(g.artifact!.secretFindings?.length ? g.artifact!.secretFindings : reviewSecretFindings(g.artifact!.diff)).map(f => `${f.path}:${f.line}`).join("、")}`
          : mapped === "done" ? `新组「${g.title}」已完成：分支 \`${g.branch}\`${g.pr ? `，PR ${g.pr.url}` : `，没有创建 PR（${g.error ?? "无匹配平台链接"}）`}。\n\n${(g.fix?.outcomes ?? []).map(o => `- ${o.id} ${o.outcome}：${o.summary}`).join("\n")}\n\nverification：\n${g.fix?.verification ?? "无"}`
          : mapped === "no_changes" ? "没有产生可提交的改动。" : mapped === "blocked" ? `新组涉及高风险文件，需要你单独确认后才推送：${g.artifact?.risks.join("、") ?? ""}` : `新组${mapped === "cancelled" ? "已取消" : mapped === "interrupted" ? "被中断" : "失败"}${g.error ? `：${g.error}` : ""}。`;
        this.append(j, { role: "system", body, executionId: x.id, attemptId: x.attemptId, event: `execution_${mapped}` });
      });
    }
  }
  async close() {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.all([...this.submissions]);
    await this.idle();
    await this.write(data => { for (const job of data.jobs) { if (["evaluating", "preparing_dependencies", "running_groups"].includes(job.state)) job.state = "interrupted"; for (const group of job.groups) if (active.has(group.state)) group.state = "interrupted"; this.interruptConversation(job); } });
  }
}
