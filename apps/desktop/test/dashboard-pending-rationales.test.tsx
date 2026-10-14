// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { DashboardPendingRationales } from "../src/renderer/components/DashboardPendingRationales.js";
import { deferredRationale, keepDeferredRationale } from "../src/renderer/components/deferred-rationale-draft.js";
import type { PendingRationaleSummary } from "../src/shared/renderer-api.js";

afterEach(cleanup);

const decisions: PendingRationaleSummary[] = ["缓存", "协议", "存储"].map((question, index) => ({
  id: String(index), question, selectedAnswer: `答案${index}`,
  created: "2026-09-28T00:00:00.000Z", project: "decision", sourceClient: "codex",
  contextSummary: null, capturedQuestion: null,
}));

it("postpones without resolving the decision, keeps its draft and never revisits it in the same round", async () => {
  const pending = decisions.map((item, index) => ({ ...item, id: `decision-postpone-${index}` }));
  const complete = vi.fn(), skip = vi.fn(), discard = vi.fn(), keepLocal = vi.fn();
  const props = { decisions: pending, listDecisions: async () => [], onComplete: complete, onSkip: skip, onDiscard: discard, onKeepLocal: keepLocal };
  const user = userEvent.setup();
  render(<DashboardPendingRationales {...props} />);
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  await user.type(screen.getByRole("textbox"), "待确认的缓存理由");
  await user.click(screen.getByRole("button", { name: "复用现有能力" }));
  await user.click(screen.getByRole("button", { name: "稍后" }));
  expect(screen.getByRole("textbox", { description: "协议" })).toHaveValue("");
  expect(screen.getByRole("status")).toHaveTextContent("已处理 0 条 · 稍后 1 条");
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
  expect(deferredRationale(pending[0]!.id)).toEqual({ rationale: "待确认的缓存理由", reasonFactors: ["reuse"] });
  await user.click(screen.getByRole("button", { name: "稍后" }));
  expect(screen.getByRole("textbox", { description: "存储" })).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "稍后" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  for (const callback of [complete, skip, discard, keepLocal]) expect(callback).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  expect(screen.getByRole("textbox", { description: "缓存" })).toHaveValue("待确认的缓存理由");
  expect(screen.getByRole("button", { name: "复用现有能力" })).toHaveAttribute("aria-pressed", "true");
});

