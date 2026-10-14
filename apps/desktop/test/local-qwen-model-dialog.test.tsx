import type { DecisionApi } from "../src/shared/renderer-api.js";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LocalQwenModelDialog } from "../src/renderer/components/LocalQwenModelDialog.js";
import { apiFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);
it("installs only the chosen model and preserves the profile switches when saving", async () => {
  const { api } = apiFixture(rationaleSnapshot());
  let installed = false;
  api.listManagedQwenModels = vi.fn<DecisionApi["listManagedQwenModels"]>(async () => [
    { modelId: "qwen3.5-2b-q4-k-m", status: "available", downloadedBytes: 1329766560, totalBytes: 1329766560 },
    { modelId: "qwen3.5-4b-q4-k-m", status: installed ? "available" : "missing", downloadedBytes: installed ? 3013027808 : 0, totalBytes: 3013027808 },
  ]);
  api.installManagedQwenModel = vi.fn(async () => { installed = true; });
  const profile = { version: 1 as const, profileId: "builtin-qwen", kind: "qwen" as const, label: "Qwen 本地模型", enabled: false, priority: 10, model: "qwen3.5-2b-q4-k-m", timeoutMs: 5000, credentialConfigured: false };
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<LocalQwenModelDialog api={api} profile={profile} onClose={onClose} onSaved={async () => undefined} />);
  await screen.findByText("已安装，文件校验通过。");
  await user.selectOptions(screen.getByLabelText("Qwen 本地模型"), "qwen3.5-4b-q4-k-m");
  expect(screen.getByRole("button", { name: "保存模型选择" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "安装所选模型" }));
  expect(api.installManagedQwenModel).toHaveBeenCalledWith("qwen3.5-4b-q4-k-m");
  await waitFor(() => expect(screen.getByRole("button", { name: "保存模型选择" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "保存模型选择" }));
  expect(api.saveModelProviderProfile).toHaveBeenCalledWith({ profile: { ...profile, model: "qwen3.5-4b-q4-k-m" } });
  expect(onClose).toHaveBeenCalledOnce();
});

it("keeps reading the install status after one read fails, and says so only until a read succeeds", async () => {
  const { api } = apiFixture(rationaleSnapshot());
  const status = (state: "installing" | "available", downloaded: number) => [
    { modelId: "qwen3.5-2b-q4-k-m" as const, status: "missing" as const, downloadedBytes: 0, totalBytes: 1329766560 },
    { modelId: "qwen3.5-4b-q4-k-m" as const, status: state, downloadedBytes: downloaded, totalBytes: 3013027808 },
  ];
  let calls = 0;
  api.listManagedQwenModels = vi.fn<DecisionApi["listManagedQwenModels"]>(async () => {
    calls += 1;
    if (calls === 1) return status("installing", 301302780);
    if (calls === 2) throw new Error("读取安装状态失败");
    return status("available", 3013027808);
  });
  const profile = { version: 1 as const, profileId: "builtin-qwen", kind: "qwen" as const, label: "Qwen 本地模型", enabled: false, priority: 10, model: "qwen3.5-4b-q4-k-m", timeoutMs: 5000, credentialConfigured: false };
  render(<LocalQwenModelDialog api={api} profile={profile} onClose={() => undefined} onSaved={async () => undefined} />);
  expect(await screen.findByText(/正在下载 \d+%/u)).toBeVisible();
  expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent("读取安装状态失败");
  // Stopped at the failed read, the download stayed at 9% and 保存 disabled although the model was installed.
  await waitFor(() => expect(screen.getByText("已安装，文件校验通过。")).toBeVisible(), { timeout: 6_000 });
  expect(screen.getByRole("button", { name: "保存模型选择" })).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
}, 15_000);
