// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PrReviewSnapshot } from "@cognelis/decision-protocol";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { PrReviewPanel } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";

afterEach(() => { cleanup(); localStorage.clear(); });

const connectionId = "00000000-0000-4000-8000-000000000011";

/*
 * A PR read before shows at once from the cache while its commits are confirmed in the background. The reader opens
 * 选择评审文件 on the cached snapshot (every file chosen); the confirmation brings a newer commit with one more file.
 * The dialog goes on with the selection it started with: the new file arrives unchecked, the footer says 2 / 3, and
 * 确定 narrows the review to the old files although the reader never deselected anything.
 */
it("keeps every file chosen when the background check brings a newer snapshot with more files", async () => {
  const api = createPreviewApi();
  const base = await api.loadPrReview({ connectionId, reference: "sample/app#123" });
  const cached: PrReviewSnapshot = { ...base, files: [{ path: "src/request.ts", status: "modified" }, { path: "src/config.ts", status: "modified" }],
    fileBatches: { "src/request.ts": 1, "src/config.ts": 1 }, fileHunks: { "src/config.ts": [300], "src/request.ts": [420] } };
  const fresh: PrReviewSnapshot = { ...cached, snapshotId: "00000000-0000-4000-8000-000000000002", sourceCommit: "c".repeat(40),
    files: [...cached.files, { path: "src/retry.ts", status: "added" }],
    fileBatches: { ...cached.fileBatches, "src/retry.ts": 1 }, fileHunks: { ...cached.fileHunks, "src/retry.ts": [200] } };
  vi.spyOn(api, "peekPrReview").mockResolvedValue(cached);
  let deliver!: (snapshot: PrReviewSnapshot) => void;
  vi.spyOn(api, "loadPrReview").mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  const run = vi.spyOn(api, "runPrReview");
  render(<PrReviewPanel api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /#123 示例：调整请求超时/ }));
  fireEvent.click(await screen.findByRole("button", { name: "选择文件" }));
  const dialog = screen.getByRole("dialog", { name: "选择评审文件" });
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选 2 / 2 个文件");

  await act(async () => { deliver(fresh); });
  expect(await screen.findByText("PR 有新提交，已读取最新变更。")).toBeInTheDocument();
  // Nothing was deselected: the new file is part of "every file", as the dialog was opened on.
  expect(within(dialog).getByRole("checkbox", { name: "src/retry.ts" })).toBeChecked();
  expect(within(dialog).getByRole("status")).toHaveTextContent("已选 3 / 3 个文件");

  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  // Confirmed as it was opened, the review is not narrowed.
  expect(screen.queryByText("个文件将评审")).toBeNull();
  vi.mocked(api.loadPrReview).mockResolvedValue(fresh);
  const start = screen.getByRole("button", { name: "开始评审" });
  fireEvent.click(start);
  await vi.waitFor(() => expect(run).toHaveBeenCalled());
  expect(run.mock.calls[0]![0]).not.toHaveProperty("paths");
});
