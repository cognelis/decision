import { z } from "zod";
import { decisionContextResultSchema } from "./decision-context.js";
import { repositoryRelativePathSchema } from "./decision-scope.js";
import type { ModelProviderKind } from "./model.js";

export const PR_REVIEW_BATCH_MAX_CALLS = 6;

/**
 * Changed files a PR is read with: GitHub's own file list stops at 3,000. Refused past 100, a large PR (a rename, a
 * dependency bump, a generated client) could not be opened at all; code-meeseeks reads it whole and lets the model's
 * budget decide what is reviewed, the rest named as not reviewed.
 */
export const PR_REVIEW_MAX_FILES = 3_000;

/**
 * Diff characters one review group holds. A small local model reads a page at a time; a remote model or a CLI agent
 * reads most PRs whole, as PR-Agent and Claude Code do, and a larger PR in a few groups of related files.
 */
export const prReviewUnitChars = (kind: ModelProviderKind): number => (kind === "qwen" || kind === "apple" ? 4_000 : 48_000);

/**
 * Review groups, and the chunks of an overview, suggestions or verification, a model works on at once: a local model
 * one at a time, a remote model or a CLI agent three, as pr-agent runs its chunks and Claude Code its reviewers.
 */
export const prReviewLanes = (kind: ModelProviderKind): number => (kind === "qwen" || kind === "apple" ? 1 : 3);

const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^./]+$/u;
/** A test: in a tests directory, or named *.test.* / *.spec.*. */
export const isPrReviewTestPath = (path: string): boolean => TEST_FILE.test(path);
const stem = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.(?:test|spec)(?=\.[^.]+$)/u, "").replace(/\.[^.]+$/u, "");

/**
 * The order files are reviewed in: by path, so a directory's files sit together, with each file's tests right
 * after it, where one group can hold both the change and what exercises it. Shared, so the page counts a selection's
 * groups in the order the review packs them: kept in the whole PR's order, a test whose source was not picked moved.
 */
export function prReviewOrder(paths: readonly string[]): string[] {
  const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Tests by stem, looked up once per file: matched pair by pair, 3,000 files held the main process for seconds.
  const tests = new Map<string, string[]>();
  for (const path of sorted) if (TEST_FILE.test(path)) tests.set(stem(path), [...(tests.get(stem(path)) ?? []), path]);
  const placed = new Set<string>();
  const order: string[] = [];
  for (const path of sorted.filter((item) => !TEST_FILE.test(item))) {
    order.push(path);
    for (const test of tests.get(stem(path)) ?? []) if (!placed.has(test)) { placed.add(test); order.push(test); }
  }
  return [...order, ...sorted.filter((path) => TEST_FILE.test(path) && !placed.has(path))];
}

/**
 * What a file, or a piece of one, adds to a group's prompt besides its lines: `{"path":…,"lines":[…]}`. Left out, a
 * group of hundreds of one-line files (a rename across a large PR) ran past its prompt and was refused as too large.
 */
export const prReviewFileOverhead = (path: string): number => path.length + 24;

/**
 * How many groups files take — each file as its path and its hunks' diff sizes, in review order — packed as the review
 * service packs them: whole files while they fit, a larger file cut between hunks, its last piece shared with what
 * follows, each file and each piece with its place in the prompt. Only a hunk larger than a group, which the service
 * cuts line by line, is counted by size alone.
 */
export function estimatePrReviewUnits(files: Array<readonly [path: string, hunks: number[]]>, unitChars: number): number {
  let units = 0, room = 0;
  for (const [path, hunks] of files) {
    const overhead = prReviewFileOverhead(path);
    const diff = hunks.reduce((sum, hunk) => sum + hunk, 0);
    if (diff <= 0) continue;
    const size = diff + overhead;
    if (size <= room) { room -= size; continue; }
    if (size <= unitChars) { units++; room = unitChars - size; continue; }
    const limit = unitChars - overhead;
    let pieces = 0, piece = 0;
    for (const hunk of hunks) {
      if (piece && piece + hunk > limit) { pieces++; piece = 0; }
      if (hunk <= limit) { piece += hunk; continue; }
      pieces += Math.floor(hunk / limit);
      piece = hunk % limit;
    }
    units += pieces + (piece ? 1 : 0);
    room = piece ? unitChars - piece - overhead : 0;
  }
  return units;
}

