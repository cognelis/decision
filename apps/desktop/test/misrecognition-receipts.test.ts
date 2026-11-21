import { DecisionStore, MarkdownRepository, SqliteIndex, LocalDecisionStore, DecisionRelationRepository } from "@cognelis/decision-storage";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { DecisionDeletionService } from "../src/main/decision-deletion-service.js";
import { MisrecognitionReceiptStore } from "../src/main/misrecognition-receipts.js";

// Synthetic: one word that appears in every piece of text the decision holds, and nowhere else.
const WORD = "ZQXWORDSYNTH";
const captured = (id: string, overrides: Parameters<typeof recordFixture>[0] = {}) => recordFixture({
  id, created: "2026-10-20T08:00:00.000Z", sourceClient: "claude-code", captureMode: "transcript",
  project: `${WORD}-project`, question: `${WORD} 要不要拆分？`, contextSummary: `${WORD} 背景`,
  context: { taskBackground: `${WORD} 任务`, decisionFraming: `${WORD} 约束`, truncated: false },
  detection: { band: "high", score: 83, detectorVersion: "rules-v5", signals: ["has_choice_prompt", "awaits_confirmation"] },
  options: [{ id: "a", label: `${WORD} 甲`, tradeoffs: [] }, { id: "b", label: `${WORD} 乙`, tradeoffs: [] }, { id: "c", label: `${WORD} 丙`, tradeoffs: [] }],
  selectedAnswer: { kind: "preset", values: [`${WORD} 甲`] }, rationaleOriginal: `${WORD} 理由`, tags: [WORD],
  ...overrides,
});

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-misrecognition-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repository = new MarkdownRepository(join(root, "vault")), index = new SqliteIndex(join(root, "index.sqlite"));
  const local = new LocalDecisionStore(join(root, "local.sqlite"));
  cleanups.push(() => { try { index.close(); } catch {} }, () => local.close());
  const store = new DecisionStore(repository, index), relations = new DecisionRelationRepository(join(root, "vault"));
  const trashItem = vi.fn(async (path: string) => { await mkdir(join(root, "trash"), { recursive: true }); await rename(path, join(root, "trash", basename(path))); });
  const receiptsPath = join(root, "user-data", "misrecognition-receipts.json");
  const receipts = new MisrecognitionReceiptStore(receiptsPath, () => new Date("2026-10-21T09:00:00.000Z"));
  const service = new DecisionDeletionService({ repository, store, local, relations, methodologies: async () => [], trashItem, removeVector: async () => undefined, misrecognitions: receipts });
  return { root, store, local, service, receipts, receiptsPath, trashItem };
};

const filesUnder = async (directory: string): Promise<string[]> => (await readdir(directory, { withFileTypes: true, recursive: true }))
  .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));

it("leaves a receipt of labels and counts only when a captured decision is deleted as misrecognized", async () => {
  const { root, store, service, receiptsPath } = await setup();
  const record = captured("misrecognized-vault");
  await store.save(record);
  const preview = await service.preview({ id: record.id, storage: "vault" });
  expect(preview.captured).toBe(true);
  expect(await service.delete({ id: record.id, storage: "vault", expectedContentHash: preview.contentHash, misrecognized: true })).toEqual({ deleted: true, warnings: [] });
  const { receipts: written } = JSON.parse(await readFile(receiptsPath, "utf8"));
  expect(written).toHaveLength(1);
  expect(written[0]).toEqual({
    version: 1, captureMode: "transcript", detectorVersion: "rules-v5", band: "high", score: 83, signals: ["has_choice_prompt", "awaits_confirmation"],
    sourceClient: "claude-code", optionCount: 3, capturedAt: "2026-10-20T08:00:00.000Z", deletedAt: "2026-10-21T09:00:00.000Z",
  });
  // Nothing outside the vault and the trash it went to holds a word of the decision, its ID, or a hash of its note.
  for (const file of (await filesUnder(join(root, "user-data")))) {
    const text = await readFile(file, "utf8");
    expect(text).not.toContain(WORD); expect(text).not.toContain(record.id); expect(text).not.toMatch(/[a-f0-9]{64}/u);
  }
});

it("never writes free text that might sit in a signal", async () => {
  const { store, service, receiptsPath } = await setup();
  const record = captured("odd-signal", { detection: { band: "medium", score: 55, detectorVersion: "rules-v5", signals: ["has_choice_prompt", `${WORD} 原文`] } });
  await store.save(record);
  const preview = await service.preview({ id: record.id, storage: "vault" });
  await service.delete({ id: record.id, storage: "vault", expectedContentHash: preview.contentHash, misrecognized: true });
  const text = await readFile(receiptsPath, "utf8");
  expect(text).not.toContain(WORD); expect(JSON.parse(text).receipts[0].signals).toEqual(["has_choice_prompt"]);
});

