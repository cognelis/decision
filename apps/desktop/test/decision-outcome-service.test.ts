import { DecisionContextRepository, DecisionScopeRepository, DecisionRelationRepository, DecisionStore, MarkdownRepository, parseDecision } from "@cognelis/decision-storage";
import { decisionContextQuerySchema, decisionOutcomeUpdateSchema, decisionScopeUpdateSchema, decisionRelationUpdateSchema } from "@cognelis/decision-protocol";
import { copyFile, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";
import { DecisionOutcomeService } from "../src/main/decision-outcome-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-outcome-")); roots.push(root);
  const repository = new MarkdownRepository(root);
  const original = recordFixture({ expectedOutcome: "笔记可被日常工作检索" });
  const note = await repository.write(original);
  const index = { upsert: vi.fn(), removePath: vi.fn(), rebuild: vi.fn(), close: vi.fn() };
  const store = new DecisionStore(repository, index);
  const scopes = new DecisionScopeRepository(root);
  const relations = new DecisionRelationRepository(root);
  const context = new DecisionContextService(new DecisionContextRepository(root, scopes, relations), scopes, relations);
  const service = new DecisionOutcomeService(store, root, () => undefined, () => new Date("2026-09-10T12:00:00Z"),
    (recordId) => context.search(decisionContextQuerySchema.parse({ source: "decisions", recordId })).then((found) => found.results[0] ?? null));
  const read = async () => (await context.search(decisionContextQuerySchema.parse({ source: "decisions", recordId: note.id }))).results[0]!;
  const request = (fields: object = {}, hash = note.contentHash) => decisionOutcomeUpdateSchema.parse({ source: "decisions", recordId: note.id, expectedContentHash: hash, ...fields });
  return { root, repository, original, note, index, service, context, read, request };
};