export const prPlatformSchema = z.enum(["github", "gitlab", "bitbucket-server"]);
export const prConnectionSchema = z.object({
  id: z.string().uuid(), label: z.string().trim().min(1).max(100), platform: prPlatformSchema,
  baseUrl: z.string().url().max(2_000).refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      !url.username && !url.password && !url.search && !url.hash;
  }, "连接地址必须是 HTTPS，且不含凭据、查询或片段；本机回环允许 HTTP。"),
}).strict();
export const prConnectionInputSchema = prConnectionSchema.omit({ id: true }).extend({
  id: z.string().uuid().optional(), token: z.string().trim().min(1).max(4_000).optional(),
}).strict();
export const prListQuerySchema = z.object({
  connectionId: z.string().uuid(), filter: z.enum(["review-requested", "created"]).default("review-requested"),
  /** Merged PRs are history whose discussion can still be recorded; open when omitted. */
  state: z.enum(["open", "merged"]).optional(),
  /**
   * Where the list reads on from, as the platform gave it: a page number on GitHub and GitLab, an item offset plus one
   * on Bitbucket. Held to 1,000, a reviewer's merged history past about 1,000 PRs on Bitbucket could not be read further.
   */
  page: z.number().int().min(1).max(10_000_000).default(1),
}).strict();
export const prListItemSchema = z.object({
  reference: z.string().min(1).max(2_000), title: z.string().max(2_000), repository: z.string().max(1_000),
  number: z.string().regex(/^\d+$/u), author: z.string().max(300), updatedAt: z.string().max(100),
}).strict();
export const prListResponseSchema = z.object({ items: z.array(prListItemSchema).max(50), nextPage: z.number().int().positive().nullable() }).strict();
export const prReviewLoadSchema = z.object({
  connectionId: z.string().uuid(), reference: z.string().trim().min(1).max(2_000),
  /** The list's last-updated time: unchanged means nothing on the PR moved since it was cached. */
  updatedAt: z.string().max(100).optional(),
}).strict();
/** Snapshots read ahead in the background, in list order. */
export const prReviewPrefetchSchema = z.object({
  connectionId: z.string().uuid(),
  items: z.array(z.object({ reference: z.string().trim().min(1).max(2_000), updatedAt: z.string().max(100).optional() }).strict()).max(10),
}).strict();
export type PrReviewPrefetch = z.infer<typeof prReviewPrefetchSchema>;
export const prReviewProgressSchema = z.object({
  runId: z.string().uuid(), id: z.string().min(1).max(200), at: z.string().datetime(),
  kind: z.enum(["status", "model", "tool", "retry"]), status: z.enum(["running", "done", "error", "cancelled"]),
  message: z.string().max(500), detail: z.string().max(4_000).optional(),
  /**
   * Which review group (0-based) a step is from, and in a deep review which reviewer: the page shows a group's steps
   * under it. Said in every message instead ("第 2 组 · 规则与决策审查 · 检索决策完成"), it buried what the step did.
   */
  group: z.number().int().nonnegative().max(9_999).optional(),
  lens: z.enum(["bugs", "rules"]).optional(),
  /** What a search found, to read on the page and open: each decision's source, id, title, gist and note. */
  decisions: z.array(z.object({
    source: z.enum(["summarize", "decisions", "principles"]), id: z.string().max(200), title: z.string().max(200),
    summary: z.string().max(400), applicability: z.enum(["scope_match", "needs_review", "out_of_scope"]).optional(),
    relativePath: z.string().max(2_000),
    /** The other project it is filed under: the rules reviewer of a deep review reads those decisions too. */
    otherProject: z.string().max(500).optional(),
  }).strict()).max(5).optional(),
  /** Where the code a step read sits, to open in the PR's details: the file, its side, the first line read, and as diff or file. */
  code: z.object({ path: repositoryRelativePathSchema, side: z.enum(["old", "new"]), line: z.number().int().positive(), view: z.enum(["diff", "file"]) }).strict().optional(),
}).strict();
export type PrConnection = z.infer<typeof prConnectionSchema>;
export type PrConnectionInput = z.infer<typeof prConnectionInputSchema>;
export type PrListQuery = z.infer<typeof prListQuerySchema>;
export type PrListResponse = z.infer<typeof prListResponseSchema>;
export type PrListItem = z.infer<typeof prListItemSchema>;

