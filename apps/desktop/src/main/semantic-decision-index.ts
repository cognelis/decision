import { SqliteIndex, type ParsedStoredNote } from "@cognelis/decision-storage";

/** All DecisionStore writes and file-watcher changes pass this index before vectors are refreshed. */
export class SemanticDecisionIndex extends SqliteIndex {
  constructor(path: string, private readonly changed: () => void) {
    super(path);
  }

  #notifyChanged(): void {
    // A failed background notification must not turn an already committed index write into a save failure.
    try { this.changed(); } catch {}
  }

  override upsert(note: ParsedStoredNote): void {
    super.upsert(note);
    this.#notifyChanged();
  }

  override removePath(path: string): string | null {
    const removed = super.removePath(path);
    if (removed !== null) this.#notifyChanged();
    return removed;
  }

  override rebuild(notes: ParsedStoredNote[], keep: string[] = []): void {
    super.rebuild(notes, keep);
    this.#notifyChanged();
  }
}
