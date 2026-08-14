import type { AppSnapshot } from "../src/shared/renderer-api.js";
import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_WINDOW_MIN_SIZE,
  DESKTOP_WINDOW_SIZE,
} from "../src/shared/decision-layout.js";
import {
  WindowManager,
  type BrowserWindowLike,
  type BrowserWindowOptionsLike,
} from "../src/main/window-manager.js";
import { serverCaptureFixture } from "./fixtures.js";

class FakeWindow implements BrowserWindowLike {
  nativeGlassActive = false;
  readonly webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
  };
  readonly show = vi.fn();
  readonly focus = vi.fn();
  readonly hide = vi.fn();
  readonly setNativeSurfaceMode = vi.fn();
  readonly loadURL = vi.fn(async () => undefined);
  readonly loadFile = vi.fn(async () => undefined);
  readonly on = vi.fn();

  isDestroyed(): boolean {
    return false;
  }
}

const snapshot = (values: Partial<AppSnapshot> = {}): AppSnapshot => ({
  current: null,
  waitingCount: 0,
  primarySurface: "dashboard",
  dashboard: {
    totalDecisions: 0,
    recorded7d: 0,
    reviewAttention: 0,
    recentDecisions: [],
  },
  candidateReviewOpen: false,
  candidateReviewProgress: null,
  decisionCandidates: { current: null, count: 0 },
  theme: "auto",
  vaultPath: "/vault",
  health: { index: "healthy", recovery: "healthy" },
  integrationStatus: {
    claudeCode: "installed",
    codex: "installed",
  },
  pendingRationales: [],
  semanticRecognition: {
    provider: "rules",
    providerLabel: "规则识别",
    availability: "model_missing",
    mode: "hybrid",
    processed7d: 0,
    high7d: 0,
    medium7d: 0,
    failures7d: 0,
    updatedAt: "2026-07-27T10:00:00.000Z",
  },
  ...values,
});

const createManager = (
  window: FakeWindow,
  options: {
    platform?: NodeJS.Platform;
    renderer?: { kind: "url"; value: string } | { kind: "file"; value: string };
    onOptions?: (value: BrowserWindowOptionsLike) => void;
  } = {},
) =>
  new WindowManager({
    createWindow: (value) => {
      options.onOptions?.(value);
      return window;
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 900, y: 200 }),
      getDisplayNearestPoint: () => ({
        workArea: { x: 100, y: 24, width: 1_440, height: 900 },
      }),
    },
    preloadPath: "/app/preload.js",
    renderer: options.renderer ?? {
      kind: "file",
      value: "/app/index.html",
    },
    platform: options.platform ?? "darwin",
  });

