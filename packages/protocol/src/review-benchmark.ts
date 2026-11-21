import { z } from "zod";

import { sourceClientSchema } from "./capture.js";
import { repositoryRelativePathSchema } from "./decision-scope.js";
import { prPlatformSchema } from "./pr-review.js";
import { isCalendarDate } from "./todo.js";

/**
 * 评审评测集（review benchmark）：缺陷集（defect）里是后来查出问题的 PR，测评审能不能找出来；干净集（clean）里是确认
 * 没问题的 PR，测评审会不会乱提。一个样本（case）只存引用和标注，不存源码。App 把它存在本机数据里、按仓库分，agent
 * 经 MCP 录入和修改；录入的一律是候选，用户核对过才确认入集。开发集和留出集由 App 分，留出集的答案不经 MCP 返回。
 */
export const REVIEW_BENCHMARK_VERSION = 1 as const;

export const REVIEW_BENCHMARK_LIMITS = {
  casesPerCall: 20,
  title: 200,
  issueTitle: 300,
  evidence: 600,
  /** A known false positive's finding and why it does not hold. */
  finding: 300,
  note: 500,
  reference: 200,
  url: 500,
  scopePaths: 50,
  issues: 20,
  locations: 20,
  fixCommits: 10,
  knownFalsePositives: 20,
  provenance: 10,
  /** Changes a case keeps; the oldest go first. */
  history: 100,
  /** Cases one page of a listing returns at most. */
  page: 100,
} as const;

const L = REVIEW_BENCHMARK_LIMITS;
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const line = (maximum: number) => text(maximum).regex(/^[^\r\n]*$/u, "must be a single line");

export const reviewBenchmarkSetSchema = z.enum(["defect", "clean"]);
export const reviewBenchmarkStatusSchema = z.enum(["candidate", "confirmed", "withdrawn"]);
export const reviewBenchmarkSplitSchema = z.enum(["dev", "holdout"]);
export const reviewBenchmarkProvenanceKindSchema = z.enum(["revert", "fix_commit", "task", "incident", "review_reaction", "sampling", "other"]);
/** As the App and the bridge say them. */
export const REVIEW_BENCHMARK_LABELS = {
  set: { defect: "缺陷集", clean: "干净集" },
  status: { candidate: "候选", confirmed: "已确认", withdrawn: "已撤回" },
  split: { dev: "开发集", holdout: "留出集" },
} as const;
export type ReviewBenchmarkSet = z.infer<typeof reviewBenchmarkSetSchema>;
export type ReviewBenchmarkStatus = z.infer<typeof reviewBenchmarkStatusSchema>;
export type ReviewBenchmarkSplit = z.infer<typeof reviewBenchmarkSplitSchema>;

/** A commit by its full id, as Git prints it: a short one may name another commit later. */
export const reviewBenchmarkCommitSchema = z.string().trim().toLowerCase().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, "must be a full commit id");
const dateSchema = z.string().refine(isCalendarDate, "must be a date as YYYY-MM-DD");
const urlSchema = z.url({ protocol: /^https?$/u }).max(L.url);
/** Absolute, as the App runs Git in it: the agent's own working directory means nothing to the App. */
export const reviewBenchmarkRepositoryPathSchema = z.string().min(1).max(4_000)
  .refine((path) => (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) && !/[\0\r\n]/u.test(path), "must be an absolute path");
/** What a replay's reference keeps to (`owner/repo#12`): owner/repo, group/repo, PROJECT/repo. */
const prRepositorySchema = z.string().trim().min(1).max(L.reference).regex(/^[\p{L}\p{N}_.~@-]+(?:\/[\p{L}\p{N}_.~@-]+)*$/u, "must be a repository name such as owner/repo");

/*
 * Each part as a shape: kept to strictly when sent (a field this version does not know is refused, not dropped), read
 * leniently in an answer, so a bridge still running in an agent's session keeps reading a newer App's (IMP-184).
 */
const locationShape = {
  path: repositoryRelativePathSchema,
  /** new: the file as the PR left it (headSha); old: as it was before the PR (the merge base), for lines it took out. */
  side: z.enum(["new", "old"]).default("new"),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
};
const issueShape = {
  title: line(L.issueTitle),
  priority: z.enum(["P1", "P2", "P3"]),
  evidence: text(L.evidence),
  /** The commits that fixed it. None only for a tradeoff. */
  fixShas: z.array(reviewBenchmarkCommitSchema).max(L.fixCommits).default([]),
  /** 作者接受的取舍：评审提到它不算误报，也不计入召回。 */
  tradeoff: z.boolean().default(false),
};
const falsePositiveShape = {
  /** What the review said. */
  finding: text(L.finding),
  /** Why it does not hold. */
  why: text(L.finding),
};
const provenanceShape = {
  kind: reviewBenchmarkProvenanceKindSchema,
  /** The number it is known by: a revert's or fix's commit, a task's id, an incident review's title. */
  reference: line(L.reference),
  url: urlSchema.optional(),
};
const prShape = {
  platform: prPlatformSchema.optional(),
  repository: prRepositorySchema,
  number: z.number().int().positive(),
  url: urlSchema.optional(),
};

