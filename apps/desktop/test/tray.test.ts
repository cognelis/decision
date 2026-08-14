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
});
