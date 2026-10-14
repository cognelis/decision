// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { DecisionApi } from "../src/shared/renderer-api.js";
import { ModelProviderPanel } from "../src/renderer/components/ModelProviderPanel.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

type Statuses = Awaited<ReturnType<DecisionApi["listLocalModelClientStatuses"]>>;

it("keeps the candidates 刷新模型候选 read when the slower read from opening the page lands after it", async () => {
  const { api } = apiFixture(rationaleSnapshot({ current: null }));
  vi.mocked(api.listModelProviderProfiles).mockResolvedValue([
    { version: 1, profileId: "builtin-claude-code", kind: "claude-code-cli", label: "Claude Code CLI", enabled: false, priority: 30, timeoutMs: 30_000, credentialConfigured: false },
  ]);
  const client = { kind: "claude-code-cli" as const, executablePath: "/opt/homebrew/bin/claude", version: "2.1.220", authenticated: true, supported: true, availability: "available" as const, checkedAt: "2026-07-30T00:00:00.000Z" };
  let finishOpening: ((value: Statuses) => void) | undefined;
  vi.mocked(api.listLocalModelClientStatuses)
    .mockReturnValueOnce(new Promise<Statuses>((resolve) => { finishOpening = resolve; }))
    .mockResolvedValue([{ ...client, modelsSource: "server", models: [{ id: "claude-opus-test", label: "Opus" }] }]);
  const user = userEvent.setup();
  render(<ModelProviderPanel api={api} />);
  const panel = await screen.findByRole("region", { name: "模型后端" });
  await user.click(await within(panel).findByRole("button", { name: "配置 Claude Code CLI" }));
  const dialog = within(screen.getByRole("dialog", { name: "配置 Claude Code CLI" }));
  await user.click(dialog.getByRole("button", { name: "刷新模型候选" }));
  expect(await dialog.findByText(/候选来源：服务端直查/u)).toBeVisible();
  const candidates = () => document.getElementById(dialog.getByLabelText("客户端模型").getAttribute("list")!)?.querySelector("option");
  expect(candidates()).toHaveAttribute("value", "claude-opus-test");

  // The read from opening the page, its server query failed back then, comes back only now: it emptied the list.
  await act(async () => { finishOpening!([client]); await Promise.resolve(); });
  expect(dialog.getByText(/候选来源：服务端直查/u)).toBeVisible();
  expect(candidates()).toHaveAttribute("value", "claude-opus-test");
});
