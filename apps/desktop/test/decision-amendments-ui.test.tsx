// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { decisionContextQuerySchema, decisionContextResponseSchema, decisionContextResultSchema, decisionScopeSchema, type AmendmentState } from "@cognelis/decision-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { DecisionEvidencePanel } from "../src/renderer/components/pages/decisions/DecisionEvidencePanel.js";
import { DecisionLibraryPanel } from "../src/renderer/components/pages/decisions/DecisionLibraryPanel.js";
import { createEvidencePreviewApi } from "../src/renderer/evidence-preview-api.js";
import type { AmendmentRecordView, DecisionEvidenceApi } from "../src/shared/renderer-api.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);
const HASH = "a".repeat(64);
const state = (over: Partial<AmendmentState> = {}): AmendmentState => ({
  revision: 2, relativePath: "Decision Journal/decision-amendments/x.md", withdrawn: null,
  amendments: [{ n: 1, at: "2026-11-11T10:31:00", client: "Codex", text: "回退时要在日志里写明原模型和回退原因。", basis: "user_said", reason: null }],
  revised: { fields: ["appliesWhen"], values: { appliesWhen: "本地模型输出被截断、或流式中断超过 30 秒时。" }, at: "2026-11-11T10:28:00", client: "Codex", reason: "你说中断也要按截断处理", stale: false },
  history: [{ revision: 1, at: "2026-11-11T10:28:00", client: "Codex", action: "revise", reason: "你说中断也要按截断处理", before: { appliesWhen: "本地模型输出被截断时。" }, basis: "user_said" }],
  ...over,
});

it("marks a decision row an agent rewrote or added to, without a second line", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
  const row = (id: string, question: string) => ({ id, created: "2026-07-30T00:00:00.000Z", sourceClient: "codex", project: "test", question, selectedAnswer: "合成选择", rationaleStatus: "captured" as const, rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliesPrincipleIds: [], appliedPrinciples: [], appliedPrincipleIds: [] });
  vi.mocked(api.listDecisions).mockImplementation(async () => [row("D-1", "改写过的决策"), row("D-2", "没动过的决策")] as never);
  vi.mocked(api.listDecisionAmendments).mockResolvedValue({ unavailable: false, records: [{ source: "decisions", recordId: "D-1", contentHash: HASH, state: state() }] });
  render(<DecisionLibraryPanel api={api} totalDecisions={2} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);
  const rewritten = (await screen.findByText("改写过的决策")).closest("li")!;
  await waitFor(() => expect(within(rewritten).getByText("已改写")).toBeVisible());
  expect(within(rewritten).getByText("+1")).toBeVisible();
  expect(within(screen.getByText("没动过的决策").closest("li")!).queryByText("已改写")).toBeNull();
});

it("shows a row's question and choice as a rewrite in force has them", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
  const row = { id: "D-1", created: "2026-07-30T00:00:00.000Z", sourceClient: "codex", project: "test", question: "旧问题", selectedAnswer: "旧选择", rationaleStatus: "captured" as const, rationale: null, context: null, outcome: null, outcomeReview: null, reviewDueDate: null, appliesPrincipleIds: [], appliedPrinciples: [], appliedPrincipleIds: [] };
  vi.mocked(api.listDecisions).mockImplementation(async () => [row] as never);
  const revised = state({ revised: { ...state().revised!, fields: ["question", "choice"], values: { question: "新问题", choice: "新选择" } } });
  vi.mocked(api.listDecisionAmendments).mockResolvedValue({ unavailable: false, records: [{ source: "decisions", recordId: "D-1", contentHash: HASH, state: revised }] });
  render(<DecisionLibraryPanel api={api} totalDecisions={1} onOpenPrinciple={vi.fn()} onDistillDecision={vi.fn()} onRecorded={vi.fn()} />);
  const item = (await screen.findByText("新问题")).closest("li")!;
  expect(within(item).getByText(/新选择/u)).toBeVisible();
  expect(screen.queryByText("旧问题")).toBeNull();
});

const evidence = async (record: AmendmentRecordView | null, over: Partial<DecisionEvidenceApi> = {}) => {
  const preview = createEvidencePreviewApi();
  const found = decisionContextResultSchema.parse({ ...(await preview.searchDecisionContext(decisionContextQuerySchema.parse({ recordId: "A" }))).results[0], appliesWhen: "本地模型输出被截断时。", caution: null, applicability: { status: "needs_review", reasons: [], scope: decisionScopeSchema.parse({}) } });
  const response = decisionContextResponseSchema.parse({ contextVersion: 1, status: "matched", coverage: "complete", sources: [{ source: "decisions", status: "ready", records: 1, skipped: 0 }], results: [found], total: 1, nextOffset: null, guidance: "", boundary: { advisoryOnly: true, noDecisionWritten: true, noPrincipleApplied: true } });
  const api = {
    ...preview,
    searchDecisionContext: vi.fn(async () => response),
    listDecisionAmendments: vi.fn(async () => ({ records: record === null ? [] : [record], unavailable: false })),
    updateDecisionAmendment: vi.fn(async () => ({ amendVersion: 1 as const, status: "saved" as const, revision: 3, relativePath: "x.md", originalUnchanged: true as const })),
    ...over,
  } as unknown as DecisionEvidenceApi & { updateDecisionAmendment: ReturnType<typeof vi.fn> };
  render(<DecisionEvidencePanel api={api} decisionId="A" revision="1" />);
  await screen.findByRole("button", { name: "打开原文" });
  return api;
};

