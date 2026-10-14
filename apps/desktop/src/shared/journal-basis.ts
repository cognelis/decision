import type { JournalEntry } from "@cognelis/decision-core/journal-entry";

/**
 * What a revision of a preference or idea was based on: every field as shown, in a fixed key order. Sent
 * with the revision and compared with the note as it now stands, so a change made meanwhile (an agent's
 * restatement, an edit in Obsidian) is noticed rather than written over with the copy the page had.
 */
export const journalEntryBasis = (entry: JournalEntry): string => {
  const { revisionEvents: _history, ...shown } = entry;
  return JSON.stringify(shown, (_key, value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)))
      : value);
};
