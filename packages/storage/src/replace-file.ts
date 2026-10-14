import type { PathLike } from "node:fs";
import { rename } from "node:fs/promises";

const HELD_OPEN = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Renames a written file over the one it replaces, as an atomic save does. On Windows the file replaced may
 * be open for a moment (an antivirus scan, a sync client, Obsidian, the bridge reading runtime.json), and the
 * rename then fails with EPERM, EBUSY or EACCES: a save failed, or the app would not start, where waiting a
 * little succeeds. Elsewhere a failure is what it says.
 */
export const renameReplacing = async (
  from: PathLike,
  to: PathLike,
  options: {
    platform?: NodeJS.Platform;
    renameFile?: (from: PathLike, to: PathLike) => Promise<void>;
    wait?: (milliseconds: number) => Promise<void>;
    /** Checked again before each retry: what the caller confirmed before writing may have changed meanwhile. */
    beforeRetry?: () => Promise<void>;
  } = {},
): Promise<void> => {
  const platform = options.platform ?? process.platform;
  const renameFile = options.renameFile ?? rename;
  const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // About a second and a half in all.
      if (platform !== "win32" || code === undefined || !HELD_OPEN.has(code) || attempt === 5) throw error;
      await wait(50 * 2 ** attempt);
      // An edit saved in Obsidian while it waited was otherwise written over without a word.
      await options.beforeRetry?.();
    }
  }
};
