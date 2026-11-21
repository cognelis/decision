import { describe, expect, it, vi } from "vitest";

import { shutdownApplication } from "../src/main/application-shutdown.js";
import { LocalEmbeddingClient, LocalModelHost } from "../src/main/semantic/local-model-client.js";
import type { LocalModelReply } from "../src/main/semantic/local-model-host.js";

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
};

describe("application shutdown", () => {
  it("does not cut accepted local writes off at the controller timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let release!: () => void;
      const writes = new Promise<void>(resolve => { release = resolve; });
      const stopController = vi.fn(async () => undefined);
      const closeLocalModels = vi.fn(async () => undefined);
      let ended = false;
      const closing = shutdownApplication({ closeObsidian: async () => undefined, flushSemanticPairs: async () => undefined,
        closeSemanticCoordinator: async () => undefined, closeDecisionSemanticSearch: async () => undefined,
        closeLocalModels, flushOrganization: () => writes, stopController }).then(() => { ended = true; });
      await vi.advanceTimersByTimeAsync(15000);
      const endedBeforeWrites = ended; const stoppedBeforeWrites = stopController.mock.calls.length;
      release(); await closing;
      expect(endedBeforeWrites).toBe(false); expect(stoppedBeforeWrites).toBe(0);
      expect(closeLocalModels).toHaveBeenCalledOnce(); expect(stopController).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("stops the controller and ends within its deadline when a stage never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stopController = vi.fn(async () => undefined);
      let ended = false;
      void shutdownApplication({
        closeObsidian: async () => undefined,
        // Never ends.
        flushSemanticPairs: () => new Promise<void>(() => undefined),
        closeSemanticCoordinator: async () => undefined,
        closeDecisionSemanticSearch: async () => undefined,
        closeLocalModels: async () => undefined,
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

  it("waits for the local models' process to close, the server stopped meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stopController = vi.fn(async () => undefined);
      let ended = false;
      void shutdownApplication({
        closeObsidian: async () => undefined,
        flushSemanticPairs: async () => undefined,
        closeSemanticCoordinator: async () => undefined,
        closeDecisionSemanticSearch: async () => undefined,
        // Its grace and the kill after it: six seconds at most.
        closeLocalModels: () => new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
        stopController,
      }).then(() => {
        ended = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(stopController).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes the knowledge page's marker when its model's close comes after the local models' shutdown", async () => {
    const host = new LocalModelHost({
      spawn: () => {
        let reply = (_reply: LocalModelReply): void => undefined;
        let exit = (_code: number | null): void => undefined;
        return {
          postMessage: (message) => {
            if (message.op === "shutdown") setImmediate(() => exit(0));
            else if ("id" in message) setImmediate(() => reply({ id: message.id, ok: true, value: { model: "m", vectors: [[1]] } }));
          },
          onMessage: (listener) => { reply = listener; },
          onExit: (listener) => { exit = listener; },
          kill: () => exit(null),
        };
      },
      log: () => undefined,
    });
    const notes = new LocalEmbeddingClient(host, { modelsDirectory: "/models" });
    await notes.embed(["笔记"]);
    let shutdownStarted = (): void => undefined;
    const shutdownBegun = new Promise<void>((resolve) => { shutdownStarted = resolve; });
    const writeMarker = vi.fn(async () => undefined);

    await shutdownApplication({
      // The knowledge page first waits on its watcher and its own operations: its model's close reaches the client
      // after the process was told to shut down, and refused, it failed the close and no marker was written.
      closeObsidian: async () => {
        await shutdownBegun;
        await notes.close();
      },
      writeObsidianMarker: writeMarker,
      flushSemanticPairs: async () => undefined,
      closeSemanticCoordinator: async () => undefined,
      closeDecisionSemanticSearch: async () => undefined,
      closeLocalModels: () => {
        const closed = host.shutdown();
        shutdownStarted();
        return closed;
      },
      stopController: async () => undefined,
    });

    expect(writeMarker).toHaveBeenCalledOnce();
  });

  it("still ends at its limit when a model close never does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let ended = false;
      void shutdownApplication({
        closeObsidian: async () => undefined,
        flushSemanticPairs: async () => undefined,
        closeSemanticCoordinator: () => new Promise<void>(() => undefined),
        closeDecisionSemanticSearch: async () => undefined,
        closeLocalModels: async () => undefined,
        stopController: async () => undefined,
      }).then(() => {
        ended = true;
      });

      await vi.advanceTimersByTimeAsync(11_000);
      expect(ended).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
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
      closeLocalModels: async () => undefined,
      stopController: async () => { order.push("controller"); },
    });

    // The model calls are cut short before the pair being classified is waited on: waited on first, a quit held
    // for as long as that call took (half a minute, a billed CLI among them), with every other call left running.
    expect(order).toEqual(["coordinator", "decision-search", "obsidian", "inbox-start"]);
    await waitUntil(() => order.includes("marker"));
    expect(order).toEqual(["coordinator", "decision-search", "obsidian", "inbox-start", "marker"]);
    releaseInbox?.();
    await shutdown;
    expect(order).toEqual([
      "coordinator",
      "decision-search",
      "obsidian",
      "inbox-start",
      "marker",
      "inbox-finish",
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
      closeLocalModels: async () => undefined,
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
      closeLocalModels: async () => undefined,
      stopController,
    });

    expect(closeSearch).toHaveBeenCalledOnce();
    expect(stopController).toHaveBeenCalledOnce();
  });
});
