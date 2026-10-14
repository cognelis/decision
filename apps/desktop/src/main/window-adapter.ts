import type { BrowserWindow } from "electron";

import type { LiquidGlassSurface } from "./liquid-glass.js";
import type { BrowserWindowLike } from "./window-manager.js";

/**
 * Electron's window as WindowManager drives it. `appHidden`, on macOS, says whether the app was hidden with ⌘H: there
 * a window's own isVisible() is also false when other windows merely cover it (a terminal running the agent in front),
 * and a capture arriving then pulled the window forward and took the focus from where the reader was typing.
 */
export const adaptWindow = (
  window: BrowserWindow,
  nativeGlass: LiquidGlassSurface | null,
  appHidden?: () => boolean,
): BrowserWindowLike => ({
  nativeGlassActive: nativeGlass !== null,
  webContents: {
    // Each event as Electron emits it: only will-navigate was ever passed on, whatever was asked for.
    on: (event: string, listener: (...args: never[]) => void) => {
      (window.webContents as NodeJS.EventEmitter).on(event, listener as (...args: unknown[]) => void);
    },
    setWindowOpenHandler: (handler) => {
      window.webContents.setWindowOpenHandler(() => handler());
    },
    send: (channel, value) => {
      window.webContents.send(channel, value);
    },
    reload: () => window.webContents.reload(),
  },
  loadURL: (url) => window.loadURL(url),
  loadFile: (path, options) => window.loadFile(path, options),
  on: (_event, listener) => {
    window.on("close", (event) => listener(event));
  },
  maximize: () => window.maximize(),
  show: () => window.show(),
  focus: () => window.focus(),
  hide: () => window.hide(),
  // Left out, a window minimized (⌘M) or hidden with ⌘H read as in view, and a capture arriving then waited unseen.
  isMinimized: () => window.isMinimized(),
  isVisible: appHidden === undefined ? () => window.isVisible() : () => !appHidden(),
  restore: () => window.restore(),
  setNativeSurfaceMode: (mode) => nativeGlass?.update(mode),
  isDestroyed: () => window.isDestroyed(),
});
