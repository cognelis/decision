import type {
  CapturedDecisionCandidate,
  CapturedDecisionEvent,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  CandidatePersistenceError,
  DecisionCandidateQueue,
} from "../src/index.js";

const candidateFixture = (
  id: string,
  createdAt: string,
): CapturedDecisionCandidate => {
  const event: CapturedDecisionEvent = {
    eventVersion: 1,
    captureMode: "transcript",
    sourceClient: "codex",
    sessionId: "session-1",
    sourceEventId: `event-${id}`,
    batchId: `batch-${id}`,
    project: "decision",
    cwd: "/tmp/decision",
    capturedAt: createdAt,
    detection: {
      band: "medium",
      score: 62,
      detectorVersion: "rules-v1",
      signals: ["awaits_confirmation"],
    },
    questions: [
      {
        questionIndex: 0,
        question: "现在继续吗？",
        options: [],
        answer: { kind: "custom", values: ["可以"] },
        multiSelect: false,
      },
    ],
  };
  return {
    candidateVersion: 1,
    candidateId: id,
    createdAt,
    expiresAt: "2026-08-03T00:00:00.000Z",
    event,
  };
};

describe("DecisionCandidateQueue", () => {
  it("drops expired candidates and enforces the in-memory capacity", () => {
    let now = new Date("2026-07-27T12:00:00.000Z");
    const queue = new DecisionCandidateQueue({
      onPromote: vi.fn(async () => undefined),
      onIgnore: vi.fn(async () => undefined),
      maximumItems: 2,
      now: () => now,
    });
    const expired = {
      ...candidateFixture(
        "candidate-expired",
        "2026-07-20T00:00:00.000Z",
      ),
      expiresAt: "2026-07-27T11:59:59.000Z",
    };
    const first = candidateFixture(
      "candidate-1",
      "2026-07-27T00:00:00.000Z",
    );
    const second = candidateFixture(
      "candidate-2",
      "2026-07-27T00:01:00.000Z",
    );
    const third = candidateFixture(
      "candidate-3",
      "2026-07-27T00:02:00.000Z",
    );

    expect(queue.ingest(expired)).toBe(false);
    queue.ingest(first);
    queue.ingest(second);
    queue.ingest(third);
    expect(queue.snapshot()).toEqual({
      current: second,
      count: 2,
    });

    now = new Date("2026-08-04T00:00:00.000Z");
    expect(queue.snapshot()).toEqual({
      current: null,
      count: 0,
    });
  });

  it("evicts the globally oldest candidate when arrivals are out of order", () => {
    const queue = new DecisionCandidateQueue({
      onPromote: vi.fn(async () => undefined),
      onIgnore: vi.fn(async () => undefined),
      maximumItems: 2,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    const first = candidateFixture(
      "candidate-1",
      "2026-07-27T01:00:00.000Z",
    );
    const second = candidateFixture(
      "candidate-2",
      "2026-07-27T02:00:00.000Z",
    );
    const lateOldest = candidateFixture(
      "candidate-0",
      "2026-07-27T00:00:00.000Z",
    );

    queue.ingest(first);
    queue.ingest(second);
    queue.ingest(lateOldest);

    expect(queue.snapshot()).toEqual({
      current: first,
      count: 2,
    });
    expect(queue.snapshot().current).not.toEqual(lateOldest);
  });

  it("queues candidates FIFO, deduplicates IDs, and publishes snapshots", () => {
    const snapshots: unknown[] = [];
    const queue = new DecisionCandidateQueue({
      onPromote: vi.fn(async () => undefined),
      onIgnore: vi.fn(async () => undefined),
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    queue.subscribe((snapshot) => snapshots.push(snapshot));
    const first = candidateFixture(
      "candidate-1",
      "2026-07-27T00:00:00.000Z",
    );
    const second = candidateFixture(
      "candidate-2",
      "2026-07-27T00:01:00.000Z",
    );

    expect(queue.ingest(first)).toBe(true);
    expect(queue.ingest(first)).toBe(false);
    expect(queue.ingest(second)).toBe(true);

    expect(queue.snapshot()).toEqual({
      current: first,
      count: 2,
    });
    expect(() => JSON.stringify(snapshots)).not.toThrow();
  });

  it("promotes or ignores only the current candidate and advances", async () => {
    const onPromote = vi.fn(async () => undefined);
    const onIgnore = vi.fn(async () => undefined);
    const queue = new DecisionCandidateQueue({
      onPromote,
      onIgnore,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    const first = candidateFixture(
      "candidate-1",
      "2026-07-27T00:00:00.000Z",
    );
    const second = candidateFixture(
      "candidate-2",
      "2026-07-27T00:01:00.000Z",
    );
    queue.ingest(first);
    queue.ingest(second);

    await expect(
      queue.promote("not-current"),
    ).rejects.toThrow(/current/u);
    await queue.promote(first.candidateId);
    expect(onPromote).toHaveBeenCalledWith(first);
    expect(queue.snapshot().current).toEqual(second);

    await queue.ignore(second.candidateId);
    expect(onIgnore).toHaveBeenCalledWith(second);
    expect(queue.snapshot()).toEqual({
      current: null,
      count: 0,
    });
  });

  it("retains a candidate when persistence fails and retries the same action", async () => {
    let attempts = 0;
    const candidate = candidateFixture(
      "candidate-1",
      "2026-07-27T00:00:00.000Z",
    );
    const queue = new DecisionCandidateQueue({
      onPromote: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("temporary disk failure");
        }
      },
      onIgnore: vi.fn(async () => undefined),
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    queue.ingest(candidate);

    await expect(
      queue.promote(candidate.candidateId),
    ).rejects.toBeInstanceOf(CandidatePersistenceError);
    expect(queue.snapshot()).toEqual({
      current: candidate,
      count: 1,
      persistenceStatus: "failed",
    });

    await queue.retryCurrentPersistence();

    expect(attempts).toBe(2);
    expect(queue.snapshot()).toEqual({
      current: null,
      count: 0,
    });
  });
});
