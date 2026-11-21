import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TodoNoteWatcher } from "../src/main/todo-watch.js";

const roots: string[] = [];
const watchers: TodoNoteWatcher[] = [];
afterEach(async () => {
  for (const watcher of watchers.splice(0)) watcher.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const until = async (ok: () => boolean, ms = 4000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!ok() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
};

describe("TodoNoteWatcher", () => {
  it("says once for a burst of events on notes, and ignores what is not a note (a fake watch: no timing of the disk)", async () => {
    const root = await mkdtemp(join(tmpdir(), "todo-watch-"));
    roots.push(root);
    let listener: ((event: string, name: string | null) => void) | null = null;
    const watch = ((_path: string, _options: unknown, callback: (event: string, name: string | null) => void) => {
      listener = callback;
      return { on: () => undefined, close: () => undefined };
    }) as unknown as typeof import("node:fs").watch;
    const changed = vi.fn();
    const watcher = new TodoNoteWatcher(root, changed, { delay: 60, watch });
    watchers.push(watcher);
    watcher.ensure();
    watcher.ensure();
    expect(listener).not.toBeNull();

    for (const name of ["a.md.tmp", ".hidden.md", ".DS_Store", "2026"]) listener!("rename", name);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changed).not.toHaveBeenCalled();

    listener!("change", "2026/11/a.md");
    listener!("rename", "2026/11/b.md");
    listener!("change", null);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("starts watching once the folder exists, and stops when closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "todo-watch-"));
    roots.push(root);
    const folder = join(root, "todos");
    const changed = vi.fn();
    const watcher = new TodoNoteWatcher(folder, changed, { delay: 50 });
    watchers.push(watcher);
    watcher.ensure();
    await mkdir(folder, { recursive: true });
    watcher.ensure();
    await writeFile(join(folder, "b.md"), "1");
    await until(() => changed.mock.calls.length > 0);
    expect(changed).toHaveBeenCalled();

    watcher.close();
    changed.mockClear();
    await writeFile(join(folder, "b.md"), "2");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changed).not.toHaveBeenCalled();
  });
});
