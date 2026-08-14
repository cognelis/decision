import { watch, type FSWatcher } from "chokidar";

import type { DecisionIndex } from "./decision-store.js";
import {
  MarkdownRepository,
  type NoteDiagnostic,
} from "./markdown.js";

export class DecisionWatcher {
  readonly #repository: MarkdownRepository;
  readonly #index: DecisionIndex;
  readonly #onDiagnostic: (diagnostic: NoteDiagnostic) => void;
  readonly #onSynchronized: (path: string) => void;
  #watcher: FSWatcher | null = null;

  constructor(
    repository: MarkdownRepository,
    index: DecisionIndex,
    onDiagnostic: (diagnostic: NoteDiagnostic) => void = () => undefined,
    onSynchronized: (path: string) => void = () => undefined,
  ) {
    this.#repository = repository;
    this.#index = index;
    this.#onDiagnostic = onDiagnostic;
    this.#onSynchronized = onSynchronized;
  }

  start(): void {
    if (this.#watcher !== null) {
      return;
    }
    this.#watcher = watch(this.#repository.decisionsPath, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 50,
      },
    });
    this.#watcher.on("add", (path) => {
      void this.synchronizePath(path);
    });
    this.#watcher.on("change", (path) => {
      void this.synchronizePath(path);
    });
    this.#watcher.on("unlink", (path) => {
      this.removePath(path);
    });
    this.#watcher.on("error", (error) => {
      this.#onDiagnostic({
        path: this.#repository.decisionsPath,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async synchronizePath(path: string): Promise<void> {
    try {
      const note = await this.#repository.read(path);
      if (this.#index.contentHashForPath?.(path) === note.contentHash) {
        return;
      }
      this.#index.upsert(note);
      this.#onSynchronized(path);
    } catch (error) {
      this.#onDiagnostic({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  removePath(path: string): void {
    this.#index.removePath(path);
    this.#onSynchronized(path);
  }

  async close(): Promise<void> {
    const watcher = this.#watcher;
    this.#watcher = null;
    await watcher?.close();
  }
}
