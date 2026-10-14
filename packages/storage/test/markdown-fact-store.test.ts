import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownFactStore } from "../src/markdown-fact-store.js";
import { DecisionScopeRepository } from "../src/decision-scope.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-fact-store-")); roots.push(root);
  const schema = z.object({ id: z.string(), revision: z.number().int(), value: z.string() }).strict();
  const store = new MarkdownFactStore(root, "test-facts", { parse: (value) => schema.parse(value), key: (value) => value.id, heading: "测试元数据" });
  return { root, store };
};
describe("versioned Markdown filesystem", () => {
  it("does not create directories during reads and detects optimistic-write conflicts", async () => {
    const { root, store } = await setup();
    expect((await store.scan()).unavailable).toBe(false);
    expect(await readdir(root)).toEqual([]);
    const first = { id: "one", revision: 1, value: "original" };
    expect(await store.replace(first, null)).toBe("saved");
    const snapshot = await store.scan();
    await writeFile(join(root, store.relativePath("one")), "independent edit");
    expect(await store.replace({ ...first, revision: 2, value: "changed" }, snapshot.hashes.get("one")!)).toBe("conflict");
    expect(await readFile(join(root, store.relativePath("one")), "utf8")).toBe("independent edit");
  });
  it("reports a linked metadata file as unavailable and never overwrites its target", async (context) => {
    const { root, store } = await setup();
    const record = { id: "one", revision: 1, value: "original" };
    await store.replace(record, null);
    const path = join(root, store.relativePath("one"));
    const external = join(root, "outside.md"); await writeFile(external, "private outside content"); await unlink(path);
    try { await symlink(external, path); }
    catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) { context.skip(); return; }
      throw error;
    }
    expect((await store.scan()).unavailable).toBe(true);
    expect(await store.replace(record, null)).toBe("conflict");
    expect(await readFile(external, "utf8")).toBe("private outside content");
  });
  it("holds back only the scope a sync client's copy is of; the others stay readable and writable", async () => {
    const { root } = await setup();
    const scopes = new DecisionScopeRepository(root);
    const update = (recordId: string, expectedRevision = 0) => ({
      source: "decisions" as const, recordId, expectedRevision, expectedContentHash: "a".repeat(64), changeReason: "记录范围",
      scope: { projects: [], repositoryIds: [], modules: [], layers: ["frontend" as const], paths: [], excludedPaths: [], exceptions: [] },
    });
    await scopes.save(update("A"));
    await scopes.save(update("B"));
    const dir = join(root, "Decision Journal/decision-scopes");
    const name = createHash("sha256").update("decisions:A").digest("hex");
    // Two devices saved A's scope at once, and iCloud kept the other version beside it: every scope was dropped,
    // every other record's scope refused, and every source said to be partial.
    await writeFile(join(dir, `${name} 2.md`), await readFile(join(dir, `${name}.md`), "utf8"));

    const scan = await scopes.scan();
    expect(scan.unavailable).toBe(false);
    expect([scan.inDoubt("decisions:A"), scan.inDoubt("decisions:B")]).toEqual([true, false]);
    expect(await scopes.save(update("A", 1))).toMatchObject({ status: "source_unavailable" });
    expect(await scopes.save(update("B", 1))).toMatchObject({ status: "saved" });
  });

  it("reads the existing scope format with its original hashed filename", async () => {
    const { root } = await setup();
    const dir = join(root, "Decision Journal/decision-scopes"); await mkdir(dir, { recursive: true });
    const key = "summarize:A";
    const filename = `${createHash("sha256").update(key).digest("hex")}.md`;
    const scope = { scopeVersion: 1, source: "summarize", recordId: "A", revision: 1, updatedAt: "2026-09-10T00:00:00.000Z", contentHash: "a".repeat(64), scope: { layers: ["frontend"] }, changeReason: "已有范围", history: [] };
    const content = `---\n${stringify(scope)}---\n# 已有的范围记录\n`;
    await writeFile(join(dir, filename), content);
    const result = await new DecisionScopeRepository(root).scan();
    expect(result.unavailable).toBe(false);
    expect(result.records.get(key)).toMatchObject({ revision: 1, scope: { layers: ["frontend"] } });
    expect(await readFile(join(dir, filename), "utf8")).toBe(content);
  });
});