const checkedLines = (value: { startLine: number; endLine: number }) => value.endLine >= value.startLine;
export const reviewBenchmarkLocationSchema = z.object(locationShape).strict()
  .refine(checkedLines, { message: "endLine must not be before startLine", path: ["endLine"] });
export const reviewBenchmarkIssueSchema = z.object({ ...issueShape, locations: z.array(reviewBenchmarkLocationSchema).min(1).max(L.locations) }).strict()
  .refine((issue) => issue.tradeoff || issue.fixShas.length > 0, { message: "an issue that is not a tradeoff needs its fix commits", path: ["fixShas"] });
export const reviewBenchmarkFalsePositiveSchema = z.object({ ...falsePositiveShape, location: reviewBenchmarkLocationSchema.optional() }).strict();
export const reviewBenchmarkProvenanceSchema = z.object(provenanceShape).strict();
export const reviewBenchmarkPrSchema = z.object(prShape).strict();
export type ReviewBenchmarkLocation = z.output<typeof reviewBenchmarkLocationSchema>;
export type ReviewBenchmarkIssue = z.output<typeof reviewBenchmarkIssueSchema>;
export type ReviewBenchmarkFalsePositive = z.output<typeof reviewBenchmarkFalsePositiveSchema>;
export type ReviewBenchmarkProvenance = z.output<typeof reviewBenchmarkProvenanceSchema>;
export type ReviewBenchmarkPr = z.output<typeof reviewBenchmarkPrSchema>;

const issuesSchema = z.array(reviewBenchmarkIssueSchema).min(1).max(L.issues)
  .refine((issues) => issues.some((issue) => !issue.tradeoff), "a defect case needs an issue that is not a tradeoff");
const knownFalsePositivesSchema = z.array(reviewBenchmarkFalsePositiveSchema).max(L.knownFalsePositives);
const provenanceListSchema = z.array(reviewBenchmarkProvenanceSchema).min(1).max(L.provenance);

const caseInputShape = {
  title: line(L.title),
  pr: reviewBenchmarkPrSchema.optional(),
  /** The PR's head when it was reviewed: for a defect, the version that still had the problem. */
  headSha: reviewBenchmarkCommitSchema,
  /** The target branch then. The App works out the merge base from the two. */
  targetSha: reviewBenchmarkCommitSchema,
  /** Only these files are reviewed; left out, the whole PR. */
  scope: z.array(repositoryRelativePathSchema).min(1).max(L.scopePaths).optional(),
  provenance: provenanceListSchema,
};
export const reviewBenchmarkCaseInputSchema = z.discriminatedUnion("set", [
  z.object({ set: z.literal("defect"), ...caseInputShape, issues: issuesSchema }).strict(),
  z.object({
    set: z.literal("clean"),
    ...caseInputShape,
    mergedAt: dateSchema,
    /** How it was found clean: not reverted, no fix touched the lines it added, no task names it. */
    cleanEvidence: text(L.evidence),
    knownFalsePositives: knownFalsePositivesSchema.default([]),
  }).strict(),
]);
export type ReviewBenchmarkCaseInput = z.output<typeof reviewBenchmarkCaseInputSchema>;

export const reviewBenchmarkRecordRequestSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  sourceClient: sourceClientSchema,
  repositoryPath: reviewBenchmarkRepositoryPathSchema,
  cases: z.array(reviewBenchmarkCaseInputSchema).min(1).max(L.casesPerCall),
}).strict();
export type ReviewBenchmarkRecordRequest = z.output<typeof reviewBenchmarkRecordRequestSchema>;

export const reviewBenchmarkListRequestSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  repositoryPath: reviewBenchmarkRepositoryPathSchema,
  set: reviewBenchmarkSetSchema.optional(),
  status: reviewBenchmarkStatusSchema.optional(),
  /** Cases one of whose provenance references is exactly this: a fix commit, a task's id. */
  provenance: line(L.reference).optional(),
  headSha: reviewBenchmarkCommitSchema.optional(),
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(L.page).default(50),
}).strict();
export type ReviewBenchmarkListRequest = z.output<typeof reviewBenchmarkListRequestSchema>;

export const reviewBenchmarkGetRequestSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  repositoryPath: reviewBenchmarkRepositoryPathSchema,
  caseId: line(100),
}).strict();
export type ReviewBenchmarkGetRequest = z.output<typeof reviewBenchmarkGetRequestSchema>;

/** The fields an update may rewrite. The set, versions and scope are what the case is: another of them is another case. */
export const REVIEW_BENCHMARK_FIELDS = ["title", "pr", "provenance", "issues", "mergedAt", "cleanEvidence", "knownFalsePositives"] as const;
export const reviewBenchmarkFieldSchema = z.enum(REVIEW_BENCHMARK_FIELDS);

export const reviewBenchmarkUpdateRequestSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  sourceClient: sourceClientSchema,
  repositoryPath: reviewBenchmarkRepositoryPathSchema,
  caseId: line(100),
  /** The status just read: changed since, nothing is written. */
  expectedStatus: reviewBenchmarkStatusSchema,
  status: reviewBenchmarkStatusSchema.optional(),
  /** The user's own words saying they checked it: needed to confirm. */
  userConfirmation: text(L.note).optional(),
  /** Why: needed to withdraw a case or take it back to a candidate. */
  reason: text(L.note).optional(),
  note: text(L.note).optional(),
  title: line(L.title).optional(),
  pr: reviewBenchmarkPrSchema.optional(),
  provenance: provenanceListSchema.optional(),
  issues: issuesSchema.optional(),
  mergedAt: dateSchema.optional(),
  cleanEvidence: text(L.evidence).optional(),
  knownFalsePositives: knownFalsePositivesSchema.optional(),
}).strict().superRefine((value, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
  if (value.status === undefined && value.note === undefined && REVIEW_BENCHMARK_FIELDS.every((field) => value[field] === undefined)) {
    issue("status", "nothing to change");
  }
  if (value.status === "confirmed" && value.userConfirmation === undefined) issue("userConfirmation", "confirming needs the user's words");
  if (value.userConfirmation !== undefined && value.status !== "confirmed") issue("userConfirmation", "userConfirmation only with confirmed");
  if ((value.status === "withdrawn" || value.status === "candidate") && value.reason === undefined) issue("reason", "this status needs a reason");
  if (value.reason !== undefined && value.status !== "withdrawn" && value.status !== "candidate") issue("reason", "reason only with withdrawn or candidate");
});
export type ReviewBenchmarkUpdateRequest = z.output<typeof reviewBenchmarkUpdateRequestSchema>;

export const reviewBenchmarkActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), client: sourceClientSchema }),
  z.object({ kind: z.literal("user") }),
]);
export type ReviewBenchmarkActor = z.infer<typeof reviewBenchmarkActorSchema>;

const eventShape = {
  at: z.iso.datetime(),
  by: reviewBenchmarkActorSchema,
  /** null: the case was recorded by this change. */
  previous: reviewBenchmarkStatusSchema.nullable(),
  status: reviewBenchmarkStatusSchema,
  /** The fields this change rewrote; what they held before is not kept. */
  changed: z.array(reviewBenchmarkFieldSchema),
  note: text(L.note).nullable(),
  userConfirmation: text(L.note).nullable(),
  reason: text(L.note).nullable(),
};

export const reviewBenchmarkRepositorySchema = z.object({ id: z.string().regex(/^repo:[a-f0-9]{64}$/u), project: z.string().min(1).max(500) });
export type ReviewBenchmarkRepository = z.infer<typeof reviewBenchmarkRepositorySchema>;

const summaryShape = {
  id: line(100),
  set: reviewBenchmarkSetSchema,
  status: reviewBenchmarkStatusSchema,
  split: reviewBenchmarkSplitSchema,
  title: line(L.title),
  pr: z.object(prShape).nullable(),
  headSha: reviewBenchmarkCommitSchema,
  targetSha: reviewBenchmarkCommitSchema,
  /** The merge base of the two, the App's own: what the PR's changes are read against. */
  baseSha: reviewBenchmarkCommitSchema,
  /** Empty: the whole PR. */
  scope: z.array(repositoryRelativePathSchema),
  /** A clean case's merge date; null for a defect. */
  mergedAt: dateSchema.nullable(),
  provenance: z.array(z.object(provenanceShape)),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};
