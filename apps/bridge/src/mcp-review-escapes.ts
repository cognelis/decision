import type { McpServer } from "@modelcontextprotocol/server";
import {
  PR_REVIEW_TOOLS_VERSION,
  REVIEW_ESCAPE_CHANGES,
  REVIEW_ESCAPE_KINDS,
  REVIEW_ESCAPE_LAYERS,
  reviewEscapeRecordSchema,
  reviewEscapesQuerySchema,
  reviewEscapeUpdateSchema,
  type ReviewEscape,
  type ReviewEscapeRecord,
  type ReviewEscapeRecordResult,
  type ReviewEscapesQuery,
  type ReviewEscapesResult,
  type ReviewEscapeUpdate,
  type ReviewEscapeUpdateResult,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import { inputReasons } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/**
 * 漏网复盘 for agents: the merged PRs a later revert or fix showed review let through, each with its four lines; one the
 * user names recorded, the four lines written, dismissed, or made a defect benchmark candidate, when the user says so.
 */
export interface ReviewEscapeRuntime {
  recordReviewEscape?(input: ReviewEscapeRecord, report?: RuntimeFailureReport): Promise<ReviewEscapeRecordResult | null>;
  listReviewEscapes?(input: ReviewEscapesQuery, report?: RuntimeFailureReport): Promise<ReviewEscapesResult | null>;
  updateReviewEscape?(input: ReviewEscapeUpdate, report?: RuntimeFailureReport): Promise<ReviewEscapeUpdateResult | null>;
}

const connection = z.string().optional().describe("The code platform link, by id or label; left out when there is only one.");
const writeupShape = z.object({
  problem: z.string().describe("What the problem was, in a line."),
  layer: z.enum(["self_review", "pre_review", "human_review", "ci", "other"]).describe("Which layer should have stopped it: the author's self-review, Paraself's pre-review, people's review, CI and tests, or other."),
  why: z.string().describe("Why it did not."),
  change: z.enum(["rule", "prompt", "check", "norm"]).describe("Where the change goes: a review rule, the review prompt, a check (lint, test, CI), or a team norm."),
  changeText: z.string().optional().describe("What to change there, in a line."),
});
const recordShape = z.object({
  connection,
  reference: z.string().describe("The merged PR that let the problem through, as the platform names it: owner/repo#12, PROJECT/repo#12."),
  by: z.string().describe("What showed it: the PR that fixed or reverted it (owner/repo#15, or #15 in the same repository), or the fixing commit's full hash."),
  kind: z.enum(["revert", "fix"]).optional().describe("fix (default) or revert."),
  writeup: writeupShape.optional().describe("The four lines, when the user gave them."),
});
const listShape = z.object({ connection, state: z.enum(["open", "written", "dismissed"]).optional().describe("open: still to write; written; dismissed as no escape. Left out: all.") });
const updateShape = z.object({
  id: z.string().describe("The escape's id, from list_review_escapes."),
  action: z.enum(["write", "dismiss", "reopen", "add_to_benchmark"]).describe("write: its four lines (writeup); dismiss: not an escape, with reason; reopen; add_to_benchmark: a defect benchmark candidate from where the problem sat (location), once written."),
  writeup: writeupShape.optional(),
  reason: z.string().optional().describe("Why it is no escape (dismiss)."),
  location: z.object({ path: z.string(), startLine: z.number().int(), endLine: z.number().int().optional() }).optional().describe("Where the problem sat in the PR, as it left the file (add_to_benchmark)."),
  priority: z.enum(["P1", "P2", "P3"]).optional().describe("The problem's priority as a benchmark issue; P2 when left out."),
});

const reply = (text: string, reviewEscape: unknown, isError: boolean) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text }],
  structuredContent: { message: text, reviewEscape },
});
const asked = async <T>(ask: ((report: RuntimeFailureReport) => Promise<T | null>) | undefined): Promise<{ result: T | null; failure: RuntimeFailure }> => {
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = await ask?.((reported) => { failure = reported; }).catch(() => null) ?? null;
  return { result, failure };
};
const RULES = { "写复盘要给四行。": "写复盘要用 writeup 给出四行", "不是漏网要写明理由。": "dismiss 要在 reason 里写明理由", "加入评测集要给问题所在的位置。": "add_to_benchmark 要用 location 给出问题所在的位置" } as const;
const refused = (what: string, error: z.ZodError) => reply(`${what}：输入不符合要求（${inputReasons(error, RULES)}）。`, null, true);
const listed = (connections: ReadonlyArray<{ id: string; label: string }>) => connections.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有";
const STATES = { open: "待写", written: "已写", dismissed: "不是漏网" } as const;

