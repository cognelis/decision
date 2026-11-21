import type {
  CaptureAuditReceipt,
  CapturedDecisionCandidate,
  CapturedDecisionEvent,
  SemanticClassification,
  SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";
import { TextDecisionAnalyzer } from "@cognelis/decision-core";

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
  analyzer?: TextDecisionAnalyzer;
  modelEnabled?: () => boolean;
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
    ...(options.analyzer === undefined ? {} : { analyzer: options.analyzer }),
    ...(options.classifier === undefined
      ? {}
      : { classifier: options.classifier }),
    ...(options.modelEnabled === undefined
      ? {}
      : { modelEnabled: options.modelEnabled }),
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

// R2-IA2 (synthetic): the real rules, no model, and the answer the event carries.
describe("SemanticDecisionCoordinator answers read off the reply", () => {
  const store =
    "**A. SQLite** —— 单文件、零部署。\n**B. PostgreSQL** —— 并发强，要部署。\n**C. 纯 JSON 文件** —— 最简单。\n\n我推荐 A。你选 A/B/C 哪个？";
  const captured = async (assistantText: string, userText: string) => {
    const { coordinator, highEvents, mediumCandidates } = setup();
    await coordinator.process(clearPair({ assistantText, userText }));
    return [...highEvents, ...mediumCandidates.map((candidate) => candidate.event)][0]?.questions[0];
  };

  it("records a letter as the option it names", async () => {
    expect(await captured(store, "B")).toMatchObject({
      options: [{ id: "A", label: "SQLite" }, { id: "B", label: "PostgreSQL" }, { id: "C", label: "纯 JSON 文件" }],
      answer: { kind: "preset", values: ["PostgreSQL"], reply: "B" },
      multiSelect: false,
    });
  });

  it("keeps a natural-language choice verbatim when no semantic selection was verified", async () => {
    const reply = "Let's go with Zustand. The team is small.";
    expect(
      await captured(
        "## 三个方案\n\n**A. Redux Toolkit**\n生态成熟。\n\n**B. Zustand**\n极简。\n\n**C. React Context only**\n零依赖。\n\n我推荐 Zustand。\n\n你选哪个？",
        reply,
      ),
    ).toMatchObject({ answer: { kind: "custom", values: [reply] } });
  });

  it("keeps the full partial approval when only rules are available", async () => {
    expect(
      await captured(
        "1. 重命名含糊的变量\n2. 拆分大函数\n3. 给公共函数补类型注解\n\n这三项都要做吗？",
        "1 和 3 做，2 不做",
      ),
    ).toMatchObject({
      answer: { kind: "custom", values: ["1 和 3 做，2 不做"] },
      multiSelect: false,
    });
  });

  // R3-IA: the rules' own reading of the reply is what the event records, so a
  // put-off option is never recorded as taken and the scoring agrees.
  it.each([
    ["1 和 3 先做，2 暂缓", ["重命名变量", "补类型"]],
    ["除了 2 都做", ["重命名变量", "补类型"]],
  ])("records %j over options spread across paragraphs as high, taking %j", async (reply, values) => {
    const { coordinator, highEvents } = setup({ classifier: classifier(async () => classification({ question: "要做哪些？", optionLabels: ["重命名变量", "拆分函数", "补类型"], answerExcerpt: reply, selectedOptionIndices: [1, 3], promptVersion: "semantic-v4" })) });
    await coordinator.process(
      clearPair({
        assistantText: "审查结果如下。\n\n**1. 重命名变量**\n名字含糊。\n\n**2. 拆分函数**\n函数太长。\n\n**3. 补类型**\n缺返回类型。\n\n要做哪些？",
        userText: reply,
      }),
    );
    expect(highEvents[0]?.questions[0]).toMatchObject({
      answer: { kind: "multiple", values, reply },
      multiSelect: true,
    });
  });

  it("does not record the article a as option A (R2-V-AN M1)", async () => {
    const reply = "Let's go with a managed Postgres instead";
    const question = await captured(
      "**A. SQLite** — single file.\n**B. PostgreSQL** — strong concurrency.\n**C. Plain JSON files** — simplest.\n\nI recommend A. Which one, A/B/C?",
      reply,
    );
    expect(question?.answer ?? { kind: "custom", values: [reply] }).toEqual({ kind: "custom", values: [reply] });
  });

  it.each([
    [store, "都不要，先别动"],
    ["分支已评审通过。\n\n现在要把它合并到 main 吗？", "先别合并，等 CI 跑完再说"],
  ])("keeps a refusal in the reader's own words: %j → %j", async (assistantText, userText) => {
    expect(await captured(assistantText, userText)).toMatchObject({
      answer: { kind: "custom", values: [userText] },
    });
  });
});

describe("SemanticDecisionCoordinator", () => {
  it("does not call a model or emit a decision for a completed-status notification", async () => {
    const classify = vi.fn();
    const { coordinator, highEvents, mediumCandidates } = setup({ classifier: { classify } });
    await coordinator.process({ ...clearPair(), userText: "合并了" });
    expect(classify).not.toHaveBeenCalled();
    expect(highEvents).toEqual([]); expect(mediumCandidates).toEqual([]);
  });
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
        detectorVersion: "rules-v10+semantic-v2",
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
        selectedOptionIndices: [1],
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
            // Read off the reply against the model's option labels, the reply kept beside it.
            answer: {
              kind: "preset",
              values: ["前者"],
              reply: "选前者，并继续说明后续步骤",
            },
          },
        ],
      },
    });
  });

  it("asks no model, and logs no failure, when the reader turned it off", async () => {
    const pair = clearPair({
      assistantText:
        "前者风险小，后者速度快。\n\n1. 前者\n2. 后者\n\n你希望选择哪一种？",
      userText: "1",
    });
    const classify = vi.fn(async () => classification());
    const { coordinator, highEvents, auditInputs } = setup({
      classifier: classifier(classify),
      modelEnabled: () => false,
    });

    await coordinator.process(pair);

    expect(classify).not.toHaveBeenCalled();
    // Nothing was asked, so nothing failed; the rules decided on their own.
    expect(
      auditInputs.filter((input) => input.stage === "failed"),
    ).toEqual([]);
    expect(highEvents[0]?.detection).toMatchObject({
      band: "high",
      detectorVersion: "rules-v10",
    });
  });

  it("shows the rules' question even where the model agreed there is one", async () => {
    // Rules quote a whole paragraph of the message and can be checked against
    // it line by line; the model returns a span it chose. Where both have an
    // answer the deterministic one is what the reader sees.
    const pair = clearPair({
      assistantText:
        "前者风险小，后者速度快。\n\n1. 前者\n2. 后者\n\n你希望选择哪一种？",
      userText: "1",
    });
    const model = classifier(async () =>
      classification({ question: "前者风险小，后者速度快。" }),
    );
    const { coordinator, highEvents } = setup({ classifier: model });

    await coordinator.process(pair);

    expect(highEvents[0]?.questions[0]?.question).toBe(
      "你希望选择哪一种？",
    );
  });

  it("ignores what a model names when it read no decision at all", async () => {
    // A 2B model reading a long message answered `self_resolved` — its own
    // verdict is that nobody is being asked anything — and filled the option
    // list with the alphabet at full confidence. The verdict was rejected for
    // routing; the same reading must not be what the reader is shown.
    const pair = clearPair({
      assistantText:
        "前者风险小，后者速度快。\n\n1. 前者\n2. 后者\n\n你希望选择哪一种？",
      userText: "1",
    });
    const model = classifier(async () =>
      classification({
        decisionIntent: "self_resolved",
        answerRelation: "mixed",
        question: "前者风险小，后者速度快。",
        optionLabels: ["前者", "后者"],
        answerExcerpt: null,
        confidence: 0.99,
      }),
    );
    const { coordinator, highEvents, mediumCandidates } = setup({
      classifier: model,
    });

    await coordinator.process(pair);

    // Routed on the rules' own commitment (semantic_intent_contradiction), but read off by the rules either way.
    expect([...highEvents, ...mediumCandidates.map((candidate) => candidate.event)][0]?.questions[0]).toMatchObject({
      question: "你希望选择哪一种？",
      options: [
        { id: "1", label: "前者" },
        { id: "2", label: "后者" },
      ],
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
      detectorVersion: "rules-v10",
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
    "falls back to rules when the model has a %s failure, holding a timed-out high for the reader",
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
      const { auditInputs, coordinator, highEvents, mediumCandidates } = setup({
        classifier: model,
        timeoutMs: 5,
      });

      await coordinator.process(clearPair());

      // Out of time is not the model's judgement and not its absence: the rules' high waits for the reader.
      const routed = failure === "timeout" ? mediumCandidates[0]?.event : highEvents[0];
      expect(routed?.detection).toMatchObject({
        band: failure === "timeout" ? "medium" : "high",
        detectorVersion: "rules-v10",
      });
      expect(routed?.detection?.signals.includes("semantic_timeout")).toBe(failure === "timeout");
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

  it("ends a model call the overall budget ran out on as a timeout, which is what the call is filed as", async () => {
    // Aborted with no reason, the call was filed as 已取消 in model-traces while the capture audit said timeout.
    let reason: unknown;
    const model = classifier(async (_input, signal) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      reason = signal?.reason;
      throw new Error("cut off");
    });
    const { auditInputs, coordinator } = setup({ classifier: model, timeoutMs: 5 });

    await coordinator.process(clearPair());

    expect(reason).toMatchObject({ name: "TimeoutError" });
    expect(auditInputs).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "failed", errorCode: "classification_timeout" })]));
  });

  it.each([
    ["the gateway", Object.assign(new Error("The model fallback chain failed or was stopped"), { code: "provider_unavailable", failureCode: "timeout" })],
    ["the local model", Object.assign(new Error("Qwen inference timed out"), { code: "timeout" })],
  ])("holds the rules' high at medium when %s says the call ran out of time", async (_source, error) => {
    const { auditInputs, coordinator, highEvents, mediumCandidates } = setup({ classifier: classifier(async () => { throw error; }) });

    await coordinator.process(clearPair());

    expect(highEvents).toHaveLength(0);
    expect(mediumCandidates[0]?.event.detection?.signals).toContain("semantic_timeout");
    expect(auditInputs).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "failed", errorCode: "classification_timeout" })]));
  });

  it("keeps the rules' high when no model is installed", async () => {
    const missing = Object.assign(new Error("The model fallback chain failed or was stopped"), { code: "provider_unavailable", failureCode: "provider_unavailable" });
    const { coordinator, highEvents } = setup({ classifier: classifier(async () => { throw missing; }) });

    await coordinator.process(clearPair());

    expect(highEvents[0]?.detection).toMatchObject({ band: "high", detectorVersion: "rules-v10" });
    expect(highEvents[0]?.detection?.signals).not.toContain("semantic_timeout");
  });

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
        detectorVersion: "rules-v10+semantic-v2",
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

  it("leaves a pair whose model call the quit cut short for the next start", async () => {
    // Read by the rules alone and acknowledged, it would never be read by the model; nor is a quit a failure.
    let cutShort!: (error: Error) => void;
    const classify = vi.fn(() => new Promise<SemanticClassification>((_resolve, reject) => { cutShort = reject; }));
    const { auditInputs, coordinator, highEvents, mediumCandidates } = setup({ classifier: classifier(classify) });

    const processing = coordinator.process(clearPair());
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    const closing = coordinator.close();
    cutShort(Object.assign(new Error("Model call was cancelled"), { code: "cancelled" }));
    await closing;

    await expect(processing).resolves.toBe("deferred");
    expect([...highEvents, ...mediumCandidates]).toEqual([]);
    expect(auditInputs).toEqual([]);
  });

  it("closes its semantic classification service once", async () => {
    const model = classifier(async () => classification());
    const { coordinator } = setup({ classifier: model });

    await coordinator.close();
    await coordinator.close();

    expect(model.close).toHaveBeenCalledOnce();
  });
});

