import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  REVIEW_BENCHMARK_VERSION,
  modelKindSupportsGeneration,
  reviewBenchmarkRunSchema,
  type PrReviewFinding,
  type PrReviewReport,
  type PrReviewRun,
  type PrReviewSnapshot,
  type RetrievalAnswerProvider,
  type ReviewBenchmarkComparison,
  type ReviewBenchmarkRun,
  type ReviewBenchmarkRunCase,
  type ReviewBenchmarkRunRequest,
  type ReviewBenchmarkRunResult,
  type ReviewBenchmarkRunsResult,
  type ReviewBenchmarkRunStart,
  type ReviewBenchmarkRunSummary,
  type ReviewBenchmarkRunTotals,
  type ReviewBenchmarkSplit,
  type ReviewBenchmarkStoredCase,
} from "@cognelis/decision-protocol";

import { atomicWrite } from "./atomic-write.js";
import type { PrReviewClient } from "./pr-platform-client.js";
import { mergeBase, replayClient, repositoryRoot } from "./review-benchmark-replay.js";

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
const label = (model: RetrievalAnswerProvider) => [model.label, model.model].filter(Boolean).join(" · ");
/** The link a replayed case is loaded under: none of the user's. */
const REPLAY_CONNECTION = "00000000-0000-4000-8000-00000000be0c";

/** A review service as the App's own: its gateway, decisions and rules, reading the PR from `client`. */
export interface BenchmarkReviewer {
  load(input: { connectionId: string; reference: string }): Promise<PrReviewSnapshot>;
  run(input: PrReviewRun): Promise<PrReviewReport>;
  cancel(runId: string): void;
}
export interface ReviewBenchmarkRunSources {
  /** Where the runs are kept, one file each. */
  directory: string;
  /** The confirmed cases of a repository's split, with their answers (ReviewBenchmarkService.exportCases). */
  cases(repositoryPath: string, split: ReviewBenchmarkSplit, set?: "defect" | "clean"): Promise<{ repository: { id: string; project: string }; cases: ReviewBenchmarkStoredCase[] } | null>;
  models(): Promise<RetrievalAnswerProvider[]>;
  reviewer(client: PrReviewClient, onCandidates: (findings: PrReviewFinding[]) => void): BenchmarkReviewer;
  /** The runs that changed, for the page to read again. */
  changed?(id: string): void;
  now?(): number;
}

type Place = { path: string; side: "old" | "new"; startLine: number; endLine: number };
/** A finding on the place, three lines either side: as a replay judge first looks. */
const near = (finding: { path: string; side: string; line: number }, place: Place) =>
  finding.path === place.path && finding.side === place.side && finding.line >= place.startLine - 3 && finding.line <= place.endLine + 3;
const findingsOf = (report: PrReviewReport, candidates: readonly PrReviewFinding[]) => {
  const key = (item: PrReviewFinding) => `${item.path}\n${item.line}\n${item.title}`;
  const kept = new Set(report.findings.map(key));
  return [...report.findings.map((item) => ({ item, kept: true })), ...candidates.filter((item) => !kept.has(key(item))).map((item) => ({ item, kept: false }))]
    .slice(0, 50).map(({ item, kept: was }) => ({ title: item.title.slice(0, 300), priority: item.priority, path: item.path, side: item.side, line: item.line, body: item.body.slice(0, 600), kept: was }));
};

/** A run's totals over its cases done. */
export const runTotals = (run: Pick<ReviewBenchmarkRun, "cases" | "fixControl">): ReviewBenchmarkRunTotals => {
  const done = run.cases.filter((item) => item.state === "done");
  const defect = done.filter((item) => item.set === "defect"), clean = done.filter((item) => item.set === "clean");
  const sum = (items: readonly ReviewBenchmarkRunCase[], value: (item: ReviewBenchmarkRunCase) => number) => items.reduce((total, item) => total + value(item), 0);
  const verdicts = (verdict: string) => sum(clean, (item) => item.judgments.filter((judgment) => judgment.verdict === verdict).length);
  const findings = sum(clean, (item) => item.findings.filter((finding) => finding.kept).length);
  const judged = sum(clean, (item) => item.judgments.length);
  return {
    defect: { cases: defect.length, issues: sum(defect, (item) => item.issues), hit: sum(defect, (item) => item.hit), lost: sum(defect, (item) => item.lost),
      fixReported: run.fixControl ? sum(defect, (item) => item.fixReported ?? 0) : null },
    clean: { cases: clean.length, findings, harmful: verdicts("harmful"), noise: verdicts("noise"), valid: verdicts("valid"), unjudged: findings - judged, knownRepeats: sum(clean, (item) => item.knownRepeats) },
    done: done.length, failed: run.cases.filter((item) => item.state === "failed").length, total: run.cases.length,
  };
};
export const runSummary = ({ cases, ...run }: ReviewBenchmarkRun): ReviewBenchmarkRunSummary => ({ ...run, totals: runTotals({ cases, fixControl: run.fixControl }) });