export const prReviewSnapshotSchema = z.object({
  snapshotId: z.string().uuid(),
  batchCount: z.number().int().nonnegative().optional(),
  reference: z.string().max(2_000),
  title: z.string().max(2_000),
  description: z.string().max(20_000),
  project: z.string().max(500),
  sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  destinationCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  /** Where the diff starts (the merge base) when it is not the target's tip: the old side's lines are this commit's. */
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u).optional(),
  files: z.array(z.object({ path: repositoryRelativePathSchema, status: z.string().max(100) }).strict()).max(PR_REVIEW_MAX_FILES),
  /** Lockfiles and minified/source-map output among `files`: not sent to the model, in review batches or in answers. */
  skippedFiles: z.array(repositoryRelativePathSchema).max(PR_REVIEW_MAX_FILES).optional(),
  /** Review batches per file with a text diff to review, so a partial selection can say what it costs. */
  fileBatches: z.record(repositoryRelativePathSchema, z.number().int().positive()).optional(),
  /** Each reviewable file's hunk sizes in diff characters, files in review order: how many groups a review takes, for any model. */
  fileHunks: z.record(repositoryRelativePathSchema, z.array(z.number().int().positive()).min(1).max(5_000)).optional(),
  /** A short digest of each file's diff: equal digests on two snapshots mean that file's change did not move between them. */
  fileDigests: z.record(repositoryRelativePathSchema, z.string().regex(/^[a-f0-9]{16}$/u)).optional(),
  /**
   * How large the change is, lockfiles and generated files left out: lines added and removed, and how many changed files
   * are tests and how many other code — pr-agent's "relevant tests", counted rather than asked.
   */
  changeSize: z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(), testFiles: z.number().int().nonnegative(), codeFiles: z.number().int().nonnegative() }).strict().optional(),
  warnings: z.array(z.string().max(2_000)).max(100),
  /** Local review rules (code-meeseeks format) matched to this PR; their text stays in the main process. */
  rules: z.array(z.object({ id: z.string().max(500), source: z.enum(["decision", "code-meeseeks"]) }).strict()).max(20).optional(),
  /** The repository's own guides (CLAUDE.md, AGENTS.md) at the source commit; their text stays in the main process. */
  guides: z.array(repositoryRelativePathSchema).max(4).optional(),
  /** How many existing PR comments the review is told about, so it does not repeat them. */
  existingComments: z.number().int().positive().max(20).optional(),
}).strict();
/**
 * A finding the reviewer did not take, and why: a later review of the repository is told not to raise its like, and its
 * verification sets such a candidate aside, as Greptile learns from what a team turns down.
 */
export const prReviewDismissedSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(2_000),
  path: repositoryRelativePathSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();
/**
 * A finding the reviewer put on a PR as a comment: a later review of the repository is told the team cares about its
 * like, and its verification does not set such a candidate aside as a nitpick, as Greptile learns from what a team takes.
 */
export const prReviewPublishedSchema = z.object({
  title: z.string().trim().min(1).max(200),
  path: repositoryRelativePathSchema,
}).strict();
export const prReviewRunSchema = z.object({
  snapshotId: z.string().uuid(),
  runId: z.string().uuid(),
  profileId: z.string().trim().min(1).max(200),
  focus: z.string().trim().max(2_000).default(""),
  /** Only these files are reviewed; absent, every file. */
  paths: z.array(repositoryRelativePathSchema).min(1).max(PR_REVIEW_MAX_FILES).optional(),
  /** Claude Code's parallel reviewers: "deep" adds one who reads each group only for the team's rules and past decisions. */
  depth: z.enum(["standard", "deep"]).optional(),
  /** What the reviewer did not take in the repository's earlier reviews, newest first. */
  dismissed: z.array(prReviewDismissedSchema).max(20).optional(),
  /** What the reviewer put on the repository's PRs as comments in earlier reviews, newest first. */
  published: z.array(prReviewPublishedSchema).max(20).optional(),
}).strict();
export const prReviewFindingSchema = z.object({
  priority: z.enum(["P1", "P2", "P3"]),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2_000),
  path: repositoryRelativePathSchema,
  side: z.enum(["old", "new"]),
  line: z.number().int().positive(),
  decisionIndexes: z.array(z.number().int().positive()).max(5),
}).strict();
/**
 * What model calls reported spending. A call that failed or reported nothing counts in
 * `unreportedCalls`, which makes the totals a floor; `cost` only when the backend has the reader's price.
 */
