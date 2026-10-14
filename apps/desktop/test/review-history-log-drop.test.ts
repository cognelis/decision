// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { saveReviewHistory, type ReviewHistoryEntry } from "../src/renderer/components/pages/pr-review/review-history.js";

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

// Storage is full and the newest review's process log is what does not fit: saveReviewHistory() keeps the record without
// its log. It said { saved: true, dropped: 0 } of it, and the reviewer was told nothing; after the next launch the
// review's 评审过程 was empty.
it("says so when it had to leave the newest review's process log out", () => {
  const event = (index: number) => ({ runId: "00000000-0000-4000-8000-0000000000b1", id: `step-${index}`, at: "2026-10-05T02:30:00.000Z", kind: "tool" as const, status: "done" as const, message: `读取源码 ${index}`, detail: "x".repeat(3_000) });
  const newest = { id: "00000000-0000-4000-8000-0000000000e2", kind: "review", events: Array.from({ length: 10 }, (_, index) => event(index)) } as unknown as ReviewHistoryEntry;
  const older = { id: "00000000-0000-4000-8000-0000000000e1", kind: "review", events: [] } as unknown as ReviewHistoryEntry;
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (value.length > 5_000) throw new DOMException("full", "QuotaExceededError");
    setItem.call(this, key, value);
  });
  const result = saveReviewHistory([newest, older]);
  const stored = JSON.parse(localStorage.getItem("decision.pr-review.history.v1")!) as ReviewHistoryEntry[];
  // Both records were kept, the newest without its steps.
  expect(stored.map((item) => item.id)).toEqual([newest.id, older.id]);
  expect(stored[0]!.events).toEqual([]);
  // What the panel tells the reviewer by.
  expect(result).toEqual({ saved: true, dropped: 0, logDropped: true });
});
