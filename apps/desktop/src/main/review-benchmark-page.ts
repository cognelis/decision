import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  REVIEW_BENCHMARK_LIMITS,
  REVIEW_BENCHMARK_VERSION,
  modelKindSupportsGeneration,
  type PrConnection,
  type PrReviewHistoryEntry,
  type RetrievalAnswerProvider,
  type ReviewBenchmarkCaseInput,
  type ReviewBenchmarkListRequest,
  type ReviewBenchmarkListResult,
  type ReviewBenchmarkPageRequest,
  type ReviewBenchmarkPageResult,
  type ReviewBenchmarkRecordRequest,
  type ReviewBenchmarkRecordResult,
  type ReviewBenchmarkRepositoryOverview,
  type ReviewBenchmarkSuggestion,
  type ReviewBenchmarkUpdateRequest,
  type ReviewBenchmarkUpdateResult,
} from "@cognelis/decision-protocol";

import { atomicWrite } from "./atomic-write.js";
import type { PrDetails } from "./pr-platform-client.js";
import type { PrHistoryStore } from "./pr-review-records.js";
import { runSummary, type ReviewBenchmarkRuns } from "./review-benchmark-runs.js";
import type { ReviewEscapeStore } from "./review-escapes.js";
import type { PrTeamFactsCache } from "./review-quality.js";

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
const L = REVIEW_BENCHMARK_LIMITS;
const DAY = 86_400_000;
const label = (model: RetrievalAnswerProvider) => [model.label, model.model].filter(Boolean).join(" · ");
const repositoryOf = (reference: string) => reference.slice(0, reference.lastIndexOf("#"));
const numberOf = (reference: string) => Number(reference.slice(reference.lastIndexOf("#") + 1));

