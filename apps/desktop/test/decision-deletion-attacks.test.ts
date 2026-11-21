import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { serverCaptureFixture } from "./fixtures.js";
import * as storage from "../../../packages/storage/src/index.js";
import * as runtime from "../src/main/capture-runtime.js";
import * as deletion from "../src/main/decision-deletion-service.js";
import * as receipts from "../src/main/misrecognition-receipts.js";

// Loosely typed on purpose: the attacks hand the services partial collaborators and malformed requests.
const DecisionDeletionService: any = deletion.DecisionDeletionService;
const MisrecognitionReceiptStore: any = receipts.MisrecognitionReceiptStore;
const { DecisionStore, MarkdownRepository, SqliteIndex, LocalDecisionStore, DecisionRelationRepository, CaptureSpool, serializeDecision }: any = storage;
const CaptureRuntime: any = runtime.CaptureRuntime;
const auditIt = it;

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) { try { close(); } catch {} }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const setup = async (options: { record?: ReturnType<typeof recordFixture>; receiptPath?: string; methodologies?: () => Promise<Array<{ sourceDecisionIds: string[] }>>; deferred?: { holds(id: string): boolean; discard(id: string): Promise<void> } } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "r5-delete-attack-")); roots.push(root);
  const repository = new MarkdownRepository(join(root, "vault"));
  const index = new SqliteIndex(join(root, "index.sqlite"));
  const local = new LocalDecisionStore(join(root, "local.sqlite"));
  closers.push(() => index.close(), () => local.close());
  const store = new DecisionStore(repository, index);
  const relations = new DecisionRelationRepository(join(root, "vault"));
  const trashItem = vi.fn(async (path: string) => {
    const trash = join(root, "trash"); await mkdir(trash, { recursive: true });
    await rename(path, join(trash, basename(path)));
  });
  const receiptsPath = options.receiptPath ?? join(root, "user-data", "misrecognition-receipts.json");
  const receipts = new MisrecognitionReceiptStore(receiptsPath, () => new Date("2026-10-21T09:00:00.000Z"));
  const record = options.record ?? recordFixture({
    id: "attack-decision", sourceClient: "codex", captureMode: "transcript",
    question: "R5DELUNIQUEWORD: should the captured note be removed?",
    detection: { band: "high", score: 82, detectorVersion: "rules-v6", signals: ["has_choice_prompt", "R5DELUNIQUEWORD"] },
    batchId: "capture-batch", appliedPrincipleIds: ["adopted-principle"],
  });
  const saved = await store.save(record);
  const service = new DecisionDeletionService({
    repository, store, local, relations,
    methodologies: options.methodologies ?? (async () => []),
    trashItem,
    removeVector: async () => undefined,
    misrecognitions: receipts,
    deferred: options.deferred,
    batchSiblings: (batchId: string, id: string) => index.countBatch(batchId, id) + local.countBatch(batchId, id),
  });
  return { root, record, saved, repository, index, local, store, service, trashItem, receipts, receiptsPath, relations };
};

const filesUnder = async (directory: string): Promise<string[]> => (await readdir(directory, { withFileTypes: true, recursive: true }))
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));

