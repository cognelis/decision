import { CaptureSpool, DecisionStore, MarkdownRepository, SqliteIndex, LocalDecisionStore, DecisionRelationRepository, SemanticVectorIndex } from "@cognelis/decision-storage";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile, copyFile, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionDeletionService } from "../src/main/decision-deletion-service.js";
import { SemanticSearchService } from "../src/main/semantic-search-service.js";
import { CaptureRuntime } from "../src/main/capture-runtime.js";
import { serverCaptureFixture } from "./fixtures.js";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-deletion-service-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = new MarkdownRepository(join(root, "vault")), index = new SqliteIndex(join(root, "index.sqlite"));
  const local = new LocalDecisionStore(join(root, "local.sqlite")), vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
  cleanups.push(() => { try { index.close(); } catch {} }, () => local.close());
  const semantic = new SemanticSearchService({ vectors, gateway: { embed: async () => { throw new Error("No embedding model"); } } });
  cleanups.push(() => semantic.close());
  const store = new DecisionStore(repository, index), relations = new DecisionRelationRepository(join(root, "vault"));
  const record = recordFixture({ id: "delete-me", batchId: "batch-1", questionIndex: 0, appliedPrincipleIds: ["used-principle"] });
  const note = (await store.save(record)).note;
  const sibling = (await store.save(recordFixture({ id: "sibling", batchId: "batch-1", questionIndex: 1 }))).note;
  await relations.save({ first: { source: "decisions", recordId: record.id, contentHash: note.contentHash }, second: { source: "decisions", recordId: sibling.id, contentHash: sibling.contentHash }, disposition: "conflict", successor: null, reason: "Synthetic relation", expectedRevision: 0 });
  vectors.upsert([{ entityType: "decision", entityId: record.id, model: "synthetic", contentHash: note.contentHash, vector: [1, 0] }, { entityType: "decision", entityId: "sibling", model: "synthetic", contentHash: sibling.contentHash, vector: [0, 1] }]);
  const trashItem = vi.fn(async (path: string) => { await mkdir(join(root, "trash"), { recursive: true }); await rename(path, join(root, "trash", basename(path))); });
  const onDeleted = vi.fn();
  const service = new DecisionDeletionService({ repository, store, local, methodologies: async () => [{ sourceDecisionIds: [record.id] }, { sourceDecisionIds: [record.id, "elsewhere"] }], relations, trashItem, removeVector: id => semantic.removeDecision(id), onDeleted,
    batchSiblings: (batchId, id) => index.countBatch(batchId, id) + local.countBatch(batchId, id) });
  return { root, service, record, note, repository, store, index, local, vectors, semantic, trashItem, onDeleted, relations };
};

it("previews references, trashes only the confirmed note, and removes index and vector before resolving", async () => {
  const { root, service, record, note, index, vectors, store, trashItem, onDeleted } = await setup();
  const preview = await service.preview({ id: record.id, storage: "vault" });
  expect(preview).toMatchObject({ id: record.id, storage: "vault", contentHash: note.contentHash, evidencePrinciples: 2, adoptedPrinciples: 1, relations: 1, batchId: "batch-1", deferredHeld: false,
    selectedAnswer: "Markdown", project: record.project });
  expect(trashItem).not.toHaveBeenCalled();
  expect(await service.delete({ id: record.id, storage: "vault", expectedContentHash: preview.contentHash })).toEqual({ deleted: true, warnings: [] });
  expect(await readFile(join(root, "trash", basename(note.path)), "utf8")).toContain(record.question);
  expect(index.findDecisions([record.id])).toEqual([]);
  expect(index.findDecisions(["sibling"])).toHaveLength(1);
  expect(vectors.metadata("decision").map(item => item.entityId)).toEqual(["sibling"]);
  expect(onDeleted).toHaveBeenCalled();
  // Restoring the exact source from the trash is enough for the existing reconcile path.
  await rename(join(root, "trash", basename(note.path)), note.path);
  await store.reconcileIndex();
  expect(index.hasDecision(record.id)).toBe(true);
});