it("remembers postponed items when a continuous session is restored, and forgets an explicitly cleared draft", async () => {
  const pending = decisions.map((item, index) => ({ ...item, id: `decision-restored-${index}` }));
  keepDeferredRationale(pending[0]!.id, { rationale: "旧草稿", reasonFactors: [] });
  const drafts: { pending?: import("../src/renderer/components/DashboardPendingRationales.js").PendingRationaleDraft | undefined } = {};
  const props = { decisions: pending, listDecisions: async () => [], onComplete: vi.fn(), onSkip: vi.fn(), onDiscard: vi.fn(), onKeepLocal: vi.fn(), drafts };
  const user = userEvent.setup();
  const view = render(<DashboardPendingRationales {...props} />);
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  await user.clear(screen.getByRole("textbox"));
  await user.click(screen.getByRole("button", { name: "稍后" }));
  expect(deferredRationale(pending[0]!.id)).toBeUndefined();
  view.unmount();
  render(<DashboardPendingRationales {...props} />);
  expect(screen.getByRole("textbox", { description: "协议" })).toHaveValue("");
  await user.type(screen.getByRole("textbox"), "已确认");
  await user.click(screen.getByRole("button", { name: "记录到知识库并下一条" }));
  expect(screen.getByRole("textbox", { description: "存储" })).toHaveValue("");
  await user.click(screen.getByRole("button", { name: "稍后" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(props.onComplete).toHaveBeenCalledTimes(1);
});

it("keeps the current item and draft when postponing cannot store the draft", async () => {
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  await user.type(screen.getByRole("textbox"), "不能丢的草稿");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => { throw new Error("quota"); });
  try {
    await user.click(screen.getByRole("button", { name: "稍后" }));
    expect(screen.getByRole("textbox", { description: "缓存" })).toHaveValue("不能丢的草稿");
    expect(screen.getByRole("alert")).toHaveTextContent("当前条目没有跳过");
    await user.click(screen.getByRole("button", { name: "稍后" }));
    expect(screen.getByRole("textbox", { description: "协议" })).toHaveValue("");
  } finally { write.mockRestore(); }
});

it.each(["确认不保留", "记录到知识库（不补理由）"])("continues to the next decision after %s without saving the rationale", async (action) => {
  const complete = vi.fn(), discard = vi.fn(), skip = vi.fn();
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions.slice(0, 2)} listDecisions={async () => []}
    onComplete={complete} onSkip={skip} onKeepLocal={vi.fn()} onDiscard={discard} />);
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  for (const [index, question] of ["缓存", "协议"].entries()) {
    const dialog = screen.getByRole("dialog", { name: "补充决策理由" });
    expect(within(dialog).getByRole("textbox", { name: "理由原文" })).toHaveAccessibleDescription(question);
    const actions = within(dialog).getByRole("group", { name: "处理当前决策" });
    expect(within(actions).getByRole("button", { name: index === 0 ? "记录到知识库并下一条" : "记录到知识库" })).toBeInTheDocument();
    await user.click(within(actions).getByRole("button", { name: "不保留" }));
    await user.click(screen.getByRole("button", { name: action }));
    expect(action === "确认不保留" ? discard : skip).toHaveBeenLastCalledWith(String(index));
  }
  expect(complete).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("preserves the active draft when discard is cancelled or fails, then advances on retry", async () => {
  const discard = vi.fn().mockRejectedValueOnce(new Error("移除失败")).mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={discard} />);
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  await user.type(screen.getByRole("textbox"), "写到一半");
  const openConfirmation = async () => user.click(within(screen.getByRole("dialog", { name: "补充决策理由" })).getByRole("button", { name: "不保留" }));
  await openConfirmation();
  await user.click(screen.getByRole("button", { name: "取消不保留决策" }));
  expect(discard).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox")).toHaveValue("写到一半");
  await openConfirmation();
  await user.click(screen.getByRole("button", { name: "确认不保留" }));
  expect(within(screen.getByRole("dialog", { name: "不保留这条决策？" })).getByRole("alert")).toHaveTextContent("移除失败");
  expect(screen.getByRole("textbox")).toHaveValue("写到一半");
  await user.click(screen.getByRole("button", { name: "确认不保留" }));
  expect(screen.getByRole("textbox", { name: "理由原文", description: "协议" })).toHaveValue("");
  expect(discard).toHaveBeenCalledTimes(2);
});

it("saves consecutive rationales across snapshot updates and preserves a failed draft", async () => {
  const complete = vi.fn().mockResolvedValue(undefined);
  function Harness() {
    const [pending, setPending] = useState(decisions);
    return <DashboardPendingRationales decisions={pending} listDecisions={async () => []}
      onComplete={async (id, input) => {
        await complete(id, input);
        setPending((items) => items.filter((item) => item.id !== id));
      }} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />;
  }
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  await user.type(screen.getByRole("textbox"), "缓存理由");
  await user.click(screen.getByRole("button", { name: "记录到知识库并下一条" }));
  expect(complete).toHaveBeenLastCalledWith("0", { rationale: "缓存理由" });
  expect(screen.getByRole("progressbar", { name: "本轮补充进度" })).toHaveAttribute("value", "1");
  expect(screen.getByRole("progressbar")).toHaveAttribute("max", "3");
  expect(screen.getByRole("textbox", { name: "理由原文", description: "协议" })).toHaveValue("");
  expect(screen.getByRole("textbox")).toHaveFocus();
  complete.mockRejectedValueOnce(new Error("写入失败"));
  await user.type(screen.getByRole("textbox"), "协议理由");
  await user.click(screen.getByRole("button", { name: "记录到知识库并下一条" }));
  expect(screen.getByRole("alert")).toHaveTextContent("写入失败");
  expect(screen.getByRole("textbox")).toHaveValue("协议理由");
  await user.click(screen.getByRole("button", { name: "记录到知识库并下一条" }));
  await user.type(screen.getByRole("textbox", { name: "理由原文", description: "存储" }), "存储理由");
  await user.click(screen.getByRole("button", { name: "记录到知识库" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(complete).toHaveBeenLastCalledWith("2", { rationale: "存储理由" });
});

it("says which decision each row's actions, and the rationale field, are for", async () => {
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  // Six buttons with two names: tabbing through them, nothing said which decision each was for.
  const rows = screen.getAllByRole("listitem");
  rows.forEach((row, index) => {
    for (const name of ["补充理由", "不保留"]) {
      expect(within(row).getByRole("button", { name })).toHaveAccessibleDescription(decisions[index]!.question);
    }
  });
  await user.click(within(rows[1]!).getByRole("button", { name: "补充理由" }));
  // Named by the label on screen, which a speech user can say; the decision it explains is its description.
  expect(screen.getByRole("textbox", { name: "理由原文" })).toHaveAccessibleDescription("协议");
});

it("says how many wait beyond the latest it lists, and where the rest are", async () => {
  const browseAll = vi.fn();
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} total={1_800} onBrowseAll={browseAll}
    listDecisions={async () => []} onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  // Every snapshot carried and the page drew the whole backlog: megabytes, and a row for each.
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByText("1800")).toBeVisible();
  expect(screen.getByText("这里列出 3 条，另外 1797 条在知识里。")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "在知识中查看全部" }));
  expect(browseAll).toHaveBeenCalledOnce();
});

