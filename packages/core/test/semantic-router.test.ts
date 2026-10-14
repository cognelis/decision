import type {
  SemanticClassification,
  SemanticDecisionPair,
  SemanticModelBand,
} from "@cognelis/decision-protocol";
import { describe, expect, it } from "vitest";

import {
  routeSemanticDecision,
  validateSemanticClassification,
} from "../src/index.js";

const pair: SemanticDecisionPair = {
  version: 1,
  pairId: "pair-1",
  sourceClient: "codex",
  sessionId: "session-1",
  cwd: "/tmp/project",
  assistantText: "先处理技术债，还是先提交当前这批？",
  userText: "本次引入的需要处理。另外，为什么要拆字段？",
  capturedAt: "2026-07-27T12:00:00.000Z",
  expiresAt: "2026-08-03T12:00:00.000Z",
};

const classification = (
  overrides: Partial<SemanticClassification> = {},
): SemanticClassification => ({
  decisionIntent: "decision",
  answerRelation: "mixed",
  question: "先处理技术债，还是先提交当前这批？",
  optionLabels: ["处理技术债", "先提交当前这批"],
  answerExcerpt: "本次引入的需要处理",
  confidence: 0.92,
  provider: "qwen",
  modelVersion: "qwen3.5-2b-q4-k-m",
  promptVersion: "semantic-v1",
  ...overrides,
});

describe("routeSemanticDecision", () => {
  it("vetoes completed-status notifications even when the model calls them approval", () => {
    expect(routeSemanticDecision({ ruleBand: "low", modelBand: "high", answerRelation: "answers", ruleSignals: ["answer_is_status_update"] }).finalBand).toBe("low");
  });
  it("rejects a different task without answer evidence but preserves a genuine approval the model missed", () => {
    const input = { ruleBand: "high" as const, modelBand: "low" as const, answerRelation: "new_task" as const, modelIntent: "none" as const };
    expect(routeSemanticDecision(input).finalBand).toBe("low");
    expect(routeSemanticDecision({ ...input, ruleSignals: ["answer_is_explicit_approval"] }).finalBand).toBe("medium");
  });
  it.each([
    ["high", "high", "high"],
    ["high", "medium", "medium"],
    ["high", "low", "medium"],
    ["medium", "high", "medium"],
    ["medium", "medium", "medium"],
    ["medium", "low", "medium"],
    ["low", "high", "medium"],
    ["low", "medium", "medium"],
    ["low", "low", "low"],
    ["high", "unavailable", "high"],
    ["medium", "unavailable", "medium"],
    ["low", "unavailable", "low"],
  ] as const)(
    "routes rule %s and model %s to %s",
    (ruleBand, modelBand, expected) => {
      expect(
        routeSemanticDecision({
          ruleBand,
          modelBand,
          answerRelation:
            modelBand === "unavailable" ? null : "answers",
        }),
      ).toMatchObject({ finalBand: expected });
    },
  );

  it("marks disagreement and mixed answers without dropping them", () => {
    expect(
      routeSemanticDecision({
        ruleBand: "low",
        ruleScore: 20,
        modelBand: "high",
        answerRelation: "mixed",
      }),
    ).toMatchObject({
      finalBand: "medium",
      answerRelation: "mixed",
      signals: expect.arrayContaining([
        "semantic_disagreement",
        "semantic_mixed",
      ]),
    });
  });

  it("caps a high recovered pair at medium after fifteen minutes", () => {
    expect(
      routeSemanticDecision({
        ruleBand: "high",
        modelBand: "high",
        answerRelation: "answers",
        pairAgeMs: 15 * 60 * 1_000 + 1,
      }),
    ).toMatchObject({
      finalBand: "medium",
      signals: expect.arrayContaining(["stale_recovery_cap"]),
    });
  });
});

describe("validateSemanticClassification", () => {
  it("keeps only question, options, and answer excerpts found in source text", () => {
    expect(
      validateSemanticClassification(
        pair,
        classification({
          optionLabels: [
            "处理技术债",
            "模型凭空创造的选项",
            "先提交当前这批",
          ],
          answerExcerpt: "模型凭空创造的回答",
        }),
      ),
    ).toMatchObject({
      question: "先处理技术债，还是先提交当前这批？",
      optionLabels: ["处理技术债", "先提交当前这批"],
      answerExcerpt: null,
    });
  });

  it("rejects a question that is a slab of the message rather than a sentence", () => {
    // What a model that cannot find the question actually returns: the opening
    // of the message, copied verbatim until the length cap cut it off. Every
    // character of it is in the source, so a substring check cannot tell.
    const dump: SemanticDecisionPair = {
      ...pair,
      assistantText:
        "C 记下：统一用 `_title`。这是破坏性契约变更。\n\n后端要改物化输出、缺失兜底、`display",
    };
    expect(
      validateSemanticClassification(
        dump,
        classification({
          question: dump.assistantText,
          optionLabels: [],
        }),
      ).question,
    ).toBeNull();
  });

  it("drops a letter that only occurs inside a longer word", () => {
    const letters: SemanticDecisionPair = {
      ...pair,
      assistantText:
        "前端要改 `activityFormat.util.ts:191`。\n\n- **A**：一次性同步改。\n- **B**：后端过渡期双写。",
    };
    expect(
      validateSemanticClassification(
        letters,
        classification({
          question: null,
          optionLabels: ["A", "B", "C", "D", "E", "F", "G", "H"],
        }),
      ).optionLabels,
    ).toEqual(["A", "B"]);
  });

  it("rejects a fabricated question and structurally invalid model output", () => {
    expect(
      validateSemanticClassification(
        pair,
        classification({ question: "是否删除生产数据库？" }),
      ).question,
    ).toBeNull();
    expect(() =>
      validateSemanticClassification(pair, {
        ...classification(),
        confidence: 5,
      }),
    ).toThrow();
  });

  it.each([
    ["decision", "answers", 0.9, "high"],
    ["approval", "mixed", 0.6, "medium"],
    ["information_request", "answers", 0.99, "low"],
    ["decision", "new_task", 0.99, "low"],
    ["decision", "uncertain", 0.3, "low"],
  ] as const)(
    "derives %s/%s at %s as %s",
    (decisionIntent, answerRelation, confidence, expected) => {
      const validated = validateSemanticClassification(
        pair,
        classification({
          decisionIntent,
          answerRelation,
          confidence,
        }),
      );
      expect(validated.band satisfies SemanticModelBand).toBe(
        expected,
      );
    },
  );
});
