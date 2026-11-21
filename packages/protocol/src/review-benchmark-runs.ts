import { z } from "zod";

import { reviewBenchmarkRepositoryPathSchema, reviewBenchmarkSetSchema, reviewBenchmarkSplitSchema, REVIEW_BENCHMARK_VERSION } from "./review-benchmark.js";

/**
 * 评测运行 (docs/review-collaboration-design.md「评测集」的闸门): the confirmed cases of a repository reviewed again in the App
 * as they are now (prompt, model, local rules), and scored by set: the defect set by the issues its findings land on,
 * the clean set by what the user judges its findings would do. Two runs side by side say whether a change can be
 * adopted: recall not down, harmful findings not up. The holdout's answers stay out of sight: only its totals are shown.
 */
const count = z.number().int().nonnegative();

export const reviewBenchmarkRunFindingSchema = z.object({
  title: z.string().max(300), priority: z.enum(["P1", "P2", "P3"]), path: z.string().max(1_000), side: z.enum(["old", "new"]), line: z.number().int(),
  body: z.string().max(600),
  /** Kept by the verifier; false: a candidate it dropped. */
  kept: z.boolean(),
}).strict();
export type ReviewBenchmarkRunFinding = z.infer<typeof reviewBenchmarkRunFindingSchema>;
export const REVIEW_BENCHMARK_VERDICTS = { harmful: "有害", noise: "噪声", valid: "有效" } as const;
export const reviewBenchmarkVerdictSchema = z.enum(["harmful", "noise", "valid"]);

export const reviewBenchmarkRunCaseSchema = z.object({
  caseId: z.string().max(100), set: reviewBenchmarkSetSchema, title: z.string().max(300),
  state: z.enum(["pending", "running", "done", "failed"]),
  error: z.string().max(1_000).nullable(),
  /** Defect set: issues counted (tradeoffs aside), hit by a kept finding near their place, hit only by a dropped one (核验误杀). */
  issues: count, hit: count, lost: count,
  /** 修复对照: issues said again on the fixed version; null when not run. */
  fixReported: count.nullable(),
  /** Clean set: known false positives said again, by their place. */
  knownRepeats: count,
  findings: z.array(reviewBenchmarkRunFindingSchema).max(50),
  /** The user's word on each kept finding of a clean case, by its index in `findings`. */
  judgments: z.array(z.object({ finding: count, verdict: reviewBenchmarkVerdictSchema }).strict()).max(50),
  wallMs: count,
}).strict();
export type ReviewBenchmarkRunCase = z.infer<typeof reviewBenchmarkRunCaseSchema>;

export const reviewBenchmarkRunSchema = z.object({
  id: z.string().uuid(),
  repositoryPath: reviewBenchmarkRepositoryPathSchema, project: z.string().max(500),
  /** What changed since the run it is compared with: the prompt, the model, a rule. */
  label: z.string().trim().min(1).max(300),
  split: reviewBenchmarkSplitSchema, fixControl: z.boolean(),
  model: z.string().max(300), profileId: z.string().max(200),
  startedAt: z.string(), finishedAt: z.string().nullable(),
  state: z.enum(["running", "finished", "failed", "cancelled", "interrupted"]),
  error: z.string().max(1_000).nullable(),
  cases: z.array(reviewBenchmarkRunCaseSchema).max(200),
  /** The change taken on the strength of this run, by the user. */
  adopted: z.object({ at: z.string(), note: z.string().max(600) }).strict().nullable(),
}).strict();
export type ReviewBenchmarkRun = z.infer<typeof reviewBenchmarkRunSchema>;

export const reviewBenchmarkRunTotalsSchema = z.object({
  defect: z.object({ cases: count, issues: count, hit: count, lost: count, fixReported: count.nullable() }).strict(),
  clean: z.object({ cases: count, findings: count, harmful: count, noise: count, valid: count, unjudged: count, knownRepeats: count }).strict(),
  done: count, failed: count, total: count,
}).strict();
export type ReviewBenchmarkRunTotals = z.infer<typeof reviewBenchmarkRunTotalsSchema>;

/** A run as listed: its totals, never a holdout case's own. */
export const reviewBenchmarkRunSummarySchema = reviewBenchmarkRunSchema.omit({ cases: true }).extend({ totals: reviewBenchmarkRunTotalsSchema });
export type ReviewBenchmarkRunSummary = z.infer<typeof reviewBenchmarkRunSummarySchema>;

/** Two runs side by side, on their common cases: the gate's word on the later. */
export const reviewBenchmarkComparisonSchema = z.object({
  before: z.string().uuid(), after: z.string().uuid(),
  sameCases: z.boolean(),
  rows: z.array(z.object({ metric: z.enum(["hit", "harmful", "commentsPerCase", "fixReported"]), label: z.string(), before: z.number().nullable(), after: z.number().nullable(),
    change: z.enum(["same", "up", "down", "unknown"]) }).strict()),
  verdict: z.enum(["adopt", "reject_recall", "reject_harmful", "judge_first", "not_comparable"]),
  said: z.string().max(300),
}).strict();
export type ReviewBenchmarkComparison = z.infer<typeof reviewBenchmarkComparisonSchema>;

