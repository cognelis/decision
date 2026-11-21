import { BUILT_IN_CLIENTS, clientSummary } from "@cognelis/decision-integrations";
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
import { adaptWindow } from "../src/main/window-adapter.js";
import { serverCaptureFixture } from "./fixtures.js";

class FakeWindow implements BrowserWindowLike {
  readonly webContents = {
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    reload: vi.fn(),
  };
  readonly maximize = vi.fn();
  readonly show = vi.fn();
  readonly showInactive = vi.fn();
  readonly focus = vi.fn();
  readonly hide = vi.fn();
  readonly loadURL = vi.fn(async () => undefined);
  readonly loadFile = vi.fn(async () => undefined);
  readonly on = vi.fn();
  isMinimized = vi.fn(() => false);
  isVisible = vi.fn(() => true);
  readonly restore = vi.fn();

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
  accent: "blue",
  vaultPath: "/vault",
  health: { index: "healthy", recovery: "healthy" },
  clients: BUILT_IN_CLIENTS.map(clientSummary),
  integrationStatus: {
    "claude-code": "installed",
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
  window: BrowserWindowLike,
  options: {
    platform?: NodeJS.Platform;
    renderer?: { kind: "url"; value: string } | { kind: "file"; value: string };
    onOptions?: (value: BrowserWindowOptionsLike) => void;
    presentation?: "visible" | "inactive" | "hidden";
  } = {},
  hooks: { onRendererGone?: (reason: string) => void; onPageLeft?: () => void; onCloseRequested?: () => void } = {},
) =>
  new WindowManager({
    ...hooks,
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
    ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
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
      roundedCorners: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: "/app/preload.js",
      },
    });
    expect(created).not.toHaveProperty("transparent");
    expect(created).not.toHaveProperty("vibrancy");
    expect(created).not.toHaveProperty("visualEffectState");

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
    manager.publish(snapshot({ primarySurface: "decisions" }));
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
    expect(window.webContents.send).toHaveBeenCalledTimes(7);
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

  it("brings a minimized window forward when a new capture arrives, once", async () => {
    let minimized = false;
    const window = Object.assign(new FakeWindow(), {
      isMinimized: vi.fn(() => minimized),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
    });
    const manager = createManager(window);
    await manager.create();
    manager.publish(snapshot());
    window.show.mockClear();
    minimized = true;
    const event = serverCaptureFixture();
    const arrived = snapshot({
      current: { status: "awaiting_rationale", candidateId: "candidate-new", candidateKey: "key", event, question: event.questions[0]! },
    });

    // Minimized with ⌘M before the capture: it still counted as presented, and the capture waited unseen.
    manager.publish(arrived);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    // Minimized again with the same capture up: a refresh does not undo that.
    manager.publish({ ...arrived });
    expect(window.show).toHaveBeenCalledOnce();
  });

  it("brings Electron's own window forward through the adapter when minimized or hidden with ⌘H", async () => {
    // Electron's BrowserWindow as far as the adapter touches it, with the state a real one keeps.
    const electron = {
      minimized: false,
      visible: true,
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn(), send: vi.fn(), reload: vi.fn() },
      loadURL: vi.fn(async () => undefined),
      loadFile: vi.fn(async () => undefined),
      on: vi.fn(),
      maximize: vi.fn(),
      focus: vi.fn(),
      hide: vi.fn(),
      show: vi.fn(() => { electron.visible = true; }),
      restore: vi.fn(() => { electron.minimized = false; }),
      isMinimized: () => electron.minimized,
      isVisible: () => electron.visible,
      isDestroyed: () => false,
    };
    // macOS: the app hidden with ⌘H is asked of the app, not of the window.
    let hidden = false;
    const manager = createManager(adaptWindow(electron as never, () => hidden));
    await manager.create();
    manager.publish(snapshot());
    electron.show.mockClear();
    const event = serverCaptureFixture();
    const arriving = (candidateId: string) => snapshot({
      current: { status: "awaiting_rationale", candidateId, candidateKey: candidateId, event, question: event.questions[0]! },
    });

    // The adapter gave the manager no way to ask: minimized, the capture waited in the Dock.
    electron.minimized = true;
    manager.publish(arriving("candidate-1"));
    expect(electron.restore).toHaveBeenCalledOnce();
    expect(electron.show).toHaveBeenCalledOnce();
    // Covered by the terminal running the agent: the window reads not visible on macOS, yet it is where the reader
    // left it, and pulling it forward took the focus from what they were typing.
    electron.visible = false;
    manager.publish(arriving("candidate-2"));
    expect(electron.show).toHaveBeenCalledOnce();
    // Hidden with ⌘H, the next one waited out of sight.
    hidden = true;
    manager.publish(arriving("candidate-3"));
    expect(electron.show).toHaveBeenCalledTimes(2);
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

  it.each([
    ["on macOS, where a closed window still reads as in view (only ⌘H does not)", false],
    ["where a closed window reads as out of view", true],
  ])("stays closed on the capture it was closed on, and comes back for the next one or when asked, %s", async (_where, closedReadsHidden) => {
    const window = new FakeWindow();
    let visible = false;
    window.show.mockImplementation(() => { visible = true; });
    window.hide.mockImplementation(() => { visible = false; });
    if (closedReadsHidden) window.isVisible.mockImplementation(() => visible);
    const event = serverCaptureFixture();
    const waiting = (candidateId: string, primarySurface: AppSnapshot["primarySurface"] = "hidden") => snapshot({
      primarySurface,
      current: { status: "awaiting_rationale", candidateId, candidateKey: `key-${candidateId}`, event, question: event.questions[0]! },
    });
    const reviewing = snapshot({
      primarySurface: "hidden",
      candidateReviewOpen: true,
      decisionCandidates: { current: { candidateId: "candidate-1" } as AppSnapshot["decisionCandidates"]["current"], count: 1 },
    });
    let closedSnapshot = waiting("capture-1");
    // As the app controller does: the close hides the primary surface, and publishes at once.
    const manager: WindowManager = createManager(window, {}, { onCloseRequested: () => manager.publish(closedSnapshot) });
    await manager.create();
    const close = () => (window.on.mock.calls.find(([name]) => name === "close")?.[1] as (event: { preventDefault(): void }) => void)({ preventDefault: vi.fn() });

    manager.publish(waiting("capture-1", "dashboard"));
    expect(visible).toBe(true);
    // Shown again at once, focus taken: it could not be put away while a capture waited, nor while 待处理 was open.
    close();
    manager.publish(waiting("capture-1"));
    expect(visible).toBe(false);
    expect(window.show).toHaveBeenCalledOnce();

    manager.publish(waiting("capture-2"));
    expect(visible).toBe(true);
    closedSnapshot = waiting("capture-2");
    close();
    expect(visible).toBe(false);
    // The Dock, the tray, a second launch: each shows the window before asking for a page.
    manager.show();
    manager.publish(waiting("capture-2", "dashboard"));
    expect(visible).toBe(true);

    manager.publish(reviewing);
    closedSnapshot = reviewing;
    close();
    manager.publish(reviewing);
    expect(visible).toBe(false);
    // The 待处理 session ending meanwhile (its last candidate expired) puts back the page it was opened from: the
    // window came up on it with nothing to do, focus taken.
    manager.publish(snapshot({ primarySurface: "dashboard" }));
    expect(visible).toBe(false);
    manager.publish(waiting("capture-3", "dashboard"));
    expect(visible).toBe(true);
  });

  it.each([
    ["on macOS, where a closed window still reads as in view (only ⌘H does not)", false],
    ["where a closed window reads as out of view", true],
  ])("comes back once when the save it was closed on fails, %s", async (_where, closedReadsHidden) => {
    const window = new FakeWindow();
    let visible = false;
    let minimized = false;
    window.show.mockImplementation(() => { visible = true; });
    window.hide.mockImplementation(() => { visible = false; });
    window.isMinimized.mockImplementation(() => minimized);
    window.restore.mockImplementation(() => { minimized = false; });
    if (closedReadsHidden) window.isVisible.mockImplementation(() => visible);
    const event = serverCaptureFixture();
    const saved = (persistenceStatus: "saving" | "failed", primarySurface: AppSnapshot["primarySurface"] = "hidden") => snapshot({
      primarySurface,
      current: { status: "completed", candidateId: "capture-1", candidateKey: "key-capture-1", event, question: event.questions[0]! },
      persistenceStatus,
    });
    let closedSnapshot = saved("saving");
    // As the app controller does: the close hides the primary surface, and publishes at once.
    const manager: WindowManager = createManager(window, {}, { onCloseRequested: () => manager.publish(closedSnapshot) });
    await manager.create();
    const close = () => (window.on.mock.calls.find(([name]) => name === "close")?.[1] as (event: { preventDefault(): void }) => void)({ preventDefault: vi.fn() });

    manager.publish(saved("saving", "dashboard"));
    close();
    expect(visible).toBe(false);
    // Failed with the window closed: why was said in the window alone, and the one that failed held the queue, so no
    // capture came up to bring it back.
    manager.publish(saved("failed"));
    expect(visible).toBe(true);
    expect(window.focus).toHaveBeenCalledTimes(2);
    // Closed on the failure itself, it stays closed through that failure's refreshes.
    closedSnapshot = saved("failed");
    close();
    manager.publish(saved("failed"));
    expect(visible).toBe(false);

    // Minimized while a retry is written, and that fails too: brought forward once.
    manager.show();
    manager.publish(saved("saving", "dashboard"));
    minimized = true;
    manager.publish(saved("failed", "dashboard"));
    expect(window.restore).toHaveBeenCalledOnce();
    minimized = true;
    manager.publish(saved("failed", "dashboard"));
    expect(window.restore).toHaveBeenCalledOnce();
  });

  it("counts a renderer lost a minute on as a new minute's, though the clock was set back meanwhile", async () => {
    const window = new FakeWindow();
    const gone = vi.fn();
    const manager = createManager(window, {}, { onRendererGone: gone });
    await manager.create();
    const rendererGone = window.webContents.on.mock.calls.find(([event]) => event === "render-process-gone")?.[1] as
      (event: unknown, details: { reason: string }) => void;
    for (let loss = 0; loss < 3; loss += 1) rendererGone({}, { reason: "crashed" });

    const wall = vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_001);
    try {
      // Timed by the wall clock, the three counted for the hour: the window stayed blank.
      rendererGone({}, { reason: "crashed" });
      expect(window.webContents.reload).toHaveBeenCalledTimes(4);
      expect(gone).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      wall.mockRestore();
    }
  });

  it("loads the page again when its renderer is gone, a few times a minute at most, then says so", async () => {
    const window = new FakeWindow();
    const gone = vi.fn();
    const manager = createManager(window, {}, { onRendererGone: gone });
    await manager.create();
    const rendererGone = window.webContents.on.mock.calls.find(([event]) => event === "render-process-gone")?.[1] as
      (event: unknown, details: { reason: string }) => void;

    // Out of memory on a huge list, a GPU fault: the window stayed blank until the app was quit from the tray.
    rendererGone({}, { reason: "oom" });
    expect(window.webContents.reload).toHaveBeenCalledOnce();
    rendererGone({}, { reason: "crashed" });
    rendererGone({}, { reason: "crashed" });
    expect(window.webContents.reload).toHaveBeenCalledTimes(3);
    // One that dies as it loads is not loaded again and again: it is said, and loaded once more when asked for.
    rendererGone({}, { reason: "crashed" });
    expect(window.webContents.reload).toHaveBeenCalledTimes(3);
    expect(gone).toHaveBeenCalledWith("crashed");
    manager.show();
    expect(window.webContents.reload).toHaveBeenCalledTimes(4);
    manager.show();
    expect(window.webContents.reload).toHaveBeenCalledTimes(4);
    // Nor at quitting, as its windows close.
    manager.prepareToQuit();
    rendererGone({}, { reason: "clean-exit" });
    expect(gone).toHaveBeenCalledOnce();
  });

  it("says when the page shown is left, so that what it had running in the main process is stopped", async () => {
    const window = new FakeWindow();
    const left = vi.fn();
    const manager = createManager(window, {}, { onPageLeft: left });
    await manager.create();
    const listener = (name: string) => window.webContents.on.mock.calls.find(([event]) => event === name)?.[1] as (...args: unknown[]) => void;

    // A move within the page, or in a frame of it, leaves the page as it is.
    listener("did-start-navigation")({ isMainFrame: true, isSameDocument: true });
    listener("did-start-navigation")({ isMainFrame: false, isSameDocument: false });
    expect(left).not.toHaveBeenCalled();
    // 重新加载 after a render error, or the renderer gone.
    listener("did-start-navigation")({ isMainFrame: true, isSameDocument: false });
    listener("render-process-gone")({}, { reason: "crashed" });
    expect(left).toHaveBeenCalledTimes(2);
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

    expect(created).not.toHaveProperty("transparent");
    expect(created).not.toHaveProperty("vibrancy");
    expect(created).not.toHaveProperty("visualEffectState");
    expect(created).not.toHaveProperty("titleBarStyle");
    expect(created).not.toHaveProperty("trafficLightPosition");
  });
});