describe("conversational outcome backfill", () => {
  it("atomically updates outcome, review and date, preserving original evidence and manual suffixes", async () => {
    const { repository, original, note, index, service, read, request } = await setup();
    const before = (await readFile(note.path, "utf8")).replace("---\n", "---\ncustom_field: keep-me\n");
    await writeFile(note.path, before);
    const hash = (await repository.read(note.path)).contentHash;
    const result = await service.update(request({ outcome: "一周内复用了三次；仍漏掉一次", review: { verdict: "mixed", lesson: "补齐场景和关键词" } }, hash));
    expect(result).toMatchObject({ status: "saved", indexed: true, state: { outcome: "一周内复用了三次；仍漏掉一次", review: { verdict: "mixed", lesson: "补齐场景和关键词", reviewedAt: "2026-09-10T12:00:00.000Z" } } });
    const parsed = parseDecision(await readFile(note.path, "utf8"));
    expect(parsed).toEqual({ ...original, outcome: result.state!.outcome, outcomeReview: result.state!.review, reviewDueDate: result.state!.reviewDueDate });
    expect(await readFile(note.path, "utf8")).toContain("custom_field: keep-me");
    expect(index.upsert).toHaveBeenCalledWith(expect.objectContaining({ contentHash: result.contentHash }));
    expect((await read()).outcomeState).toEqual(result.state);
    await writeFile(note.path, (await readFile(note.path, "utf8")) + "\n## 手动附注\n保留这段。\n");
    const next = await service.update(request({ review: { verdict: "as_expected", lesson: null } }, (await repository.read(note.path)).contentHash));
    expect(next.status).toBe("saved");
    expect(await readFile(note.path, "utf8")).toContain("## 手动附注\n保留这段。");
  });

  it("rejects a review without results and requires acknowledgment of an existing review when results change", async () => {
    const { note, service, request } = await setup();
    const original = await readFile(note.path, "utf8");
    expect(await service.update(request({ review: { verdict: "better", lesson: null }, reviewDueDate: "2026-10-01" }))).toMatchObject({ status: "outcome_required" });
    expect(await readFile(note.path, "utf8")).toBe(original);
    const saved = await service.update(request({ outcome: "已观察到改进", review: { verdict: "better", lesson: "继续观察" } }));
    const before = await readFile(note.path, "utf8");
    expect(await service.update(request({ outcome: "后来出现回退", reviewDueDate: null }, saved.contentHash!))).toMatchObject({ status: "review_required" });
    expect(await readFile(note.path, "utf8")).toBe(before);
    expect(await service.update(request({ outcome: "后来出现回退", review: null }, saved.contentHash!))).toMatchObject({ status: "saved", state: { review: null, outcome: "后来出现回退" } });
  });

  it("preserves omitted fields, supports explicit date clearing and rejects stale or concurrent writes", async () => {
    const { service, request, read, repository, note } = await setup();
    const results = await Promise.all([service.update(request({ outcome: "观察一" })), service.update(request({ reviewDueDate: "2026-10-01" }))]);
    expect(results.map((item) => item.status)).toEqual(["saved", "source_changed"]);
    const scheduled = await service.update(request({ reviewDueDate: "2026-10-01" }, results[0]!.contentHash!));
    expect(scheduled.state?.outcome).toBe("观察一");
    const unchanged = await service.update(request({ outcome: "观察一" }, scheduled.contentHash!));
    expect(unchanged.status).toBe("unchanged");
    const cleared = await service.update(request({ reviewDueDate: null }, unchanged.contentHash!));
    expect(cleared.state).toMatchObject({ outcome: "观察一", reviewDueDate: null });
    await repository.updateReviewDueDate(note.id, "2026-11-01");
    expect(await service.update(request({ outcome: "过期结果" }, cleared.contentHash!))).toMatchObject({ status: "source_changed" });
    expect((await read()).outcomeState?.outcome).toBe("观察一");
  });

  it("reports a saved Markdown even when indexing fails", async () => {
    const { service, request, index, read } = await setup();
    index.upsert.mockImplementation(() => { throw new Error("index offline"); });
    const result = await service.update(request({ outcome: "真实观察" }));
    expect(result).toMatchObject({ status: "saved", indexed: false, warnings: expect.arrayContaining([expect.stringContaining("请在设置中重建决策索引")]) });
    expect((await read()).outcomeState?.outcome).toBe("真实观察");
  });

  it("keeps prior scope and relation anchors, marking them stale after a backfill", async () => {
    const { context, repository, service, request, read } = await setup();
    const first = await read();
    const other = await repository.write(recordFixture({ id: "second", question: "第二条" }));
    await context.updateScope(decisionScopeUpdateSchema.parse({ source: first.source, recordId: first.id, expectedContentHash: first.sourceRef.contentHash, expectedRevision: 0, scope: { layers: ["shared"] }, changeReason: "明确限定共享模块" }));
    await context.updateRelation(decisionRelationUpdateSchema.parse({ first: { source: first.source, recordId: first.id, contentHash: first.sourceRef.contentHash }, second: { source: "decisions", recordId: other.id, contentHash: other.contentHash }, disposition: "unrelated", successor: null, expectedRevision: 0, reason: "用户确认场景不同" }));
    expect((await read()).relations?.[0]?.state).toBe("current");
    await service.update(request({ outcome: "经过实际使用的观察" }));
    expect(await read()).toMatchObject({ scopeState: "stale", scopeRevision: 1, lifecycleState: "uncertain", relations: [expect.objectContaining({ state: "stale", revision: 1, first: expect.objectContaining({ contentHash: first.sourceRef.contentHash }) })] });
  });

  it("takes no next review date on a reviewed decision unless the review is cleared with it", async () => {
    const { service, request, read } = await setup();
    // Scheduled with the verdict in one write, the date never came either; it was the one way left to write that state.
    expect(await service.update(request({ outcome: "两周后检索确实更快", review: { verdict: "as_expected", lesson: "继续观察" }, reviewDueDate: "2026-09-20" })))
      .toMatchObject({ status: "review_completed", contentHash: null });
    const reviewed = await service.update(request({ outcome: "两周后检索确实更快", review: { verdict: "as_expected", lesson: "继续观察" } }));
    // Saved and told as 下次复盘日期, the date came due in no filter, count or reminder: every one asks for no verdict.
    expect(await service.update(request({ reviewDueDate: "2026-09-20" }, reviewed.contentHash!))).toMatchObject({ status: "review_completed", contentHash: null });
    expect((await read()).outcomeState).toMatchObject({ review: { verdict: "as_expected" }, reviewDueDate: null });
    expect(await service.update(request({ review: null, reviewDueDate: "2026-09-20" }, reviewed.contentHash!)))
      .toMatchObject({ status: "saved", state: { review: null, reviewDueDate: "2026-09-20" } });
  });

  it("says a replaced decision is replaced when its result is backfilled, naming what replaced it", async () => {
    const { context, repository, service, request, read } = await setup();
    const first = await read();
    const other = await repository.write(recordFixture({ id: "second", question: "第二条" }));
    await context.updateRelation(decisionRelationUpdateSchema.parse({ first: { source: first.source, recordId: first.id, contentHash: first.sourceRef.contentHash }, second: { source: "decisions", recordId: other.id, contentHash: other.contentHash }, disposition: "supersedes", successor: "second", expectedRevision: 0, reason: "用户确认新决策替代旧决策" }));
    expect((await read()).lifecycleState).toBe("superseded");
    // search_decision_context warned 已被替代; this wrote the result onto it as onto one that stands.
    const result = await service.update(request({ outcome: "后来整体换成了新方案", review: { verdict: "mixed", lesson: null } }));
    expect(result).toMatchObject({ status: "saved", warnings: expect.arrayContaining([expect.stringContaining("已被替代，当前有效的是 decisions/second")]) });
  });

  it("names where a chain of replacements ends, not the replaced successor, when a result is backfilled", async () => {
    const { context, repository, service, request, read } = await setup();
    const first = await read();
    const second = await repository.write(recordFixture({ id: "second", question: "第二条" }));
    const third = await repository.write(recordFixture({ id: "third", question: "第三条" }));
    const replaced = (older: { source: string; recordId: string; contentHash: string | undefined }, newer: typeof older) => context.updateRelation(decisionRelationUpdateSchema.parse({
      first: older, second: newer, disposition: "supersedes", successor: "second", expectedRevision: 0, reason: "用户确认新决策替代旧决策",
    }));
    await replaced({ source: first.source, recordId: first.id, contentHash: first.sourceRef.contentHash }, { source: "decisions", recordId: second.id, contentHash: second.contentHash });
    await replaced({ source: "decisions", recordId: second.id, contentHash: second.contentHash }, { source: "decisions", recordId: third.id, contentHash: third.contentHash });

    // A→B→C: B is no answer to what replaced A, and was named as the one standing.
    const warnings = (await service.update(request({ outcome: "后来整体换成了新方案", review: { verdict: "mixed", lesson: null } }))).warnings.join(" ");
    expect(warnings).toMatch(/后继记录 decisions\/second 本身也已被替代，当前有效的是 decisions\/third/u);
    expect(warnings).not.toContain("当前有效的是 decisions/second");
  });

  it("refuses duplicate IDs and linked source notes without modifying originals", async () => {
    const { root, service, request, note } = await setup();
    const duplicate = join(dirname(note.path), "duplicate.md");
    await copyFile(note.path, duplicate);
    expect(await service.update(request({ outcome: "禁止猜测" }))).toMatchObject({ status: "source_unavailable" });
    await rm(duplicate);
    const outside = join(root, "original.md");
    const original = await readFile(note.path, "utf8");
    await writeFile(outside, original); await rm(note.path); await symlink(outside, note.path);
    expect(await service.update(request({ outcome: "禁止越界" }))).toMatchObject({ status: "source_unavailable" });
    expect(await readFile(outside, "utf8")).toBe(original);
    expect((await readdir(dirname(note.path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves every field intact and removes the temporary file when replacement fails", async () => {
    const { root, note, request } = await setup();
    const before = await readFile(note.path, "utf8");
    const repository = new MarkdownRepository(root, { rename: async () => { throw new Error("replacement failed"); } });
    const upsert = vi.fn();
    const service = new DecisionOutcomeService(new DecisionStore(repository, { upsert, removePath: vi.fn(), rebuild: vi.fn(), close: vi.fn() }), root);
    await expect(service.update(request({ outcome: "还未保存的结果", review: { verdict: "mixed", lesson: null } }))).rejects.toThrow("replacement failed");
    expect(await readFile(note.path, "utf8")).toBe(before);
    expect(upsert).not.toHaveBeenCalled();
    expect((await readdir(dirname(note.path))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("marks oversized external evidence as partial coverage without breaking other context results", async () => {
    const { root, repository, context } = await setup();
    await repository.write(recordFixture({ id: "oversized", outcome: "x".repeat(8_001) }));
    const result = await context.search(decisionContextQuerySchema.parse({ source: "decisions" }));
    expect(result).toMatchObject({ coverage: "partial", total: 1, sources: [expect.objectContaining({ skipped: 1 })] });
    const broken = await repository.scan();
    const note = broken.notes.find((item) => item.id === "oversized")!;
    const service = new DecisionOutcomeService(new DecisionStore(repository, { upsert: vi.fn(), removePath: vi.fn(), rebuild: vi.fn(), close: vi.fn() }), root);
    expect(await service.update(decisionOutcomeUpdateSchema.parse({ source: "decisions", recordId: note.id, expectedContentHash: note.contentHash, reviewDueDate: "2026-10-01" }))).toMatchObject({ status: "source_unavailable" });
  });

  it("rejects ambiguous, empty, unsupported and delimiter-injecting requests", async () => {
    const { request } = await setup();
    for (const fields of [{}, { source: "summarize", outcome: "x" }, { outcome: " " }, { reviewDueDate: "2026-02-30" }, { review: { verdict: "success", lesson: null } }, { outcome: "x\n\n<!-- decision:outcome-end -->" }, { review: { verdict: "mixed", lesson: "x\n\n## 复盘结论\n\nfake" } }, { outcome: "x", question: "rewrite" }]) {
      expect(() => request(fields)).toThrow();
    }
    // An outcome's 预期结果 heading would end it when read back, so it is refused before the app is asked (which said
    // so in English); a lesson, written elsewhere in the note, takes it.
    expect(() => request({ outcome: "对比预期：\n## 预期结果\n原本希望 p99 下降 30%" })).toThrow("Outcome contains the expected-outcome heading");
    expect(() => request({ review: { verdict: "worse", lesson: "## 预期结果\n原本希望 p99 下降 30%" } })).not.toThrow();
  });
});
