import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DecisionStore, LocalDecisionStore, MarkdownRepository, SqliteIndex } from "../src/index.js";
import { recordFixture } from "./fixtures.js";

it("keeps local primary records across vault rebuilds, database reopening and disposal replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-decision-"));
  const path = join(root, "local-decisions.sqlite");
  let local = new LocalDecisionStore(path);
  const index = new SqliteIndex(join(root, "index.sqlite"));
  const repository = new MarkdownRepository(join(root, "vault"));
  const store = new DecisionStore(repository, index);
  try {
    const record = recordFixture();
    local.save(record);
    local.save(record);
    expect(local.list().total).toBe(1);
    expect(local.list("Markdown").records[0]?.selectedAnswer).toEqual(record.selectedAnswer);
    expect((await repository.scan()).notes).toEqual([]);
    await store.rebuildIndex();
    expect(index.search("Markdown")).toEqual([]);
    local.close();
    local = new LocalDecisionStore(path);
    expect(local.get(record.id)).toMatchObject({ id: record.id, question: record.question });
    await store.publishLocal(local.get(record.id)!, local.content(record.id) ?? undefined);
    await store.publishLocal(local.get(record.id)!, local.content(record.id) ?? undefined);
    expect((await repository.scan()).notes).toHaveLength(1);
    local.resolve(record.id, "published");
    local.save(record);
    expect(local.list().total).toBe(0);
    const privateRecord = recordFixture({ id: "private-local", question: "private-body-sentinel" });
    local.save(privateRecord);
    local.resolve(privateRecord.id, "discarded");
    local.save(privateRecord);
    expect(local.list().total).toBe(0);
    expect((await readFile(path)).includes(Buffer.from("private-body-sentinel"))).toBe(false);
    await store.rebuildIndex();
    expect(index.search("Markdown")).toHaveLength(1);
  } finally { local.close(); index.close(); await rm(root, { recursive: true, force: true }); }
});

it("copies a deferred note before removing it, and keeps local data on a failed promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-transfer-"));
  const local = new LocalDecisionStore(join(root, "local-decisions.sqlite"));
  const index = new SqliteIndex(join(root, "index.sqlite"));
  const repository = new MarkdownRepository(join(root, "vault"));
  const store = new DecisionStore(repository, index);
  try {
    const record = recordFixture({ status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [] });
    const note = await store.save(record);
    await expect(store.keepDeferredLocally(record.id, { save() { throw new Error("disk full"); } }, {})).rejects.toThrow("disk full");
    expect((await repository.read(note.note.path)).id).toBe(record.id);
    const source = await readFile(note.note.path, "utf8");
    await writeFile(note.note.path, source + "\n## 用户附加内容\n\n不能丢失的业务背景\n");
    await store.keepDeferredLocally(record.id, local, { rationale: "仅保留在项目中" });
    expect(local.content(record.id)).toContain("不能丢失的业务背景");
    expect(local.get(record.id)?.rationaleOriginal).toBe("仅保留在项目中");
    expect(index.search("Markdown")).toEqual([]);
    await expect(readFile(note.note.path)).rejects.toMatchObject({ code: "ENOENT" });
    const originalWrite = repository.write.bind(repository);
    repository.write = async () => { throw new Error("vault unavailable"); };
    await expect(store.publishLocal(local.get(record.id)!, local.content(record.id) ?? undefined)).rejects.toThrow("vault unavailable");
    expect(local.get(record.id)).not.toBeNull();
    repository.write = originalWrite;
    const published = await store.publishLocal(local.get(record.id)!, local.content(record.id) ?? undefined);
    const original = await readFile(published.note.path, "utf8");
    expect(original).toContain("不能丢失的业务背景");
    await writeFile(published.note.path, original.replace("仅保留在项目中", "用户在 Obsidian 中改过"));
    await expect(store.publishLocal(local.get(record.id)!, local.content(record.id) ?? undefined)).rejects.toThrow("未覆盖");
    expect(await readFile(published.note.path, "utf8")).toContain("用户在 Obsidian 中改过");
    expect(local.get(record.id)).not.toBeNull();
  } finally { local.close(); index.close(); await rm(root, { recursive: true, force: true }); }
});
