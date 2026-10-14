// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { PrPlatformActions } from "../src/renderer/components/pages/pr-review/PrPlatformActions.js";
afterEach(cleanup);

it("confirms the selected branches before merging and sends only once", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "preview", reference: "org/app#1" });
  let finish!: (value: { action: "merge"; message: string }) => void;
  const perform = vi.spyOn(api, "performPrAction").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const complete = vi.fn(), pending = vi.fn();
  render(<PrPlatformActions api={api} snapshot={snapshot} connectionId="00000000-0000-4000-8000-000000000001" disabled={false} onPending={pending} onComplete={complete} />);
  fireEvent.click(screen.getByRole("button", { name: "合并" }));
  await screen.findByText("feature/timeout");
  expect(screen.getByText("main", { selector: "strong" })).toBeVisible();
  expect(perform).not.toHaveBeenCalled();
  const confirm = screen.getByRole("button", { name: "确认合并" });
  act(() => { fireEvent.click(confirm); fireEvent.click(confirm); });
  expect(perform).toHaveBeenCalledTimes(1);
  expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: "merge", sourceCommit: snapshot.sourceCommit, sourceBranch: "feature/timeout", destinationBranch: "main" }));
  expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
  await act(async () => finish({ action: "merge", message: "PR 已合并。" }));
  expect(complete).toHaveBeenCalledWith({ action: "merge", message: "PR 已合并。" });
  expect(screen.getByRole("button", { name: "合并" })).toBeDisabled();
  expect(pending.mock.calls).toEqual([[true], [false]]);
});

it("requires GitHub change-request feedback and preserves it when submission fails", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "preview", reference: "org/app#1" });
  const perform = vi.spyOn(api, "performPrAction").mockRejectedValue(new Error("权限不足"));
  render(<PrPlatformActions api={api} snapshot={snapshot} connectionId="00000000-0000-4000-8000-000000000001" disabled={false} onPending={() => undefined} onComplete={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "需要修改" }));
  await screen.findByLabelText("评审意见");
  expect(screen.getByRole("button", { name: "确认需要修改" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("评审意见"), { target: { value: "请修复超时" } });
  fireEvent.click(screen.getByRole("button", { name: "确认需要修改" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("权限不足");
  expect(screen.getByLabelText("评审意见")).toHaveValue("请修复超时");
  expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: "need-work", body: "请修复超时" }));
});

it("says before approving that the review on screen still has P1 findings, without blocking it", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "preview", reference: "org/app#1" });
  render(<PrPlatformActions api={api} snapshot={snapshot} connectionId="00000000-0000-4000-8000-000000000001" disabled={false} openP1={2} onPending={() => undefined} onComplete={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(await screen.findByText("这份评审还有 2 个 P1 问题没有撤销；确认后照样批准。")).toBeVisible();
  expect(screen.getByRole("button", { name: "确认批准" })).toBeEnabled();
});
