import { describe, expect, it } from "vitest";

import {
  captureAuditReceiptSchema,
  semanticClassificationSchema,
  semanticDecisionPairSchema,
  semanticPairDeliveryReceiptSchema,
  semanticRecognitionStatusSchema,
  semanticRouteDecisionSchema,
} from "../src/index.js";

const pair = {
  version: 1,
  pairId: "pair-1",
  sourceClient: "codex",
  sessionId: "session-1",
  assistantTurnId: "assistant-1",
  userTurnId: "user-1",
  cwd: "/Users/demo/project",
  assistantText: "先处理技术债，还是先提交当前这批？",
  userText: "本次引入的需要处理。另外，为什么要拆成两个字段？",
  context: {
    taskBackground: "继续提高 Decision 的采集质量。",
  },
  capturedAt: "2026-07-27T12:00:00.000Z",
  expiresAt: "2026-08-03T12:00:00.000Z",
} as const;

describe("semanticDecisionPairSchema", () => {
  it("accepts one bounded assistant and user turn", () => {
    expect(semanticDecisionPairSchema.parse(pair)).toEqual(pair);
    expect(
      semanticDecisionPairSchema.parse(pair).context?.taskBackground,
    ).toBe("继续提高 Decision 的采集质量。");
  });

  it("rejects oversized text, invalid expiry, and unknown fields", () => {
    expect(() =>
      semanticDecisionPairSchema.parse({
        ...pair,
        assistantText: "x".repeat(8_001),
      }),
    ).toThrow();
    expect(() =>
      semanticDecisionPairSchema.parse({
        ...pair,
        expiresAt: pair.capturedAt,
      }),
    ).toThrow(/expiry/u);
    expect(() =>
      semanticDecisionPairSchema.parse({
        ...pair,
        transcriptPath: "/tmp/private.jsonl",
      }),
    ).toThrow();
  });
});

describe("captureAuditReceiptSchema", () => {
  it("accepts content-free stage metadata", () => {
    const receipt = {
      version: 1,
      receiptId: "receipt-1",
      sourceClient: "codex",
      sessionFingerprint: "a".repeat(64),
      turnFingerprint: "b".repeat(64),
      stage: "classification_completed",
      textSource: "transcript_tail",
      ruleBand: "high",
      modelBand: "medium",
      finalBand: "medium",
      durationMs: 42,
      createdAt: "2026-07-27T12:00:01.000Z",
    } as const;

    expect(captureAuditReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(Object.keys(receipt)).not.toContain("sessionId");
    expect(JSON.stringify(receipt)).not.toContain(pair.assistantText);
    expect(JSON.stringify(receipt)).not.toContain(pair.cwd);
  });

  it("rejects raw identifiers, text, and unsupported error codes", () => {
    expect(() =>
      captureAuditReceiptSchema.parse({
        version: 1,
        receiptId: "receipt-1",
        sourceClient: "codex",
        sessionFingerprint: "a".repeat(64),
        stage: "failed",
        errorCode: "arbitrary stack trace",
        createdAt: "2026-07-27T12:00:01.000Z",
      }),
    ).toThrow();
    expect(() =>
      captureAuditReceiptSchema.parse({
        version: 1,
        receiptId: "receipt-1",
        sourceClient: "codex",
        sessionFingerprint: "a".repeat(64),
        stage: "hook_received",
        sessionId: "raw-session",
        createdAt: "2026-07-27T12:00:01.000Z",
      }),
    ).toThrow();
  });
});

describe("semanticClassificationSchema", () => {
  it("accepts a structured mixed answer without reasoning text", () => {
    const classification = {
      decisionIntent: "decision",
      answerRelation: "mixed",
      question: "先处理技术债还是提交？",
      optionLabels: ["处理技术债", "先提交"],
      answerExcerpt: "本次引入的需要处理",
      confidence: 0.91,
      provider: "qwen",
      modelVersion: "qwen3.5-2b-q4-k-m",
      promptVersion: "semantic-v1",
    } as const;

    expect(
      semanticClassificationSchema.parse(classification),
    ).toEqual(classification);
  });

  it("rejects unbounded arrays, confidence, and hidden reasoning", () => {
    expect(() =>
      semanticClassificationSchema.parse({
        decisionIntent: "decision",
        answerRelation: "answers",
        question: "继续吗？",
        optionLabels: Array.from({ length: 9 }, (_, index) =>
          String(index),
        ),
        answerExcerpt: "继续",
        confidence: 1.1,
        provider: "apple",
        modelVersion: "system",
        promptVersion: "semantic-v1",
        reasoning: "private chain of thought",
      }),
    ).toThrow();
  });
});

describe("semantic route and status contracts", () => {
  it("accepts conservative routing metadata", () => {
    expect(
      semanticRouteDecisionSchema.parse({
        ruleBand: "high",
        ruleScore: 100,
        modelBand: "medium",
        finalBand: "medium",
        answerRelation: "mixed",
        detectorVersion: "rules-v1+semantic-v1",
        signals: ["semantic_disagreement", "semantic_mixed"],
      }),
    ).toMatchObject({ finalBand: "medium" });
  });

  it("accepts read-only recognition diagnostics", () => {
    expect(
      semanticRecognitionStatusSchema.parse({
        provider: "qwen",
        providerLabel: "Qwen 本地模型",
        availability: "available",
        mode: "hybrid",
        modelVersion: "qwen3.5-2b-q4-k-m",
        promptVersion: "semantic-v1",
        processed7d: 12,
        high7d: 4,
        medium7d: 3,
        failures7d: 0,
        updatedAt: "2026-07-27T12:00:00.000Z",
      }),
    ).toBeTruthy();
    expect(
      semanticPairDeliveryReceiptSchema.parse({ accepted: true }),
    ).toEqual({ accepted: true });
  });
});
