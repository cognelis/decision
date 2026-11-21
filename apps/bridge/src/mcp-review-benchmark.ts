import type { McpServer } from "@modelcontextprotocol/server";
import {
  REVIEW_BENCHMARK_LABELS,
  REVIEW_BENCHMARK_LIMITS,
  REVIEW_BENCHMARK_VERSION,
  reviewBenchmarkGetRequestSchema,
  reviewBenchmarkListRequestSchema,
  reviewBenchmarkProvenanceKindSchema,
  reviewBenchmarkRecordRequestSchema,
  reviewBenchmarkSetSchema,
  reviewBenchmarkStatusSchema,
  reviewBenchmarkUpdateRequestSchema,
  type ReviewBenchmarkCaseView,
  type ReviewBenchmarkGetRequest,
  type ReviewBenchmarkGetResult,
  type ReviewBenchmarkListRequest,
  type ReviewBenchmarkListResult,
  type ReviewBenchmarkRecordRequest,
  type ReviewBenchmarkRecordResult,
  type ReviewBenchmarkSetCounts,
  type ReviewBenchmarkSummary,
  type ReviewBenchmarkUpdateRequest,
  type ReviewBenchmarkUpdateResult,
} from "@cognelis/decision-protocol";
import { resolve } from "node:path";
import { z } from "zod";

import { localTime } from "./mcp-context.js";
import { runtimeFailureText, type RuntimeFailure, type RuntimeFailureReport } from "./runtime-client.js";

/**
 * 评审评测集 for agents (docs/review-collaboration-design.md「录入：MCP 工具」): candidate cases recorded in a batch,
 * listed, read and changed one at a time. The App checks every commit and line against the local repository, picks
 * each case's split, and keeps the holdout split's labels to itself; these tools only ask it.
 */
export interface ReviewBenchmarkRuntime {
  recordReviewBenchmarkCases?(input: ReviewBenchmarkRecordRequest, report?: RuntimeFailureReport): Promise<ReviewBenchmarkRecordResult | null>;
  listReviewBenchmarkCases?(input: ReviewBenchmarkListRequest, report?: RuntimeFailureReport): Promise<ReviewBenchmarkListResult | null>;
  getReviewBenchmarkCase?(input: ReviewBenchmarkGetRequest, report?: RuntimeFailureReport): Promise<ReviewBenchmarkGetResult | null>;
  updateReviewBenchmarkCase?(input: ReviewBenchmarkUpdateRequest, report?: RuntimeFailureReport): Promise<ReviewBenchmarkUpdateResult | null>;
}

export interface ReviewBenchmarkToolOptions {
  sourceClient: string;
  /** Where the MCP server started: the repository when the agent names none. */
  cwd?: string;
}

const L = REVIEW_BENCHMARK_LIMITS;
const { set: SET, status: STATUS, split: SPLIT } = REVIEW_BENCHMARK_LABELS;

/*
 * What a client is shown: flat objects, types and words only, the limits said in them. The protocol's own schemas
 * check each request (reasonOf says why in Chinese); the SDK checking these first sent zod's English to the agent.
 */
