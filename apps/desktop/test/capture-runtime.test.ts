import { describe, expect, it, vi } from "vitest";

import {
  rationaleCandidateKey,
  rationaleSemanticKey,
  type DecisionRecord,
  type RationaleSubmission,
} from "@cognelis/decision-core";
import { CaptureDispositionCorruptError } from "@cognelis/decision-storage";

import { CaptureRuntime } from "../src/main/capture-runtime.js";
import {
  serverCandidateFixture,
  serverCaptureFixture,
} from "./fixtures.js";

const semanticSpoolMethods = () => ({
  isAcknowledged: vi.fn(async () => false),
  rememberSemanticOccurrence: vi.fn(async () => undefined),
  claimCrossModeSemantic: vi.fn(async () => false),
  claimKnownSemanticOccurrence: vi.fn(async () => true),
});

interface TestIndex {
  listByRationaleStatus?(
    status: "deferred",
  ): Array<{
    id: string;
    question: string;
    created: string;
    project: string;
    sourceClient: "codex" | "claude-code" | "test";
    selectedAnswer: string;
    context: string | null;
  }>;
  hasDecision?(id: string): boolean;
}

const createRuntime = (index?: TestIndex) => {
  let sequence = 0;
  const spool = {
    append: vi.fn(async () => undefined),
    acknowledge: vi.fn(async () => undefined),
    saveDisposition: vi.fn(async () => undefined),
    replaceDisposition: vi.fn(async () => undefined),
    loadDisposition: vi.fn(
      async (): Promise<RationaleSubmission | null> => null,
    ),
    ...semanticSpoolMethods(),
  };
  const candidateSpool = {
    append: vi.fn(async () => undefined),
    acknowledge: vi.fn(async () => undefined),
    isAcknowledged: vi.fn(async () => false),
  };
  const store = {
    save: vi.fn(async (_record: DecisionRecord) => ({
      note: { id: "decision-1", path: "/note.md", contentHash: "hash" },
      indexed: true,
    })),
    completeDeferredRationale: vi.fn(async () => ({
      note: {
        id: "decision-legacy",
        path: "/legacy-note.md",
        contentHash: "legacy-hash",
      },
      indexed: true,
    })),
    skipDeferredRationale: vi.fn(async () => ({
      note: {
        id: "decision-legacy",
        path: "/legacy-note.md",
        contentHash: "legacy-hash",
      },
      indexed: true,
    })),
    deleteDeferredRationale: vi.fn(async () => ({
      note: {
        id: "decision-legacy",
        path: "/legacy-note.md",
        contentHash: "legacy-hash",
      },
      indexed: true,
    })),
    rebuildIndex: vi.fn(),
  };
  const runtime = new CaptureRuntime({
    spool,
    candidateSpool,
    store,
    ...(index === undefined ? {} : { index }),
    idFactory: () => `id-${++sequence}`,
  });
  return { candidateSpool, runtime, spool, store };
};

