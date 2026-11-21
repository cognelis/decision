import type { AppSnapshot } from "../shared/renderer-api.js";
import {
  DESKTOP_WINDOW_MIN_SIZE,
  DESKTOP_WINDOW_SIZE,
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
  roundedCorners: boolean;
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  resizable: boolean;
  maximizable: boolean;
  fullscreenable: boolean;
  show: boolean;
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
  webContents: {
    on(event: "will-navigate", listener: (event: NavigationEvent) => void): void;
    on(event: "did-start-navigation", listener: (details: NavigationStart) => void): void;
    on(event: "render-process-gone", listener: (event: unknown, details: RendererGoneDetails) => void): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    send(channel: string, value: unknown): void;
    reload(): void;
  };
  loadURL(url: string): Promise<void>;
  loadFile(path: string): Promise<void>;
  on(event: "close", listener: (event: CloseEvent) => void): void;
  maximize(): void;
  show(): void;
  showInactive(): void;
  focus(): void;
  hide(): void;
  // Required: left optional, the production adapter left them out, and a minimized or ⌘H-hidden window read as in view.
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
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
  /**
   * How the window comes up. `visible` (the reader's app): maximized the first time, in front, focused. A run started
   * by a script (smoke) leaves the reader at work: `hidden` never puts it on screen, `inactive` shows it behind the
   * app in front, as it is, unfocused. The page loads all the same either way.
   */
  presentation?: "visible" | "inactive" | "hidden";
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
  /** The captured decision last put before the reader, or its failed save: a new one is brought forward even when minimized. */
  #shownTask: string | null = null;
  /** Closed by the reader: kept closed until the next capture comes up, or the reader brings it back (show). */
  #closedByReader = false;
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
      this.#closedByReader = true;
      window.hide();
      this.#options.onCloseRequested?.();
    });
    this.#window = window;
    if (this.#options.renderer.kind === "url") {
      await window.loadURL(this.#options.renderer.value);
    } else {
      await window.loadFile(this.#options.renderer.value);
    }
  }

  show(): void {
    const window = this.#requireWindow();
    if (this.#blank) {
      this.#blank = false;
      window.webContents.reload();
    }
    const presentation = this.#options.presentation ?? "visible";
    if (this.#initialPresentation && presentation === "visible") window.maximize();
    this.#initialPresentation = false;
    this.#presented = true;
    this.#closedByReader = false;
    if (presentation === "hidden") return;
    if (window.isMinimized()) window.restore();
    if (presentation === "inactive") {
      window.showInactive();
      return;
    }
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
    // A save that fails comes up as a task of its own: closed while it was written, the window stayed closed, why it
    // failed said in it alone, and the one that failed held the queue, so no capture came up to bring it back.
    const failed = snapshot.current?.status === "completed" && snapshot.persistenceStatus === "failed";
    const task =
      snapshot.current !== null
        ? `${snapshot.current.candidateId}${failed ? " failed" : ""}`
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
    // Closed while a capture waited, or 待处理 was open: shown again at once by the close's own refresh, focus
    // taken, it could not be put away; nor did a 待处理 session ending meanwhile bring it up with nothing to do.
    // Closed, it comes back for the next capture to come up (one queued behind the current waits, as when
    // minimized), or when the reader asks (show). Said apart from outOfSight: on macOS that reads ⌘H alone, and a
    // closed window reads as in view.
    if ((!this.#presented && (!this.#closedByReader || arrived)) || (arrived && outOfSight)) this.show();
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
      throw new Error("Paraself window has not been created");
    }
    return this.#window;
  }
}
