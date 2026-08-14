import { DecisionCandidateQueue, RationaleQueue } from "@cognelis/decision-core";
import { describe, expect, it, vi } from "vitest";

import { AppController } from "../src/main/app-controller.js";
import type {
  AppHealth,
  DashboardSnapshot,
  PendingRationaleSummary,
} from "../src/shared/renderer-api.js";
import { serverCandidateFixture, serverCaptureFixture } from "./fixtures.js";

interface ControllerFixtureOptions {
  onIgnore?(): Promise<void>;
  dashboard?(): DashboardSnapshot;
  health?(): AppHealth;
  pendingRationales?(): PendingRationaleSummary[];
}

const createController = async (options: ControllerFixtureOptions = {}) => {
  let sequence = 0;
  const queue = new RationaleQueue(() => `rationale-${++sequence}`);
  const candidates = new DecisionCandidateQueue({
    onPromote: async (candidate) => {
      queue.ingestPrioritized(candidate.event);
    },
    onIgnore: options.onIgnore ?? (async () => undefined),
  });
  const publish = vi.fn();
  const controller = new AppController({
    queue,
    candidates,
    server: {
      start: vi.fn(async () => ({
        host: "127.0.0.1",
        port: 45_678,
      })),
      stop: vi.fn(async () => undefined),
    },
    watcher: {
      start: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    index: { close: vi.fn() },
    windows: {
      create: vi.fn(async () => undefined),
      publish,
      prepareToQuit: vi.fn(),
    },
    runtimeFile: "/runtime.json",
    token: "x".repeat(32),
    writeRuntime: vi.fn(async () => undefined),
    removeRuntime: vi.fn(async () => undefined),
    ...(options.dashboard === undefined
      ? {}
      : { dashboard: options.dashboard }),
    ...(options.health === undefined ? {} : { health: options.health }),
    ...(options.pendingRationales === undefined
      ? {}
      : { pendingRationales: options.pendingRationales }),
  });
  await controller.start();
  return { candidates, controller, publish, queue };
};

describe("AppController", () => {
  it("publishes one primary surface and dashboard read model at a time", async () => {
    const dashboard = {
      totalDecisions: 18,
      recorded7d: 4,
      reviewAttention: 2,
      recentDecisions: [],
    };
    const { controller } = await createController({
      dashboard: () => dashboard,
    });

    controller.openSurface("dashboard");
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "dashboard",
      dashboard,
    });

    controller.openSurface("settings");
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "settings",
    });

    controller.closePrimarySurface();
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "hidden",
    });

    controller.refresh();
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "hidden",
    });
  });

  it("reads index-backed queues before publishing index health", async () => {
    let indexDegraded = false;
    const { publish } = await createController({
      pendingRationales: () => {
        indexDegraded = true;
        return [];
      },
      health: () => ({
        index: indexDegraded ? "degraded" : "healthy",
        recovery: "healthy",
      }),
    });

    expect(publish.mock.calls[0]?.[0].health.index).toBe("degraded");
  });

  it("returns to the dashboard after candidate review is postponed", async () => {
    const { candidates, controller } = await createController();
    candidates.ingest(serverCandidateFixture());
    controller.openSurface("dashboard");

    controller.openCandidateReview();
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "hidden",
      candidateReviewOpen: true,
    });

    controller.closeCandidateReview();
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "dashboard",
      candidateReviewOpen: false,
    });
  });

  it("queues primary navigation without interrupting candidate review", async () => {
    const { candidates, controller } = await createController();
    candidates.ingest(serverCandidateFixture());
    controller.openSurface("dashboard");
    controller.openCandidateReview();

    controller.openSurface("settings");

    expect(controller.snapshot()).toMatchObject({
      primarySurface: "hidden",
      candidateReviewOpen: true,
    });

    controller.closeCandidateReview();
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "settings",
      candidateReviewOpen: false,
    });
  });

  it("returns to the dashboard after a promoted rationale is disposed", async () => {
    const { candidates, controller, queue } = await createController();
    const candidate = serverCandidateFixture();
    candidates.ingest(candidate);
    controller.openSurface("dashboard");
    controller.openCandidateReview();

    await controller.confirmCandidate(candidate.candidateId);
    expect(controller.snapshot().primarySurface).toBe("hidden");

    await queue.submit({ status: "skipped" });
    expect(controller.snapshot()).toMatchObject({
      primarySurface: "dashboard",
      candidateReviewOpen: false,
    });
  });

  it("publishes candidate changes and controls the review surface without consuming", async () => {
    const publish = vi.fn();
    const candidates = new DecisionCandidateQueue({
      onPromote: vi.fn(async () => undefined),
      onIgnore: vi.fn(async () => undefined),
    });
    const controller = new AppController({
      queue: new RationaleQueue(() => "candidate-1"),
      candidates,
      server: {
        start: vi.fn(async () => ({
          host: "127.0.0.1",
          port: 45_678,
        })),
        stop: vi.fn(async () => undefined),
      },
      watcher: {
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      index: { close: vi.fn() },
      windows: {
        create: vi.fn(async () => undefined),
        publish,
        prepareToQuit: vi.fn(),
      },
      runtimeFile: "/runtime.json",
      token: "x".repeat(32),
      writeRuntime: vi.fn(async () => undefined),
      removeRuntime: vi.fn(async () => undefined),
    });
    await controller.start();
    const candidate = serverCandidateFixture();

    candidates.ingest(candidate);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        candidateReviewOpen: false,
        decisionCandidates: {
          current: candidate,
          count: 1,
        },
      }),
    );

    controller.openCandidateReview();
    expect(controller.snapshot()).toMatchObject({
      candidateReviewOpen: true,
      decisionCandidates: {
        current: candidate,
        count: 1,
      },
    });
    expect(candidates.snapshot().current).toEqual(candidate);

    controller.closeCandidateReview();
    expect(controller.snapshot().candidateReviewOpen).toBe(false);
  });

  it("advances ignored candidates without closing the review session", async () => {
    const { candidates, controller } = await createController();
    const first = serverCandidateFixture();
    const second = {
      ...serverCandidateFixture(),
      candidateId: "candidate-server-2",
      createdAt: "2026-07-27T00:01:00.000Z",
    };
    candidates.ingest(first);
    candidates.ingest(second);
    controller.openCandidateReview();

    await controller.ignoreCandidate(first.candidateId);

    expect(controller.snapshot()).toMatchObject({
      candidateReviewOpen: true,
      candidateReviewProgress: { position: 2, total: 2 },
      decisionCandidates: {
        current: { candidateId: "candidate-server-2" },
        count: 1,
      },
    });
  });

  it("resumes the next review after the promoted rationale is disposed", async () => {
    const { candidates, controller, queue } = await createController();
    const first = serverCandidateFixture();
    const second = {
      ...serverCandidateFixture(),
      candidateId: "candidate-server-2",
      createdAt: "2026-07-27T00:01:00.000Z",
    };
    candidates.ingest(first);
    candidates.ingest(second);
    controller.openCandidateReview();

    await controller.confirmCandidate(first.candidateId);

    expect(controller.snapshot()).toMatchObject({
      candidateReviewOpen: false,
      current: {
        event: { sourceEventId: first.event.sourceEventId },
      },
    });

    await queue.submit({ status: "deferred" });

    expect(controller.snapshot()).toMatchObject({
      candidateReviewOpen: true,
      candidateReviewProgress: { position: 2, total: 2 },
      decisionCandidates: {
        current: { candidateId: "candidate-server-2" },
      },
    });
  });

  it("closes after the last ignored candidate", async () => {
    const { candidates, controller } = await createController();
    const only = serverCandidateFixture();
    candidates.ingest(only);
    controller.openCandidateReview();

    await controller.ignoreCandidate(only.candidateId);

    expect(controller.snapshot().candidateReviewOpen).toBe(false);
    expect(controller.snapshot().candidateReviewProgress).toBeNull();
  });

  it("keeps the session alive through the last promoted rationale so new arrivals can join", async () => {
    const { candidates, controller, queue } = await createController();
    const first = serverCandidateFixture();
    const late = {
      ...serverCandidateFixture(),
      candidateId: "candidate-server-late",
      createdAt: "2026-07-27T00:02:00.000Z",
    };
    candidates.ingest(first);
    controller.openCandidateReview();

    await controller.confirmCandidate(first.candidateId);
    candidates.ingest(late);
    await queue.submit({ status: "skipped" });

    expect(controller.snapshot()).toMatchObject({
      candidateReviewOpen: true,
      candidateReviewProgress: { position: 2, total: 2 },
      decisionCandidates: {
        current: { candidateId: "candidate-server-late" },
      },
    });
  });

  it("closes after the last promoted rationale is disposed", async () => {
    const { candidates, controller, queue } = await createController();
    const only = serverCandidateFixture();
    candidates.ingest(only);
    controller.openCandidateReview();

    await controller.confirmCandidate(only.candidateId);
    await queue.submit({ status: "skipped" });

    expect(controller.snapshot().candidateReviewOpen).toBe(false);
    expect(controller.snapshot().candidateReviewProgress).toBeNull();
  });

  it("keeps the current review open when persistence fails", async () => {
    const { candidates, controller } = await createController({
      onIgnore: async () => {
        throw new Error("candidate receipt failed");
      },
    });
    const candidate = serverCandidateFixture();
    candidates.ingest(candidate);
    controller.openCandidateReview();

    await expect(
      controller.ignoreCandidate(candidate.candidateId),
    ).rejects.toThrow(/Candidate persistence/u);

    expect(controller.snapshot()).toMatchObject({
      candidateReviewOpen: true,
      candidateReviewProgress: { position: 1, total: 1 },
      decisionCandidates: {
        current: { candidateId: candidate.candidateId },
        persistenceStatus: "failed",
      },
    });
  });

  it("publishes the current theme when refreshed", async () => {
    let theme: "auto" | "dark" = "auto";
    const publish = vi.fn();
    const controller = new AppController({
      queue: new RationaleQueue(() => "candidate-1"),
      server: {
        start: vi.fn(async () => ({ host: "127.0.0.1", port: 45_678 })),
        stop: vi.fn(async () => undefined),
      },
      watcher: {
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      index: { close: vi.fn() },
      windows: {
        create: vi.fn(async () => undefined),
        publish,
        prepareToQuit: vi.fn(),
      },
      runtimeFile: "/runtime.json",
      token: "x".repeat(32),
      writeRuntime: vi.fn(async () => undefined),
      removeRuntime: vi.fn(async () => undefined),
      theme: () => theme,
    });
    await controller.start();
    theme = "dark";

    controller.refresh();

    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
  });

  it("includes the current semantic recognition status in snapshots", async () => {
    const semanticRecognition = {
      provider: "qwen" as const,
      providerLabel: "Qwen 本地模型",
      availability: "available" as const,
      mode: "hybrid" as const,
      modelVersion: "qwen3.5-2b-q4-k-m",
      promptVersion: "semantic-v1",
      processed7d: 12,
      high7d: 4,
      medium7d: 3,
      failures7d: 0,
      updatedAt: "2026-07-27T10:00:00.000Z",
    };
    const controller = new AppController({
      queue: new RationaleQueue(() => "candidate-1"),
      server: {
        start: vi.fn(async () => ({
          host: "127.0.0.1",
          port: 45_678,
        })),
        stop: vi.fn(async () => undefined),
      },
      watcher: {
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      },
      index: { close: vi.fn() },
      windows: {
        create: vi.fn(async () => undefined),
        publish: vi.fn(),
        prepareToQuit: vi.fn(),
      },
      runtimeFile: "/runtime.json",
      token: "x".repeat(32),
      writeRuntime: vi.fn(async () => undefined),
      removeRuntime: vi.fn(async () => undefined),
      semanticRecognition: () => semanticRecognition,
    });

    expect(controller.snapshot().semanticRecognition).toEqual(
      semanticRecognition,
    );
  });

  it("starts services, publishes snapshots, and writes the runtime descriptor", async () => {
    const events: string[] = [];
    const queue = new RationaleQueue(() => "candidate-1");
    const controller = new AppController({
      queue,
      server: {
        start: vi.fn(async () => {
          events.push("server:start");
          return { host: "127.0.0.1", port: 45_678 };
        }),
        stop: vi.fn(async () => {
          events.push("server:stop");
        }),
      },
      watcher: {
        start: vi.fn(async () => {
          events.push("watcher:start");
        }),
        close: vi.fn(async () => {
          events.push("watcher:close");
        }),
      },
      index: {
        close: vi.fn(() => events.push("index:close")),
      },
      windows: {
        create: vi.fn(async () => {
          events.push("windows:create");
        }),
        publish: vi.fn(),
        prepareToQuit: vi.fn(() => events.push("windows:quit")),
      },
      runtimeFile: "/runtime.json",
      token: "x".repeat(32),
      writeRuntime: vi.fn(async (_path, descriptor) => {
        expect(descriptor).toMatchObject({
          protocolVersion: 1,
          port: 45_678,
          token: "x".repeat(32),
        });
        events.push("runtime:write");
      }),
      removeRuntime: vi.fn(async () => {
        events.push("runtime:remove");
      }),
      now: () => new Date("2026-07-24T01:02:03.000Z"),
      pid: 4242,
    });

    await controller.start();
    queue.ingest(serverCaptureFixture());

    expect(events.slice(0, 4)).toEqual([
      "watcher:start",
      "windows:create",
      "server:start",
      "runtime:write",
    ]);
    expect(controller.isStarted()).toBe(true);
  });

  it("shuts down in deterministic order and is idempotent", async () => {
    const events: string[] = [];
    const controller = new AppController({
      queue: new RationaleQueue(() => "candidate-1"),
      server: {
        start: vi.fn(async () => ({ host: "127.0.0.1", port: 45_678 })),
        stop: vi.fn(async () => {
          events.push("server");
        }),
      },
      watcher: {
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => {
          events.push("watcher");
        }),
      },
      index: { close: vi.fn(() => events.push("index")) },
      windows: {
        create: vi.fn(async () => undefined),
        publish: vi.fn(),
        prepareToQuit: vi.fn(() => events.push("windows")),
      },
      runtimeFile: "/runtime.json",
      token: "x".repeat(32),
      writeRuntime: vi.fn(async () => undefined),
      removeRuntime: vi.fn(async () => {
        events.push("runtime");
      }),
    });
    await controller.start();

    await controller.stop();
    await controller.stop();

    expect(events).toEqual([
      "windows",
      "watcher",
      "server",
      "index",
      "runtime",
    ]);
    expect(controller.isStarted()).toBe(false);
  });

  it("removes runtime state even when a shutdown step fails", async () => {
    const events: string[] = [];
    const controller = new AppController({
      queue: new RationaleQueue(() => "candidate-1"),
      server: {
        start: vi.fn(async () => ({ host: "127.0.0.1", port: 45_678 })),
        stop: vi.fn(async () => {
          events.push("server");
          throw new Error("server stop failed");
        }),
      },
      watcher: {
        start: vi.fn(async () => undefined),
        close: vi.fn(async () => {
          events.push("watcher");
        }),
      },
      index: { close: vi.fn(() => events.push("index")) },
      windows: {
        create: vi.fn(async () => undefined),
        publish: vi.fn(),
        prepareToQuit: vi.fn(() => events.push("windows")),
      },
      runtimeFile: "/runtime.json",
      token: "x".repeat(32),
      writeRuntime: vi.fn(async () => undefined),
      removeRuntime: vi.fn(async () => {
        events.push("runtime");
      }),
    });
    await controller.start();

    await expect(controller.stop()).rejects.toThrow(/server stop failed/u);

    expect(events).toEqual([
      "windows",
      "watcher",
      "server",
      "index",
      "runtime",
    ]);
  });
});