it("shows what an agent rewrote and added to a decision, its history with before and after, and says the choice is untouched", async () => {
  await evidence({ source: "decisions", recordId: "A", contentHash: HASH, state: state() });
  const block = within(await screen.findByRole("region", { name: "补充与修订" }));
  expect(block.getByText(/已被 Codex 改写 · 11 月 11 日/u)).toBeVisible();
  expect(block.getByText("本地模型输出被截断时。", { selector: "del" })).toBeVisible();
  expect(block.getByText("本地模型输出被截断、或流式中断超过 30 秒时。", { selector: "ins" })).toBeVisible();
  expect(block.getByRole("group", { name: "补充（来自之后的会话）" })).toHaveTextContent("回退时要在日志里写明原模型和回退原因。");
  expect(block.getByText(/决策的原笔记不会被改写/u)).toBeVisible();
});

it("goes back to before a rewrite only after asking, as the reader and against the note's hash", async () => {
  const api = await evidence({ source: "decisions", recordId: "A", contentHash: HASH, state: state() });
  const block = within(await screen.findByRole("region", { name: "补充与修订" }));
  await userEvent.click(block.getByRole("button", { name: "恢复为这一版之前" }));
  expect(api.updateDecisionAmendment).not.toHaveBeenCalled();
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "恢复" }));
  await waitFor(() => expect(api.updateDecisionAmendment).toHaveBeenCalledWith(expect.objectContaining({
    action: "revert", toRevision: 1, source: "decisions", recordId: "A", sourceClient: "我", expectedContentHash: HASH, expectedRevision: 2,
  })));
});

it("says a restore from a long text is cut here and uses the whole at the main process", async () => {
  const cut = state({ history: [{ ...state().history[0]!, beforeTruncated: true }] });
  await evidence({ source: "decisions", recordId: "A", contentHash: HASH, state: cut });
  const block = within(await screen.findByRole("region", { name: "补充与修订" }));
  await userEvent.click(block.getByRole("button", { name: "恢复为这一版之前" }));
  expect(within(await screen.findByRole("dialog")).getByText("…（已截断，恢复会用完整原文）")).toBeVisible();
});

it("says a stale edit is stale, and applies it to the new original only after the reader confirms", async () => {
  const stale = state({ revised: { ...state().revised!, stale: true } });
  const api = await evidence({ source: "decisions", recordId: "A", contentHash: HASH, state: stale });
  const block = within(await screen.findByRole("region", { name: "补充与修订" }));
  expect(block.getByText(/修改已失效（原笔记已变化）/u)).toBeVisible();
  await userEvent.click(block.getByRole("button", { name: "按新原文重新应用" }));
  expect(api.updateDecisionAmendment).not.toHaveBeenCalled();
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "重新应用" }));
  await waitFor(() => expect(api.updateDecisionAmendment).toHaveBeenCalledWith(expect.objectContaining({
    action: "revise", source: "decisions", recordId: "A", sourceClient: "我", basis: "user_said", expectedContentHash: HASH, expectedRevision: 2,
    fields: { appliesWhen: "本地模型输出被截断、或流式中断超过 30 秒时。" },
  })));
});

it("says a conflict and reads again, and shows nothing extra for a decision no agent touched", async () => {
  const api = await evidence({ source: "decisions", recordId: "A", contentHash: HASH, state: state() }, {
    updateDecisionAmendment: vi.fn(async () => ({ amendVersion: 1 as const, status: "source_changed" as const, revision: 2, relativePath: "x.md", originalUnchanged: true as const })),
  });
  const block = within(await screen.findByRole("region", { name: "补充与修订" }));
  await userEvent.click(block.getByRole("button", { name: "恢复为这一版之前" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "恢复" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("原决策在你打开之后改过");
  await waitFor(() => expect(vi.mocked(api.listDecisionAmendments).mock.calls.length).toBeGreaterThan(1));
  cleanup();
  await evidence(null);
  expect(screen.queryByRole("region", { name: "补充与修订" })).toBeNull();
  void fireEvent;
});

it("names the client, not its id, in a decision's tag and history", async () => {
  const byId = state({ revised: { ...state().revised!, client: "claude-code" }, amendments: [{ ...state().amendments[0]!, client: "codex" }], history: state().history.map((item) => ({ ...item, client: "claude-code" })) });
  await evidence({ source: "decisions", recordId: "A", contentHash: HASH, state: byId });
  const block = within(await screen.findByRole("region", { name: "补充与修订" }));
  expect(block.getByText(/已被 Claude Code 改写/u)).toBeVisible();
  expect(block.getByText("Codex")).toBeVisible();
  expect(document.body.textContent).not.toMatch(/claude-code|codex/u);
});