const repositoryPathShape = z.string().optional().describe(
  "The local Git repository the cases are in: an absolute path to it or any directory in it. Default: the directory the MCP server was started in, which may not be the repository you are curating; pass it when working elsewhere.",
);
const locationShape = z.object({
  path: z.string().describe("Repository-relative path, as Git prints it."),
  side: z.enum(["new", "old"]).optional().describe("new (default): lines of the PR's version (headSha); old: lines the PR took out, numbered as before it (the merge base)."),
  startLine: z.number().int().describe("First line, from 1."),
  endLine: z.number().int().describe("Last line, at least startLine."),
});
const issueShape = z.object({
  title: z.string().describe(`What is wrong, one line, up to ${L.issueTitle} characters.`),
  priority: z.enum(["P1", "P2", "P3"]).describe("P1: correctness, data loss or security; P2: a real defect of lesser impact; P3: minor."),
  locations: z.array(locationShape).describe(`Where it is, 1 to ${L.locations}: the lines its fix changed, as they read in headSha (or, for removed lines, before the PR).`),
  evidence: z.string().describe(`One paragraph, up to ${L.evidence} characters: why it is a defect and how that was established (the fix, the incident, the bug). No source code beyond a few words, no secrets.`),
  fixShas: z.array(z.string()).optional().describe(`Full ids of the commits that fixed it, up to ${L.fixCommits}. Required unless tradeoff; none may already be in headSha.`),
  tradeoff: z.boolean().optional().describe("true for a problem the author knowingly accepted: a review raising it is not wrong, but it does not count toward recall. Default false."),
});
const falsePositiveShape = z.object({
  finding: z.string().describe(`What a review said about this PR that did not hold, up to ${L.finding} characters.`),
  why: z.string().describe(`Why it did not hold, up to ${L.finding} characters.`),
  location: locationShape.optional(),
});
const provenanceShape = z.object({
  kind: reviewBenchmarkProvenanceKindSchema.describe(
    "revert: a revert commit; fix_commit: a commit that fixed it; task: a bug in the task tracker; incident: an incident or escape review; review_reaction: the author's answer to a review comment; sampling: picked from merged PRs for the clean set; other.",
  ),
  reference: z.string().describe(`The id it is known by (a commit's full id, a task id), one line up to ${L.reference} characters; list_review_benchmark_cases finds cases by it.`),
  url: z.string().optional().describe("Its http(s) link, if it has one."),
});
const prShape = z.object({
  platform: z.enum(["github", "gitlab", "bitbucket-server"]).optional(),
  repository: z.string().describe("owner/repo on GitHub, group/repo on GitLab, PROJECT/repo on Bitbucket."),
  number: z.number().int().describe("The PR's number."),
  url: z.string().optional().describe("Its http(s) link."),
});
const issuesShape = z.array(issueShape).describe(`defect only, 1 to ${L.issues}: its problems, at least one not a tradeoff.`);
const knownFalsePositivesShape = z.array(falsePositiveShape).describe(`clean only, up to ${L.knownFalsePositives}: review comments made on it that did not hold.`);
const titleShape = z.string().describe(`The PR's own title as it was, one line up to ${L.title} characters. A replay shows it to the reviewer: never describe the problem in it.`);

const recordToolShape = z.object({
  repositoryPath: repositoryPathShape,
  cases: z.array(z.object({
    set: reviewBenchmarkSetSchema.describe("defect: a PR found later to have a problem, recorded at the version that still had it; clean: a PR found to have none."),
    title: titleShape,
    pr: prShape.optional().describe("The PR on its platform, when there is one."),
    headSha: z.string().describe("Full id of the PR's head as it was reviewed; for a defect, a version that still had the problem, before any fix."),
    targetSha: z.string().describe("Full id of the target branch's commit then, before the PR was merged."),
    scope: z.array(z.string()).optional().describe(`Review only these changed files, up to ${L.scopePaths}; left out, the whole PR.`),
    provenance: z.array(provenanceShape).describe(`Where the case came from, 1 to ${L.provenance}.`),
    issues: issuesShape.optional(),
    mergedAt: z.string().optional().describe("clean only: the merge date, YYYY-MM-DD."),
    cleanEvidence: z.string().optional().describe(`clean only, up to ${L.evidence} characters: how it was found clean (not reverted, no later fix touched the lines it added, no bug names it).`),
    knownFalsePositives: knownFalsePositivesShape.optional(),
  })).describe(`1 to ${L.casesPerCall} cases, one PR each.`),
});

const listToolShape = z.object({
  repositoryPath: repositoryPathShape,
  set: reviewBenchmarkSetSchema.optional(),
  status: reviewBenchmarkStatusSchema.optional(),
  provenance: z.string().optional().describe("Only cases with a provenance reference exactly this (a fix commit's full id, a task id): look before recording one."),
  headSha: z.string().optional().describe("Only cases at this PR version (its full id)."),
  limit: z.number().int().optional().describe(`Cases per page, 1 to ${L.page}, default 50.`),
  offset: z.number().int().optional().describe("The previous page's nextOffset, the other parameters unchanged; default 0."),
});

const getToolShape = z.object({
  repositoryPath: repositoryPathShape,
  caseId: z.string().describe("The case's id (case-…), from record_review_benchmark_cases or list_review_benchmark_cases."),
});

