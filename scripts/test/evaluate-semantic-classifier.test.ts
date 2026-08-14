import { describe, expect, it } from "vitest";

// @ts-expect-error The evaluator is a directly executable ESM module.
import {
  createProviderPredictor,
  evaluateSemanticCorpus,
  evaluationExitCode,
  formatEvaluationError,
  formatHumanReport,
  parseEvaluatorArgs,
} from "../evaluate-semantic-classifier.mjs";

const samples = [
  {
    id: "zh-high",
    sourceClient: "codex",
    locale: "zh-CN",
    assistantText: "选 A 还是 B？",
    userText: "A",
    expectedBand: "high",
    expectedRelation: "answers",
  },
  {
    id: "en-missed",
    sourceClient: "claude-code",
    locale: "en",
    assistantText: "Would you prefer the safe path?",
    userText: "Yes",
    expectedBand: "medium",
    expectedRelation: "answers",
  },
  {
    id: "zh-false-positive",
    sourceClient: "codex",
    locale: "zh-CN",
    assistantText: "测试日志中的问题？",
    userText: "继续",
    expectedBand: "low",
    expectedRelation: "new_task",
  },
  {
    id: "en-mixed",
    sourceClient: "claude-code",
    locale: "en",
    assistantText: "Ship now or fix first?",
    userText: "Fix first, and explain the field split.",
    expectedBand: "medium",
    expectedRelation: "mixed",
  },
  {
    id: "en-negative",
    sourceClient: "codex",
    locale: "en",
    assistantText: "All tests passed.",
    userText: "Continue.",
    expectedBand: "low",
    expectedRelation: "new_task",
  },
] as const;

const predictions = {
  "zh-high": {
    band: "high",
    relation: "answers",
    question: "选 A 还是 B？",
    answerExcerpt: "A",
  },
  "en-missed": {
    band: "low",
    relation: "uncertain",
    question: null,
    answerExcerpt: null,
  },
  "zh-false-positive": {
    band: "high",
    relation: "new_task",
    question: "测试日志中的问题？",
    answerExcerpt: "继续",
  },
  "en-mixed": {
    band: "medium",
    relation: "mixed",
    question: "Ship now or fix first?",
    answerExcerpt: "Fix first",
  },
  "en-negative": {
    band: "low",
    relation: "new_task",
    question: null,
    answerExcerpt: null,
  },
} as const;