export const prReviewUsageSchema = z.object({
  input: z.number().int().nonnegative().max(100_000_000),
  output: z.number().int().nonnegative().max(100_000_000),
  unreportedCalls: z.number().int().nonnegative().max(100_000),
  cost: z.object({ currency: z.string().min(1).max(8), amount: z.number().nonnegative().max(1_000_000) }).strict().optional(),
}).strict();
export type PrReviewUsage = z.infer<typeof prReviewUsageSchema>;
export const prReviewReportSchema = z.object({
  status: z.enum(["completed", "incomplete", "cancelled", "failed", "stale"]),
  summary: z.string().max(4_000),
  findings: z.array(prReviewFindingSchema).max(200),
  evidence: z.array(z.object({ index: z.number().int().positive(), record: decisionContextResultSchema }).strict()).max(40),
  readFiles: z.array(repositoryRelativePathSchema).max(PR_REVIEW_MAX_FILES),
  unreadFiles: z.array(repositoryRelativePathSchema).max(PR_REVIEW_MAX_FILES),
  reviewedFiles: z.array(repositoryRelativePathSchema).max(PR_REVIEW_MAX_FILES).default([]),
  unreviewedFiles: z.array(repositoryRelativePathSchema).max(PR_REVIEW_MAX_FILES).default([]),
  warnings: z.array(z.string().max(2_000)).max(100),
  steps: z.number().int().nonnegative(),
  usage: prReviewUsageSchema.optional(),
  history: z.array(prReviewProgressSchema).max(2_000).default([]),
  /** How many groups of related files the review read the PR in. */
  groups: z.number().int().nonnegative().optional(),
  /** The PR's brief in a line, when the review wrote one (a large PR, read in groups). */
  overview: z.string().max(1_000).optional(),
  /**
   * Each group's conclusion, by its files and reviewer: the page lists them, where `summary` (kept for export and the PR
   * comment) ran them into one text.
   */
  conclusions: z.array(z.object({ label: z.string().max(600), lens: z.enum(["bugs", "rules"]).optional(), text: z.string().max(4_000) }).strict()).max(500).optional(),
  /** A deep review: two reviewers read each group, one for defects, one for the team's rules and past decisions. */
  depth: z.literal("deep").optional(),
  /** Candidates the verification pass scored below the bar (Claude Code's 80 of 100): left out of `findings`, kept with why. */
  filtered: z.array(z.object({
    finding: prReviewFindingSchema, score: z.number().int().min(0).max(100), reason: z.string().max(1_000),
  }).strict()).max(200).optional(),
}).strict();
export type PrReviewLoad = z.infer<typeof prReviewLoadSchema>;
export type PrReviewSnapshot = z.infer<typeof prReviewSnapshotSchema>;
export type PrReviewRun = z.infer<typeof prReviewRunSchema>;
export type PrReviewDismissed = z.infer<typeof prReviewDismissedSchema>;
export type PrReviewPublished = z.infer<typeof prReviewPublishedSchema>;
export type PrReviewFinding = z.infer<typeof prReviewFindingSchema>;
export type PrReviewReport = z.infer<typeof prReviewReportSchema>;
export type PrReviewProgress = z.infer<typeof prReviewProgressSchema>;

export const prReviewFollowUpSchema = z.object({
  runId: z.string().uuid(), profileId: z.string().trim().min(1).max(200),
  /** Lets the pinned diff be found again once the snapshot has left memory. */
  connectionId: z.string().uuid().optional(),
  snapshot: prReviewSnapshotSchema,
  /** Absent for a PR asked about without a review: an overview or suggestions straight away. */
  report: prReviewReportSchema.omit({ history: true }).optional(),
  excerpts: z.string().max(12000),
  focus: z.string().max(2000).optional(),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) }).strict()).max(12),
  question: z.string().trim().min(1).max(2000),
  /** A PR overview (/describe) or improvement suggestions (/improve): run as their own pipelines over the whole PR. */
  command: z.enum(["describe", "improve"]).optional(),
}).strict();
export const prReviewFollowUpResponseSchema = z.object({ answer: z.string().trim().min(1).max(8000) }).strict();
/** The answer as the renderer gets it: the model's output plus what the call spent. */
export const prReviewFollowUpResultSchema = z.object({ answer: z.string().trim().min(1).max(8000), usage: prReviewUsageSchema.optional() }).strict();
export type PrReviewFollowUpResult = z.infer<typeof prReviewFollowUpResultSchema>;
export type PrReviewFollowUp = z.infer<typeof prReviewFollowUpSchema>;
export type PrReviewFollowUpResponse = z.infer<typeof prReviewFollowUpResponseSchema>;

/** code-meeseeks' re-evaluation: one finding is judged again and kept, replaced or dropped. */
export const prReviewReevaluateSchema = z.object({
  runId: z.string().uuid(), profileId: z.string().trim().min(1).max(200),
  connectionId: z.string().uuid().optional(),
  snapshot: prReviewSnapshotSchema,
  finding: prReviewFindingSchema,
  summary: z.string().max(4_000),
  focus: z.string().max(2_000).optional(),
  /** The commit an earlier review raised this finding on: the question becomes whether it is still there. */
  earlierCommit: prReviewSnapshotSchema.shape.sourceCommit.optional(),
}).strict();
export const prReviewVerdictSchema = z.object({
  verdict: z.enum(["keep", "replace", "drop"]),
  reason: z.string().trim().min(1).max(2_000),
  replacement: z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(2_000) }).strict().nullable(),
}).strict();
export type PrReviewReevaluate = z.infer<typeof prReviewReevaluateSchema>;
export type PrReviewVerdict = z.infer<typeof prReviewVerdictSchema>;


