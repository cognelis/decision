import type { McpServer } from "@modelcontextprotocol/server";
import {
  PR_BUILD_LABELS,
  PR_COMMENTS_PER_CALL,
  PR_FINDING_BASIS_LABELS,
  PR_REQUIRED_APPROVALS,
  PR_REVIEW_TOOLS_VERSION,
  PR_RISK_LABELS,
  PR_RESPONSE_LABELS,
  PR_OUTCOME_LABELS,
  prCommentResponse,
  prCommentTitle,
  prCommentsToolQuerySchema,
  prCommentUpdateToolSchema,
  prReviewSettingsQuerySchema,
  prReviewSettingsUpdateSchema,
  prReviewMarkOf,
  prDescriptionDraftQuerySchema,
  prListToolQuerySchema,
  prUpdateRequestSchema,
  prReviewCommentsRecordSchema,
  prReviewFindingUpdateSchema,
  prReviewRecordRequestSchema,
  prReviewRecordsQuerySchema,
  prReviewRunToolRequestSchema,
  type PrDescriptionDraftQuery,
  type PrDescriptionDraftResult,
  type PrListToolQuery,
  type PrListToolResult,
  type PrUpdateRequest,
  type PrUpdateResult,
  type PrReviewCommentsRecord,
  type PrReviewCommentsResult,
  type PrReviewFindingUpdate,
  type PrReviewFindingUpdateResult,
  type PrReviewStatus,
  type PrRiskLevel,
  type PrReviewRecordFinding,
  type PrReviewRecordRequest,
  type PrReviewRecordResult,
  type PrReviewRecordSummary,
  type PrReviewRecordsQuery,
  type PrReviewRecordsResult,
  type PrReviewRunToolRequest,
  type PrReviewRunToolResult,
  type PrCommentsToolQuery,
  type PrCommentsToolResult,
  type PrCommentUpdateTool,
  type PrCommentUpdateToolResult,
  type PrReviewSettingsItem,
  type PrReviewSettingsQuery,
  type PrReviewSettingsResult,
  type PrReviewSettingsUpdate,
  type PrReviewSettingsUpdateResult,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import { inputReasons, localTime } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/**
 * PR 评审 for agents: the code platform's PR lists with each PR's build, approvals and blockers (list_prs), the review
 * records the App keeps (list_pr_reviews, get_pr_review), with each PR's risk level and each finding's basis; and, as
 * the review page does, start a review (run_pr_review), 不采纳 a finding (update_pr_review_finding) and post chosen
 * findings to the PR (record_pr_comments); and on the user's own PR, the comments it received and the answer to each
 * (list_pr_comments, update_pr_comment). Approving and merging are not here: an AI's approval is no one's.
 */
export interface PrReviewRuntime {
  listPrs?(input: PrListToolQuery, report?: RuntimeFailureReport): Promise<PrListToolResult | null>;
  listPrReviewRecords?(input: PrReviewRecordsQuery, report?: RuntimeFailureReport): Promise<PrReviewRecordsResult | null>;
  getPrReviewRecord?(input: PrReviewRecordRequest, report?: RuntimeFailureReport): Promise<PrReviewRecordResult | null>;
  runPrReview?(input: PrReviewRunToolRequest, report?: RuntimeFailureReport): Promise<PrReviewRunToolResult | null>;
  updatePrReviewFinding?(input: PrReviewFindingUpdate, report?: RuntimeFailureReport): Promise<PrReviewFindingUpdateResult | null>;
  recordPrComments?(input: PrReviewCommentsRecord, report?: RuntimeFailureReport): Promise<PrReviewCommentsResult | null>;
  prDescriptionDraft?(input: PrDescriptionDraftQuery, report?: RuntimeFailureReport): Promise<PrDescriptionDraftResult | null>;
  updatePr?(input: PrUpdateRequest, report?: RuntimeFailureReport): Promise<PrUpdateResult | null>;
  listPrComments?(input: PrCommentsToolQuery, report?: RuntimeFailureReport): Promise<PrCommentsToolResult | null>;
  updatePrComment?(input: PrCommentUpdateTool, report?: RuntimeFailureReport): Promise<PrCommentUpdateToolResult | null>;
  getPrReviewSettings?(input: PrReviewSettingsQuery, report?: RuntimeFailureReport): Promise<PrReviewSettingsResult | null>;
  updatePrReviewSettings?(input: PrReviewSettingsUpdate, report?: RuntimeFailureReport): Promise<PrReviewSettingsUpdateResult | null>;
}

const listPrsShape = z.object({
  connection: z.string().optional().describe("A code platform connection's id or its label as Paraself's 链接 page shows it. Left out: the first page of every connection."),
  view: z.enum(["review_requested", "created", "merged"]).optional().describe("review_requested (default): PRs waiting for the user's review; created: the user's own; merged: merged ones they reviewed or wrote."),
  page: z.number().int().optional().describe("The page, from 1; with connection only: the previous answer's next page."),
});
const listReviewsShape = z.object({
  reference: z.string().optional().describe("A PR as the platform names it (owner/repo#12, PROJECT/repo#12), or a repository (owner/repo) for all its PRs. Left out: every record."),
  connectionId: z.string().optional().describe("Only one connection's records, by its id from list_prs."),
  limit: z.number().int().optional().describe("Records per page, 1 to 50, default 20."),
  offset: z.number().int().optional().describe("The previous page's nextOffset, the other parameters unchanged."),
});
const getReviewShape = z.object({ id: z.string().describe("A record's id, from list_pr_reviews or list_prs.") });
const findingNumber = z.number().int().describe("The finding's number as get_pr_review lists it, from 1.");
const prTargetShape = {
  connection: z.string().optional().describe("The code platform connection's id or label as Paraself's 链接 page shows it; may be left out when there is only one."),
  reference: z.string().describe("The PR as the platform names it: owner/repo#12, PROJECT/repo#12."),
};
const descriptionDraftShape = z.object(prTargetShape);
const commentsShape = z.object(prTargetShape);
const settingsShape = z.object({ connection: prTargetShape.connection });
const updateSettingsShape = z.object({
  connection: prTargetShape.connection,
  autoReview: z.boolean().describe("true: turn 自动预评审 on for the link; false: off."),
  model: z.string().optional().describe("On only: the model, by an id or label the answer lists. Left out: the one set before, else the first."),
  dailyReviews: z.number().int().optional().describe("On only: reviews a day at most, 1 to 50. Left out: as set before, else 5."),
});
const updateCommentShape = z.object({
  ...prTargetShape,
  comment: z.string().describe("The comment's id, as list_pr_comments gives it."),
  response: z.enum(["wrong", "intended", "wontfix", "later"]).describe("wrong (误报): it does not hold; intended (有意为之): done so on purpose; wontfix (不处理): it holds but is not worth changing now; later (转后续): to be done later, as a todo."),
  reason: z.string().optional().describe("The user's words, up to 4000 characters: why, for wrong, intended and wontfix (needed there); anything to add, for later."),
  todo: z.string().optional().describe("later only: the todo's title, up to 200 characters. Left out: the comment's own."),
});
const runReviewShape = z.object({
  ...prTargetShape,
  depth: z.enum(["standard", "deep"]).optional().describe("deep: more candidates, each checked again; slower and more model calls. Left out: deep for a high-risk PR, standard otherwise."),
  scope: z.enum(["since_last_review", "all"]).optional().describe("since_last_review (default): a later round reviews only what the commits since the last review changed; all: the whole PR again."),
  focus: z.string().optional().describe("What the user wants looked at especially, in their words, up to 2000 characters."),
  model: z.string().optional().describe("The model to review with, by an id or label the answer lists. Left out: the one this PR was last reviewed with, else the first configured."),
});
const updatePrShape = z.object({
  ...prTargetShape,
  description: z.string().describe("The whole description to write, as the user confirmed it, up to 60000 characters."),
  baseVersion: z.string().describe("The baseVersion get_pr_description_draft gave: the description is written only over that version."),
});
const updateFindingShape = z.object({
  id: z.string().describe("The review record's id, from list_pr_reviews or list_prs."),
  finding: findingNumber,
  action: z.enum(["dismiss", "restore"]).describe("dismiss: the user does not take this finding (不采纳); restore: take that back (撤回)."),
  reason: z.string().optional().describe("dismiss only, and needed there: the user's reason, up to 500 characters. Later reviews of the repository are told it."),
});
const recordCommentsShape = z.object({
  id: z.string().describe("The review record's id, from list_pr_reviews or list_prs."),
  findings: z.array(z.object({
    finding: findingNumber,
    blocking: z.boolean().optional().describe("Post it as a blocking item. Left out: a P1 that does not rest only on the user's personal basis is blocking, as the review page has it; false for an ordinary comment."),
    body: z.string().optional().describe("Words the user wants posted instead of the finding's own, up to 9000 characters; the line saying it came from Paraself and what it stands on is added either way."),
    evenIfDuplicate: z.boolean().optional().describe("Post it even though a comment at its place on the PR already says the same: only when the user insists after being told."),
  })).describe(`The findings to post, in order, 1 to ${PR_COMMENTS_PER_CALL}.`),
});

const reply = (text: string, prReview: unknown, isError: boolean) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text }],
  // Claude Code shows a model only the structuredContent of a result that has one: what the text says goes there too.
  structuredContent: { message: text, prReview },
});
const asked = async <T>(ask: ((report: RuntimeFailureReport) => Promise<T | null>) | undefined): Promise<{ result: T | null; failure: RuntimeFailure }> => {
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = await ask?.((reported) => { failure = reported; }).catch(() => null) ?? null;
  return { result, failure };
};
// Rules the schemas say in words of their own: said as they are.
const RULES = { "不修要写明理由。": "不修（wrong、intended、wontfix）要在 reason 里写明用户的理由" } as const;
const refused = (what: string, error: z.ZodError) => reply(`${what}：输入不符合要求（${inputReasons(error, RULES)}）。`, null, true);