it("refuses a changed note without trashing or removing any derived data", async () => {
  const { service, record, note, index, vectors, trashItem } = await setup();
  await writeFile(note.path, (await readFile(note.path, "utf8")) + "\n用户在 Obsidian 新增的内容。\n");
  await expect(service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash })).rejects.toThrow(/刷新|重新/);
  expect(trashItem).not.toHaveBeenCalled(); expect(index.hasDecision(record.id)).toBe(true);
  expect(vectors.metadata("decision")).toHaveLength(2);
});

it("keeps the note, index, and vectors if the system trash fails", async () => {
  const { service, record, note, index, vectors, trashItem } = await setup();
  trashItem.mockRejectedValueOnce(new Error("trash unavailable"));
  await expect(service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash })).rejects.toThrow();
  expect(await readFile(note.path, "utf8")).toContain(record.question); expect(index.hasDecision(record.id)).toBe(true);
  expect(vectors.metadata("decision")).toHaveLength(2);
});

it("checks the local content hash, permanently erases the body, and prevents replay resurrection", async () => {
  const { service, local, record, trashItem } = await setup();
  local.save(record);
  const preview = await service.preview({ id: record.id, storage: "local" });
  expect(preview.contentHash).toBe(createHash("sha256").update(local.content(record.id)!).digest("hex"));
  await expect(service.delete({ id: record.id, storage: "local", expectedContentHash: "a".repeat(64) })).rejects.toThrow(/刷新|重新/);
  expect(local.get(record.id)).not.toBeNull();
  expect(await service.delete({ id: record.id, storage: "local", expectedContentHash: preview.contentHash })).toEqual({ deleted: true, warnings: [] });
  expect(local.get(record.id)).toBeNull(); expect(local.content(record.id)).toBeNull();
  local.save(record); expect(local.get(record.id)).toBeNull();
  expect(trashItem).not.toHaveBeenCalled();
});


it("refuses duplicate IDs without sending either source to trash", async () => {
  const { service, record, note, trashItem } = await setup();
  await copyFile(note.path, note.path.replace(/\.md$/u, "-copy.md"));
  await expect(service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash })).rejects.toThrow(/多篇|副本|同一/);
  expect(trashItem).not.toHaveBeenCalled(); expect(await readFile(note.path, "utf8")).toContain(record.question);
});
it("never follows a replaced symlink into a file outside the vault", async () => {
  const { root, service, record, note, trashItem } = await setup();
  const outside = join(root, "outside.md"); await rename(note.path, outside); await symlink(outside, note.path);
  await expect(service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash })).rejects.toThrow();
  expect(trashItem).not.toHaveBeenCalled(); expect(await readFile(outside, "utf8")).toContain(record.question);
});


it("reports a completed trash move truthfully when the derived index cannot update", async () => {
  const { root, service, record, note, index, vectors, onDeleted } = await setup();
  index.close();
  const result = await service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash });
  expect(result).toMatchObject({ deleted: true, warnings: [expect.stringContaining("索引更新失败")] });
  expect(await readFile(join(root, "trash", basename(note.path)), "utf8")).toContain(record.question);
  expect(vectors.metadata("decision").map(item => item.entityId)).toEqual(["sibling"]);
  expect(onDeleted).toHaveBeenCalledWith(result.warnings);
});
it("reports a completed trash move truthfully if the semantic index is already unavailable", async () => {
  const { root, service, record, note, index, semantic } = await setup();
  await semantic.close();
  const result = await service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash });
  expect(result).toMatchObject({ deleted: true, warnings: [expect.stringContaining("语义索引清理失败")] });
  expect(index.hasDecision(record.id)).toBe(false);
  expect(await readFile(join(root, "trash", basename(note.path)), "utf8")).toContain(record.question);
});


it("does not report a committed deletion as failed if refreshing the interface throws", async () => {
  const { service, record, note, index, onDeleted } = await setup();
  onDeleted.mockImplementationOnce(() => { throw new Error("snapshot unavailable"); });
  const result = await service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash });
  expect(result).toMatchObject({ deleted: true, warnings: [expect.stringContaining("刷新失败")] });
  expect(index.hasDecision(record.id)).toBe(false);
});

