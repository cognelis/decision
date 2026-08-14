import type {
  CaptureAuditReceipt,
  CapturedDecisionCandidate,
  CapturedDecisionEvent,
  SemanticClassification,
  SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  SemanticDecisionCoordinator,
} from "../src/main/semantic/semantic-coordinator.js";
import type {
  SemanticClassificationService,
  SemanticClassifierInput,
} from "../src/main/semantic/semantic-classifier.js";
import { semanticPairFixture } from "./fixtures.js";

const classification = (
  overrides: Partial<SemanticClassification> = {},
): SemanticClassification => ({
  decisionIntent: "decision",
  answerRelation: "answers",
  question: "先处理技术债，还是先提交当前这批？",
  optionLabels: ["处理技术债", "先提交当前这批"],
  answerExcerpt: "本次引入的需要处理",
  confidence: 0.92,
  provider: "qwen",
  modelVersion: "qwen3.5-2b-q4-k-m",
  promptVersion: "semantic-v1",
  ...overrides,
});

const classifier = (
  classify: SemanticClassificationService["classify"],
): SemanticClassificationService => ({
  classify,
  close: vi.fn(async () => undefined),
});

const setup = (options: {
  classifier?: SemanticClassificationService;
  now?: () => Date;
  timeoutMs?: number;
} = {}) => {
  const highEvents: CapturedDecisionEvent[] = [];
  const mediumCandidates: CapturedDecisionCandidate[] = [];
  const auditInputs: Array<Record<string, unknown>> = [];
  const runtime = {
    ingest: vi.fn(async (event: CapturedDecisionEvent) => {
      highEvents.push(event);
      return { accepted: 1, duplicates: 0 };
    }),
    ingestCandidate: vi.fn(
      async (candidate: CapturedDecisionCandidate) => {
        mediumCandidates.push(candidate);
      },
    ),
  };
  const audit = {
    record: vi.fn(
      async (input: Record<string, unknown>) => {
        auditInputs.push(input);
        return {} as CaptureAuditReceipt;
      },
    ),
  };
  const coordinator = new SemanticDecisionCoordinator({
    runtime,
    audit,
    ...(options.classifier === undefined
      ? {}
      : { classifier: options.classifier }),
    now:
      options.now ??
      (() => new Date("2026-07-27T00:05:00.000Z")),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  });
  return {
    audit,
    auditInputs,
    coordinator,
    highEvents,
    mediumCandidates,
    runtime,
  };
};

const clearPair = (
  overrides: Partial<SemanticDecisionPair> = {},
): SemanticDecisionPair =>
  semanticPairFixture({
    assistantText: "先处理技术债，还是先提交当前这批？",
    userText: "本次引入的需要处理",
    capturedAt: "2026-07-27T00:04:00.000Z",
    expiresAt: "2026-08-03T00:04:00.000Z",
    ...overrides,
  });