const STATES = { running: "进行中", finished: "完成", interrupted: "已中断", failed: "失败" } as const;
const counted = (findings: PrReviewRecordSummary["findings"]) => {
  const total = findings.P1 + findings.P2 + findings.P3;
  return total === 0 ? "没有问题" : `${total} 个问题（${(["P1", "P2", "P3"] as const).filter((key) => findings[key]).map((key) => `${key} ${findings[key]}`).join("、")}）`;
};
const recordLine = (item: PrReviewRecordSummary) => [
  item.kind === "chat" ? "问答" : `第 ${item.round} 轮${item.auto ? "自动预" : ""}评审${STATES[item.state]}`,
  item.risk ? PR_RISK_LABELS[item.risk] : null,
  item.kind === "review" && item.status !== null ? counted(item.findings) : null,
  item.published ? `已发布 ${item.published} 条评论` : null,
].filter(Boolean).join(" · ");

/** The platform's say, as the approval panel shows it: the build, people's approvals against the level's need, what blocks. */
const statusLine = (status: PrReviewStatus, risk: PrRiskLevel | null) => [
  PR_BUILD_LABELS[status.build],
  status.approvals === null ? "批准人数读不到" : `批准 ${status.approvals.count}${risk ? `/${PR_REQUIRED_APPROVALS[risk]}` : " 人"}${status.approvals.stale.length ? `（另有 ${status.approvals.stale.length} 人的批准在旧提交上，要重新看）` : ""}`,
  `${status.blockers === null ? "阻塞项读不到" : `${status.blockers || "没有"}${status.blockers ? " 项" : ""}${status.blocking === "tasks" ? "未完成的任务" : "未解决的讨论"}`}${status.blockersHold === false ? "（仓库没开对应的合并检查，拦不住合并）" : ""}`,
].join(" · ");