it("discards a decision put off for its rationale through the capture runtime, so neither the queue nor a restart brings it back", async () => {
  const { root, repository, store, index, local, relations, semantic, trashItem } = await setup();
  const spool = new CaptureSpool(join(root, "spool"));
  const runtime = new CaptureRuntime({ spool, store, index, idFactory: () => "queued" });
  await spool.append(serverCaptureFixture());
  for (const event of await spool.list()) await runtime.ingest(event);
  await runtime.queue.submit({ status: "deferred" });
  const id = runtime.pendingRationales()[0]!.id;
  // Its note as an earlier version wrote one: listed under 待补理由 in the library, where 删除 is offered.
  const note = (await store.save(recordFixture({ id, status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [] }))).note;
  expect(runtime.pendingRationaleCount()).toBe(1);
  const service = new DecisionDeletionService({ repository, store, local, relations, methodologies: async () => [], trashItem, removeVector: id => semantic.removeDecision(id),
    deferred: { holds: id => runtime.holdsDeferredRationale(id), discard: id => runtime.discardDeferredRationale(id) } });
  const preview = await service.preview({ id, storage: "vault" });
  // Said in the dialog, and never a one-step confirmation: deleting it also ends the reminders to add a rationale.
  expect(preview.deferredHeld).toBe(true);
  expect(await service.delete({ id, storage: "vault", expectedContentHash: preview.contentHash })).toEqual({ deleted: true, warnings: [] });
  expect(await readFile(join(root, "trash", basename(note.path)), "utf8")).toContain(id);
  // Left in the runtime, the home page and the tray still counted it, and completing it wrote the note back.
  expect(runtime.pendingRationales()).toEqual([]);
  expect(runtime.pendingRationaleCount()).toBe(0);
  await runtime.recoverSpooled();
  expect(runtime.pendingRationales()).toEqual([]);
  // Its spool event and disposition went with it: a restart does not put it on the list again.
  const restarted = new CaptureRuntime({ spool, store, index, idFactory: () => "must-not-queue" });
  await restarted.recoverSpooled();
  expect(restarted.pendingRationales()).toEqual([]);
  expect(restarted.pendingRationaleCount()).toBe(0);
  expect(restarted.queue.snapshot().current).toBeNull();
});

it("refuses a deferred decision changed elsewhere before the runtime lets go of it", async () => {
  const { root, repository, store, index, local, relations, semantic, trashItem } = await setup();
  const spool = new CaptureSpool(join(root, "spool"));
  const runtime = new CaptureRuntime({ spool, store, index, idFactory: () => "queued" });
  await spool.append(serverCaptureFixture());
  for (const event of await spool.list()) await runtime.ingest(event);
  await runtime.queue.submit({ status: "deferred" });
  const id = runtime.pendingRationales()[0]!.id;
  const note = (await store.save(recordFixture({ id, status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [] }))).note;
  const discard = vi.fn((id: string) => runtime.discardDeferredRationale(id));
  const service = new DecisionDeletionService({ repository, store, local, relations, methodologies: async () => [], trashItem, removeVector: id => semantic.removeDecision(id),
    deferred: { holds: id => runtime.holdsDeferredRationale(id), discard } });
  await expect(service.delete({ id, storage: "vault", expectedContentHash: "0".repeat(64) })).rejects.toThrow(/重新读取/u);
  expect(discard).not.toHaveBeenCalled(); expect(trashItem).not.toHaveBeenCalled();
  expect(runtime.pendingRationaleCount()).toBe(1); expect(index.hasDecision(note.id)).toBe(true);
  // The runtime's own refusal is said as it is, and nothing is moved.
  discard.mockRejectedValueOnce(new Error("「问题」的理由已写入 Obsidian，只是本机恢复队列还没更新；请先在「补充理由」里再保存一次"));
  await expect(service.delete({ id, storage: "vault", expectedContentHash: note.contentHash })).rejects.toThrow("理由已写入 Obsidian");
  expect(trashItem).not.toHaveBeenCalled(); expect(index.hasDecision(note.id)).toBe(true);
});

