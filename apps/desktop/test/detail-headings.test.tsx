// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App.js";
import {
  acceptedMethodologyFixture,
  apiFixture,
  rationaleSnapshot,
  renderDecisionLibrary,
} from "./app-fixtures.js";

/* A record's sections are titled as headings: shown as titles, they were plain text a screen reader could not jump by. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("titles the sections of a decision's detail as headings under its question", async () => {
  const decision = {
    id: "decision-1", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision",
    question: "缓存层放在哪一侧？", selectedAnswer: "先放在读取端", rationaleStatus: "captured" as const,
    rationale: "可回退。", context: null, expectedOutcome: "读取延迟降低", outcome: "延迟降低 30%",
    outcomeReview: { verdict: "as_expected" as const, lesson: "先验证读取端", reviewedAt: "2026-08-01T03:04:00.000Z" },
    reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
  };
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
  vi.mocked(api.listDecisions).mockResolvedValue([decision as never]);
  await renderDecisionLibrary(api);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: new RegExp(decision.question, "u") }));
  const detail = within(await screen.findByRole("dialog", { name: "决策详情" }));

  for (const section of ["决策理由", "预期结果", "实际结果", "预期 / 实际复盘", "采用的方法论"]) {
    expect(detail.getByRole("heading", { level: 4, name: section })).toBeVisible();
  }
  expect(detail.getByRole("heading", { level: 3, name: decision.question })).toBeVisible();
});

it("titles the sections of a principle's detail as headings", async () => {
  const principle = acceptedMethodologyFixture({ id: "principle-1", title: "先验证边界再扩大投入" });
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "methodology" }));
  vi.mocked(api.listMethodologies).mockResolvedValue([principle]);
  const user = userEvent.setup();
  render(<App api={api} />);

  const page = await screen.findByRole("region", { name: "方法论" });
  await user.click(await within(page).findByText(principle.title));
  const detail = within(await screen.findByRole("dialog", { name: "方法论详情" }));
  for (const section of ["适用条件", "注意事项", "证据摘要", "实际采用", "质量检查"]) {
    expect(detail.getByRole("heading", { level: 4, name: section })).toBeVisible();
  }
});
