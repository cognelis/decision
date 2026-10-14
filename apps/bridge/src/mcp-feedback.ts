import type { McpServer } from "@modelcontextprotocol/server";
import { decisionFeedbackUpdateSchema, decisionFeedbackUpdateResultSchema, decisionFeedbackQuerySchema, decisionFeedbackResponseSchema, type DecisionFeedbackUpdate, type DecisionFeedbackUpdateResult, type DecisionFeedbackQuery, type DecisionFeedbackResponse } from "@cognelis/decision-protocol";
import { runtimeFailureText, unsavedText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";
export interface DecisionFeedbackRuntime {
  saveDecisionContextFeedback?(input: DecisionFeedbackUpdate, report?: RuntimeFailureReport): Promise<DecisionFeedbackUpdateResult | null>;
  getDecisionContextFeedback?(input: DecisionFeedbackQuery, report?: RuntimeFailureReport): Promise<DecisionFeedbackResponse | null>;
}
// In the words of the App's feedback panel: the enums, and the counts as JSON, ran on inside the Chinese. The raw
// values stay in structuredContent.
const ratings = { helpful: "确实有帮助", not_applicable: "相关但不适用", insufficient_context: "信息不足", irrelevant: "与任务无关" };
const sourceStates = { current: "当前原文版本", changed: "对应旧版原文", missing: "原文已缺失", unavailable: "原文暂不可核对" };
const coverages = { complete: "完整", partial: "不完整，数量只是已读到的观察", unavailable: "无法读取" };
const notSaved = {
  source_changed: "原决策笔记已改变，请重新读取来源的内容版本后核对。",
  source_unavailable: "来源未能完整读取，请检查原笔记是否缺失、重复或损坏。",
  revision_conflict: "这条反馈已有更新的版本，或撤回时改动了原反馈的任务、对象或评价；请用 get_decision_context_feedback 重新读取后核对。",
  feedback_unavailable: "这条反馈的记录现在无法可靠读取，请稍后用 get_decision_context_feedback 核对。",
  feedback_not_found: "没有找到要撤回的这条反馈，请用 get_decision_context_feedback 核对 feedbackId。",
};
const tally = (counts: Record<keyof typeof ratings, number>): string =>
  (Object.keys(ratings) as Array<keyof typeof ratings>).map((rating) => `${ratings[rating]} ${counts[rating]}`).join("，");
export const registerDecisionFeedbackTools = (server: McpServer, runtime: DecisionFeedbackRuntime): void => {
  server.registerTool("record_decision_context_feedback", {
    title: "Record explicit feedback on historical decision use",
    description: "Only when the user explicitly asks to record their experience with a retrieved decision, save helpful, not_applicable, insufficient_context or irrelevant feedback for a concrete task. First read the exact source and current content hash; pass reference with source, recordId and expectedContentHash. Include the user's task, judgment and reason; optional project/taskScope describe that task. Never fabricate a positive rating from tests passing or infer permanent scope from a task-specific mismatch. Generate a new UUID feedbackId and expectedRevision=0 for each new observation. Preserve that ID and request across uncertain retries; read get_decision_context_feedback before retrying. Corrections reuse the ID and current revision; target source/ID cannot change. To withdraw, copy the existing record's fields and source anchor, set withdrawn=true, update reason and expectedRevision; withdrawal works after source disappearance. Revisions retain bounded history. Feedback is separate metadata; no decisions, scope, relationships, outcomes or ranking are changed.",
    inputSchema: decisionFeedbackUpdateSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    let failure = { reason: "not_running" } as RuntimeFailure;
    const response = await runtime.saveDecisionContextFeedback?.(decisionFeedbackUpdateSchema.parse(input), (reported) => {
      failure = reported;
    }).catch(() => null);
    const result = response == null ? null : decisionFeedbackUpdateResultSchema.parse(response);
    const saved = result?.status === "saved" || result?.status === "unchanged";
    const text = result === null ? unsavedText(failure, "使用反馈", "请按来源重新读取反馈，保留原 feedbackId 核对后再重试。") : saved ? `使用反馈已记录，版本 ${result.revision}；未修改决策或适用范围。` : `使用反馈未保存：${notSaved[result.status as keyof typeof notSaved]}`;
    // Claude Code shows a model only the structuredContent of a result that has one: what the text tells it goes there too.
    return { ...(saved ? {} : { isError: true }), content: [{ type: "text" as const, text }], structuredContent: { message: text, feedbackUpdate: result } };
  });
  server.registerTool("get_decision_context_feedback", {
    title: "Read and summarize task-specific decision feedback",
    description: "Read explicit historical decision-use feedback with revisions, source-version status, counts and pagination. To filter a record provide both source and recordId. Optional project filters the task's recorded project; omitted project spans projects. includeWithdrawn exposes withdrawn feedback and history. Counts use the latest revision of each feedbackId and exclude withdrawn ratings; currentSourceRatings also excludes changed, missing or unreadable source versions. Partial coverage is not a complete evaluation; counts are observations, not accuracy or proof of benefit. Never automatically turn feedback into permanent scope, replacements or search ranking changes.",
    inputSchema: decisionFeedbackQuerySchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => {
    let failure = { reason: "not_running" } as RuntimeFailure;
    const response = await runtime.getDecisionContextFeedback?.(decisionFeedbackQuerySchema.parse(input), (reported) => {
      failure = reported;
    }).catch(() => null);
    const result = response == null ? null : decisionFeedbackResponseSchema.parse(response);
    const unavailable = `${runtimeFailureText(failure)}使用反馈没有读到；不能据此认为没有反馈。`;
    return { ...(result === null || result.coverage === "unavailable" ? { isError: true } : {}), content: [{ type: "text" as const, text: result === null ? unavailable : [result.guidance, `覆盖：${coverages[result.coverage]}；未撤回 ${result.activeCount} 条，已撤回 ${result.withdrawnCount} 条。`, `全部反馈评价：${tally(result.ratings)}；其中当前原文版本：${tally(result.currentSourceRatings)}。`, ...result.results.map(({ record, sourceState, relativePath }) => `${record.feedbackId} · ${record.reference.source}/${record.reference.recordId} · 版本 ${record.revision}${record.withdrawn ? "（已撤回）" : ""}\n任务：${record.task}\n评价：${ratings[record.rating]}；来源状态：${sourceStates[sourceState]}\n理由：${record.reason}\n记录：${relativePath}`), ...(result.nextOffset === null ? [] : [`下一页 offset=${result.nextOffset}，保留其余筛选。`])].join("\n\n") }], structuredContent: { ...(result === null ? { message: unavailable } : {}), feedback: result } };
  });
};
