// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DecisionDeletionDialog } from "../src/renderer/components/pages/decisions/DecisionDeletionDialog.js";
import { DecisionLibraryPanel } from "../src/renderer/components/pages/decisions/DecisionLibraryPanel.js";
import { LocalDecisionList } from "../src/renderer/components/pages/decisions/LocalDecisionList.js";
import { DashboardReviewInbox } from "../src/renderer/components/DashboardReviewInbox.js";
import { RecentDecisionList } from "../src/renderer/components/RecentDecisionList.js";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);
const target = { id: "delete-id", storage: "vault" as const };
const preview = { ...target, question: "删除哪条合成决策？", contentHash: "b".repeat(64), evidencePrinciples: 2, adoptedPrinciples: 1, relations: 3, batchId: "batch", captured: false, deferredHeld: false, selectedAnswer: "合成选择", project: "合成项目" };
it("shows recoverability and reference counts, and requires a separate explicit confirmation with the displayed hash", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue(preview);
  const onClose = vi.fn(), onDeleted = vi.fn(); const user = userEvent.setup();
  render(<DecisionDeletionDialog api={api} target={target} onClose={onClose} onDeleted={onDeleted} />);
  const dialog = within(await screen.findByRole("dialog", { name: "删除这条决策？" }));
  expect(await dialog.findByText(/2 条原则.*证据/u)).toBeVisible();
  expect(dialog.getByText(/采用.*1 条/u)).toBeVisible(); expect(dialog.getByText(/人工关系.*3 条/u)).toBeVisible();
  expect(dialog.getByText(/系统废纸篓.*恢复/u)).toBeVisible(); expect(dialog.getByText(/同一批.*只删除这一条/u)).toBeVisible();
  expect(dialog.getByText(/已确认的独立选择保留/u)).toBeVisible();
  expect(api.deleteDecision).not.toHaveBeenCalled();
  await user.click(dialog.getByRole("button", { name: "取消" })); expect(onClose).toHaveBeenCalled(); expect(api.deleteDecision).not.toHaveBeenCalled();
  await user.click(dialog.getByRole("button", { name: "删除" }));
  expect(api.deleteDecision).toHaveBeenCalledWith({ ...target, expectedContentHash: preview.contentHash });
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith({ deleted: true, warnings: [] }));
});
it("keeps the confirmation on failure and requires refreshing its version before retry", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue(preview);
  vi.mocked(api.deleteDecision).mockRejectedValueOnce(new Error("笔记已变化，请刷新后重新确认删除。"));
  const user = userEvent.setup(), onDeleted = vi.fn();
  render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={onDeleted} />);
  await user.click(await screen.findByRole("button", { name: "删除" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("笔记已变化"); expect(onDeleted).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "删除" })).toBeDisabled();
  vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...preview, contentHash: "c".repeat(64) });
  await user.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "删除" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "删除" }));
  expect(api.deleteDecision).toHaveBeenLastCalledWith({ ...target, expectedContentHash: "c".repeat(64) });
});
it("opens the danger confirmation from a vault decision detail and removes only that decision after success", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
  let rows = [{ id: target.id, created: "2026-07-30T00:00:00.000Z", sourceClient: "codex", project: "test", question: "待删除的决策", selectedAnswer: "合成选择", rationaleStatus: "captured" as const, rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [] }];
  vi.mocked(api.listDecisions).mockImplementation(async () => rows); vi.mocked(api.previewDecisionDeletion).mockResolvedValue(preview);
  vi.mocked(api.deleteDecision).mockImplementation(async () => { rows = []; return { deleted: true, warnings: [] }; });
  const user = userEvent.setup();
  render(<DecisionLibraryPanel api={api} totalDecisions={1} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);
  await user.click(await screen.findByText("待删除的决策"));
  const button = within(screen.getByRole("dialog", { name: "决策详情" })).getByRole("button", { name: "删除决策" });
  expect(button).toHaveClass("danger-button"); await user.click(button);
  // Asked over the detail, which stays behind it.
  const confirmation = within(await screen.findByRole("dialog", { name: "删除这条决策？" }));
  expect(screen.getByRole("dialog", { name: "决策详情" })).toBeInTheDocument();
  expect(confirmation.getByRole("button", { name: "取消" })).toHaveFocus();
  await user.click(confirmation.getByRole("button", { name: "删除" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByText("待删除的决策")).toBeNull();
});
it("exposes permanent deletion for each local record with an irreversible warning", async () => {
  const { api } = apiFixture(rationaleSnapshot());
  vi.mocked(api.listLocalDecisions).mockResolvedValue({ records: [recordFixture({ id: target.id })], total: 1 });
  vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...preview, storage: "local" });
  const user = userEvent.setup(); render(<LocalDecisionList api={api} />);
  await user.click(await screen.findByRole("button", { name: "删除" }));
  expect(await screen.findByText(/永久删除.*无法恢复/u)).toBeVisible();
  expect(api.deleteDecision).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole("dialog", { name: "删除这条决策？" })).getByRole("button", { name: "删除" }));
  expect(api.deleteDecision).toHaveBeenCalledWith({ id: target.id, storage: "local", expectedContentHash: preview.contentHash });
});