it("says the rest wait their turn when all it lists are held in the capture spool alone", () => {
  const held = Array.from({ length: 50 }, (_, index) => ({ ...decisions[0]!, id: `held-${index}`, inVault: false as const }));
  render(<DashboardPendingRationales decisions={held} total={60} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  // Found nowhere else: "在知识里" sent the reader to a page that does not have them.
  expect(screen.getByText("这里列出 50 条，其余 10 条等这些处理后再列出。")).toBeVisible();
});

it("keeps the dialog open, and what is written in it, for a decision pushed out of a list cut short", async () => {
  const user = userEvent.setup();
  const props = { listDecisions: async () => [], onComplete: vi.fn(), onSkip: vi.fn(), onKeepLocal: vi.fn(), onDiscard: vi.fn() };
  const view = render(<DashboardPendingRationales decisions={decisions} total={100} {...props} />);
  await user.click(within(screen.getAllByRole("listitem")[2]!).getByRole("button", { name: "补充理由" }));
  await user.type(screen.getByRole("textbox", { name: "理由原文", description: "存储" }), "写到一半");

  // One more put off: the list carries the newest, and 存储 is no longer among them.
  const newer = { ...decisions[0]!, id: "3", question: "新的待补" };
  view.rerender(<DashboardPendingRationales decisions={[newer, decisions[0]!, decisions[1]!]} total={101} {...props} />);
  expect(screen.getByRole("textbox", { name: "理由原文", description: "存储" })).toHaveValue("写到一半");
});

it("does not bring a 不保留 confirmation back by itself once its decision was pushed out of the list and returns", async () => {
  const user = userEvent.setup();
  const props = { listDecisions: async () => [], onComplete: vi.fn(), onSkip: vi.fn(), onKeepLocal: vi.fn(), onDiscard: vi.fn() };
  const view = render(<DashboardPendingRationales decisions={decisions} total={4} {...props} />);
  await user.click(within(screen.getAllByRole("listitem")[2]!).getByRole("button", { name: "不保留" }));
  expect(screen.getByRole("dialog", { name: "不保留这条决策？" })).toBeInTheDocument();

  // Another put off: 存储 leaves the list cut short, and its confirmation goes with it.
  const newer = { ...decisions[0]!, id: "3", question: "新的待补" };
  view.rerender(<DashboardPendingRationales decisions={[newer, decisions[0]!, decisions[1]!]} total={5} {...props} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  // That one handled elsewhere, 存储 is listed again: the confirmation the reader never reopened came back, unasked.
  view.rerender(<DashboardPendingRationales decisions={decisions} total={4} {...props} />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("requires confirmation and retries only remaining selected items after a batch failure", async () => {
  const skip = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("保存失败。")).mockResolvedValue(undefined);
  const discard = vi.fn();
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={skip} onKeepLocal={vi.fn()} onDiscard={discard} />);
  await user.click(screen.getByRole("button", { name: "批量处理" }));
  let dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByRole("button", { name: "记录到知识库（不补理由）" })).toBeDisabled();
  await user.click(dialog.getByRole("checkbox", { name: /全选/ }));
  await user.click(dialog.getByRole("button", { name: "记录到知识库（不补理由）" }));
  expect(skip).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认记录到知识库（不补理由）（3 条）" }));
  // A refusal is a whole sentence already: wrapped, it ended "。。".
  expect(screen.getByRole("alert")).toHaveTextContent(/^已处理 1 条，其余尚未处理：保存失败。可重试剩余项。$/u);
  dialog = within(screen.getByRole("dialog"));
  expect(dialog.queryByText("缓存")).toBeNull();
  await user.click(dialog.getByRole("button", { name: "确认记录到知识库（不补理由）（2 条）" }));
  expect(skip.mock.calls.map(([id]) => id)).toEqual(["0", "1", "1", "2"]);
  expect(discard).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("says the rationale text is required, and when ⌘↩ cannot save without it", async () => {
  const complete = vi.fn();
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} listDecisions={async () => []}
    onComplete={complete} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  await user.click(within(screen.getAllByRole("listitem")[0]!).getByRole("button", { name: "补充理由" }));
  const textarea = screen.getByRole("textbox", { name: "理由原文" });
  expect(textarea).toBeRequired();
  const factor = screen.getAllByRole("button", { pressed: false })[0]!;
  factor.focus();
  await user.keyboard("{Enter}{Meta>}{Enter}{/Meta}");

  // With a factor alone, ⌘↩ did nothing and said nothing, focus left on the factor.
  expect(complete).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("理由原文必填");
  expect(textarea).toHaveFocus();
});

it("puts focus on the batch's confirm button as the step changes to it", async () => {
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "批量处理" }));
  const dialog = within(screen.getByRole("dialog"));
  await user.click(dialog.getByRole("checkbox", { name: /全选/ }));
  dialog.getByRole("button", { name: "记录到知识库（不补理由）" }).focus();
  await user.keyboard("{Enter}");

  // The button pressed went with the step: focus fell to the dialog itself, the confirmation never reached.
  expect(dialog.getByRole("button", { name: "确认记录到知识库（不补理由）（3 条）" })).toHaveFocus();
});