it("says 同一批 only while another record of the capture remains, in the vault or kept locally", async () => {
  const { service, store, local, record } = await setup();
  // A single-question capture still carries its batch ID.
  await store.save(recordFixture({ id: "alone", batchId: "batch-alone", questionIndex: 0 }));
  expect((await service.preview({ id: "alone", storage: "vault" })).batchId).toBeNull();
  expect((await service.preview({ id: record.id, storage: "vault" })).batchId).toBe("batch-1");
  local.save(recordFixture({ id: "local-alone", batchId: "batch-local", questionIndex: 0 }));
  expect((await service.preview({ id: "local-alone", storage: "local" })).batchId).toBeNull();
  // Its sibling kept on this Mac only, the other in the vault: both still count.
  local.save(recordFixture({ id: "local-sibling", batchId: "batch-alone", questionIndex: 1 }));
  expect((await service.preview({ id: "alone", storage: "vault" })).batchId).toBe("batch-alone");
  expect((await service.preview({ id: "local-sibling", storage: "local" })).batchId).toBe("batch-alone");
});

it("forgets what 整理与记忆 holds of the decision only as the preview showed it, before the note goes (IMP-191)", async () => {
  const { record, note, repository, store, local, relations, trashItem } = await setup();
  const forgotten: string[] = [];
  let previewHash = "a".repeat(64);
  const organization = {
    previewForget: async ({ key }: { key: string }, options?: { preserveChoices: boolean }) => { expect(options).toEqual({ preserveChoices: true }); return { experiences: [{ id: "exp-1", title: "引用这条决策的经验" }], suggestions: 2, modelCalls: 3, complete: true, previewHash, key }; },
    forget: async ({ key, expectedPreviewHash }: { key: string; expectedPreviewHash: string }, options?: { preserveChoices: boolean }) => {
      expect(options).toEqual({ preserveChoices: true });
      if (expectedPreviewHash !== previewHash) return { status: "preview_changed", failed: [] };
      forgotten.push(key);
      return { status: "done", failed: [] };
    },
  };
  const service = new DecisionDeletionService({ repository, store, local, methodologies: async () => [], relations, trashItem, removeVector: async () => undefined, organization });
  const preview = await service.preview({ id: record.id, storage: "vault" });
  expect(preview.organization).toEqual({ experiences: [{ id: "exp-1", title: "引用这条决策的经验" }], suggestions: 2, modelCalls: 3, complete: true, previewHash });
  // Not confirmed against the preview: nothing forgotten, nothing trashed.
  await expect(service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash })).rejects.toThrow(/重新打开/);
  previewHash = "b".repeat(64);
  await expect(service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash, expectedOrganizationPreviewHash: "a".repeat(64) })).rejects.toThrow(/重新打开/);
  expect(forgotten).toEqual([]);
  expect(trashItem).not.toHaveBeenCalled();
  expect(await service.delete({ id: record.id, storage: "vault", expectedContentHash: note.contentHash, expectedOrganizationPreviewHash: previewHash })).toMatchObject({ deleted: true });
  expect(forgotten).toEqual([`decision:${record.id}`]);
  expect(trashItem).toHaveBeenCalledTimes(1);
});

for (const complete of [false, true]) it(`does not omit an empty organization preview with ${complete ? 'call records' : 'unreadable sources'}`, async () => {
  const { record, note, repository, store, local, relations, trashItem } = await setup();
  const previewHash = 'c'.repeat(64);
  const forget = vi.fn(async () => ({ status: 'done', failed: [] }));
  const service = new DecisionDeletionService({ repository, store, local, methodologies: async () => [], relations, trashItem, removeVector: async () => undefined,
    organization: { previewForget: async () => ({ experiences: [], suggestions: 0, modelCalls: complete ? 1 : 0, complete, previewHash }), forget } });
  const preview = await service.preview({ id: record.id, storage: 'vault' });
  expect(preview.organization?.complete).toBe(complete);
  const request = { id: record.id, storage: 'vault' as const, expectedContentHash: note.contentHash, expectedOrganizationPreviewHash: previewHash };
  if (complete) {
    await service.delete(request);
    expect(forget).toHaveBeenCalledWith({ key: `decision:${record.id}`, confirm: true, expectedPreviewHash: previewHash }, { preserveChoices: true });
  } else {
    await expect(service.delete(request)).rejects.toThrow('没能完整读取');
    expect(forget).not.toHaveBeenCalled(); expect(trashItem).not.toHaveBeenCalled();
  }
});
