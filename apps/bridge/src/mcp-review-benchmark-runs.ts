import type { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import {
  REVIEW_BENCHMARK_VERSION,
  reviewBenchmarkRunQuerySchema,
  reviewBenchmarkRunRequestSchema,
  reviewBenchmarkRunsQuerySchema,
  type ReviewBenchmarkComparison,
  type ReviewBenchmarkRunCase,
  type ReviewBenchmarkRunQuery,
  type ReviewBenchmarkRunRequest,
  type ReviewBenchmarkRunResult,
  type ReviewBenchmarkRunsQuery,
  type ReviewBenchmarkRunsResult,
  type ReviewBenchmarkRunStart,
  type ReviewBenchmarkRunSummary,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import { inputReasons } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/**
 * 评测运行 for agents: the confirmed cases of a repository reviewed again in the App, as it reviews now, scored by set;
 * runs listed, and one read with how it compares with the one before it. Judging a clean finding harmful and adopting
 * a change are the user's, in the App.
 */
export interface ReviewBenchmarkRunRuntime {
  runReviewBenchmark?(input: ReviewBenchmarkRunRequest, report?: RuntimeFailureReport): Promise<ReviewBenchmarkRunStart | null>;
  listReviewBenchmarkRuns?(input: ReviewBenchmarkRunsQuery, report?: RuntimeFailureReport): Promise<ReviewBenchmarkRunsResult | null>;
  getReviewBenchmarkRun?(input: ReviewBenchmarkRunQuery, report?: RuntimeFailureReport): Promise<ReviewBenchmarkRunResult | null>;
}

const repository = z.string().optional().describe("The local Git repository whose cases to run: an absolute path to it or any directory in it. Default: the directory the MCP server was started in.");
const runShape = z.object({
  repositoryPath: repository,
  label: z.string().describe("What changed since the run this will be compared with, in a line: the prompt, the model, a rule (本机规则「列表接口都要分页」改为只管返回超过 100 条的列表)."),
  split: z.enum(["holdout", "dev"]).optional().describe("holdout (default): the cases a change is judged on, whose answers stay hidden; dev: the ones to tune against."),
  set: z.enum(["defect", "clean"]).optional().describe("Only one set; left out, both."),
  model: z.string().optional().describe("The model, by an id or label the answer lists; left out, the first that writes."),
  fixControl: z.boolean().optional().describe("Also review each defect case's fixed version, to see an issue fixed is not said again (修复对照). Doubles the defect set's calls."),
});
const listShape = z.object({ repositoryPath: repository });
const getShape = z.object({
  id: z.string().describe("The run's id, from run_review_benchmark or list_review_benchmark_runs."),
  compareTo: z.string().optional().describe("Another run to compare with; left out, the last finished run of the same repository and split before it."),
});

const reply = (text: string, reviewBenchmarkRun: unknown, isError: boolean) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text }],
  structuredContent: { message: text, reviewBenchmarkRun },
});
const asked = async <T>(ask: ((report: RuntimeFailureReport) => Promise<T | null>) | undefined): Promise<{ result: T | null; failure: RuntimeFailure }> => {
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = await ask?.((reported) => { failure = reported; }).catch(() => null) ?? null;
  return { result, failure };
};
const refused = (what: string, error: z.ZodError) => reply(`${what}：输入不符合要求（${inputReasons(error, {})}）。`, null, true);
const SPLIT = { holdout: "留出集", dev: "开发集" } as const;
const STATE = { running: "进行中", finished: "已跑完", failed: "失败", cancelled: "已取消", interrupted: "已中断" } as const;

export const runLine = (run: ReviewBenchmarkRunSummary) => {
  const { defect, clean, done, failed, total } = run.totals;
  return [
    `${run.id} · 「${run.label}」· ${run.project} 的${SPLIT[run.split]} · ${STATE[run.state]}（${done}/${total} 个样本${failed ? `，${failed} 个失败` : ""}）· 模型 ${run.model} · ${run.startedAt.slice(0, 16).replace("T", " ")}`,
    `  缺陷集 ${defect.cases} 个：命中 ${defect.hit}/${defect.issues} 个问题，核验误杀 ${defect.lost}${defect.fixReported === null ? "" : `，修复后再报 ${defect.fixReported}`}`,
    `  干净集 ${clean.cases} 个：意见 ${clean.findings} 条（有害 ${clean.harmful}、噪声 ${clean.noise}、有效 ${clean.valid}，待判 ${clean.unjudged}），已知误报再犯 ${clean.knownRepeats}`,
    ...(run.adopted ? [`  已采用（${run.adopted.at.slice(0, 10)}）${run.adopted.note ? `：${run.adopted.note}` : ""}`] : []),
  ].join("\n");
};
const comparisonText = (comparison: ReviewBenchmarkComparison) => [
  `和 ${comparison.before} 对比：`,
  ...comparison.rows.map((row) => `- ${row.label}：${row.before ?? "—"} → ${row.after ?? "—"}`),
  `结论：${comparison.said}`,
].join("\n");
const caseLine = (item: ReviewBenchmarkRunCase) => `- ${item.caseId}「${item.title}」（${item.set === "defect" ? "缺陷集" : "干净集"}）：${item.state === "failed" ? `失败：${item.error ?? ""}` : item.state !== "done" ? "没跑完"
  : item.set === "defect" ? `命中 ${item.hit}/${item.issues}${item.lost ? `，核验误杀 ${item.lost}` : ""}` : `意见 ${item.findings.filter((finding) => finding.kept).length} 条${item.knownRepeats ? `，已知误报再犯 ${item.knownRepeats}` : ""}`}`;