/** Suggestions taken or left, by key: neither is offered again. */
export class SuggestionLedger {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  async read(): Promise<Record<string, "taken" | "dismissed">> {
    try { return z.object({ version: z.literal(1), keys: z.record(z.string(), z.enum(["taken", "dismissed"])) }).parse(JSON.parse(await readFile(this.path, "utf8"))).keys; }
    catch { return {}; }
  }
  mark(key: string, as: "taken" | "dismissed"): Promise<void> {
    const next = this.#tail.then(async () => {
      const keys = { ...(await this.read()), [key]: as };
      await atomicWrite(this.path, JSON.stringify({ version: 1, keys: Object.fromEntries(Object.entries(keys).slice(-2_000)) }));
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export interface ReviewBenchmarkPageSources {
  runs: ReviewBenchmarkRuns;
  benchmark: {
    list(request: ReviewBenchmarkListRequest): Promise<ReviewBenchmarkListResult>;
    record(request: ReviewBenchmarkRecordRequest): Promise<ReviewBenchmarkRecordResult>;
    update(request: ReviewBenchmarkUpdateRequest): Promise<ReviewBenchmarkUpdateResult>;
  };
  /** The repositories added in 本地审阅, by path: where cases are kept and replayed from. */
  repositories(): Promise<string[]>;
  connections(): Promise<PrConnection[]>;
  history: PrHistoryStore;
  facts: PrTeamFactsCache;
  escapes: ReviewEscapeStore;
  get(connectionId: string, reference: string): Promise<PrDetails>;
  localPath(connectionId: string, repository: string): Promise<string | null>;
  models(): Promise<RetrievalAnswerProvider[]>;
  ledger: SuggestionLedger;
  now?(): number;
}

const reviewed = (entries: readonly PrReviewHistoryEntry[], connectionId: string) =>
  entries.filter((entry): entry is PrReviewHistoryEntry & { report: NonNullable<PrReviewHistoryEntry["report"]> } => entry.kind === "review" && entry.connectionId === connectionId && entry.report !== null);

/** 线上回流 for one link: findings the authors fixed or called wrong, and PRs long merged with nothing pointing back at them. */
export const suggestionsFor = async (connectionId: string, sources: ReviewBenchmarkPageSources): Promise<ReviewBenchmarkSuggestion[]> => {
  const [{ entries }, facts, ledger, escapes] = await Promise.all([sources.history.list(), sources.facts.read(), sources.ledger.read(), sources.escapes.list()]);
  const now = sources.now?.() ?? Date.now();
  const mergedAt = (reference: string) => facts[`${connectionId}|${reference}`]?.mergedAt ?? null;
  const found: ReviewBenchmarkSuggestion[] = [];
  const records = reviewed(entries, connectionId);
  for (const entry of records) {
    for (const item of entry.published) {
      const kind = item.outcome?.kind, finding = entry.report.findings[item.finding];
      if ((kind !== "fixed" && kind !== "wrong") || !finding || ledger[`${entry.id}:${item.finding}`]) continue;
      found.push({ key: `${entry.id}:${item.finding}`, set: kind === "fixed" ? "defect" : "clean", source: kind, reference: entry.snapshot.reference, title: finding.title.slice(0, 500),
        said: kind === "fixed" ? "作者确认“修了”" : `作者回复“说错了”${item.outcome?.words ? `：${item.outcome.words.slice(0, 200)}` : ""}`,
        blocked: kind === "wrong" && !mergedAt(entry.snapshot.reference) ? "PR 合并后才能入干净集" : null });
    }
  }
  // 抽样: reviewed here, merged sixty days and more ago, no revert or fix naming it; three at most a look.
  const sampled = new Set<string>();
  for (const entry of records) {
    const reference = entry.snapshot.reference, merged = mergedAt(reference), key = `sample:${connectionId}|${reference}`;
    if (sampled.size >= 3 || sampled.has(reference) || !merged || now - Date.parse(merged) < 60 * DAY || ledger[key]) continue;
    if (escapes.some((item) => item.connectionId === connectionId && item.reference === reference && item.state !== "dismissed")) continue;
    sampled.add(reference);
    found.push({ key, set: "clean", source: "sampling", reference, title: entry.snapshot.title.slice(0, 500), said: `合并 ${Math.floor((now - Date.parse(merged)) / DAY)} 天，没有回滚，也没有 PR 点名修复它`, blocked: null });
  }
  return found.slice(0, 30);
};

/** A suggestion recorded as a candidate case: confirmed into its set only once the user checks it. */
const accept = async (connectionId: string, key: string, sources: ReviewBenchmarkPageSources): Promise<{ ok: boolean; message: string }> => {
  const suggestion = (await suggestionsFor(connectionId, sources)).find((item) => item.key === key);
  if (!suggestion) return { ok: false, message: "这条建议已经不在了。" };
  if (suggestion.blocked) return { ok: false, message: `还不能收：${suggestion.blocked}。` };
  const { entries } = await sources.history.list();
  const records = reviewed(entries, connectionId);
  const entry = suggestion.source === "sampling" ? records.find((item) => item.snapshot.reference === suggestion.reference) : records.find((item) => item.id === key.slice(0, key.lastIndexOf(":")));
  if (!entry) return { ok: false, message: "找不到这条建议对应的评审记录。" };
  const repository = repositoryOf(entry.snapshot.reference);
  const path = await sources.localPath(connectionId, repository).catch(() => null);
  if (!path) return { ok: false, message: `本地审阅里没有 ${repository} 的本地仓库：先在“本地审阅”里添加它，并拉取相关提交。` };
  const connection = (await sources.connections()).find((item) => item.id === connectionId);
  const pr = { ...(connection ? { platform: connection.platform } : {}), repository, number: numberOf(entry.snapshot.reference) };
  const version = { title: entry.snapshot.title.slice(0, L.title), pr, headSha: entry.snapshot.sourceCommit, targetSha: entry.snapshot.destinationCommit };
  const merged = (await sources.facts.read())[`${connectionId}|${entry.snapshot.reference}`]?.mergedAt ?? null;
  let input: ReviewBenchmarkCaseInput;
  if (suggestion.source === "sampling") {
    input = { set: "clean", ...version, mergedAt: merged!.slice(0, 10), cleanEvidence: `${suggestion.said}（只看了你评审或创建的、读到过的 PR）。`.slice(0, L.evidence), knownFalsePositives: [],
      provenance: [{ kind: "sampling", reference: `合并超过 60 天的抽样：${entry.snapshot.reference}`.slice(0, L.reference) }] };
  } else {
    const index = Number(key.slice(key.lastIndexOf(":") + 1));
    const finding = entry.report.findings[index]!, outcome = entry.published.find((item) => item.finding === index)?.outcome;
    const place = { path: finding.path, side: finding.side, startLine: finding.line, endLine: finding.line };
    if (suggestion.source === "fixed") {
      const head = await sources.get(connectionId, entry.snapshot.reference).then((details) => details.source.commit, () => null);
      if (!head) return { ok: false, message: `读不到 ${entry.snapshot.reference} 现在的提交。` };
      if (head === entry.snapshot.sourceCommit) return { ok: false, message: "PR 上还没有评审之后的新提交，找不到修复它的提交。" };
      input = { set: "defect", ...version, provenance: [{ kind: "review_reaction", reference: `作者确认已修：${finding.title}`.slice(0, L.reference) }, { kind: "fix_commit", reference: head }],
        issues: [{ title: finding.title.slice(0, L.issueTitle), priority: finding.priority, evidence: finding.body.slice(0, L.evidence), fixShas: [head], tradeoff: false, locations: [place] }] };
    } else {
      input = { set: "clean", ...version, mergedAt: merged!.slice(0, 10), cleanEvidence: `作者回复“说错了”${outcome?.words ? `：${outcome.words}` : ""}`.slice(0, L.evidence),
        knownFalsePositives: [{ finding: `${finding.title}：${finding.body}`.slice(0, L.finding), why: (outcome?.words || "作者回复说错了").slice(0, L.finding), location: place }],
        provenance: [{ kind: "review_reaction", reference: `作者回复说错了：${finding.title}`.slice(0, L.reference) }] };
    }
  }
  try {
    const result = await sources.benchmark.record({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "paraself", repositoryPath: path, cases: [input] });
    const item = result.cases[0];
    if (result.status === "repository_not_found" || !item) return { ok: false, message: `${path} 不是 Git 仓库。` };
    if (item.outcome === "rejected" || !item.caseId) return { ok: false, message: `评测集没有收下：${item.reasons.join("；") || "原因不明"}` };
    await sources.ledger.mark(key, "taken");
    return { ok: true, message: item.outcome === "duplicate" ? `评测集里已经有这个样本（${item.caseId}）。` : `已录为候选样本 ${item.caseId}：核对后在“待确认的候选样本”里确认入集。` };
  } catch (error) { return { ok: false, message: said(error) }; }
};

const overview = async (connectionId: string | undefined, sources: ReviewBenchmarkPageSources): Promise<NonNullable<ReviewBenchmarkPageResult["overview"]>> => {
  const repositories: ReviewBenchmarkRepositoryOverview[] = [];
  // The repositories added in 本地审阅, and any a run was made in (an agent's, through the bridge).
  const paths = new Set([...await sources.repositories().catch(() => []), ...(await sources.runs.list()).map((run) => run.repositoryPath)]);
  for (const path of paths) {
    const listed = await sources.benchmark.list({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, repositoryPath: path, status: "candidate", offset: 0, limit: 20 }).catch(() => null);
    if (!listed || listed.status !== "ok" || !listed.repository) continue;
    const runs = (await sources.runs.list(path)).slice(0, 10).map(runSummary);
    const counts = (set: "defect" | "clean") => ({ candidate: listed.counts[set].candidate, dev: listed.counts[set].confirmed.dev, holdout: listed.counts[set].confirmed.holdout });
    repositories.push({ path, project: listed.repository.project, counts: { defect: counts("defect"), clean: counts("clean") }, runs,
      candidates: listed.cases.map((item) => ({ caseId: item.id, set: item.set, title: item.title, from: item.pr ? `${item.pr.repository}#${item.pr.number}` : "" })) });
  }
  const models = (await sources.models().catch(() => [])).filter((model) => modelKindSupportsGeneration(model.kind)).map((model) => ({ id: model.profileId, label: label(model) }));
  return { repositories, suggestions: connectionId ? await suggestionsFor(connectionId, sources) : [], models, active: sources.runs.active };
};

/** The review page's 评测集. Starting a run spends model calls for every case: only on the user's click. */
export const benchmarkPage = async (request: ReviewBenchmarkPageRequest, sources: ReviewBenchmarkPageSources): Promise<ReviewBenchmarkPageResult> => {
  const done = (ok: boolean, message: string | null, more: Partial<ReviewBenchmarkPageResult> = {}): ReviewBenchmarkPageResult => ({ ok, message, overview: null, run: null, ...more });
  switch (request.kind) {
    case "overview": return done(true, null, { overview: await overview(request.connectionId, sources) });
    case "run": {
      const started = await sources.runs.start({ repositoryPath: request.repositoryPath, label: request.label, split: request.split, fixControl: request.fixControl, ...(request.model ? { model: request.model } : {}) });
      return started.status === "started" && started.run ? done(true, `已开始评测：${started.run.label}。`, { run: await sources.runs.result(started.run.id, undefined, true) }) : done(false, started.reason ?? "没有开始评测。");
    }
    case "get": return done(true, null, { run: await sources.runs.result(request.id, request.compareTo, true) });
    case "judge": {
      const run = await sources.runs.judge(request.id, request.caseId, request.finding, request.verdict);
      return run ? done(true, null, { run: await sources.runs.result(run.id, undefined, true) }) : done(false, "这条意见不能判：只判干净集里核验留下的意见。");
    }
    case "adopt": {
      const run = await sources.runs.adopt(request.id, request.note);
      return run ? done(true, `已记为采用：${run.label}。`, { run: await sources.runs.result(run.id, undefined, true) }) : done(false, "只有跑完的评测能记为采用。");
    }
    case "cancel": return sources.runs.cancel(request.id) ? done(true, "正在取消评测：当前样本停下后结束。") : done(false, "这次评测没有在运行。");
    case "confirm": {
      const result = await sources.benchmark.update({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "paraself", repositoryPath: request.repositoryPath, caseId: request.caseId,
        expectedStatus: "candidate", status: "confirmed", userConfirmation: "用户在 Paraself 评审质量页的评测集里核对后点了“确认入集”。" }).catch((error: unknown) => ({ status: "rejected" as const, reasons: [said(error)] }));
      return result.status === "saved" || result.status === "unchanged" ? done(true, "已确认入集。") : done(false, `没有确认入集：${result.reasons?.join("；") || result.status}`);
    }
    case "accept": { const result = await accept(request.connectionId, request.key, sources); return done(result.ok, result.message); }
    case "dismiss": await sources.ledger.mark(request.key, "dismissed"); return done(true, "这条建议不再列出。");
  }
};
