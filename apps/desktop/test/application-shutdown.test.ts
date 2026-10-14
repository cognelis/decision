import { describe, expect, it, vi } from "vitest";

import { shutdownApplication } from "../src/main/application-shutdown.js";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
};

describe("application shutdown", () => {
  it("stops the controller and ends within its deadline when a stage never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stopController = vi.fn(async () => undefined);
      let ended = false;
      void shutdownApplication({
        closeObsidian: async () => undefined,
        flushSemanticPairs: async () => undefined,
        closeSemanticCoordinator: async () => undefined,
        // A model call deaf to its abort: it never ends.
        closeDecisionSemanticSearch: () => new Promise<void>(() => undefined),
        stopController,
      }).then(() => {
        ended = true;
      });

      // Held by it, the quit never came, and the server and the bridge's descriptor stayed up behind it.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(stopController).toHaveBeenCalledOnce();
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts Obsidian close immediately and writes its marker while semantic cleanup is blocked", async () => {
    const order: string[] = [];
    let releaseInbox: (() => void) | undefined;
    const blockedInbox = new Promise<void>((resolve) => {
      releaseInbox = resolve;
    });
    const shutdown = shutdownApplication({
      closeObsidian: async () => { order.push("obsidian"); },
      writeObsidianMarker: async () => { order.push("marker"); },
      flushSemanticPairs: async () => {
        order.push("inbox-start");
        await blockedInbox;
        order.push("inbox-finish");
      },
      closeSemanticCoordinator: async () => { order.push("coordinator"); },
      closeDecisionSemanticSearch: async () => { order.push("decision-search"); },
      stopController: async () => { order.push("controller"); },
    });

    // The model calls are cut short before the pair being classified is waited on: waited on first, a quit held
    // for as long as that call took (half a minute, a billed CLI among them), with every other call left running.
    expect(order).toEqual(["obsidian", "inbox-start", "coordinator"]);
    await waitUntil(() => order.includes("marker"));
    expect(order).toEqual(["obsidian", "inbox-start", "coordinator", "marker"]);
    releaseInbox?.();
    await shutdown;
    expect(order).toEqual([
      "obsidian",
      "inbox-start",
      "coordinator",
      "marker",
      "inbox-finish",
      "decision-search",
      "controller",
    ]);
  });

  it("never writes a marker for failed Obsidian close and still runs later cleanup", async () => {
    const writeMarker = vi.fn(async () => undefined);
    const closeSearch = vi.fn(async () => undefined);
    const stopController = vi.fn(async () => undefined);

    await shutdownApplication({
      closeObsidian: async () => {
        throw new Error("private close failure");
      },
      writeObsidianMarker: writeMarker,
      flushSemanticPairs: async () => undefined,
      closeSemanticCoordinator: async () => undefined,
      closeDecisionSemanticSearch: closeSearch,
      stopController,
    });

    expect(writeMarker).not.toHaveBeenCalled();
    expect(closeSearch).toHaveBeenCalledOnce();
    expect(stopController).toHaveBeenCalledOnce();
  });

  it("continues shutdown when marker persistence fails", async () => {
    const closeSearch = vi.fn(async () => undefined);
    const stopController = vi.fn(async () => undefined);

    await shutdownApplication({
      closeObsidian: async () => undefined,
      writeObsidianMarker: async () => {
        throw new Error("marker unavailable");
      },
      flushSemanticPairs: async () => undefined,
      closeSemanticCoordinator: async () => undefined,
      closeDecisionSemanticSearch: closeSearch,
      stopController,
    });

    expect(closeSearch).toHaveBeenCalledOnce();
    expect(stopController).toHaveBeenCalledOnce();
  });
});