it("maximizes only the first presentation and preserves later manual resizing", async () => {
  const window = new FakeWindow();
  const manager = createManager(window);
  await manager.create();
  expect(window.maximize).not.toHaveBeenCalled();
  manager.publish(snapshot());
  expect(window.maximize).toHaveBeenCalledTimes(1);
  expect(window.maximize.mock.invocationCallOrder[0]).toBeLessThan(window.show.mock.invocationCallOrder[0]!);
  manager.hide();
  manager.show();
  manager.publish(snapshot());
  expect(window.maximize).toHaveBeenCalledTimes(1);
});

describe("a window for a run started by a script", () => {
  const capture = () => {
    const event = serverCaptureFixture();
    return snapshot({
      primarySurface: "hidden",
      current: {
        status: "awaiting_rationale",
        candidateId: "candidate-script",
        candidateKey: "candidate-key",
        event,
        question: event.questions[0]!,
      },
    });
  };

  it("never comes on screen, not at start, nor for a capture, nor when asked for, its page loaded all the same", async () => {
    const window = new FakeWindow();
    const manager = createManager(window, { presentation: "hidden" });
    await manager.create();
    manager.publish(snapshot());
    manager.publish(capture());
    manager.show();

    expect(window.loadFile).toHaveBeenCalledOnce();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(window.restore).not.toHaveBeenCalled();
  });

  it("asked to be seen, comes up behind the app in front, as it is, unfocused", async () => {
    const window = new FakeWindow();
    const manager = createManager(window, { presentation: "inactive" });
    await manager.create();
    manager.publish(snapshot());
    manager.publish(capture());

    expect(window.showInactive).toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.maximize).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
});
