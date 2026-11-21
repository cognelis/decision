import type { McpServer } from "@modelcontextprotocol/server";
import {
  PR_REVIEW_TOOLS_VERSION,
  REVIEW_BASIS_ROW_LABELS,
  reviewQualityQuerySchema,
  reviewRuleUpdateSchema,
  type ReviewNoisyRule,
  type ReviewQualityQuery,
  type ReviewQualityResult,
  type ReviewRuleUpdate,
  type ReviewRuleUpdateResult,
  type ReviewTeamWindow,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import { inputReasons } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/**
 * 评审质量 for agents (docs/review-collaboration-design.md「评审改进回路」): what became of the findings posted, which
 * rules authors keep calling wrong, and the team's own figures from the code platform; and one of Paraself's own local
 * review rules turned off or on, when the user says so.
 */
export interface ReviewQualityRuntime {
  getReviewQuality?(input: ReviewQualityQuery, report?: RuntimeFailureReport): Promise<ReviewQualityResult | null>;
  updateReviewRule?(input: ReviewRuleUpdate, report?: RuntimeFailureReport): Promise<ReviewRuleUpdateResult | null>;
}

const qualityShape = z.object({ connection: z.string().optional().describe("The code platform link, by id or label; left out when there is only one.") });
const ruleShape = z.object({
  rule: z.string().describe("The rule's file in Paraself's rules directory, as get_review_quality names it (list-pagination.md)."),
  enabled: z.boolean().describe("false: turn it off, later reviews no longer use it; true: on again."),
});

const reply = (text: string, reviewQuality: unknown, isError: boolean) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text }],
  structuredContent: { message: text, reviewQuality },
});
const asked = async <T>(ask: ((report: RuntimeFailureReport) => Promise<T | null>) | undefined): Promise<{ result: T | null; failure: RuntimeFailure }> => {
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = await ask?.((reported) => { failure = reported; }).catch(() => null) ?? null;
  return { result, failure };
};
const refused = (what: string, error: z.ZodError) => reply(`${what}：输入不符合要求（${inputReasons(error, {})}）。`, null, true);

const figure = (value: number | null, unit = "") => (value === null ? "—" : `${value}${unit}`);
const windowLine = (now: ReviewTeamWindow, before: ReviewTeamWindow) => [
  `${now.prs} 个已合并的 PR（之前 30 天 ${before.prs} 个）`,
  `每个 PR 的人工批准 ${figure(now.approvalsPerPr)}（之前 ${figure(before.approvalsPerPr)}）`,
  `人工评论 ${figure(now.humanCommentsPerPr, " 条")}（之前 ${figure(before.humanCommentsPerPr, " 条")}）`,
  `等人批准的中位 ${figure(now.waitHours, " 小时")}（之前 ${figure(before.waitHours, " 小时")}）`,
  `回滚 ${now.rollbacks}（之前 ${before.rollbacks}）`,
  `漏网 ${now.escapes}（之前 ${before.escapes}）`,
].join("，");
const ruleLine = (rule: ReviewNoisyRule) => `- ${rule.kind === "decision" ? `决策「${rule.title}」（id ${rule.id}）` : `${rule.source === "decision" ? "Paraself" : "code-meeseeks"} 本机规则 ${rule.id}`}：作者答复过的 ${rule.settled} 条里说错了 ${rule.wrong}、无所谓 ${rule.wontfix}，涉及 ${rule.prs} 个 PR。${rule.words.length ? `作者说：${rule.words.join("；")}` : ""}`;

export const getReviewQuality = async (input: z.input<typeof qualityShape>, runtime: ReviewQualityRuntime) => {
  const request = reviewQualityQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有读取评审质量", request.error);
  const { result, failure } = await asked((report) => runtime.getReviewQuality?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取评审质量：${runtimeFailureText(failure)}`, null, true);
  if (!result.quality) {
    const listed = result.connections.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有";
    return reply(`没有读取评审质量：${result.status === "connection_needed" ? "有不止一个代码平台连接，要用 connection 指明" : `没有叫「${request.data.connection}」的连接`}。现有的连接：${listed}。`, result, true);
  }
  const { label, days, team, outcomes, noise, escapes } = result.quality;
  const open = escapes.filter((item) => item.state === "open").length;
  const text = [
    `「${label}」近 ${days} 天的评审质量（只用代码平台和本机记录，不收集同学的使用数据）：`,
    `团队：${windowLine(team.current, team.previous)}。${team.unread ? `还有 ${team.unread} 个 PR 没读到，下次读取时接着读。` : ""}${team.error ? `读平台时出错：${team.error}` : ""}`,
    `已发布意见的结果 · ${outcomes.total} 条：`,
    ...outcomes.rows.map((row) => `- ${REVIEW_BASIS_ROW_LABELS[row.basis]}：发布 ${row.published}，修了 ${row.fixed}，说错了 ${row.wrong}，有意为之 ${row.intended}，无所谓 ${row.wontfix}，转后续 ${row.later}，未回应 ${row.none}`),
    `${outcomes.maybeFixed ? `原位置之后被改过、作者没回复的“可能修了”另有 ${outcomes.maybeFixed} 条，不计入上面。` : ""}结果来自作者的标准回复。`,
    ...(noise.length ? ["常被说错或说无所谓的规则（改写或停用前先问用户）：", ...noise.map(ruleLine)] : ["没有常被说错的规则。"]),
    ...(escapes.length ? [`漏网复盘 ${escapes.length} 条${open ? `，${open} 条待写` : ""}：用 list_review_escapes 看。`] : []),
    ...(result.quality.promotions.length ? [`晋升提议 ${result.quality.promotions.length} 条：用 list_rule_promotion_candidates 看。`] : []),
    "只读。",
  ].join("\n");
  return reply(text, result, false);
};

export const updateReviewRule = async (input: z.input<typeof ruleShape>, runtime: ReviewQualityRuntime) => {
  const request = reviewRuleUpdateSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  const what = input.enabled === false ? "没有停用规则" : "没有启用规则";
  if (!request.success) return refused(what, request.error);
  const { result, failure } = await asked((report) => runtime.updateReviewRule?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`${what}：${runtimeFailureText(failure)}`, null, true);
  if (result.status !== "updated") return reply(`${what}：${result.reason ?? "原因不明"}`, result, true);
  return reply(request.data.enabled ? `已重新启用 Paraself 评审规则 ${request.data.rule}：之后的评审照常用它。` : `已停用 Paraself 评审规则 ${request.data.rule}：之后的评审不再用它，文件还在，可以再启用。`, result, false);
};

export const registerReviewQualityTools = (server: McpServer, runtime: ReviewQualityRuntime): void => {
  server.registerTool("get_review_quality", {
    title: "Read review quality",
    description: "Read 评审质量 for a code platform link, over the last 30 days against the 30 before: the team's figures from the platform (people's approvals and comments per merged PR, the median wait for a person's approval, reverts), what became of the findings Paraself posted by what they stood on (a repository rule, the user's own decisions and local rules, or the code alone), and the rules whose findings authors keep calling wrong or not worth it. The first read of a link reads its merged PRs from the platform, twenty at a time. Read-only.",
    inputSchema: qualityShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => getReviewQuality(input, runtime));
  server.registerTool("update_review_rule", {
    title: "Turn a local review rule off or on",
    description: "Turn one of Paraself's own local review rules off (enabled: false in its file), or on again. Only when the user asks, typically for a rule get_review_quality says authors keep calling wrong; the file stays and can be turned on again. Rules of other tools (code-meeseeks) are theirs to change.",
    inputSchema: ruleShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => updateReviewRule(input, runtime));
};
