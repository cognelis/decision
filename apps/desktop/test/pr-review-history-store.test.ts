import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PR_REVIEW_HISTORY_LIMITS, type PrReviewHistoryEntry } from "@cognelis/decision-protocol";
import { afterEach, beforeEach, expect, it } from "vitest";

import { PrReviewHistoryStore } from "../src/main/pr-review-history-store.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "paraself-review-history-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const entry = (n: number, at = `2026-10-${String((n % 28) + 1).padStart(2, "0")}T10:00:00.000Z`, detail = 0): PrReviewHistoryEntry => ({
  id: id(n), kind: "review", at, model: "本机", focus: "", draft: "", turns: [],
  snapshot: { snapshotId: id(9_000 + n), reference: "acme/app#12", title: `修复登录 ${n}`, description: "", project: "app",
    sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/login.ts", status: "modified" }], warnings: [] },
  events: Array.from({ length: detail ? 2_000 : 0 }, (_, step) => ({ runId: id(8_000), id: `step-${step}`, at, kind: "tool", status: "done", message: "读取源码", detail: "评".repeat(detail) })),
  report: null, state: "finished", error: "", published: [], verdicts: [], rechecks: [],
});

it("keeps each record in a file of its own, lists them newest first, and deletes the removed", async () => {
  const store = new PrReviewHistoryStore(directory);
  expect(await store.list()).toEqual({ entries: [], unreadable: 0 });
  await store.save({ entries: [entry(1, "2026-10-01T10:00:00.000Z"), entry(2, "2026-10-02T10:00:00.000Z")], removed: [] });
  expect((await readdir(directory)).sort()).toEqual([`${id(1)}.json`, `${id(2)}.json`]);
  expect((await store.list()).entries.map((item) => item.id)).toEqual([id(2), id(1)]);
  // A record changed later is saved whole again; one deleted on the page goes.
  await store.save({ entries: [{ ...entry(1, "2026-10-01T10:00:00.000Z"), focus: "权限边界" }], removed: [id(2)] });
  expect(await store.list()).toMatchObject({ entries: [{ id: id(1), focus: "权限边界" }], unreadable: 0 });
  expect(await store.get(id(1))).toMatchObject({ focus: "权限边界" });
  expect(await store.get("../escape")).toBeNull();
});

it("reads the others when one record cannot be read, and leaves that one as it is", async () => {
  const store = new PrReviewHistoryStore(directory);
  await store.save({ entries: [entry(1)], removed: [] });
  await writeFile(join(directory, `${id(2)}.json`), "{broken");
  expect(await store.list()).toMatchObject({ entries: [{ id: id(1) }], unreadable: 1 });
  expect(await readFile(join(directory, `${id(2)}.json`), "utf8")).toBe("{broken");
});

it("keeps a record past its size without its process log, and says so", async () => {
  const store = new PrReviewHistoryStore(directory);
  // 2,000 steps of 4,000 characters of Chinese: some 24 MB, past a record's 8 MiB.
  const result = await store.save({ entries: [entry(1, undefined, 4_000)], removed: [] });
  expect(result).toEqual({ dropped: 0, logDropped: [id(1)], refused: [] });
  expect((await store.get(id(1)))?.events).toEqual([]);
});

it("lets the records changed longest ago go past the limit", async () => {
  const store = new PrReviewHistoryStore(directory);
  const all = Array.from({ length: PR_REVIEW_HISTORY_LIMITS.entries }, (_, n) => entry(n));
  await store.save({ entries: all, removed: [] });
  // The first two changed longest ago.
  for (const [n, seconds] of [[0, 1_000], [1, 2_000]] as const) await utimes(join(directory, `${id(n)}.json`), seconds, seconds);
  expect(await store.save({ entries: [entry(PR_REVIEW_HISTORY_LIMITS.entries), entry(PR_REVIEW_HISTORY_LIMITS.entries + 1)], removed: [] }))
    .toEqual({ dropped: 2, logDropped: [], refused: [] });
  const names = await readdir(directory);
  expect(names).toHaveLength(PR_REVIEW_HISTORY_LIMITS.entries);
  expect(names).not.toContain(`${id(0)}.json`);
  expect(names).not.toContain(`${id(1)}.json`);
});