auditIt("deletes a deferred-rationale record once, then replaying its capture cannot restore it", async () => {
  const root = await mkdtemp(join(tmpdir(), "r5-delete-deferred-")); roots.push(root);
  const repository = new MarkdownRepository(join(root, "vault"));
  const index = new SqliteIndex(join(root, "index.sqlite"));
  const local = new LocalDecisionStore(join(root, "local.sqlite"));
  closers.push(() => index.close(), () => local.close());
  const store = new DecisionStore(repository, index);
  const spool = new CaptureSpool(join(root, "spool"));
  const runtime = new CaptureRuntime({ spool, store, index, idFactory: () => "queued-capture" });
  const event = serverCaptureFixture();
  await spool.append(event);
  for (const savedEvent of await spool.list()) await runtime.ingest(savedEvent);
  await runtime.queue.submit({ status: "deferred" });
  const id = runtime.pendingRationales()[0]!.id;
  const note = (await store.save(recordFixture({ id, batchId: event.batchId, status: "deferred_rationale", rationaleStatus: "deferred", rationaleOriginal: null, reasonFactors: [] }))).note;
  const trashItem = vi.fn(async (path: string) => { const trash = join(root, "trash"); await mkdir(trash, { recursive: true }); await rename(path, join(trash, basename(path))); });
  const service = new DecisionDeletionService({
    repository, store, local, relations: new DecisionRelationRepository(join(root, "vault")),
    methodologies: async () => [], trashItem, removeVector: async () => undefined,
    deferred: { holds: (key: string) => runtime.holdsDeferredRationale(key), discard: (key: string) => runtime.discardDeferredRationale(key) },
  });
  const preview = await service.preview({ id, storage: "vault" });
  const request = { id, storage: "vault" as const, expectedContentHash: preview.contentHash };
  await expect(service.delete(request)).resolves.toMatchObject({ deleted: true });
  await expect(service.delete(request)).rejects.toThrow();
  expect(trashItem).toHaveBeenCalledTimes(1);
  expect(runtime.pendingRationaleCount()).toBe(0);

  // Re-ingest the same raw capture event after the not_recorded disposition was persisted.
  await runtime.ingest(event);
  await runtime.recoverSpooled();
  const restarted = new CaptureRuntime({ spool, store, index, idFactory: () => "must-not-resurrect" });
  await restarted.recoverSpooled();
  expect(runtime.pendingRationales()).toEqual([]);
  expect(restarted.pendingRationales()).toEqual([]);
  expect(await repository.findDecision(id)).toBeNull();
});

