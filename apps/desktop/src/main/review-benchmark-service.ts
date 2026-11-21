import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { resolveDecisionRepository } from "@cognelis/decision-integrations";
import {
  REVIEW_BENCHMARK_FIELDS,
  REVIEW_BENCHMARK_LABELS,
  REVIEW_BENCHMARK_LIMITS,
  REVIEW_BENCHMARK_VERSION,
  reviewBenchmarkCaseViewSchema,
  reviewBenchmarkRepositorySchema,
  reviewBenchmarkStoredCaseSchema,
  reviewBenchmarkSummarySchema,
  type DecisionRepository,
  type ReviewBenchmarkCaseInput,
  type ReviewBenchmarkCaseView,
  type ReviewBenchmarkFalsePositive,
  type ReviewBenchmarkGetRequest,
  type ReviewBenchmarkGetResult,
  type ReviewBenchmarkIssue,
  type ReviewBenchmarkListRequest,
  type ReviewBenchmarkListResult,
  type ReviewBenchmarkLocation,
  type ReviewBenchmarkRecordRequest,
  type ReviewBenchmarkRecordResult,
  type ReviewBenchmarkRepository,
  type ReviewBenchmarkSet,
  type ReviewBenchmarkSetCounts,
  type ReviewBenchmarkSplit,
  type ReviewBenchmarkStoredCase,
  type ReviewBenchmarkUpdateRequest,
  type ReviewBenchmarkUpdateResult,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import { atomicWrite } from "./atomic-write.js";
import { LocalReviewGit } from "./local-review-git.js";

/**
 * 评审评测集（docs/review-collaboration-design.md「评测集」）：每个仓库一个 JSON 文件，在 App 的本机数据里，不进 Vault
 * （笔记检索会把留出集的答案交给 agent），也不进仓库。样本只存引用和标注；录入和改标注时，提交、行号都按本地仓库核对。
 */

/** What a replay reads at most of one PR's patch, as a review on a platform does (scripts/replay-pr-review.mjs). */
const REPLAY_DIFF_BYTES = 2 * 1024 * 1024;
/** About a third of the cases are held out: those whose hash starts with a byte below this. */
const HOLDOUT_BELOW = 86;
/** Changing these changes the answer the user checked: a confirmed case goes back to a candidate. */
const ANSWER_FIELDS: ReadonlySet<string> = new Set(["issues", "cleanEvidence", "knownFalsePositives", "mergedAt"]);

const storeSchema = z.object({
  reviewBenchmarkVersion: z.literal(REVIEW_BENCHMARK_VERSION),
  repository: reviewBenchmarkRepositorySchema.strict(),
  cases: z.array(reviewBenchmarkStoredCaseSchema),
}).strict();
type Store = z.output<typeof storeSchema>;

type Git = Pick<LocalReviewGit, "commitExists" | "mergeBase" | "diffPaths" | "diffBytes" | "lineCount">;
interface Version { headSha: string; baseSha: string; scope: readonly string[] }
interface Labels { issues: readonly ReviewBenchmarkIssue[] | null; knownFalsePositives: readonly ReviewBenchmarkFalsePositive[] | null; mergedAt: string | null }

const { set: SET, status: STATUS } = REVIEW_BENCHMARK_LABELS;
const short = (commit: string) => commit.slice(0, 12);
const digest = (seed: string, key: string) => createHash("sha256").update(`${seed}\n${key}`).digest();
/** One case per repository, version and scope: the same PR sent again (say after a timeout) is the one already kept. */
const caseKey = (repositoryId: string, headSha: string, scope: readonly string[]) => [repositoryId, headSha, ...[...new Set(scope)].sort()].join("\n");
const caseIdOf = (key: string) => `case-${digest("paraself-review-benchmark-case-v1", key).toString("hex").slice(0, 12)}`;
/** Fixed by what the case is: nobody picks which cases are held out, and one sent again lands where it did. */
const splitOf = (key: string): ReviewBenchmarkSplit => (digest("paraself-review-benchmark-split-v1", key)[0]! < HOLDOUT_BELOW ? "holdout" : "dev");
const localDay = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const repositoryOf = ({ id, project }: DecisionRepository): ReviewBenchmarkRepository => ({ id, project });
const labelsOf = (item: ReviewBenchmarkCaseInput | ReviewBenchmarkStoredCase): Labels => "split" in item
  ? { issues: item.issues, knownFalsePositives: item.knownFalsePositives, mergedAt: item.mergedAt }
  : item.set === "defect"
    ? { issues: item.issues, knownFalsePositives: null, mergedAt: null }
    : { issues: null, knownFalsePositives: item.knownFalsePositives, mergedAt: item.mergedAt };

const summaryOf = (item: ReviewBenchmarkStoredCase) => reviewBenchmarkSummarySchema.parse(item);
/** A held-out case's labels, and what was said about it, are kept from whoever reads it here: nobody tunes against them. */
const viewOf = (item: ReviewBenchmarkStoredCase): ReviewBenchmarkCaseView => {
  const withheld = item.split === "holdout";
  return reviewBenchmarkCaseViewSchema.parse({
    ...summaryOf(item),
    issues: withheld ? null : item.issues,
    cleanEvidence: withheld ? null : item.cleanEvidence,
    knownFalsePositives: withheld ? null : item.knownFalsePositives,
    labelsWithheld: withheld,
    history: withheld ? item.history.map((event) => ({ ...event, note: null, userConfirmation: null, reason: null })) : item.history,
  });
};
const emptyCounts = (): ReviewBenchmarkSetCounts => ({ candidate: 0, confirmed: { dev: 0, holdout: 0 }, withdrawn: 0 });

/** `work` over every item, four at a time, each result at its item's place: a batch's Git reads, not all at once. */
const inLanes = async <T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  }));
  return results;
};

