import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionContextRepository, createDecisionFeedbackStore } from "@cognelis/decision-storage";
import { decisionFeedbackUpdateSchema, decisionFeedbackQuerySchema } from "@cognelis/decision-protocol";
import { DecisionFeedbackService } from "../src/main/decision-feedback-service.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-feedback-")); roots.push(root);
  const folder = join(root, "Decision Journal/summarize"); await mkdir(folder, { recursive: true });
  const path = join(folder, "A.md"); await writeFile(path, "---\nid: A\ncreated: 2026-09-01\nstatus: accepted\nproject: demo\nselected_option: 使用业务编号\n---\n原始依据\n");
  const context = new DecisionContextRepository(root); const store = createDecisionFeedbackStore(root);
  const service = new DecisionFeedbackService(context, store, () => new Date("2026-09-11T08:00:00Z"));
  const doc = (await context.scan()).documents[0]!;
  const input = decisionFeedbackUpdateSchema.parse({ feedbackId: randomUUID(), expectedRevision: 0, reference: { source: doc.source, recordId: doc.id, expectedContentHash: doc.contentHash }, task: "列表重排时核对选择", project: "demo", taskScope: { layer: "frontend" }, rating: "helpful", reason: "原文解释了编号稳定性的原因" });
  return { root, path, store, service, input, list: (extra = {}) => service.list(decisionFeedbackQuerySchema.parse(extra)) };
};
describe("decision use feedback", () => {
  it("reads without creating a feedback directory and stores explicit feedback without changing the source", async () => {
    const { root, path, service, input, list } = await setup(); const before = await readFile(path, "utf8");
    expect(await list()).toMatchObject({ coverage: "complete", total: 0 });
    expect(await readdir(join(root, "Decision Journal"))).toEqual(["summarize"]);
    expect(await service.save(input)).toMatchObject({ status: "saved", revision: 1, noDecisionChanged: true });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await list()).toMatchObject({ activeCount: 1, ratings: { helpful: 1 }, currentSourceRatings: { helpful: 1 }, results: [{ sourceState: "current", record: { task: input.task, project: "demo", taskScope: { layer: "frontend" } } }] });
  });
  it("is stopped only by a note set aside that could be the record itself", async () => {
    const { root, service, input, list } = await setup();
    expect(await service.save(input)).toMatchObject({ status: "saved" });
    const folder = join(root, "Decision Journal/summarize");
    // Broken while edited in Obsidian, and nothing to do with A: it stopped every record's feedback.
    await writeFile(join(folder, "Z.md"), "---\nid: Z\nselected_option: [unclosed\n---\n正文\n");
    expect(await service.save({ ...input, feedbackId: randomUUID() })).toMatchObject({ status: "saved" });
    expect(await list()).toMatchObject({ results: [{ sourceState: "current" }, { sourceState: "current" }] });
    // A broken copy naming A could be A: which one counts cannot be told.
    await writeFile(join(folder, "A copy.md"), "---\nid: A\nselected_option: [unclosed\n---\n正文\n");
    expect(await service.save({ ...input, feedbackId: randomUUID() })).toMatchObject({ status: "source_unavailable" });
    expect((await list()).results.every((result) => result.sourceState === "unavailable")).toBe(true);
  });

  it("acknowledges concurrent identical retries once, including after later source changes", async () => {
    const { path, service, input, list } = await setup();
    expect((await Promise.all([service.save(input), service.save(input)])).map((result) => result.status)).toEqual(["saved", "unchanged"]);
    await writeFile(path, (await readFile(path, "utf8")) + "新的上下文\n");
    expect(await service.save(input)).toMatchObject({ status: "unchanged", revision: 1 });
    expect(await list()).toMatchObject({ activeCount: 1, ratings: { helpful: 1 }, currentSourceRatings: { helpful: 0 }, results: [{ sourceState: "changed" }] });
    expect(await service.save({ ...input, feedbackId: randomUUID() })).toMatchObject({ status: "source_changed" });
  });
  it("revises one observation without double counting and keeps bounded history", async () => {
    const { service, input, list } = await setup(); await service.save(input);
    const next = { ...input, expectedRevision: 1, rating: "not_applicable" as const, reason: "后来核对发现新列表需要保留临时行" };
    expect(await service.save(next)).toMatchObject({ status: "saved", revision: 2 });
    expect(await service.save(input)).toMatchObject({ status: "revision_conflict" });
    expect(await list()).toMatchObject({ activeCount: 1, ratings: { helpful: 0, not_applicable: 1 }, results: [{ record: { history: [{ revision: 1, rating: "helpful" }] } }] });
    for (let rev = 2; rev < 24; rev++) await service.save({ ...next, expectedRevision: rev, reason: `修订说明 ${rev}` });
    const record = (await list()).results[0]!.record;
    expect(record.history).toHaveLength(20); expect(record.revision).toBe(24);
  });
  it("withdraws after the source disappears, retaining the original task and rating", async () => {
    const { path, service, input, list } = await setup(); await service.save(input); await rm(path);
    expect(await service.save({ ...input, expectedRevision: 1, withdrawn: true, task: "篡改任务", reason: "撤回" })).toMatchObject({ status: "revision_conflict" });
    const withdrawal = { ...input, expectedRevision: 1, withdrawn: true, reason: "当时判断有误，撤回观察" };
    expect(await service.save(withdrawal)).toMatchObject({ status: "saved", revision: 2 });
    expect(await service.save(withdrawal)).toMatchObject({ status: "unchanged" });
    expect(await list()).toMatchObject({ activeCount: 0, withdrawnCount: 1, total: 0, ratings: { helpful: 0 } });
    expect(await list({ includeWithdrawn: true })).toMatchObject({ total: 1, results: [{ sourceState: "missing", record: { withdrawn: true, task: input.task, rating: "helpful" } }] });
    expect(await service.save({ ...withdrawal, feedbackId: randomUUID(), expectedRevision: 0 })).toMatchObject({ status: "feedback_not_found" });
  });
  it("filters task projects and paginates all latest observations", async () => {
    const { service, input, list } = await setup();
    for (let i = 0; i < 3; i++) await service.save({ ...input, feedbackId: randomUUID(), project: i < 2 ? "demo" : "other" });
    const page = await list({ source: "summarize", recordId: "A", project: "demo", limit: 1 });
    expect(page).toMatchObject({ activeCount: 2, total: 2, nextOffset: 1, ratings: { helpful: 2 } });
    expect((await list({ project: "demo", limit: 1, offset: 1 })).results[0]!.record.feedbackId).not.toBe(page.results[0]!.record.feedbackId);
  });
  it("reports partial metadata and refuses writes instead of treating damaged feedback as absent", async () => {
    const { root, service, input, list } = await setup(); await service.save(input);
    await writeFile(join(root, "Decision Journal/decision-feedback/broken.md"), "broken");
    expect(await list()).toMatchObject({ coverage: "partial", activeCount: 1 });
    expect(await service.save({ ...input, feedbackId: randomUUID() })).toMatchObject({ status: "feedback_unavailable" });
  });
  it("does not call coverage complete when a feedback note of its own name cannot be read", async () => {
    const { root, service, input, list } = await setup(); await service.save(input);
    // Edited past reading in Obsidian: a rating typed in Chinese, in the note named for that feedback.
    const folder = join(root, "Decision Journal/decision-feedback");
    const [name] = await readdir(folder);
    await writeFile(join(folder, name!), (await readFile(join(folder, name!), "utf8")).replace("rating: helpful", "rating: 很有帮助"));
    // It could be feedback on this record: 还没有记录使用反馈 would not be true.
    expect(await list({ source: "summarize", recordId: "A" })).toMatchObject({ coverage: "unavailable", total: 0 });
  });
  it("rejects incomplete references, empty evidence and invalid ratings", async () => {
    const { input } = await setup();
    for (const overrides of [{ feedbackId: "not-uuid" }, { task: " " }, { reason: "" }, { rating: "success" }, { expectedRevision: -1 }]) expect(() => decisionFeedbackUpdateSchema.parse({ ...input, ...overrides })).toThrow();
    expect(() => decisionFeedbackQuerySchema.parse({ source: "summarize" })).toThrow();
  });
});