auditIt("serializes concurrent deletes so one note moves and only one receipt is recorded", async () => {
  const { record, saved, service, trashItem, receiptsPath } = await setup();
  const preview = await service.preview({ id: record.id, storage: "vault" });
  const request = { id: record.id, storage: "vault" as const, expectedContentHash: preview.contentHash, misrecognized: true };
  const results = await Promise.allSettled([service.delete(request), service.delete(request)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(trashItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(receiptsPath, "utf8")).receipts).toHaveLength(1);
  expect(saved.note.path).toBeTruthy();
});

auditIt("keeps sibling and reference counts in the preview so the UI cannot use the no-impact path", async () => {
  const record = recordFixture({ id: "referenced-decision", captureMode: "transcript", batchId: "batch-with-sibling", appliedPrincipleIds: ["applied"] });
  const { store, service, trashItem } = await setup({
    record,
    methodologies: async () => [{ sourceDecisionIds: [record.id] }],
  });
  await store.save(recordFixture({ id: "same-capture-sibling", batchId: record.batchId, questionIndex: 1 }));
  const preview = await service.preview({ id: record.id, storage: "vault" });
  expect(preview).toMatchObject({ batchId: record.batchId, evidencePrinciples: 1, adoptedPrinciples: 1 });
  expect(trashItem).not.toHaveBeenCalled();
});

auditIt.each(["corrupt", "unwritable"] as const)("deletes with a warning and preserves the receipt destination when it is %s", async mode => {
  const root = await mkdtemp(join(tmpdir(), `r5-delete-receipt-${mode}-`)); roots.push(root);
  const receiptPath = join(root, "user-data", "misrecognition-receipts.json");
  const sentinel = `DO_NOT_OVERWRITE_${mode}_R5`;
  if (mode === "corrupt") {
    await mkdir(join(root, "user-data"), { recursive: true });
    await writeFile(receiptPath, `${sentinel}\n{broken`);
  } else {
    await writeFile(join(root, "user-data"), sentinel);
  }
  const { root: deletionRoot, record, saved, service, trashItem } = await setup({ record: recordFixture({ id: `receipt-${mode}`, sourceClient: "codex", captureMode: "transcript", detection: { band: "high", score: 80, detectorVersion: "rules-v6", signals: ["approved"] } }), receiptPath });
  const preview = await service.preview({ id: record.id, storage: "vault" });
  const result = await service.delete({ id: record.id, storage: "vault", expectedContentHash: preview.contentHash, misrecognized: true });
  expect(result).toMatchObject({ deleted: true, warnings: [expect.stringContaining("回执没能保存")] });
  expect(trashItem).toHaveBeenCalledTimes(1);
  expect(await readFile(mode === "corrupt" ? receiptPath : join(root, "user-data"), "utf8")).toContain(sentinel);
  expect(await readFile(join(deletionRoot, "trash", basename(saved.note.path)), "utf8")).toContain(record.id);
});

auditIt("rejects renderer-supplied detection metadata and leaves the captured record untouched", async () => {
  const { record, saved, service, trashItem, receiptsPath } = await setup();
  const preview = await service.preview({ id: record.id, storage: "vault" });
  const request = {
    id: record.id, storage: "vault" as const, expectedContentHash: preview.contentHash, misrecognized: true,
    question: "FAKE_RENDERER_BODY", detectorVersion: "rules-v999", band: "low", score: 0,
    signals: ["FAKE_SIGNAL"], sourceClient: "fake-client", optionCount: 999,
    idHash: createHash("sha256").update(record.id).digest("hex"),
  };
  await expect(service.delete(request as never)).rejects.toThrow();
  expect(trashItem).not.toHaveBeenCalled();
  expect(await readFile(saved.note.path, "utf8")).toContain(record.question);
  await expect(readFile(receiptsPath, "utf8")).rejects.toThrow(/ENOENT/u);
});

auditIt("does not delete a hand-written local decision when misrecognized is forged", async () => {
  const manual = recordFixture({ id: "manual-local-delete-attack", sourceClient: "manual", captureMode: null, detection: null });
  const { local, service, trashItem, receiptsPath } = await setup({ record: manual });
  const savedContent = serializeDecision(manual);
  local.save(manual);
  const preview = await service.preview({ id: manual.id, storage: "local" });
  await expect(service.delete({ id: manual.id, storage: "local", expectedContentHash: preview.contentHash, misrecognized: true })).rejects.toThrow(/不是从对话/u);
  expect(local.content(manual.id)).toBe(savedContent);
  expect(trashItem).not.toHaveBeenCalled();
  await expect(readFile(receiptsPath, "utf8")).rejects.toThrow(/ENOENT/u);
});

auditIt("keeps receipt content free of the decision text, ID and source hash throughout user-data", async () => {
  const marker = "R5DELETEPRIVACYUNIQUEWORD";
  const record = recordFixture({ id: `${marker}-record-id`, sourceClient: "codex", captureMode: "transcript", question: `${marker} question`, contextSummary: `${marker} context`, rationaleOriginal: `${marker} rationale`, detection: { band: "high", score: 88, detectorVersion: "rules-v6", signals: ["safe_signal", marker] } });
  const { root, saved, service, receiptsPath } = await setup({ record });
  const sourceHash = createHash("sha256").update(await readFile(saved.note.path)).digest("hex");
  const preview = await service.preview({ id: record.id, storage: "vault" });
  await service.delete({ id: record.id, storage: "vault", expectedContentHash: preview.contentHash, misrecognized: true });
  const files = await filesUnder(join(root, "user-data"));
  expect(files).toContain(receiptsPath);
  const completeUserData = (await Promise.all(files.map(file => readFile(file, "utf8")))).join("\n");
  expect(completeUserData).not.toContain(marker);
  expect(completeUserData).not.toContain(record.id);
  expect(completeUserData).not.toContain(sourceHash);
  expect(completeUserData).not.toMatch(/[a-f0-9]{64}/u);
});
