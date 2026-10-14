// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { App } from "../src/renderer/App.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

/*
 * A dialog holding what the reader typed is not closed by Escape, as the rationale and review dialogs already were:
 * one Escape (to dismiss a password manager's popup, say) threw away an address, a model and an API key.
 */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("keeps a model backend being added open on Escape once something is typed, and lets 取消 let it go", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "models" }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([]);
  const user = userEvent.setup();
  render(<App api={api} />);
  const panel = await screen.findByRole("region", { name: "模型后端" });

  // Nothing typed: Escape closes it as before.
  await user.click(within(panel).getByRole("button", { name: "添加模型后端" }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "添加模型后端" })).toBeNull();

  await user.click(within(panel).getByRole("button", { name: "添加模型后端" }));
  const dialog = within(screen.getByRole("dialog", { name: "添加模型后端" }));
  await user.selectOptions(dialog.getByLabelText("后端类型"), "openai-compatible");
  await user.type(dialog.getByLabelText("服务地址"), "https://llm.example.com/v1");
  await user.type(dialog.getByLabelText("API 密钥"), "sk-private");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "添加模型后端" })).toBeInTheDocument();
  expect(dialog.getByLabelText("API 密钥")).toHaveValue("sk-private");

  await user.click(dialog.getByRole("button", { name: "取消添加" }));
  expect(screen.queryByRole("dialog", { name: "添加模型后端" })).toBeNull();
});

it("keeps a code platform link being added open on Escape once its token is typed", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null, primarySurface: "connections" }));
  vi.mocked(api.listPrConnections).mockResolvedValue([]);
  const user = userEvent.setup();
  render(<App api={api} />);

  await user.click(await screen.findByRole("button", { name: "新增链接" }));
  const dialog = within(screen.getByRole("dialog", { name: "新增链接" }));
  await user.type(dialog.getByLabelText("访问令牌"), "glpat-private");
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "新增链接" })).toBeInTheDocument();
  expect(dialog.getByLabelText("访问令牌")).toHaveValue("glpat-private");
});
