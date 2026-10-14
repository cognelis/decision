// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionApi } from "../src/shared/renderer-api.js";
import { ActiveRecordDialog } from "../src/renderer/components/pages/decisions/ActiveRecordDialog.js";
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
    expect(screen.getByText("理由（可稍后补充）").closest("label")?.querySelector("textarea")).toHaveAccessibleName("理由");
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
