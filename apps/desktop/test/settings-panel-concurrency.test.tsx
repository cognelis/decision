// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPanel } from "../src/renderer/components/pages/settings/SettingsPanel.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

it("keeps unrelated settings usable while an index rebuild and preference saves finish independently", async () => {
  const snapshot = rationaleSnapshot({ current: null });
  const { api } = apiFixture(snapshot);
  let finishTheme!: () => void;
  let failReminder!: (error: Error) => void;
  let finishIndex!: (value: Awaited<ReturnType<typeof api.rebuildIndex>>) => void;
  vi.mocked(api.setTheme).mockReturnValueOnce(new Promise((resolve) => { finishTheme = resolve; }));
  vi.mocked(api.setReviewRemindersEnabled).mockReturnValueOnce(new Promise((_resolve, reject) => { failReminder = reject; }));
  vi.mocked(api.rebuildIndex).mockReturnValueOnce(new Promise((resolve) => { finishIndex = resolve; }));
  const user = userEvent.setup();
  render(<SettingsPanel snapshot={snapshot} api={api} />);
  const rebuild = screen.getByRole("button", { name: "重建决策索引" });
  const theme = screen.getByRole("button", { name: "浅色" });
  const reminder = screen.getByRole("switch", { name: "复盘提醒" });
  await user.dblClick(rebuild);
  expect(api.rebuildIndex).toHaveBeenCalledTimes(1);
  expect(rebuild).toBeDisabled();
  expect(theme).toBeEnabled();
  expect(screen.getByRole("button", { name: "更换仓库" })).toBeEnabled();
  await user.click(theme);
  expect(theme).toBeDisabled();
  expect(within(screen.getByRole("group", { name: "主题色" })).getByRole("button", { name: "蓝" })).toBeEnabled();
  await user.click(reminder);
  expect(reminder).toBeDisabled();
  expect(screen.getByRole("switch", { name: "本地密钥模式" })).toBeEnabled();
  await act(async () => { finishTheme(); });
  expect(theme).toBeEnabled();
  expect(reminder).toBeDisabled();
  expect(rebuild).toBeDisabled();
  await act(async () => { failReminder(new Error("提醒设置未写入")); });
  expect(reminder).toBeEnabled();
  expect(screen.getByText("提醒设置未写入")).toBeVisible();
  await act(async () => { finishIndex({ indexedCount: 3, diagnostics: [] }); });
  expect(rebuild).toBeEnabled();
  expect(screen.getByText("主题已更新。")).toBeVisible();
  expect(screen.getByText("提醒设置未写入")).toBeVisible();
  expect(screen.getByText("已从 Markdown 重建决策索引，共 3 条。")).toBeVisible();
});
