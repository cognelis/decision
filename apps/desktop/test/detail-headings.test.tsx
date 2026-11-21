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

it("titles a decision's detail with its question as plain text, gives a long one whole, and keeps 删除决策 in the footer, held while editing", async () => {
  const question = "进展同步一下：\n- **已完成**：页头改版\n\n先做 **A 组** 还是设置四页？";
  const decision = {
    id: "decision-long", created: "2026-07-30T03:04:00.000Z", sourceClient: "codex", project: "decision",
    question, selectedAnswer: "先做 A 组", rationaleStatus: "captured" as const, rationale: "用得最多。", context: null,
    outcome: null, outcomeReview: null, reviewDueDate: null, appliedPrincipleIds: [], appliedPrinciples: [],
  };
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "decisions" }));
  vi.mocked(api.listDecisions).mockResolvedValue([decision as never]);
  await renderDecisionLibrary(api);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: /进展同步一下/u }));
  const dialog = await screen.findByRole("dialog", { name: "决策详情" });
  const detail = within(dialog);

  // The title is the question without its Markdown marks; the question as written, lists and all, is in the body.
  expect(detail.getByRole("heading", { level: 3 })).toHaveTextContent("进展同步一下：已完成：页头改版 先做 A 组 还是设置四页？");
  const whole = detail.getByRole("region", { name: "问题" });
  expect(within(whole).getByRole("listitem")).toHaveTextContent("已完成：页头改版");
  expect(within(whole).getByText("A 组", { selector: "strong" })).toBeVisible();

  // Deleting is apart from the record, in the footer; while something is written it waits, and says why.
  const remove = detail.getByRole("button", { name: "删除决策" });
  expect(remove.closest("footer")).not.toBeNull();
  await user.click(detail.getByRole("button", { name: "记录结果" }));
  expect(remove).toBeDisabled();
  expect(detail.getByText(/正在编辑「实际结果」/u)).toBeVisible();
  await user.click(detail.getByRole("button", { name: "取消" }));
  expect(remove).toBeEnabled();
});