export const escapeText = (escape: ReviewEscape) => [
  `${escape.id} · ${escape.reference}「${escape.title}」· ${STATES[escape.state]}：${REVIEW_ESCAPE_KINDS[escape.by.kind] === "用户说的" ? "用户说" : ""}合并后被 ${escape.by.reference}${escape.by.title ? `「${escape.by.title}」` : ""}${escape.by.kind === "revert" ? "回滚" : "修复"}`,
  ...(escape.writeup ? [`  问题：${escape.writeup.problem}`, `  本该拦住的一层：${REVIEW_ESCAPE_LAYERS[escape.writeup.layer]}`, `  为什么没拦住：${escape.writeup.why}`,
    `  改在哪里：${REVIEW_ESCAPE_CHANGES[escape.writeup.change]}${escape.writeup.changeText ? `，${escape.writeup.changeText}` : ""}`] : []),
  ...(escape.dismissed ? [`  不是漏网：${escape.dismissed}`] : []),
  ...(escape.benchmarkCase ? [`  已是评测集样本 ${escape.benchmarkCase}（候选，用户核对后才入集）`] : []),
].join("\n");

export const recordReviewEscape = async (input: z.input<typeof recordShape>, runtime: ReviewEscapeRuntime) => {
  const request = reviewEscapeRecordSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有记下漏网", request.error);
  const { result, failure } = await asked((report) => runtime.recordReviewEscape?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认是否记下了漏网：${runtimeFailureText(failure)}。先用 list_review_escapes 看看，不要直接重试。`, null, true);
  if (result.status === "connection_not_found" || result.status === "connection_needed") return reply(`没有记下漏网：${result.status === "connection_needed" ? "有不止一个代码平台连接，要用 connection 指明" : `没有叫「${request.data.connection}」的连接`}。现有的连接：${listed(result.connections)}。`, result, true);
  if (result.status === "exists") return reply(`已经记过这个漏网，没有重复记：\n${escapeText(result.escape!)}`, result, false);
  if (result.status !== "recorded" || !result.escape) return reply(`没有记下漏网：${result.reason ?? "原因不明"}`, result, true);
  return reply(`已记下漏网：\n${escapeText(result.escape)}${result.escape.writeup ? "" : "\n复盘的四行等用户说了再用 update_review_escape 写。"}`, result, false);
};

export const listReviewEscapes = async (input: z.input<typeof listShape>, runtime: ReviewEscapeRuntime) => {
  const request = reviewEscapesQuerySchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有列出漏网复盘", request.error);
  const { result, failure } = await asked((report) => runtime.listReviewEscapes?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有列出漏网复盘：${runtimeFailureText(failure)}`, null, true);
  if (result.status !== "ok") return reply(`没有列出漏网复盘：${result.status === "connection_needed" ? "有不止一个代码平台连接，要用 connection 指明" : `没有叫「${request.data.connection}」的连接`}。现有的连接：${listed(result.connections)}。`, result, true);
  const text = result.escapes.length ? [`漏网复盘 ${result.escapes.length} 条：`, ...result.escapes.map(escapeText), "只读。"].join("\n")
    : "没有漏网复盘。合并后被回滚、或被后来的 PR 修复的 PR，打开评审质量时会被找出来。只读。";
  return reply(text, result, false);
};

export const updateReviewEscape = async (input: z.input<typeof updateShape>, runtime: ReviewEscapeRuntime) => {
  const request = reviewEscapeUpdateSchema.safeParse({ prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, ...input });
  if (!request.success) return refused("没有改动漏网复盘", request.error);
  const { result, failure } = await asked((report) => runtime.updateReviewEscape?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认漏网复盘是否改动：${runtimeFailureText(failure)}。先用 list_review_escapes 看看。`, null, true);
  if (result.status !== "updated" || !result.escape) return reply(`没有改动漏网复盘：${result.reason ?? "原因不明"}`, result, true);
  const done = { write: "已写好复盘", dismiss: "已记为不是漏网", reopen: "已重新打开", add_to_benchmark: "已加入评测集的候选样本（用户核对后才入集）" }[request.data.action];
  return reply(`${done}：\n${escapeText(result.escape)}`, result, false);
};

export const registerReviewEscapeTools = (server: McpServer, runtime: ReviewEscapeRuntime): void => {
  server.registerTool("record_review_escape", {
    title: "Record a review escape",
    description: "Record a 漏网 (a problem review let through): a merged PR a later PR or commit fixed or reverted, as the user names it, with its four lines if they gave them. Paraself also finds them by itself among the merged PRs when 评审质量 is read. Only when the user asks. Changes only Paraself's records.",
    inputSchema: recordShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, (input) => recordReviewEscape(input, runtime));
  server.registerTool("list_review_escapes", {
    title: "List review escapes",
    description: "List a link's 漏网复盘: merged PRs a later revert or fix showed review let through, each with its four lines (the problem, which layer should have stopped it, why it did not, where the change goes) once written, or why it was dismissed. Read-only.",
    inputSchema: listShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => listReviewEscapes(input, runtime));
  server.registerTool("update_review_escape", {
    title: "Write or settle a review escape",
    description: "When the user says so: write an escape's four lines, dismiss it as no escape with their reason, open it again, or make it a defect benchmark candidate from where the problem sat (needs the four lines, a Paraself review of the PR and its repository added in 本地审阅). A candidate is confirmed into the benchmark only after the user checks it.",
    inputSchema: updateShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => updateReviewEscape(input, runtime));
};
