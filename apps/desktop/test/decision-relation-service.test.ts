import { DecisionContextRepository, DecisionScopeRepository, DecisionRelationRepository, MarkdownRepository } from "@cognelis/decision-storage";
import { decisionContextQuerySchema, decisionRelationUpdateSchema, type DecisionRelationUpdate } from "@cognelis/decision-protocol";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionContextService } from "../src/main/decision-context-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-relation-")); roots.push(root);
  const directory = join(root, "Decision Journal/summarize"); await mkdir(directory, { recursive: true });
  for (const id of ["A", "B", "C"]) await writeFile(join(directory, `${id}.md`), `---\nid: ${id}\ncreated: 2026-09-01\nstatus: accepted\nproject: project\nselected_option: 采用方案 ${id}\n---\n# 选择\n记录方案 ${id} 的原始理由。\n`);
  const scopes = new DecisionScopeRepository(root);
  const relations = new DecisionRelationRepository(root);
  const repository = new DecisionContextRepository(root, scopes, relations);
  const service = new DecisionContextService(repository, scopes, relations);
  const read = async (id: string, source = "summarize") => (await service.search(decisionContextQuerySchema.parse({ recordId: id, source }))).results[0]!;
  const update = async (first: string, second: string, overrides: Partial<DecisionRelationUpdate> = {}) => {
    const a = await read(first); const b = await read(second);
    return decisionRelationUpdateSchema.parse({
      first: { source: a.source, recordId: a.id, contentHash: a.sourceRef.contentHash }, second: { source: b.source, recordId: b.id, contentHash: b.sourceRef.contentHash },
      disposition: "supersedes", successor: "second", expectedRevision: 0, reason: "用户明确确认替代关系", ...overrides,
    });
  };
  return { root, directory, repository, relations, service, read, update };
};

