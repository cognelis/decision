// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  // Said as a question with its act on the one solid button, and focus on 取消, so Enter does not merge.
  const dialog = within(screen.getByRole("dialog", { name: "合并这个 PR？" }));
  expect(dialog.getByRole("button", { name: "取消" })).toHaveFocus();
  const confirm = dialog.getByRole("button", { name: "合并" });
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
  expect(screen.getByRole("button", { name: "标记为需要修改" })).toBeDisabled();
  expect(screen.getByLabelText("评审意见")).toHaveAccessibleDescription("必填，会作为评审意见发布到 PR。");
  fireEvent.change(screen.getByLabelText("评审意见"), { target: { value: "请修复超时" } });
  fireEvent.click(screen.getByRole("button", { name: "标记为需要修改" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("权限不足");
  expect(screen.getByLabelText("评审意见")).toHaveValue("请修复超时");
  expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: "need-work", body: "请修复超时" }));
});

it("asks for a reason to approve past standing P1s or open blockers, and sends it with the approval", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "preview", reference: "org/app#1" });
  const perform = vi.spyOn(api, "performPrAction");
  const status = { sourceCommit: snapshot.sourceCommit, build: "passed" as const, approvals: { count: 0, users: [], logins: [], stale: [] }, blockers: 1, blocking: "discussions" as const, blockersHold: null, sections: null, problems: [] };
  render(<PrPlatformActions api={api} snapshot={snapshot} connectionId="00000000-0000-4000-8000-000000000001" disabled={false} openP1={2} status={status} onPending={() => undefined} onComplete={() => undefined} />);
  // Nothing standing to rest a quick approval on: not offered.
  expect(screen.queryByRole("button", { name: "快速批准" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  expect(await screen.findByText("还有 1 项未完成的阻塞项，这份评审还有 2 个 P1 问题没有撤销：批准要写明理由。")).toBeVisible();
  const dialog = within(screen.getByRole("dialog", { name: "批准这个 PR？" }));
  const approve = dialog.getByRole("button", { name: "批准" });
  expect(approve).toBeDisabled();
  expect(dialog.getByLabelText("批准理由（必填）")).toHaveAccessibleDescription("会作为批准意见发到 PR。");
  fireEvent.change(dialog.getByLabelText("批准理由（必填）"), { target: { value: "P1 是有意为之，已和作者确认。" } });
  fireEvent.click(approve);
  await waitFor(() => expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: "approve", body: "批准理由：P1 是有意为之，已和作者确认。" })));
});

it("posts the reason after approving where an approval takes no words, and only the reason once that failed", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "preview", reference: "org/app#1" });
  const context = api.getPrActionContext;
  vi.spyOn(api, "getPrActionContext").mockImplementation(async (input) => ({ ...(await context(input)), platform: "bitbucket-server" }));
  const perform = vi.spyOn(api, "performPrAction").mockResolvedValue({ action: "approve", message: "已提交 Approve。" });
  const comment = vi.spyOn(api, "publishPrGeneralComment").mockRejectedValueOnce(new Error("没有执行此操作的权限（HTTP 403），请确认账号和令牌授权。")).mockResolvedValueOnce({ message: "评论已发布到 PR。" });
  const complete = vi.fn();
  render(<PrPlatformActions api={api} snapshot={snapshot} connectionId="00000000-0000-4000-8000-000000000001" disabled={false} openP1={1} onPending={() => undefined} onComplete={complete} />);
  fireEvent.click(screen.getByRole("button", { name: "批准" }));
  const reason = await screen.findByLabelText("批准理由（必填）");
  expect(reason).toHaveAccessibleDescription("会在批准之后作为一条评论发到 PR。");
  fireEvent.change(reason, { target: { value: "已当面确认。" } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "批准" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已批准，但理由没能发到 PR：没有执行此操作的权限（HTTP 403），请确认账号和令牌授权。可以重新发布理由，不会再批准一次。");
  expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: "approve", body: "" }));
  fireEvent.click(screen.getByRole("button", { name: "重新发布理由" }));
  await waitFor(() => expect(complete).toHaveBeenCalledWith({ action: "approve", message: "已提交 Approve。理由已发到 PR。" }));
  expect(perform).toHaveBeenCalledTimes(1);
  expect(comment).toHaveBeenCalledTimes(2);
  expect(comment).toHaveBeenLastCalledWith(expect.objectContaining({ sourceCommit: snapshot.sourceCommit, body: "批准理由：已当面确认。" }));
});

it("offers a quick approval with its checks, and takes what they cannot catch before approving", async () => {
  const api = createPreviewApi();
  const snapshot = await api.loadPrReview({ connectionId: "preview", reference: "org/app#1" });
  const perform = vi.spyOn(api, "performPrAction");
  const checks = ["构建通过", "没有未完成的阻塞项", "预评审没有成立的问题", "PR 描述三段齐全"].map(label => ({ label, ok: true }));
  render(<PrPlatformActions api={api} snapshot={snapshot} connectionId="00000000-0000-4000-8000-000000000001" disabled={false} quick={{ eligible: true, checks }} onPending={() => undefined} onComplete={() => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: "快速批准" }));
  const dialog = within(await screen.findByRole("dialog", { name: "快速批准 org/app#1？" }));
  expect(dialog.getByRole("list", { name: "快速批准的条件" })).toHaveTextContent("构建通过没有未完成的阻塞项预评审没有成立的问题PR 描述三段齐全");
  const submit = await dialog.findByRole("button", { name: "批准并写入依据" });
  await waitFor(() => expect(dialog.getByLabelText("这些检查拦不住什么（必填）")).toBeVisible());
  expect(submit).toBeDisabled();
  fireEvent.change(dialog.getByLabelText("这些检查拦不住什么（必填）"), { target: { value: "翻译键是否存在没有测试覆盖。" } });
  fireEvent.click(submit);
  await waitFor(() => expect(perform).toHaveBeenCalledWith(expect.objectContaining({ action: "approve",
    body: "快速批准（低风险）：构建通过；没有未完成的阻塞项；预评审没有成立的问题；PR 描述三段齐全。\n\n这些检查拦不住什么：翻译键是否存在没有测试覆盖。" })));
});
