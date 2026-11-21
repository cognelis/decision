import type { McpServer } from "@modelcontextprotocol/server";
import {
  LOCAL_REVIEW_TOOLS_VERSION,
  localReviewJobRecordSchema,
  localReviewJobRequestSchema,
  localReviewJobsQuerySchema,
  localReviewJobUpdateSchema,
  type LocalReviewJobRecord,
  type LocalReviewJobRecordResult,
  type LocalReviewJobRequest,
  type LocalReviewJobResult,
  type LocalReviewJobSummary,
  type LocalReviewJobsQuery,
  type LocalReviewJobsResult,
  type LocalReviewJobUpdate,
  type LocalReviewJobUpdateResult,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import { inputReasons } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/**
 * 本地审阅 for agents: comments handed to the App's local review (on a local repository's changes, or on the user's own
 * PR), and its tasks read, cancelled or retried. Pushing a PR's fix and approving a risky change are the user's, in the App.
 */
export interface LocalReviewRuntime {
  recordLocalReviewJob?(input: LocalReviewJobRecord, report?: RuntimeFailureReport): Promise<LocalReviewJobRecordResult | null>;
  listLocalReviewJobs?(input: LocalReviewJobsQuery, report?: RuntimeFailureReport): Promise<LocalReviewJobsResult | null>;
  getLocalReviewJob?(input: LocalReviewJobRequest, report?: RuntimeFailureReport): Promise<LocalReviewJobResult | null>;
  updateLocalReviewJob?(input: LocalReviewJobUpdate, report?: RuntimeFailureReport): Promise<LocalReviewJobUpdateResult | null>;
}

const recordShape = z.object({
  repository: z.string().optional().describe("A local repository added in Paraself's 本地审阅: its id, name or path. Needed with annotations; with a PR, left out: the one whose push remote is the PR's source repository."),
  annotations: z.array(z.object({
    path: z.string().describe("A file of the repository, relative to its root."),
    line: z.number().int().describe("The line, from 1, in the repository's current HEAD (side new) or in its base (side old)."),
    endLine: z.number().int().optional().describe("The last line of a range; left out, one line."),
    side: z.enum(["old", "new"]).optional().describe("new (default): HEAD; old: the base it is compared against."),
    body: z.string().describe("What to change there, up to 4000 characters."),
  })).optional().describe("Comments on lines of the repository's changes (its HEAD against its base branch), 1 to 50. Or give reference and comments instead."),
  connection: z.string().optional().describe("With a PR: the code platform link's id or label; may be left out when there is only one."),
  reference: z.string().optional().describe("The user's own PR, as the platform names it (owner/repo#12), whose comments to fix."),
  comments: z.array(z.string()).optional().describe("With reference: the ids of the comments to fix, as list_pr_comments gives them, 1 to 20; line comments only."),
  model: z.string().optional().describe("The model profile, by an id or label the answer lists. Left out: the first that fits the repository's worker."),
});
const listShape = z.object({
  repository: z.string().optional().describe("Only one repository's tasks: its id, name or path."),
  limit: z.number().int().optional().describe("Tasks to list, 1 to 50, default 20, newest first."),
});
const getShape = z.object({ id: z.string().describe("The task's id, from record_local_review_job or list_local_review_jobs.") });
const updateShape = z.object({
  id: z.string().describe("The task's id."),
  action: z.enum(["cancel", "retry"]).describe("cancel: stop the task; retry: run a failed or interrupted group again (with group), or the evaluation (without)."),
  group: z.number().int().optional().describe("retry only: the group's number, as get_local_review_job lists it."),
});

const reply = (text: string, localReview: unknown, isError: boolean) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text }],
  structuredContent: { message: text, localReview },
});
const asked = async <T>(ask: ((report: RuntimeFailureReport) => Promise<T | null>) | undefined): Promise<{ result: T | null; failure: RuntimeFailure }> => {
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = await ask?.((reported) => { failure = reported; }).catch(() => null) ?? null;
  return { result, failure };
};
const RULES = {
  "annotations 和 reference 二选一。": "annotations（本地改动上的意见）和 reference（用户自己 PR 上的意见）二选一",
  "从 PR 交意见要给 comments。": "从 PR 交意见要用 comments 给出意见 id",
  "本地改动上的意见要指明 repository。": "本地改动上的意见要用 repository 指明工程",
} as const;
const refused = (what: string, error: z.ZodError) => reply(`${what}：输入不符合要求（${inputReasons(error, RULES)}）。`, null, true);