/**
 * The gate (闸门) on the cases both runs finished: recall first, then harm. Not to be taken while a clean finding of
 * either is unjudged; below twenty cases, counts only.
 */
export const compareRuns = (before: ReviewBenchmarkRun, after: ReviewBenchmarkRun): ReviewBenchmarkComparison => {
  const finished = (run: ReviewBenchmarkRun) => new Set(run.cases.filter((item) => item.state === "done").map((item) => item.caseId));
  const both = [...finished(after)].filter((id) => finished(before).has(id));
  const on = (run: ReviewBenchmarkRun) => runTotals({ fixControl: run.fixControl, cases: run.cases.filter((item) => both.includes(item.caseId)) });
  const b = on(before), a = on(after);
  const sameCases = both.length === before.cases.length && both.length === after.cases.length;
  const perCase = (totals: ReviewBenchmarkRunTotals) => (totals.clean.cases ? Math.round((totals.clean.findings / totals.clean.cases) * 10) / 10 : null);
  const change = (from: number | null, to: number | null) => (from === null || to === null ? "unknown" as const : to > from ? "up" as const : to < from ? "down" as const : "same" as const);
  const row = (metric: ReviewBenchmarkComparison["rows"][number]["metric"], name: string, from: number | null, to: number | null) => ({ metric, label: name, before: from, after: to, change: change(from, to) });
  const rows = [
    row("hit", `缺陷命中（${a.defect.issues} 个问题）`, b.defect.hit, a.defect.hit),
    row("harmful", `有害意见（${a.clean.cases} 个 PR）`, b.clean.harmful, a.clean.harmful),
    row("commentsPerCase", "每个 PR 的意见", perCase(b), perCase(a)),
    row("fixReported", "修复后再报", b.defect.fixReported, a.defect.fixReported),
  ];
  const unjudged = a.clean.unjudged + b.clean.unjudged;
  const [verdict, words]: [ReviewBenchmarkComparison["verdict"], string] = both.length === 0 ? ["not_comparable", "两次没有都跑完的样本，不能比。"]
    : a.defect.hit < b.defect.hit ? ["reject_recall", "召回降了：不要采用。"]
      : unjudged > 0 ? ["judge_first", `两次评测还有 ${unjudged} 条干净集意见没判（每次评测在它自己的记录里判），判完再决定。`]
        : a.clean.harmful > b.clean.harmful ? ["reject_harmful", "有害意见增加：不要采用。"]
          : ["adopt", a.clean.harmful < b.clean.harmful ? "召回没降，有害意见减少：可以采用。" : "召回没降，有害意见没有增加：可以采用。"];
  const notes = [...(sameCases || both.length === 0 ? [] : [`只比两次都跑完的 ${both.length} 个样本。`]), ...(both.length && both.length < 20 ? ["样本少于 20 个，只看计数。"] : [])];
  return { before: before.id, after: after.id, sameCases, rows, verdict, said: [words, ...notes].join("").slice(0, 300) };
};