it("writes no receipt for a plain deletion and refuses the mark on a decision that was not captured", async () => {
  const { store, service, receiptsPath, trashItem } = await setup();
  const record = captured("plain-delete");
  await store.save(record);
  const preview = await service.preview({ id: record.id, storage: "vault" });
  await service.delete({ id: record.id, storage: "vault", expectedContentHash: preview.contentHash });
  await expect(readFile(receiptsPath, "utf8")).rejects.toThrow(/ENOENT/u);

  const manual = recordFixture({ id: "manual-delete", sourceClient: "manual", captureMode: null, detection: null });
  await store.save(manual);
  const manualPreview = await service.preview({ id: manual.id, storage: "vault" });
  expect(manualPreview.captured).toBe(false);
  trashItem.mockClear();
  await expect(service.delete({ id: manual.id, storage: "vault", expectedContentHash: manualPreview.contentHash, misrecognized: true })).rejects.toThrow(/识别/u);
  expect(trashItem).not.toHaveBeenCalled();
  await expect(readFile(receiptsPath, "utf8")).rejects.toThrow(/ENOENT/u);
});

it("leaves the same receipt for a local record and keeps the deletion when the receipt cannot be written", async () => {
  const { root, store, local, service, receiptsPath } = await setup();
  // A vault in use, as the App always has one: relations are read from it before any deletion.
  await store.save(recordFixture({ id: "vault-in-use" }));
  const record = captured("misrecognized-local", { detection: null, captureMode: "structured_tool" });
  local.save(record);
  const preview = await service.preview({ id: record.id, storage: "local" });
  expect(preview.captured).toBe(true);
  await service.delete({ id: record.id, storage: "local", expectedContentHash: preview.contentHash, misrecognized: true });
  // A structured question was not a guess of the rules: no band, score or version to give.
  expect(JSON.parse(await readFile(receiptsPath, "utf8")).receipts[0]).toMatchObject({ captureMode: "structured_tool", detectorVersion: null, band: null, score: null, signals: [], optionCount: 3 });

  const second = captured("receipt-fails");
  local.save(second);
  await rm(join(root, "user-data"), { recursive: true });
  await writeFile(join(root, "user-data"), "not a directory");
  const secondPreview = await service.preview({ id: second.id, storage: "local" });
  const result = await service.delete({ id: second.id, storage: "local", expectedContentHash: secondPreview.contentHash, misrecognized: true });
  expect(result).toMatchObject({ deleted: true, warnings: [expect.stringContaining("识别错误")] });
  expect(local.get(second.id)).toBeNull();
});

it("sums the last 30 days by band, signal and rule version without reading any decision", async () => {
  const { receipts, receiptsPath } = await setup();
  const base = { version: 1, captureMode: "transcript", sourceClient: "codex", optionCount: 2, capturedAt: "2026-10-01T00:00:00.000Z" } as const;
  await receipts.record({ ...base, detectorVersion: "rules-v5", band: "high", score: 80, signals: ["has_choice_prompt", "awaits_confirmation"], deletedAt: "2026-10-20T00:00:00.000Z" });
  await receipts.record({ ...base, detectorVersion: "rules-v4", band: "medium", score: 60, signals: ["has_choice_prompt"], deletedAt: "2026-10-01T00:00:00.000Z" });
  await receipts.record({ ...base, captureMode: "structured_tool", detectorVersion: null, band: null, score: null, signals: [], deletedAt: "2026-10-21T00:00:00.000Z" });
  // Older than 30 days: kept on disk, outside the window.
  await receipts.record({ ...base, detectorVersion: "rules-v3", band: "high", score: 90, signals: ["has_choice_prompt"], deletedAt: "2026-09-01T00:00:00.000Z" });
  // A receipt this version cannot read is skipped, not the whole file.
  const file = JSON.parse(await readFile(receiptsPath, "utf8"));
  await writeFile(receiptsPath, JSON.stringify({ ...file, receipts: [...file.receipts, { version: 1, question: "不该出现" }] }));
  expect(await receipts.summary()).toEqual({
    days: 30, total: 3,
    byMode: { transcript: 2, structured_tool: 1 },
    byBand: { high: 1, medium: 1, unknown: 1 },
    bySignal: { has_choice_prompt: 2, awaits_confirmation: 1 },
    byDetector: { "rules-v5": 1, "rules-v4": 1, unknown: 1 },
  });
});

it("says the receipts could not be read rather than that there are none", async () => {
  const { receiptsPath, receipts } = await setup();
  expect(await receipts.summary()).toEqual({ days: 30, total: 0, byMode: { transcript: 0, structured_tool: 0 }, byBand: { high: 0, medium: 0, unknown: 0 }, bySignal: {}, byDetector: {} });
  await mkdir(join(receiptsPath, ".."), { recursive: true });
  await writeFile(receiptsPath, "{damaged");
  expect(await receipts.summary()).toMatchObject({ total: 0, unavailable: true });
  // Left as it is: a later receipt does not replace what could not be read.
  await expect(receipts.record({ version: 1, captureMode: "transcript", detectorVersion: null, band: null, score: null, signals: [], sourceClient: "codex", optionCount: 0, capturedAt: "2026-10-01T00:00:00.000Z" })).rejects.toThrow();
  expect(await readFile(receiptsPath, "utf8")).toBe("{damaged");
});

it("writes the receipts file for the owner alone", async () => {
  const { receipts, receiptsPath } = await setup();
  await receipts.record({ version: 1, captureMode: "transcript", detectorVersion: "rules-v5", band: "high", score: 80, signals: [], sourceClient: "codex", optionCount: 2, capturedAt: "2026-10-01T00:00:00.000Z" });
  expect((await stat(receiptsPath)).mode & 0o777).toBe(0o600);
});
