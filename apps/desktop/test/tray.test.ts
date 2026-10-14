import { describe, expect, it, vi } from "vitest";

import {
  configureTray,
  TrayLifecycle,
} from "../src/main/tray.js";

describe("tray configuration", () => {
  it("retains the tray for the application lifetime and disposes it on shutdown", () => {
    const lifecycle = new TrayLifecycle();
    const first = { destroy: vi.fn() };
    const second = { destroy: vi.fn() };

    expect(lifecycle.attach(first)).toBe(first);
    expect(lifecycle.attach(second)).toBe(second);
    expect(first.destroy).toHaveBeenCalledOnce();

    lifecycle.dispose();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it("separates workload status from menu actions", () => {
    const image = {
      setTemplateImage: vi.fn(),
    };
    const tray = {
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
    };
    const openSettings = vi.fn();
    const openDashboard = vi.fn();
    const quit = vi.fn();
    const buildMenu = vi.fn((template) => ({ template }));

    const menu = configureTray({
      tray,
      image,
      buildMenu,
      pendingCount: 5,
      openDashboard,
      openSettings,
      quit,
    });

    expect(image.setTemplateImage).toHaveBeenCalledWith(true);
    expect(tray.setTitle).toHaveBeenCalledWith("");
    expect(tray.setToolTip).toHaveBeenCalledWith(
      "Decision · 5 项待办",
    );
    expect(tray.setContextMenu).toHaveBeenCalledWith(menu);
    expect(menu.template).toHaveLength(4);
    expect(menu.template[0]).toMatchObject({
      label: "首页",
      sublabel: "5 项待办",
      accessibilityLabel: "打开首页，5 项待办",
    });
    expect(menu.template[1]).toMatchObject({
      label: "设置…",
      accessibilityLabel: "打开设置",
      accelerator: "CommandOrControl+,",
    });
    expect(menu.template[2]).toEqual({ type: "separator" });
    expect(menu.template[3]).toMatchObject({
      label: "退出",
      accelerator: "CommandOrControl+Q",
    });

    menu.template[0]?.click?.();
    expect(openDashboard).toHaveBeenCalledOnce();
    expect(openSettings).not.toHaveBeenCalled();

    menu.template[1]?.click?.();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    menu.template[3]?.click?.();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("stays quiet in the menu bar when there is no pending work", () => {
    const tray = {
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
    };
    const buildMenu = vi.fn((template) => ({ template }));

    const menu = configureTray({
      tray,
      image: { setTemplateImage: vi.fn() },
      buildMenu,
      pendingCount: 0,
      openDashboard: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn(),
    });

    expect(tray.setTitle).toHaveBeenCalledWith("");
    expect(tray.setToolTip).toHaveBeenCalledWith(
      "Decision · 暂无待办",
    );
    expect(menu.template[0]?.sublabel).toBe("暂无待办");
    expect(menu.template[0]?.accessibilityLabel).toBe(
      "打开首页，暂无待办",
    );
  });

  it("keeps the exact workload in the menu without widening the menu bar", () => {
    const tray = {
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
    };
    const menu = configureTray({
      tray,
      image: { setTemplateImage: vi.fn() },
      buildMenu: (template) => ({ template }),
      pendingCount: 128,
      openDashboard: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn(),
    });

    expect(tray.setTitle).toHaveBeenCalledWith("");
    expect(menu.template[0]?.sublabel).toBe("128 项待办");
  });

  it("names due reviews apart from the rest of the workload", () => {
    const tray = {
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: () => false,
    };
    configureTray({
      tray: tray as never,
      image: { setTemplateImage: vi.fn() } as never,
      buildMenu: (template) => template,
      pendingCount: 5,
      reviewDueCount: 3,
      openDashboard: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn(),
    });

    // A single merged number cannot say that a review came due; counted on top of a smaller total as 待复盘,
    // it said another number, and another name, than the home page.
    expect(tray.setToolTip).toHaveBeenCalledWith(
      "Decision · 5 项待办，其中 3 条需复盘",
    );
  });

  it("falls back to the quiet copy when nothing is waiting", () => {
    const tray = {
      setTitle: vi.fn(),
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      destroy: vi.fn(),
      isDestroyed: () => false,
    };
    configureTray({
      tray: tray as never,
      image: { setTemplateImage: vi.fn() } as never,
      buildMenu: (template) => template,
      pendingCount: 0,
      reviewDueCount: 0,
      openDashboard: vi.fn(),
      openSettings: vi.fn(),
      quit: vi.fn(),
    });

    expect(tray.setToolTip).toHaveBeenCalledWith("Decision · 暂无待办");
  });
});
