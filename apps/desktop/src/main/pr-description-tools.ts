import {
  PR_REVIEW_TOOLS_VERSION,
  prDescriptionDraft,
  prDescriptionFactsFrom,
  prDescriptionSections,
  type PrConnection,
  type PrDescription,
  type PrDescriptionDraftQuery,
  type PrDescriptionDraftResult,
  type PrDescriptionRead,
  type PrDescriptionUpdate,
  type PrDescriptionUpdateResult,
  type PrReviewHistoryList,
  type PrReviewSnapshot,
  type PrReviewStatus,
  type PrUpdateRequest,
  type PrUpdateResult,
} from "@cognelis/decision-protocol";

import { PrDescriptionMovedError } from "./pr-platform-client.js";

/**
 * PR 描述三段 for an agent (get_pr_description_draft, update_pr), as the review page's description dialog drafts and
 * writes them: the description read fresh from the platform, the parts it lacks drafted from what Paraself knows (its
 * risk, build, latest review, the latest overview's rollback note), written back only over the version read.
 */
export interface PrDescriptionToolSources {
  connections(): Promise<PrConnection[]>;
  read(request: PrDescriptionRead): Promise<PrDescription>;
  update(request: PrDescriptionUpdate): Promise<PrDescriptionUpdateResult>;
  status(connectionId: string, reference: string): Promise<PrReviewStatus | null>;
  history(): Promise<PrReviewHistoryList>;
  /** The PR's snapshot as last read here, for its risk and files when no review of it is kept. */
  snapshot(connectionId: string, reference: string): Promise<PrReviewSnapshot | null>;
}

/** The link named, or the only one; otherwise why not, with the links there are. */
export const resolveConnection = async (sources: { connections(): Promise<PrConnection[]> }, name: string | undefined) => {
  const all = await sources.connections();
  const connections = all.map(({ id, label, platform }) => ({ id, label, platform }));
  const found = name === undefined ? (all.length === 1 ? all[0] : undefined) : all.find((item) => item.id === name || item.label === name);
  const status = name === undefined && all.length > 1 ? "connection_needed" as const : "connection_not_found" as const;
  return { connection: found, connections, status };
};
const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);

export const descriptionDraftForAgent = async (query: PrDescriptionDraftQuery, sources: PrDescriptionToolSources): Promise<PrDescriptionDraftResult> => {
  const { connection, connections, status } = await resolveConnection(sources, query.connection);
  const answer = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections };
  if (!connection) return { ...answer, status, reason: null, draft: null };
  try {
    const current = await sources.read({ connectionId: connection.id, reference: query.reference });
    const [platform, { entries }, snapshot] = await Promise.all([
      sources.status(connection.id, query.reference).catch(() => null), sources.history(), sources.snapshot(connection.id, query.reference).catch(() => null),
    ]);
    const latest = entries.find((entry) => entry.kind === "review" && entry.connectionId === connection.id && entry.snapshot.reference === query.reference);
    const risk = latest?.snapshot.risk ?? snapshot?.risk ?? null;
    const facts = prDescriptionFactsFrom(entries, connection.id, query.reference, { risk, status: platform, files: (latest?.snapshot.files ?? snapshot?.files ?? []).map((file) => file.path) });
    const draft = prDescriptionDraft(current.description, facts);
    return { ...answer, status: "ok", reason: null, draft: {
      connectionId: connection.id, reference: query.reference, title: current.title, description: current.description, baseVersion: current.version,
      present: prDescriptionSections(current.description), added: draft.added, text: draft.text,
      facts: { risk: risk?.level ?? null, build: platform?.build ?? null, reviewRound: facts.review?.round ?? null, rollbackFromOverview: facts.rollback !== null },
    } };
  } catch (error) {
    return { ...answer, status: "failed", reason: said(error), draft: null };
  }
};

export const updatePrForAgent = async (request: PrUpdateRequest, sources: PrDescriptionToolSources): Promise<PrUpdateResult> => {
  const { connection, connections, status } = await resolveConnection(sources, request.connection);
  const answer = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections };
  if (!connection) return { ...answer, status, reason: null, message: null };
  try {
    const result = await sources.update({ connectionId: connection.id, reference: request.reference, description: request.description, baseVersion: request.baseVersion });
    return { ...answer, status: "updated", reason: null, message: result.message };
  } catch (error) {
    return { ...answer, status: error instanceof PrDescriptionMovedError ? "changed" : "failed", reason: said(error), message: null };
  }
};
