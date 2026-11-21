import { createJournalEntry } from "@cognelis/decision-core";
import { DecisionAmendmentRepository, JournalEntryRepository } from "@cognelis/decision-storage";
import { decisionContextQuerySchema } from "@cognelis/decision-protocol";
import { mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CurrentJournal } from "../src/main/current-journal.js";
import { DecisionAmendmentService, journalContentHash } from "../src/main/decision-context-amendments.js";
import { ContextSearch } from "../src/main/decision-context-signals.js";
import { readSources } from "../src/main/organization-sources.js";
import { organizationSourceAccess } from "../src/main/organization-authorization.js";
import { emptyOrganizationState } from "../src/main/organization-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-current-journal-")); roots.push(root);
  const journal = new JournalEntryRepository(root), amendments = new DecisionAmendmentRepository(root);
  for (const [id, kind] of [["P", "preference"], ["Q", "preference"], ["I", "idea"]] as const) await journal.create(createJournalEntry(
    kind === "preference" ? { kind, title: `合成回滚 ${id}`, content: `原始约定 ${id}`, knowledgeStatus: "active", appliesWhen: "仅测试", exceptions: "生产未批准" }
      : { kind, title: "合成想法", content: "待验证想法", whyInteresting: "合成验证价值", knowledgeStatus: "active" },
    { sourceKind: "app_manual", sourceForm: "user_original", project: "synthetic" }, id, new Date("2026-11-16T01:00:00Z")));
  const service = new DecisionAmendmentService(amendments, { find: async (_source, id) => {
    const entry = await journal.find(id, { sure: true });
    return entry === null ? null : { contentHash: journalContentHash(entry), summary: entry.content, appliesWhen: entry.kind === "preference" ? entry.appliesWhen : null, caution: entry.kind === "preference" ? entry.exceptions : null, userWrote: true };
  } }, () => undefined);
  const current = new CurrentJournal(journal, amendments);
  const change = (id: string, action: "withdraw" | "restore", expectedRevision: number) => service.update({ amendVersion: 1, sourceClient: "codex", source: id === "I" ? "ideas" : "preferences", recordId: id, action, expectedRevision, reason: "合成用户要求", basis: "user_said" });
  const search = new ContextSearch({ search: async () => { throw new Error("unexpected decision search"); } }, { scan: () => journal.list({ everything: true }) }, undefined, amendments);
  return { root, journal, amendments, current, service, change, search };
};

