import { describe, expect, it, vi } from "vitest";

import {
  DecisionPersistenceError,
  RationaleQueue,
} from "../src/index.js";
import {
  captureFixture,
  questionFixture,
} from "./fixtures.js";

describe("RationaleQueue", () => {
  it("splits a batch into FIFO candidates and deduplicates replays", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const event = captureFixture({
      questions: [questionFixture(0), questionFixture(1)],
    });

    expect(queue.ingest(event)).toEqual({ accepted: 2, duplicates: 0 });
    expect(queue.ingest(event)).toEqual({ accepted: 0, duplicates: 2 });
    expect(queue.snapshot()).toMatchObject({
      current: {
        status: "awaiting_rationale",
        candidateId: "candidate-1",
        question: { questionIndex: 0 },
      },
      waitingCount: 1,
    });
  });

  it("temporarily prioritizes a reviewed rationale and then resumes FIFO", async () => {
    let sequence = 0;
    const queue = new RationaleQueue(
      () => `candidate-${++sequence}`,
    );
    const existing = captureFixture({
      sourceEventId: "existing",
      toolUseId: "existing",
      batchId: "existing",
    });
    const reviewed = captureFixture({
      sourceEventId: "reviewed",
      toolUseId: "reviewed",
      batchId: "reviewed",
    });

    queue.ingest(existing);
    queue.ingestPrioritized(reviewed);

    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-2",
        event: { sourceEventId: "reviewed" },
      },
      waitingCount: 1,
    });

    await queue.submit({ status: "skipped" });

    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-1",
        event: { sourceEventId: "existing" },
      },
      waitingCount: 0,
    });
  });

  it("deduplicates the same native answer across structured and transcript capture", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const structured = captureFixture();
    const { toolUseId: _toolUseId, ...transcript } = captureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    expect(queue.ingest(structured)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(queue.ingestDetailed(transcript)).toEqual({
      receipt: {
        accepted: 0,
        duplicates: 1,
      },
      crossModeDuplicates: [
        {
          primaryCandidateId: "candidate-1",
          event: transcript,
          question: transcript.questions[0],
        },
      ],
    });
    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-1",
        event: { captureMode: "structured_tool" },
      },
      waitingCount: 0,
    });
  });

  it("does not semantically deduplicate separate sessions", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const structured = captureFixture();
    const { toolUseId: _toolUseId, ...transcript } = captureFixture({
      captureMode: "transcript",
      sessionId: "another-session",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    expect(queue.ingest(structured)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(queue.ingest(transcript)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
  });

  it("promotes a transcript candidate when structured capture arrives later", () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const structured = captureFixture();
    const { toolUseId: _toolUseId, ...transcript } = captureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    expect(queue.ingest(transcript)).toEqual({
      accepted: 1,
      duplicates: 0,
    });
    expect(queue.ingestDetailed(structured)).toMatchObject({
      receipt: {
        accepted: 0,
        duplicates: 1,
      },
      crossModeDuplicates: [
        {
          primaryCandidateId: "candidate-1",
          event: transcript,
          question: transcript.questions[0],
        },
      ],
    });
    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-1",
        event: { captureMode: "structured_tool" },
      },
      waitingCount: 0,
    });
  });

  it.each(
    ["captured", "deferred", "skipped", "not_recorded"] as const,
  )(
    "disposes a candidate as %s without waiting for an agent",
    async (status) => {
      const onDisposition = vi.fn(async () => undefined);
      const queue = new RationaleQueue(() => "candidate-1", {
        onDisposition,
      });
      queue.ingest(captureFixture());

      await queue.submit(
        status === "captured"
          ? {
              status,
              rationale: "Because it is maintainable.",
              reasonFactors: ["maintainability"],
            }
          : { status },
      );

      expect(onDisposition).toHaveBeenCalledWith(
        expect.objectContaining({ candidateId: "candidate-1" }),
        expect.objectContaining({ status }),
      );
      expect(queue.snapshot().current).toBeNull();
    },
  );

  it("accepts a bounded explicit principle as the rationale basis", async () => {
    const onDisposition = vi.fn(async () => undefined);
    const queue = new RationaleQueue(() => "candidate-1", {
      onDisposition,
    });
    queue.ingest(captureFixture());

    await queue.submit({
      status: "captured",
      appliedPrincipleIds: ["principle-1"],
    });

    expect(onDisposition).toHaveBeenCalledWith(expect.anything(), {
      status: "captured",
      appliedPrincipleIds: ["principle-1"],
    });
  });

  it("publishes serializable snapshots and advances FIFO", async () => {
    let sequence = 0;
    const queue = new RationaleQueue(() => `candidate-${++sequence}`);
    const snapshots: unknown[] = [];
    queue.subscribe((snapshot) => snapshots.push(snapshot));
    queue.ingest(
      captureFixture({
        questions: [questionFixture(0), questionFixture(1)],
      }),
    );

    await queue.submit({ status: "skipped" });

    expect(queue.snapshot()).toMatchObject({
      current: {
        candidateId: "candidate-2",
        question: { questionIndex: 1 },
      },
      waitingCount: 0,
    });
    expect(() => JSON.stringify(snapshots)).not.toThrow();
  });

  it("retains a completed candidate for persistence retry", async () => {
    let attempts = 0;
    const queue = new RationaleQueue(() => "candidate-1", {
      onDisposition: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("disk full");
        }
      },
    });
    queue.ingest(captureFixture());

    await expect(
      queue.submit({
        status: "captured",
        rationale: "Cannot lose this rationale.",
      }),
    ).rejects.toBeInstanceOf(DecisionPersistenceError);
    expect(queue.snapshot()).toMatchObject({
      current: { status: "completed" },
      persistenceStatus: "failed",
    });

    await queue.retryCurrentPersistence();

    expect(queue.snapshot().current).toBeNull();
  });

  it("reports synchronous persistence failures as rejected promises", async () => {
    const queue = new RationaleQueue(() => "candidate-1", {
      onDisposition: () => {
        throw new Error("synchronous disk failure");
      },
    });
    queue.ingest(captureFixture());

    let submission: Promise<void> | undefined;
    expect(() => {
      submission = queue.submit({ status: "skipped" });
    }).not.toThrow();
    await expect(submission).rejects.toBeInstanceOf(
      DecisionPersistenceError,
    );
    expect(queue.snapshot()).toMatchObject({
      current: { status: "completed" },
      persistenceStatus: "failed",
    });
  });
});