const STATES: Record<string, string> = { queued: "排队中", evaluating: "评估意见", preparing_dependencies: "准备依赖", running_groups: "修改中", finished: "已结束", no_changes: "没有要改的", failed: "失败", cancelled: "已取消", interrupted: "已中断",
  pending: "待处理", fixing: "修改中", committed: "已提交", pushing: "推送中", opening_pr: "开 PR 中", pr_opened: "PR 已开", pushed_no_pr: "已推送、没开 PR", blocked: "等用户确认" };
const summaryLine = (job: LocalReviewJobSummary) => [
  `任务 ${job.id} · ${job.repository} · ${STATES[job.state] ?? job.state} · ${job.comments} 条意见${job.pr ? ` · 来自 ${job.pr.reference}，修复推到 ${job.pr.sourceBranch}` : ""}`,
  ...job.groups.map((group) => `  组 ${group.ordinal}「${group.title}」：${job.pr && group.state === "blocked" ? "改好了，等用户在 App 里确认推送" : job.pr && group.state === "pr_opened" ? "已推送到原 PR" : STATES[group.state] ?? group.state}${group.pr ? `，${group.pr}` : ""}`),
  ...(job.needsAttention ? [`  有 ${job.needsAttention} 处等用户处理`] : []),
  ...(job.error ? [`  ${job.error}`] : []),
].join("\n");

