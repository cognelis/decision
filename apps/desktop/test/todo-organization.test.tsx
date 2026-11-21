// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TodoPanel, type TodoApi } from "../src/renderer/components/pages/todos/TodoPanel.js";
import type { OrganizationApi } from "../src/renderer/components/pages/organization/OrganizationPanel.js";
import type { ReadingLayerApi } from "../src/renderer/components/pages/organization/TodoReadingLayer.js";
import { createOrganizationPreview } from "../src/renderer/preview-organization.js";
import { createTodoPreview } from "../src/renderer/preview-todos.js";

/** 待办页的整理入口：徽标取服务端总量；打开面板的范围来自当前清单的项目；整理面板藏起来后再打开，状态还在。 */

const setup = () => {
  const store = createTodoPreview();
  const preview = createOrganizationPreview(null);
  const organizationApi = {
    ...preview,
    listModelProviderProfiles: vi.fn(async () => []),
    getOrganization: vi.fn(preview.getOrganization),
  } as unknown as OrganizationApi & ReadingLayerApi;
  const api: TodoApi = { ...store, openVaultDocument: vi.fn(async () => undefined) };
  render(<TodoPanel api={api} todoRevision={0} organization={{ api: organizationApi, revision: 0, pending: 8, onOpenMethodology: vi.fn() }} />);
  return { organizationApi, user: userEvent.setup() };
};

afterEach(cleanup);

describe("待办页的整理入口", () => {
  it("入口徽标显示服务端给的待审阅总量，不是自己数的", async () => {
    setup();
    expect(await screen.findByRole("button", { name: /整理/u, pressed: false })).toHaveTextContent("8");
  });

  it("打开后范围来自当前清单与它的项目，关闭后再打开仍是同一个面板", async () => {
    const { organizationApi, user } = setup();
    await user.click((await screen.findAllByRole("button", { name: /Paraself 遗留问题调研/iu }))[0]!);
    await user.click(screen.getByRole("button", { name: /^整理/u }));
    await waitFor(() => expect(organizationApi.getOrganization).toHaveBeenCalledWith(expect.objectContaining({ project: null, scope: "all" })));
    expect(await screen.findByRole("tab", { name: /总览/u })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "关闭整理" }));
    expect(screen.queryByRole("tab", { name: /总览/u })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^整理/u }));
    expect(await screen.findByRole("tab", { name: /总览/u })).toBeVisible();
  });
});