describe("CaptureRuntime", () => {
  it("promotes a reviewed candidate durably into the rationale queue", async () => {
    const { candidateSpool, runtime, spool } = createRuntime();
    const candidate = {
      ...serverCandidateFixture(),
      event: {
        ...serverCandidateFixture().event,
        context: {
          taskBackground: "继续开发 Decision。",
          decisionFraming: "先规则后本地模型。",
        },
      },
    };

    await runtime.ingestCandidate(candidate);
    await runtime.confirmCurrentCandidate();

    expect(candidateSpool.append).toHaveBeenCalledWith(candidate);
    expect(spool.append).toHaveBeenCalledWith(candidate.event);
    expect(candidateSpool.acknowledge).toHaveBeenCalledWith(
      candidate.candidateId,
    );
    expect(
      spool.append.mock.invocationCallOrder[0],
    ).toBeLessThan(
      candidateSpool.acknowledge.mock.invocationCallOrder[0]!,
    );
    expect(runtime.queue.snapshot()).toMatchObject({
      current: {
        event: {
          detection: { band: "medium" },
          context: {
            taskBackground: "继续开发 Decision。",
          },
        },
      },
    });
    expect(runtime.candidates.snapshot()).toEqual({
      current: null,
      count: 0,
    });
  });

  it("keeps an explicitly promoted review actionable when a capture receipt already exists", async () => {
    const { candidateSpool, runtime, spool } = createRuntime();
    const candidate = serverCandidateFixture();
    spool.isAcknowledged.mockResolvedValue(true);

    await runtime.ingestCandidate(candidate);
    await runtime.confirmCurrentCandidate();

    expect(runtime.queue.snapshot()).toMatchObject({
      current: {
        status: "awaiting_rationale",
        event: { sourceEventId: candidate.event.sourceEventId },
      },
    });
    expect(candidateSpool.acknowledge).toHaveBeenCalledWith(
      candidate.candidateId,
    );
    expect(spool.claimCrossModeSemantic).not.toHaveBeenCalled();
  });

  it("lets an explicit promotion override persisted cross-mode deduplication", async () => {
    const { candidateSpool, runtime, spool } = createRuntime();
    const candidate = serverCandidateFixture();
    spool.claimCrossModeSemantic.mockResolvedValue(true);

    await runtime.ingestCandidate(candidate);
    await runtime.confirmCurrentCandidate();

    expect(runtime.queue.snapshot()).toMatchObject({
      current: {
        status: "awaiting_rationale",
        event: { sourceEventId: candidate.event.sourceEventId },
      },
    });
    expect(candidateSpool.acknowledge).toHaveBeenCalledWith(
      candidate.candidateId,
    );
    expect(spool.claimCrossModeSemantic).not.toHaveBeenCalled();
  });

  it("promotes a transcript candidate when its generic source event id collides with an indexed decision", async () => {
    const earlierEvent = serverCaptureFixture({
      captureMode: "transcript",
      sourceClient: "claude-code",
      sessionId: "shared-claude-session",
      sourceEventId: "stop:prompt",
      toolUseId: undefined,
      batchId: "claude-code:shared-claude-session:semantic:earlier",
      questions: [
        {
          ...serverCaptureFixture().questions[0]!,
          question: "先前完全不同的问题",
          answer: { kind: "custom", values: ["先前回答"] },
        },
      ],
    });
    const indexedRecordId = `decision-${rationaleCandidateKey(
      earlierEvent,
      earlierEvent.questions[0]!,
    )}`;
    const { candidateSpool, runtime } = createRuntime({
      hasDecision: vi.fn((id: string) => id === indexedRecordId),
    });
    const candidate = {
      ...serverCandidateFixture(),
      candidateId: "current-transcript-candidate",
      event: serverCaptureFixture({
        captureMode: "transcript",
        sourceClient: "claude-code",
        sessionId: "shared-claude-session",
        sourceEventId: "stop:prompt",
        toolUseId: undefined,
        batchId: "claude-code:shared-claude-session:semantic:current",
        detection: {
          band: "medium",
          score: 65,
          detectorVersion: "rules-v1",
          signals: ["awaits_confirmation"],
        },
        questions: [
          {
            ...serverCaptureFixture().questions[0]!,
            question: "当前要记录的问题",
            options: [{ label: "A" }, { label: "B" }],
            answer: { kind: "custom", values: ["A"] },
          },
        ],
      }),
    };

    await runtime.ingestCandidate(candidate);
    await runtime.confirmCurrentCandidate();

    expect(runtime.queue.snapshot()).toMatchObject({
      current: {
        status: "awaiting_rationale",
        event: { batchId: candidate.event.batchId },
        question: { question: "当前要记录的问题" },
      },
    });
    expect(candidateSpool.acknowledge).toHaveBeenCalledWith(
      candidate.candidateId,
    );
  });

  it("prioritizes a promoted review without losing the existing rationale", async () => {
    const { runtime } = createRuntime();
    const existing = serverCaptureFixture({
      sessionId: "existing-session",
      sourceEventId: "existing",
      toolUseId: "existing",
      batchId: "existing",
    });
    const reviewed = serverCandidateFixture();

    await runtime.ingest(existing);
    await runtime.ingestCandidate(reviewed);
    await runtime.confirmCurrentCandidate();

    expect(runtime.queue.snapshot()).toMatchObject({
      current: {
        event: {
          sourceEventId: reviewed.event.sourceEventId,
        },
      },
      waitingCount: 1,
    });

    await runtime.queue.submit({ status: "skipped" });

    expect(runtime.queue.snapshot()).toMatchObject({
      current: {
        event: { sourceEventId: "existing" },
      },
      waitingCount: 0,
    });
  });

  it("ignores a reviewed candidate without creating a capture or Markdown", async () => {
    const { candidateSpool, runtime, spool, store } =
      createRuntime();
    const candidate = serverCandidateFixture();

    await runtime.ingestCandidate(candidate);
    await runtime.ignoreCurrentCandidate();

    expect(candidateSpool.acknowledge).toHaveBeenCalledWith(
      candidate.candidateId,
    );
    expect(spool.append).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(runtime.queue.snapshot().current).toBeNull();
  });

  it("keeps a candidate review retryable when acknowledgement fails", async () => {
    const { candidateSpool, runtime, spool } = createRuntime();
    const candidate = serverCandidateFixture();
    candidateSpool.acknowledge.mockRejectedValueOnce(
      new Error("temporary candidate receipt failure"),
    );

    await runtime.ingestCandidate(candidate);
    await expect(
      runtime.confirmCurrentCandidate(),
    ).rejects.toThrow(/Candidate persistence/u);
    expect(runtime.candidates.snapshot()).toMatchObject({
      current: candidate,
      persistenceStatus: "failed",
    });

    await runtime.retryCurrentCandidate();

    expect(spool.append).toHaveBeenCalledTimes(2);
    expect(runtime.candidates.snapshot().current).toBeNull();
  });

  it("keeps a deferred rationale local without writing or acknowledging it", async () => {
    const { runtime, spool, store } = createRuntime();
    const event = serverCaptureFixture();

    await runtime.ingest(event);
    await runtime.queue.submit({ status: "deferred" });

    expect(store.save).not.toHaveBeenCalled();
    expect(spool.saveDisposition).toHaveBeenCalledWith(
      event,
      0,
      { status: "deferred" },
    );
    expect(
      spool.saveDisposition.mock.invocationCallOrder[0],
    ).toBeLessThan(
      spool.rememberSemanticOccurrence.mock.invocationCallOrder[0]!,
    );
    expect(spool.acknowledge).not.toHaveBeenCalled();
    expect(runtime.pendingRationales()).toEqual([
      {
        id: expect.stringMatching(/^decision-[a-f0-9]{64}$/u),
        question: event.questions[0]?.question,
        created: event.capturedAt,
        project: event.project,
        sourceClient: event.sourceClient,
        selectedAnswer:
          event.questions[0]?.answer.values.join("、"),
        contextSummary: null,
      },
    ]);
    expect(runtime.queue.snapshot().current).toBeNull();
  });

  it("writes a local deferred rationale only when its reason is completed", async () => {
    const { runtime, spool, store } = createRuntime();
    const event = serverCaptureFixture();
    await runtime.ingest(event);
    await runtime.queue.submit({
      status: "deferred",
      appliedPrincipleIds: ["principle-1"],
    });
    const pending = runtime.pendingRationales()[0]!;

    await runtime.completeDeferredRationale(pending.id, {
      rationale: "先保留可逆方案。",
      reasonFactors: ["reversibility"],
    });

    expect(spool.replaceDisposition).toHaveBeenCalledWith(
      event,
      0,
      {
        status: "captured",
        rationale: "先保留可逆方案。",
        reasonFactors: ["reversibility"],
        appliedPrincipleIds: ["principle-1"],
      },
    );
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: pending.id,
        status: "completed",
        rationaleStatus: "captured",
        rationaleOriginal: "先保留可逆方案。",
        appliedPrincipleIds: ["principle-1"],
      }),
    );
    expect(spool.acknowledge).toHaveBeenCalledWith(event, 0);
    expect(runtime.pendingRationales()).toEqual([]);
  });

  it("skips a local deferred rationale without deleting its decision", async () => {
    const { runtime, spool, store } = createRuntime();
    const event = serverCaptureFixture();
    await runtime.ingest(event);
    await runtime.queue.submit({
      status: "deferred",
      appliedPrincipleIds: ["principle-2"],
    });
    const pending = runtime.pendingRationales()[0]!;
    await runtime.skipDeferredRationale(pending.id);

    expect(spool.replaceDisposition).toHaveBeenCalledWith(
      event,
      0,
      { status: "skipped", appliedPrincipleIds: ["principle-2"] },
    );
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: pending.id,
        status: "rationale_skipped",
        rationaleStatus: "skipped",
        rationaleOriginal: null,
        appliedPrincipleIds: ["principle-2"],
      }),
    );
    expect(spool.acknowledge).toHaveBeenCalledWith(event, 0);
    expect(runtime.pendingRationales()).toEqual([]);
  });

  it("discards a local deferred rationale without writing a decision", async () => {
    const { runtime, spool, store } = createRuntime();
    const event = serverCaptureFixture();
    await runtime.ingest(event);
    await runtime.queue.submit({ status: "deferred" });
    const pending = runtime.pendingRationales()[0]!;

    await runtime.discardDeferredRationale(pending.id);

    expect(spool.replaceDisposition).toHaveBeenCalledWith(event, 0, {
      status: "not_recorded",
    });
    expect(store.save).not.toHaveBeenCalled();
    expect(spool.acknowledge).toHaveBeenCalledWith(event, 0);
    expect(runtime.pendingRationales()).toEqual([]);
  });

  it("restores deferred applied principles after an app restart", async () => {
    const { runtime, spool, store } = createRuntime();
    const event = serverCaptureFixture();
    spool.loadDisposition.mockResolvedValue({
      status: "deferred",
      appliedPrincipleIds: ["principle-recovered"],
    });

    await runtime.ingest(event);
    const pending = runtime.pendingRationales()[0]!;
    await runtime.completeDeferredRationale(pending.id, {
      rationale: "恢复后补充理由。",
    });

    expect(spool.replaceDisposition).toHaveBeenCalledWith(event, 0, {
      status: "captured",
      rationale: "恢复后补充理由。",
      appliedPrincipleIds: ["principle-recovered"],
    });
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        appliedPrincipleIds: ["principle-recovered"],
      }),
    );
  });

  it("keeps completing legacy deferred Markdown through the store", async () => {
    const legacy = {
      id: "decision-legacy",
      question: "旧的待补理由",
      created: "2026-07-24T00:00:00.000Z",
      project: "decision",
      sourceClient: "codex" as const,
      selectedAnswer: "保留 Markdown",
      context: null,
    };
    const { runtime, store } = createRuntime({
      listByRationaleStatus: () => [legacy],
    });
    const update = { rationale: "补充旧记录的理由。" };

    expect(runtime.pendingRationales()).toEqual([
      {
        id: legacy.id,
        question: legacy.question,
        created: legacy.created,
        project: legacy.project,
        sourceClient: legacy.sourceClient,
        selectedAnswer: legacy.selectedAnswer,
        contextSummary: legacy.context,
      },
    ]);
    await runtime.completeDeferredRationale(legacy.id, update);

    expect(store.completeDeferredRationale).toHaveBeenCalledWith(
      legacy.id,
      update,
    );
  });

  it("skips a persisted deferred rationale through the store", async () => {
    const legacy = {
      id: "decision-legacy",
      question: "旧的待补理由",
      created: "2026-07-24T00:00:00.000Z",
      project: "decision",
      sourceClient: "codex" as const,
      selectedAnswer: "保留 Markdown",
      context: null,
    };
    const { runtime, store } = createRuntime({
      listByRationaleStatus: () => [legacy],
    });
    await runtime.skipDeferredRationale(legacy.id);

    expect(store.skipDeferredRationale).toHaveBeenCalledWith(
      legacy.id,
    );
  });

  it("deletes a persisted deferred rationale through the store", async () => {
    const legacy = {
      id: "decision-legacy",
      question: "旧的待补理由",
      created: "2026-07-24T00:00:00.000Z",
      project: "decision",
      sourceClient: "codex" as const,
      selectedAnswer: "不再记录",
      context: null,
    };
    const { runtime, store } = createRuntime({
      listByRationaleStatus: () => [legacy],
    });

    await runtime.discardDeferredRationale(legacy.id);

    expect(store.deleteDeferredRationale).toHaveBeenCalledWith(legacy.id);
  });

  it("shows the newest deferred decisions with enough context to judge them", () => {
    const older = {
      id: "decision-older",
      question: "旧决策",
      created: "2026-06-01T00:00:00.000Z",
      project: "archive",
      sourceClient: "claude-code" as const,
      selectedAnswer: "保留旧方案",
      context: null,
    };
    const newer = {
      id: "decision-newer",
      question: "新决策",
      created: "2026-07-30T00:00:00.000Z",
      project: "decision",
      sourceClient: "codex" as const,
      selectedAnswer: "补全上下文",
      context: "先让历史待办可以判断。",
    };
    const { runtime } = createRuntime({
      listByRationaleStatus: () => [older, newer],
    });

    expect(runtime.pendingRationales()).toEqual([
      {
        id: newer.id,
        question: newer.question,
        created: newer.created,
        project: newer.project,
        sourceClient: newer.sourceClient,
        selectedAnswer: newer.selectedAnswer,
        contextSummary: newer.context,
      },
      {
        id: older.id,
        question: older.question,
        created: older.created,
        project: older.project,
        sourceClient: older.sourceClient,
        selectedAnswer: older.selectedAnswer,
        contextSummary: older.context,
      },
    ]);
  });

  it("keeps local deferred rationales available when the index read fails", async () => {
    const { runtime } = createRuntime({
      listByRationaleStatus: () => {
        throw new Error("index unavailable");
      },
    });
    const event = serverCaptureFixture();
    await runtime.ingest(event);
    await runtime.queue.submit({ status: "deferred" });

    expect(runtime.pendingRationales()).toEqual([
      {
        id: expect.stringMatching(/^decision-[a-f0-9]{64}$/u),
        question: event.questions[0]?.question,
        created: event.capturedAt,
        project: event.project,
        sourceClient: event.sourceClient,
        selectedAnswer:
          event.questions[0]?.answer.values.join("、"),
        contextSummary: null,
      },
    ]);
    expect(runtime.health()).toMatchObject({
      index: "degraded",
      indexMessage: expect.stringMatching(/SQLite 索引读取失败/u),
      recovery: "healthy",
    });
  });

  it("acknowledges no-record without writing Markdown", async () => {
    const { runtime, spool, store } = createRuntime();

    await runtime.ingest(serverCaptureFixture());
    await runtime.queue.submit({ status: "not_recorded" });

    expect(store.save).not.toHaveBeenCalled();
    expect(spool.acknowledge).toHaveBeenCalledOnce();
  });

  it("retains the candidate and spool body when Markdown save fails", async () => {
    const { runtime, spool, store } = createRuntime();
    store.save.mockRejectedValueOnce(new Error("disk full"));
    await runtime.ingest(serverCaptureFixture());

    await expect(
      runtime.queue.submit({
        status: "captured",
        rationale: "不能丢失",
      }),
    ).rejects.toThrow(/persistence/i);

    expect(spool.acknowledge).not.toHaveBeenCalled();
    expect(runtime.queue.snapshot()).toMatchObject({
      current: { status: "completed" },
      persistenceStatus: "failed",
    });
  });

  it("reuses the same record when spool acknowledgement is retried", async () => {
    const { runtime, spool, store } = createRuntime();
    spool.acknowledge.mockRejectedValueOnce(
      new Error("temporary spool failure"),
    );
    await runtime.ingest(serverCaptureFixture());

    await expect(
      runtime.queue.submit({ status: "skipped" }),
    ).rejects.toThrow(/persistence/i);
    await runtime.queue.retryCurrentPersistence();

    expect(store.save).toHaveBeenCalledTimes(2);
    const first = store.save.mock.calls[0]?.[0];
    const second = store.save.mock.calls[1]?.[0];
    expect(first?.id).toMatch(/^decision-[a-f0-9]{64}$/u);
    expect(second).toEqual(first);
    expect(runtime.queue.snapshot().current).toBeNull();
  });

  it("acknowledges a cross-mode duplicate spool body", async () => {
    const { runtime, spool } = createRuntime();
    const structured = serverCaptureFixture();
    const {
      toolUseId: _toolUseId,
      ...transcript
    } = serverCaptureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });

    await runtime.ingest(structured);
    await expect(runtime.ingest(transcript)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    await runtime.queue.submit({ status: "not_recorded" });

    expect(spool.acknowledge).toHaveBeenCalledWith(transcript, 0);
  });

  it("derives the same record across process restarts", async () => {
    const event = serverCaptureFixture();
    const saved: DecisionRecord[] = [];
    const store = {
      save: vi.fn(async (record: DecisionRecord) => {
        saved.push(record);
        return {
          note: {
            id: record.id,
            path: "/note.md",
            contentHash: "hash",
          },
          indexed: true,
        };
      }),
    };
    const first = new CaptureRuntime({
      spool: {
        ...semanticSpoolMethods(),
        acknowledge: vi.fn(async () => {
          throw new Error("process exits before acknowledgement");
        }),
      },
      store,
      idFactory: () => "first-process-candidate",
    });
    const second = new CaptureRuntime({
      spool: {
        ...semanticSpoolMethods(),
        acknowledge: vi.fn(async () => undefined),
      },
      store,
      idFactory: () => "second-process-candidate",
    });

    await first.ingest(event);
    await expect(
      first.queue.submit({ status: "skipped" }),
    ).rejects.toThrow(/persistence/i);
    await second.ingest(event);
    await second.queue.submit({ status: "skipped" });

    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual(saved[0]);
  });

  it("keeps distinct IDs for repeated same-mode decisions", async () => {
    const { runtime, store } = createRuntime();
    const first = serverCaptureFixture();
    const second = serverCaptureFixture({
      sourceEventId: "event-2",
      toolUseId: "tool-2",
      batchId: "test:server-test:tool-2",
    });

    await runtime.ingest(first);
    await runtime.ingest(second);
    await runtime.queue.submit({ status: "skipped" });
    await runtime.queue.submit({ status: "skipped" });

    const ids = store.save.mock.calls.map(
      ([record]) => record.id,
    );
    expect(new Set(ids).size).toBe(2);
  });

  it("accepts a later same-mode repeat after the first was persisted", async () => {
    const { runtime } = createRuntime();
    const first = serverCaptureFixture();
    const later = serverCaptureFixture({
      sourceEventId: "event-later",
      toolUseId: "tool-later",
      batchId: "test:server-test:tool-later",
      capturedAt: "2026-07-25T00:01:00.000Z",
    });

    await runtime.ingest(first);
    await runtime.queue.submit({ status: "skipped" });

    await expect(runtime.ingest(later)).resolves.toEqual({
      accepted: 1,
      duplicates: 0,
    });
  });

  it("resumes a journaled disposition after restart", async () => {
    const { runtime, spool, store } = createRuntime();
    const event = serverCaptureFixture();
    spool.loadDisposition.mockResolvedValue({
      status: "captured",
      rationale: "恢复的原始理由",
      reasonFactors: ["risk"],
    });

    await runtime.ingest(event);
    await runtime.resumePendingDispositions();

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        rationaleOriginal: "恢复的原始理由",
        reasonFactors: ["risk"],
      }),
    );
    expect(runtime.queue.snapshot().current).toBeNull();
  });

  it("acknowledges an already indexed record without prompting again", async () => {
    const event = serverCaptureFixture();
    const question = event.questions[0]!;
    const recordId =
      `decision-${rationaleCandidateKey(event, question)}`;
    const spool = {
      ...semanticSpoolMethods(),
      acknowledge: vi.fn(async () => undefined),
    };
    const runtime = new CaptureRuntime({
      spool,
      store: {
        save: vi.fn(),
      },
      index: {
        hasDecision: vi.fn(
          (id: string) => id === recordId,
        ),
      },
      idFactory: () => "must-not-create-candidate",
    });

    await expect(runtime.ingest(event)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(spool.acknowledge).toHaveBeenCalledWith(event, 0);
    expect(runtime.queue.snapshot().current).toBeNull();
  });

  it("acknowledges a cross-mode semantic replay found after restart", async () => {
    const event = serverCaptureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      toolUseId: undefined,
      batchId: "text-batch",
    });
    const question = event.questions[0]!;
    const spool = {
      ...semanticSpoolMethods(),
      acknowledge: vi.fn(async () => undefined),
      claimCrossModeSemantic: vi.fn(async () => true),
    };
    const runtime = new CaptureRuntime({
      spool,
      store: { save: vi.fn() },
      idFactory: () => "must-not-create-candidate",
    });

    await expect(runtime.ingest(event)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(spool.claimCrossModeSemantic).toHaveBeenCalledWith(
      rationaleSemanticKey(event, question),
      "transcript",
      event.capturedAt,
      30 * 60 * 1_000,
      rationaleCandidateKey(event, question),
    );
    expect(spool.acknowledge).toHaveBeenCalledWith(event, 0);
    expect(runtime.queue.snapshot().current).toBeNull();
  });

  it("acknowledges an alias that arrives while its primary finalizes", async () => {
    let releasePrimary: () => void = () => undefined;
    let announcePrimary: () => void = () => undefined;
    const primaryStarted = new Promise<void>((resolve) => {
      announcePrimary = resolve;
    });
    const primaryRelease = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    const structured = serverCaptureFixture();
    const {
      toolUseId: _toolUseId,
      ...transcript
    } = serverCaptureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });
    const spool = {
      ...semanticSpoolMethods(),
      saveDisposition: vi.fn(async () => undefined),
      acknowledge: vi.fn(
        async (event: typeof structured) => {
          if (event.captureMode === "structured_tool") {
            announcePrimary();
            await primaryRelease;
          }
        },
      ),
    };
    const runtime = new CaptureRuntime({
      spool,
      store: { save: vi.fn() },
      idFactory: () => "candidate-1",
    });
    await runtime.ingest(structured);

    const submission = runtime.queue.submit({
      status: "not_recorded",
    });
    await primaryStarted;
    await expect(runtime.ingest(transcript)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(spool.acknowledge).toHaveBeenCalledWith(transcript, 0);
    releasePrimary();
    await submission;
  });

  it("claims and retries an alias whose acknowledgement fails during finalization", async () => {
    let releasePrimary: () => void = () => undefined;
    let announcePrimary: () => void = () => undefined;
    const primaryStarted = new Promise<void>((resolve) => {
      announcePrimary = resolve;
    });
    const primaryRelease = new Promise<void>((resolve) => {
      releasePrimary = resolve;
    });
    const structured = serverCaptureFixture();
    const {
      toolUseId: _toolUseId,
      ...transcript
    } = serverCaptureFixture({
      captureMode: "transcript",
      sourceEventId: "stop-1:prompt-1",
      batchId: "text-batch",
    });
    let claimedAlias: string | null = null;
    let failAliasAcknowledgement = true;
    const spool = {
      isAcknowledged: vi.fn(async () => false),
      saveDisposition: vi.fn(async () => undefined),
      rememberSemanticOccurrence: vi.fn(async () => undefined),
      claimCrossModeSemantic: vi.fn(
        async (
          _semanticKey: string,
          _mode: string,
          _capturedAt: string,
          _maximumAgeMs: number,
          aliasCandidateKey: string,
        ) => claimedAlias === aliasCandidateKey,
      ),
      claimKnownSemanticOccurrence: vi.fn(
        async (
          _occurrenceId: string,
          _aliasMode: string,
          aliasCandidateKey: string,
        ) => {
          claimedAlias = aliasCandidateKey;
          return true;
        },
      ),
      acknowledge: vi.fn(
        async (event: typeof structured) => {
          if (event.captureMode === "structured_tool") {
            announcePrimary();
            await primaryRelease;
            return;
          }
          if (failAliasAcknowledgement) {
            failAliasAcknowledgement = false;
            throw new Error("temporary alias acknowledgement failure");
          }
        },
      ),
    };
    const runtime = new CaptureRuntime({
      spool,
      store: { save: vi.fn() },
      idFactory: () => "candidate-1",
    });
    await runtime.ingest(structured);
    const submission = runtime.queue.submit({
      status: "not_recorded",
    });
    await primaryStarted;

    await expect(runtime.ingest(transcript)).rejects.toThrow(
      /temporary alias acknowledgement failure/i,
    );
    expect(spool.claimKnownSemanticOccurrence).toHaveBeenCalled();
    await expect(runtime.ingest(transcript)).resolves.toEqual({
      accepted: 0,
      duplicates: 1,
    });
    expect(spool.acknowledge).toHaveBeenCalledTimes(3);
    releasePrimary();
    await submission;
  });

  it("surfaces a quarantined corrupt rationale journal as degraded health", async () => {
    const { runtime, spool } = createRuntime();
    const event = serverCaptureFixture();
    spool.loadDisposition.mockRejectedValueOnce(
      new CaptureDispositionCorruptError(
        "/private/spool/disposition.json",
        new Error("invalid JSON"),
      ),
    );
    await runtime.ingest(event);

    await runtime.resumePendingDispositions();

    expect(runtime.health()).toMatchObject({
      index: "healthy",
      recovery: "degraded",
      recoveryMessage: expect.stringMatching(/恢复日志损坏/u),
    });
    expect(runtime.queue.snapshot().current?.status).toBe(
      "awaiting_rationale",
    );

    await runtime.rebuildIndex();

    expect(runtime.health()).toMatchObject({
      index: "healthy",
      recovery: "degraded",
      recoveryMessage: expect.stringMatching(/恢复日志损坏/u),
    });
  });
});