const updateToolShape = z.object({
  repositoryPath: repositoryPathShape,
  caseId: getToolShape.shape.caseId,
  expectedStatus: reviewBenchmarkStatusSchema.describe("The status you just read. Changed since, nothing is written; read it again."),
  status: reviewBenchmarkStatusSchema.optional().describe(
    "confirmed: only after the user has said they checked this case's labels, their words in userConfirmation; withdrawn: out of the benchmark, with reason; candidate: back to a candidate from confirmed or withdrawn, with reason. Omitted, it stays (but see below).",
  ),
  userConfirmation: z.string().optional().describe(`With confirmed: the user's own words saying they checked it, quoted, up to ${L.note} characters. Never your own.`),
  reason: z.string().optional().describe(`With withdrawn or candidate: why, up to ${L.note} characters.`),
  note: z.string().optional().describe(`A note on the case, up to ${L.note} characters.`),
  title: titleShape.optional(),
  pr: prShape.optional().describe("Replaces the PR reference."),
  provenance: z.array(provenanceShape).optional().describe(`Replaces where it came from, 1 to ${L.provenance}.`),
  issues: issuesShape.optional().describe(`defect only: replaces its issues, 1 to ${L.issues}, at least one not a tradeoff.`),
  mergedAt: z.string().optional().describe("clean only: replaces the merge date, YYYY-MM-DD."),
  cleanEvidence: z.string().optional().describe(`clean only: replaces how it was found clean, up to ${L.evidence} characters.`),
  knownFalsePositives: knownFalsePositivesShape.optional().describe(`clean only: replaces them, up to ${L.knownFalsePositives}; an empty array clears them.`),
});

export type RecordReviewBenchmarkCasesInput = z.input<typeof recordToolShape>;
export type ListReviewBenchmarkCasesInput = z.input<typeof listToolShape>;
export type GetReviewBenchmarkCaseInput = z.input<typeof getToolShape>;
export type UpdateReviewBenchmarkCaseInput = z.input<typeof updateToolShape>;

// The protocol's rules, said as what to change.
const RULES: Record<string, string> = {
  "must be a full commit id": "要写完整的提交号（40 或 64 位十六进制）",
  "must be a date as YYYY-MM-DD": "要写成 YYYY-MM-DD 的日期",
  "must be an absolute path": "要是本地仓库里某个目录的绝对路径",
  "must be a repository name such as owner/repo": "要写平台上的仓库名，如 owner/repo、PROJECT/repo",
  "must be a single line": "只能写一行",
  "Expected a literal repository-relative path without traversal or glob syntax": "要写仓库内的相对路径，不能以 / 开头，不能有 ..、* 或 ?",
  "endLine must not be before startLine": "endLine 不能小于 startLine",
  "an issue that is not a tradeoff needs its fix commits": "要写修复提交 fixShas；只有作者接受的取舍（tradeoff 设为 true）可以不写",
  "a defect case needs an issue that is not a tradeoff": "缺陷集样本至少要有一个不是取舍（tradeoff 不为 true）的问题",
  "nothing to change": "status、note 和要改的字段至少要提供一项",
  "confirming needs the user's words": "设为 confirmed 需要 userConfirmation：用户说已核对过的原话；用户没有明确说过就不要确认",
  "userConfirmation only with confirmed": "userConfirmation 只在设为 confirmed 时提供",
  "this status needs a reason": "设为 withdrawn 或 candidate 需要 reason，写明为什么",
  "reason only with withdrawn or candidate": "reason 只在设为 withdrawn 或 candidate 时提供，其余说明写进 note",
};
const ONLY_FOR: Record<string, string> = {
  issues: "issues 只用于缺陷集样本（set 为 defect）",
  mergedAt: "mergedAt 只用于干净集样本（set 为 clean）",
  cleanEvidence: "cleanEvidence 只用于干净集样本（set 为 clean）",
  knownFalsePositives: "knownFalsePositives 只用于干净集样本（set 为 clean）",
};
/** ["cases", 0, "issues", 1, "fixShas"] as 「cases 第 1 个的 issues 第 2 个的 fixShas」. */
const where = (path: readonly PropertyKey[]): string => path.reduce<string>((text, part) =>
  typeof part === "number" ? `${text} 第 ${part + 1} 个` : text === "" ? String(part) : text.endsWith("个") ? `${text}的 ${String(part)}` : `${text}.${String(part)}`, "");
