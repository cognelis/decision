import type { MethodologyRecord } from "@cognelis/decision-core";

/**
 * What a candidate principle's edit was based on: the fields the edit writes, as the editor began from them. Sent
 * with it and compared with the note as it now stands, so a change made meanwhile (an edit in Obsidian) is
 * noticed rather than written over with the copy the page had.
 */
export const methodologyRevisionBasis = (
  record: Pick<MethodologyRecord, "title" | "principle" | "appliesWhen" | "caution" | "evidenceSummary">,
): string => JSON.stringify([record.title, record.principle, record.appliesWhen, record.caution, record.evidenceSummary]);