describe("RSI-16 current journal evidence", () => {
  it.each(["P", "I"])("honors withdrawal and restoration without changing the original: %s", async id => {
    const c = await setup(); const scan = await c.journal.list({ everything: true });
    const path = join(c.root, scan.relativePaths!.get(id)!); const before = await readFile(path, "utf8");
    expect(await c.change(id, "withdraw", 0)).toMatchObject({ status: "saved" });
    expect((await c.current.list()).entries.some(entry => entry.id === id)).toBe(false);
    expect(await c.current.find(id)).toBeNull();
    expect(await c.change(id, "restore", 1)).toMatchObject({ status: "saved" });
    expect((await c.current.find(id))?.id).toBe(id);
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("matches rewritten and added words before ranking and preserves provenance and qualifiers", async () => {
    const c = await setup(); const original = (await c.journal.find("P"))!;
    expect(await c.service.update({ amendVersion: 1, sourceClient: "codex", source: "preferences", recordId: "P", action: "revise", expectedRevision: 0, expectedContentHash: journalContentHash(original), fields: { summary: "改用绿色通道", appliesWhen: "仅灰度阶段", caution: "需人工授权" }, reason: "合成改写", basis: "user_said" })).toMatchObject({ status: "saved" });
    expect(await c.service.update({ amendVersion: 1, sourceClient: "codex", source: "preferences", recordId: "P", action: "append", text: "新补充条件", basis: "user_said" })).toMatchObject({ status: "saved" });
    const result = (await c.current.list({ query: "绿色通道", limit: 1 })).entries;
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id: "P", appliesWhen: "仅灰度阶段", exceptions: "需人工授权" });
    expect(result[0]!.content).toContain("改写"); expect(result[0]!.content).toContain("新补充条件");
    expect((await c.current.list({ query: "新补充条件", limit: 1 })).entries[0]?.id).toBe("P");
    expect((await c.journal.find("P"))!.content).toBe(original.content);
  });
  it("quarantines only the damaged amendment and reports incomplete coverage in all readers", async () => {
    const c = await setup(); await c.change("P", "withdraw", 0);
    await writeFile(join(c.root, c.amendments.relativePath("preferences", "P")), "synthetic broken metadata");
    const scan = await c.amendments.scan(); expect(scan.unavailable).toBe(false); expect(scan.inDoubt("preferences:P")).toBe(true);
    const result = await c.current.list(); expect(result.entries.map(entry => entry.id)).not.toContain("P"); expect(result.entries.map(entry => entry.id)).toContain("Q"); expect(result.diagnostics.length).toBeGreaterThan(0);
    await expect(c.current.find("P")).rejects.toThrow("无法核对"); expect((await c.current.find("Q"))?.id).toBe("Q");
    const searched = await c.search.search(decisionContextQuerySchema.parse({ source: "preferences" }));
    expect(searched.results.map(entry => entry.id)).toEqual(["Q"]); expect(searched.coverage).toBe("partial");
    const sources = await readSources({ todos: async () => ({ lists: [], diagnostics: [] }), journal: () => c.journal.list({ everything: true }), decisions: async () => ({ documents: [], sources: [] }), amendments: () => c.amendments.scan(), experiences: async () => ({ experiences: [], diagnostics: [] }), relative: path => path }, new Date());
    expect(sources.units.get("preference:P")?.metadataUnreadable).toBe(true);
    const access = organizationSourceAccess(emptyOrganizationState(), sources);
    expect(access.usable(["preference:P"])).toBe(false); expect(access.usable(["preference:Q"])).toBe(true);
    expect(sources.incomplete.has("preference")).toBe(true);
  });
  it("keeps a healthy known source readable when an unrelated raw note is malformed", async () => {
    const c = await setup(); const scan = await c.journal.list({ everything: true });
    const path = join(c.root, scan.relativePaths!.get("P")!);
    await writeFile(path, "synthetic malformed original");
    expect((await c.current.list()).entries.map(entry => entry.id)).toContain("Q");
    expect((await c.current.find("Q"))?.id).toBe("Q");
    await expect(c.current.find("P")).rejects.toThrow("无法核对");
    await expect(c.current.find("missing")).rejects.toThrow("无法核对");
  });
  it("quarantines duplicate identities without hiding a healthy neighbor", async () => {
    const c = await setup(); const scan = await c.journal.list({ everything: true });
    const path = join(c.root, scan.relativePaths!.get("P")!);
    await writeFile(path.replace(/\.md$/u, "-duplicate.md"), (await readFile(path, "utf8")).replace("原始约定 P", "冲突的另一条原文"));
    expect((await c.current.list()).entries.map(entry => entry.id)).not.toContain("P");
    await expect(c.current.find("P")).rejects.toThrow("无法核对");
    expect((await c.current.find("Q"))?.id).toBe("Q");
    const result = await c.search.search(decisionContextQuerySchema.parse({ source: "preferences" }));
    expect(result.results.map(entry => entry.id)).toEqual(["Q"]); expect(result.coverage).toBe("partial");
  });
  it("never treats a globally unreadable amendment directory as no withdrawals", async () => {
    const c = await setup(); await c.change("P", "withdraw", 0);
    const folder = join(c.root, "Decision Journal/decision-amendments"); await rename(folder, `${folder}-held`); await writeFile(folder, "blocked");
    await expect(c.current.list()).rejects.toThrow("无法读取"); await expect(c.current.find("Q")).rejects.toThrow("无法读取");
    const result = await c.search.search(decisionContextQuerySchema.parse({ source: "preferences" }));
    expect(result.results).toEqual([]); expect(result.coverage).toBe("unavailable");
  });
  it("rejects a stale original snapshot and accepts its new text on the next read", async () => {
    const c = await setup(); const scan = await c.journal.list({ everything: true });
    const path = join(c.root, scan.relativePaths!.get("P")!); let first = true;
    const current = new CurrentJournal(c.journal, { scan: async () => {
      const snapshot = await c.amendments.scan();
      if (first) { first = false; await writeFile(path, (await readFile(path, "utf8")).replace("原始约定 P", "外部更新后的约定")); }
      return snapshot;
    } });
    const changed = await current.list(); expect(changed.entries.some(entry => entry.id === "P")).toBe(false); expect(changed.diagnostics.length).toBeGreaterThan(0);
    expect((await current.find("P"))?.content).toBe("外部更新后的约定");
  });
  it("does not publish a record changed between the source and metadata reads", async () => {
    const c = await setup(); let first = true;
    const current = new CurrentJournal(c.journal, { scan: async () => {
      const snapshot = await c.amendments.scan();
      if (first) { first = false; await c.change("P", "withdraw", 0); }
      return snapshot;
    } });
    expect((await current.list()).entries.some(entry => entry.id === "P")).toBe(false);
    expect(await current.find("P")).toBeNull();
  });
});
