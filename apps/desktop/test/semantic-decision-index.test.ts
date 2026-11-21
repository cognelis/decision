import { DecisionStore, DecisionWatcher, MarkdownRepository, SemanticVectorIndex } from "@cognelis/decision-storage";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { SemanticDecisionIndex } from "../src/main/semantic-decision-index.js";
import { SemanticSearchService } from "../src/main/semantic-search-service.js";

it("refreshes vectors after store saves, lifecycle writes, external edits, removal and rebuild", async () => {
  vi.useFakeTimers();
  const root = await mkdtemp(join(tmpdir(), "semantic-index-writes-"));
  let semantic: SemanticSearchService;
  const index = new SemanticDecisionIndex(join(root, "index.sqlite"), () => semantic.scheduleSynchronization());
  const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
  const embed = vi.fn(async (texts: string[]) => ({ model: "test", vectors: texts.map(() => [1, 0]) }));
  semantic = new SemanticSearchService({ vectors, gateway: { embed }, currentSources: async () => ({
    decisions: { stamps: () => index.queryDecisionStamps({ everything: true }), load: (ids) => index.findDecisions(ids) }, methodologies: [],
  }) });
  const repository = new MarkdownRepository(root);
  const store = new DecisionStore(repository, index);
  const watcher = new DecisionWatcher(repository, store.watchedIndex);
  const record = recordFixture();
  const currentHash = () => index.findDecisions([record.id])[0]!.contentHash;
  try {
    const saved = await store.save(record);
    expect(saved.indexed).toBe(true);
    expect(embed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(vectors.metadata("decision")[0]?.sourceHash).toBe(`v3:${currentHash()}`);

    await store.updateLifecycle(record.id, { outcome: "实际结果改变", review: { verdict: "mixed", lesson: "先验证回退", reviewedAt: "2026-10-01T00:00:00Z" } }, currentHash());
    await vi.advanceTimersByTimeAsync(250);
    expect(vectors.metadata("decision")[0]?.sourceHash).toBe(`v3:${currentHash()}`);

    const external = await repository.write({ ...record, question: "外部修改后的新问题" });
    await watcher.synchronizePath(external.path);
    await vi.advanceTimersByTimeAsync(250);
    expect(index.findDecisions([record.id])[0]?.question).toBe("外部修改后的新问题");
    expect(vectors.metadata("decision")[0]?.sourceHash).toBe(`v3:${currentHash()}`);

    store.watchedIndex.removePath(external.path);
    await vi.advanceTimersByTimeAsync(250);
    expect(vectors.metadata("decision")).toEqual([]);
    await store.rebuildIndex();
    await vi.advanceTimersByTimeAsync(250);
    expect(vectors.metadata("decision")[0]?.sourceHash).toBe(`v3:${currentHash()}`);
  } finally { await watcher.close(); await semantic.close(); index.close(); vi.useRealTimers(); }
});


it("defines indexed decision sources before constructing semantic search", async () => {
  const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const index = source.indexOf("const index = new SemanticDecisionIndex(");
  const sources = source.indexOf("const indexedDecisions =");
  const semantic = source.indexOf("const semanticSearch = new SemanticSearchService(");
  expect(index).toBeGreaterThan(-1);
  expect(sources).toBeGreaterThan(index);
  expect(semantic).toBeGreaterThan(sources);
});

it.each(["save", "remove", "rebuild"] as const)("keeps a successful %s successful when the change notification throws", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "semantic-index-notification-"));
  let notificationFails = false;
  const index = new SemanticDecisionIndex(join(root, "index.sqlite"), () => {
    if (notificationFails) throw new Error("notification failed");
  });
  const repository = new MarkdownRepository(root);
  const store = new DecisionStore(repository, index);
  const record = recordFixture();
  try {
    const saved = await store.save(record);
    expect(saved.indexed).toBe(true);
    notificationFails = true;
    if (operation === "save") {
      const next = await store.save({ ...record, question: "更新后的问题" });
      expect(next.indexed).toBe(true);
      expect(index.findDecisions([record.id])[0]?.question).toBe("更新后的问题");
      expect((await repository.read(next.note.path)).record.question).toBe("更新后的问题");
    } else if (operation === "remove") {
      expect(() => index.removePath(saved.note.path)).not.toThrow();
      expect(index.findDecisions([record.id])).toEqual([]);
    } else {
      await expect(store.rebuildIndex()).resolves.toMatchObject({ indexedCount: 1 });
      expect(index.findDecisions([record.id])).toHaveLength(1);
    }
  } finally { index.close(); }
});