export const runReviewBenchmark = async (input: z.input<typeof runShape>, runtime: ReviewBenchmarkRunRuntime, cwd?: string) => {
  const request = reviewBenchmarkRunRequestSchema.safeParse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, ...input, repositoryPath: resolve(cwd ?? process.cwd(), input.repositoryPath?.trim() || ".") });
  if (!request.success) return refused("没有开始评测", request.error);
  const { result, failure } = await asked((report) => runtime.runReviewBenchmark?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有确认评测是否开始：${runtimeFailureText(failure)}。先用 list_review_benchmark_runs 看看，不要直接重试。`, null, true);
  if (result.status !== "started" || !result.run) {
    const models = result.status === "model_not_found" ? `可用的：${result.models.map((item) => `「${item.label}」（id ${item.id}）`).join("、") || "没有"}。` : "";
    return reply(`没有开始评测：${result.reason ?? "原因不明"}${models}`, result, true);
  }
  return reply([
    `已开始评测「${result.run.label}」：${result.run.project} 的${SPLIT[result.run.split]}，${result.run.totals.total} 个样本，模型 ${result.run.model}${result.run.fixControl ? "，含修复对照" : ""}。`,
    `运行 id ${result.run.id}。在 App 里后台进行，每个样本几分钟；用 get_review_benchmark_run 看进度、结果和与上一次的对比。干净集意见是否有害、要不要采用，由用户在 App 的评审质量页决定。`,
  ].join("\n"), result, false);
};

export const listReviewBenchmarkRuns = async (input: z.input<typeof listShape>, runtime: ReviewBenchmarkRunRuntime, cwd?: string) => {
  const request = reviewBenchmarkRunsQuerySchema.safeParse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: resolve(cwd ?? process.cwd(), input.repositoryPath?.trim() || ".") });
  if (!request.success) return refused("没有列出评测", request.error);
  const { result, failure } = await asked((report) => runtime.listReviewBenchmarkRuns?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有列出评测：${runtimeFailureText(failure)}`, null, true);
  if (result.status === "repository_not_found") return reply("没有列出评测：repositoryPath（没传时是 MCP 服务启动的目录）不在 Git 仓库里。", result, true);
  return reply(result.runs.length ? [`评测 ${result.runs.length} 次，新的在前：`, ...result.runs.map(runLine), "只读。"].join("\n") : "这个仓库还没有跑过评测。只读。", result, false);
};

export const getReviewBenchmarkRun = async (input: z.input<typeof getShape>, runtime: ReviewBenchmarkRunRuntime) => {
  const request = reviewBenchmarkRunQuerySchema.safeParse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, ...input });
  if (!request.success) return refused("没有读取评测", request.error);
  const { result, failure } = await asked((report) => runtime.getReviewBenchmarkRun?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取评测：${runtimeFailureText(failure)}`, null, true);
  if (!result.run) return reply(`没有 id 为 ${request.data.id} 的评测。`, result, true);
  return reply([
    runLine(result.run),
    ...(result.cases ? ["逐个样本：", ...result.cases.map(caseLine)] : ["留出集的逐个样本不给看，只看总数，免得照着答案调。"]),
    ...(result.comparison ? [comparisonText(result.comparison)] : ["还没有可以对比的上一次评测。"]),
    "只读。",
  ].join("\n"), result, false);
};

export const registerReviewBenchmarkRunTools = (server: McpServer, runtime: ReviewBenchmarkRunRuntime, options: { cwd?: string } = {}): void => {
  server.registerTool("run_review_benchmark", {
    title: "Run the review benchmark",
    description: "Review a repository's confirmed benchmark cases again in the App, as Paraself reviews now (prompt, model, local rules), and score them by set: the defect set by the issues its findings land on, the clean set by its findings, which the user judges harmful or not in the App. Run it before and after a change to the review prompt, model or rules, then compare with get_review_benchmark_run. It spends model calls for every case, for minutes each: only when the user asks. One run at a time; it answers at once with the run's id.",
    inputSchema: runShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => runReviewBenchmark(input, runtime, options.cwd));
  server.registerTool("list_review_benchmark_runs", {
    title: "List review benchmark runs",
    description: "List a repository's benchmark runs, newest first: what changed, the split, the state, and each set's totals (issues hit, findings dropped by the verifier, clean findings by the user's verdicts), and whether the user adopted the change. Read-only.",
    inputSchema: listShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => listReviewBenchmarkRuns(input, runtime, options.cwd));
  server.registerTool("get_review_benchmark_run", {
    title: "Read a review benchmark run",
    description: "Read one benchmark run: its totals, each case for a dev run (a holdout run's cases stay hidden, only its totals), and how it compares with the run before it: recall first, then harmful findings, with the gate's word on adopting the change. Read-only.",
    inputSchema: getShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => getReviewBenchmarkRun(input, runtime));
};
