// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionContextQuerySchema, decisionFeedbackQuerySchema, decisionFeedbackRecordSchema, type DecisionFeedbackUpdate } from "@cognelis/decision-protocol";
import { createEvidencePreviewApi } from "../src/renderer/evidence-preview-api.js";
import { DecisionFeedbackPanel } from "../src/renderer/components/pages/decisions/DecisionFeedbackPanel.js";
afterEach(cleanup);
const setup = async () => {
  const preview = createEvidencePreviewApi(); const empty = await preview.getDecisionContextFeedback(decisionFeedbackQuerySchema.parse({}));
  const record = (await preview.searchDecisionContext(decisionContextQuerySchema.parse({ recordId: "A" }))).results[0]!;
  const api = { getDecisionContextFeedback: vi.fn(async () => empty), saveDecisionContextFeedback: vi.fn(async (input: DecisionFeedbackUpdate) => ({ status: "saved" as const, feedbackId: input.feedbackId, revision: 1, noDecisionChanged: true as const })) };
  render(<DecisionFeedbackPanel api={api} record={record} />); fireEvent.click(screen.getByText("使用反馈")); await screen.findByText("还没有记录使用反馈。");
  return { api, empty, record };
};
describe("desktop usage feedback", () => {
  it("lets go of a failed read once a later read of the same record lands", async () => {
    const preview = createEvidencePreviewApi(); const empty = await preview.getDecisionContextFeedback(decisionFeedbackQuerySchema.parse({}));
    const record = (await preview.searchDecisionContext(decisionContextQuerySchema.parse({ recordId: "A" }))).results[0]!;
    const api = { getDecisionContextFeedback: vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(empty), saveDecisionContextFeedback: vi.fn() };
    const { rerender } = render(<DecisionFeedbackPanel api={api} record={record} />);
    fireEvent.click(screen.getByText("使用反馈"));
    expect(await screen.findByRole("alert")).toHaveTextContent("反馈读取失败");
    // Its note changed (an agent's edit), the panel reads again, and it works: "do not take this as no feedback"
    // stood beside the list just read.
    rerender(<DecisionFeedbackPanel api={api} record={{ ...record, sourceRef: { ...record.sourceRef, contentHash: "d".repeat(64) } }} />);
    await screen.findByText("还没有记录使用反馈。");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("requires a selected judgment and retains the same feedback ID after an uncertain save", async () => {
    const { api } = await setup(); api.saveDecisionContextFeedback.mockRejectedValueOnce(new Error("lost response"));
    fireEvent.click(screen.getByRole("button", { name: "记录使用反馈" }));
    fireEvent.change(screen.getByLabelText("使用时的任务"), { target: { value: "迁移列表编号" } });
    fireEvent.change(screen.getByLabelText("观察与理由"), { target: { value: "缺少适用例外" } });
    expect(screen.getByRole("button", { name: "保存使用反馈" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("本次使用评价"), { target: { value: "insufficient_context" } });
    fireEvent.click(screen.getByRole("button", { name: "保存使用反馈" })); await screen.findByRole("alert");
    const first = api.saveDecisionContextFeedback.mock.calls[0]![0];
    expect(screen.getByLabelText("使用时的任务")).toHaveValue("迁移列表编号");
    fireEvent.click(screen.getByRole("button", { name: "保存使用反馈" }));
    await waitFor(() => expect(api.saveDecisionContextFeedback).toHaveBeenCalledTimes(2));
    expect(api.saveDecisionContextFeedback.mock.calls[1]![0]).toEqual(first);
    await screen.findByText("使用反馈已保存，未改变决策或适用范围。");
  });
  it("withdraws feedback for a missing source using stored task and version fields", async () => {
    const { api, empty } = await setup();
    const stored = decisionFeedbackRecordSchema.parse({ feedbackVersion: 1, feedbackId: crypto.randomUUID(), revision: 3, updatedAt: "2026-09-11T10:00:00Z", reference: { source: "decisions", recordId: "A", expectedContentHash: "c".repeat(64) }, task: "先前的使用任务", project: "original", taskScope: { layer: "backend" }, rating: "helpful", reason: "当时有帮助", history: [] });
    api.getDecisionContextFeedback.mockResolvedValue({ ...empty, total: 1, activeCount: 1, results: [{ record: stored, sourceState: "missing", relativePath: "Decision Journal/decision-feedback/test.md" }] });
    fireEvent.click(screen.getByRole("button", { name: "重新读取反馈" })); await screen.findByText("先前的使用任务");
    expect(screen.getByRole("button", { name: "更正反馈" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "撤回反馈" }));
    expect(screen.getByLabelText("使用时的任务")).toHaveAttribute("readonly");
    fireEvent.change(screen.getByLabelText("撤回理由"), { target: { value: "撤回此前判断" } });
    fireEvent.click(screen.getByRole("button", { name: "确认撤回反馈" }));
    await waitFor(() => expect(api.saveDecisionContextFeedback).toHaveBeenCalledWith(expect.objectContaining({ feedbackId: stored.feedbackId, expectedRevision: 3, reference: stored.reference, task: stored.task, project: stored.project, taskScope: stored.taskScope, rating: "helpful", withdrawn: true, reason: "撤回此前判断" })));
  });
});
