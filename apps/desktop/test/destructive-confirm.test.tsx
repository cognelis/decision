// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModelProviderPanel } from "../src/renderer/components/ModelProviderPanel.js";
import { ModelTracePanel } from "../src/renderer/components/ModelTracePanel.js";
import { apiFixture, modelTraceFixture, rationaleSnapshot } from "./app-fixtures.js";

afterEach(cleanup);

/** Confirmed by clicking again on the same spot: a habitual double-click must not be that second click. */
describe("a destructive action confirmed by a second click", () => {
  it("does not delete a model backend, and its stored key, on a double-click", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null }));
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([{
      version: 1, profileId: "remote-1", kind: "openai", label: "OpenAI 生产", enabled: true, priority: 40,
      model: "gpt-5", timeoutMs: 30_000, baseUrl: "https://api.openai.com", apiProtocol: "responses",
      credentialConfigured: true,
    }]);
    vi.mocked(api.deleteModelProviderProfile).mockResolvedValue(true);
    const user = userEvent.setup();
    render(<ModelProviderPanel api={api} />);

    await user.dblClick(await screen.findByRole("button", { name: "删除 OpenAI 生产" }));
    expect(api.deleteModelProviderProfile).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认删除 OpenAI 生产" }));
    expect(api.deleteModelProviderProfile).toHaveBeenCalledWith("remote-1");
  });

  it("does not clear every model trace on a double-click", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null }), [modelTraceFixture()]);
    vi.mocked(api.clearModelTraces).mockResolvedValue(1);
    const user = userEvent.setup();
    render(<ModelTracePanel api={api} contentEnabled />);

    await user.dblClick(await screen.findByRole("button", { name: "清空记录" }));
    expect(api.clearModelTraces).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认清空全部记录" }));
    expect(api.clearModelTraces).toHaveBeenCalledTimes(1);
  });

  it("disarms a backend's deletion once the reader goes on to something else", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null }));
    const remote = (profileId: string, label: string) => ({
      version: 1 as const, profileId, kind: "openai" as const, label, enabled: true, priority: profileId === "a" ? 40 : 41,
      model: "gpt-5", timeoutMs: 30_000, baseUrl: "https://api.openai.com", apiProtocol: "responses" as const, credentialConfigured: true,
    });
    vi.mocked(api.listModelProviderProfiles).mockResolvedValue([remote("a", "后端A"), remote("b", "后端B")]);
    const user = userEvent.setup();
    render(<ModelProviderPanel api={api} />);

    await user.click(await screen.findByRole("button", { name: "删除 后端A" }));
    await user.click(screen.getByRole("button", { name: "编辑 后端B" }));
    await user.click(screen.getByRole("button", { name: "取消编辑" }));
    // Still armed after all that, one stray click deleted the backend and its key.
    expect(screen.queryByRole("button", { name: "确认删除 后端A" })).toBeNull();
    expect(screen.getByRole("button", { name: "删除 后端A" })).toBeVisible();
  });

  it("disarms clearing every trace once the reader goes on to something else", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null }), [modelTraceFixture()]);
    const user = userEvent.setup();
    render(<ModelTracePanel api={api} contentEnabled />);
    await user.click(await screen.findByRole("button", { name: "清空记录" }));
    await user.click(screen.getByRole("switch", { name: "记录模型输入和输出" }));

    // Still armed, one click later wiped every record.
    expect(await screen.findByRole("button", { name: "清空记录" })).toBeVisible();
    expect(screen.queryByText("再次点击以确认清空全部模型调用记录。")).toBeNull();
  });

  it("says the traces were cleared when only reading the list again fails", async () => {
    const { api } = apiFixture(rationaleSnapshot({ current: null }), [modelTraceFixture()]);
    vi.mocked(api.clearModelTraces).mockResolvedValue(1);
    const user = userEvent.setup();
    render(<ModelTracePanel api={api} contentEnabled />);
    await user.click(await screen.findByRole("button", { name: "清空记录" }));
    vi.mocked(api.listModelTraces).mockRejectedValue(new Error("读取超时"));
    await user.click(screen.getByRole("button", { name: "确认清空全部记录" }));

    // Said as the read's failure alone, the clearing looked as if it had not happened.
    expect(await screen.findByText("模型调用记录已清空。列表暂时无法刷新：读取超时")).toBeVisible();
  });
});
