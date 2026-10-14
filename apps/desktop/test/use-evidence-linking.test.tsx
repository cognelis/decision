// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DecisionLibraryItem } from "../src/shared/renderer-api.js";
import { useEvidenceLinking } from "../src/renderer/components/pages/methodology/use-evidence-linking.js";

const reviewed = (index: number, question: string): DecisionLibraryItem => ({
  id: `decision-${String(index).padStart(3, "0")}`,
  created: new Date(Date.UTC(2025, 0, 1) + index * 86_400_000).toISOString(),
  sourceClient: "codex",
  project: "decision",
  question,
  selectedAnswer: "分步做",
  rationaleStatus: "captured",
  rationale: null,
  context: null,
  expectedOutcome: null,
  outcome: "结果符合预期。",
  reviewDueDate: null,
  outcomeReview: { verdict: "as_expected", lesson: null, reviewedAt: "2026-09-01T00:00:00.000Z" },
  appliedPrincipleIds: [],
  appliedPrinciples: [],
});

describe("useEvidenceLinking", () => {
  it("finds a reviewed decision older than the 200 it loaded when searched for", async () => {
    const all = [reviewed(0, "数据库迁移要不要停机？"), ...Array.from({ length: 200 }, (_, index) => reviewed(index + 1, `日常决策 ${index + 1}`))];
    // As the main process answers: newest first, at most 200, a query filters.
    const listDecisions = vi.fn(async (query: { query: string; limit?: number }) =>
      all
        .filter((decision) => query.query === "" || decision.question.includes(query.query))
        .sort((left, right) => right.created.localeCompare(left.created))
        .slice(0, Math.min(200, query.limit ?? 100)));
    const api = { listDecisions, getMethodologyEvidenceMatches: vi.fn(async () => []) };
    const { result } = renderHook(() => useEvidenceLinking({ api: api as never, selected: null, reportError: () => undefined }));

    act(() => result.current.openSourceChooser());
    await waitFor(() => expect(result.current.sourceLoading).toBe(false));
    act(() => result.current.searchSources("数据库迁移"));

    // Filtered only from the 200 it had, the one the reader remembered could not be found.
    await waitFor(() => expect(result.current.visibleReviewedDecisions.map((decision) => decision.id)).toEqual(["decision-000"]));
  });

  it("keeps the newer query's matches when an older query answers last", async () => {
    vi.useFakeTimers();
    try {
      // Found by the index on a field the picker does not read itself (its expected outcome, its tags).
      const byNewer = reviewed(1, "页面改造怎么推进？");
      const byOlder = reviewed(2, "另一个问题");
      const pending = new Map<string, (records: DecisionLibraryItem[]) => void>();
      const listDecisions = vi.fn((query: { query: string }) =>
        query.query === "" ? Promise.resolve([]) : new Promise<DecisionLibraryItem[]>((resolve) => pending.set(query.query, resolve)));
      const api = { listDecisions, getMethodologyEvidenceMatches: vi.fn(async () => []) };
      const { result } = renderHook(() => useEvidenceLinking({ api: api as never, selected: null, reportError: () => undefined }));

      await act(async () => { result.current.openSourceChooser(); });
      act(() => result.current.searchSources("回滚"));
      await act(() => vi.advanceTimersByTimeAsync(250));
      act(() => result.current.searchSources("回滚预案"));
      await act(() => vi.advanceTimersByTimeAsync(250));
      await act(async () => { pending.get("回滚预案")!([byNewer]); });
      expect(result.current.visibleReviewedDecisions.map((decision) => decision.id)).toEqual([byNewer.id]);

      // Taken, the older answer put its matches in place of the newer query's, and 页面改造 dropped out.
      await act(async () => { pending.get("回滚")!([byOlder]); });
      expect(result.current.visibleReviewedDecisions.map((decision) => decision.id)).toEqual([byNewer.id]);
    } finally {
      vi.useRealTimers();
    }
  });
});
