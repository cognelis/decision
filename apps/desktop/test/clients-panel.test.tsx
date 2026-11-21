// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionApi } from "../src/shared/renderer-api.js";
import { ClientsPanel } from "../src/renderer/components/pages/clients/ClientsPanel.js";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { START_ONBOARDING_EVENT } from "../src/renderer/onboarding-navigation.js";

const harness = async (overrides: Partial<DecisionApi> = {}) => {
  const preview = createPreviewApi();
  const snapshot = await preview.getSnapshot();
  const api: DecisionApi = { ...preview, ...overrides };
  render(<ClientsPanel snapshot={snapshot} api={api} />);
  return { api, snapshot };
};

afterEach(cleanup);

describe("ClientsPanel", () => {
  it("connects clients independently while read-only checks stay available and batch writes wait", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    type Report = Awaited<ReturnType<DecisionApi["installIntegrations"]>>;
    let finishClaude!: (report: Report) => void;
    let failCodex!: (error: Error) => void;
    const install = vi.fn<DecisionApi["installIntegrations"]>()
      .mockReturnValueOnce(new Promise((resolve) => { finishClaude = resolve; }))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { failCodex = reject; }))
      .mockResolvedValue({ mode: "dry-run", targets: [], commands: [], restartRequired: false });
    render(<ClientsPanel snapshot={{ ...snapshot, integrationStatus: { ...snapshot.integrationStatus, "claude-code": "not-installed", codex: "not-installed" } }} api={{ ...preview, installIntegrations: install }} />);
    const claude = screen.getByRole("button", { name: "接入 Claude Code" });
    const codex = screen.getByRole("button", { name: "接入 Codex" });
    fireEvent.click(claude);
    expect(claude).toBeDisabled();
    expect(codex).toBeEnabled();
    expect(screen.getByRole("button", { name: "全部修复" })).toBeDisabled();
    const check = screen.getByRole("button", { name: "检查连接" });
    expect(check).toBeEnabled();
    fireEvent.click(codex);
    fireEvent.click(check);
    await waitFor(() => expect(check).toBeEnabled());
    expect(install).toHaveBeenNthCalledWith(1, "apply", ["claude-code"]);
    expect(install).toHaveBeenNthCalledWith(2, "apply", ["codex"]);
    expect(install).toHaveBeenNthCalledWith(3, "dry-run", expect.any(Array));
    await act(async () => { finishClaude({ mode: "apply", targets: [{ client: "claude-code", path: "/tmp/claude-settings.json", changed: true, status: "installed" }], commands: [], restartRequired: false }); });
    expect(claude).toBeEnabled();
    expect(codex).toBeDisabled();
    expect(within(claude.closest("article")!).getByRole("status")).toHaveTextContent("Claude Code 已接入");
    await act(async () => { failCodex(new Error("Codex 配置不可写")); });
    expect(codex).toBeEnabled();
    expect(screen.getByRole("button", { name: "全部修复" })).toBeEnabled();
    expect(within(codex.closest("article")!).getByRole("status")).toHaveTextContent("Codex 配置不可写");
    expect(within(claude.closest("article")!).getByRole("status")).toHaveTextContent("Claude Code 已接入");
  });

  it("ends its list with 接入其他工具, which opens the assistant's 接入新工具 conversation", async () => {
    await harness();
    const started = vi.fn();
    window.addEventListener(START_ONBOARDING_EVENT, started);
    try {
      const list = screen.getByRole("heading", { name: "客户端" }).closest("section")!;
      const button = within(list).getByRole("button", { name: "接入其他工具" });
      // The list's last control, below the tools it names.
      const buttons = within(list).getAllByRole("button");
      expect(buttons.at(-1)).toBe(button);
      fireEvent.click(button);
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(START_ONBOARDING_EVENT, started);
    }
  });

  it("reads each client's latest decision again as decisions come in", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    let captured: Awaited<ReturnType<DecisionApi["listDecisions"]>> = [];
    const listDecisions = vi.fn<DecisionApi["listDecisions"]>(async (query) => (query.sourceClient === "claude-code" ? captured : []));
    const api: DecisionApi = { ...preview, listDecisions };
    const view = render(<ClientsPanel snapshot={snapshot} api={api} />);
    await waitFor(() => expect(listDecisions).toHaveBeenCalled());

    // Connected, then tested with one choice in Claude Code: read once, the card went on saying nothing had come in.
    const [first] = await preview.listDecisions({ query: "", limit: 1 });
    captured = [{ ...first!, question: "先用 SQLite 还是直接上 Postgres？" }];
    view.rerender(<ClientsPanel snapshot={{ ...snapshot, dashboard: { ...snapshot.dashboard, totalDecisions: snapshot.dashboard.totalDecisions + 1 } }} api={api} />);
    expect(await screen.findByText(/先用 SQLite 还是直接上 Postgres/u)).toBeVisible();
  });

  it("keeps capture clients separate from platform links", async () => {
    const listPrConnections = vi.fn(async () => []);
    await harness({ listPrConnections });
    expect(screen.getByRole("heading", { name: "Codex" })).toBeVisible();
    expect(screen.getByRole("button", { name: "链接" })).toBeVisible();
    expect(screen.queryByLabelText("访问令牌")).toBeNull();
    expect(listPrConnections).not.toHaveBeenCalled();
  });

  it("lists the connected first, then those found on this machine, the rest folded away", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    const others = snapshot.clients.length - 5;
    render(
      <ClientsPanel
        snapshot={{
          ...snapshot,
          integrationStatus: {
            ...Object.fromEntries(snapshot.clients.map((client) => [client.id, "command-missing" as const])),
            "claude-code": "installed", codex: "upgrade-required", "qwen-code": "installed", cursor: "not-installed", "my-cli": "not-installed",
          },
        }}
        api={preview}
      />,
    );
    const list = screen.getByRole("region", { name: "客户端" });
    // A client not on this machine asks nothing of the reader, nor is it counted.
    expect(list).toHaveTextContent("已连接 2 / 5 · 3 个需要处理");
    const visible = within(list).getAllByRole("article").filter((row) => row.closest("details") === null);
    expect(visible.map((row) => within(row).getByRole("heading").textContent)).toEqual(["Claude Code", "Codex", "Qwen Code", "Cursor CLI", "My CLI"]);
    const folded = list.querySelector("details")!;
    expect(folded).not.toHaveAttribute("open");
    expect(within(folded).getByText(`其他支持的工具（${others}）`)).toBeVisible();
    expect(within(folded).getByRole("article", { name: "Antigravity", hidden: true })).toHaveTextContent("没有找到 agy 命令");
    expect(within(list).getByRole("article", { name: "Codex" })).toHaveTextContent("需重新连接");
  });

  it("gives each client its own 接入 and 断开, and the reader's own only 删除", async () => {
    const installIntegrations = vi.fn<DecisionApi["installIntegrations"]>(async (mode) => ({ mode, targets: [{ client: "cursor", path: "/h/.cursor/hooks.json", changed: true, status: "installed" }], commands: [], restartRequired: true }));
    const removeIntegrations = vi.fn<DecisionApi["removeIntegrations"]>(async () => ({ mode: "apply", targets: [{ client: "qwen-code", path: "/h/.qwen/settings.json", changed: true, status: "removed" }], commands: [], restartRequired: true }));
    await harness({ installIntegrations, removeIntegrations });
    const list = screen.getByRole("region", { name: "客户端" });

    const cursor = within(list).getByRole("article", { name: "Cursor CLI" });
    fireEvent.click(within(cursor).getByRole("button", { name: "接入 Cursor CLI" }));
    await waitFor(() => expect(installIntegrations).toHaveBeenCalledWith("apply", ["cursor"]));
    expect(within(cursor).queryByRole("button", { name: /断开/u })).toBeNull();

    const qwen = within(list).getByRole("article", { name: "Qwen Code" });
    expect(within(qwen).queryByRole("button", { name: /^接入/u })).toBeNull();
    fireEvent.click(within(qwen).getByRole("button", { name: "断开 Qwen Code" }));
    const dialog = await screen.findByRole("dialog", { name: "断开 Qwen Code？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "断开" }));
    await waitFor(() => expect(removeIntegrations).toHaveBeenCalledWith(["qwen-code"]));

    const mine = within(list).getByRole("article", { name: "My CLI" });
    expect(within(mine).getByText("自定义")).toBeVisible();
    expect(within(mine).getAllByRole("button").map((button) => button.textContent)).toEqual(["删除"]);
  });

  it("marks a tool written from its docs alone 未实测, and says why on hover", async () => {
    await harness();
    const qwen = within(screen.getByRole("region", { name: "客户端" })).getByRole("article", { name: "Qwen Code" });
    const tag = within(qwen).getByText("未实测");
    expect(tag).toHaveAttribute("title", expect.stringMatching(/官方文档/u));
    expect(within(screen.getByRole("region", { name: "客户端" })).getByRole("article", { name: "Claude Code" })).not.toHaveTextContent("未实测");
  });

  it("says a client of the reader's that a shipped tool replaces is no longer in effect", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    const clients = snapshot.clients.map((client) =>
      client.id === "my-cli" ? { ...client, problem: "Paraself 已内置 Qwen Code，这一条不再生效，可以删除", superseded: true as const } : client);
    render(<ClientsPanel snapshot={{ ...snapshot, clients }} api={preview} />);
    const mine = within(screen.getByRole("region", { name: "客户端" })).getByRole("article", { name: "My CLI" });
    expect(mine).toHaveTextContent("不再生效");
    fireEvent.click(within(mine).getByRole("button", { name: "删除 My CLI" }));
    expect(await screen.findByRole("dialog", { name: "删除「My CLI」？" })).toHaveTextContent("不会改动它填写的钩子配置文件");
  });

  it("says what a check did under the buttons that did it", async () => {
    await harness();
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    const maintenance = screen.getByRole("region", { name: "接入维护" });
    expect(await within(maintenance).findByRole("status")).toHaveTextContent("检查完成");
  });

  it("asks for repair in the action color only when a client needs it, and acts on those on this machine", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    const installIntegrations = vi.fn<DecisionApi["installIntegrations"]>(async (mode) => ({ mode, targets: [], commands: [], restartRequired: true }));
    const missing = Object.fromEntries(snapshot.clients.map((client) => [client.id, "command-missing" as const]));
    const view = render(
      <ClientsPanel snapshot={{ ...snapshot, integrationStatus: { ...missing, "claude-code": "installed", codex: "installed" } }} api={{ ...preview, installIntegrations }} />,
    );
    expect(screen.getByRole("button", { name: "全部修复" })).not.toHaveClass("primary-button");

    view.rerender(
      <ClientsPanel snapshot={{ ...snapshot, integrationStatus: { ...missing, "claude-code": "installed", codex: "not-installed" } }} api={{ ...preview, installIntegrations }} />,
    );
    expect(screen.getByRole("button", { name: "全部修复" })).toHaveClass("primary-button");
    fireEvent.click(screen.getByRole("button", { name: "全部修复" }));
    await waitFor(() => expect(installIntegrations).toHaveBeenCalledWith("apply", ["claude-code", "codex"]));
  });
});