export const listPrs = async (input: z.input<typeof listPrsShape>, runtime: PrReviewRuntime) => {
  const request = prListToolQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有列出 PR", request.error);
  const { result, failure } = await asked((report) => runtime.listPrs?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有列出 PR：${runtimeFailureText(failure)}`, null, true);
  const connections = result.connections.map((item) => `「${item.label}」（${item.platform}，id ${item.id}）`).join("、") || "没有";
  if (result.status === "connection_not_found") return reply(`没有列出 PR：没有叫「${request.data.connection}」的连接。现有的连接：${connections}。`, result, true);
  if (result.connections.length === 0) return reply("还没有连接代码平台：请用户先在 Paraself 的「链接」页添加。", result, false);
  const view = { review_requested: "待我评审", created: "我创建的", merged: "已合并" }[request.data.view];
  const text = result.lists.flatMap((list) => {
    const connection = result.connections.find((item) => item.id === list.connectionId)!;
    const head = `连接「${connection.label}」· ${view}${request.data.connection === undefined ? "" : ` · 第 ${request.data.page} 页`}：`;
    if (list.error !== null) return [`${head}读不了（${list.error}）。`];
    if (list.prs.length === 0) return [`${head}没有 PR。`];
    return [head, ...list.prs.map((pr) => `- ${pr.reference} ${pr.title}（${pr.author || "未知作者"}${pr.updatedAt ? `，${localTime(pr.updatedAt)} 更新` : ""}）· ${pr.latest ? `本机：${recordLine(pr.latest)}，记录 ${pr.latest.id}` : "本机未评审"}${pr.status ? ` · 平台：${statusLine(pr.status, pr.latest?.risk ?? null)}` : ""}`),
      ...(list.nextPage === null ? [] : [`还有下一页：connection 传 ${connection.id}，page 传 ${list.nextPage}。`])];
  }).join("\n");
  const statuses = request.data.view !== "merged" && result.lists.some((list) => list.prs.some((pr) => pr.status));
  return reply(`${text}\n风险等级只有评审过的 PR 才有，按目标分支的 REVIEW.md 和改动的文件判定${statuses ? "；批准只数人的，机器人和服务账号的批准不算，需要几人按风险等级定（高风险 2 人，其余 1 人）；没写“平台”的 PR 是状态没有及时读到" : ""}。只读，没有改动平台上的任何东西。`, result, false);
};

export const listPrReviews = async (input: z.input<typeof listReviewsShape>, runtime: PrReviewRuntime) => {
  const request = prReviewRecordsQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有读取评审记录", request.error);
  const { result, failure } = await asked((report) => runtime.listPrReviewRecords?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取评审记录：${runtimeFailureText(failure)}`, null, true);
  const text = [
    result.total === 0 ? "没有符合条件的评审记录。" : `共 ${result.total} 条评审记录，这一页 ${result.records.length} 条，新的在前：`,
    ...result.records.map((item) => `- ${item.id} · ${localTime(item.at)} · ${item.reference} ${item.title} · ${recordLine(item)}`),
    ...(result.nextOffset === null ? [] : [`还有更多：offset 传 ${result.nextOffset}，其余参数不变。`]),
    ...(result.unreadable ? [`另有 ${result.unreadable} 条记录无法读取，原数据已保留。`] : []),
    ...(result.records.length ? ["要看一次评审的问题和依据，用 get_pr_review。"] : []),
  ].join("\n");
  return reply(text, result, false);
};

/** What became of a posted finding (发布后跟踪结果), as last read from its PR. */
const outcomeText = (outcome: NonNullable<PrReviewRecordFinding["outcome"]>) =>
  `${outcome.kind === "none" ? "作者还没回应" : outcome.kind === "maybe_fixed" ? "可能修了（没有回复，原位置在之后的提交里改过）" : `作者回应：${PR_OUTCOME_LABELS[outcome.kind]}${outcome.words ? ` —— ${outcome.words.replace(/\s+/gu, " ").slice(0, 300)}` : ""}`}（读于 ${localTime(outcome.at)}）`;
