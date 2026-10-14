import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC_CHANNELS,
  RENDERER_METHOD_NAMES,
} from "../src/shared/renderer-api.js";

/**
 * The preload bridge is the one seam no other test covers: a method the
 * renderer API declares but the bridge never exposes, or a channel the bridge
 * invokes that the shared contract never names, compiles and unit-tests
 * cleanly and then does nothing at all at runtime. That is exactly the shape of
 * "点问答没反应" — the surface existed everywhere except where it mattered.
 */

let exposed: Record<string, unknown> = {};
const invoked: string[] = [];
const subscribed: string[] = [];
// A failure the next call meets in the main process, as Electron hands it over.
let failure: Error | null = null;

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, value: Record<string, unknown>) => {
      exposed = value;
    },
  },
  ipcRenderer: {
    invoke: (channel: string) => {
      invoked.push(channel);
      const next = failure;
      failure = null;
      return next === null ? Promise.resolve(undefined) : Promise.reject(next);
    },
    on: (channel: string) => {
      subscribed.push(channel);
    },
    removeListener: () => undefined,
  },
}));

const loadBridge = async (): Promise<Record<string, unknown>> => {
  exposed = {};
  invoked.length = 0;
  subscribed.length = 0;
  vi.resetModules();
  await import("../src/preload/index.js");
  return exposed;
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preload bridge", () => {
  it("exposes every method the renderer API declares, and nothing more", async () => {
    const api = await loadBridge();

    expect(Object.keys(api).sort()).toEqual([...RENDERER_METHOD_NAMES].sort());
  });

  it("freezes the bridge so the page cannot reshape it", async () => {
    const api = await loadBridge();

    expect(Object.isFrozen(api)).toBe(true);
  });

  it("hands a failure in the main process on in its own words, without Electron's prefix", async () => {
    const api = await loadBridge();
    failure = new Error(
      "Error invoking remote method 'decision:createMethodologyRevisionDraft': Error: 这条原则已经有一个待处理的修订候选。",
    );
    const create = api.createMethodologyRevisionDraft as (...args: unknown[]) => Promise<unknown>;
    await expect(create("principle-1", {})).rejects.toThrow(/^这条原则已经有一个待处理的修订候选。$/u);
  });

  it("reaches only channels the shared contract names", async () => {
    const api = await loadBridge();
    const known = new Set<string>(Object.values(IPC_CHANNELS));

    for (const name of RENDERER_METHOD_NAMES) {
      const method = api[name];
      expect(typeof method).toBe("function");
      // Arguments are irrelevant here: the mock records the channel without
      // validating anything, and validation is the main process's job.
      const call = (method as (...args: unknown[]) => unknown)(
        undefined,
        undefined,
      );
      void Promise.resolve(call).catch(() => undefined);
    }

    // Listener-style methods register and request-style methods invoke, so
    // every declared method must have reached exactly one named channel.
    expect(invoked.length + subscribed.length).toBe(
      RENDERER_METHOD_NAMES.length,
    );
    for (const channel of [...invoked, ...subscribed]) {
      expect(known).toContain(channel);
    }
  });
});
