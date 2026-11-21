// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CONTEXT_SUMMARY_LINES } from "@cognelis/decision-protocol";

import type { DecisionApi, RecordContextSummary } from "../src/shared/renderer-api.js";
import { ActiveRecordDialog, type ActiveRecordApi } from "../src/renderer/components/pages/decisions/ActiveRecordDialog.js";
import { loadActiveRecordDraft } from "../src/renderer/components/pages/decisions/active-record-draft.js";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const saved = {
  recordVersion: 1, status: "created", recordKind: "decision", recordId: "guarded-record",
  knowledgeStatus: "active", sensitivity: "private", storedTranscript: false,
} as const;

describe("ActiveRecordDialog", () => {
  it("restores an unfinished form, isolates generated text, and clears only after saving", async () => {
    const createProactiveRecord = vi.fn<DecisionApi["createProactiveRecord"]>(async () => saved);
    const props = { api: { createProactiveRecord }, onClose: vi.fn(), onSaved: vi.fn() };
    const first = render(<ActiveRecordDialog {...props} />);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "未完成的记录" } });
    fireEvent.change(screen.getByLabelText("最终选择"), { target: { value: "先验证再扩大范围" } });
    fireEvent.change(screen.getByLabelText("复盘日期"), { target: { value: "2026-10-01" } });
    first.unmount();
    const generated = render(<ActiveRecordDialog {...props} draft={{ title: "回答转存", content: "模型归纳" }} />);
    expect(screen.getByLabelText("标题")).toHaveValue("回答转存");
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledOnce());
    expect(loadActiveRecordDraft().value?.title).toBe("未完成的记录");
    generated.unmount();
    render(<ActiveRecordDialog {...props} />);
    expect(screen.getByLabelText("标题")).toHaveValue("未完成的记录");
    expect(screen.getByLabelText("复盘日期")).toHaveValue("2026-10-01");
    createProactiveRecord.mockRejectedValueOnce(new Error("写入失败"));
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    expect(await screen.findByText("保存失败：写入失败")).toBeVisible();
    expect(loadActiveRecordDraft().value?.content).toBe("先验证再扩大范围");
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(loadActiveRecordDraft().value).toBeNull());
  });

  it("sends the languages a preference is specific to as typed, none for a general one, and never for a decision", async () => {
    const createProactiveRecord = vi.fn<DecisionApi["createProactiveRecord"]>(async () => saved);
    render(<ActiveRecordDialog api={{ createProactiveRecord }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByLabelText("适用语言")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "错误处理" } });
    fireEvent.change(screen.getByLabelText("当前偏好"), { target: { value: "错误用 fmt.Errorf 包装后再返回" } });
    fireEvent.change(screen.getByLabelText("适用语言"), { target: { value: "Go，golang 、 Rust" } });
    expect(loadActiveRecordDraft().value?.languages).toBe("Go，golang 、 Rust");
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledOnce());
    // Made one name each where it is kept: golang and Go are the same there.
    expect(createProactiveRecord.mock.calls[0]![0]).toMatchObject({ kind: "preference", languages: ["Go", "golang", "Rust"] });

    cleanup();
    render(<ActiveRecordDialog api={{ createProactiveRecord }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "想法" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "评审清单" } });
    fireEvent.change(screen.getByLabelText("想法内容"), { target: { value: "每次评审先过一遍清单" } });
    fireEvent.change(screen.getByLabelText("适用语言"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledTimes(2));
    expect(createProactiveRecord.mock.calls[1]![0]).not.toHaveProperty("languages");

    cleanup();
    render(<ActiveRecordDialog api={{ createProactiveRecord }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "命名" } });
    fireEvent.change(screen.getByLabelText("当前偏好"), { target: { value: "包名用小写单词" } });
    fireEvent.change(screen.getByLabelText("适用语言"), { target: { value: "a、b、c、d、e、f、g、h、i" } });
    expect(screen.getByRole("alert")).toHaveTextContent("适用语言最多 8 项");
    expect(screen.getByRole("button", { name: "保存记录" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "决策" }));
    expect(screen.queryByLabelText("适用语言")).toBeNull();
    fireEvent.change(screen.getByLabelText("最终选择"), { target: { value: "包名用小写单词" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledTimes(3));
    expect(createProactiveRecord.mock.calls[2]![0]).not.toHaveProperty("languages");
  });

  it("names the rationale field by the label shown for it", () => {
    render(<ActiveRecordDialog api={{ createProactiveRecord: vi.fn() }} onClose={vi.fn()} onSaved={vi.fn()} />);
    // Shown as 理由（可稍后补充） and named 补充说明, a speech user saying what they saw did not reach it.
    const label = screen.getByText("理由（可稍后补充）");
    expect(document.getElementById(label.getAttribute("for") ?? "")).toHaveAccessibleName("理由");
  });

  it("protects unreadable drafts until the reader explicitly clears them", () => {
    localStorage.setItem("decision.active-record.draft.v1", "unreadable original");
    render(<ActiveRecordDialog api={{ createProactiveRecord: vi.fn() }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "另一个标题" } });
    expect(screen.getByRole("alert")).toHaveTextContent("无法读取本机草稿");
    expect(localStorage.getItem("decision.active-record.draft.v1")).toBe("unreadable original");
    fireEvent.click(screen.getByRole("button", { name: "清空草稿" }));
    expect(screen.getByLabelText("标题")).toHaveValue("");
    expect(loadActiveRecordDraft().value).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the dialog and the draft when the record already exists, saying the new fields were not saved", async () => {
    const createProactiveRecord = vi.fn<DecisionApi["createProactiveRecord"]>(async () => ({ ...saved, status: "duplicate", recordId: "first" }));
    const onSaved = vi.fn();
    render(<ActiveRecordDialog api={{ createProactiveRecord }} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "列表分页用游标还是偏移？" } });
    fireEvent.change(screen.getByLabelText("最终选择"), { target: { value: "统一用游标分页" } });
    fireEvent.change(screen.getByLabelText("项目"), { target: { value: "mobile" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));

    expect(await screen.findByText(/已有标题和最终选择都相同的记录，这次填写的其它内容没有保存/u)).toBeVisible();
    expect(onSaved).not.toHaveBeenCalled();
    expect(loadActiveRecordDraft().value?.project).toBe("mobile");
    // About the decision just tried, not a preference nobody has tried to save.
    fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    expect(screen.queryByText(/已有标题和/u)).toBeNull();
  });

  it("offers to keep a draft only while it is actually being kept", () => {
    localStorage.setItem("decision.active-record.draft.v1", "unreadable original");
    render(<ActiveRecordDialog api={{ createProactiveRecord: vi.fn() }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "另一个标题" } });
    expect(screen.queryByRole("button", { name: "关闭并保留草稿" })).toBeNull();
    expect(screen.getByRole("button", { name: "取消" })).toBeVisible();
  });

  it("saves an optional review date only for a decision", async () => {
    const createProactiveRecord = vi.fn<DecisionApi["createProactiveRecord"]>(async () => saved);
    render(<ActiveRecordDialog api={{ createProactiveRecord }} draft={{ title: "逐步上线", content: "先做灰度" }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("复盘日期"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: "decision", reviewDueDate: "2026-10-01" })));
    fireEvent.click(screen.getByRole("button", { name: "想法" }));
    expect(screen.queryByLabelText("复盘日期")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledTimes(2));
    expect(createProactiveRecord.mock.calls[1]?.[0]).not.toHaveProperty("reviewDueDate");
  });

  it("validates only the fields belonging to the selected record kind", () => {
    const createProactiveRecord = vi.fn(async () => saved);
    render(<ActiveRecordDialog api={{ createProactiveRecord }} draft={{ title: "已有标题", content: "已有内容" }} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    const appliesWhen = screen.getByRole("textbox", { name: "适用条件" });
    fireEvent.change(appliesWhen, { target: { value: "条件".repeat(2_001) } });
    expect(appliesWhen).toHaveAccessibleDescription(/4000/);
    expect(screen.getByRole("button", { name: "保存记录" })).toBeDisabled();
    fireEvent.keyDown(appliesWhen, { key: "Enter", ctrlKey: true });
    expect(createProactiveRecord).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "想法" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "保存记录" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    expect(screen.getByRole("textbox", { name: "适用条件" })).toHaveValue("条件".repeat(2_001));
  });

  it("keeps oversized draft text and blocks both submit paths until corrected", async () => {
    const createProactiveRecord = vi.fn(async () => saved);
    const oversized = "题".repeat(501);
    render(<ActiveRecordDialog api={{ createProactiveRecord }} draft={{ title: oversized, content: "整理后的选择" }} onClose={vi.fn()} onSaved={vi.fn()} />);
    const title = screen.getByRole("textbox", { name: "标题" });
    expect(title).toHaveValue(oversized);
    expect(screen.getByRole("button", { name: "保存记录" })).toBeDisabled();
    expect(title).toHaveAccessibleDescription(/500/);
    fireEvent.keyDown(title, { key: "Enter", metaKey: true });
    fireEvent.submit(title.closest("form")!);
    expect(createProactiveRecord).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: "可保存的标题" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledOnce());
    expect(createProactiveRecord).toHaveBeenCalledWith(expect.objectContaining({ title: "可保存的标题", content: "整理后的选择", sourceForm: "user_paraphrase" }));
  });

  it("keeps a saving draft locked and submits only once, then permits a failed save to be retried", async () => {
    let fail!: (error: Error) => void;
    const createProactiveRecord = vi.fn<DecisionApi["createProactiveRecord"]>(() => new Promise((_resolve, reject) => { fail = reject; }));
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<ActiveRecordDialog api={{ createProactiveRecord }} draft={{ title: "原标题", content: "原内容" }} onClose={onClose} onSaved={onSaved} />);
    const title = screen.getByRole("textbox", { name: "标题" });
    act(() => {
      fireEvent.submit(title.closest("form")!);
      fireEvent.submit(title.closest("form")!);
    });
    expect(createProactiveRecord).toHaveBeenCalledOnce();
    expect(title).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭主动记录" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { fail(new Error("保存暂不可用")); });
    expect(screen.getByRole("alert")).toHaveTextContent("保存暂不可用");
    expect(title).toBeEnabled();
    expect(title).toHaveValue("原标题");
    expect(screen.getByRole("textbox", { name: "最终选择" })).toHaveValue("原内容");
    createProactiveRecord.mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
    expect(createProactiveRecord).toHaveBeenCalledTimes(2);
  });

  it("records a scoped preference from a progressive form", async () => {
    const createProactiveRecord = vi.fn(async () => ({
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: "preference" as const,
      recordId: "preference-1",
      knowledgeStatus: "active" as const,
      sensitivity: "private" as const,
      storedTranscript: false as const,
    }));
    const onSaved = vi.fn();
    render(
      <ActiveRecordDialog
        api={{ createProactiveRecord } as unknown as DecisionApi}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    fireEvent.change(screen.getByLabelText("标题"), {
      target: { value: "常规实现决策默认由系统自主完成" },
    });
    fireEvent.change(screen.getByLabelText("当前偏好"), {
      target: { value: "普通可逆的方向与实现由系统自行判断并交付结果。" },
    });
    fireEvent.change(screen.getByLabelText("适用条件"), {
      target: { value: "既定目标和仓库范围内的普通产品与工程取舍。" },
    });
    fireEvent.change(screen.getByLabelText("例外与边界"), {
      target: { value: "权限、付费、不可逆操作、公开范围或核心验收冲突。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));

    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledOnce());
    expect(createProactiveRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "preference",
        sourceKind: "app_manual",
        sourceForm: "user_original",
        sensitivity: "private",
      }),
    );
    // What the reader gave, and nothing worked out for them: recorded again, the entry already there kept
    // its standing and its strength, where a status from this form's empty fields and a strength nobody
    // picked demoted it to 待澄清 and softened its hard constraint.
    expect(createProactiveRecord).toHaveBeenLastCalledWith(expect.not.objectContaining({ knowledgeStatus: expect.anything() }));
    expect(createProactiveRecord).toHaveBeenLastCalledWith(expect.not.objectContaining({ strength: expect.anything() }));
    expect(onSaved).toHaveBeenCalled();

    // Picked, even the one shown, it is said.
    fireEvent.change(screen.getByLabelText("偏好强度"), { target: { value: "default" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledTimes(2));
    expect(createProactiveRecord).toHaveBeenLastCalledWith(expect.objectContaining({ strength: "default" }));
  });

  it("never files a draft as the reader's own words", async () => {
    const createProactiveRecord = vi.fn(async () => ({
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: "decision" as const,
      recordId: "decision-1",
      knowledgeStatus: "active" as const,
      sensitivity: "private" as const,
      storedTranscript: false as const,
    }));
    render(
      <ActiveRecordDialog
        api={{ createProactiveRecord } as unknown as DecisionApi}
        draft={{ title: "为什么先留测试环境？", content: "先留测试环境。" }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));

    // "user_original" claims the reader typed it. Accepting a draft verbatim
    // is a paraphrase, and a provenance claim in a permanent record has to be
    // true even then.
    await waitFor(() =>
      expect(createProactiveRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceKind: "app_manual",
          sourceForm: "user_paraphrase",
          title: "为什么先留测试环境？",
          content: "先留测试环境。",
        }),
      ),
    );
  });

  it("saves with Cmd/Ctrl+Enter once the required fields are filled", async () => {
    const createProactiveRecord = vi.fn(async () => ({
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: "idea" as const,
      recordId: "idea-2",
      knowledgeStatus: "inbox" as const,
      sensitivity: "private" as const,
      storedTranscript: false as const,
    }));
    render(
      <ActiveRecordDialog
        api={{ createProactiveRecord } as unknown as DecisionApi}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "想法" }));
    const title = screen.getByLabelText("标题");
    fireEvent.keyDown(title, { key: "Enter", metaKey: true });
    expect(createProactiveRecord).not.toHaveBeenCalled();

    fireEvent.change(title, { target: { value: "冲突触发复盘" } });
    const content = screen.getByLabelText("想法内容");
    fireEvent.change(content, { target: { value: "只在真实冲突时建议复盘。" } });
    fireEvent.keyDown(content, { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "保存记录" })).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+Enter Control+Enter",
    );
  });

  // The footer's buttons sit outside the form: ⌘↩ from one of them still saves, through the same checks.
  it("saves with Cmd/Ctrl+Enter from the footer too", async () => {
    const createProactiveRecord = vi.fn(async () => ({
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: "idea" as const,
      recordId: "idea-3",
      knowledgeStatus: "inbox" as const,
      sensitivity: "private" as const,
      storedTranscript: false as const,
    }));
    render(
      <ActiveRecordDialog
        api={{ createProactiveRecord } as unknown as DecisionApi}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "想法" }));
    const save = screen.getByRole("button", { name: "保存记录" });
    expect(save.closest("form")).toBeNull();
    fireEvent.keyDown(save, { key: "Enter", metaKey: true });
    expect(createProactiveRecord).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "冲突触发复盘" } });
    fireEvent.change(screen.getByLabelText("想法内容"), { target: { value: "只在真实冲突时建议复盘。" } });
    fireEvent.keyDown(save, { key: "Enter", metaKey: true });

    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledOnce());
  });

  it("quick-captures an idea into the inbox", async () => {
    const createProactiveRecord = vi.fn(async () => ({
      recordVersion: 1 as const,
      status: "created" as const,
      recordKind: "idea" as const,
      recordId: "idea-1",
      knowledgeStatus: "inbox" as const,
      sensitivity: "private" as const,
      storedTranscript: false as const,
    }));
    render(
      <ActiveRecordDialog
        api={{ createProactiveRecord } as unknown as DecisionApi}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "想法" }));
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "冲突触发复盘" } });
    fireEvent.change(screen.getByLabelText("想法内容"), { target: { value: "只在真实冲突时建议复盘。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存记录" }));

    await waitFor(() =>
      expect(createProactiveRecord).toHaveBeenCalledWith(expect.objectContaining({ kind: "idea" })),
    );
    // Its standing is the record's to work out: with nothing on why it is worth keeping, 待澄清.
    expect(createProactiveRecord).toHaveBeenLastCalledWith(expect.not.objectContaining({ knowledgeStatus: expect.anything() }));
  });

  it("keeps a draft it was opened with, once changed, against a stray Escape: it is kept nowhere else", async () => {
    const onClose = vi.fn();
    render(
      <ActiveRecordDialog
        api={{ createProactiveRecord: vi.fn() } as unknown as DecisionApi}
        draft={{ title: "为什么先留测试环境？", content: "先留测试环境。" }}
        onClose={onClose}
        onSaved={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "主动记录" });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "配置变更是否先只在测试环境验证" } });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ActiveRecordDialog summary of the context it was opened with", () => {
  const original = "PR：调整请求超时（sample/app#123）\n位置：src/request.ts:12\n讨论串：\nBob：超时写死不好。";
  const summary = "在做什么：src/request.ts:12 给请求加了超时。\n定了什么：超时由调用方传入。";
  const summarized: RecordContextSummary = { status: "summarized", summary, model: "qwen3.5-2b-q4-k-m", clipped: false };
  type Summarize = NonNullable<ActiveRecordApi["summarizeRecordContext"]>;
  const later = () => {
    let resolve!: (value: RecordContextSummary) => void;
    const promise = new Promise<RecordContextSummary>((done) => { resolve = done; });
    return { promise, resolve };
  };
  const renderWith = (summarizeRecordContext: Summarize, context = original) => {
    const createProactiveRecord = vi.fn<DecisionApi["createProactiveRecord"]>(async () => saved);
    const cancelRecordContextSummary = vi.fn(async (_requestId: string) => undefined);
    const onClose = vi.fn();
    const view = render(<ActiveRecordDialog api={{ createProactiveRecord, summarizeRecordContext, cancelRecordContextSummary }}
      draft={{ title: "超时由谁决定？", content: "超时由调用方传入。", context }} onClose={onClose} onSaved={vi.fn()} />);
    return { ...view, createProactiveRecord, cancelRecordContextSummary, onClose };
  };
  const contextBox = () => screen.getByRole("textbox", { name: "当时上下文" });

  it("offers a summary only beside a context, runs it and shows it apart for checking, the context untouched", async () => {
    // Begun here, a form has no context and nothing to summarize.
    render(<ActiveRecordDialog api={{ createProactiveRecord: vi.fn(), summarizeRecordContext: vi.fn(), cancelRecordContextSummary: vi.fn() }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "用本机模型总结" })).toBeNull();
    cleanup();
    const running = later();
    const summarize = vi.fn<Summarize>(() => running.promise);
    const { onClose } = renderWith(summarize);
    const button = screen.getByRole("button", { name: "用本机模型总结" });
    fireEvent.click(button);
    expect(summarize).toHaveBeenCalledWith({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u), context: original, title: "超时由谁决定？", choice: "超时由调用方传入。" });
    // The same button, so focus stays on it: pressed again, it stops the summary.
    expect(button).toHaveAccessibleName("取消总结");
    expect(screen.getByText(/^本机模型正在总结/u)).toHaveAttribute("role", "status");
    expect(contextBox()).toHaveAttribute("readonly");
    await act(async () => running.resolve(summarized));
    const panel = screen.getByRole("region", { name: "本机模型总结" });
    expect(panel).toHaveTextContent("本机模型生成，可能遗漏或有误，请核对");
    expect(within(panel).getByText(/^在做什么：src\/request.ts:12 给请求加了超时。/u)).toBeVisible();
    expect(within(panel).getAllByRole("button").map((choice) => choice.textContent)).toEqual(["用总结替换上下文", "放在上下文前面", "不用"]);
    expect(contextBox()).toHaveValue(original);
    expect(contextBox()).not.toHaveAttribute("readonly");
    // Waited for, it is not thrown away by a stray Escape.
    fireEvent.keyDown(screen.getByRole("dialog", { name: "主动记录" }), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("replaces the context or goes before it, marked as the local model's, and 撤回 puts the reader's own back", async () => {
    const { createProactiveRecord } = renderWith(vi.fn<Summarize>(async () => summarized));
    fireEvent.click(screen.getByRole("button", { name: "用本机模型总结" }));
    fireEvent.click(await screen.findByRole("button", { name: "用总结替换上下文" }));
    expect(contextBox()).toHaveValue(`（本机模型总结，经确认采用）\n${summary}`);
    expect(screen.getByText(/^已用总结替换上下文/u)).toHaveAttribute("role", "status");
    const undo = screen.getByRole("button", { name: "撤回，恢复原上下文" });
    expect(undo).toHaveFocus();
    // Summarized again over it, the context it replaced, kept for 撤回 alone, would be gone.
    expect(screen.getByRole("button", { name: "用本机模型总结" })).toBeDisabled();
    fireEvent.click(undo);
    expect(contextBox()).toHaveValue(original);
    // Back at the choice, the reader's to make again.
    expect(screen.getByRole("button", { name: "用总结替换上下文" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "放在上下文前面" }));
    const adopted = `（本机模型总结，经确认采用）\n${summary}\n\n（以下为原上下文）\n${original}`;
    expect(contextBox()).toHaveValue(adopted);
    fireEvent.click(screen.getByRole("button", { name: /保存记录/u }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledOnce());
    // Saved, the record says whose words they are: the local model's, adopted by the reader, before the draft's own.
    expect(createProactiveRecord.mock.calls[0]![0]).toMatchObject({ context: adopted, sourceForm: "user_paraphrase" });
  });

  it("undoes an adopted summary only as far as edits made since allow, never dropping them", async () => {
    renderWith(vi.fn<Summarize>(async () => summarized));
    const value = () => (contextBox() as HTMLTextAreaElement).value;
    fireEvent.click(screen.getByRole("button", { name: "用本机模型总结" }));
    fireEvent.click(await screen.findByRole("button", { name: "放在上下文前面" }));
    // Edited under the summary: 撤回 takes the summary off and leaves the edit.
    fireEvent.change(contextBox(), { target: { value: `${value()}\n补充：5 秒是和网关约定的。` } });
    fireEvent.click(screen.getByRole("button", { name: "撤回，恢复原上下文" }));
    expect(contextBox()).toHaveValue(`${original}\n补充：5 秒是和网关约定的。`);
    // Edited in the summary itself: what 撤回 would put back has no room for the edit, so it is not offered.
    fireEvent.click(screen.getByRole("button", { name: "用总结替换上下文" }));
    const edited = `${value()}（已核对）`;
    fireEvent.change(contextBox(), { target: { value: edited } });
    const undo = screen.getByRole("button", { name: "撤回，恢复原上下文" });
    expect(undo).toBeDisabled();
    expect(undo).toHaveAccessibleDescription(/采用后又改过上下文/u);
    expect(contextBox()).toHaveValue(edited);
    // Still not summarized again: the reader edits the context by hand from here.
    expect(screen.getByRole("button", { name: "用本机模型总结" })).toBeDisabled();
  });

  it("keeps 用本机模型总结 off while a summary is adopted, so the context before it is never lost or marked twice", async () => {
    renderWith(vi.fn<Summarize>(async () => summarized));
    const value = () => (contextBox() as HTMLTextAreaElement).value;
    const again = screen.getByRole("button", { name: "用本机模型总结" });
    fireEvent.click(again);
    fireEvent.click(await screen.findByRole("button", { name: "用总结替换上下文" }));
    expect(again).toBeDisabled();
    // A character changed, then changed back. Summarized again in between, the context before the summary was gone
    // for good, and one put in front of the other left two marks, the first heading the model's text as the reader's.
    const adopted = value();
    fireEvent.change(contextBox(), { target: { value: `${adopted}x` } });
    expect(again).toBeDisabled();
    expect(again).toHaveAccessibleDescription("采用后又改过上下文，撤回会丢掉这些修改，所以撤回和重新总结都不可用；要去掉总结，请直接在上面删改。");
    fireEvent.change(contextBox(), { target: { value: adopted } });
    expect(again).toHaveAccessibleDescription("已采用总结；如需重新总结，请先撤回。");
    fireEvent.click(screen.getByRole("button", { name: "撤回，恢复原上下文" }));
    expect(contextBox()).toHaveValue(original);
    fireEvent.click(screen.getByRole("button", { name: "放在上下文前面" }));
    expect(value().split(CONTEXT_SUMMARY_LINES.mark)).toHaveLength(2);
    expect(value().split(CONTEXT_SUMMARY_LINES.original)).toHaveLength(2);
    expect(value().endsWith(`${CONTEXT_SUMMARY_LINES.original}\n${original}`)).toBe(true);
  });

  it("does not offer to put the summary in front when the context would pass its limit, and says why", async () => {
    renderWith(vi.fn<Summarize>(async () => summarized), "讨论".repeat(3_975));
    fireEvent.click(screen.getByRole("button", { name: "用本机模型总结" }));
    const prepend = await screen.findByRole("button", { name: "放在上下文前面" });
    // Put there, the record could not be saved until the reader found what to cut.
    expect(prepend).toBeDisabled();
    expect(prepend).toHaveAccessibleDescription("放在前面后当时上下文会超过 8000 个字符的上限，可以先删减上下文，或用总结替换。");
    expect(screen.getByRole("button", { name: "用总结替换上下文" })).toBeEnabled();
  });

  it("says the context is marked as the local model's only while the mark heads it", async () => {
    renderWith(vi.fn<Summarize>(async () => summarized));
    fireEvent.click(screen.getByRole("button", { name: "用本机模型总结" }));
    fireEvent.click(await screen.findByRole("button", { name: "用总结替换上下文" }));
    expect(screen.getByText(/^已用总结替换上下文/u)).toHaveTextContent(/^已用总结替换上下文，开头注明了是本机模型总结。$/u);
    // The reader is its author: the mark is theirs to take out, and the form then no longer says it is there.
    fireEvent.change(contextBox(), { target: { value: summary } });
    expect(screen.getByText(/^已用总结替换上下文/u)).toHaveTextContent(/^已用总结替换上下文。$/u);
  });

  it("leaves the reader's text as it was when the summary is not used", async () => {
    const { createProactiveRecord } = renderWith(vi.fn<Summarize>(async () => summarized));
    const edited = `${original}\n补充：5 秒是和网关约定的。`;
    fireEvent.change(contextBox(), { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "用本机模型总结" }));
    fireEvent.click(await screen.findByRole("button", { name: "不用" }));
    expect(screen.queryByRole("region", { name: "本机模型总结" })).toBeNull();
    expect(contextBox()).toHaveValue(edited);
    expect(screen.getByRole("button", { name: "用本机模型总结" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /保存记录/u }));
    await waitFor(() => expect(createProactiveRecord).toHaveBeenCalledWith(expect.objectContaining({ context: edited })));
  });

  it("stops a running summary on 取消总结 and when the form closes, taking nothing from it after", async () => {
    const running = later();
    const summarize = vi.fn<Summarize>(() => running.promise);
    const { cancelRecordContextSummary, unmount } = renderWith(summarize);
    fireEvent.click(screen.getByRole("button", { name: "用本机模型总结" }));
    fireEvent.click(screen.getByRole("button", { name: "取消总结" }));
    expect(cancelRecordContextSummary).toHaveBeenCalledWith(summarize.mock.calls[0]![0].requestId);
    expect(screen.getByText("已取消总结，上下文没有改动。")).toHaveAttribute("role", "status");
    await act(async () => running.resolve(summarized));
    expect(screen.queryByRole("region", { name: "本机模型总结" })).toBeNull();
    expect(contextBox()).toHaveValue(original);
    // Closed while one runs: nobody is left to read it, so it is stopped.
    summarize.mockReturnValueOnce(later().promise);
    fireEvent.click(screen.getByRole("button", { name: "用本机模型总结" }));
    unmount();
    expect(cancelRecordContextSummary).toHaveBeenLastCalledWith(summarize.mock.calls[1]![0].requestId);
  });

  it("says why there is no summary, a timeout or a failure as it is, and keeps the context as it was", async () => {
    const summarize = vi.fn<Summarize>()
      .mockResolvedValueOnce({ status: "unavailable", reason: "没有启用本机模型。请先在“模型”中启用 Qwen 本机模型；总结只在本机进行，不会发给远端 API 或命令行工具。" })
      .mockRejectedValueOnce(new Error("本机模型没有在限定时间内写完总结（可能正忙于其它调用，或上下文较长），可以稍后重试。"))
      .mockRejectedValueOnce(new Error("总结没有完成：模型的回答不符合要求的格式（例如超出长度），请重试或换一个模型。"));
    renderWith(summarize);
    const button = screen.getByRole("button", { name: "用本机模型总结" });
    fireEvent.click(button);
    expect(await screen.findByText(/^没有启用本机模型。请先在“模型”中启用 Qwen 本机模型/u)).toHaveAttribute("role", "status");
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent("本机模型没有在限定时间内写完总结（可能正忙于其它调用，或上下文较长），可以稍后重试。原上下文没有改动。");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/^总结没有完成：模型的回答不符合要求的格式/u));
    expect(contextBox()).toHaveValue(original);
    expect(button).toBeEnabled();
  });
});
