import type { AppSnapshot } from "../shared/renderer-api.js";
import {
  DESKTOP_WINDOW_MIN_SIZE,
  DESKTOP_WINDOW_SIZE,
  type DecisionWindowMode,
} from "../shared/decision-layout.js";

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserWindowOptionsLike {
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  frame: boolean;
  titleBarStyle?: "hiddenInset";
  trafficLightPosition?: { x: number; y: number };
  transparent: boolean;
  roundedCorners: boolean;
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  resizable: boolean;
  maximizable: boolean;
  fullscreenable: boolean;
  show: boolean;
  backgroundColor: string;
  vibrancy?: "under-window";
  visualEffectState?: "active";
  webPreferences: {
    nodeIntegration: boolean;
    contextIsolation: boolean;
    sandbox: boolean;
    preload: string;
  };
}

interface NavigationEvent {
  preventDefault(): void;
}

interface CloseEvent {
  preventDefault(): void;
}

interface RendererGoneDetails {
  reason: string;
}

interface NavigationStart {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

export interface BrowserWindowLike {
  nativeGlassActive?: boolean;
  webContents: {
    on(event: "will-navigate", listener: (event: NavigationEvent) => void): void;
    on(event: "did-start-navigation", listener: (details: NavigationStart) => void): void;
    on(event: "render-process-gone", listener: (event: unknown, details: RendererGoneDetails) => void): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    send(channel: string, value: unknown): void;
    reload(): void;
  };
  loadURL(url: string): Promise<void>;
  loadFile(
    path: string,
    options?: { query?: Record<string, string> },
  ): Promise<void>;
  on(event: "close", listener: (event: CloseEvent) => void): void;
  maximize(): void;
  show(): void;
  focus(): void;
  hide(): void;
  // Required: left optional, the production adapter left them out, and a minimized or ⌘H-hidden window read as in view.
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  setNativeSurfaceMode?(mode: DecisionWindowMode): void;
  isDestroyed(): boolean;
}

interface ScreenLike {
  getCursorScreenPoint(): { x: number; y: number };
  getDisplayNearestPoint(point: { x: number; y: number }): {
    workArea: Rectangle;
  };
}

interface WindowManagerOptions {
  createWindow(options: BrowserWindowOptionsLike): BrowserWindowLike;
  screen: ScreenLike;
  preloadPath: string;
  renderer:
    | { kind: "url"; value: string }
    | { kind: "file"; value: string };
  platform?: NodeJS.Platform;
  onCloseRequested?: () => void;
  /** The page could not be brought back on its own: its renderer went again and again (`reason` as Electron says). */
  onRendererGone?: (reason: string) => void;
  /** The page shown is left (reloaded, or its renderer gone): nothing is there any more to take what it asked for. */
  onPageLeft?: () => void;
}

/** Loaded again on its own this often in a minute at most: a page whose renderer dies as it loads would loop. */
const RENDERER_RELOADS_PER_MINUTE = 3;

const initialBounds = (screen: ScreenLike): Rectangle => {
  const point = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(point);
  const width = Math.min(
    DESKTOP_WINDOW_SIZE.width,
    Math.max(DESKTOP_WINDOW_MIN_SIZE.width, workArea.width - 24),
  );
  const height = Math.min(
    DESKTOP_WINDOW_SIZE.height,
    Math.max(DESKTOP_WINDOW_MIN_SIZE.height, workArea.height - 24),
  );
  return {
    x: Math.round(workArea.x + Math.max(0, (workArea.width - width) / 2)),
    y: Math.round(workArea.y + Math.max(0, (workArea.height - height) / 2)),
    width,
    height,
  };
};

export class WindowManager {
  readonly #options: WindowManagerOptions;
  #window: BrowserWindowLike | null = null;
  #presented = false;
  #initialPresentation = true;
  #quitting = false;
  /** The captured decision last put before the reader: a new one is brought forward even when minimized. */
  #shownTask: string | null = null;
  /** When the renderer went, within the last minute. */
  #rendererLosses: number[] = [];
  /** Left blank, its renderer gone too often to load again on its own: loaded again once the reader asks for it. */
  #blank = false;

  constructor(options: WindowManagerOptions) {
    this.#options = options;
  }

