import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename } from "node:path";

/**
 * Watches the todo notes' folder for changes made outside the App (Obsidian, a sync client, a hand edit) and says so,
 * once a burst of events has settled: the page reads the lists again. The App's own and an agent's writes move the
 * revision themselves (TodoService.onWritten); this is the way for the rest, and it also catches those two, harmlessly.
 */
export class TodoNoteWatcher {
  readonly #folder: string;
  readonly #changed: () => void;
  readonly #delay: number;
  readonly #watch: typeof watch;
  #watcher: FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(folder: string, changed: () => void, options: { delay?: number; watch?: typeof watch } = {}) {
    this.#folder = folder;
    this.#changed = changed;
    this.#delay = options.delay ?? 300;
    this.#watch = options.watch ?? watch;
  }

  /**
   * Starts watching when the folder is there; called again (after a write has made it, at a rebuild) while it is not.
   * Does nothing when already watching. A watch that ends on an error is dropped, so that the next call watches again.
   */
  ensure(): void {
    if (this.#watcher !== null || this.#closed || !existsSync(this.#folder)) return;
    try {
      const watcher = this.#watch(this.#folder, { recursive: true }, (_event, name) => {
        // Only notes count: a write's temporary file, Finder's .DS_Store or a hidden copy is not a change to a list.
        const file = name === null || name === undefined ? null : basename(String(name));
        if (file !== null && (!file.endsWith(".md") || file.startsWith("."))) return;
        this.#schedule();
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.#watcher === watcher) this.#watcher = null;
      });
      this.#watcher = watcher;
    } catch {
      this.#watcher = null;
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#closed) this.#changed();
    }, this.#delay);
  }
}