it("disconnects every connected client, and names them and their restart", async () => {
  const preview = createPreviewApi();
  const snapshot = await preview.getSnapshot();
  render(<ClientsPanel snapshot={snapshot} api={preview} />);
  fireEvent.click(screen.getByRole("button", { name: "断开全部" }));
  const dialog = await screen.findByRole("dialog", { name: "断开所有已接入的工具？" });
  expect(dialog).toHaveTextContent("Claude Code、Codex、Grok、Qwen Code、My CLI 里的自动记录和决策前核对都会移除");
  expect(dialog).toHaveTextContent("重启正在运行的 Claude Code、Codex、Grok、Qwen Code 或 My CLI 后生效。");
});

it("keeps 断开全部 apart from the main actions and off while nothing is connected", async () => {
  const preview = createPreviewApi();
  const snapshot = await preview.getSnapshot();
  render(<ClientsPanel snapshot={{ ...snapshot, integrationStatus: Object.fromEntries(snapshot.clients.map((client) => [client.id, "not-installed" as const])) }} api={preview} />);
  const disconnect = screen.getByRole("button", { name: "断开全部" });
  expect(disconnect).toBeDisabled();
  expect(disconnect).toHaveClass("danger-button");
  // First in the group, a rule from 检查连接 and 全部修复: it sat right beside the primary one.
  const actions = [...disconnect.parentElement!.querySelectorAll("button")].map((button) => button.textContent);
  expect(actions).toEqual(["断开全部", "检查连接", "全部修复"]);
});

