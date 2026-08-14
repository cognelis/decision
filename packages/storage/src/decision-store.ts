import type { DecisionRecord } from "@cognelis/decision-core";

import type {
  AppliedPrinciplesUpdate,
  DeferredRationaleUpdate,
  NoteDiagnostic,
  OutcomeReviewUpdate,
  ParsedStoredNote,
  StoredNote,
} from "./markdown.js";
import { MarkdownRepository } from "./markdown.js";

export interface DecisionIndex {
  upsert(note: ParsedStoredNote): void;
  removePath(path: string): void;
  rebuild(notes: ParsedStoredNote[]): void;
  close(): void;
  contentHashForPath?(path: string): string | null;
}

export interface SaveResult {
  note: StoredNote;
  indexed: boolean;
}

export interface RebuildReport {
  indexedCount: number;
  diagnostics: NoteDiagnostic[];
}

export class DecisionStore {
  readonly #repository: MarkdownRepository;
  readonly #index: DecisionIndex;
  readonly #onIndexError: (error: Error) => void;

  constructor(
    repository: MarkdownRepository,
    index: DecisionIndex,
    onIndexError: (error: Error) => void = () => undefined,
  ) {
    this.#repository = repository;
    this.#index = index;
    this.#onIndexError = onIndexError;
  }

  async save(record: DecisionRecord): Promise<SaveResult> {
    const note = await this.#repository.write(record);
    try {
      this.#index.upsert(await this.#repository.read(note.path));
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async rebuildIndex(): Promise<RebuildReport> {
    const scan = await this.#repository.scan();
    this.#index.rebuild(scan.notes);
    return {
      indexedCount: scan.notes.length,
      diagnostics: scan.diagnostics,
    };
  }

  async completeDeferredRationale(
    id: string,
    input: DeferredRationaleUpdate,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateDeferredRationale(id, input);
    try {
      this.#index.upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async skipDeferredRationale(id: string): Promise<SaveResult> {
    const note = await this.#repository.skipDeferredRationale(id);
    try {
      this.#index.upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async deleteDeferredRationale(id: string): Promise<SaveResult> {
    const note = await this.#repository.deleteDeferredRationale(id);
    try {
      this.#index.removePath(note.path);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateOutcome(id: string, outcome: string): Promise<SaveResult> {
    const note = await this.#repository.updateOutcome(id, outcome);
    try {
      this.#index.upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateReviewDueDate(
    id: string,
    reviewDueDate: string | null,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateReviewDueDate(id, reviewDueDate);
    try {
      this.#index.upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateAppliedPrinciples(
    id: string,
    input: AppliedPrinciplesUpdate,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateAppliedPrinciples(id, input);
    try {
      this.#index.upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }

  async updateOutcomeReview(
    id: string,
    input: OutcomeReviewUpdate,
  ): Promise<SaveResult> {
    const note = await this.#repository.updateOutcomeReview(id, input);
    try {
      this.#index.upsert(note);
      return { note, indexed: true };
    } catch (error) {
      this.#onIndexError(
        error instanceof Error ? error : new Error(String(error)),
      );
      return { note, indexed: false };
    }
  }
}