  async create(): Promise<void> {
    if (this.#window !== null && !this.#window.isDestroyed()) {
      return;
    }
    this.#presented = false;
    this.#initialPresentation = true;
    const darwin = (this.#options.platform ?? process.platform) === "darwin";
    const window = this.#options.createWindow({
      ...initialBounds(this.#options.screen),
      minWidth: DESKTOP_WINDOW_MIN_SIZE.width,
      minHeight: DESKTOP_WINDOW_MIN_SIZE.height,
      frame: true,
      ...(darwin
        ? {
            titleBarStyle: "hiddenInset" as const,
            trafficLightPosition: { x: 16, y: 18 },
          }
        : {}),
      transparent: true,
      roundedCorners: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      show: false,
      backgroundColor: "#00000000",
      ...(darwin
        ? {
            vibrancy: "under-window" as const,
            visualEffectState: "active" as const,
          }
        : {}),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: this.#options.preloadPath,
      },
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    // A renderer gone (out of memory on a huge list, a GPU fault) left the window blank: the Dock, the tray and a
    // second launch only showed the dead page again, while captures went on arriving for a panel it could not draw.
    window.webContents.on("render-process-gone", (_event, details) => this.#rendererLost(window, details.reason));
    // Reloaded (重新加载 after a render error), what the page had running in the main process went on: a PR review
    // refused every review after it, with no page left that knew how to stop it, and went on calling the model.
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.#options.onPageLeft?.();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("close", (event) => {
      if (this.#quitting) {
        return;
      }
      event.preventDefault();
      this.#presented = false;
      window.hide();
      this.#options.onCloseRequested?.();
    });
    this.#window = window;
    window.setNativeSurfaceMode?.("desktop");
    if (this.#options.renderer.kind === "url") {
      const url = new URL(this.#options.renderer.value);
      if (window.nativeGlassActive === true) {
        url.searchParams.set("nativeGlass", "1");
      }
      await window.loadURL(url.toString());
    } else {
      await window.loadFile(
        this.#options.renderer.value,
        window.nativeGlassActive === true
          ? { query: { nativeGlass: "1" } }
          : undefined,
      );
    }
  }

  show(): void {
    const window = this.#requireWindow();
    if (this.#blank) {
      this.#blank = false;
      window.webContents.reload();
    }
    if (this.#initialPresentation) {
      window.maximize();
      this.#initialPresentation = false;
    }
    this.#presented = true;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  hide(): void {
    this.#presented = false;
    this.#window?.hide();
  }

  /** Pushes to the renderer when a window is up; a silent no-op otherwise. */
  send(channel: string, payload: unknown): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  }

  publish(snapshot: AppSnapshot): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) {
      return;
    }
    this.send("decision:snapshot", snapshot);
    const hasActiveTask =
      snapshot.current !== null ||
      (snapshot.candidateReviewOpen &&
        snapshot.decisionCandidates.current !== null);
    const task =
      snapshot.current !== null
        ? snapshot.current.candidateId
        : snapshot.candidateReviewOpen
          ? (snapshot.decisionCandidates.current?.candidateId ?? null)
          : null;
    const arrived = task !== null && task !== this.#shownTask;
    this.#shownTask = task;
    if (snapshot.primarySurface === "hidden" && !hasActiveTask) {
      this.#presented = false;
      window.hide();
      return;
    }
    // Minimized, or hidden with ⌘H, the window still counts as presented: a capture arriving then is put in
    // front of the reader all the same, or it waited unseen. Once: refreshes of it do not undo a minimize.
    const outOfSight = window.isMinimized() || !window.isVisible();
    if (!this.#presented || (arrived && outOfSight)) this.show();
  }

  prepareToQuit(): void {
    this.#quitting = true;
  }

  #rendererLost(window: BrowserWindowLike, reason: string): void {
    if (this.#quitting || window.isDestroyed()) return;
    this.#options.onPageLeft?.();
    // On the monotonic clock: on the wall clock, losses before a clock set back an hour counted for that hour.
    const now = performance.now();
    this.#rendererLosses = [...this.#rendererLosses.filter((at) => now - at < 60_000), now];
    if (this.#rendererLosses.length <= RENDERER_RELOADS_PER_MINUTE) {
      window.webContents.reload();
      return;
    }
    this.#blank = true;
    this.#options.onRendererGone?.(reason);
  }

  #requireWindow(): BrowserWindowLike {
    if (this.#window === null || this.#window.isDestroyed()) {
      throw new Error("Decision window has not been created");
    }
    return this.#window;
  }
}
