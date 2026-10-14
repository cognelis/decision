import { DecisionContextRepository, DecisionScopeRepository } from "@cognelis/decision-storage";
import { decisionContextQuerySchema, decisionScopeUpdateSchema } from "@cognelis/decision-protocol";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionContextService } from "../src/main/decision-context-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-scope-")); roots.push(root);
  await mkdir(join(root, "Decision Journal/summarize"), { recursive: true });
  const path = join(root, "Decision Journal/summarize/DEC-0001.md");
  const original = "---\nid: DEC-0001\ncreated: 2026-09-01\nstatus: accepted\nselected_option: 稳定业务标识\nproject: project\n---\n# 原始决定\n列表使用稳定标识。\n";
  await writeFile(path, original);
  const scopes = new DecisionScopeRepository(root);
  const service = new DecisionContextService(new DecisionContextRepository(root, scopes), scopes);
  const first = (await service.search(decisionContextQuerySchema.parse({ recordId: "DEC-0001" }))).results[0]!;
  const input = decisionScopeUpdateSchema.parse({ source: "summarize", recordId: first.id, expectedContentHash: first.sourceRef.contentHash, expectedRevision: 0,
    scope: { projects: ["project"], layers: ["frontend"], exceptions: ["服务端输出不受此约束"] }, changeReason: "用户明确限定前端列表" });
  return { root, path, original, service, scopes, input };
};

describe("recorded decision scope", () => {
  it("writes separate versioned Markdown, leaving the original decision unchanged", async () => {
    const { root, path, original, service, scopes, input } = await setup();
    expect(await service.updateScope(input)).toEqual({ status: "saved", revision: 1, originalNoteUnchanged: true });
    expect(await readFile(path, "utf8")).toBe(original);
    const read = (await service.search(decisionContextQuerySchema.parse({ recordId: "DEC-0001", taskScope: { layer: "frontend" } }))).results[0]!;
    expect(read).toMatchObject({ scopeRevision: 1, scopeState: "current", applicability: { status: "needs_review", scope: { layers: ["frontend"], exceptions: ["服务端输出不受此约束"] } } });
    expect(await service.updateScope({ ...input, expectedRevision: 1, scope: { ...input.scope, layers: ["shared"] }, changeReason: "用户明确调整为共享层" })).toMatchObject({ status: "saved", revision: 2 });
    const stored = (await scopes.scan()).records.get("summarize:DEC-0001")!;
    expect(stored.history[0]).toMatchObject({ revision: 1, scope: { layers: ["frontend"] }, changeReason: input.changeReason });
    expect((await readdir(join(root, "Decision Journal/decision-scopes"))).every((file) => file.endsWith(".md"))).toBe(true);
  });

  it("excludes explicitly incompatible results but retains them for ID lookup or explicit inspection", async () => {
    const { service, input } = await setup(); await service.updateScope(input);
    const query = { query: "列表", taskScope: { layer: "backend" } };
    expect(await service.search(decisionContextQuerySchema.parse(query))).toMatchObject({ status: "no_match", excludedByScope: 1, results: [] });
    expect((await service.search(decisionContextQuerySchema.parse({ ...query, includeOutOfScope: true }))).results[0]?.applicability?.status).toBe("out_of_scope");
    expect((await service.search(decisionContextQuerySchema.parse({ ...query, recordId: "DEC-0001" }))).results[0]?.applicability?.status).toBe("out_of_scope");
  });

  it("rejects stale edits and does not apply old scope when the original note changes", async () => {
    const { path, service, input } = await setup();
    await service.updateScope(input);
    // The very request again (a transport timed out after the write): acknowledged, not a version conflict with its own.
    expect(await service.updateScope(input)).toMatchObject({ status: "unchanged", revision: 1 });
    await writeFile(path, (await readFile(path, "utf8")) + "\n新的上下文\n");
    const read = (await service.search(decisionContextQuerySchema.parse({ query: "列表", taskScope: { layer: "backend" } }))).results[0]!;
    expect(read).toMatchObject({ scopeState: "stale", scopeRevision: 1, applicability: { status: "needs_review", scope: { layers: ["frontend"], exceptions: ["服务端输出不受此约束"] } } });
    expect(await service.updateScope({ ...input, expectedRevision: 1 })).toMatchObject({ status: "source_changed" });
  });

  it("keeps a scoped record the same object from scan to scan, so what a search worked out for it stands", async () => {
    const { root, path, scopes, service, input } = await setup();
    await service.updateScope(input);
    const settled = new Date(Date.now() - 60_000);
    await utimes(path, settled, settled);
    const repository = new DecisionContextRepository(root, scopes);
    const scoped = async () => (await repository.scan()).documents.find((document) => document.id === "DEC-0001")!;
    const first = await scoped();
    expect(first.scopeState).toBe("current");
    // A copy each scan was a new record to every search: its words normalized again on each one.
    expect(await scoped()).toBe(first);
  });

  it("serializes competing updates so a stale writer cannot replace a newer scope", async () => {
    const { service, input } = await setup();
    const results = await Promise.all([service.updateScope(input), service.updateScope({ ...input, changeReason: "第二个并发请求" })]);
    expect(results.map((result) => result.status).sort()).toEqual(["revision_conflict", "saved"]);
  });

  it("treats malformed scope metadata as incomplete coverage, never silently broadening the record", async () => {
    const { root, service, input } = await setup(); await service.updateScope(input);
    const directory = join(root, "Decision Journal/decision-scopes");
    const files = await readdir(directory);
    await writeFile(join(directory, files[0]!), "broken scope");
    const result = await service.search(decisionContextQuerySchema.parse({ recordId: "DEC-0001", taskScope: { layer: "backend" } }));
    expect(result).toMatchObject({ coverage: "partial", results: [expect.objectContaining({ scopeState: "unavailable", applicability: expect.objectContaining({ status: "needs_review" }) })] });
    expect(await service.updateScope({ ...input, expectedRevision: 1 })).toMatchObject({ status: "source_unavailable" });
  });
});
