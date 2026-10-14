// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { recordFixture } from "../../../packages/storage/test/fixtures.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";
import { LocalDecisionList } from "../src/renderer/components/pages/decisions/LocalDecisionList.js";
import { DashboardPendingRationales } from "../src/renderer/components/DashboardPendingRationales.js";

afterEach(cleanup);

it("requires confirmation, preserves remaining selections after failure and never repeats resolved items", async () => {
  const { api } = apiFixture(rationaleSnapshot());
  let records = [recordFixture(), recordFixture({ id: "second-local", question: "业务功能选择" })];
  vi.mocked(api.listLocalDecisions).mockImplementation(async () => ({ records, total: records.length }));
  let fail = true;
  vi.mocked(api.resolveLocalDecision).mockImplementation(async (id) => {
    if (id === "second-local" && fail) { fail = false; throw new Error("Obsidian unavailable"); }
    records = records.filter(record => record.id !== id);
  });
  const user = userEvent.setup();
  render(<LocalDecisionList api={api} />);
  await user.click(await screen.findByRole("checkbox", { name: "选择 Markdown 还是数据库？" }));
  await user.click(screen.getByRole("checkbox", { name: "选择 业务功能选择" }));
  await user.click(screen.getByRole("button", { name: "记录到知识库" }));
  expect(api.resolveLocalDecision).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认记录到知识库" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("已处理 1 条");
  await waitFor(() => expect(screen.getByRole("button", { name: "确认记录到知识库" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "确认记录到知识库" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(vi.mocked(api.resolveLocalDecision).mock.calls).toEqual([["018f-example-decision", "publish"], ["second-local", "publish"], ["second-local", "publish"]]);
});

it("searches and paginates local records, and discards only after confirmation", async () => {
  const { api } = apiFixture(rationaleSnapshot());
  vi.mocked(api.listLocalDecisions).mockImplementation(async (_query, offset) => ({ records: [recordFixture({ id: String(offset) })], total: 101 }));
  const user = userEvent.setup();
  render(<LocalDecisionList api={api} />);
  await user.click(await screen.findByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "不保留" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(api.resolveLocalDecision).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "不保留" }));
  await user.click(screen.getByRole("button", { name: "确认不保留" }));
  expect(api.resolveLocalDecision).toHaveBeenCalledWith("0", "discard");
  await waitFor(() => expect(screen.getByRole("button", { name: "下一页" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() => expect(api.listLocalDecisions).toHaveBeenLastCalledWith("", 100));
  await user.type(screen.getByRole("searchbox", { name: "搜索本机记录" }), "业务");
  await waitFor(() => expect(api.listLocalDecisions).toHaveBeenLastCalledWith("业务", 0));
});

it("keeps a continuous draft locally, preserves it after failure and advances after retry", async () => {
  const onKeepLocal = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  const items = ["第一条", "第二条"].map((question, index) => ({ id: String(index), question, created: "2026-10-11T00:00:00.000Z", selectedAnswer: "业务选择", project: "app", sourceClient: "codex", contextSummary: null, capturedQuestion: null, inVault: false as const }));
  const onComplete = vi.fn(), onDiscard = vi.fn();
  const user = userEvent.setup();
  render(<DashboardPendingRationales decisions={items} onKeepLocal={onKeepLocal} onComplete={onComplete} onDiscard={onDiscard} onSkip={vi.fn()} listDecisions={async () => []} />);
  await user.click(screen.getByRole("button", { name: "连续补充" }));
  await user.type(screen.getByRole("textbox"), "只在当前项目有效");
  const group = within(screen.getByRole("group", { name: "处理当前决策" }));
  await user.click(group.getByRole("button", { name: "仅本机保留" }));
  expect(screen.getByRole("alert")).toHaveTextContent("disk full");
  expect(screen.getByRole("textbox")).toHaveValue("只在当前项目有效");
  await user.click(group.getByRole("button", { name: "仅本机保留" }));
  expect(onKeepLocal).toHaveBeenLastCalledWith("0", { rationale: "只在当前项目有效" });
  expect(screen.getByRole("textbox", { description: "第二条" })).toHaveValue("");
  expect(onComplete).not.toHaveBeenCalled();
  expect(onDiscard).not.toHaveBeenCalled();
});
