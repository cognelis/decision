// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActiveRecordDialog } from "../src/renderer/components/pages/decisions/ActiveRecordDialog.js";
import { HistoricalDecisionView } from "../src/renderer/components/pages/decisions/HistoricalDecisionView.js";
import { historicalDraft } from "../src/renderer/components/TaskActions.js";
import { createHistoricalDecisionPreview, type HistoricalDecisionPreviewState } from "../src/renderer/preview-historical-decisions.js";

afterEach(() => { cleanup(); localStorage.clear(); });

const mount = (state: HistoricalDecisionPreviewState | null = null) => {
  const api = { ...createHistoricalDecisionPreview(state), openVaultDocument: vi.fn(async () => undefined) };
  const props = { onRecord: vi.fn(), onOpenDecision: vi.fn(), onCounted: vi.fn() };
  render(<HistoricalDecisionView api={api} refreshRevision={0} {...props} />);
  return { api, ...props };
};
const rows = () => screen.queryAllByRole("button").filter((button) => button.classList.contains("historical-row"));

describe("HistoricalDecisionView", () => {
  it("lists every record with the withdrawn ones, and narrows by status and by what is typed", async () => {
    const { onCounted } = mount();
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(onCounted).toHaveBeenLastCalledWith(10);
    expect(screen.getByRole("status")).toHaveTextContent("10 条结果");

    fireEvent.click(screen.getByRole("button", { name: "已撤回" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("团队仓库是否开启强制签名提交？");

    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(rows()).toHaveLength(10));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史决定" }), { target: { value: "sqlite" } });
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toHaveTextContent("向量索引放在哪里？");

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索历史决定" }), { target: { value: "没有这样的记录" } });
    expect(await screen.findByText("没有匹配结果")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清除关键词与筛选" }));
    await waitFor(() => expect(rows()).toHaveLength(10));
  });

  it("offers the first record where there is none, and nothing to search", async () => {
    const { onRecord } = mount("empty");
    expect(await screen.findByText("还没有历史决定")).toBeVisible();
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "记一条历史决定" }));
    expect(onRecord).toHaveBeenCalledOnce();
  });

  it("names the notes it could not read beside the ones it could, and never takes an index out of reach for an empty ledger", async () => {
    const unreadable = mount("unreadable");
    expect(await screen.findByText("2 篇笔记读不出来，没有进入列表。")).toBeVisible();
    await waitFor(() => expect(rows()).toHaveLength(10));
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    fireEvent.click(screen.getByRole("button", { name: "2026-09-02-日志保留期-77c1e0aa.md" }));
    expect(unreadable.api.openVaultDocument).toHaveBeenCalledWith("Decision Journal/history/2026/2026-09-02-日志保留期-77c1e0aa.md");
    cleanup();

    mount("index");
    expect(await screen.findByText("本机索引读不了，这里暂时列不出记录。")).toBeVisible();
    expect(screen.queryByText("还没有历史决定")).toBeNull();
    expect(rows()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "从 Vault 重建索引" }));
    await waitFor(() => expect(rows()).toHaveLength(10));
    expect(screen.queryByText("本机索引读不了，这里暂时列不出记录。")).toBeNull();
  });

  it("changes a record on the revision shown, asks before a status change, and leaves a withdrawn one read-only", async () => {
    const { api } = mount();
    const update = vi.spyOn(api, "updateHistoricalDecision");
    const user = userEvent.setup();
    await waitFor(() => expect(rows()).toHaveLength(10));
    await user.click(rows()[1]!);
    const detail = within(await screen.findByRole("dialog", { name: "历史决定详情" }));
    expect(await detail.findByRole("heading", { name: "首页待办入口放在哪一层？" })).toBeVisible();
    // The one it replaced is a step away, and what it carries is shown as recorded.
    expect(detail.getByRole("button", { name: /放在首页卡片区第二屏/u })).toBeVisible();
    expect(detail.getByText("只做全局快捷键，不放入口")).toBeVisible();

    await user.click(detail.getByRole("button", { name: "修改决定" }));
    const field = detail.getByLabelText("最终决定");
    await user.clear(field);
    // Emptied, it cannot be saved: a record always says what was decided.
    expect(detail.getByRole("button", { name: "保存" })).toBeDisabled();
    await user.type(field, "放进主导航第五项");
    await user.click(detail.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ id: "hdec-preview-nav", expectedRevision: 1, decision: "放进主导航第五项" }));
    expect(await detail.findByText("放进主导航第五项", { selector: "p" })).toBeVisible();

    await user.click(detail.getByRole("button", { name: "标记已结束" }));
    const asked = within(await screen.findByRole("dialog", { name: "标记已结束" }));
    await user.type(asked.getByLabelText("状态说明（可选）"), "导航重做后不再适用");
    expect(update).toHaveBeenCalledTimes(1);
    await user.click(asked.getByRole("button", { name: "标记已结束" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith({ id: "hdec-preview-nav", expectedRevision: 2, status: "ended", expectedStatus: "active", statusNote: "导航重做后不再适用" }));
    expect(await detail.findByText("状态说明：导航重做后不再适用")).toBeVisible();

    await user.click(detail.getByRole("button", { name: "撤回记录" }));
    await user.click(within(await screen.findByRole("dialog", { name: "撤回记录" })).getByRole("button", { name: "撤回记录" }));
    // Withdrawn just now, on the page: the day is today's.
    expect(await detail.findByText(/^这条记录已撤回 · \d{4}-\d{2}-\d{2}$/u)).toBeVisible();
    expect(detail.queryByRole("button", { name: "修改决定" })).toBeNull();
    expect(detail.queryByRole("button", { name: "转为正式决策" })).toBeNull();
    expect(detail.getByRole("button", { name: "恢复有效" })).toBeVisible();
  });

  it("shows who changed what and what it read before, folded at the foot, and the day a record was withdrawn", async () => {
    mount();
    const user = userEvent.setup();
    await waitFor(() => expect(rows()).toHaveLength(10));
    await user.click(rows()[1]!);
    let detail = within(await screen.findByRole("dialog", { name: "历史决定详情" }));
    const history = await detail.findByText("变更历史");
    expect(history.closest("details")).not.toHaveAttribute("open");
    expect(history.parentElement).toHaveTextContent("3 条");
    await user.click(history);
    const changed = detail.getByText("修改：最终决定").closest(".amendment-history-row") as HTMLElement;
    expect(within(changed).getByText("我")).toBeVisible();
    expect(within(changed).getByText("放进主导航第五项").tagName).toBe("DEL");
    expect(within(changed).getByText("放进主导航第六项，首页只留计数").tagName).toBe("INS");
    // Nothing written before is said, not struck through.
    expect(detail.getByText("（空）").tagName).toBe("SPAN");
    expect(detail.getByText("Codex")).toBeVisible();
    cleanup();

    mount();
    await waitFor(() => expect(rows()).toHaveLength(10));
    await user.click(rows().find((row) => row.textContent?.includes("团队仓库"))!);
    detail = within(await screen.findByRole("dialog", { name: "历史决定详情" }));
    expect(await detail.findByText("这条记录已撤回 · 2026-11-20")).toBeVisible();
  });

  it("makes a decision record of one once, and from then on leads to it", async () => {
    const { api, onOpenDecision } = mount();
    const update = vi.spyOn(api, "updateHistoricalDecision");
    const user = userEvent.setup();
    await waitFor(() => expect(rows()).toHaveLength(10));
    await user.click(rows()[0]!);
    const detail = within(await screen.findByRole("dialog", { name: "历史决定详情" }));
    await user.click(await detail.findByRole("button", { name: "转为正式决策" }));
    await user.click(within(await screen.findByRole("dialog", { name: "转为正式决策" })).getByRole("button", { name: "转为正式决策" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ id: "hdec-preview-update", expectedRevision: 1, promote: true }));
    expect(await detail.findByText("已转为正式决策")).toBeVisible();
    expect(detail.queryByRole("button", { name: "转为正式决策" })).toBeNull();
    await user.click(detail.getByRole("button", { name: "打开正式决策" }));
    expect(onOpenDecision).toHaveBeenCalledWith("recent-1");
  });
});