it.each(["answer_only_requests_information", "answer_has_no_commitment"])("keeps %s custom when the model provides options", async signal => {
  class NoTakeAnalyzer extends TextDecisionAnalyzer {
    override complete(...args: Parameters<TextDecisionAnalyzer["complete"]>): ReturnType<TextDecisionAnalyzer["complete"]> {
      return { ...super.complete(...args), band: "medium", score: 60, signals: [signal], selected: [] };
    }
  }
  const question = "采用 Postgres 还是 Redis？";
  const { coordinator, highEvents, mediumCandidates } = setup({
    analyzer: new NoTakeAnalyzer(),
    classifier: classifier(async () => classification({ question, optionLabels: ["Postgres", "Redis"], answerExcerpt: "Redis" })),
  });
  await coordinator.process(clearPair({ assistantText: question, userText: "Redis" }));
  const event = [...highEvents, ...mediumCandidates.map(candidate => candidate.event)][0];
  expect(event?.questions[0]?.answer).toEqual({ kind: "custom", values: ["Redis"] });
});

// R16: options the model gave carry no id; the marker taken off for judging must not change which one was picked.
it.each([
  ["推荐项在第一位", ["兼容迁移（推荐）", "直接替换"], "直接替换", "直接替换"],
  ["推荐项在第一位，选推荐项", ["兼容迁移（推荐）", "直接替换"], "兼容迁移", "兼容迁移（推荐）"],
  ["推荐项在第二位", ["直接替换", "兼容迁移（推荐）"], "直接替换", "直接替换"],
])("records the option the reader picked among model-given options without ids: %s", async (_name, optionLabels, userText, expected) => {
  const assistantText = `${optionLabels.join("，")}。请你定下最终方向。`;
  const { coordinator, highEvents, mediumCandidates } = setup({
    classifier: classifier(async () => classification({ question: "请你定下最终方向。", optionLabels, answerExcerpt: userText })),
  });
  await coordinator.process(clearPair({ assistantText, userText }));
  const event = [...highEvents, ...mediumCandidates.map(candidate => candidate.event)][0];
  expect(event?.questions[0]?.options.map(option => option.label)).toEqual(optionLabels);
  expect(event?.questions[0]?.answer.values).toEqual([expected]);
});

