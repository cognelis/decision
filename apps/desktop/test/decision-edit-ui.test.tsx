// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { AmendmentState } from "@cognelis/decision-protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { DecisionLibraryPanel } from "../src/renderer/components/pages/decisions/DecisionLibraryPanel.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);
const HASH = "c".repeat(64);
const at = new Date().toISOString();
const item = (over: Record<string, unknown> = {}) => ({
  id: "D-1", created: "2026-07-30T08:30:00.000Z", sourceClient: "codex", project: "decision", question: "决策工作流应该从设置中拆出吗？", selectedAnswer: "建立独立决策中心",
  rationaleStatus: "captured" as const, rationale: "更容易维护。", context: "设置页已有 9 个分区。", expectedOutcome: "找历史决策降到 10 秒。",
  outcome: "上线后平均 8 秒。", outcomeReview: { verdict: "as_expected" as const, lesson: "紧凑信息架构更适合高频回看。", reviewedAt: "2026-08-01T09:30:00.000Z" },
  reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [], contentHash: HASH, ...over,
});
const state = (over: Partial<AmendmentState> = {}): AmendmentState => ({
  revision: 3, relativePath: "Decision Journal/decision-amendments/x.md", amendments: [], withdrawn: null,
  revised: { fields: ["choice", "context", "expectedOutcome"], values: { choice: "建立独立决策中心，先只放决策和复盘", context: "设置页已有 9 个分区，信息密度过高。", expectedOutcome: "一个月内降到 10 秒以内。" }, at, client: "codex", reason: "r", stale: false },
  originals: { choice: "建立独立决策中心", context: "设置页已有 9 个分区。", expectedOutcome: "找历史决策降到 10 秒。" },
  history: [
    { revision: 1, at, client: "我", action: "revise", reason: "范围写清楚", before: { choice: "建立独立决策中心" }, basis: "user_said" },
    { revision: 2, at, client: "codex", action: "revise", reason: "你补充了规模", before: { context: "设置页已有 9 个分区。" }, basis: "user_said" },
    { revision: 3, at, client: "我", action: "revise", reason: null, before: { expectedOutcome: "找历史决策降到 10 秒。" }, basis: "user_said" },
  ],
  ...over,
});

const open = async (amendment: AmendmentState | null, over: Record<string, unknown> = {}) => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
  vi.mocked(api.listDecisions).mockResolvedValue([item(over)] as never);
  vi.mocked(api.listDecisionAmendments).mockResolvedValue({ unavailable: false, records: amendment === null ? [] : [{ source: "decisions", recordId: "D-1", contentHash: HASH, state: amendment }] });
  vi.mocked(api.updateDecisionAmendment).mockResolvedValue({ amendVersion: 1, status: "saved", revision: 4, relativePath: "x.md", originalUnchanged: true });
  const user = userEvent.setup();
  render(<DecisionLibraryPanel api={api} totalDecisions={1} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);
  await user.click(await screen.findByText("决策工作流应该从设置中拆出吗？"));
  return { api, user, details: within(screen.getByRole("dialog", { name: "决策详情" })) };
};

it("shows each rewritten section as it reads now, tagged by who and when, with the first words one click away", async () => {
  const { details } = await open(state());
  await waitFor(() => expect(details.getByText("建立独立决策中心，先只放决策和复盘", { selector: ".decision-detail-answer" })).toBeVisible());
  expect(details.getAllByText("已修改 · 今天").length).toBe(2);
  expect(details.getByText("已被 Codex 修改 · 今天")).toBeVisible();
  expect(details.getByText("一个月内降到 10 秒以内。", { selector: ".decision-detail-expected p" })).toBeVisible();
  const choice = within(document.querySelector<HTMLElement>(".decision-detail-choice")!);
  await userEvent.click(choice.getByText("最初版本"));
  expect(choice.getByText("建立独立决策中心", { selector: ".amendment-original p" })).toBeVisible();
});

it("edits the question from the pencil beside the title, as a rewrite of the reader's own, with the reason optional", async () => {
  const { api, user, details } = await open(null);
  await user.click(details.getByRole("button", { name: "编辑问题" }));
  const box = details.getByRole("textbox", { name: "问题" });
  expect(details.getByText(/正在编辑「问题」/u)).toBeVisible();
  await user.clear(box);
  await user.type(box, "决策工作流要不要拆出来？");
  await user.type(details.getByRole("textbox", { name: "修改原因（可选）" }), "措辞更直接");
  await user.click(details.getByRole("button", { name: "保存问题" }));
  await waitFor(() => expect(api.updateDecisionAmendment).toHaveBeenCalledWith({
    amendVersion: 1, source: "decisions", recordId: "D-1", sourceClient: "我", action: "revise", basis: "user_said",
    expectedContentHash: HASH, expectedRevision: 0, fields: { question: "决策工作流要不要拆出来？" }, reason: "措辞更直接",
  }));
  await waitFor(() => expect(vi.mocked(api.listDecisionAmendments).mock.calls.length).toBeGreaterThan(1));
});

