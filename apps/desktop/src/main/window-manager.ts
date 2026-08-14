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

export interface BrowserWindowLike {
  nativeGlassActive?: boolean;
  webContents: {
    on(event: "will-navigate", listener: (event: NavigationEvent) => void): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    send(channel: string, value: unknown): void;
  };
  loadURL(url: string): Promise<void>;
  loadFile(
    path: string,
    options?: { query?: Record<string, string> },
  ): Promise<void>;
  on(event: "close", listener: (event: CloseEvent) => void): void;
  show(): void;
  focus(): void;
  hide(): void;
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
}

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
  #quitting = false;

  constructor(options: WindowManagerOptions) {
    this.#options = options;
  }

  async create(): Promise<void> {
    if (this.#window !== null && !this.#window.isDestroyed()) {
      return;
    }
    this.#presented = false;
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
    this.#presented = true;
    window.show();
    window.focus();
  }

  hide(): void {
    this.#presented = false;
    this.#window?.hide();
  }

  publish(snapshot: AppSnapshot): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) {
      return;
    }
    window.webContents.send("decision:snapshot", snapshot);
    const hasActiveTask =
      snapshot.current !== null ||
      (snapshot.candidateReviewOpen &&
        snapshot.decisionCandidates.current !== null);
    if (snapshot.primarySurface === "hidden" && !hasActiveTask) {
      this.#presented = false;
      window.hide();
      return;
    }
    if (!this.#presented) {
      this.#presented = true;
      window.show();
      window.focus();
    }
  }

  prepareToQuit(): void {
    this.#quitting = true;
  }

  #requireWindow(): BrowserWindowLike {
    if (this.#window === null || this.#window.isDestroyed()) {
      throw new Error("Decision window has not been created");
    }
    return this.#window;
  }
}
