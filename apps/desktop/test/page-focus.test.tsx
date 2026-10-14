// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

/*
 * Where focus goes when the control that had it leaves with its page: a jump from the home page, a first-run step,
 * a settings section. Left on the document itself, Tab started over at the top of the window and a screen reader
 * said nothing of where the reader had arrived.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const decision = {
  id: "decision-1",
  created: "2026-09-30T03:04:00.000Z",
  sourceClient: "codex",
  project: "decision",
  question: "缓存层放在哪一侧？",
  selectedAnswer: "先放在读取端",
  rationaleStatus: "captured" as const,
  rationale: "可回退。",
  context: null,
  outcome: null,
  outcomeReview: null,
  reviewDueDate: null,
  appliedPrincipleIds: [],
  appliedPrinciples: [],
};
const on = (primarySurface: "dashboard" | "decisions" | "clients" | "settings", firstRun = false) =>
  rationaleSnapshot({
    current: null,
    primarySurface,
    dashboard: firstRun
      ? { totalDecisions: 0, recorded7d: 0, reviewAttention: 0, recentDecisions: [] }
      : {
          totalDecisions: 1,
          recorded7d: 1,
          reviewAttention: 0,
          recentDecisions: [{ id: decision.id, question: decision.question, selectedAnswer: decision.selectedAnswer, project: decision.project, sourceClient: "codex", created: decision.created, rationaleStatus: "captured" }] as never,
        },
  });

it("gives the knowledge page's title focus when a record opened from the home page is closed", async () => {
  const { api, emit } = apiFixture(on("dashboard"));
  vi.mocked(api.listDecisions).mockResolvedValue([decision as never]);
  const user = userEvent.setup();
  render(<App api={api} />);

  const recent = await screen.findByRole("list", { name: "已记录的最近决策" });
  within(recent).getByRole("button", { name: new RegExp(decision.question, "u") }).focus();
  await user.keyboard("{Enter}");
  act(() => emit(on("decisions")));

  const detail = await screen.findByRole("dialog", { name: "决策详情" });
  await waitFor(() => expect(detail).toContainElement(document.activeElement as HTMLElement));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "决策详情" })).toBeNull());
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "知识" })).toContainElement(document.activeElement as HTMLElement),
  );
  expect(document.activeElement).toHaveRole("heading");
});

it("gives a page reached from a first-run step, or another settings section, its title's focus", async () => {
  const { api, emit } = apiFixture(on("dashboard", true));
  const user = userEvent.setup();
  render(<App api={api} />);

  within(await screen.findByRole("list", { name: "开始使用的步骤" })).getByRole("button", { name: "前往接入" }).focus();
  await user.keyboard("{Enter}");
  act(() => emit(on("clients", true)));
  expect(await screen.findByRole("heading", { level: 1, name: "接入" })).toHaveFocus();

  within(screen.getByRole("navigation", { name: "设置分区" })).getByRole("button", { name: "通用" }).focus();
  await user.keyboard("{Enter}");
  act(() => emit(on("settings", true)));
  expect(await screen.findByRole("heading", { level: 1, name: "通用设置" })).toHaveFocus();
});

it("leaves focus on the sidebar when the page is chosen there", async () => {
  const { api, emit } = apiFixture(on("dashboard"));
  const user = userEvent.setup();
  render(<App api={api} />);

  const knowledge = within(await screen.findByRole("navigation", { name: "主导航" })).getByRole("button", { name: "知识" });
  knowledge.focus();
  await user.keyboard("{Enter}");
  act(() => emit(on("decisions")));
  await screen.findByRole("region", { name: "知识" });
  expect(knowledge).toHaveFocus();
});