describe("semantic evaluator", () => {
  it("maps the explicit user-data option without falling back to real app data", () => {
    expect(
      parseEvaluatorArgs([
        "--provider",
        "builtin-codex",
        "--user-data",
        "/private/tmp/provider-smoke",
      ]),
    ).toMatchObject({
      provider: "builtin-codex",
      userData: "/private/tmp/provider-smoke",
    });
  });

  it("formats only stable and already-sanitized provider diagnostics", () => {
    expect(
      formatEvaluationError({
        message: "Managed model process exited unsuccessfully",
        code: "process_failed",
        processExitCode: 2,
        diagnosticExcerpt: "error: unsupported flag",
      }),
    ).toBe(
      "Managed model process exited unsuccessfully [process_failed, exit 2]: error: unsupported flag",
    );
  });

  it("computes deterministic aggregate, confusion, and slice metrics", async () => {
    const original = structuredClone(samples);
    const report = await evaluateSemanticCorpus({
      samples,
      predictor: async (sample: (typeof samples)[number]) =>
        predictions[sample.id],
    });

    expect(report.summary).toMatchObject({
      samples: 5,
      highPrecision: 0.5,
      highMediumRecall: 0.666667,
      relationAccuracy: 4 / 5,
      questionExtractability: 1,
      answerExtractability: 1,
      thresholdsMet: false,
    });
    expect(report.confusion).toEqual({
      high: { high: 1, medium: 0, low: 0 },
      medium: { high: 0, medium: 1, low: 1 },
      low: { high: 1, medium: 0, low: 1 },
    });
    expect(report.slices.locale).toMatchObject({
      "zh-CN": {
        samples: 2,
        highPrecision: 0.5,
        highMediumRecall: 1,
      },
      en: {
        samples: 3,
        highPrecision: 1,
        highMediumRecall: 0.5,
      },
    });
    expect(report.slices.sourceClient).toMatchObject({
      codex: { samples: 3 },
      "claude-code": { samples: 2 },
    });
    expect(samples).toEqual(original);
  });

  it("fails unmet thresholds unless report-only is explicit", async () => {
    const report = await evaluateSemanticCorpus({
      samples,
      predictor: async (sample: (typeof samples)[number]) =>
        predictions[sample.id],
    });

    expect(evaluationExitCode(report, { reportOnly: false })).toBe(1);
    expect(evaluationExitCode(report, { reportOnly: true })).toBe(0);
    expect(formatHumanReport(report)).toContain(
      "High precision",
    );
    expect(formatHumanReport(report)).toContain(
      "50.0%",
    );
  });

  it("reports per-provider latency and token usage without inventing missing values", async () => {
    const providerPredictions = {
      ...predictions,
      "zh-high": {
        ...predictions["zh-high"],
        provider: "codex-cli",
        latencyMs: 900,
        usage: {
          source: "provider_reported",
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        },
      },
      "en-missed": {
        ...predictions["en-missed"],
        provider: "codex-cli",
        latencyMs: 700,
        usage: {
          source: "unavailable",
        },
      },
      "zh-false-positive": {
        ...predictions["zh-false-positive"],
        provider: "codex-cli",
        latencyMs: 1_100,
        usage: {
          source: "provider_reported",
          inputTokens: 80,
          outputTokens: 20,
          totalTokens: 100,
        },
      },
      "en-mixed": {
        ...predictions["en-mixed"],
        provider: "claude-code-cli",
        latencyMs: 500,
        usage: {
          source: "provider_reported",
          inputTokens: 60,
          outputTokens: 15,
          totalTokens: 75,
          costUsd: 0.001,
        },
      },
      "en-negative": {
        ...predictions["en-negative"],
        provider: "claude-code-cli",
        latencyMs: 300,
        usage: {
          source: "provider_reported",
          inputTokens: 40,
          outputTokens: 10,
          totalTokens: 50,
          costUsd: 0.002,
        },
      },
    } as const;

    const report = await evaluateSemanticCorpus({
      samples,
      predictor: async (sample: (typeof samples)[number]) =>
        providerPredictions[sample.id],
    });

    expect(report.providers).toEqual({
      "claude-code-cli": expect.objectContaining({
        provider: "claude-code-cli",
        samples: 2,
        medianLatencyMs: 400,
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        costUsd: 0.003,
        tokenUsageUnavailable: 0,
      }),
      "codex-cli": expect.objectContaining({
        provider: "codex-cli",
        samples: 3,
        medianLatencyMs: 900,
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        costUsd: null,
        tokenUsageUnavailable: 1,
      }),
    });
    expect(formatHumanReport(report)).toContain(
      "codex-cli",
    );
    expect(formatHumanReport(report)).toContain(
      "200 input / 50 output",
    );
  });

  it("combines a selected provider result with the unchanged routing guardrails", async () => {
    const predictor = createProviderPredictor({
      provider: "builtin-codex",
      rulePredictor: async () => ({
        band: "high",
        relation: "answers",
        question: "选 A 还是 B？",
        answerExcerpt: "A",
      }),
      invoke: async () => ({
        classification: {
          decisionIntent: "decision",
          answerRelation: "answers",
          question: "选 A 还是 B？",
          optionLabels: ["A", "B"],
          answerExcerpt: "A",
          confidence: 0.92,
          provider: "codex-cli",
          modelVersion: "gpt-test",
          promptVersion: "semantic-v1",
        },
        visibleOutput: "{}",
        traceInput: {
          systemPrompt: "system",
          userPrompt: "user",
          outputSchema: {},
          clientSystemPromptVisibility: "opaque",
        },
        usage: {
          source: "provider_reported",
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
        },
        providerDurationMs: 321.6,
      }),
      validateClassification: (_pair: unknown, value: unknown) => ({
        ...(value as Record<string, unknown>),
        band: "high",
      }),
      routeDecision: () => ({
        finalBand: "high",
      }),
    });

    await expect(predictor(samples[0])).resolves.toEqual({
      band: "high",
      relation: "answers",
      question: "选 A 还是 B？",
      answerExcerpt: "A",
      provider: "builtin-codex",
      latencyMs: 322,
      usage: {
        source: "provider_reported",
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    });
  });
});
