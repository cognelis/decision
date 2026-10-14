// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionContextQuerySchema, decisionContextResultSchema, decisionContextResponseSchema, decisionScopeSchema, decisionHandoffRequestSchema, type DecisionContextResponse, type DecisionContextResult } from "@cognelis/decision-protocol";
import type { DecisionEvidenceApi } from "../src/shared/renderer-api.js";
import { createEvidencePreviewApi } from "../src/renderer/evidence-preview-api.js";
import { DecisionEvidencePanel } from "../src/renderer/components/pages/decisions/DecisionEvidencePanel.js";

afterEach(cleanup);
const setup = async (overrides: Partial<DecisionContextResult> = {}) => {
  const preview = createEvidencePreviewApi();
  let record = decisionContextResultSchema.parse({ ...(await preview.searchDecisionContext(decisionContextQuerySchema.parse({ recordId: "A" }))).results[0], scopeState: "current", scopeRevision: 3, applicability: { status: "needs_review", reasons: [], scope: decisionScopeSchema.parse({ repositoryIds: [`repo:${"b".repeat(64)}`], layers: ["frontend"] }) }, ...overrides });
  const response = (records = [record]) => decisionContextResponseSchema.parse({ contextVersion: 1, status: records.length ? "matched" : "no_match", coverage: "complete", sources: [{ source: "decisions", status: "ready", records: records.length, skipped: 0 }], results: records, total: records.length, nextOffset: null, guidance: "", boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true } });
  const api = {
    saveDecisionContextFeedback: preview.saveDecisionContextFeedback,
    getDecisionContextFeedback: preview.getDecisionContextFeedback,
    searchDecisionContext: vi.fn<DecisionEvidenceApi["searchDecisionContext"]>(async () => response()),
    updateDecisionScope: vi.fn<DecisionEvidenceApi["updateDecisionScope"]>(async () => ({ status: "saved", revision: 4, originalNoteUnchanged: true })),
    updateDecisionRelation: vi.fn<DecisionEvidenceApi["updateDecisionRelation"]>(async () => ({ status: "saved", revision: 1, originalNotesUnchanged: true })),
    openDecisionSource: vi.fn<DecisionEvidenceApi["openDecisionSource"]>(async () => ({ status: "opened", relativePath: record.sourceRef.relativePath, noNoteWritten: true })),
    prepareDecisionHandoff: vi.fn(preview.prepareDecisionHandoff),
  };
  return { api, record, response, setRecord: (value: DecisionContextResult) => { record = value; } };
};
const show = async (api: DecisionEvidenceApi) => {
  const result = render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" />);
  await screen.findByRole("button", { name: "打开原文" }); return result;
};

