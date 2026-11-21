import { clipText, type DecisionContextQuery, type DecisionContextResponse, type ProactiveRecordRequest, type ProactiveRecordResult } from "@cognelis/decision-protocol";

/**
 * Close enough in meaning that a record just written may be one already there. Calibrated on the local embedding model
 * with 14 pairs (CS-1-F): wording repeated 0.85-0.93, the same said another way 0.76-0.83, related but different 0.53-0.58,
 * unrelated 0.15-0.31; 0.70 is in the gap, over 0.12 above the one and 0.06 under the other.
 */
export const DUPLICATE_SIMILARITY = 0.7;
// What the bridge's answer can wait for: the record is written already, and a slow hint must not make it look unwritten.
const BUDGET_MS = 1_500;

type Duplicates = NonNullable<ProactiveRecordResult["possibleDuplicates"]>;

/** Existing records of the kind just written whose meaning is close to it, nearest first, at most 3; none when not known. */
export const possibleDuplicates = async (
  search: (query: DecisionContextQuery) => Promise<DecisionContextResponse>,
  request: ProactiveRecordRequest,
  ownId: string,
): Promise<Duplicates> => {
  const source = request.kind === "decision" ? ["decisions", "summarize"] as const : request.kind === "preference" ? ["preferences"] as const : ["ideas"] as const;
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), BUDGET_MS).unref());
  const found = await Promise.race([
    search({
      query: clipText(`${request.title}\n${request.content}`, 700), source: [...source], mode: "semantic", minSimilarity: DUPLICATE_SIMILARITY,
      includeOutOfScope: true, limit: 6, offset: 0,
    }).catch(() => null),
    timeout,
  ]);
  return (found?.results ?? [])
    .filter((record) => record.id !== ownId && record.similarity !== undefined && record.source !== "principles")
    .slice(0, 3)
    .map((record) => ({ source: record.source as Duplicates[number]["source"], id: record.id, title: clipText(record.title, 200), similarity: record.similarity! }));
};