describe("historical decision relations", () => {
  it("records a directional successor with evidence and leaves source files unchanged", async () => {
    const { directory, service, read, update } = await setup();
    const before = await Promise.all(["A", "B"].map((id) => readFile(join(directory, `${id}.md`), "utf8")));
    expect(await service.updateRelation(await update("A", "B"))).toMatchObject({ status: "saved", revision: 1, originalNotesUnchanged: true });
    expect(await read("A")).toMatchObject({ current: false, lifecycleState: "superseded", successors: [expect.objectContaining({ source: "summarize", id: "B" })], relations: [expect.objectContaining({ successor: "other", revision: 1, state: "current" })] });
    expect(await read("B")).toMatchObject({ current: true, relations: [expect.objectContaining({ successor: "self" })] });
    expect(await Promise.all(["A", "B"].map((id) => readFile(join(directory, `${id}.md`), "utf8")))).toEqual(before);
  });
  it("follows a chain of replacements to the record that stands", async () => {
    const { service, read, update } = await setup();
    expect(await service.updateRelation(await update("A", "B"))).toMatchObject({ status: "saved" });
    expect(await service.updateRelation(await update("B", "C"))).toMatchObject({ status: "saved" });

    const a = await read("A");
    // B, replaced in turn, was shown as an accepted successor: the next agent took it as current.
    expect(a.successors).toEqual([expect.objectContaining({ id: "B", status: "superseded" })]);
    expect(a.warnings).toEqual(expect.arrayContaining([expect.stringContaining("当前有效的是 summarize/C")]));
  });

  it("records a replacement beside an unrelated broken note, but not with one that could be either side", async () => {
    const { directory, service, update } = await setup();
    const request = await update("A", "B");
    await writeFile(join(directory, "Z.md"), "---\nid: Z\nselected_option: [unclosed\n---\n正文\n");
    expect(await service.updateRelation(request)).toMatchObject({ status: "saved" });
    await writeFile(join(directory, "C copy.md"), "---\nid: C\nselected_option: [unclosed\n---\n正文\n");
    expect(await service.updateRelation(await update("B", "C"))).toMatchObject({ status: "source_unavailable" });
  });

  it("rejects replacement cycles, including concurrent edits to different pairs", async () => {
    const { service, update, relations } = await setup();
    const requests = await Promise.all([update("A", "B"), update("B", "C"), update("C", "A")]);
    const results = await Promise.all(requests.map((request) => service.updateRelation(request)));
    expect(results.map((result) => result.status)).toEqual(["saved", "saved", "cycle_rejected"]);
    expect((await relations.scan()).records.size).toBe(2);
  });
  it("counts a replacement whose note has changed or is gone when refusing a cycle", async () => {
    const { directory, service, read, update } = await setup();
    expect(await service.updateRelation(await update("A", "B"))).toMatchObject({ status: "saved" });
    expect(await service.updateRelation(await update("B", "C"))).toMatchObject({ status: "saved" });
    // B's note gone (moved out by a sync), both edges through it unverifiable: "A replaces C" closed the chain into
    // a cycle the App itself wrote to disk, and all three read as uncertain once B came back.
    const b = await readFile(join(directory, "B.md"), "utf8");
    await rm(join(directory, "B.md"));
    expect(await service.updateRelation(await update("C", "A"))).toMatchObject({ status: "cycle_rejected" });
    await writeFile(join(directory, "B.md"), b);
    // A's note edited: A↔B stale, and "A replaces C" was taken all the same; confirming A→B again was then refused.
    await writeFile(join(directory, "A.md"), `${await readFile(join(directory, "A.md"), "utf8")}\n补充一句。\n`);
    expect((await read("A")).relations?.[0]?.state).toBe("stale");
    expect(await service.updateRelation(await update("C", "A"))).toMatchObject({ status: "cycle_rejected" });
    expect(await service.updateRelation(await update("A", "B", { expectedRevision: 1 }))).toMatchObject({ status: "saved", revision: 2 });
  });
  it("records a replacement that points into a cycle already in the notes, closing none itself", async () => {
    const { directory, service, read, update } = await setup();
    for (const [id, other] of [["B", "C"], ["C", "B"]]) {
      await writeFile(join(directory, `${id}.md`), (await readFile(join(directory, `${id}.md`), "utf8")).replace("project: project\n", `project: project\nsupersedes: ${other}\n`));
    }
    expect((await read("B")).lifecycleState).toBe("uncertain");
    // Refused as forming the cycle, though nothing leads back to A.
    expect(await service.updateRelation(await update("A", "B"))).toMatchObject({ status: "saved" });
  });
  it("withdraws what is withdrawn without another revision", async () => {
    const { service, read, update } = await setup();
    await service.updateRelation(await update("A", "B"));
    const withdraw = (expectedRevision: number) => update("A", "B", { disposition: "revoked", successor: null, expectedRevision, reason: "用户撤回" });
    expect(await service.updateRelation(await withdraw(1))).toMatchObject({ status: "saved", revision: 2 });
    // Each 撤销 of the withdrawn relation wrote a revision more.
    expect(await service.updateRelation(await withdraw(2))).toMatchObject({ status: "unchanged", revision: 2 });
    expect((await read("A")).relations?.[0]).toMatchObject({ state: "revoked", revision: 2, historyCount: 1 });
  });
  it("answers unchanged to a withdrawal sent again with the note's current hash after an edit", async () => {
    const { directory, service, read, update } = await setup();
    await service.updateRelation(await update("A", "B"));
    // Edited since: the relation reads stale, and a withdrawal carries the note's current hash.
    await writeFile(join(directory, "A.md"), `${await readFile(join(directory, "A.md"), "utf8")}\n补充一句。\n`);
    const withdraw = (expectedRevision: number) => update("A", "B", { disposition: "revoked", successor: null, expectedRevision, reason: "用户撤回" });
    expect(await service.updateRelation(await withdraw(1))).toMatchObject({ status: "saved", revision: 2 });
    // Sent again as it was after a timeout: compared with the hashes the withdrawal was written with, it read as a
    // newer version of someone else's.
    expect(await service.updateRelation(await withdraw(1))).toMatchObject({ status: "unchanged", revision: 2 });
    expect((await read("A")).relations?.[0]).toMatchObject({ state: "revoked", revision: 2, historyCount: 1 });
  });
  it("supports confirmed conflict, unrelated revision and revocation with visible history", async () => {
    const { service, read, update } = await setup();
    await service.updateRelation(await update("A", "B", { disposition: "conflict", successor: null }));
    const conflicts = await service.search(decisionContextQuerySchema.parse({ relation: "conflict" }));
    expect(conflicts.results.map((record) => record.id).sort()).toEqual(["A", "B"]);
    await service.updateRelation(await update("B", "A", { disposition: "unrelated", successor: null, expectedRevision: 1, reason: "用户核对后确认场景不同" }));
    expect((await service.search(decisionContextQuerySchema.parse({ relation: "conflict" }))).results).toEqual([]);
    const withdrawn = await update("A", "B", { disposition: "revoked", successor: null, expectedRevision: 2, reason: "撤销此前关系判断" });
    expect(await service.updateRelation(withdrawn)).toMatchObject({ status: "saved", revision: 3 });
    expect((await read("A")).relations?.[0]).toMatchObject({ state: "revoked", historyCount: 2, history: [expect.objectContaining({ disposition: "conflict" }), expect.objectContaining({ disposition: "unrelated" })] });
  });
  it("rejects stale source and relation versions, but allows withdrawal after a source disappears", async () => {
    const { directory, service, read, update } = await setup();
    const input = await update("A", "B"); await service.updateRelation(input);
    // The very request again (a transport timed out after the write): acknowledged, not a version conflict with its own.
    expect(await service.updateRelation(input)).toMatchObject({ status: "unchanged", revision: 1 });
    await writeFile(join(directory, "B.md"), (await readFile(join(directory, "B.md"), "utf8")) + "\n新的背景。\n");
    expect(await read("A")).toMatchObject({ lifecycleState: "uncertain", relations: [expect.objectContaining({ state: "stale" })] });
    expect(await service.updateRelation({ ...input, expectedRevision: 1 })).toMatchObject({ status: "source_changed" });
    await rm(join(directory, "B.md"));
    expect((await read("A")).relations?.[0]?.state).toBe("missing_source");
    expect(await service.updateRelation({ ...input, disposition: "revoked", successor: null, expectedRevision: 1 })).toMatchObject({ status: "saved", revision: 2 });
    expect((await read("A")).lifecycleState).toBe("current");
  });
  it("supports a new App decision replacing an imported historical record", async () => {
    const { root, service, read } = await setup();
    await new MarkdownRepository(root).write(recordFixture({ id: "A" }));
    const old = await read("A"); const newer = await read("A", "decisions");
    await service.updateRelation(decisionRelationUpdateSchema.parse({
      first: { source: "summarize", recordId: old.id, contentHash: old.sourceRef.contentHash },
      second: { source: "decisions", recordId: newer.id, contentHash: newer.sourceRef.contentHash },
      disposition: "supersedes", successor: "second", expectedRevision: 0, reason: "用户确认新记录替代历史记录",
    }));
    const previous = await read("A");
    expect(previous.successors).toEqual([expect.objectContaining({ source: "decisions", id: "A" })]);
    expect(previous.warnings.some((warning) => warning.includes("自引用"))).toBe(false);
    expect((await read("A", "decisions")).predecessors).toEqual([expect.objectContaining({ source: "summarize", id: "A" })]);
  });
  it("does not treat damaged relation metadata as proof that a decision is current", async () => {
    const { root, service, read, update } = await setup();
    await service.updateRelation(await update("A", "B"));
    const folder = join(root, "Decision Journal/decision-relations");
    const file = (await readdir(folder))[0]!; await writeFile(join(folder, file), "broken");
    const result = await service.search(decisionContextQuerySchema.parse({ relation: "needs_review" }));
    expect(result.coverage).toBe("partial");
    expect((await read("A")).lifecycleState).toBe("uncertain");
    expect(await service.updateRelation(await update("A", "C"))).toMatchObject({ status: "source_unavailable" });
  });
});
