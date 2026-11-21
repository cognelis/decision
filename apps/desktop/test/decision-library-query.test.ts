import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionContextRepository, DecisionWatcher, MarkdownRepository, SqliteIndex, parseDecisionContextNote, serializeDecision, type DecisionContextSnapshot } from "@cognelis/decision-storage";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionAnswerCache, queryDecisionsWithReplies } from "../src/main/decision-library-query.js";

let root: string;
let index: SqliteIndex | undefined;
afterEach(async () => {
  index?.close();
  index = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

describe("decision library reply retrieval", () => {
  it("caches partial answers with duplicate note IDs and refreshes the reply after upsert", async () => {
    root = await mkdtemp(join(tmpdir(), "decision-answer-partial-"));
    const vault = join(root, "vault");
    const repository = new MarkdownRepository(vault);
    index = new SqliteIndex(join(root, "index.sqlite"));
    const record = recordFixture({ selectedAnswer: { kind: "preset", values: ["Markdown"], reply: "修改前的原话。" } });
    const saved = await repository.write(record);
    index.upsert(await repository.read(saved.path));
    const duplicate = await repository.write({ ...record, id: "duplicate-note" });
    await copyFile(duplicate.path, duplicate.path.replace(/\.md$/u, " copy.md"));
    const context = new DecisionContextRepository(vault);
    const scan = vi.spyOn(context, "scan");
    const cache = new DecisionAnswerCache(context, index);

    const first = await cache.read();
    expect((await scan.mock.results[0]!.value).sources).toContainEqual(expect.objectContaining({ source: "decisions", status: "partial", records: 1, skipped: 2 }));
    expect(first.has("duplicate-note")).toBe(false);
    expect(first.get(record.id)).toMatchObject({ reply: "修改前的原话。" });
    expect(await cache.read()).toBe(first);
    expect(scan).toHaveBeenCalledTimes(1);

    const edited = await repository.write({ ...record, selectedAnswer: { kind: "preset", values: ["Markdown"], reply: "更新后的原话。" } });
    index.upsert(await repository.read(edited.path));
    const updated = await cache.read();
    expect(updated.get(record.id)).toMatchObject({ reply: "更新后的原话。" });
    expect(await cache.read()).toBe(updated);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("reuses answers until watcher edits, additions, removal or rebuild change the index", async () => {
    root = await mkdtemp(join(tmpdir(), "decision-answer-cache-"));
    const vault = join(root, "vault");
    const repository = new MarkdownRepository(vault);
    index = new SqliteIndex(join(root, "index.sqlite"));
    const watcher = new DecisionWatcher(repository, index);
    const context = new DecisionContextRepository(vault);
    const scan = vi.spyOn(context, "scan");
    const cache = new DecisionAnswerCache(context, index);
    const record = recordFixture({ selectedAnswer: { kind: "preset", values: ["Markdown"], reply: "先用蓝莓。" } });
    try {
      const saved = await repository.write(record);
      await watcher.synchronizePath(saved.path);
      const first = await cache.read();
      expect(first.get(record.id)?.values).toEqual(["Markdown"]);
      expect(await cache.read()).toBe(first);
      expect(scan).toHaveBeenCalledTimes(1);

      const edited = await repository.write({ ...record, selectedAnswer: { kind: "preset", values: ["数据库"], reply: "改用草莓。" } });
      await watcher.synchronizePath(edited.path);
      expect((await cache.read()).get(record.id)).toEqual({ kind: "preset", values: ["数据库"], reply: "改用草莓。" });
      expect(scan).toHaveBeenCalledTimes(2);

      const added = await repository.write({ ...record, id: "new-answer" });
      await watcher.synchronizePath(added.path);
      expect((await cache.read()).get("new-answer")).toMatchObject({ reply: "先用蓝莓。" });
      expect(scan).toHaveBeenCalledTimes(3);

      await rm(added.path);
      watcher.removePath(added.path);
      expect((await cache.read()).has("new-answer")).toBe(false);
      expect(scan).toHaveBeenCalledTimes(4);

      await repository.write({ ...record, selectedAnswer: { kind: "preset", values: ["Markdown"], reply: "重建后用苹果。" } });
      index.rebuild((await repository.scan()).notes);
      const rebuilt = await cache.read();
      expect(rebuilt.get(record.id)).toMatchObject({ reply: "重建后用苹果。" });
      expect(await cache.read()).toBe(rebuilt);
      expect(scan).toHaveBeenCalledTimes(5);
    } finally { await watcher.close(); }
  });

  it("shares concurrent scans and discards a snapshot overtaken by an index update", async () => {
    let revision = 0;
    let release!: (snapshot: DecisionContextSnapshot) => void;
    const stale: DecisionContextSnapshot = { documents: [], sources: [{ source: "decisions", status: "empty", records: 0, skipped: 0 }] };
    const record = recordFixture({ selectedAnswer: { kind: "preset", values: ["Markdown"], reply: "修改后的原话。" } });
    const document = parseDecisionContextNote({ content: serializeDecision(record), relativePath: "Decision Journal/decisions/fresh.md", contentHash: "fresh", size: 1, modifiedAtMs: 0 }, "decisions")!;
    const fresh: DecisionContextSnapshot = { documents: [document], sources: [{ source: "decisions", status: "ready", records: 1, skipped: 0 }] };
    const scan = vi.fn().mockImplementationOnce(() => new Promise<DecisionContextSnapshot>((resolve) => { release = resolve; })).mockResolvedValue(fresh);
    const cache = new DecisionAnswerCache({ scan }, { revision: () => revision });
    const first = cache.read();
    const second = cache.read();
    revision += 1;
    const afterUpdate = cache.read();
    expect(scan).toHaveBeenCalledTimes(1);
    release(stale);
    const answers = await Promise.all([first, second, afterUpdate]);
    expect(answers[0]!.get(record.id)).toMatchObject({ reply: "修改后的原话。" });
    expect(answers[0]).toBe(answers[1]);
    expect(answers[1]).toBe(answers[2]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(await cache.read()).toBe(answers[0]);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("retries failed and unavailable scans instead of caching them indefinitely", async () => {
    const unavailable: DecisionContextSnapshot = { documents: [], sources: [{ source: "decisions", status: "unavailable", records: 0, skipped: 1 }] };
    const complete: DecisionContextSnapshot = { documents: [], sources: [{ source: "decisions", status: "empty", records: 0, skipped: 0 }] };
    const scan = vi.fn().mockRejectedValueOnce(new Error("temporarily unreadable")).mockResolvedValueOnce(unavailable).mockResolvedValue(complete);
    const cache = new DecisionAnswerCache({ scan }, { revision: () => 0 });
    await expect(cache.read()).rejects.toThrow("temporarily unreadable");
    const partial = await cache.read();
    const recovered = await cache.read();
    expect(recovered).not.toBe(partial);
    expect(await cache.read()).toBe(recovered);
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("finds long, short and mixed keywords from note replies against an unchanged existing SQLite index", async () => {
    root = await mkdtemp(join(tmpdir(), "decision-library-reply-"));
    const vault = join(root, "vault");
    const repository = new MarkdownRepository(vault);
    index = new SqliteIndex(join(root, "index.sqlite"));
    for (const [id, kind, reply] of [
      ["preset", "preset", "先用蓝莓方案，方便撤回。"],
      ["multiple", "multiple", "组合蓝莓与其他方案。"],
    ] as const) {
      const saved = await repository.write(recordFixture({ id, selectedAnswer: { kind, values: ["Markdown"], reply } }));
      index.upsert(await repository.read(saved.path));
    }
    index.close();
    index = new SqliteIndex(join(root, "index.sqlite"));
    // As R2 wrote it: the selected option is a label, and neither reply is present in FTS.
    expect(index.queryDecisions({ query: "蓝莓" })).toEqual([]);
    const snapshot = await new DecisionContextRepository(vault).scan();
    const answers = new Map(snapshot.documents.flatMap((document) => document.answer ? [[document.id, document.answer] as const] : []));
    const found = (query: string, extra = {}) => queryDecisionsWithReplies(index!, { query, ...extra }, answers).map(({ id }) => id);
    expect(found("蓝莓").sort()).toEqual(["multiple", "preset"]);
    expect(found("方便撤回")).toEqual(["preset"]);
    expect(found("Markdown 方便撤回")).toEqual(["preset"]);
    expect(found("Markdown 蓝莓").sort()).toEqual(["multiple", "preset"]);
    expect(found("不存在 蓝莓")).toEqual([]);
    expect(found("蓝莓", { sourceClient: "claude-code" })).toEqual([]);
    expect(found("蓝莓", { project: "other" })).toEqual([]);
    expect(found("蓝莓", { decisionId: "missing" })).toEqual([]);
    expect(found("蓝莓", { limit: 1 })).toHaveLength(1);
    expect(found("Markdown")).toHaveLength(2);
    expect(index.queryDecisions({ query: "蓝莓" })).toEqual([]);
  });

  it("resolves legacy IDs including custom letter replies using that note's options, retaining unknown and ambiguous IDs", async () => {
    root = await mkdtemp(join(tmpdir(), "decision-library-legacy-"));
    const repository = new MarkdownRepository(join(root, "vault"));
    index = new SqliteIndex(join(root, "index.sqlite"));
    for (const record of [
      recordFixture({ id: "legacy", selectedAnswer: { kind: "multiple", values: ["markdown", "database"], reply: "这两个都留着。" } }),
      recordFixture({ id: "custom", selectedAnswer: { kind: "custom", values: ["markdown"] } }),
      recordFixture({ id: "letter", options: [{ id: "A", label: "Markdown", tradeoffs: [] }], selectedAnswer: { kind: "custom", values: ["A"] } }),
      recordFixture({ id: "unknown", selectedAnswer: { kind: "preset", values: ["missing"] } }),
      recordFixture({ id: "ambiguous", options: [{ id: "A", label: "第一项", tradeoffs: [] }, { id: "A", label: "第二项", tradeoffs: [] }], selectedAnswer: { kind: "preset", values: ["A"] } }),
    ]) await repository.write(record);
    const snapshot = await new DecisionContextRepository(join(root, "vault")).scan();
    const answers = new Map(snapshot.documents.map((document) => [document.id, document.answer]));
    expect(answers.get("legacy")).toEqual({ kind: "multiple", values: ["Markdown", "数据库"], reply: "这两个都留着。" });
    expect(answers.get("custom")?.values).toEqual(["Markdown"]);
    expect(answers.get("letter")).toEqual({ kind: "custom", values: ["Markdown"] });
    expect(answers.get("unknown")?.values).toEqual(["missing"]);
    expect(answers.get("ambiguous")?.values).toEqual(["A"]);
  });
});
