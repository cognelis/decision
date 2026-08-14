import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DecisionWatcher,
  MarkdownRepository,
  SqliteIndex,
  serializeDecision,
} from "../src/index.js";
import { recordFixture } from "./fixtures.js";

const makeWatcher = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-watcher-"));
  const repository = new MarkdownRepository(join(root, "vault"));
  const index = new SqliteIndex(join(root, "index.sqlite"));
  const diagnostics: Array<{ path: string; message: string }> = [];
  const onSynchronized = vi.fn();
  const watcher = new DecisionWatcher(
    repository,
    index,
    (diagnostic) => diagnostics.push(diagnostic),
    onSynchronized,
  );
  return {
    repository,
    index,
    diagnostics,
    onSynchronized,
    watcher,
  };
};

describe("DecisionWatcher", () => {
  it("re-indexes a valid external Markdown edit", async () => {
    const { repository, index, onSynchronized, watcher } =
      await makeWatcher();
    const stored = await repository.write(recordFixture());
    index.upsert(await repository.read(stored.path));
    const edited = serializeDecision(
      recordFixture({
        tags: ["externally-edited"],
        rationaleOriginal: "用户在 Obsidian 中改过。",
      }),
    );
    await writeFile(stored.path, edited, "utf8");

    await watcher.synchronizePath(stored.path);

    expect(index.search("externally-edited")).toHaveLength(1);
    expect((await repository.read(stored.path)).record.rationaleOriginal).toBe(
      "用户在 Obsidian 中改过。",
    );
    expect(onSynchronized).toHaveBeenCalledWith(stored.path);
    index.close();
  });

  it("reports malformed external Markdown without overwriting it", async () => {
    const {
      repository,
      index,
      diagnostics,
      onSynchronized,
      watcher,
    } = await makeWatcher();
    const path = join(repository.decisionsPath, "broken.md");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(repository.decisionsPath, { recursive: true }),
    );
    const malformed = "---\nid: broken\n---\nnot a decision";
    await writeFile(path, malformed, "utf8");

    await watcher.synchronizePath(path);

    expect(diagnostics).toEqual([
      expect.objectContaining({ path, message: expect.any(String) }),
    ]);
    expect(await readFile(path, "utf8")).toBe(malformed);
    expect(index.count()).toBe(0);
    expect(onSynchronized).not.toHaveBeenCalled();
    index.close();
  });

  it("removes a deleted note from the index", async () => {
    const { repository, index, onSynchronized, watcher } =
      await makeWatcher();
    const stored = await repository.write(recordFixture());
    index.upsert(await repository.read(stored.path));

    watcher.removePath(stored.path);

    expect(index.count()).toBe(0);
    expect(onSynchronized).toHaveBeenCalledWith(stored.path);
    index.close();
  });
});