/** run_review_benchmark: the repository's confirmed cases of a split reviewed again, in the background. */
export const reviewBenchmarkRunRequestSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  repositoryPath: reviewBenchmarkRepositoryPathSchema,
  label: z.string().trim().min(1).max(300),
  split: reviewBenchmarkSplitSchema.default("holdout"),
  set: reviewBenchmarkSetSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  fixControl: z.boolean().default(false),
}).strict();
export type ReviewBenchmarkRunRequest = z.output<typeof reviewBenchmarkRunRequestSchema>;
export const reviewBenchmarkRunStartSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  status: z.enum(["started", "busy", "repository_not_found", "no_cases", "model_not_found", "failed"]),
  reason: z.string().max(1_000).nullable(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  run: reviewBenchmarkRunSummarySchema.nullable(),
}).strict();
export type ReviewBenchmarkRunStart = z.infer<typeof reviewBenchmarkRunStartSchema>;

export const reviewBenchmarkRunsQuerySchema = z.object({ reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION), repositoryPath: reviewBenchmarkRepositoryPathSchema }).strict();
export type ReviewBenchmarkRunsQuery = z.output<typeof reviewBenchmarkRunsQuerySchema>;
export const reviewBenchmarkRunsResultSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  status: z.enum(["ok", "repository_not_found"]),
  runs: z.array(reviewBenchmarkRunSummarySchema).max(50),
}).strict();
export type ReviewBenchmarkRunsResult = z.infer<typeof reviewBenchmarkRunsResultSchema>;

/** get_review_benchmark_run: one run, compared with `compareTo` or the last finished run of its repository and split before it. */
export const reviewBenchmarkRunQuerySchema = z.object({ reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION), id: z.string().uuid(), compareTo: z.string().uuid().optional() }).strict();
export type ReviewBenchmarkRunQuery = z.output<typeof reviewBenchmarkRunQuerySchema>;
export const reviewBenchmarkRunResultSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  status: z.enum(["ok", "not_found"]),
  run: reviewBenchmarkRunSummarySchema.nullable(),
  /** A dev run's cases with their findings; a holdout run's are kept back. */
  cases: z.array(reviewBenchmarkRunCaseSchema).max(200).nullable(),
  comparison: reviewBenchmarkComparisonSchema.nullable(),
}).strict();
export type ReviewBenchmarkRunResult = z.infer<typeof reviewBenchmarkRunResultSchema>;

/**
 * 线上回流: what review left behind that could become a case, for the user to take or leave. A finding the author
 * fixed is a defect case at the commit it was raised on; one they called wrong, on a PR that merged, a clean case
 * with it as a known false positive; a PR merged sixty days and more with no revert or fix naming it, a clean case.
 */
export const reviewBenchmarkSuggestionSchema = z.object({
  key: z.string().max(300),
  set: reviewBenchmarkSetSchema,
  source: z.enum(["fixed", "wrong", "sampling"]),
  reference: z.string().max(2_000),
  title: z.string().max(500),
  said: z.string().max(600),
  /** Why it cannot be taken yet (not merged, no local repository…); null when it can. */
  blocked: z.string().max(300).nullable(),
}).strict();
export type ReviewBenchmarkSuggestion = z.infer<typeof reviewBenchmarkSuggestionSchema>;

const counts = z.object({ candidate: count, dev: count, holdout: count }).strict();
export const reviewBenchmarkRepositoryOverviewSchema = z.object({
  path: z.string().max(4_000), project: z.string().max(500),
  counts: z.object({ defect: counts, clean: counts }).strict(),
  candidates: z.array(z.object({ caseId: z.string().max(100), set: reviewBenchmarkSetSchema, title: z.string().max(300), from: z.string().max(300) }).strict()).max(20),
  runs: z.array(reviewBenchmarkRunSummarySchema).max(10),
}).strict();
export type ReviewBenchmarkRepositoryOverview = z.infer<typeof reviewBenchmarkRepositoryOverviewSchema>;

/** The review page's 评测集: one channel, what to do said by `kind`. */
export const reviewBenchmarkPageRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("overview"), connectionId: z.string().uuid().optional() }).strict(),
  z.object({ kind: z.literal("run"), repositoryPath: reviewBenchmarkRepositoryPathSchema, label: z.string().trim().min(1).max(300), split: reviewBenchmarkSplitSchema,
    model: z.string().trim().min(1).max(200).optional(), fixControl: z.boolean() }).strict(),
  z.object({ kind: z.literal("get"), id: z.string().uuid(), compareTo: z.string().uuid().optional() }).strict(),
  z.object({ kind: z.literal("judge"), id: z.string().uuid(), caseId: z.string().max(100), finding: count, verdict: reviewBenchmarkVerdictSchema }).strict(),
  z.object({ kind: z.literal("adopt"), id: z.string().uuid(), note: z.string().trim().max(600) }).strict(),
  z.object({ kind: z.literal("cancel"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("confirm"), repositoryPath: reviewBenchmarkRepositoryPathSchema, caseId: z.string().max(100) }).strict(),
  z.object({ kind: z.literal("accept"), connectionId: z.string().uuid(), key: z.string().max(300) }).strict(),
  z.object({ kind: z.literal("dismiss"), key: z.string().max(300) }).strict(),
]);
export type ReviewBenchmarkPageRequest = z.output<typeof reviewBenchmarkPageRequestSchema>;
export const reviewBenchmarkPageResultSchema = z.object({
  /** What was done, or why it was not. */
  message: z.string().max(1_000).nullable(),
  ok: z.boolean(),
  overview: z.object({
    repositories: z.array(reviewBenchmarkRepositoryOverviewSchema).max(50),
    suggestions: z.array(reviewBenchmarkSuggestionSchema).max(30),
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    /** The run under way, if one is. */
    active: z.string().nullable(),
  }).strict().nullable(),
  run: reviewBenchmarkRunResultSchema.nullable(),
}).strict();
export type ReviewBenchmarkPageResult = z.infer<typeof reviewBenchmarkPageResultSchema>;
