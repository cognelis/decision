import type { McpServer } from "@modelcontextprotocol/server";
import { PR_REVIEW_TOOLS_VERSION, reviewPromotionsQuerySchema, type ReviewPromotion, type ReviewPromotionsQuery, type ReviewPromotionsResult } from "@cognelis/decision-protocol";
import { z } from "zod";

import { inputReasons } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/** 晋升提议 for agents: rules that live only in the user's Paraself which review keeps needing, to propose for REVIEW.md. */
export interface ReviewPromotionRuntime {
  listRulePromotionCandidates?(input: ReviewPromotionsQuery, report?: RuntimeFailureReport): Promise<ReviewPromotionsResult | null>;
}

const listShape = z.object({ connection: z.string().optional().describe("The code platform link, by id or label; left out when there is only one.") });
const reply = (text: string, rulePromotions: unknown, isError: boolean) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text }],
  structuredContent: { message: text, rulePromotions },
});
const KIND = { decision: "决策", local_rule: "本机规则", escape: "漏网复盘" } as const;

export const promotionText = (item: ReviewPromotion) => [
  `- ${KIND[item.kind]}「${item.title}」→ ${item.repository} 的 REVIEW.md${item.proposed ? `（已交给本地审阅，任务 ${item.proposed.jobId}）` : ""}`,
  `  ${item.signals.join("；")}`,
  `  例子：${item.evidence.map((evidence) => `${evidence.reference}「${evidence.title}」（${evidence.outcome}）`).join("；")}`,
  `  草稿：${item.draft}`,
].join("\n");

export const listRulePromotionCandidates = async (input: z.input<typeof listShape>, runtime: ReviewPromotionRuntime) => {
  const request = reviewPromotionsQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return reply(`没有列出晋升提议：输入不符合要求（${inputReasons(request.error, {})}）。`, null, true);
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = await runtime.listRulePromotionCandidates?.(request.data, (reported) => { failure = reported; }).catch(() => null) ?? null;
  if (result === null) return reply(`没有列出晋升提议：${runtimeFailureText(failure)}`, null, true);
  if (result.status !== "ok") {
    const listed = result.connections.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有";
    return reply(`没有列出晋升提议：${result.status === "connection_needed" ? "有不止一个代码平台连接，要用 connection 指明" : `没有叫「${request.data.connection}」的连接`}。现有的连接：${listed}。`, result, true);
  }
  const text = result.promotions.length ? [
    `晋升提议 ${result.promotions.length} 条：只在 Paraself 里的规则，评审一再用到，适合写进仓库的 REVIEW.md，让作者和大家的评审都看得到。`,
    ...result.promotions.map(promotionText),
    "要提议时，用户在 Paraself 评审质量页点“提议写进 REVIEW.md”（交给本地审阅改文件，确认后才推送开 PR）；或在用户同意后用 record_local_review_job 把草稿作为 REVIEW.md 上的意见交给本地审阅。只读。",
  ].join("\n") : "还没有晋升提议：同一条个人规则在两个以上 PR 的意见里出现、依据它的 P1 被修了、作者回复仓库里没有这条规则，或漏网复盘说要改规则时，会列在这里。只读。";
  return reply(text, result, false);
};

export const registerReviewPromotionTools = (server: McpServer, runtime: ReviewPromotionRuntime): void => {
  server.registerTool("list_rule_promotion_candidates", {
    title: "List rule promotion proposals",
    description: "List 晋升提议: the user's own rules (decisions, local review rules) that review keeps needing, with what says so (findings in two PRs or more, a fixed P1, an author answering the repository has no such rule) and escapes whose write-up says the change goes into a rule; each with its examples and a draft line for the repository's REVIEW.md. Proposing one is the user's: in the App, or by handing the draft to the local review with record_local_review_job once they agree. Read-only.",
    inputSchema: listShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => listRulePromotionCandidates(input, runtime));
};
