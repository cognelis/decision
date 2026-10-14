// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DecisionApi } from "../src/shared/renderer-api.js";
import { SettingsPanel } from "../src/renderer/components/pages/settings/SettingsPanel.js";
import { createPreviewApi } from "../src/renderer/preview-api.js";
import { ModelsPanel } from "../src/renderer/components/pages/models/ModelsPanel.js";
import { rationaleSnapshot } from "./app-fixtures.js";

/**
 * The vault is the one folder a reader has to be able to reach by hand: it is
 * the source of truth the index is rebuilt from, and the only thing worth
 * backing up. Printing its path is not the same as reaching it.
 */
const harness = async (overrides: Partial<DecisionApi> = {}) => {
  const preview = createPreviewApi();
  const snapshot = await preview.getSnapshot();
  const api: DecisionApi = {
    ...preview,
    revealVault: vi.fn(async () => true),
    ...overrides,
  };
  render(<SettingsPanel snapshot={snapshot} api={api} />);
  return { api, snapshot };
};

afterEach(cleanup);

describe("SettingsPanel", () => {
  it("uses a switch for reminders and preserves its state if saving fails", async () => {
    const setReviewRemindersEnabled = vi.fn(async () => { throw new Error("提醒设置保存失败"); });
    await harness({ setReviewRemindersEnabled });
    const user = userEvent.setup();
    const toggle = screen.getByRole("switch", { name: "复盘提醒" });
    expect(toggle).toBeChecked();
    toggle.focus();
    await user.keyboard(" ");
    expect(setReviewRemindersEnabled).toHaveBeenCalledWith(false);
    expect(await screen.findByRole("status")).toHaveTextContent("提醒设置保存失败");
    expect(toggle).toBeChecked();
  });

  it("shows why the index needs attention, and what a rebuild found", async () => {
    const preview = createPreviewApi();
    const snapshot = await preview.getSnapshot();
    const rebuildIndex = vi.fn(async () => ({ indexedCount: 4, diagnostics: [{ path: "/vault/dec-7.md", message: "bad" }] }));
    render(
      <SettingsPanel
        snapshot={{ ...snapshot, health: { ...snapshot.health, index: "degraded", indexMessage: "1 篇决策笔记无法读取，没有出现在列表里：dec-7.md。" } }}
        api={{ ...preview, rebuildIndex }}
      />,
    );
    const user = userEvent.setup();

    expect(screen.getByText(/1 篇决策笔记无法读取/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "重建决策索引" }));
    expect(await screen.findByRole("status")).toHaveTextContent("共 4 条；1 处需要处理");
  });

  it("says nothing changed when choosing another vault is cancelled", async () => {
    const user = userEvent.setup();
    const { api } = await harness({ chooseVault: vi.fn(async () => null) });

    await user.click(screen.getByRole("button", { name: "更换仓库" }));

    await waitFor(() => expect(api.chooseVault).toHaveBeenCalledOnce());
    expect(screen.queryByText("仓库已更新，重启后生效。")).toBeNull();
  });

  it("shows the vault in the file manager without naming a path", async () => {
    const user = userEvent.setup();
    const { api } = await harness();

    await user.click(
      screen.getByRole("button", { name: "在文件管理器中显示" }),
    );

    // No argument: the renderer may ask for this one folder and cannot name
    // another, so nothing it says reaches the file manager.
    expect(api.revealVault).toHaveBeenCalledWith();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已在文件管理器中显示仓库。",
    );
  });

  it("says so when the vault is no longer where it was configured", async () => {
    const user = userEvent.setup();
    await harness({ revealVault: vi.fn(async () => false) });

    await user.click(
      screen.getByRole("button", { name: "在文件管理器中显示" }),
    );

    // Silence here would read as "opened it", and the reader would go looking
    // at a window that never appeared.
    expect(await screen.findByRole("status")).toHaveTextContent(
      "没有找到这个仓库目录，它可能已被移动。",
    );
  });
});


it("toggles local credential mode and reports migration failures", async () => {
  const setLocalCredentialsEnabled = vi.fn(async () => { throw new Error("迁移失败"); });
  await harness({ setLocalCredentialsEnabled });
  const toggle = screen.getByRole("switch", { name: "本地密钥模式" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(screen.getByText(/密钥以明文保存在本机/)).toBeVisible();
  fireEvent.click(toggle);
  await waitFor(() => expect(setLocalCredentialsEnabled).toHaveBeenCalledWith(true));
  expect(await screen.findByRole("status")).toHaveTextContent("迁移失败");
  expect(toggle).toHaveAttribute("aria-checked", "false");
});

it("says the model backends could not be read, reads them again on request, and says a classifier choice was not saved", async () => {
  const api = createPreviewApi();
  const list = api.listModelProviderProfiles;
  let fail = true;
  api.listModelProviderProfiles = async () => {
    if (fail) throw new Error("模型后端配置无法读取");
    return list();
  };
  api.setCaptureClassifier = async () => {
    throw new Error("设置无法保存");
  };
  const user = userEvent.setup();
  render(<ModelsPanel snapshot={rationaleSnapshot({ current: null, primarySurface: "models" })} api={api} />);

  // It said "正在读取模型后端…" for good, and offered to add to a list it never had.
  expect(await screen.findByText("模型后端暂时无法读取：模型后端配置无法读取")).toBeVisible();
  expect(screen.getByRole("button", { name: "添加模型后端" })).toBeDisabled();
  fail = false;
  await user.click(screen.getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "添加模型后端" })).toBeEnabled());

  await user.selectOptions(screen.getByRole("combobox", { name: "采集分类使用的引擎" }), "models");
  expect(await screen.findByText("采集分类没能保存：设置无法保存")).toBeVisible();
});

it("says no model can be used when none is enabled, rather than calling the rules unavailable", async () => {
  const snapshot = rationaleSnapshot({ current: null, primarySurface: "models" });
  render(<ModelsPanel api={createPreviewApi()}
    snapshot={{ ...snapshot, semanticRecognition: { ...snapshot.semanticRecognition, mode: "rules_only", unavailableModels: [] } }} />);
  expect(screen.getByText("没有可用的模型，正在只用规则。")).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "添加模型后端" })).toBeEnabled());
});