export const recordLocalReviewJob = async (input: z.input<typeof recordShape>, runtime: LocalReviewRuntime) => {
  const request = localReviewJobRecordSchema.safeParse({ localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有交给本地审阅", request.error);
  const { result, failure } = await asked((report) => runtime.recordLocalReviewJob?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认是否交给了本地审阅：${runtimeFailureText(failure)}。先用 list_local_review_jobs 看有没有新任务，不要直接重试。`, null, true);
  const repositories = result.repositories.map((item) => `「${item.name}」（id ${item.id}）`).join("、") || "没有";
  if (result.status === "repository_not_found") return reply(`没有交给本地审阅：没有「${request.data.repository}」这个工程。本地审阅里的工程：${repositories}。`, result, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") {
    return reply(`没有交给本地审阅：${result.status === "connection_needed" ? "有不止一个代码平台连接，要用 connection 指明" : `没有叫「${request.data.connection}」的连接`}。现有的连接：${result.connections.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有"}。`, result, true);
  }
  if (result.status === "model_not_found") return reply(`没有交给本地审阅：${result.reason ?? `没有「${request.data.model}」这个模型档案`}。可用的：${result.models.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有"}。`, result, true);
  if (result.status !== "submitted" || !result.jobId) return reply(`没有交给本地审阅：${result.reason ?? "原因不明"}`, result, true);
  const text = [
    `已交给本地审阅：任务 ${result.jobId}，${request.data.reference ? `${request.data.reference} 上的 ${request.data.comments!.length} 条意见` : `${request.data.annotations!.length} 条意见`}。它在后台评估、修改，用 get_local_review_job 看进度和结果。`,
    request.data.reference
      ? "改好后由用户在 Paraself 评审页“我创建的”里确认，再作为新提交推到原 PR；推送不经工具。"
      : "改好的每组会推到新分支并开 PR（涉及 CI、Git 行为文件等高风险改动的，等用户在 App 里确认）。",
  ].join("\n");
  return reply(text, result, false);
};

export const listLocalReviewJobs = async (input: z.input<typeof listShape>, runtime: LocalReviewRuntime) => {
  const request = localReviewJobsQuerySchema.safeParse({ localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有列出本地审阅任务", request.error);
  const { result, failure } = await asked((report) => runtime.listLocalReviewJobs?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有列出本地审阅任务：${runtimeFailureText(failure)}`, null, true);
  const text = result.jobs.length ? [`本地审阅任务 ${result.total} 个${result.total > result.jobs.length ? `，列出最新的 ${result.jobs.length} 个` : ""}：`, ...result.jobs.map(summaryLine), "只读。"].join("\n") : "还没有本地审阅任务。只读。";
  return reply(text, result, false);
};

export const getLocalReviewJob = async (input: z.input<typeof getShape>, runtime: LocalReviewRuntime) => {
  const request = localReviewJobRequestSchema.safeParse({ localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有读取本地审阅任务", request.error);
  const { result, failure } = await asked((report) => runtime.getLocalReviewJob?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取本地审阅任务：${runtimeFailureText(failure)}`, null, true);
  const job = result.job;
  if (!job) return reply(`没有这个本地审阅任务：${request.data.id}。用 list_local_review_jobs 查。`, result, true);
  const text = [
    summaryLine(job),
    `执行方式 ${job.worker} · 模型 ${job.model}`,
    "意见：",
    ...job.annotations.map((item, index) => `${index + 1}. ${item.path}:${item.line} ${item.body.replace(/\s+/gu, " ").slice(0, 300)}\n   评估：${item.verdict ?? "还没有"}${item.reason ? `，${item.reason.replace(/\s+/gu, " ").slice(0, 300)}` : ""}${item.outcome ? `\n   修改：${item.outcome}，${(item.summary ?? "").replace(/\s+/gu, " ").slice(0, 300)}` : ""}`),
    ...job.details.flatMap((detail) => [
      `组 ${detail.ordinal}：${detail.commit ? `提交 ${detail.commit.slice(0, 12)}，改了 ${detail.changedFiles.join("、") || "没有文件"}` : "还没有提交"}${detail.risks.length ? `；高风险文件 ${detail.risks.join("、")}，推送要用户在 App 里确认` : ""}`,
      ...(detail.verification ? [`  验证：${detail.verification.replace(/\s+/gu, " ").slice(0, 800)}`] : []),
      ...(detail.error ? [`  ${detail.error}`] : []),
    ]),
    ...(job.followUp ? [`推送后：${job.followUp.replied} 条意见已回复已修，本轮变化${job.followUp.described ? "已" : "没有"}写进 PR 描述${job.followUp.error ? `；${job.followUp.error}` : ""}。`] : []),
    "只读。",
  ].join("\n");
  return reply(text, result, false);
};

export const updateLocalReviewJob = async (input: z.input<typeof updateShape>, runtime: LocalReviewRuntime) => {
  const request = localReviewJobUpdateSchema.safeParse({ localReviewToolsVersion: LOCAL_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有改动本地审阅任务", request.error);
  const { result, failure } = await asked((report) => runtime.updateLocalReviewJob?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认任务是否改动：${runtimeFailureText(failure)}。先用 get_local_review_job 看它现在的状态。`, null, true);
  if (result.status === "not_found") return reply(`没有这个本地审阅任务：${request.data.id}。`, result, true);
  if (result.status === "refused") return reply(`没有${request.data.action === "cancel" ? "取消" : "重试"}：${result.reason ?? "原因不明"}`, result, true);
  return reply(`${request.data.action === "cancel" ? "已取消" : "已重新排队"}。\n${result.job ? summaryLine(result.job) : ""}`.trim(), result, false);
};

export const registerLocalReviewTools = (server: McpServer, runtime: LocalReviewRuntime): void => {
  server.registerTool("record_local_review_job", {
    title: "Hand comments to the local review",
    description:
      "Hand a batch of comments to Paraself's local review, which judges each, fixes the accepted ones with a coding agent in a private copy of the repository and commits: comments on lines of a local repository's changes (annotations), or comments on the user's own PR (reference and comments, line comments only). It spends model calls, and its fixes go to the team's code platform: those of a local repository's changes are pushed to new branches with PRs opened (a change to CI or Git behavior files waits for the user's approval in the App); a PR's fix waits until the user confirms the push in the App, then goes onto the PR's own branch as a new commit, only while that branch is still at the head it was made on. Call it only when the user asks for these comments to be fixed, never on your own. Returns the task's id at once; get_local_review_job shows its progress.",
    inputSchema: recordShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input) => recordLocalReviewJob(input, runtime));
  server.registerTool("list_local_review_jobs", {
    title: "List local review tasks",
    description: "List the local review's tasks, newest first: each with its state, its groups and their branches and PRs, whether it came from comments on a PR, and what waits on the user. Read-only.",
    inputSchema: listShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => listLocalReviewJobs(input, runtime));
  server.registerTool("get_local_review_job", {
    title: "Read one local review task",
    description: "Read one local review task: each comment with the local review's judgement and what its fix did, each group's commit, changed files, high-risk files and verification, and for comments from a PR, whether the fixed ones were answered and the description's 本轮变化 written. Read-only.",
    inputSchema: getShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => getLocalReviewJob(input, runtime));
  server.registerTool("update_local_review_job", {
    title: "Cancel or retry a local review task",
    description: "Cancel a local review task that is still running, or retry one that failed or was interrupted: a group by its number, or the evaluation. Use only when the user says so. Confirming a push or approving a high-risk change is not here: those are the user's, in the App.",
    inputSchema: updateShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input) => updateLocalReviewJob(input, runtime));
};