const findingLine = (finding: PrReviewRecordFinding) => {
  const basis = finding.basis.tier === "repository" ? `依据 ${finding.basis.guides.join("、")}（${PR_FINDING_BASIS_LABELS.repository}）`
    : finding.basis.tier === "personal" ? finding.basis.blocking.length
      ? `依据 本机评审规则 ${finding.basis.blocking.join("、")}（个人规则，标记为阻塞${finding.priority === "P1" ? "：可以设为阻塞，评论会引用规则原文" : "：只有 P1 能设为阻塞，这条只作建议"}）`
      : `依据${finding.decisions.length ? ` 个人决策：${finding.decisions.join("、")}` : " 本机评审规则"}（${PR_FINDING_BASIS_LABELS.personal}）` : "依据代码本身";
  const verdict = finding.verdict === null ? null
    : finding.verdict.by === "reviewer" ? `用户不采纳：${finding.verdict.reason}`
    : `复评${{ keep: "仍成立", replace: "改写后成立", drop: "不成立" }[finding.verdict.verdict]}：${finding.verdict.reason}`;
  return [`${finding.index + 1}. ${finding.priority} ${finding.title}（${finding.path}:${finding.line}，${finding.side === "new" ? "新版本" : "旧版本"}）`,
    `   ${finding.body.replace(/\s+/gu, " ").slice(0, 600)}`,
    `   ${[basis, verdict, finding.published ? `已发布为 PR 评论${finding.blocking ? "（阻塞项）" : ""}${finding.outcome ? `，${outcomeText(finding.outcome)}` : "，结果还没读到"}` : null].filter(Boolean).join("；")}`].join("\n");
};