it("says of one put off in a capture that it is not yet in Obsidian, rather than recorded there", async () => {
  // Held in the app's recovery queue alone: no note yet, none to take out of the library.
  const held = decisions.map((decision) => ({ ...decision, inVault: false as const }));
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={held} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  expect(screen.queryByText("决策已记录")).toBeNull();

  await user.click(within(screen.getAllByRole("listitem")[0]!).getByRole("button", { name: "不保留" }));
  expect(within(screen.getByRole("dialog")).getByText("确认后不会写入 Obsidian")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "取消不保留决策" }));
  await user.click(within(screen.getAllByRole("listitem")[0]!).getByRole("button", { name: "补充理由" }));
  expect(within(screen.getByRole("dialog")).getByText("记录到知识库会写入 Obsidian；仅本机保留可稍后集中整理。")).toBeVisible();
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "取消" }));

  // One of each among those chosen: each said for what it is.
  render(<DashboardPendingRationales decisions={[decisions[0]!, held[1]!]} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={vi.fn()} />);
  await user.click(screen.getAllByRole("button", { name: "批量处理" }).at(-1)!);
  const batch = within(screen.getByRole("dialog"));
  await user.click(batch.getByRole("checkbox", { name: /全选/u }));
  await user.click(batch.getByRole("button", { name: "不保留" }));
  expect(within(screen.getByRole("dialog")).getByText("确认后不再记录：已写入的会从决策库与 Obsidian 中移除，其余不会写入")).toBeVisible();
});

it("discards only explicitly selected decisions after reviewing the removal warning", async () => {
  const discard = vi.fn().mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={decisions} listDecisions={async () => []}
    onComplete={vi.fn()} onSkip={vi.fn()} onKeepLocal={vi.fn()} onDiscard={discard} />);
  await user.click(screen.getByRole("button", { name: "批量处理" }));
  let dialog = within(screen.getByRole("dialog"));
  await user.click(dialog.getByRole("checkbox", { name: "选择协议" }));
  await user.click(dialog.getByRole("button", { name: "不保留" }));
  expect(discard).not.toHaveBeenCalled();
  dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText(/确认后会从决策库与 Obsidian 中移除/)).toBeVisible();
  expect(dialog.queryByText("缓存")).toBeNull();
  await user.click(dialog.getByRole("button", { name: "确认不保留（1 条）" }));
  expect(discard.mock.calls).toEqual([["1"]]);
});
