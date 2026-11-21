import { randomUUID } from "node:crypto";

import {
  PR_REVIEW_TOOLS_VERSION,
  prReviewDismissedIn,
  prReviewPublishedIn,
  type PrConnection,
  type PrReviewHistoryEntry,
  type PrReviewLoad,
  type PrReviewReport,
  type PrReviewRun,
  type PrReviewRunToolRequest,
  type PrReviewRunToolResult,
  type PrReviewSnapshot,
  type RetrievalAnswerProvider,
} from "@cognelis/decision-protocol";

import { resolveConnection } from "./pr-description-tools.js";
import type { PrHistoryStore } from "./pr-review-records.js";

/**
 * run_pr_review: a review an agent starts, as the review page starts one. The PR is read fresh; its record is kept from
 * the start, running, so the page and get_pr_review show it; the review is told what the repository's reviews were not
 * to raise and what they posted; when it ends, its report goes into the record. One review runs at a time, whoever
 * started it. The page is told each time the record changes and reads it again.
 */
export interface PrReviewRunSources {
  connections(): Promise<PrConnection[]>;
  models(): Promise<RetrievalAnswerProvider[]>;
  load(request: PrReviewLoad): Promise<PrReviewSnapshot>;
  run(request: PrReviewRun): Promise<PrReviewReport>;
  /** A review is running (the page's, or another agent's). */
  running(): boolean;
  /** The reviews started here and not ended: the page reads them as under way, not as left behind. */
  underWay: Set<string>;
  history: PrHistoryStore;
  changed(ids: string[]): void;
}

const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
const label = (model: RetrievalAnswerProvider) => [model.label, model.model].filter(Boolean).join(" · ");

/** `auto`: started by 自动预评审, and so marked on its record. */
export const startReviewForAgent = async (request: PrReviewRunToolRequest, sources: PrReviewRunSources, options: { auto?: boolean } = {}): Promise<PrReviewRunToolResult> => {
  const { connection, connections, status } = await resolveConnection(sources, request.connection);
  const available = await sources.models().catch(() => []);
  const answer = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections, models: available.map((model) => ({ id: model.profileId, label: label(model) })) } as const;
  if (!connection) return { ...answer, status, reason: null, run: null };
  if (sources.running()) return { ...answer, status: "busy", reason: "已有评审正在运行（评审页或别的 agent 发起的），等它结束再开始。", run: null };
  const { entries } = await sources.history.list();
  const earlier = entries.filter((entry) => entry.kind === "review" && entry.connectionId === connection.id && entry.snapshot.reference === request.reference);
  const model = request.model === undefined
    ? available.find((item) => item.profileId === earlier[0]?.profileId) ?? available[0]
    : available.find((item) => item.profileId === request.model || label(item) === request.model || item.label === request.model);
  if (!model) return { ...answer, status: request.model === undefined ? "no_model" : "model_not_found", reason: null, run: null };
  let snapshot: PrReviewSnapshot;
  try { snapshot = await sources.load({ connectionId: connection.id, reference: request.reference }); }
  catch (error) { return { ...answer, status: "failed", reason: said(error), run: null }; }
  // A later round reads what came after the last review with a report, unless the whole PR is asked for.
  const last = earlier.find((entry) => entry.report);
  const since = request.scope === "since_last_review" && last && last.snapshot.sourceCommit !== snapshot.sourceCommit ? last.snapshot.sourceCommit : undefined;
  const depth = request.depth ?? (snapshot.risk?.level === "high" ? "deep" : "standard");
  const id = randomUUID();
  const entry: PrReviewHistoryEntry = {
    id, kind: "review", at: new Date().toISOString(), model: label(model), focus: request.focus, snapshot, connectionId: connection.id, profileId: model.profileId,
    draft: "", turns: [], events: [], report: null, state: "running", error: "", published: [], verdicts: [], rechecks: [], ...(options.auto ? { auto: true as const } : {}),
  };
  await sources.history.save({ entries: [entry], removed: [] });
  sources.underWay.add(id);
  sources.changed([id]);
  const dismissed = prReviewDismissedIn(entries, connection.id, request.reference);
  const published = prReviewPublishedIn(entries, connection.id, request.reference);
  // ponytail: runs in the App's main process, not awaited; the record is the way back to its result.
  void (async () => {
    let done: PrReviewHistoryEntry;
    try {
      const report = await sources.run({ snapshotId: snapshot.snapshotId, runId: id, profileId: model.profileId, focus: request.focus, ...(depth === "deep" ? { depth } : {}),
        ...(dismissed.length ? { dismissed } : {}), ...(published.length ? { published } : {}), ...(since ? { since } : {}) });
      done = { ...entry, state: "finished", report: { ...report, history: [] }, events: report.history.slice(-2_000) };
    } catch (error) {
      done = { ...entry, state: "failed", error: said(error) };
    }
    await sources.history.save({ entries: [done], removed: [] }).catch(() => undefined);
    sources.underWay.delete(id);
    sources.changed([id]);
  })();
  return { ...answer, status: "started", reason: null,
    run: { id, reference: request.reference, title: snapshot.title, model: label(model), depth, since: since ?? null, risk: snapshot.risk?.level ?? null, round: earlier.length + 1 } };
};