describe("desktop decision evidence", () => {
  it("tells the detail around it while a draft is open", async () => {
    const { api } = await setup();
    const onEditingChange = vi.fn();
    render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" onEditingChange={onEditingChange} />);
    await screen.findByRole("button", { name: "打开原文" });
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByText(/适用范围 ·/)); fireEvent.click(screen.getByRole("button", { name: "编辑范围" }));
    expect(onEditingChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "取消范围编辑" }));
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });
  it("stops saying the source could not be read once a later read succeeds", async () => {
    const { api } = await setup();
    api.searchDecisionContext.mockRejectedValueOnce(new Error("vault busy"));
    const view = render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取来源失败，请重新读取。");

    // The detail around it moves on (an outcome recorded), and the read now succeeds.
    view.rerender(<DecisionEvidencePanel api={api} decisionId="A" revision="2" />);

    await screen.findByRole("button", { name: "打开原文" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("saves explicit scope against its original version and preserves hidden repository restrictions", async () => {
    const { api } = await setup(); await show(api);
    fireEvent.click(screen.getByText(/适用范围 ·/)); fireEvent.click(screen.getByRole("button", { name: "编辑范围" }));
    fireEvent.change(screen.getByLabelText("适用项目"), { target: { value: "demo\n\n" } });
    fireEvent.change(screen.getByLabelText("修改理由"), { target: { value: "仅针对业务列表" } });
    fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    await waitFor(() => expect(api.updateDecisionScope).toHaveBeenCalledWith(expect.objectContaining({ source: "decisions", recordId: "A", expectedRevision: 3, expectedContentHash: "a".repeat(64), scope: expect.objectContaining({ projects: ["demo"], repositoryIds: [`repo:${"b".repeat(64)}`], layers: ["frontend"] }) })));
    expect(await screen.findByText("适用范围已保存。")).toBeInTheDocument();
  });
  it("retains the scope draft on version conflicts and does not silently retry", async () => {
    const { api } = await setup(); api.updateDecisionScope.mockResolvedValue({ status: "source_changed", revision: 3, originalNoteUnchanged: true });
    await show(api); fireEvent.click(screen.getByText(/适用范围 ·/)); fireEvent.click(screen.getByRole("button", { name: "编辑范围" }));
    fireEvent.change(screen.getByLabelText("适用例外"), { target: { value: "旧版迁移仍保留原方案" } });
    fireEvent.change(screen.getByLabelText("修改理由"), { target: { value: "补充例外" } }); fireEvent.click(screen.getByRole("button", { name: "保存范围" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("原文已改变");
    expect(screen.getByLabelText("适用例外")).toHaveValue("旧版迁移仍保留原方案"); expect(api.updateDecisionScope).toHaveBeenCalledTimes(1);
  });
  it("requires an explicit target, direction and reason before saving a replacement", async () => {
    const { api, record, response } = await setup(); const other = { ...record, source: "summarize" as const, id: "B", title: "新的业务编号方案" };
    await show(api); fireEvent.click(screen.getByText(/关联决策 ·/)); fireEvent.click(screen.getByRole("button", { name: "关联另一条决策" }));
    await screen.findByLabelText("查找另一条决策");
    api.searchDecisionContext.mockImplementation(async (query) => query.source === "summarize" ? response([other]) : response());
    fireEvent.change(screen.getByLabelText("查找另一条决策"), { target: { value: "编号" } }); fireEvent.click(screen.getByRole("button", { name: "查找决策" }));
    fireEvent.click(await screen.findByRole("button", { name: "历史沉淀 · 新的业务编号方案" }));
    fireEvent.change(screen.getByLabelText("关系判断"), { target: { value: "supersedes" } });
    fireEvent.change(screen.getByLabelText("哪条是后继决策"), { target: { value: "other" } });
    fireEvent.change(screen.getByLabelText("判断理由"), { target: { value: "已确认整体迁移到新方案" } });
    fireEvent.click(screen.getByRole("button", { name: "保存关系判断" }));
    await waitFor(() => expect(api.updateDecisionRelation).toHaveBeenCalledWith(expect.objectContaining({ first: { source: "decisions", recordId: "A", contentHash: "a".repeat(64) }, second: { source: "summarize", recordId: "B", contentHash: "a".repeat(64) }, disposition: "supersedes", successor: "second", expectedRevision: 0 })));
  });
  it("allows withdrawing a dangling relationship using its stored anchors", async () => {
    const first = { source: "decisions" as const, recordId: "A", contentHash: "c".repeat(64) }; const second = { source: "summarize" as const, recordId: "B", contentHash: "d".repeat(64) };
    const { api, response } = await setup({ relationCount: 1, relations: [{ relationId: "pair", disposition: "conflict", state: "missing_source", revision: 2, updatedAt: "2026-09-11T00:00:00Z", reason: "旧判断", successor: null, other: { source: "summarize", recordId: "B", title: "已删除来源" }, relativePath: "Decision Journal/decision-relations/pair.md", first, second, historyCount: 0, history: [] }] });
    await show(api); api.searchDecisionContext.mockImplementation(async () => response([]));
    fireEvent.click(screen.getByText(/关联决策 ·/)); fireEvent.click(screen.getByRole("button", { name: "调整或撤销关系" }));
    await screen.findByLabelText("关系判断"); fireEvent.change(screen.getByLabelText("关系判断"), { target: { value: "revoked" } });
    fireEvent.change(screen.getByLabelText("判断理由"), { target: { value: "撤回旧判断" } }); fireEvent.click(screen.getByRole("button", { name: "保存关系判断" }));
    await waitFor(() => expect(api.updateDecisionRelation).toHaveBeenCalledWith({ first, second, disposition: "revoked", successor: null, reason: "撤回旧判断", expectedRevision: 2 }));
  });
  it("previews and copies handoff text, then invalidates it after task input changes", async () => {
    const { api } = await setup(); const writeText = vi.fn(async () => undefined); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await show(api); fireEvent.click(screen.getByRole("button", { name: "整理交接" }));
    fireEvent.change(screen.getByLabelText("当前任务目标"), { target: { value: "继续列表优化" } });
    fireEvent.change(screen.getByLabelText("验证说明"), { target: { value: "已核对排序行为" } });
    fireEvent.click(screen.getByRole("button", { name: "生成交接预览" })); await screen.findByLabelText("交接内容");
    expect(api.prepareDecisionHandoff).toHaveBeenCalledWith(decisionHandoffRequestSchema.parse({ objective: "继续列表优化", project: "decision", references: [{ source: "decisions", recordId: "A", expectedContentHash: "a".repeat(64) }], verification: ["已核对排序行为"] }));
    fireEvent.click(screen.getByRole("button", { name: "复制交接内容" })); await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    await screen.findByText("交接内容已复制。"); fireEvent.change(screen.getByLabelText("当前任务目标"), { target: { value: "改变后的目标" } });
    expect(screen.queryByLabelText("交接内容")).not.toBeInTheDocument();
  });
  it("keeps a feedback being written and a handoff preview through a re-read, the preview until its note changes", async () => {
    const { api, record, response } = await setup();
    // An IPC round trip, as in the app: not answered within the same task.
    const read = vi.fn((records = [record]) => new Promise<DecisionContextResponse>((resolve) => setTimeout(() => resolve(response(records)), 20)));
    api.searchDecisionContext.mockImplementation(() => read());
    const prepare = api.prepareDecisionHandoff.getMockImplementation()!;
    api.prepareDecisionHandoff.mockImplementation(async (input) => ({ ...(await prepare(input)), evidence: [{ reference: input.references[0]!, status: "verified" as const, record }] }));
    const view = render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" />);
    fireEvent.click(await screen.findByRole("button", { name: "整理交接" }));
    fireEvent.change(screen.getByLabelText("当前任务目标"), { target: { value: "接手缓存改造" } });
    fireEvent.click(screen.getByRole("button", { name: "生成交接预览" }));
    await screen.findByLabelText("交接内容");
    fireEvent.click(screen.getByRole("button", { name: "记录使用反馈" }));
    fireEvent.change(screen.getByLabelText("使用时的任务"), { target: { value: "给订单服务加缓存" } });

    // Another decision indexed, and a re-read that fails: replaced by 正在核对来源… meanwhile, the feedback went.
    view.rerender(<DecisionEvidencePanel api={api} decisionId="A" revision="2" />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    api.searchDecisionContext.mockRejectedValueOnce(new Error("vault busy"));
    view.rerender(<DecisionEvidencePanel api={api} decisionId="A" revision="3" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("读取来源失败");
    expect(screen.getByLabelText("使用时的任务")).toHaveValue("给订单服务加缓存");
    expect(screen.getByLabelText("交接内容")).toBeInTheDocument();

    // Its own note changed (an outcome recorded): the preview made from it goes, the feedback stays.
    api.searchDecisionContext.mockImplementation(() => read([{ ...record, sourceRef: { ...record.sourceRef, contentHash: "e".repeat(64) } }]));
    view.rerender(<DecisionEvidencePanel api={api} decisionId="A" revision="4" />);
    await waitFor(() => expect(screen.queryByLabelText("交接内容")).toBeNull());
    expect(screen.getByLabelText("使用时的任务")).toHaveValue("给订单服务加缓存");
  });
  it("takes a handoff preview away once a re-read shows the decision superseded, its note as it was", async () => {
    const { api, record, response } = await setup({ lifecycleState: "current" });
    const prepare = api.prepareDecisionHandoff.getMockImplementation()!;
    api.prepareDecisionHandoff.mockImplementation(async (input) => ({ ...(await prepare(input)), evidence: [{ reference: input.references[0]!, status: "verified" as const, record }] }));
    const view = render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" />);
    fireEvent.click(await screen.findByRole("button", { name: "整理交接" }));
    fireEvent.change(screen.getByLabelText("当前任务目标"), { target: { value: "接手缓存改造" } });
    fireEvent.click(screen.getByRole("button", { name: "生成交接预览" }));
    await screen.findByLabelText("交接内容");

    // An agent recorded that a later decision supersedes it: kept beside the note, whose hash is unchanged.
    api.searchDecisionContext.mockImplementation(async () => response([{ ...record, lifecycleState: "superseded" }]));
    view.rerender(<DecisionEvidencePanel api={api} decisionId="A" revision="2" />);
    await screen.findByText("已被替代");
    // Kept, it still said the decision was current, ready to copy.
    await waitFor(() => expect(screen.queryByLabelText("交接内容")).toBeNull());
  });
  it("keeps a search for the other decision under way through a re-read", async () => {
    const { api, record, response } = await setup(); const other = { ...record, source: "summarize" as const, id: "B", title: "新的业务编号方案" };
    let release!: () => void; const searched = new Promise<void>((resolve) => { release = resolve; });
    api.searchDecisionContext.mockImplementation(async (query) => {
      if (query.recordId === undefined) await searched;
      return query.source === "summarize" ? response([other]) : response();
    });
    const view = render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" />);
    fireEvent.click(await screen.findByRole("button", { name: "关联另一条决策" }));
    fireEvent.change(await screen.findByLabelText("查找另一条决策"), { target: { value: "编号" } });
    fireEvent.click(screen.getByRole("button", { name: "查找决策" }));
    // Another decision indexed while it runs.
    view.rerender(<DecisionEvidencePanel api={api} decisionId="A" revision="2" />);
    await waitFor(() => expect(api.searchDecisionContext).toHaveBeenCalledTimes(4));
    release();
    expect(await screen.findByRole("button", { name: "历史沉淀 · 新的业务编号方案" })).toBeInTheDocument();
  });
  it("ignores a late source response from a previously selected decision", async () => {
    const { api, record, response } = await setup(); let resolve!: (result: DecisionContextResponse) => void;
    api.searchDecisionContext.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const view = render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" />);
    api.searchDecisionContext.mockResolvedValue(response([{ ...record, id: "B", lifecycleState: "superseded" }]));
    view.rerender(<DecisionEvidencePanel api={api} decisionId="B" revision="1" />);
    await screen.findByText("已被替代"); resolve(response());
    await waitFor(() => expect(screen.getByText("已被替代")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "打开原文" }));
    await waitFor(() => expect(api.openDecisionSource).toHaveBeenCalledWith(expect.objectContaining({ recordId: "B" })));
  });
});
