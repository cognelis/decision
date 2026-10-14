// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { PrReviewPanel } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";
import { saveReviewHistory, type ReviewHistoryEntry } from "../src/renderer/components/pages/pr-review/review-history.js";

afterEach(() => { cleanup(); localStorage.clear(); });

const connectionId = "00000000-0000-4000-8000-000000000011";
const finding = { priority: "P2" as const, title: "超时后请求仍在运行", body: "底层请求不会取消。", path: "src/request.ts", side: "new" as const, line: 12, decisionIndexes: [] };
const record = (id: string, reference: string, title: string): ReviewHistoryEntry => ({
  id, kind: "review", at: "2026-09-30T10:00:00.000Z", model: "本机", focus: "", draft: "", turns: [], events: [], state: "finished", error: "", published: [], verdicts: [], rechecks: [],
  connectionId, profileId: "local",
  snapshot: { snapshotId: "00000000-0000-4000-8000-000000000001", reference, title, description: "", project: "sample", sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40),
    files: [{ path: "src/request.ts", status: "modified" }], fileBatches: { "src/request.ts": 1 }, warnings: [] },
  report: { status: "completed", summary: "一处问题。", findings: [finding], evidence: [], readFiles: ["src/request.ts"], unreadFiles: [], reviewedFiles: ["src/request.ts"], unreviewedFiles: [], warnings: [], steps: 2, history: [], groups: 1 },
});

/*
 * The PR 详情 opened on one record is closed when another record is opened from elsewhere (quick jump, a notification):
 * selectRun() resets showDetails. 选择评审文件 is not reset the same way: the jump takes its snapshot away, so it goes
 * out of sight, but `choosingScope` stays true — and the next PR the reader opens brings the dialog back, unasked,
 * for that other PR.
 */
it("does not reopen 选择评审文件 on the next PR after a jump to a record closed it", async () => {
  const api = createPreviewApi();
  const id = "00000000-0000-4000-8000-0000000000a1";
  saveReviewHistory([record(id, "sample/app#1", "PR 甲")]);
  const base = await api.loadPrReview({ connectionId, reference: "sample/app#123" });
  vi.spyOn(api, "loadPrReview").mockResolvedValue({ ...base, files: [{ path: "src/request.ts", status: "modified" }, { path: "src/config.ts", status: "modified" }],
    fileBatches: { "src/request.ts": 1, "src/config.ts": 1 }, fileHunks: { "src/config.ts": [300], "src/request.ts": [420] } });
  const view = render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "选择文件" }));
  expect(screen.getByRole("dialog", { name: "选择评审文件" })).toBeVisible();

  // ⌘K (or a notification) to the record of PR 甲.
  view.rerender(<PrReviewPanel api={api} openRun={{ id }} />);
  expect(await screen.findByRole("heading", { name: "PR 甲" })).toBeVisible();
  expect(screen.queryByRole("dialog", { name: "选择评审文件" })).toBeNull();

  // Back to the PR list, and the PR opened again: its preparation page, with no dialog the reader did not ask for.
  fireEvent.click(screen.getByRole("button", { name: /^PR\s*\d+/u }));
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  await screen.findByRole("button", { name: "选择文件" });
  expect(screen.queryByRole("dialog", { name: "选择评审文件" })).toBeNull();
});