it("edits the choice, the rationale, the context and the expected result in place, each with its own button and the shared editor", async () => {
  const { api, user, details } = await open(null);
  for (const [open, field, save] of [["修改选择", "最终选择", "保存选择"], ["修改理由", "决策理由", "保存理由"], ["修改上下文", "当时上下文", "保存上下文"], ["修改预期", "预期结果", "保存预期"]] as const) {
    await user.click(details.getByRole("button", { name: open }));
    // The same editor the other sections use: a text box with its count, 取消 and 保存.
    expect(details.getByText(/\d+ \/ \d+/u)).toBeVisible();
    await user.type(details.getByRole("textbox", { name: field }), "。补");
    await user.click(details.getByRole("button", { name: save }));
    await waitFor(() => expect(details.queryByRole("button", { name: save })).toBeNull());
  }
  expect(api.updateDecisionAmendment).toHaveBeenCalledTimes(4);
  expect(vi.mocked(api.updateDecisionAmendment).mock.calls.map(([request]) => Object.keys((request as { fields: object }).fields)[0])).toEqual(["choice", "rationale", "context", "expectedOutcome"]);
});

it("cannot be left while editing, and cancelling writes nothing", async () => {
  const { api, user, details } = await open(null);
  await user.click(details.getByRole("button", { name: "修改理由" }));
  expect(details.getByRole("button", { name: "删除决策" })).toBeDisabled();
  await user.click(details.getByRole("button", { name: "取消" }));
  expect(details.queryByText(/正在编辑/u)).toBeNull();
  expect(api.updateDecisionAmendment).not.toHaveBeenCalled();
});

it("says a conflict, keeps the draft and reads again", async () => {
  const { api, user, details } = await open(null);
  vi.mocked(api.updateDecisionAmendment).mockResolvedValueOnce({ amendVersion: 1, status: "source_changed", revision: 0, relativePath: "x.md", originalUnchanged: true });
  await user.click(details.getByRole("button", { name: "修改选择" }));
  await user.type(details.getByRole("textbox", { name: "最终选择" }), "！");
  await user.click(details.getByRole("button", { name: "保存选择" }));
  expect(await details.findByRole("alert")).toHaveTextContent("在你打开之后改过");
  expect(details.getByRole("textbox", { name: "最终选择" })).toHaveValue("建立独立决策中心！");
  await waitFor(() => expect(vi.mocked(api.listDecisionAmendments).mock.calls.length).toBeGreaterThan(1));
});

it("compares the review with the first expectation by default, and with the changed one on request", async () => {
  const { user, details } = await open(state());
  const review = within(await details.findByText("预期 / 实际复盘").then((node) => node.closest("section")!));
  expect(review.getByRole("button", { name: "最初的预期" })).toHaveAttribute("aria-pressed", "true");
  expect(review.getByText("找历史决策降到 10 秒。")).toBeVisible();
  await user.click(review.getByRole("button", { name: "修改后的预期" }));
  expect(review.getByText("一个月内降到 10 秒以内。")).toBeVisible();
  expect(review.getByRole("button", { name: "修改后的预期" })).toHaveAttribute("aria-pressed", "true");
});

it("tags a stale edit 修改已失效, not 已修改, and shows no first words equal to the body", async () => {
  const base = state();
  const { details } = await open({ ...base, revised: { ...base.revised!, stale: true } });
  await waitFor(() => expect(details.getAllByText("修改已失效").length).toBeGreaterThan(0));
  expect(details.queryByText("已修改 · 今天")).toBeNull();
  expect(details.queryByText("最初版本")).toBeNull();
});

it("counts the rewrites in the progress and jumps to where they are listed", async () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const { user, details } = await open(state());
  const row = await details.findByRole("button", { name: /3 次 · 今天/u });
  await user.click(row);
  expect(scroll).toHaveBeenCalled();
});

it("shows no edit marks for a decision nobody rewrote, and no comparison", async () => {
  const { details } = await open(null);
  expect(details.queryByText(/已修改|已被/u)).toBeNull();
  expect(details.queryByRole("button", { name: "最初的预期" })).toBeNull();
  expect(details.queryByRole("button", { name: /修订.*次/u })).toBeNull();
});