const reasonOf = (issue: z.core.$ZodIssue): string => {
  const at = where(issue.path);
  const prefix = at === "" ? "" : `${at}：`;
  if (issue.code === "unrecognized_keys") return issue.keys.map((key) => ONLY_FOR[key] === undefined ? `${prefix}没有 ${key} 这个字段` : `${prefix}${ONLY_FOR[key]}`).join("；");
  const rule = RULES[issue.message] ?? (() => {
    switch (issue.code) {
      case "too_big": return issue.origin === "string" ? `最多 ${issue.maximum} 个字符` : issue.origin === "array" ? `最多 ${issue.maximum} 个` : `不能超过 ${issue.maximum}`;
      case "too_small": return issue.origin === "string" ? "不能是空的" : issue.origin === "array" ? `至少要有 ${issue.minimum} 个` : issue.minimum === 0 ? "要是正整数" : `不能小于 ${issue.minimum}`;
      case "invalid_value": return `只能是 ${issue.values.map(String).join("、")}`;
      case "invalid_union": return "要是 defect（缺陷集）或 clean（干净集）";
      case "invalid_format": return issue.format === "url" ? "要是 http 或 https 链接" : "格式不对";
      case "invalid_type": return "缺少，或者类型不对";
      default: return "不符合要求";
    }
  })();
  return `${prefix}${rule}`;
};
const reasons = (error: z.ZodError): string => [...new Set(error.issues.map(reasonOf))].join("；");

/** Optional parts a model filled with nothing ("", [] or null), as not given: refused, a batch was lost over an empty url. */
const pruned = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(pruned);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, part]) => part !== "" && part !== null && !(Array.isArray(part) && part.length === 0))
    .map(([key, part]) => [key, pruned(part)]));
};
const repositoryPath = (given: string | undefined, options: ReviewBenchmarkToolOptions): string => resolve(options.cwd ?? process.cwd(), given?.trim() || ".");

const reply = (text: string, reviewBenchmark: unknown, isError: boolean) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: "text" as const, text }],
  // Claude Code shows a model only the structuredContent of a result that has one: what the text says goes there too.
  structuredContent: { message: text, reviewBenchmark },
});
const short = (commit: string) => commit.slice(0, 12);
const NOT_A_REPOSITORY = "repositoryPath（没传时是 MCP 服务启动的目录）不在 Git 仓库里：传本地仓库里某个目录的绝对路径";

const sent = async <T>(ask: ((report: RuntimeFailureReport) => Promise<T | null>) | undefined): Promise<{ result: T | null; failure: RuntimeFailure }> => {
  // Widened, not narrowed to this first value: the report may change it.
  let failure = { reason: "not_running" } as RuntimeFailure;
  const result = await ask?.((reported) => { failure = reported; }).catch(() => null) ?? null;
  return { result, failure };
};

export const recordReviewBenchmarkCases = async (input: RecordReviewBenchmarkCasesInput, runtime: ReviewBenchmarkRuntime, options: ReviewBenchmarkToolOptions) => {
  const request = reviewBenchmarkRecordRequestSchema.safeParse({
    reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION,
    sourceClient: options.sourceClient,
    repositoryPath: repositoryPath(input.repositoryPath, options),
    cases: Array.isArray(input.cases) ? input.cases.map(pruned) : input.cases,
  });
  if (!request.success) {
    return reply(`没有录入：输入不符合要求（${reasons(request.error)}）。一个样本不合要求，这一批都没有发出；改正后再录，不要声称已经录入。`, null, true);
  }
  const { result, failure } = await sent((report) => runtime.recordReviewBenchmarkCases?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) {
    const text = failure.reason === "no_answer"
      ? `无法确认这批样本是否已录入：${runtimeFailureText(failure)}先用 list_review_benchmark_cases（headSha 或 provenance）核实再决定是否重试；用同样的内容重试不会重复录入。不要声称已经录入。`
      : `没有录入：${runtimeFailureText(failure)}不要声称已经录入。`;
    return reply(text, null, true);
  }
  if (result.status === "repository_not_found") return reply(`没有录入：${NOT_A_REPOSITORY}。`, result, true);
  const count = (outcome: string) => result.cases.filter((item) => item.outcome === outcome).length;
  const lines = result.cases.map((item, index) =>
    item.outcome === "recorded" ? `第 ${index + 1} 个：已录入为候选（${item.caseId}，${SPLIT[item.split!]}）`
    : item.outcome === "duplicate" ? `第 ${index + 1} 个：已经录过（${item.caseId}，${STATUS[item.status!]}），这次没有重复写入`
    : `第 ${index + 1} 个没有录入：${item.reasons.join("；")}`);
  const recorded = count("recorded");
  const text = [
    `评测集（项目 ${result.repository!.project}）：${result.cases.length} 个样本里录入 ${recorded} 个、已有 ${count("duplicate")} 个、退回 ${count("rejected")} 个。`,
    ...lines,
    ...(recorded > 0 ? ["录入的都是候选，不算入集：请用户核对标注；用户明确说核对过以后，再用 update_review_benchmark_case 设为 confirmed，并在 userConfirmation 里附上用户的原话。开发集和留出集由 App 按样本分，留出集的标注之后不会经 MCP 返回。"] : []),
    ...(count("rejected") > 0 ? ["退回的按原因改正后再录；已录入和已有的不用重发。"] : []),
  ].join("\n");
  return reply(text, result, recorded + count("duplicate") === 0);
};

