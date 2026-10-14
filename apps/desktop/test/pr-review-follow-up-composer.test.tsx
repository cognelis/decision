// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const first = "00000000-0000-4000-8000-0000000000a1", second = "00000000-0000-4000-8000-0000000000b1";

it("sends on Enter, keeps Shift+Enter and a composing Enter as typing", async () => {
  const api = createPreviewApi();
  saveReviewHistory([record(first, "sample/app#1", "PR 甲")]);
  const ask = vi.spyOn(api, "followUpPrReview");
  render(<PrReviewPanel api={api} />);
  const box = await screen.findByLabelText("继续追问");
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeDisabled());
  fireEvent.change(box, { target: { value: "为什么" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(ask).not.toHaveBeenCalled();
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  expect(ask).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.keyDown(box, { key: "Enter" });
  await waitFor(() => expect(ask).toHaveBeenCalledWith(expect.objectContaining({ question: "为什么" })));
  expect(await screen.findByText(/可以将取消信号传给底层请求/u)).toBeVisible();
  expect(box).toHaveValue("");
});

it("keeps each record's draft while the reader moves between records", async () => {
  const api = createPreviewApi();
  saveReviewHistory([record(first, "sample/app#1", "PR 甲"), record(second, "sample/app#2", "PR 乙")]);
  const view = render(<PrReviewPanel api={api} />);
  const box = await screen.findByLabelText("继续追问");
  fireEvent.change(box, { target: { value: "甲的草稿" } });
  view.rerender(<PrReviewPanel api={api} openRun={{ id: second }} />);
  expect(await screen.findByRole("heading", { name: "PR 乙" })).toBeVisible();
  expect(screen.getByLabelText("继续追问")).toHaveValue("");
  view.rerender(<PrReviewPanel api={api} openRun={{ id: first }} />);
  expect(await screen.findByRole("heading", { name: "PR 甲" })).toBeVisible();
  expect(screen.getByLabelText("继续追问")).toHaveValue("甲的草稿");
});

/*
 * A review running on another record is said on the record open ("「…」正在评审…，完成或停止后才能开始新的评审或追问",
 * with the way back). An answer pending on another record is not: the composer here is read-only and its send button
 * disabled with nothing to say why, and the one control shown, 停止回答, stops the other record's answer.
 */
it("says on another record that an answer is pending elsewhere, as it says of a running review", async () => {
  const api = createPreviewApi();
  saveReviewHistory([record(first, "sample/app#1", "PR 甲"), record(second, "sample/app#2", "PR 乙")]);
  let finish!: (value: { answer: string }) => void;
  vi.spyOn(api, "followUpPrReview").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = render(<PrReviewPanel api={api} />);
  const box = await screen.findByLabelText("继续追问");
  fireEvent.change(box, { target: { value: "为什么" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发送" })).toBeEnabled());
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByText("正在回答…")).toBeVisible();

  view.rerender(<PrReviewPanel api={api} openRun={{ id: second }} />);
  expect(await screen.findByRole("heading", { name: "PR 乙" })).toBeVisible();
  const here = screen.getByLabelText("继续追问");
  expect(here).toHaveAttribute("readonly");
  expect(screen.queryByRole("button", { name: "发送" })).toBeNull();
  // The one control offered here is 停止回答: it stops PR 甲's answer, which this page never names.
  const cancel = vi.spyOn(api, "cancelPrReview");
  fireEvent.click(screen.getByRole("button", { name: "停止回答" }));
  expect(cancel).toHaveBeenCalledTimes(1);
  // Said, with the way back, as a running review is ("「PR 甲」正在评审…完成或停止后才能开始新的评审或追问").
  expect(screen.queryAllByRole("status").map(element => element.textContent).join("\n")).toMatch(/PR 甲/u);
  await act(async () => { finish({ answer: "好的。" }); });
});