describe('RSI-016: selection evidence is separate from decision intent', () => {
  const assistantText = 'A. Use an in-memory cache.\nB. Use a Redis cache.\nC. Keep the current cache.\n\nWhich implementation should we adopt?';
  const labels = ['Use an in-memory cache.', 'Use a Redis cache.', 'Keep the current cache.'];
  it('retains a literal label containing a conjunction without a model', async () => {
    const { coordinator, highEvents } = setup();
    await coordinator.process(semanticPairFixture({ assistantText: '1. 日志和指标\n2. 只记录日志\n3. 不采集\n\n请选择观测方案。', userText: '日志和指标' }));
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'preset', values: ['日志和指标'], reply: '日志和指标' });
  });
  it('matches a complete label before treating its parts as separate choices', async () => {
    const { coordinator, highEvents } = setup();
    await coordinator.process(semanticPairFixture({ assistantText: 'A. 备份和恢复\nB. 备份\nC. 恢复\n\n你选哪个？', userText: '备份和恢复' }));
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'preset', values: ['备份和恢复'], reply: '备份和恢复' });
  });
  it('retains a complete explicit exclusion without relying on semantic label generation', async () => {
    const reply = 'All except B.';
    const { coordinator, highEvents } = setup({ classifier: classifier(async () => classification({ question: 'Which implementation should we adopt?', optionLabels: [], selectedOptionIndices: [], answerExcerpt: reply })) });
    await coordinator.process(semanticPairFixture({ assistantText, userText: reply }));
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'multiple', values: [labels[0], labels[2]], reply });
  });
  it('excludes the complete label before considering its words as separate choices', async () => {
    const reply = 'All except 备份和恢复.';
    const { coordinator, highEvents } = setup();
    await coordinator.process(semanticPairFixture({ assistantText: 'A. 备份和恢复\nB. 备份\nC. 恢复\n\n你选哪个？', userText: reply }));
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'multiple', values: ['备份', '恢复'], reply });
  });
  it('does not split mixed compound names into unrelated options', async () => {
    const reply = 'All except 备份和恢复、日志.';
    const { coordinator, highEvents, mediumCandidates } = setup();
    await coordinator.process(semanticPairFixture({ assistantText: 'A. 备份和恢复\nB. 备份\nC. 恢复\nD. 日志\n\n你选哪些？', userText: reply }));
    const event = [...highEvents, ...mediumCandidates.map(candidate => candidate.event)][0];
    expect(event?.questions[0]?.answer).toEqual({ kind: 'custom', values: [reply] });
  });
  it.each([
    { optionLabels: [], selectedOptionIndices: [4] },
    { optionLabels: [labels[1]!, labels[0]!, labels[2]!], selectedOptionIndices: [1] },
    { optionLabels: labels, selectedOptionIndices: [1] },
    { optionLabels: labels, selectedOptionIndices: [] },
  ])('keeps invalid or conflicting semantic selections for confirmation: %j', async selection => {
    const reply = 'Choose B.';
    const { coordinator, highEvents, mediumCandidates, auditInputs } = setup({ classifier: classifier(async () => classification({ question: 'Which implementation should we adopt?', answerExcerpt: reply, ...selection })) });
    await coordinator.process(semanticPairFixture({ assistantText, userText: reply }));
    expect(highEvents).toHaveLength(0);
    expect(mediumCandidates[0]?.event.questions[0]?.answer).toEqual({ kind: 'custom', values: [reply] });
    expect(auditInputs.at(-1)).toMatchObject({ stage: 'routed', finalBand: 'medium' });
  });
  it('does not preselect a mentioned option when the semantic reading says undecided', async () => {
    const reply = "I haven't picked A; I want to understand why B has lower latency before making a decision.";
    const { coordinator, highEvents, mediumCandidates } = setup({ classifier: classifier(async () => classification({ question: 'Which implementation should we adopt?', optionLabels: labels, answerRelation: 'uncertain', answerExcerpt: reply })) });
    await coordinator.process(semanticPairFixture({ assistantText, userText: reply }));
    expect(highEvents).toHaveLength(0);
    expect(mediumCandidates[0]?.event.questions[0]?.answer).toEqual({ kind: 'custom', values: [reply] });
  });
  it('resolves a genuine choice from semantic option evidence, keeping the whole reply', async () => {
    const reply = 'I vote B.';
    const { coordinator, highEvents } = setup({ classifier: classifier(async () => classification({ question: 'Which implementation should we adopt?', optionLabels: labels, answerExcerpt: reply, selectedOptionIndices: [2], promptVersion: 'semantic-v4' })) });
    await coordinator.process(semanticPairFixture({ assistantText, userText: reply }));
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'preset', values: [labels[1]], reply });
  });
  it('binds selection indices to the actual options supplied to the classifier', async () => {
    const reply = 'I vote B.';
    const classify = vi.fn<SemanticClassificationService['classify']>(async () => classification({ question: 'Which implementation should we adopt?', optionLabels: [], answerExcerpt: reply, selectedOptionIndices: [2] }));
    const { coordinator, highEvents } = setup({ classifier: classifier(classify) });
    await coordinator.process(semanticPairFixture({ assistantText, userText: reply }));
    expect(classify.mock.calls[0]?.[0]).toMatchObject({ selectionOptions: labels.map((label, index) => ({ id: ['A', 'B', 'C'][index], label })) });
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'preset', values: [labels[1]], reply });
  });
  it('aligns a verbatim dash-numbered model label with its rule option', async () => {
    const reply = 'I vote B.';
    const { coordinator, highEvents } = setup({ classifier: classifier(async () => classification({ question: 'Which database should we use?', optionLabels: ['A — SQLite', 'B — PostgreSQL'], answerExcerpt: reply, selectedOptionIndices: [2] })) });
    await coordinator.process(semanticPairFixture({ assistantText: 'A — SQLite\nB — PostgreSQL\n\nWhich database should we use?', userText: reply }));
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'preset', values: ['PostgreSQL'], reply });
  });
  it('retains a supplied label normalized from Markdown in the original options', async () => {
    const reply = '我选择 B。';
    const { coordinator, highEvents } = setup({ classifier: classifier(async () => classification({ question: '你选哪个？', optionLabels: [], answerExcerpt: reply, selectedOptionIndices: [2] })) });
    await coordinator.process(semanticPairFixture({ assistantText: 'A. 不采集\nB. 采集**日志**和**指标**\nC. 只采集日志\n\n你选哪个？', userText: reply }));
    expect(highEvents[0]?.questions[0]?.answer).toEqual({ kind: 'preset', values: ['采集日志和指标'], reply });
  });
  it('keeps uncertain rule-only wording verbatim for confirmation instead of guessing an option', async () => {
    const reply = 'The old ticket says “choose B,” but that quote is only background. No option has been selected.';
    const { coordinator, highEvents, mediumCandidates } = setup();
    await coordinator.process(semanticPairFixture({ assistantText, userText: reply }));
    expect(highEvents).toHaveLength(0);
    expect(mediumCandidates[0]?.event.questions[0]?.answer).toEqual({ kind: 'custom', values: [reply] });
  });
});