const unreferenced = { ...preview, evidencePrinciples: 0, adoptedPrinciples: 0, relations: 0, batchId: null };
it("asks once, without the impact list, when nothing refers to the decision", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue(unreferenced);
  const user = userEvent.setup(), onDeleted = vi.fn();
  render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={onDeleted} />);
  const dialog = within(await screen.findByRole("dialog", { name: "删除这条决策？" }));
  expect(await dialog.findByText(/笔记会移到系统废纸篓/u)).toBeVisible();
  expect(dialog.queryByRole("list")).toBeNull(); expect(dialog.queryByText(/原则/u)).toBeNull();
  // Written by hand: there was no recognition to be wrong.
  expect(dialog.queryByRole("button", { name: /识别错误/u })).toBeNull();
  await user.click(dialog.getByRole("button", { name: "删除" }));
  expect(api.deleteDecision).toHaveBeenCalledWith({ ...target, expectedContentHash: preview.contentHash });
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
});
it("says a local record goes for good in the same single step", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...unreferenced, storage: "local" });
  render(<DecisionDeletionDialog api={api} target={{ ...target, storage: "local" }} onClose={vi.fn()} onDeleted={vi.fn()} />);
  expect(await screen.findByText(/本机记录将永久删除/u)).toBeVisible();
  expect(screen.queryByRole("list")).toBeNull();
});
it("offers 识别错误，删除 beside a plain deletion for a captured decision and passes the mark only when chosen", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...unreferenced, captured: true });
  const user = userEvent.setup();
  render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={vi.fn()} />);
  const dialog = within(await screen.findByRole("dialog", { name: "删除这条决策？" }));
  expect(await dialog.findByText(/不含正文/u)).toBeVisible();
  await user.click(dialog.getByRole("button", { name: "识别错误，删除" }));
  expect(api.deleteDecision).toHaveBeenCalledWith({ ...target, expectedContentHash: preview.contentHash, misrecognized: true });
});
it("still shows the impact preview for a referenced captured decision, with both choices", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...preview, captured: true });
  const user = userEvent.setup();
  render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={vi.fn()} />);
  const dialog = within(await screen.findByRole("dialog", { name: "删除这条决策？" }));
  expect(await dialog.findByText(/2 条原则.*证据/u)).toBeVisible();
  expect(dialog.getByRole("button", { name: "识别错误，删除" })).toBeEnabled();
  await user.click(dialog.getByRole("button", { name: "删除" }));
  expect(api.deleteDecision).toHaveBeenCalledWith({ ...target, expectedContentHash: preview.contentHash });
});
it("deletes straight from a row of the decision list without opening its details", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
  let rows = [{ id: target.id, created: "2026-07-30T00:00:00.000Z", sourceClient: "codex", project: "test", question: "列表里的错误写入", selectedAnswer: "合成选择", rationaleStatus: "captured" as const, rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [] }];
  vi.mocked(api.listDecisions).mockImplementation(async () => rows); vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...unreferenced, captured: true });
  vi.mocked(api.deleteDecision).mockImplementation(async () => { rows = []; return { deleted: true, warnings: [] }; });
  const user = userEvent.setup();
  render(<DecisionLibraryPanel api={api} totalDecisions={1} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);
  const list = within(await screen.findByRole("list", { name: "决策列表" }));
  await user.click(await list.findByRole("button", { name: "删除", description: /列表里的错误写入/u }));
  expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull();
  await user.click(await screen.findByRole("button", { name: "识别错误，删除" }));
  expect(api.deleteDecision).toHaveBeenCalledWith({ ...target, expectedContentHash: preview.contentHash, misrecognized: true });
  await waitFor(() => expect(screen.queryByText("列表里的错误写入")).toBeNull());
});
it("offers deletion on each of the home page's recent decisions", async () => {
  const onDelete = vi.fn(), onOpen = vi.fn(); const user = userEvent.setup();
  render(<RecentDecisionList decisions={[{ id: target.id, question: "首页的错误写入", selectedAnswer: "合成选择", project: "test", sourceClient: "codex", created: "2026-07-30T00:00:00.000Z", rationaleStatus: "captured" }]}
    onOpenDecision={onOpen} onOpenRetrospective={vi.fn()} onDeleteDecision={onDelete} />);
  await user.click(screen.getByRole("button", { name: "删除", description: /首页的错误写入/u }));
  expect(onDelete).toHaveBeenCalledWith(target.id); expect(onOpen).not.toHaveBeenCalled();
});
it("offers deletion on a decision waiting in the review inbox, where a wrong capture scheduled for review turns up", async () => {
  const onDelete = vi.fn(), onOpen = vi.fn(); const user = userEvent.setup();
  render(<DashboardReviewInbox decisions={[{ id: target.id, created: "2026-09-01T10:00:00.000Z", sourceClient: "codex", project: "test", question: "排进复盘的错误写入", selectedAnswer: "合成选择", rationaleStatus: "captured", rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: "2026-09-10", appliedPrincipleIds: [], appliedPrinciples: [] }]}
    unscheduled={[]} loading={false} failed={false} onRetry={vi.fn()} onOpenDecision={onOpen} onDeleteDecision={onDelete} onOpenReviewInbox={vi.fn()}
    onSaveOutcome={vi.fn()} onSaveReview={vi.fn()} onPostponeReview={vi.fn()} remindersEnabled />);
  await user.click(screen.getByRole("button", { name: "删除", description: /排进复盘的错误写入/u }));
  expect(onDelete).toHaveBeenCalledWith(target.id); expect(onOpen).not.toHaveBeenCalled();
});
it("names what is being deleted under its question: the answer chosen, or the project when there is none", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue(unreferenced);
  const view = render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={vi.fn()} />);
  const dialog = within(await screen.findByRole("dialog", { name: "删除这条决策？" }));
  expect(await dialog.findByText("选择：合成选择")).toBeVisible();
  view.unmount();
  vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...unreferenced, selectedAnswer: "" });
  render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={vi.fn()} />);
  expect(await screen.findByText("项目：合成项目")).toBeVisible();
  expect(screen.queryByText(/选择：/u)).toBeNull();
});
it("says a decision still waiting for its rationale stops being asked about, and shows the full preview for it", async () => {
  const { api } = apiFixture(rationaleSnapshot()); vi.mocked(api.previewDecisionDeletion).mockResolvedValue({ ...unreferenced, deferredHeld: true });
  render(<DecisionDeletionDialog api={api} target={target} onClose={vi.fn()} onDeleted={vi.fn()} />);
  const dialog = within(await screen.findByRole("dialog", { name: "删除这条决策？" }));
  expect(await dialog.findByText("这条还在待补理由队列里，删除后不再提醒补理由。")).toBeVisible();
  // Not the one-step form: the impact list is there too.
  expect(dialog.getByRole("list")).toBeVisible();
});