const counted = (counts: ReviewBenchmarkSetCounts): string =>
  `候选 ${counts.candidate}，已确认 ${counts.confirmed.dev + counts.confirmed.holdout}（开发集 ${counts.confirmed.dev}，留出集 ${counts.confirmed.holdout}），已撤回 ${counts.withdrawn}`;
const described = (item: ReviewBenchmarkSummary): string => {
  const pr = item.pr === null ? "" : `PR ${item.pr.repository}#${item.pr.number}，`;
  const scope = item.scope.length === 0 ? "" : `，只看 ${item.scope.join("、")}`;
  const sources = item.provenance.map((source) => `${source.kind} ${source.reference}`).join("、");
  return `${item.id}［${SET[item.set]}·${STATUS[item.status]}·${SPLIT[item.split]}］${item.title}（${pr}head ${short(item.headSha)}${scope}；来源 ${sources}）`;
};

export const listReviewBenchmarkCases = async (input: ListReviewBenchmarkCasesInput, runtime: ReviewBenchmarkRuntime, options: ReviewBenchmarkToolOptions) => {
  const { repositoryPath: given, ...filters } = pruned(input) as ListReviewBenchmarkCasesInput;
  const request = reviewBenchmarkListRequestSchema.safeParse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repositoryPath(given, options), ...filters });
  if (!request.success) return reply(`没有读取评测集：输入不符合要求（${reasons(request.error)}）。`, null, true);
  const { result, failure } = await sent((report) => runtime.listReviewBenchmarkCases?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取评测集：${runtimeFailureText(failure)}`, null, true);
  if (result.status === "repository_not_found") return reply(`没有读取评测集：${NOT_A_REPOSITORY}。`, result, true);
  const text = [
    `评测集（项目 ${result.repository!.project}）：缺陷集 ${counted(result.counts.defect)}；干净集 ${counted(result.counts.clean)}。`,
    result.total === 0 ? "没有符合条件的样本。" : `符合条件的 ${result.total} 个，这一页 ${result.cases.length} 个：`,
    ...result.cases.map(described),
    ...(result.nextOffset === null ? [] : [`还有更多：offset 传 ${result.nextOffset}，其余参数不变。`]),
    ...(result.cases.length > 0 ? ["列表不含标注；要看一个样本的标注和变更记录，用 get_review_benchmark_case。"] : []),
  ].join("\n");
  return reply(text, result, false);
};

const located = (location: { path: string; side: "new" | "old"; startLine: number; endLine: number }) =>
  `${location.path}:${location.startLine}${location.endLine === location.startLine ? "" : `–${location.endLine}`}${location.side === "old" ? "（PR 之前的版本）" : ""}`;
const labelled = (item: ReviewBenchmarkCaseView): string[] => {
  if (item.labelsWithheld) return ["它在留出集：标注和备注不经 MCP 返回，免得有人对着答案调评审。要改标注，可以整项重写（issues、cleanEvidence、knownFalsePositives）。"];
  if (item.set === "defect") {
    return (item.issues ?? []).map((issue, index) =>
      `问题 ${index + 1}（${issue.priority}${issue.tradeoff ? "，作者接受的取舍" : ""}）：${issue.title}；位置 ${issue.locations.map(located).join("、")}；${issue.fixShas.length === 0 ? "" : `修复 ${issue.fixShas.map(short).join("、")}；`}证据：${issue.evidence}`);
  }
  return [
    `合并于 ${item.mergedAt}；为什么算干净：${item.cleanEvidence}`,
    ...(item.knownFalsePositives ?? []).map((entry, index) => `已知误报 ${index + 1}：${entry.finding}；不成立的原因：${entry.why}${entry.location === undefined ? "" : `（${located(entry.location)}）`}`),
  ];
};
const historyOf = (item: ReviewBenchmarkCaseView): string[] => item.history.map((event) => {
  const who = event.by.kind === "agent" ? event.by.client : "用户";
  const status = event.previous === null ? `录入为${STATUS[event.status]}` : event.previous === event.status ? STATUS[event.status] : `${STATUS[event.previous]} → ${STATUS[event.status]}`;
  const said = [
    event.changed.length === 0 ? "" : `改了 ${event.changed.join("、")}`,
    event.userConfirmation === null ? "" : `用户原话：${event.userConfirmation}`,
    event.reason === null ? "" : `原因：${event.reason}`,
    event.note === null ? "" : `备注：${event.note}`,
  ].filter(Boolean).join("；");
  return `${localTime(event.at)} ${who}：${status}${said === "" ? "" : `；${said}`}`;
});
const shown = (item: ReviewBenchmarkCaseView): string => [described(item), ...labelled(item), "变更记录：", ...historyOf(item)].join("\n");

export const getReviewBenchmarkCase = async (input: GetReviewBenchmarkCaseInput, runtime: ReviewBenchmarkRuntime, options: ReviewBenchmarkToolOptions) => {
  const request = reviewBenchmarkGetRequestSchema.safeParse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: repositoryPath(input.repositoryPath, options), caseId: input.caseId });
  if (!request.success) return reply(`没有读取样本：输入不符合要求（${reasons(request.error)}）。`, null, true);
  const { result, failure } = await sent((report) => runtime.getReviewBenchmarkCase?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) return reply(`没有读取样本：${runtimeFailureText(failure)}`, null, true);
  if (result.status === "repository_not_found") return reply(`没有读取样本：${NOT_A_REPOSITORY}。`, result, true);
  if (result.case === null) return reply(`没有读取样本：这个仓库的评测集里没有 ${request.data.caseId}，用 list_review_benchmark_cases 找到正确的 caseId。`, result, true);
  return reply(shown(result.case), result, false);
};

export const updateReviewBenchmarkCase = async (input: UpdateReviewBenchmarkCaseInput, runtime: ReviewBenchmarkRuntime, options: ReviewBenchmarkToolOptions) => {
  const { repositoryPath: given, ...rest } = input;
  // A note or reason left blank is not given; a field's own parts are pruned, the field itself kept: [] clears it.
  const fields = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== "" && value !== undefined).map(([key, value]) => [key, typeof value === "object" ? pruned(value) : value]));
  const request = reviewBenchmarkUpdateRequestSchema.safeParse({
    reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION,
    sourceClient: options.sourceClient,
    repositoryPath: repositoryPath(given, options),
    ...fields,
  });
  if (!request.success) return reply(`没有更新样本：输入不符合要求（${reasons(request.error)}）。改正后再试，不要声称已经更新。`, null, true);
  const { result, failure } = await sent((report) => runtime.updateReviewBenchmarkCase?.(request.data, report) ?? Promise.resolve(null));
  if (result === null) {
    const text = failure.reason === "no_answer"
      ? `无法确认样本是否已更新：${runtimeFailureText(failure)}先用 get_review_benchmark_case 核实；同样的内容重试不会重复写入。不要声称已经更新。`
      : `没有更新样本：${runtimeFailureText(failure)}不要声称已经更新。`;
    return reply(text, null, true);
  }
  const id = request.data.caseId;
  switch (result.status) {
    case "repository_not_found": return reply(`没有更新样本：${NOT_A_REPOSITORY}。`, result, true);
    case "case_not_found": return reply(`没有更新样本：这个仓库的评测集里没有 ${id}，用 list_review_benchmark_cases 找到正确的 caseId。`, result, true);
    case "status_changed": return reply(`没有更新样本：${result.reasons.join("；")}。`, result, true);
    case "rejected": return reply(`没有更新样本 ${id}：${result.reasons.join("；")}。改正后再试。`, result, true);
    case "unchanged": return reply(`${id} 没有变化：内容和现在一样，这次没有写入。`, result, false);
    case "saved": {
      const item = result.case!;
      const changed = item.history.at(-1)?.changed ?? [];
      const reopened = request.data.status === undefined && request.data.expectedStatus === "confirmed" && item.status === "candidate";
      const text = [
        `已更新 ${id}${changed.length === 0 ? "" : `：改了 ${changed.join("、")}`}；现在是「${STATUS[item.status]}」${request.data.expectedStatus === item.status ? "" : `（原来是「${STATUS[request.data.expectedStatus]}」）`}。`,
        ...(reopened ? ["标注改了，样本从「已确认」退回「候选」：请用户重新核对，用户确认后再设为 confirmed。"] : []),
      ].join("\n");
      return reply(text, result, false);
    }
  }
};

export const registerReviewBenchmarkTools = (server: McpServer, runtime: ReviewBenchmarkRuntime, options: ReviewBenchmarkToolOptions): void => {
  server.registerTool("record_review_benchmark_cases", {
    title: "Record candidate review benchmark cases",
    description:
      "Record historical PRs as candidate cases of the user's review benchmark in Paraself: the defect set (a PR later found to have a problem, recorded at the version that still had it, with its issues, their lines and fix commits) or the clean set (a PR found to have none, with how that was established and any review comments on it that did not hold). Only when the user asks you to curate the benchmark. One PR per case, up to 20 per call. First look with list_review_benchmark_cases (headSha or provenance) for one already recorded. The App checks every commit, line and fix against the local repository and refuses what does not hold, saying why; it picks each case's dev or holdout split, which you cannot choose. Every case starts as a candidate: it counts only once the user has checked it and you confirm it with update_review_benchmark_case. Store references and labels only: no source code beyond a few words, no secrets, no full discussions. title is the PR's own title, shown to the reviewer in a replay: never describe the problem in it. Sending the same case again returns the one already recorded.",
    inputSchema: recordToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => recordReviewBenchmarkCases(input, runtime, options));
  server.registerTool("list_review_benchmark_cases", {
    title: "List review benchmark cases",
    description:
      "List the review benchmark cases of one local repository, newest change first, with each set's counts (candidate, confirmed in the dev and holdout splits, withdrawn). Filters: set, status, provenance (a reference exactly as recorded, such as a fix commit's full id or a task id) and headSha; look here before recording a case. Lists references and statuses, never labels. Read-only.",
    inputSchema: listToolShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => listReviewBenchmarkCases(input, runtime, options));
  server.registerTool("get_review_benchmark_case", {
    title: "Read one review benchmark case",
    description:
      "Read one review benchmark case: its references, status, split, labels (a defect case's issues with their lines and fixes; a clean case's evidence and known false positives) and its history of changes. A case in the holdout split comes without its labels and notes, so nobody tunes a review against them. Read-only.",
    inputSchema: getToolShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => getReviewBenchmarkCase(input, runtime, options));
  server.registerTool("update_review_benchmark_case", {
    title: "Change one review benchmark case",
    description:
      "Change one review benchmark case: replace its labels (issues for a defect case; mergedAt, cleanEvidence or knownFalsePositives for a clean one), title, pr or provenance, which the App checks again as when recorded; add a note; or change its status. Confirm a case (status confirmed) only after the user has said they checked its labels, with their words quoted in userConfirmation, never on your own judgement; withdraw it with a reason when it does not belong in the benchmark; take it back to a candidate with a reason. Changing the labels of a confirmed case takes it back to a candidate unless the same call confirms it again. expectedStatus is required: the status just read; changed since, nothing is written. The set, versions and scope cannot change: withdraw the case and record another. Nothing is deleted; every change is kept in the case's history. The same change sent again changes nothing.",
    inputSchema: updateToolShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input) => updateReviewBenchmarkCase(input, runtime, options));
};