const viewLocation = z.object(locationShape);
const labelShape = {
  /** A defect case's issues; null for a clean case, and for one in the holdout split (labelsWithheld). */
  issues: z.array(z.object({ ...issueShape, locations: z.array(viewLocation) })).nullable(),
  /** A clean case's; null for a defect, and in the holdout split. */
  cleanEvidence: text(L.evidence).nullable(),
  knownFalsePositives: z.array(z.object({ ...falsePositiveShape, location: viewLocation.optional() })).nullable(),
};

/** A case as the App keeps it: strict, so a file a newer App wrote is not read, rather than written back without what it added. */
export const reviewBenchmarkStoredCaseSchema = z.object({
  ...summaryShape,
  pr: reviewBenchmarkPrSchema.nullable(),
  provenance: z.array(reviewBenchmarkProvenanceSchema),
  issues: z.array(reviewBenchmarkIssueSchema).nullable(),
  cleanEvidence: text(L.evidence).nullable(),
  knownFalsePositives: z.array(reviewBenchmarkFalsePositiveSchema).nullable(),
  history: z.array(z.object(eventShape).strict()).max(L.history),
}).strict();
export type ReviewBenchmarkStoredCase = z.output<typeof reviewBenchmarkStoredCaseSchema>;

export const reviewBenchmarkSummarySchema = z.object(summaryShape);
export type ReviewBenchmarkSummary = z.output<typeof reviewBenchmarkSummarySchema>;
export const reviewBenchmarkCaseViewSchema = z.object({
  ...summaryShape,
  ...labelShape,
  /** The case is in the holdout split: its labels are kept from whoever reads it here, so nobody tunes against them. */
  labelsWithheld: z.boolean(),
  history: z.array(z.object(eventShape)),
});
export type ReviewBenchmarkCaseView = z.output<typeof reviewBenchmarkCaseViewSchema>;

const countSchema = z.number().int().nonnegative();
const setCountsSchema = z.object({ candidate: countSchema, confirmed: z.object({ dev: countSchema, holdout: countSchema }), withdrawn: countSchema });
export type ReviewBenchmarkSetCounts = z.output<typeof setCountsSchema>;

export const reviewBenchmarkRecordResultSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  /** processed: each case's outcome is in `cases`. repository_not_found: repositoryPath is in no Git repository; nothing written. */
  status: z.enum(["processed", "repository_not_found"]),
  repository: reviewBenchmarkRepositorySchema.nullable(),
  /** One for each case sent, in the order sent. */
  cases: z.array(z.object({
    /**
     * recorded: saved, as a candidate. duplicate: the same version (and scope) is already in the same set; nothing written,
     * caseId is that one. rejected: a check failed, said in reasons; not saved.
     */
    outcome: z.enum(["recorded", "duplicate", "rejected"]),
    caseId: z.string().nullable(),
    status: reviewBenchmarkStatusSchema.nullable(),
    split: reviewBenchmarkSplitSchema.nullable(),
    reasons: z.array(z.string()),
  })),
});
export type ReviewBenchmarkRecordResult = z.output<typeof reviewBenchmarkRecordResultSchema>;

export const reviewBenchmarkListResultSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  status: z.enum(["ok", "repository_not_found"]),
  repository: reviewBenchmarkRepositorySchema.nullable(),
  /** Every case of the repository, the filters aside. */
  counts: z.object({ defect: setCountsSchema, clean: setCountsSchema }),
  /** Cases matching the filters. */
  total: countSchema,
  nextOffset: countSchema.nullable(),
  cases: z.array(reviewBenchmarkSummarySchema),
});
export type ReviewBenchmarkListResult = z.output<typeof reviewBenchmarkListResultSchema>;

export const reviewBenchmarkGetResultSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  status: z.enum(["ok", "repository_not_found", "case_not_found"]),
  repository: reviewBenchmarkRepositorySchema.nullable(),
  case: reviewBenchmarkCaseViewSchema.nullable(),
});
export type ReviewBenchmarkGetResult = z.output<typeof reviewBenchmarkGetResultSchema>;

export const reviewBenchmarkUpdateResultSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  /**
   * saved: written. unchanged: it already stood so; nothing written. status_changed: its status is no longer
   * expectedStatus; nothing written, case is as it stands. rejected: a check failed, said in reasons; nothing written.
   */
  status: z.enum(["saved", "unchanged", "repository_not_found", "case_not_found", "status_changed", "rejected"]),
  reasons: z.array(z.string()),
  repository: reviewBenchmarkRepositorySchema.nullable(),
  case: reviewBenchmarkCaseViewSchema.nullable(),
});
export type ReviewBenchmarkUpdateResult = z.output<typeof reviewBenchmarkUpdateResultSchema>;
