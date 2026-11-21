import { z } from "zod";
import { modelProviderProfileSchema, modelBackendKindSchema } from "./model.js";

export const localReviewPathSchema = z.string().min(1).max(2000).refine(p => !p.includes("\0") && !p.includes("\\") && !p.startsWith("/") && p.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"), "文件路径无效");
const id = z.string().uuid(), oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
export const localReviewAnnotationSchema = z.object({ id, path: localReviewPathSchema, startLine: z.number().int().positive(), endLine: z.number().int().positive(), side: z.enum(["old", "new"]), lineText: z.string().max(100_000), body: z.string().trim().min(1).max(4000) }).strict().refine(a => a.endLine >= a.startLine);
export const localReviewWorkerSchema = z.enum(["codex", "claude-code", "pi"]);
export type LocalReviewWorkerKind = z.infer<typeof localReviewWorkerSchema>;
export const localReviewDependenciesSchema = z.object({ mode: z.enum(["auto", "custom", "off"]), argv: z.array(z.string().min(1).max(8192).refine(s => !s.includes("\0"))).max(200), files: z.array(localReviewPathSchema).max(100), allowScripts: z.boolean() }).strict();
export const localReviewSettingsSchema = z.object({ dependencies: localReviewDependenciesSchema.optional(), worker: localReviewWorkerSchema.default("codex"), pushRemote: z.string().min(1).max(200), baseBranch: z.string().min(1).max(500), reviewers: z.array(z.string().min(1).max(200)).max(20) }).strict();
export const localReviewRepositorySnapshotSchema = z.object({ path: z.string(), headSha: oid, baseSha: oid, branch: z.string().nullable(), dirty: z.boolean(), author: z.object({ name: z.string(), email: z.string() }) });
export const localReviewRepositorySchema = z.object({ id, name: z.string(), snapshot: localReviewRepositorySnapshotSchema, settings: localReviewSettingsSchema });
export const localReviewSessionSchema = z.object({ id, repositoryId: id, snapshot: localReviewRepositorySnapshotSchema, annotations: z.array(localReviewAnnotationSchema).max(50) });
export const localReviewVerdictSchema = z.object({ id: z.string(), verdict: z.enum(["accept", "reject", "needs_input"]), reason: z.string().min(1).max(4000) });
export const localReviewFixSchema = z.object({ possibleLaunchdLabels: z.array(z.string()).optional(), actualModel: z.string().optional(), actualBackend: modelBackendKindSchema.optional(), changedFiles: z.array(localReviewPathSchema).max(2000).default([]), outcomes: z.array(z.object({ id: z.string(), outcome: z.enum(["fixed", "partial", "skipped"]), summary: z.string().max(4000) })), commitTitle: z.string().max(300), verification: z.string().max(16_000) });
export const localReviewArtifactSchema = z.object({ secretFindings: z.array(z.object({ path: localReviewPathSchema, line: z.number().int().positive() })).optional(), commitOid: oid, changes: z.array(z.object({ path: localReviewPathSchema, oldPath: localReviewPathSchema.optional(), oldMode: z.string(), newMode: z.string(), status: z.string() })), diff: z.string().max(4 * 1024 * 1024), risks: z.array(localReviewPathSchema) });
export const localReviewGroupStateSchema = z.enum(["pending", "fixing", "committed", "pushing", "opening_pr", "pr_opened", "pushed_no_pr", "blocked", "no_changes", "failed", "cancelled", "interrupted"]);
export const localReviewAuthorizationSchema = z.object({ groupId: id, commitOid: oid, risks: z.array(localReviewPathSchema), pushUrl: z.string() });
// ponytail: initial evaluation still plans 1-8 groups; conversation groups add up to this cumulative cap (rejected before any intent).
export const LOCAL_REVIEW_MAX_GROUPS = 16;
// ponytail: soft gate only on new user messages. Worker/system/recovery messages are never blocked, so a receipt cannot fail the ledger write.
export const LOCAL_REVIEW_MESSAGE_SOFT_LIMIT = 400;
// ponytail: bounds on retries that make messages after the soft gate: 5 turn retries, 20 execution retries (comment retries included).
export const LOCAL_REVIEW_MAX_TURN_ATTEMPTS = 5;
export const LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS = 20;
export const LOCAL_REVIEW_USER_MESSAGE_MAX = 8000;
export const LOCAL_REVIEW_REPLY_MAX = 16_000;
// System results quote verification (up to 16000) plus outcomes and the unsent comment verbatim, so they get a larger internal cap than replies.
export const LOCAL_REVIEW_SYSTEM_MAX = 60_000;
export const localReviewReferenceSchema = z.object({ kind: z.enum(["annotation", "group"]), id }).strict();
export const localReviewPlanTargetSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("existing"), groupId: z.string().min(1).max(200) }).strict(), z.object({ kind: z.literal("new"), title: z.string().trim().min(1).max(200) }).strict()]);
/** The model's proposal; ids are checked by the host, so they are plain strings here. */
export const localReviewPlanSchema = z.object({ target: localReviewPlanTargetSchema, annotationIds: z.array(z.string().min(1).max(200)).max(50), requirements: z.string().max(4000), expectedChanges: z.string().trim().min(1).max(4000), reason: z.string().trim().min(1).max(4000) }).strict();
export const localReviewStoredPlanSchema = localReviewPlanSchema.extend({ planBaseOid: oid.nullable(), executable: z.boolean(), invalidReason: z.string().max(1000).nullable() }).strict();
export const localReviewMessageSchema = z.object({
  id, seq: z.number().int().positive(), role: z.enum(["user", "worker", "system"]), createdAt: z.string(), body: z.string().min(1),
  references: z.array(localReviewReferenceSchema).max(20), turnId: id.nullable(),
  plan: localReviewStoredPlanSchema.optional(), executionId: id.optional(), attemptId: id.optional(), event: z.string().min(1).max(60).optional(),
}).strict().superRefine((m, ctx) => { if (m.body.length > (m.role === "user" ? LOCAL_REVIEW_USER_MESSAGE_MAX : m.role === "worker" ? LOCAL_REVIEW_REPLY_MAX : LOCAL_REVIEW_SYSTEM_MAX)) ctx.addIssue({ code: "custom", message: "消息过长" }); });
export const localReviewTurnStateSchema = z.enum(["queued", "running", "answered", "failed", "cancelled", "interrupted"]);
export const localReviewTurnSchema = z.object({
  id, userMessageId: id, state: localReviewTurnStateSchema, attemptId: id, attempts: z.number().int().nonnegative(), error: z.string().max(2000).nullable(),
  stats: z.object({ summaryLevel: z.number().int().min(0).max(2), excerpts: z.number().int().nonnegative(), omittedTurns: z.number().int().nonnegative(), chars: z.number().int().nonnegative() }).strict().nullable().default(null),
}).strict();
export const localReviewConversationSchema = z.object({ messages: z.array(localReviewMessageSchema), nextSeq: z.number().int().positive(), readSeq: z.number().int().nonnegative() }).strict();
export const localReviewExecutionStateSchema = z.enum(["pending", "fixing", "committed", "pushing", "commenting", "done", "done_comment_failed", "no_changes", "blocked", "remote_changed", "failed", "cancelled", "interrupted"]);
export const localReviewExecutionAuthorizationSchema = z.object({ executionId: id, groupId: id, commitOid: oid, planBaseOid: oid, risks: z.array(localReviewPathSchema), pushUrl: z.string() }).strict();
export const localReviewExecutionSchema = z.object({
  id, messageId: id, turnId: id, groupId: id, kind: z.enum(["existing", "new"]), planBaseOid: oid.nullable(),
  annotationIds: z.array(id).max(50), requirements: z.string().max(4000), expectedChanges: z.string().max(4000),
  state: localReviewExecutionStateSchema, intent: z.enum(["fix", "commit", "push", "comment"]).nullable(), attemptId: id, attempts: z.number().int().nonnegative(),
  newCommitOid: oid.nullable().default(null), fix: localReviewFixSchema.nullable().default(null), artifact: localReviewArtifactSchema.nullable().default(null), excludedFiles: z.array(localReviewPathSchema).default(() => []),
  pushed: z.boolean().default(false), comment: z.object({ body: z.string().max(40_000), published: z.boolean(), error: z.string().max(2000).nullable() }).strict().nullable().default(null),
  authorization: localReviewExecutionAuthorizationSchema.nullable().default(null), error: z.string().max(2000).nullable(), createdAt: z.string(), updatedAt: z.string(),
}).strict();
export type LocalReviewMessage = z.infer<typeof localReviewMessageSchema>;
export type LocalReviewTurn = z.infer<typeof localReviewTurnSchema>;
export type LocalReviewExecution = z.infer<typeof localReviewExecutionSchema>;
export type LocalReviewPlan = z.infer<typeof localReviewPlanSchema>;
export type LocalReviewStoredPlan = z.infer<typeof localReviewStoredPlanSchema>;
export type LocalReviewReference = z.infer<typeof localReviewReferenceSchema>;
export const localReviewGroupSchema = z.object({ id, ordinal: z.number().int().positive(), title: z.string(), reason: z.string(), annotationIds: z.array(id), branch: z.string(), state: localReviewGroupStateSchema, retryable: z.boolean().default(true), attemptId: id, intent: z.enum(["fix", "commit", "push", "create_pr"]).nullable(), artifact: localReviewArtifactSchema.nullable(), excludedFiles: z.array(localReviewPathSchema).default([]), fix: localReviewFixSchema.nullable(), pushObservedSha: oid.nullable(), pr: z.object({ id: z.string(), url: z.string().url() }).nullable(), authorization: localReviewAuthorizationSchema.nullable(), error: z.string().nullable(), cleanupError: z.string().nullable(), origin: z.enum(["evaluation", "conversation"]).default("evaluation"), requirements: z.string().max(4000).default(""), commits: z.array(z.object({ oid, executionId: id.nullable() }).strict()).max(200).default(() => []) }).strict();
/**
 * A task made of comments on one of the user's own PRs (作者回应 · 修, docs/review-collaboration-design.md「作者回应与修复」):
 * its fix is one commit on the PR's own branch, over the head it was made on, pushed once the author says so, never
 * forced; then each comment fixed is answered 已修 under it and the description's 本轮变化 is written.
 */