describe("WindowManager", () => {
  it("creates a centered, resizable and hardened desktop window", async () => {
    const window = new FakeWindow();
    let created: BrowserWindowOptionsLike | undefined;
    const manager = createManager(window, {
      onOptions: (value) => {
        created = value;
      },
    });

    await manager.create();

    expect(created).toMatchObject({
      x: 240,
      y: 94,
      ...DESKTOP_WINDOW_SIZE,
      minWidth: DESKTOP_WINDOW_MIN_SIZE.width,
      minHeight: DESKTOP_WINDOW_MIN_SIZE.height,
      frame: true,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 18 },
      transparent: true,
      roundedCorners: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      show: false,
      vibrancy: "under-window",
      visualEffectState: "active",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: "/app/preload.js",
      },
    });
    expect(window.setNativeSurfaceMode).toHaveBeenCalledWith("desktop");

    const navigationHandler = window.webContents.on.mock.calls[0]?.[1] as
      ((event: { preventDefault(): void }) => void) | undefined;
    const navigationEvent = { preventDefault: vi.fn() };
    navigationHandler?.(navigationEvent);
    expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();

    const openHandler = window.webContents.setWindowOpenHandler.mock
      .calls[0]?.[0] as (() => { action: "deny" }) | undefined;
    expect(openHandler?.()).toEqual({ action: "deny" });
  });

  it("updates every application surface without repeatedly refocusing the visible window", async () => {
    const window = new FakeWindow();
    const manager = createManager(window);
    await manager.create();

    manager.publish(snapshot({ primarySurface: "dashboard" }));
    manager.publish(snapshot({ primarySurface: "clients" }));
    manager.publish(snapshot({ primarySurface: "models" }));
    manager.publish(snapshot({ primarySurface: "activity" }));
    manager.publish(snapshot({ primarySurface: "settings" }));
    const event = serverCaptureFixture();
    manager.publish(
      snapshot({
        primarySurface: "hidden",
        current: {
          status: "awaiting_rationale",
          candidateId: "candidate-current",
          candidateKey: "candidate-key",
          event,
          question: event.questions[0]!,
        },
      }),
    );

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.hide).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledTimes(6);
    expect(window.setNativeSurfaceMode).toHaveBeenCalledTimes(1);
  });

  it("hides only when no desktop surface or active task is open", async () => {
    const window = new FakeWindow();
    const manager = createManager(window);
    await manager.create();

    manager.publish(snapshot({ primarySurface: "hidden" }));

    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
  });

  it("does not refocus an empty visible workspace during background refreshes", async () => {
    const window = new FakeWindow();
    const manager = createManager(window);
    await manager.create();
    const emptyDashboard = snapshot({
      primarySurface: "dashboard",
      current: null,
      candidateReviewOpen: false,
      decisionCandidates: { current: null, count: 0 },
      pendingRationales: [],
    });

    manager.publish(emptyDashboard);
    for (let refresh = 0; refresh < 100; refresh += 1) {
      manager.publish(emptyDashboard);
    }

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("keeps background inbox counts hidden until the user opens the app", async () => {
    const window = new FakeWindow();
    const manager = createManager(window);
    await manager.create();

    manager.publish(
      snapshot({
        primarySurface: "hidden",
        dashboard: {
          totalDecisions: 12,
          recorded7d: 3,
          reviewAttention: 4,
          recentDecisions: [],
        },
        decisionCandidates: { current: null, count: 3 },
      }),
    );

    expect(window.hide).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("shows once when a real rationale task arrives while hidden", async () => {
    const window = new FakeWindow();
    const manager = createManager(window);
    await manager.create();
    manager.publish(snapshot({ primarySurface: "hidden" }));
    const event = serverCaptureFixture();

    manager.publish(
      snapshot({
        primarySurface: "hidden",
        current: {
          status: "awaiting_rationale",
          candidateId: "candidate-current",
          candidateKey: "candidate-key",
          event,
          question: event.questions[0]!,
        },
      }),
    );

    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("honors an explicit request to bring an already presented window forward", async () => {
    const window = new FakeWindow();
    const manager = createManager(window);
    await manager.create();
    manager.publish(snapshot({ primarySurface: "dashboard" }));

    manager.show();

    expect(window.show).toHaveBeenCalledTimes(2);
    expect(window.focus).toHaveBeenCalledTimes(2);
  });

  it("turns the close control into a recoverable hide until quit", async () => {
    const window = new FakeWindow();
    const closeRequested = vi.fn();
    const manager = new WindowManager({
      createWindow: () => window,
      screen: {
        getCursorScreenPoint: () => ({ x: 900, y: 200 }),
        getDisplayNearestPoint: () => ({
          workArea: { x: 100, y: 24, width: 1_440, height: 900 },
        }),
      },
      preloadPath: "/app/preload.js",
      renderer: { kind: "file", value: "/app/index.html" },
      platform: "darwin",
      onCloseRequested: closeRequested,
    });
    await manager.create();
    const closeHandler = window.on.mock.calls[0]?.[1] as
      ((event: { preventDefault(): void }) => void) | undefined;
    const closeEvent = { preventDefault: vi.fn() };

    closeHandler?.(closeEvent);
    manager.prepareToQuit();
    closeHandler?.(closeEvent);

    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(window.hide).toHaveBeenCalledOnce();
    expect(closeRequested).toHaveBeenCalledOnce();
  });

  it("marks the renderer when native glass is active", async () => {
    const window = new FakeWindow();
    window.nativeGlassActive = true;
    const manager = createManager(window, {
      renderer: {
        kind: "url",
        value: "http://localhost:5173/?preview=dashboard",
      },
    });

    await manager.create();

    expect(window.loadURL).toHaveBeenCalledWith(
      "http://localhost:5173/?preview=dashboard&nativeGlass=1",
    );
  });

  it("omits macOS chrome options on other platforms", async () => {
    let created: BrowserWindowOptionsLike | undefined;
    const manager = createManager(new FakeWindow(), {
      platform: "win32",
      onOptions: (value) => {
        created = value;
      },
    });

    await manager.create();

    expect(created).not.toHaveProperty("vibrancy");
    expect(created).not.toHaveProperty("visualEffectState");
    expect(created).not.toHaveProperty("titleBarStyle");
    expect(created).not.toHaveProperty("trafficLightPosition");
  });
});
