// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { PrReviewProgress, PrReviewReport, PrReviewSnapshot } from "@cognelis/decision-protocol";
import { reviewMarkdown } from "../src/renderer/components/pages/pr-review/PrReviewPanel.js";
import { renderMarkdown } from "../src/renderer/components/pages/assistant/markdown.js";

afterEach(cleanup);

const snapshot: PrReviewSnapshot = {
  snapshotId: "00000000-0000-4000-8000-0000000000a1", reference: "acme/app#12", title: "修复登录", description: "", project: "app",
  sourceCommit: "a".repeat(40), destinationCommit: "b".repeat(40), files: [{ path: "src/login.ts", status: "modified" }], warnings: [],
};

// A model call refused for its shape: pr-review-service's failureDetail() puts the raw output under "模型原始输出：" and
// clips the whole detail at 4,000 characters. A model that wrapped its JSON in a ```json fence and ran long is cut
// before the closing fence.
const rawOutput = "```json\n" + JSON.stringify({ actions: [{ action: "finish_review", summary: "登录流程的说明。".repeat(400), findings: [] }] }, null, 2);
const failed: PrReviewProgress = {
  runId: "00000000-0000-4000-8000-0000000000b1", id: "model-3", at: "2026-10-05T02:30:00.000Z", kind: "model", status: "error",
  message: "第 3 次调用模型失败", detail: `错误类别：invalid_output\n\n模型原始输出：\n${rawOutput}`.slice(0, 4_000),
};
const done: PrReviewProgress = { runId: failed.runId, id: "status-end", at: "2026-10-05T02:31:00.000Z", kind: "status", status: "done", message: "评审结束" };

const report: PrReviewReport = {
  status: "failed", summary: "模型调用失败，没有形成结论。", findings: [], readFiles: [], unreadFiles: ["src/login.ts"],
  reviewedFiles: [], unreviewedFiles: ["src/login.ts"], warnings: [], steps: 3, history: [failed, done],
  evidence: [{ index: 1, record: {
    source: "decisions", kind: "recorded_decision", id: "DEC-7", title: "登录失败统一返回 401", summary: "登录失败一律返回 401，不区分用户不存在与密码错误。",
    sourceRef: { relativePath: "决策/DEC-7.md", contentHash: "c".repeat(64), excerpt: "登录失败一律返回 401。" },
    current: true, lifecycleState: "active", warnings: [], relations: [], scopeRevision: 1,
  } as never }],
};

it("keeps the sections after a step's raw model output as sections when the output has an unclosed code fence", () => {
  const markdown = reviewMarkdown(snapshot, report);
  // The process section carries the step's detail as written.
  expect(markdown).toContain("模型原始输出：\n```json");
  render(<div>{renderMarkdown(markdown)}</div>);
  // The evidence section and the closing note follow the process section; both must still be readable as such.
  expect(screen.getByRole("heading", { name: "决策证据" })).toBeInTheDocument();
  expect(screen.getByText(/本报告由 AI 评审生成/).closest("pre")).toBeNull();
});