export const getPrReview = async (input: z.input<typeof getReviewShape>, runtime: PrReviewRuntime) => {
  const request = prReviewRecordRequestSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有读取评审记录", request.error);
  const { result, failure } = await asked((report) => runtime.getPrReviewRecord?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取评审记录：${runtimeFailureText(failure)}`, null, true);
  const record = result.record;
  if (record === null) return reply(`没有找到评审记录 ${request.data.id}：用 list_pr_reviews 找到正确的 id。`, result, true);
  const risk = record.riskDetail;
  const text = [
    `${record.reference} ${record.title} · ${localTime(record.at)} · ${record.model} · ${recordLine(record)}`,
    `提交 ${record.sourceCommit.slice(0, 12)}${record.destinationBranch ? `，目标分支 ${record.destinationBranch}` : ""}${record.focus ? `；关注点：${record.focus}` : ""}`,
    ...(risk ? [`风险等级：${PR_RISK_LABELS[risk.level]}（${risk.reasons.filter((reason) => reason.level === risk.level).map((reason) => `${reason.reason}：${reason.paths.join("、")}${reason.more ? ` 等` : ""}`).join("；") || "没有改动文件"}；${risk.table === "review_md" ? "按目标分支的 REVIEW.md 风险路径" : "目标分支没有 REVIEW.md 风险路径表，按默认规则"}${risk.changesRules ? "；这个 PR 改了评审规则文件" : ""}）`] : []),
    `仓库规范：${record.guides.join("、") || "没有"}；本机评审规则：${record.rules.join("、") || "没有"}`,
    ...(record.summary ? [`结论：${record.summary}`] : []),
    ...(record.findingsList.length ? ["问题：", ...record.findingsList.map(findingLine)] : record.kind === "review" && record.status !== null ? ["没有形成有效问题。"] : []),
    ...(record.needsContext.length ? ["待核实：", ...record.needsContext.map((item) => `- ${item.title}（${item.path}:${item.line}）：${item.reason}；缺少 ${item.missing}`)] : []),
    ...(record.setAside.unplaced || record.setAside.rejected ? [`另有 ${record.setAside.unplaced} 条没能定位到改动行、${record.setAside.rejected} 条核验不成立的候选，未列出。`] : []),
    ...(record.turns.length ? [`追问 ${record.turns.length} 次：${record.turns.map((turn) => `「${turn.question.slice(0, 80)}」`).join("、")}`] : []),
    ...(record.error ? [`出错：${record.error}`] : []),
    ...record.warnings.slice(0, 5).map((warning) => `提示：${warning}`),
    "这些是 AI 评审的草稿：没有执行测试，也不代表 PR 已获批准。个人依据的问题只能作建议，不能要求作者照改。",
  ].join("\n");
  return reply(text, result, false);
};

export const updatePrReviewFinding = async (input: z.input<typeof updateFindingShape>, runtime: PrReviewRuntime) => {
  const request = prReviewFindingUpdateSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有改动这个问题", request.error);
  const { result, failure } = await asked((report) => runtime.updatePrReviewFinding?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认改动结果：${runtimeFailureText(failure)}。可以用 get_pr_review 看这个问题现在的状态。`, null, true);
  if (result.status === "not_found") return reply(`没有找到评审记录 ${request.data.id}：用 list_pr_reviews 找到正确的 id。`, result, true);
  if (result.status === "refused") return reply(`没有改动：${result.reason}`, result, true);
  const finding = result.record?.findingsList[request.data.finding - 1];
  const named = `第 ${request.data.finding} 个问题${finding ? `「${finding.title}」` : ""}`;
  const repository = result.record?.reference.replace(/#\d+$/u, "") ?? "这个仓库";
  if (result.status === "unchanged") return reply(`${named}${request.data.action === "dismiss" ? "已经以同样的原因不采纳" : "没有不采纳过"}，没有改动。`, result, false);
  return reply(request.data.action === "dismiss"
    ? `已不采纳${named}：${request.data.reason}。以后评审 ${repository} 时，会把它和原因告诉模型，不再提同类问题。只改了 Paraself 本机的记录，代码平台上没有变化。`
    : `已撤回${named}的不采纳：以后评审 ${repository} 时不再带上它。只改了 Paraself 本机的记录。`, result, false);
};

const OUTCOMES = { posted: "已发布", already_posted: "已经发布过，没有重发", duplicate: "没有发布", failed: "失败", not_tried: "没有尝试" } as const;
export const recordPrComments = async (input: z.input<typeof recordCommentsShape>, runtime: PrReviewRuntime) => {
  const request = prReviewCommentsRecordSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有发布评论", request.error);
  const { result, failure } = await asked((report) => runtime.recordPrComments?.(request.data, report) ?? Promise.resolve(null));
  // Gone quiet midway, some may be out: they are recorded as they go, and never posted again.
  if (result === null) return reply(`没有确认发布结果：${runtimeFailureText(failure)}。可能已经发出了一部分：先用 get_pr_review 看哪些问题已发布，再决定是否调用；已发布的不会重发。`, null, true);
  if (result.status === "not_found") return reply(`没有找到评审记录 ${request.data.id}：用 list_pr_reviews 找到正确的 id。`, result, true);
  if (result.status === "refused") return reply(`没有发布任何评论：${result.reason}`, result, true);
  const lines = result.results.map((item) => {
    const finding = result.record?.findingsList[item.finding - 1];
    return `- 第 ${item.finding} 个${finding ? `「${finding.title}」` : ""}：${OUTCOMES[item.outcome]}${item.blocking && (item.outcome === "posted" || item.outcome === "already_posted") ? "（阻塞项）" : ""}${item.outcome === "posted" || item.outcome === "failed" || item.outcome === "duplicate" ? `，${item.message}` : ""}${item.outcome === "duplicate" ? "；用户坚持要发时，evenIfDuplicate 传 true" : ""}`;
  });
  const posted = result.results.filter((item) => item.outcome === "posted");
  const failedAt = result.results.find((item) => item.outcome === "failed");
  const head = result.status === "posted"
    ? `已发布到 ${result.record?.reference ?? "PR"}：新发 ${posted.length} 条${posted.some((item) => item.blocking) ? `，其中 ${posted.filter((item) => item.blocking).length} 条阻塞` : ""}。`
    : `发布到第 ${failedAt?.finding} 个问题时失败${posted.length ? `，之前的 ${posted.length} 条已经发出，不会重发` : "，这次没有发出任何评论"}；原因处理好后再调用，只会补发剩下的。`;
  return reply([head, ...lines, ...result.warnings, "以用户的平台账号发布，每条末尾写明来自 Paraself 预评审和依据。"].join("\n"), result, result.status !== "posted");
};

const PARTS = { verification: "验证", risk: "风险", rollback: "撤回" } as const;
const ROUND_CAP = 3;
const connectionTrouble = (status: "connection_not_found" | "connection_needed", connections: Array<{ id: string; label: string; platform: string }>, named: string | undefined) =>
  `${status === "connection_needed" ? "有不止一个代码平台连接，要用 connection 指明是哪个" : named === undefined ? "还没有连接代码平台：请用户先在 Paraself 的「链接」页添加" : `没有叫「${named}」的连接`}。现有的连接：${connections.map((item) => `「${item.label}」（${item.platform}，id ${item.id}）`).join("、") || "没有"}。`;

export const getPrDescriptionDraft = async (input: z.input<typeof descriptionDraftShape>, runtime: PrReviewRuntime) => {
  const request = prDescriptionDraftQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有起草 PR 描述", request.error);
  const { result, failure } = await asked((report) => runtime.prDescriptionDraft?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有起草 PR 描述：${runtimeFailureText(failure)}`, null, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") return reply(`没有起草 PR 描述：${connectionTrouble(result.status, result.connections, request.data.connection)}`, result, true);
  if (result.status === "failed" || !result.draft) return reply(`没有起草 PR 描述：读不了这个 PR（${result.reason}）。`, result, true);
  const draft = result.draft;
  const has = (Object.keys(PARTS) as Array<keyof typeof PARTS>).filter((part) => draft.present[part]).map((part) => PARTS[part]);
  const facts = [draft.facts.risk ? PR_RISK_LABELS[draft.facts.risk] : "风险等级未知（这个 PR 还没在 Paraself 里读过）", draft.facts.build ? `构建：${PR_BUILD_LABELS[draft.facts.build as keyof typeof PR_BUILD_LABELS] ?? draft.facts.build}` : "构建状态没读到",
    draft.facts.reviewRound ? `Paraself 预评审第 ${draft.facts.reviewRound} 轮` : "还没有 Paraself 预评审", draft.facts.rollbackFromOverview ? "撤回取自 PR 概览" : "还没有 PR 概览，撤回留给作者写"];
  const text = [
    `${draft.reference} ${draft.title}`,
    `现在的描述：${draft.description.trim() ? `${has.length ? `有${has.join("、")}` : "没有验证、风险、撤回三段"}${draft.added.length && has.length ? `，缺${draft.added.map((part) => PARTS[part]).join("、")}` : ""}` : "空"}。`,
    draft.added.length ? `补上了${draft.added.map((part) => PARTS[part]).join("、")}，整份描述的草稿如下；括号里的是要作者补的。给用户看过、按他的意思改好后，再用 update_pr 写回，baseVersion 传 ${draft.baseVersion}：` : `三段都已经有了，不用补。要改的话 baseVersion 传 ${draft.baseVersion}。`,
    ...(draft.added.length ? ["```markdown", draft.text, "```"] : []),
    `依据：${facts.join("；")}。只读，没有改动平台上的任何东西。`,
  ].join("\n");
  return reply(text, result, false);
};

export const runPrReview = async (input: z.input<typeof runReviewShape>, runtime: PrReviewRuntime) => {
  const request = prReviewRunToolRequestSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有开始评审", request.error);
  const { result, failure } = await asked((report) => runtime.runPrReview?.(request.data, report) ?? Promise.resolve(null));
  // Not known whether it started: a second call would start a second review.
  if (result === null) return reply(`没有确认评审是否开始：${runtimeFailureText(failure)}。先用 list_pr_reviews 看这个 PR 有没有新的进行中记录，不要直接重试。`, null, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") return reply(`没有开始评审：${connectionTrouble(result.status, result.connections, request.data.connection)}`, result, true);
  const models = result.models.map((model) => `「${model.label}」（id ${model.id}）`).join("、");
  if (result.status === "no_model") return reply("没有开始评审：Paraself 里还没有可用的模型，请用户先在 Paraself 的设置里添加。", result, true);
  if (result.status === "model_not_found") return reply(`没有开始评审：没有「${request.data.model}」这个模型。可用的：${models}。`, result, true);
  if (result.status === "busy" || result.status === "failed" || !result.run) return reply(`没有开始评审：${result.reason ?? "原因不明"}`, result, true);
  const run = result.run;
  const text = [
    `已开始评审 ${run.reference}「${run.title}」：第 ${run.round} 轮，${run.depth === "deep" ? "深度" : "标准"}评审，模型 ${run.model}${run.risk ? `，${PR_RISK_LABELS[run.risk]}` : ""}${run.since ? `，只看提交 ${run.since.slice(0, 12)} 之后的改动` : ""}。`,
    `记录 id ${run.id}。评审在 Paraself 里后台进行，评审页也能看到；用 get_pr_review 看它是否结束和结果，一般要几分钟，PR 大或深度评审更久。`,
    ...(run.round > ROUND_CAP ? [`这个 PR 之前已经评审了 ${run.round - 1} 轮。同类问题来回出现时，建议用户约作者当面谈，或请作者重新考虑方案。`] : []),
    "没有向 PR 发布任何东西：要发布哪些问题，由用户说了再用 record_pr_comments。",
  ].join("\n");
  return reply(text, result, false);
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
export const listPrComments = async (input: z.input<typeof commentsShape>, runtime: PrReviewRuntime) => {
  const request = prCommentsToolQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有读取意见", request.error);
  const { result, failure } = await asked((report) => runtime.listPrComments?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取意见：${runtimeFailureText(failure)}`, null, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") return reply(`没有读取意见：${connectionTrouble(result.status, result.connections, request.data.connection)}`, result, true);
  if (result.status === "failed" || !result.read) return reply(`没有读取意见：${result.reason ?? "原因不明"}`, result, true);
  const comments = result.read.comments;
  const answered = comments.filter((comment) => prCommentResponse(comment)).length;
  const fromParaself = comments.filter((comment) => prReviewMarkOf(comment.body)).length;
  const lines = comments.map((comment, index) => {
    const mark = prReviewMarkOf(comment.body), response = prCommentResponse(comment);
    const state = [comment.task === "open" ? "阻塞，未完成" : comment.task === "resolved" ? "阻塞，已完成" : null, comment.resolved === true ? "讨论已解决" : null].filter(Boolean).join("，");
    return [
      `${index + 1}. ${state ? `[${state}] ` : ""}${mark ? mark.priority : "人工"} ${prCommentTitle(comment.body)} — ${comment.author || "未知作者"}${mark ? ` · Paraself 预评审${mark.suggestion ? " · 个人经验，只作建议" : mark.basis ? ` · ${mark.basis}` : ""}` : ""}${comment.path ? ` · ${comment.path}${comment.line ? `:${comment.line}` : ""}` : ""}（意见 id ${comment.id}）`,
      `   去向：${response ? `已回复 ${PR_RESPONSE_LABELS[response.kind]} —— ${clip(response.words, 300)}` : "还没有，等用户决定"}`,
      `   正文：${clip(comment.body.replace(/\s+/gu, " ").trim(), 400)}`,
    ].join("\n");
  });
  const text = [
    comments.length ? `${request.data.reference} 收到 ${comments.length} 条意见，${answered} 条有去向${fromParaself ? `（${fromParaself} 条来自 Paraself 预评审）` : ""}。` : `${request.data.reference} 还没有别人的意见。`,
    ...lines,
    ...(result.read.more ? ["评论很多，只读了最近的十页。"] : []),
    ...(result.read.me === null ? ["没有认出令牌对应的账号：用户自己的回复认不出来，去向可能显示为还没有。"] : []),
    "每条意见都要有去向：不修（误报、有意为之、不处理）或转后续，用户说了怎么处理、为什么之后，用 update_pr_comment 回复。改代码不在这里。只读，没有改动平台上的任何东西。",
  ].join("\n");
  return reply(text, result, false);
};

export const updatePrComment = async (input: z.input<typeof updateCommentShape>, runtime: PrReviewRuntime) => {
  const request = prCommentUpdateToolSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有回复", request.error);
  const { result, failure } = await asked((report) => runtime.updatePrComment?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认回复是否发出：${runtimeFailureText(failure)}。先用 list_pr_comments 看这条意见的去向，不要直接重试。`, null, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") return reply(`没有回复：${connectionTrouble(result.status, result.connections, request.data.connection)}`, result, true);
  if (result.status !== "answered" || !result.result) return reply(`没有回复：${result.reason ?? "原因不明"}`, result, true);
  return reply(`${result.result.message}（${request.data.reference}，以用户的平台账号回复）`, result, false);
};

const AUTO_NOTE = "开着时，Paraself 每 30 分钟看一次待我评审的 PR：新的或有新提交的自动评审（高风险的用深度评审，之后只看新提交），一次一个，同一个 PR 第三轮之后不再自动评审。结果只在本机，不发到 PR 上。";
const settingsLine = (item: PrReviewSettingsItem) => `「${item.label}」（${item.platform}，id ${item.connectionId}）：${item.autoReview
  ? `自动预评审已开，模型 ${item.autoReview.model}，每天最多 ${item.autoReview.dailyReviews} 次，今天用了 ${item.usedToday} 次${item.usedToday >= item.autoReview.dailyReviews ? "，今天的额度用完了" : ""}。` : "自动预评审没开。"}`;

export const getPrReviewSettings = async (input: z.input<typeof settingsShape>, runtime: PrReviewRuntime) => {
  const request = prReviewSettingsQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有读取评审设置", request.error);
  const { result, failure } = await asked((report) => runtime.getPrReviewSettings?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取评审设置：${runtimeFailureText(failure)}`, null, true);
  if (result.status === "connection_not_found") return reply(`没有叫「${request.data.connection}」的连接。现有的连接：${result.connections.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有"}。`, result, true);
  const text = result.settings.length ? [...result.settings.map(settingsLine), AUTO_NOTE, "只读。"].join("\n") : "还没有连接代码平台：请用户先在 Paraself 的「链接」页添加。只读。";
  return reply(text, result, false);
};

export const updatePrReviewSettings = async (input: z.input<typeof updateSettingsShape>, runtime: PrReviewRuntime) => {
  const request = prReviewSettingsUpdateSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有改动评审设置", request.error);
  const { result, failure } = await asked((report) => runtime.updatePrReviewSettings?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认设置是否改动：${runtimeFailureText(failure)}。先用 get_pr_review_settings 看现在的设置。`, null, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") return reply(`没有改动评审设置：${connectionTrouble(result.status, result.connections, request.data.connection)}`, result, true);
  if (result.status === "model_not_found") return reply(`没有改动评审设置：${result.reason ?? `没有「${request.data.model}」这个模型`}。可用的：${result.models.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有"}。`, result, true);
  if (result.status !== "updated" || !result.settings) return reply(`没有改动评审设置：${result.reason ?? "原因不明"}`, result, true);
  return reply(`${request.data.autoReview ? "已打开" : "已关闭"}自动预评审。${settingsLine(result.settings)}${request.data.autoReview ? `\n${AUTO_NOTE}会花模型额度。` : ""}`, result, false);
};

export const updatePr = async (input: z.input<typeof updatePrShape>, runtime: PrReviewRuntime) => {
  const request = prUpdateRequestSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有写回 PR 描述", request.error);
  const { result, failure } = await asked((report) => runtime.updatePr?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认写回结果：${runtimeFailureText(failure)}。先用 get_pr_description_draft 看现在的描述是不是已经改了，不要直接重试。`, null, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") return reply(`没有写回 PR 描述：${connectionTrouble(result.status, result.connections, request.data.connection)}`, result, true);
  if (result.status === "changed") return reply(`没有写回：${result.reason} 用 get_pr_description_draft 重新读取，把要改的合进最新的描述，给用户确认后再写回。`, result, true);
  if (result.status === "failed") return reply(`没有写回 PR 描述：${result.reason}`, result, true);
  return reply(`${result.message}（${request.data.reference}，以用户的平台账号写回）`, result, false);
};

export const registerPrReviewTools = (server: McpServer, runtime: PrReviewRuntime): void => {
  server.registerTool("list_prs", {
    title: "List pull requests from the code platform",
    description:
      "List the user's pull requests on a code platform connection they set up in Paraself: waiting for their review (default), created by them, or merged. Each PR comes with its latest review or Q&A record in Paraself, if any: its state, risk level (by the files it changes, against the target branch's REVIEW.md), which round of review it was and how many findings. Reads the platform with the user's token; changes nothing there. Read-only.",
    inputSchema: listPrsShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => listPrs(input, runtime));
  server.registerTool("list_pr_reviews", {
    title: "List PR review records",
    description:
      "List the PR review and Q&A records Paraself keeps, newest first: for one PR (owner/repo#12), one repository (owner/repo), or all. Each with its state, risk level, round, findings by priority and how many were posted as PR comments. Read-only.",
    inputSchema: listReviewsShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => listPrReviews(input, runtime));
  server.registerTool("get_pr_review", {
    title: "Read one PR review record",
    description:
      "Read one PR review record: the PR, commit and target branch, its risk level and why, the repository guides read from the target branch (REVIEW.md, CLAUDE.md, AGENTS.md) and local review rules, the conclusion, and each finding with its location, body and basis: a repository rule (the author can be asked to follow it), a personal basis (the user's own decisions or local rules: a suggestion only, never a demand on the author), or the code alone; with its re-evaluation, the user's own 不采纳 and its reason, and whether it was posted. Also the candidates left to check, and the questions asked about it. The findings are an AI's drafts: not tested, not an approval. Read-only.",
    inputSchema: getReviewShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => getPrReview(input, runtime));
  server.registerTool("run_pr_review", {
    title: "Start a Paraself review of a PR",
    description:
      "Start a review of a PR in Paraself, as the review page's 开始评审 does: the PR is read fresh from its code platform and reviewed in the App, in the background, with a model the user configured, against the target branch's REVIEW.md and guides, the user's decisions and local review rules, and what earlier reviews of the repository were told not to raise. A later round reviews only what the commits since the last review changed, unless scope is all. Returns at once with the record's id; get_pr_review shows its progress and, once done, its findings. It spends model calls for minutes: start it only when the user asks for a review, never on your own. One review runs at a time. It posts nothing to the PR: findings go out only with record_pr_comments, as the user says.",
    inputSchema: runReviewShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (input) => runPrReview(input, runtime));
  server.registerTool("update_pr_review_finding", {
    title: "Dismiss a PR review finding, or take that back",
    description:
      "Mark one finding of a PR review record as not taken (不采纳) with the user's reason, or take that back (撤回): what the review page's buttons do. Later reviews of the same repository are told of a dismissed finding and its reason, so they do not raise its like again. Use only when the user says so, never to tidy up. A finding already posted to the PR cannot be dismissed. Changes only the record in Paraself, nothing on the code platform.",
    inputSchema: updateFindingShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => updatePrReviewFinding(input, runtime));
  server.registerTool("get_pr_description_draft", {
    title: "Draft a PR's description: verification, risk, rollback",
    description:
      "Read a PR's description from its code platform and draft the parts the team's PR template asks for that it lacks: 验证 (what was checked, the build, Paraself's review), 风险 (the risk level by the files it changes against the target branch's REVIEW.md, and the modules it touches) and 撤回 (how to undo it and what cannot be undone, from the latest PR overview). What the author wrote stays; parts in brackets are for the author to fill in. Returns the whole draft and the version to write over with update_pr. Read-only.",
    inputSchema: descriptionDraftShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => getPrDescriptionDraft(input, runtime));
  server.registerTool("update_pr", {
    title: "Write a PR's description back",
    description:
      "Write a PR's description back to its code platform, with the user's account, over the version get_pr_description_draft read: refused when the description changed since. This writes to the team's code platform: call it only after the user has seen and confirmed the exact text, never on your own. It changes the description only: approving and merging are not tools, an AI's approval is no one's.",
    inputSchema: updatePrShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (input) => updatePr(input, runtime));
  server.registerTool("record_pr_comments", {
    title: "Post PR review findings to the PR",
    description:
      `Post chosen findings of a PR review record to its PR as line comments, with the user's platform account, pinned to the commits that review read: refused once the PR has new commits. This writes to the team's code platform: call it only when the user has said which findings to post (and, if they want, in what words), never on your own. Each comment ends with a line saying it came from Paraself's pre-review and what it stands on. A blocking one is a task on Bitbucket, which its "no open tasks" merge check holds on; GitHub and GitLab have no tasks, so there it is an ordinary comment, which blocks only where the repository requires discussions resolved. A finding resting only on the user's own decisions or local rules is a suggestion and cannot be blocking. Posts one after another and stops at the first failure; one already posted is never posted again. At most ${PR_COMMENTS_PER_CALL} per call. Approving and merging are not tools: an AI's approval is no one's.`,
    inputSchema: recordCommentsShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => recordPrComments(input, runtime));
  server.registerTool("get_pr_review_settings", {
    title: "Read PR review settings",
    description: "Read each code platform link's 自动预评审 (automatic pre-review): on or off, the model, the reviews a day at most and how many it started today. When on, Paraself reviews the PRs waiting for the user's review as they come in, new or with new commits, one at a time and never past a PR's third round; the results stay in Paraself, nothing is posted to the PR. Read-only.",
    inputSchema: settingsShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => getPrReviewSettings(input, runtime));
  server.registerTool("update_pr_review_settings", {
    title: "Turn automatic pre-review on or off",
    description: "Turn a link's 自动预评审 (automatic pre-review) on, with a model and a daily limit of reviews, or off. It spends model calls every day it is on: change it only when the user asks, never on your own. It changes Paraself's settings only; nothing on the code platform.",
    inputSchema: updateSettingsShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => updatePrReviewSettings(input, runtime));
  server.registerTool("list_pr_comments", {
    title: "List the comments on the user's own PR",
    description:
      "List the comments others left on one of the user's own PRs, people's and Paraself pre-reviews', each with where it is, whether it is a blocking task and done, what it stands on (a Paraself pre-review's closing line), and what the user answered with a standard reply (已修, 误报, 有意为之, 不处理, 转后续), if anything. Every comment is to get an answer. Reads the code platform with the user's token. Read-only.",
    inputSchema: commentsShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => listPrComments(input, runtime));
  server.registerTool("update_pr_comment", {
    title: "Answer a comment on the user's own PR",
    description:
      "Answer one comment on the user's own PR with a standard reply in its thread, with the user's platform account: wrong (误报), intended (有意为之) or wontfix (不处理), each with the user's reason; or later (转后续), which first adds a todo to the user's 「PR 后续」 list for the repository and names it in the reply. This writes to the team's code platform: call it only after the user has said what to do with that comment and why, never on your own. A comment answered already is not answered again. Fixing the code is not this tool.",
    inputSchema: updateCommentShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => updatePrComment(input, runtime));
};