// CL2-REVIEW-CAT SPEC-2 (rounds/CL2/review-cat/spec/duplicate-id.test.tsx).
it("gives a superseded client of the reader's its own row name beside the catalog tool of its id", async () => {
  const preview = createPreviewApi();
  const snapshot = await preview.getSnapshot();
  const qwen = snapshot.clients.find((client) => client.id === "qwen-code")!;
  const { untested: _untested, ...rest } = qwen;
  const old = { ...rest, name: "旧 Qwen 配置", custom: true as const, superseded: true as const, problem: "Paraself 已内置 Qwen Code，这一条不再生效，可以删除" };
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<ClientsPanel snapshot={{ ...snapshot, clients: [qwen, old], integrationStatus: { "qwen-code": "installed" } }} api={preview} />);
  await waitFor(() => expect(document.querySelectorAll("article")).toHaveLength(2));
  expect(screen.getByRole("article", { name: "旧 Qwen 配置" })).toHaveTextContent("不再生效");
  expect(screen.getByRole("article", { name: "Qwen Code" })).toHaveTextContent("已连接");
  expect(new Set([...document.querySelectorAll("h3")].map((heading) => heading.id)).size).toBe(2);
  expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/u);
  errors.mockRestore();
});

// CL2-REVIEW-CAT CFG-3.
it("says a client whose hooks another file of its own shadows is not recording, and why", async () => {
  const preview = createPreviewApi();
  const snapshot = await preview.getSnapshot();
  render(<ClientsPanel snapshot={{ ...snapshot, integrationStatus: { ...snapshot.integrationStatus, droid: "shadowed" } }} api={preview} />);
  const droid = within(screen.getByRole("region", { name: "客户端" })).getByRole("article", { name: "Factory Droid" });
  expect(droid).toHaveTextContent("未生效");
  expect(droid).toHaveTextContent("~/.factory/hooks.json");
  expect(within(droid).getByRole("button", { name: "重新接入 Factory Droid" })).toBeVisible();
  expect(within(droid).getByRole("button", { name: "断开 Factory Droid" })).toBeVisible();
});