/** Diff browsing stays pinned to the commits of the visible review. */
export const prReviewDiffRequestSchema = prReviewLoadSchema.extend({
  sourceCommit: prReviewSnapshotSchema.shape.sourceCommit,
  destinationCommit: prReviewSnapshotSchema.shape.destinationCommit,
}).strict();
export const prReviewDiffResponseSchema = z.object({ diff: z.string().max(2 * 1024 * 1024) }).strict();
export type PrReviewDiffRequest = z.infer<typeof prReviewDiffRequestSchema>;
export type PrReviewDiffResponse = z.infer<typeof prReviewDiffResponseSchema>;

export const prReviewFileRequestSchema = prReviewDiffRequestSchema.extend({ path: repositoryRelativePathSchema, side: z.enum(["old", "new"]) }).strict();
export const prReviewFileResponseSchema = z.object({ content: z.string().max(2 * 1024 * 1024), binary: z.boolean() }).strict();
export type PrReviewFileRequest = z.infer<typeof prReviewFileRequestSchema>;
export type PrReviewFileResponse = z.infer<typeof prReviewFileResponseSchema>;

export const prActionContextSchema = prReviewDiffRequestSchema.extend({
  platform: prPlatformSchema,
  title: z.string().max(2000),
  sourceBranch: z.string().min(1).max(500),
  destinationBranch: z.string().min(1).max(500),
  state: z.enum(["open", "closed", "merged"]),
  version: z.number().int().nonnegative().optional(),
  reviewerSlug: z.string().min(1).max(300).optional(),
  canReview: z.boolean(),
}).strict();
export const prActionRequestSchema = prReviewDiffRequestSchema.extend({
  action: z.enum(["approve", "need-work", "merge"]),
  body: z.string().trim().max(10000).default(""),
  mergeMethod: z.enum(["merge", "squash", "rebase"]).default("merge"),
  sourceBranch: z.string().min(1).max(500),
  destinationBranch: z.string().min(1).max(500),
}).strict();
export const prActionResultSchema = z.object({ action: z.enum(["approve", "need-work", "merge"]), message: z.string().max(2000) }).strict();
export type PrActionContext = z.infer<typeof prActionContextSchema>;
export type PrActionRequest = z.infer<typeof prActionRequestSchema>;
export type PrActionResult = z.infer<typeof prActionResultSchema>;

/** A finding the reviewer edited and chose to post, anchored to a changed line of the reviewed commits. */
export const prReviewCommentRequestSchema = prReviewDiffRequestSchema.extend({
  path: repositoryRelativePathSchema,
  side: z.enum(["old", "new"]),
  line: z.number().int().positive(),
  body: z.string().trim().min(1).max(10_000),
}).strict();
export const prReviewCommentResultSchema = z.object({ message: z.string().max(2_000) }).strict();
export type PrReviewCommentRequest = z.infer<typeof prReviewCommentRequestSchema>;
export type PrReviewCommentResult = z.infer<typeof prReviewCommentResultSchema>;

/** A comment on the PR as a whole (an overview, suggestions, an answer), posted only after the reader confirms it. */
export const prGeneralCommentRequestSchema = prReviewDiffRequestSchema.extend({
  body: z.string().trim().min(1).max(10_000),
}).strict();
export type PrGeneralCommentRequest = z.infer<typeof prGeneralCommentRequestSchema>;

/** A comment already on the PR, the link to read it there, and the decision recorded from it, if any. */
export const prDiscussionCommentSchema = z.object({
  id: z.string().min(1).max(200), url: z.string().url().max(2_000),
  author: z.string().max(300), path: z.string().max(2_000).nullable(), line: z.number().int().nullable(),
  body: z.string().max(8_000), createdAt: z.string().max(100),
  decisionId: z.string().max(200).nullable(),
}).strict();
/** `more` when older comments were left unread. */
export const prDiscussionSchema = z.object({ comments: z.array(prDiscussionCommentSchema).max(500), more: z.boolean() }).strict();
export type PrDiscussionComment = z.infer<typeof prDiscussionCommentSchema>;
export type PrDiscussion = z.infer<typeof prDiscussionSchema>;