export interface ReviewBenchmarkServiceOptions {
  git?: Git;
  now?: () => Date;
  locate?: (directory: string) => Promise<DecisionRepository | null>;
}

export class ReviewBenchmarkService {
  readonly #directory: string;
  readonly #git: Git;
  readonly #now: () => Date;
  readonly #locate: (directory: string) => Promise<DecisionRepository | null>;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(directory: string, options: ReviewBenchmarkServiceOptions = {}) {
    this.#directory = directory;
    this.#git = options.git ?? new LocalReviewGit();
    this.#now = options.now ?? (() => new Date());
    this.#locate = options.locate ?? resolveDecisionRepository;
  }

  async record(request: ReviewBenchmarkRecordRequest): Promise<ReviewBenchmarkRecordResult> {
    const found = await this.#locate(request.repositoryPath);
    if (found === null) return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "repository_not_found", repository: null, cases: [] };
    return this.#serialized(async () => {
      const store = await this.#read(found);
      const keyed = request.cases.map((input) => {
        const key = caseKey(found.id, input.headSha, input.scope ?? []);
        return { input, key, id: caseIdOf(key) };
      });
      const known = new Set(store.cases.map((item) => item.id));
      const checked = await inLanes(keyed, ({ input, id }) => (known.has(id) ? Promise.resolve(null) : this.#checkCase(request.repositoryPath, input)));
      const at = this.#now().toISOString();
      const cases = keyed.map(({ input, key, id }, index): ReviewBenchmarkRecordResult["cases"][number] => {
        const existing = store.cases.find((item) => item.id === id);
        if (existing !== undefined) {
          return existing.set === input.set
            ? { outcome: "duplicate", caseId: id, status: existing.status, split: existing.split, reasons: [] }
            : { outcome: "rejected", caseId: null, status: null, split: null, reasons: [`这个版本已经作为${SET[existing.set]}样本录入（${id}），同一个版本不能既有问题又是干净的`] };
        }
        const check = checked[index]!;
        if ("reasons" in check) return { outcome: "rejected", caseId: null, status: null, split: null, reasons: check.reasons };
        store.cases.push({
          id,
          set: input.set,
          status: "candidate",
          split: splitOf(key),
          title: input.title,
          pr: input.pr ?? null,
          headSha: input.headSha,
          targetSha: input.targetSha,
          baseSha: check.baseSha,
          scope: [...new Set(input.scope ?? [])],
          mergedAt: input.set === "clean" ? input.mergedAt : null,
          provenance: input.provenance,
          issues: input.set === "defect" ? input.issues : null,
          cleanEvidence: input.set === "clean" ? input.cleanEvidence : null,
          knownFalsePositives: input.set === "clean" ? input.knownFalsePositives : null,
          createdAt: at,
          updatedAt: at,
          history: [{ at, by: { kind: "agent", client: request.sourceClient }, previous: null, status: "candidate", changed: [], note: null, userConfirmation: null, reason: null }],
        });
        return { outcome: "recorded", caseId: id, status: "candidate", split: splitOf(key), reasons: [] };
      });
      if (cases.some((item) => item.outcome === "recorded")) await this.#write(store);
      return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "processed", repository: repositoryOf(found), cases };
    });
  }

  async list(request: ReviewBenchmarkListRequest): Promise<ReviewBenchmarkListResult> {
    const counts = { defect: emptyCounts(), clean: emptyCounts() };
    const found = await this.#locate(request.repositoryPath);
    if (found === null) return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "repository_not_found", repository: null, counts, total: 0, nextOffset: null, cases: [] };
    const { cases } = await this.#read(found);
    for (const item of cases) {
      if (item.status === "confirmed") counts[item.set].confirmed[item.split] += 1;
      else counts[item.set][item.status] += 1;
    }
    const matching = cases
      .filter((item) => (request.set === undefined || item.set === request.set)
        && (request.status === undefined || item.status === request.status)
        && (request.headSha === undefined || item.headSha === request.headSha)
        && (request.provenance === undefined || item.provenance.some((source) => source.reference === request.provenance)))
      .sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
    const page = matching.slice(request.offset, request.offset + request.limit);
    const end = request.offset + page.length;
    return {
      reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION,
      status: "ok",
      repository: repositoryOf(found),
      counts,
      total: matching.length,
      nextOffset: end < matching.length ? end : null,
      cases: page.map(summaryOf),
    };
  }

  async get(request: ReviewBenchmarkGetRequest): Promise<ReviewBenchmarkGetResult> {
    const found = await this.#locate(request.repositoryPath);
    if (found === null) return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "repository_not_found", repository: null, case: null };
    const item = (await this.#read(found)).cases.find((stored) => stored.id === request.caseId);
    return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: item === undefined ? "case_not_found" : "ok", repository: repositoryOf(found), case: item === undefined ? null : viewOf(item) };
  }

  async update(request: ReviewBenchmarkUpdateRequest): Promise<ReviewBenchmarkUpdateResult> {
    const found = await this.#locate(request.repositoryPath);
    const answer = (status: ReviewBenchmarkUpdateResult["status"], reasons: string[], item: ReviewBenchmarkStoredCase | null = null): ReviewBenchmarkUpdateResult => ({
      reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status, reasons, repository: found === null ? null : repositoryOf(found), case: item === null ? null : viewOf(item),
    });
    if (found === null) return answer("repository_not_found", []);
    return this.#serialized(async () => {
      const store = await this.#read(found);
      const index = store.cases.findIndex((item) => item.id === request.caseId);
      const current = store.cases[index];
      if (current === undefined) return answer("case_not_found", []);
      if (current.status !== request.expectedStatus) {
        return answer("status_changed", [`这个样本现在是「${STATUS[current.status]}」，不是 expectedStatus 的「${STATUS[request.expectedStatus]}」，先重新读取再决定`], current);
      }
      const foreign = (current.set === "defect" ? (["mergedAt", "cleanEvidence", "knownFalsePositives"] as const) : (["issues"] as const))
        .filter((field) => request[field] !== undefined);
      if (foreign.length > 0) {
        return answer("rejected", [`${foreign.join("、")} 只用于${SET[current.set === "defect" ? "clean" : "defect"]}样本，这个样本属于${SET[current.set]}`], current);
      }
      const changed = REVIEW_BENCHMARK_FIELDS.filter((field) => request[field] !== undefined && !isDeepStrictEqual(request[field], current[field]));
      const next: ReviewBenchmarkStoredCase = { ...current, ...Object.fromEntries(changed.map((field) => [field, request[field]])) };
      if (changed.some((field) => field === "issues" || field === "knownFalsePositives" || field === "mergedAt")) {
        const reasons = await this.#checkLabels(request.repositoryPath, next, labelsOf(next));
        if (reasons.length > 0) return answer("rejected", reasons, current);
      }
      const status = request.status ?? (current.status === "confirmed" && changed.some((field) => ANSWER_FIELDS.has(field)) ? "candidate" : current.status);
      const note = request.note ?? null;
      if (status === current.status && changed.length === 0 && (note === null || current.history.at(-1)?.note === note)) return answer("unchanged", [], current);
      const at = this.#now().toISOString();
      next.status = status;
      next.updatedAt = at;
      next.history = [...current.history, {
        at, by: { kind: "agent" as const, client: request.sourceClient }, previous: current.status, status, changed, note,
        userConfirmation: request.userConfirmation ?? null, reason: request.reason ?? null,
      }].slice(-REVIEW_BENCHMARK_LIMITS.history);
      store.cases[index] = next;
      await this.#write(store);
      return answer("saved", [], next);
    });
  }

  /**
   * The confirmed cases of one split, labels and all, for a replay to run and score (scripts/replay-pr-review.mjs
   * export-benchmark). Never reached from the MCP tools: the holdout split's answers stay out of an agent's reach.
   */
  async exportCases(repositoryPath: string, split: ReviewBenchmarkSplit, set?: ReviewBenchmarkSet): Promise<{ repository: ReviewBenchmarkRepository; cases: ReviewBenchmarkStoredCase[] } | null> {
    const found = await this.#locate(repositoryPath);
    if (found === null) return null;
    const { cases } = await this.#read(found);
    return { repository: repositoryOf(found), cases: cases.filter((item) => item.status === "confirmed" && item.split === split && (set === undefined || item.set === set)) };
  }

  async #checkCase(directory: string, input: ReviewBenchmarkCaseInput): Promise<{ baseSha: string } | { reasons: string[] }> {
    const scope = input.scope ?? [];
    const [head, target] = await Promise.all([this.#git.commitExists(directory, input.headSha), this.#git.commitExists(directory, input.targetSha)]);
    const missing = [...(head ? [] : [`headSha ${short(input.headSha)}`]), ...(target ? [] : [`targetSha ${short(input.targetSha)}`])];
    if (missing.length > 0) return { reasons: [`${missing.join(" 和 ")} 在这个仓库里不存在：提交号要写完整，本地仓库要已经 fetch 到它`] };
    const baseSha = await this.#git.mergeBase(directory, input.headSha, input.targetSha);
    if (baseSha === null) return { reasons: ["headSha 和 targetSha 没有共同的历史：targetSha 要用当时的目标分支"] };
    const [paths, size] = await Promise.all([this.#git.diffPaths(directory, baseSha, input.headSha), this.#git.diffBytes(directory, baseSha, input.headSha)]);
    if (paths.length === 0) return { reasons: ["headSha 相对 targetSha 没有改动，它已经在目标分支的历史里：targetSha 要用合并之前的目标分支"] };
    const reasons: string[] = [];
    if (size === null || size > REPLAY_DIFF_BYTES) reasons.push("这个 PR 的改动超过 2 MiB，回放读不了它");
    const changed = new Set(paths);
    const outside = scope.filter((path) => !changed.has(path));
    if (outside.length > 0) reasons.push(`scope 里的 ${outside.join("、")} 不是这个 PR 改过的文件`);
    if (reasons.length > 0) return { reasons };
    const labelReasons = await this.#checkLabels(directory, { headSha: input.headSha, baseSha, scope }, labelsOf(input));
    return labelReasons.length > 0 ? { reasons: labelReasons } : { baseSha };
  }

  /** Each issue's lines are there, its fixes are not yet in the PR's version, and a clean case's merge is not in the future. */
  async #checkLabels(directory: string, version: Version, labels: Labels): Promise<string[]> {
    const lines = new Map<string, Promise<number | null>>();
    const lineCount = (commit: string, path: string) => {
      const key = `${commit}:${path}`;
      if (!lines.has(key)) lines.set(key, this.#git.lineCount(directory, commit, path));
      return lines.get(key)!;
    };
    const located = async (where: string, location: ReviewBenchmarkLocation): Promise<string | null> => {
      if (version.scope.length > 0 && !version.scope.includes(location.path)) return `${where}的 ${location.path} 不在 scope 里：评审只看 scope 里的文件`;
      const side = location.side === "new" ? "PR 的版本（headSha）" : "PR 之前的版本（合并基点）";
      const count = await lineCount(location.side === "new" ? version.headSha : version.baseSha, location.path);
      if (count === null) return `${where}的 ${location.path} 在${side}里不存在，或不是文本文件`;
      return location.endLine > count ? `${where}的 ${location.path} 第 ${location.startLine}–${location.endLine} 行超出范围：${side}只有 ${count} 行` : null;
    };
    const fixed = async (where: string, fix: string): Promise<string | null> => {
      if (!(await this.#git.commitExists(directory, fix))) return `${where}的修复提交 ${short(fix)} 在这个仓库里不存在`;
      return (await this.#git.mergeBase(directory, fix, version.headSha)) === fix
        ? `${where}的修复提交 ${short(fix)} 已经包含在 headSha 里：headSha 要选修复之前、问题还在的版本`
        : null;
    };
    const checks: Promise<string | null>[] = [];
    labels.issues?.forEach((issue, index) => {
      for (const location of issue.locations) checks.push(located(`issues 第 ${index + 1} 个`, location));
      for (const fix of new Set(issue.fixShas)) checks.push(fixed(`issues 第 ${index + 1} 个`, fix));
    });
    labels.knownFalsePositives?.forEach((item, index) => {
      if (item.location !== undefined) checks.push(located(`knownFalsePositives 第 ${index + 1} 个`, item.location));
    });
    const reasons = (await Promise.all(checks)).filter((reason): reason is string => reason !== null);
    if (labels.mergedAt !== null && labels.mergedAt > localDay(this.#now())) reasons.push(`mergedAt ${labels.mergedAt} 晚于今天`);
    return [...new Set(reasons)];
  }

  /** Changes one after another, each reading what the last wrote. ponytail: one queue for every repository's file. */
  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  #file(repositoryId: string): string {
    return join(this.#directory, `${repositoryId.slice("repo:".length)}.json`);
  }

  async #read(repository: DecisionRepository): Promise<Store> {
    let raw: string;
    try {
      raw = await readFile(this.#file(repository.id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repository: repositoryOf(repository), cases: [] };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    const parsed = storeSchema.safeParse(value);
    // Not written back over: a newer App's file keeps what it added, a damaged one stays for whoever looks at it.
    if (!parsed.success) throw new Error("这个仓库的评测集文件读不了：可能是更新版本的 Paraself 写的，或者已经损坏；这次没有改动它。");
    return parsed.data;
  }

  async #write(store: Store): Promise<void> {
    await atomicWrite(this.#file(store.repository.id), `${JSON.stringify(store, null, 2)}\n`);
  }
}