describe("ActiveRecordDialog › 历史决定", () => {
  const saved = { recordVersion: 1, status: "created", recordKind: "decision", recordId: "d-1", knowledgeStatus: "active", sensitivity: "private", storedTranscript: false } as const;

  it("is offered only where it can be saved, asks for no rationale, and saves through its own call", async () => {
    const createProactiveRecord = vi.fn(async () => saved);
    const first = render(<ActiveRecordDialog api={{ createProactiveRecord }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "历史决定" })).toBeNull();
    first.unmount();

    const preview = createHistoricalDecisionPreview("empty");
    const record = vi.spyOn(preview, "recordHistoricalDecision");
    const onSaved = vi.fn();
    render(<ActiveRecordDialog api={{ createProactiveRecord, ...preview }} initialKind="historical" onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByRole("button", { name: "历史决定" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText(/理由/u)).toBeNull();
    expect(screen.getByRole("button", { name: /保存记录/u })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("决定事项"), { target: { value: "团建去哪？" } });
    fireEvent.change(screen.getByLabelText("最终决定"), { target: { value: "去海边" } });
    fireEvent.change(screen.getByLabelText("决定日期"), { target: { value: "2026-08-30" } });

    const more = screen.getByRole("button", { name: /更多追踪信息/u });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveTextContent("已填 0 项");
    fireEvent.click(more);
    fireEvent.change(screen.getByLabelText("备选方案"), { target: { value: "去爬山\n\n去露营" } });
    expect(more).toHaveTextContent("已填 1 项");

    fireEvent.click(screen.getByRole("button", { name: /保存记录/u }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ recordKind: "historical_decision", recordId: "hdec-preview-new-1", status: "created" }));
    expect(record.mock.calls[0]![0]).toMatchObject({ title: "团建去哪？", decision: "去海边", decidedOn: "2026-08-30", options: ["去爬山", "去露营"], sourceKind: "app_manual" });
    expect(createProactiveRecord).not.toHaveBeenCalled();
    cleanup();

    // The same thing sent again is not written twice, and the form says so instead of closing.
    onSaved.mockClear();
    render(<ActiveRecordDialog api={{ createProactiveRecord, ...preview }} draft={{ kind: "historical", title: "团建去哪？", content: "去海边" }} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("决定日期"), { target: { value: "2026-08-30" } });
    fireEvent.click(screen.getByRole("button", { name: /保存记录/u }));
    expect(await screen.findByText(/相同的历史决定，没有重复保存/u)).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("opens from a captured choice with what was not chosen under the fold, already unfolded, and its source fixed", () => {
    const draft = historicalDraft({
      question: "## 缓存放哪？\n\n- 先看体量",
      answer: "放本机",
      alternatives: ["放 **Redis**\n另起一行", "", ...Array.from({ length: 9 }, (_, index) => `方案 ${index}`)],
      project: "decision",
      context: "  只有单机部署。 ",
    });
    expect(draft).toMatchObject({ kind: "historical", title: "缓存放哪？先看体量", content: "放本机", project: "decision", context: "只有单机部署。", historical: { sourceKind: "agent_capture" } });
    // One line each, the empty one dropped, and no more than a record holds.
    expect(draft.historical?.options).toEqual(["放 Redis 另起一行", ...Array.from({ length: 7 }, (_, index) => `方案 ${index}`)]);

    render(<ActiveRecordDialog api={{ createProactiveRecord: vi.fn(), ...createHistoricalDecisionPreview("empty") }} draft={draft} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole("button", { name: /更多追踪信息/u })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("当时背景")).toHaveValue("只有单机部署。");
    expect(screen.getByLabelText("来源")).toHaveValue("Agent 采集");
    expect(screen.getByLabelText("来源")).toHaveAttribute("readonly");
  });
});