/** One benchmark run at a time, in the App's main process, each kept in its own file as it goes. */
export class ReviewBenchmarkRuns {
  /** The run under way: its record held here, so a judgment made meanwhile and the run's own progress write one object. */
  #active: { id: string; controller: AbortController; reviewer: BenchmarkReviewer | null; reviewRun: string | null; run: ReviewBenchmarkRun } | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly sources: ReviewBenchmarkRunSources) {}
  get active(): string | null { return this.#active?.id ?? null; }

  async #read(id: string): Promise<ReviewBenchmarkRun | null> {
    try {
      const run = reviewBenchmarkRunSchema.parse(JSON.parse(await readFile(join(this.sources.directory, `${id}.json`), "utf8")));
      // Left running by an App that is gone: interrupted, its cases done kept.
      return run.state === "running" && this.#active?.id !== run.id ? { ...run, state: "interrupted" } : run;
    } catch { return null; }
  }
  #write(run: ReviewBenchmarkRun): Promise<void> {
    const next = this.#tail.then(async () => {
      await mkdir(this.sources.directory, { recursive: true });
      await atomicWrite(join(this.sources.directory, `${run.id}.json`), JSON.stringify(run));
    });
    this.#tail = next.catch(() => undefined);
    return next.then(() => this.sources.changed?.(run.id));
  }
  async list(repositoryPath?: string): Promise<ReviewBenchmarkRun[]> {
    const root = repositoryPath === undefined ? undefined : await repositoryRoot(repositoryPath) ?? repositoryPath;
    const names = await readdir(this.sources.directory).catch(() => [] as string[]);
    const runs = await Promise.all(names.filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name)).map((name) => this.#read(name.slice(0, -5))));
    return runs.filter((run): run is ReviewBenchmarkRun => run !== null && (root === undefined || run.repositoryPath === root))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
  }
  get(id: string) { return this.#read(id); }

  async start(request: Omit<ReviewBenchmarkRunRequest, "reviewBenchmarkVersion">): Promise<ReviewBenchmarkRunStart> {
    const available = (await this.sources.models().catch(() => [])).filter((model) => modelKindSupportsGeneration(model.kind));
    const answer = (status: ReviewBenchmarkRunStart["status"], reason: string | null, run: ReviewBenchmarkRun | null = null): ReviewBenchmarkRunStart =>
      ({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status, reason, models: available.map((model) => ({ id: model.profileId, label: label(model) })), run: run && runSummary(run) });
    if (this.#active) return answer("busy", "已有评测在运行，等它结束或取消后再开始。");
    const model = request.model === undefined ? available[0] : available.find((item) => item.profileId === request.model || item.label === request.model || label(item) === request.model);
    if (!model) return answer("model_not_found", request.model === undefined ? "没有可用的模型：先在 Paraself 的模型设置里启用一个。" : `没有「${request.model}」这个模型。`);
    const root = await repositoryRoot(request.repositoryPath);
    const found = root ? await this.sources.cases(root, request.split, request.set).catch(() => null) : null;
    if (!root || !found) return answer("repository_not_found", `${request.repositoryPath} 不在 Git 仓库里。`);
    if (!found.cases.length) return answer("no_cases", `这个仓库的${request.split === "holdout" ? "留出集" : "开发集"}还没有确认入集的样本。`);
    const run: ReviewBenchmarkRun = {
      id: randomUUID(), repositoryPath: root, project: found.repository.project, label: request.label, split: request.split, fixControl: request.fixControl,
      model: label(model), profileId: model.profileId, startedAt: new Date(this.sources.now?.() ?? Date.now()).toISOString(), finishedAt: null, state: "running", error: null, adopted: null,
      cases: found.cases.slice(0, 200).map((item) => ({ caseId: item.id, set: item.set, title: item.title.slice(0, 300), state: "pending", error: null,
        issues: (item.issues ?? []).filter((issue) => !issue.tradeoff).length, hit: 0, lost: 0, fixReported: null, knownRepeats: 0, findings: [], judgments: [], wallMs: 0 })),
    };
    this.#active = { id: run.id, controller: new AbortController(), reviewer: null, reviewRun: null, run };
    await this.#write(run);
    // ponytail: runs in the App's main process, not awaited; the run's file is the way back to its results.
    void this.#go(run, found.cases, found.repository.project);
    return answer("started", null, run);
  }

  cancel(id: string): boolean {
    if (this.#active?.id !== id) return false;
    this.#active.controller.abort();
    if (this.#active.reviewRun) this.#active.reviewer?.cancel(this.#active.reviewRun);
    return true;
  }

  /** One case reviewed: its version replayed from the local repository, its findings scored against its answers. */
  async #review(directory: string, item: ReviewBenchmarkStoredCase, project: string, index: number, head: string, base: string, profileId: string): Promise<{ report: PrReviewReport; candidates: PrReviewFinding[] }> {
    const repository = item.pr?.repository ?? `benchmark/${project.replace(/[^\p{L}\p{N}_.~@-]+/gu, "-") || "repository"}`;
    const reference = `${repository}#${item.pr?.number ?? index + 1}`;
    const client = await replayClient(directory, { reference, repository, title: item.title, head, target: item.targetSha, base });
    const candidates: PrReviewFinding[] = [];
    const reviewer = this.sources.reviewer(client, (found) => candidates.push(...found));
    const runId = randomUUID();
    if (this.#active) { this.#active.reviewer = reviewer; this.#active.reviewRun = runId; }
    const snapshot = await reviewer.load({ connectionId: REPLAY_CONNECTION, reference });
    this.#active?.controller.signal.throwIfAborted();
    const report = await reviewer.run({ snapshotId: snapshot.snapshotId, runId, profileId, focus: "", ...(item.scope.length ? { paths: item.scope } : {}),
      ...(snapshot.risk?.level === "high" ? { depth: "deep" as const } : {}) });
    return { report, candidates };
  }

  async #go(run: ReviewBenchmarkRun, cases: ReviewBenchmarkStoredCase[], project: string) {
    const signal = this.#active!.controller.signal;
    try {
      for (const [index, item] of cases.slice(0, 200).entries()) {
        if (signal.aborted) break;
        const at = run.cases[index]!;
        at.state = "running";
        await this.#write(run);
        const started = performance.now();
        try {
          const { report, candidates } = await this.#review(run.repositoryPath, item, project, index, item.headSha, item.baseSha, run.profileId);
          at.findings = findingsOf(report, candidates);
          const kept = at.findings.filter((finding) => finding.kept), dropped = at.findings.filter((finding) => !finding.kept);
          const issues = (item.issues ?? []).filter((issue) => !issue.tradeoff);
          const lands = (findings: typeof kept, issue: (typeof issues)[number]) => findings.some((finding) => issue.locations.some((place) => near(finding, place)));
          at.hit = issues.filter((issue) => lands(kept, issue)).length;
          at.lost = issues.filter((issue) => !lands(kept, issue) && lands(dropped, issue)).length;
          at.knownRepeats = (item.knownFalsePositives ?? []).filter((known) => known.location && kept.some((finding) => near(finding, known.location!))).length;
          // 修复对照: the newest fix reviewed the same way; an issue said again at its place is reported again.
          if (run.fixControl && item.set === "defect") {
            const fix = issues.flatMap((issue) => issue.fixShas).at(-1);
            if (fix) {
              const again = await this.#review(run.repositoryPath, item, project, index, fix, await mergeBase(run.repositoryPath, fix, item.targetSha), run.profileId);
              const fixedKept = findingsOf(again.report, []).filter((finding) => finding.kept);
              at.fixReported = issues.filter((issue) => lands(fixedKept, issue)).length;
            } else at.fixReported = 0;
          }
          at.state = "done";
        } catch (error) {
          at.state = "failed";
          at.error = signal.aborted ? "已取消" : said(error);
        }
        at.wallMs = Math.round(performance.now() - started);
        await this.#write(run);
      }
      run.state = signal.aborted ? "cancelled" : run.cases.every((item) => item.state === "failed") ? "failed" : "finished";
    } catch (error) {
      run.state = "failed"; run.error = said(error);
    } finally {
      run.finishedAt = new Date(this.sources.now?.() ?? Date.now()).toISOString();
      // Let go only once the end is written: read in between, the file still says running, which reads as interrupted.
      await this.#write(run).catch(() => undefined);
      this.#active = null;
    }
  }

  /** The user's word on a kept finding of a clean case: harmful, noise or valid. */
  async judge(id: string, caseId: string, finding: number, verdict: "harmful" | "noise" | "valid"): Promise<ReviewBenchmarkRun | null> {
    const run = this.#active?.id === id ? this.#active.run : await this.#read(id);
    const at = run?.cases.find((item) => item.caseId === caseId && item.set === "clean");
    if (!run || !at || !at.findings[finding]?.kept) return null;
    at.judgments = [...at.judgments.filter((item) => item.finding !== finding), { finding, verdict }].sort((a, b) => a.finding - b.finding);
    await this.#write(run);
    return run;
  }
  async adopt(id: string, note: string): Promise<ReviewBenchmarkRun | null> {
    const run = await this.#read(id);
    if (!run || run.state !== "finished") return null;
    run.adopted = { at: new Date(this.sources.now?.() ?? Date.now()).toISOString(), note: note.slice(0, 600) };
    await this.#write(run);
    return run;
  }

  /** A run, compared with `compareTo` or the last finished one of its repository and split before it. A holdout's cases stay back, unless `judging` (its clean cases only, to judge). */
  async result(id: string, compareTo?: string, judging = false): Promise<ReviewBenchmarkRunResult> {
    const run = await this.#read(id);
    if (!run) return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "not_found", run: null, cases: null, comparison: null };
    const before = compareTo !== undefined ? await this.#read(compareTo)
      : (await this.list(run.repositoryPath)).find((item) => item.id !== run.id && item.split === run.split && item.state === "finished" && item.startedAt < run.startedAt) ?? null;
    const cases = run.split === "dev" ? run.cases : judging ? run.cases.filter((item) => item.set === "clean") : null;
    return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "ok", run: runSummary(run), cases, comparison: before ? compareRuns(before, run) : null };
  }
  async summaries(repositoryPath: string): Promise<ReviewBenchmarkRunsResult> {
    if (!await repositoryRoot(repositoryPath)) return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "repository_not_found", runs: [] };
    return { reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, status: "ok", runs: (await this.list(repositoryPath)).map(runSummary) };
  }
}
