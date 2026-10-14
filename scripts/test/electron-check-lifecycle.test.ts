import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
const { createElectronCheckLifecycle } = createRequire(import.meta.url)("../electron-check-lifecycle.cjs");
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); vi.useRealTimers(); });
const setup = (shutdown = async () => undefined) => {
  vi.useFakeTimers();
  const app = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const runtime = Object.assign(new EventEmitter(), { ppid: 12345, kill: vi.fn(), stderr: { write: vi.fn() } });
  const window = { isDestroyed: () => false, destroy: vi.fn() };
  const server = { close: vi.fn(shutdown) };
  const close = createElectronCheckLifecycle({ app, runtime, getWindow: () => window, getServer: () => server });
  disposers.push(async () => { void close(0); await vi.advanceTimersByTimeAsync(1100); });
  return { app, runtime, window, server, close };
};
describe("Electron probe shutdown", () => {
  it("destroys the window, closes the server and removes shutdown listeners", async () => {
    const { close, app, runtime, window, server } = setup();
    await close(0);
    expect(window.destroy).toHaveBeenCalledOnce(); expect(server.close).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
    expect(app.listenerCount("before-quit")).toBe(0);
  });
  it("forces a failure exit when the server never closes, without reentering shutdown", async () => {
    const { close, app, server, runtime } = setup(() => new Promise<void>(() => {}));
    void close(0); void close(1); runtime.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(1000);
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(server.close).toHaveBeenCalledOnce();
    expect(runtime.listenerCount("SIGTERM")).toBe(0);
  });
  it.each([["SIGTERM", 143], ["SIGINT", 130]])("handles %s even when cleanup rejects", async (signal, code) => {
    const { app, runtime } = setup(async () => { throw new Error("close failed"); });
    runtime.emit(signal); await vi.advanceTimersByTimeAsync(0);
    expect(app.exit).toHaveBeenCalledWith(code);
  });
  it("detects a disappeared parent even when its recorded PID does not change", async () => {
    const { runtime, app } = setup();
    runtime.kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await vi.advanceTimersByTimeAsync(500);
    expect(app.exit).toHaveBeenCalledWith(1);
  });
  it("handles Dock quit and exits if its parent disappears", async () => {
    const quit = setup(); const event = { preventDefault: vi.fn() };
    quit.app.emit("before-quit", event); await vi.advanceTimersByTimeAsync(0);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(quit.app.exit).toHaveBeenCalledWith(0);
    const orphan = setup(); orphan.runtime.ppid = 1;
    await vi.advanceTimersByTimeAsync(500);
    expect(orphan.app.exit).toHaveBeenCalledWith(1);
  });
});