describe("SemanticDecisionCoordinator", () => {
  it("routes rule/model high agreement into the rationale queue", async () => {
    const model = classifier(async () => classification());
    const { coordinator, highEvents, mediumCandidates } = setup({
      classifier: model,
    });

    await expect(
      coordinator.process(clearPair()),
    ).resolves.toBe("processed");

    expect(highEvents).toHaveLength(1);
    expect(mediumCandidates).toEqual([]);
    expect(highEvents[0]).toMatchObject({
      captureMode: "transcript",
      detection: {
        band: "high",
        detectorVersion: "rules-v1+semantic-v1",
        signals: expect.arrayContaining(["semantic_agreement"]),
      },
      questions: [
        {
          question: "先处理技术债，还是先提交当前这批？",
          answer: {
            kind: "custom",
            values: ["本次引入的需要处理"],
          },
        },
      ],
    });
  });

  it("routes a model-only decision to the existing medium candidate queue", async () => {
    const pair = clearPair({
      assistantText:
        "前者风险小，后者速度快。请你定下最终方向。",
      userText: "选前者，并继续说明后续步骤",
    });
    const model = classifier(async () =>
      classification({
        question: "请你定下最终方向。",
        optionLabels: ["前者", "后者"],
        answerExcerpt: "选前者",
      }),
    );
    const { coordinator, highEvents, mediumCandidates } = setup({
      classifier: model,
    });

    await coordinator.process(pair);

    expect(highEvents).toEqual([]);
    expect(mediumCandidates).toHaveLength(1);
    expect(mediumCandidates[0]).toMatchObject({
      candidateVersion: 1,
      candidateId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      event: {
        detection: {
          band: "medium",
          signals: expect.arrayContaining([
            "semantic_disagreement",
          ]),
        },
        questions: [
          {
            question: "请你定下最终方向。",
            options: [{ label: "前者" }, { label: "后者" }],
            answer: {
              values: ["选前者，并继续说明后续步骤"],
            },
          },
        ],
      },
    });
  });

  it("drops rule/model low agreement after recording the route", async () => {
    const pair = clearPair({
      assistantText: "测试已经通过。",
      userText: "继续下一个任务",
    });
    const model = classifier(async () =>
      classification({
        decisionIntent: "none",
        answerRelation: "new_task",
        question: null,
        optionLabels: [],
        answerExcerpt: null,
        confidence: 0.99,
      }),
    );
    const { auditInputs, coordinator, runtime } = setup({
      classifier: model,
    });

    await coordinator.process(pair);

    expect(runtime.ingest).not.toHaveBeenCalled();
    expect(runtime.ingestCandidate).not.toHaveBeenCalled();
    expect(auditInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "classification_completed",
          finalBand: "low",
        }),
        expect.objectContaining({
          stage: "routed",
          finalBand: "low",
        }),
      ]),
    );
  });

  it("uses the existing rule result when no model is available", async () => {
    const { coordinator, highEvents } = setup();

    await coordinator.process(clearPair());

    expect(highEvents).toHaveLength(1);
    expect(highEvents[0]?.detection).toMatchObject({
      band: "high",
      detectorVersion: "rules-v1",
      signals: expect.arrayContaining(["semantic_unavailable"]),
    });
  });

  it("keeps a mixed answer at medium and stores the complete user input", async () => {
    const pair = clearPair({
      userText:
        "本次引入的需要处理。另外，为什么要拆为两个字段？",
    });
    const model = classifier(async () =>
      classification({
        answerRelation: "mixed",
        answerExcerpt: "本次引入的需要处理",
        confidence: 0.7,
      }),
    );
    const { coordinator, mediumCandidates } = setup({
      classifier: model,
    });

    await coordinator.process(pair);

    expect(mediumCandidates[0]).toMatchObject({
      event: {
        detection: {
          band: "medium",
          signals: expect.arrayContaining(["semantic_mixed"]),
        },
        questions: [
          {
            answer: { values: [pair.userText] },
          },
        ],
      },
    });
  });

  it("caps stale high agreement at medium", async () => {
    const model = classifier(async () => classification());
    const { coordinator, mediumCandidates } = setup({
      classifier: model,
      now: () => new Date("2026-07-27T00:20:00.001Z"),
    });

    await coordinator.process(
      clearPair({
        capturedAt: "2026-07-27T00:05:00.000Z",
      }),
    );

    expect(mediumCandidates[0]?.event.detection?.signals).toContain(
      "stale_recovery_cap",
    );
  });

  it.each(["timeout", "invalid", "crash"] as const)(
    "falls back to rules when the model has a %s failure",
    async (failure) => {
      const model = classifier(async (_input, signal) => {
        if (failure === "invalid") {
          return {
            ...classification(),
            confidence: 5,
          } as SemanticClassification;
        }
        if (failure === "crash") {
          throw new Error("provider crashed");
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("cancelled");
      });
      const { auditInputs, coordinator, highEvents } = setup({
        classifier: model,
        timeoutMs: 5,
      });

      await coordinator.process(clearPair());

      expect(highEvents[0]?.detection).toMatchObject({
        band: "high",
        detectorVersion: "rules-v1",
      });
      expect(auditInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "failed",
            errorCode:
              failure === "timeout"
                ? "classification_timeout"
                : failure === "invalid"
                  ? "provider_invalid_output"
                  : "provider_unavailable",
          }),
        ]),
      );
    },
  );

  it("allows a cold local model more than five seconds to initialize", async () => {
    vi.useFakeTimers();
    try {
      const model = classifier(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(classification()), 6_000);
          }),
      );
      const { coordinator, highEvents } = setup({
        classifier: model,
      });

      const processing = coordinator.process(clearPair());
      await vi.advanceTimersByTimeAsync(6_000);
      await processing;

      expect(highEvents[0]?.detection).toMatchObject({
        detectorVersion: "rules-v1+semantic-v1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes only bounded pair text and locale to the model", async () => {
    let received: SemanticClassifierInput | null = null;
    const model = classifier(async (input) => {
      received = input;
      return classification();
    });
    const { coordinator } = setup({ classifier: model });
    const pair = clearPair();

    await coordinator.process(pair);

    expect(received).toEqual({
      pairId: pair.pairId,
      assistantText: pair.assistantText,
      userText: pair.userText,
      locale: "zh-CN",
    });
    expect(JSON.stringify(received)).not.toContain(pair.cwd);
    expect(JSON.stringify(received)).not.toContain(pair.sessionId);
  });

  it("keeps the pair retryable when route persistence fails", async () => {
    const { auditInputs, coordinator, runtime } = setup();
    runtime.ingest.mockRejectedValueOnce(new Error("capture spool full"));

    await expect(
      coordinator.process(clearPair()),
    ).rejects.toThrow("capture spool full");
    expect(auditInputs.at(-1)).toMatchObject({
      stage: "failed",
      errorCode: "routing_failed",
    });
  });

  it("closes its semantic classification service once", async () => {
    const model = classifier(async () => classification());
    const { coordinator } = setup({ classifier: model });

    await coordinator.close();
    await coordinator.close();

    expect(model.close).toHaveBeenCalledOnce();
  });
});
