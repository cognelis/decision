import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";

// What syncing the temporary file answers: nothing, or the error of a volume that cannot, or of a disk that failed.
const sync = vi.hoisted(() => ({ error: null as NodeJS.ErrnoException | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const failing = sync.error;
      if (failing === null) return handle;
      return new Proxy(handle, {
        get: (target, key) => {
          if (key === "sync") return () => Promise.reject(failing);
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? (value as (...rest: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
});

import { replaceNote } from "../src/note-rewrite.js";

const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

it("saves on a volume that cannot sync, and refuses on a disk that fails to", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "replace-note-sync-")), "note.md");
  await writeFile(path, "---\nid: one\n---\n# 标题\n", "utf8");
  const raw = await readFile(path, "utf8");
  // Some network mounts: the note is written as it always was.
  sync.error = failure("ENOTSUP");
  await replaceNote(path, raw, "---\nid: one\n---\n# 新标题\n");
  expect(await readFile(path, "utf8")).toBe("---\nid: one\n---\n# 新标题\n");

  // A disk error, swallowed with the rest: a temporary file perhaps never written through took the note's place.
  sync.error = failure("EIO");
  await expect(replaceNote(path, "---\nid: one\n---\n# 新标题\n", "---\nid: one\n---\n# 再改\n")).rejects.toThrow("EIO");
  expect(await readFile(path, "utf8")).toBe("---\nid: one\n---\n# 新标题\n");
  expect((await readdir(dirname(path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});
