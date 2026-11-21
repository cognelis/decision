// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App.js";
import { deferredRationale, keepDeferredRationale } from "../src/renderer/components/deferred-rationale-draft.js";
import { saveReviewHistory, type ReviewHistoryEntry } from "../src/renderer/components/pages/pr-review/review-history.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const KEY = "decision.pr-review.history.v1";
const review = (n: number, detail: number) =>
  ({ id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`, kind: "review", events: [{ detail: "评".repeat(detail) }] }) as unknown as ReviewHistoryEntry;

// The store is the whole app's (some five million characters here, as in Electron): a rationale put off on the capture
// panel and a record being written keep their drafts in it too. The reviews were written to all the room there was,
// their oldest let go only once a write failed: grown that long, they left none, and 稍后处理 could not keep a draft.
it("leaves the store room for drafts however long the review history grows", () => {
  const entries = Array.from({ length: 10 }, (_, n) => review(n, 499_000));
  // Uncapped, the whole history fits with a few thousand characters to spare.
  const spare = 5_000_000 - KEY.length - JSON.stringify(entries).length;
  entries[9] = review(9, 499_000 + spare - 3_000);

  const result = saveReviewHistory(entries);

  const draft = { rationale: "部署前先跑全量回归，因为上次漏测了支付回调。".repeat(250), reasonFactors: [] };
  expect(keepDeferredRationale("decision-key-1", draft)).toBe(true);
  expect(deferredRationale("decision-key-1")).toEqual(draft);
  // The newest kept, the oldest let go, and said.
  const stored = JSON.parse(localStorage.getItem(KEY)!) as ReviewHistoryEntry[];
  expect(stored.map((item) => item.id)).toEqual(entries.slice(0, stored.length).map((item) => item.id));
  expect(result).toEqual({ saved: true, dropped: entries.length - stored.length });
});

it("keeps the newest review without its process log when that alone outgrows the history's share", () => {
  const newest = review(1, 3_000_000);
  const older = review(0, 1_000);

  expect(saveReviewHistory([newest, older])).toEqual({ saved: true, dropped: 0, logDropped: true });
  const stored = JSON.parse(localStorage.getItem(KEY)!) as ReviewHistoryEntry[];
  expect(stored.map((item) => [item.id, item.events.length])).toEqual([[newest.id, 0], [older.id, 1]]);
});

// Saved whole, as a version without the share saved it: read back as the review page reads it.
const saved = (n: number) => ({
  id: `00000000-0000-4000-8000-0000000000e${n}`, kind: "review", at: "2026-10-01T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [],
  snapshot: { snapshotId: "00000000-0000-4000-8000-0000000000a1", reference: "acme/app#12", title: "修复登录", description: "", project: "app",
    sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/login.ts", status: "modified" }], warnings: [] },
  events: Array.from({ length: 100 }, (_, step) => ({ runId: "00000000-0000-4000-8000-0000000000b1", id: `step-${step}`,
    at: "2026-10-01T10:00:00.000Z", kind: "tool", status: "done", message: "读取源码", detail: "评".repeat(4_000) })),
  report: null, state: "finished", error: "", published: [], verdicts: [], rechecks: [],
});

// Once the App kept the history, what this window's storage held is moved there at the start, the review page not yet
// opened: the store is left room for the drafts kept there too.
it("moves the history this window's storage held into the App at the start, and frees the store for drafts", async () => {
  const entries = Array.from({ length: 6 }, (_, n) => saved(n));
  localStorage.setItem(KEY, JSON.stringify(entries));
  // The rest of the store held by the app's other data, room left for a few thousand characters.
  localStorage.setItem("other", "x".repeat(5_000_000 - KEY.length - localStorage.getItem(KEY)!.length - "other".length - 3_000));
  const draft = { rationale: "部署前先跑全量回归，因为上次漏测了支付回调。".repeat(250), reasonFactors: [] };
  expect(keepDeferredRationale("decision-key-1", draft)).toBe(false);

  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "dashboard" }));
  const app = window as { decision?: unknown };
  app.decision = api;
  try {
    render(createElement(App, { api }));
    await waitFor(() => expect(localStorage.getItem(KEY)).toBeNull());
    expect(api.savePrReviewHistory).toHaveBeenCalledWith({ entries: entries.map((entry) => expect.objectContaining({ id: entry.id })), removed: [] });
    expect(keepDeferredRationale("decision-key-1", draft)).toBe(true);
  } finally {
    delete app.decision;
  }
});

it("leaves the history where it was when the App could not take it, and a preview's always", async () => {
  const entries = [saved(0)];
  localStorage.setItem(KEY, JSON.stringify(entries));
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "dashboard" }));
  vi.mocked(api.savePrReviewHistory).mockRejectedValue(new Error("disk full"));
  const app = window as { decision?: unknown };
  app.decision = api;
  try {
    const view = render(createElement(App, { api }));
    await waitFor(() => expect(api.savePrReviewHistory).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify(entries));
    view.unmount();
  } finally {
    delete app.decision;
  }
  // Not the App's own api (a preview's, whose store this storage is): nothing moved, nothing cleared.
  vi.mocked(api.savePrReviewHistory).mockClear();
  render(createElement(App, { api }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(api.savePrReviewHistory).not.toHaveBeenCalled();
  expect(localStorage.getItem(KEY)).toBe(JSON.stringify(entries));
});
