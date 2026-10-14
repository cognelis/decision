/**
 * A rationale begun on the capture panel and put off with 稍后处理, kept on this device by candidate until it is
 * completed, skipped or discarded from 待补理由. Put off, it was dropped, and that dialog opened blank.
 */
export interface DeferredRationaleDraft {
  rationale: string;
  reasonFactors: string[];
}

const key = "decision.deferredRationaleDrafts.v1";

const read = (): Record<string, DeferredRationaleDraft> => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, DeferredRationaleDraft>
      : {};
  } catch {
    return {};
  }
};

const write = (drafts: Record<string, DeferredRationaleDraft>): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify(drafts));
    return true;
  } catch {
    // Callers that would discard a visible draft can keep the editor open when storage is unavailable.
    return false;
  }
};

export const keepDeferredRationale = (id: string, draft: DeferredRationaleDraft): boolean => {
  if (draft.rationale.trim().length === 0 && draft.reasonFactors.length === 0) return true;
  // ponytail: the latest 50 kept; one put off longer than that starts afresh.
  return write(Object.fromEntries([...Object.entries(read()).filter(([kept]) => kept !== id), [id, draft]].slice(-50)));
};

export const deferredRationale = (id: string): DeferredRationaleDraft | undefined => {
  const draft = read()[id];
  return draft !== undefined && typeof draft.rationale === "string" && Array.isArray(draft.reasonFactors) &&
    draft.reasonFactors.every((factor) => typeof factor === "string")
    ? draft
    : undefined;
};

export const dropDeferredRationale = (id: string): boolean => {
  const drafts = read();
  if (!(id in drafts)) return true;
  delete drafts[id];
  return write(drafts);
};

/**
 * Drafts filed under the capture panel's per-run id, as they were before they were filed by decision: the home
 * page never found them, so none was restored, nor deleted with its decision. Taken out.
 */
export const forgetUnfiledDeferredRationales = (): void => {
  const drafts = read();
  const filed = Object.fromEntries(Object.entries(drafts).filter(([id]) => id.startsWith("decision-")));
  if (Object.keys(filed).length < Object.keys(drafts).length) write(filed);
};