export const localReviewPrSchema = z.object({
  connectionId: id, reference: z.string().min(1).max(2000), url: z.string().max(2000), sourceBranch: z.string().min(1).max(500),
  /** The PR's head when the task was made: the fix is made on it, and pushed only while the branch is still there. */
  headSha: oid,
  /** Which comment each annotation came from. */
  comments: z.array(z.object({ annotationId: id, commentId: z.string().min(1).max(200), author: z.string().max(300), title: z.string().max(200) }).strict()).max(50),
  /** After the push: the comments answered 已修, whether 本轮变化 was written, and what did not go out. */
  replied: z.array(z.string().max(200)).max(50).default(() => []),
  described: z.boolean().default(false),
  followUpError: z.string().max(2000).nullable().default(null),
}).strict();
export type LocalReviewPr = z.infer<typeof localReviewPrSchema>;
/** 修: the chosen comments on the user's PR, handed to a local review of the repository its branch is pushed from. */
export const localReviewFromPrSchema = z.object({
  connectionId: id, reference: z.string().trim().min(1).max(2000), commentIds: z.array(z.string().min(1).max(200)).min(1).max(20),
  profileId: z.string().min(1).max(200), worker: localReviewWorkerSchema.optional(),
  /** The local repository; left out, the one whose push remote is the PR's source repository. */
  repositoryId: id.optional(),
}).strict();
export type LocalReviewFromPr = z.infer<typeof localReviewFromPrSchema>;
export const localReviewJobSchema = z.object({ possibleLaunchdLabels: z.array(z.string()).optional(), dependencies: z.object({ possibleLaunchdLabels: z.array(z.string()).optional(), key: z.string().regex(/^[a-f0-9]{64}$/u).optional(), summary: z.string().max(4000), log: z.string().max(2 * 1024 * 1024) }).optional(), worker: localReviewWorkerSchema.default("codex"), actualModel: z.string().optional(), actualBackend: modelBackendKindSchema.optional(), id, repositoryId: id, sessionId: id, snapshot: localReviewRepositorySnapshotSchema, annotations: z.array(localReviewAnnotationSchema).max(50), settings: localReviewSettingsSchema, profile: modelProviderProfileSchema, state: z.enum(["queued", "evaluating", "preparing_dependencies", "running_groups", "finished", "no_changes", "failed", "cancelled", "interrupted"]), createdAt: z.string(), updatedAt: z.string(), pushUrl: z.string(), connection: z.object({ id, baseUrl: z.string(), platform: z.enum(["github", "gitlab", "bitbucket-server"]), sourceRepository: z.string(), destinationRepository: z.string() }).nullable(), prUnavailable: z.string().nullable(), pr: localReviewPrSchema.nullable().default(null), verdicts: z.array(localReviewVerdictSchema), originalGroups: z.unknown(), fallback: z.string().nullable(), planVersion: z.number().int(), groups: z.array(localReviewGroupSchema).max(LOCAL_REVIEW_MAX_GROUPS), rejectedPrGroupId: id.nullable(), error: z.string().nullable(), conversation: localReviewConversationSchema.default(() => ({ messages: [], nextSeq: 1, readSeq: 0 })), turns: z.array(localReviewTurnSchema).default(() => []), executions: z.array(localReviewExecutionSchema).default(() => []) });
export const localReviewStateSchema = z.object({ version: z.literal(1), repositories: z.array(localReviewRepositorySchema), sessions: z.array(localReviewSessionSchema), jobs: z.array(localReviewJobSchema) });
export const localReviewContextSchema = z.object({ repositoryId: id, sessionId: id }).strict();
export const localReviewReadSchema = localReviewContextSchema.extend({ path: localReviewPathSchema, side: z.enum(["old", "new"]) });
export const localReviewAnnotateSchema = localReviewReadSchema.extend({ annotationId: id.optional(), startLine: z.number().int().positive(), endLine: z.number().int().positive(), body: z.string().trim().min(1).max(4000) });
// follow_up: a PR task's 已修 replies and 本轮变化 sent again after some did not go out; the push itself is never redone.
export const localReviewActionSchema = z.object({ repositoryId: id, jobId: id, groupId: id.optional(), action: z.enum(["cancel", "retry", "discard", "approve", "follow_up"]), authorization: localReviewAuthorizationSchema.optional() }).strict();
export const localReviewSendMessageSchema = z.object({ repositoryId: id, jobId: id, body: z.string().trim().min(1).max(LOCAL_REVIEW_USER_MESSAGE_MAX), references: z.array(localReviewReferenceSchema).max(20).default([]) }).strict();
export const localReviewExecuteSchema = z.object({ repositoryId: id, jobId: id, messageId: id }).strict();
export const localReviewMarkReadSchema = z.object({ repositoryId: id, jobId: id, seq: z.number().int().nonnegative() }).strict();
export const localReviewConversationActionSchema = z.object({ repositoryId: id, jobId: id, action: z.enum(["cancel_turn", "retry_turn", "cancel_execution", "retry_execution", "discard_execution", "approve_execution", "retry_comment"]), turnId: id.optional(), executionId: id.optional(), authorization: localReviewExecutionAuthorizationSchema.optional() }).strict();
export const localReviewFilesSchema = z.object({ pushUrl: z.string().nullable(), prUnavailable: z.string().nullable(), files: z.array(z.object({ path: z.string(), mode: z.string(), type: z.string(), oid })), diff: z.string() });
export const localReviewSessionRequestSchema = z.object({ repositoryId: id, baseBranch: z.string().max(500).optional() }).strict();
export const localReviewChooseSchema = z.object({ baseBranch: z.string().max(500).optional() }).strict();
export const localReviewSaveSettingsSchema = z.object({ repositoryId: id, settings: localReviewSettingsSchema }).strict();
export const localReviewSubmitSchema = localReviewContextSchema.extend({ profileId: z.string().min(1).max(200), worker: localReviewWorkerSchema.optional() });
export const localReviewRemoveAnnotationSchema = localReviewContextSchema.extend({ annotationId: id });
export type LocalReviewFiles = z.infer<typeof localReviewFilesSchema>;
export type LocalReviewAnnotate = z.infer<typeof localReviewAnnotateSchema>;
export type LocalReviewState = z.infer<typeof localReviewStateSchema>;
export type LocalReviewJob = z.infer<typeof localReviewJobSchema>;
export type LocalReviewGroup = z.infer<typeof localReviewGroupSchema>;
export type LocalReviewSession = z.infer<typeof localReviewSessionSchema>;
export type LocalReviewSettings = z.infer<typeof localReviewSettingsSchema>;
export type LocalReviewAction = z.infer<typeof localReviewActionSchema>;
export type LocalReviewSendMessage = z.infer<typeof localReviewSendMessageSchema>;
export type LocalReviewExecute = z.infer<typeof localReviewExecuteSchema>;
export type LocalReviewMarkRead = z.infer<typeof localReviewMarkReadSchema>;
export type LocalReviewConversationAction = z.infer<typeof localReviewConversationActionSchema>;
/** Title shown for a task: the first comment's file and line plus when it was created; the UUID is secondary. */
export const localReviewTaskTitle = (job: { annotations: readonly { path: string; startLine: number }[]; createdAt: string }): string => `${job.annotations[0] ? `${job.annotations[0].path}:${job.annotations[0].startLine}` : "审阅任务"} · ${job.createdAt}`;
