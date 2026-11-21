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

  it.each([
    ["high", "medium"],
    ["medium", "medium"],
    ["low", "low"],
  ] as const)(
    "holds a rule %s at %s when the model was asked and ran out of time",
    (ruleBand, expected) => {
      expect(
        routeSemanticDecision({
          ruleBand,
          modelBand: "unavailable",
          answerRelation: null,
          modelTimedOut: true,
        }),
      ).toMatchObject({
        finalBand: expected,
        detectorVersion: "rules-v10",
        signals: ["semantic_timeout"],
      });
    },
  );

  it("keeps the rules' high when the model reads the reply as an answer yet sees no decision asked", () => {
    // R8 holdout v5: a partial approval, `answers` from the model with intent `none`, was pulled to medium.
    const input = { ruleBand: "high" as const, modelBand: "low" as const, answerRelation: "answers" as const, modelIntent: "none" as const, ruleSignals: ["has_choice_prompt", "answer_partially_approves"], userText: "1 和 2 做，3 先不做" };
    expect(routeSemanticDecision(input)).toMatchObject({ finalBand: "high", signals: ["semantic_intent_contradiction"] });
    expect(routeSemanticDecision({ ...input, answerRelation: "mixed", modelIntent: "information_request" }).finalBand).toBe("high");
    // Naming an option is what evaluations and mentions do too: not enough to overrule the model.
    expect(routeSemanticDecision({ ...input, ruleSignals: ["has_choice_prompt", "answer_matches_option"] }).finalBand).toBe("medium");
    // A model that says decision and not answered is no contradiction.
    expect(routeSemanticDecision({ ...input, answerRelation: "uncertain", modelIntent: "decision" }).finalBand).toBe("medium");
    expect(routeSemanticDecision({ ...input, ruleBand: "medium" }).finalBand).toBe("medium");
    // R8-SEM2 F03 (synthetic model output): an approval word with the decision held back is not a commitment.
    for (const userText of ["可以，不过我还没决定合不合，等 QA 的结果。", "Sounds good, but I haven't decided yet.", "行，先压测一下再确认。"]) {
      expect(routeSemanticDecision({ ...input, ruleSignals: ["has_choice_prompt", "answer_is_explicit_approval"], userText }).finalBand).toBe("medium");
    }
    // Putting one item off is part of a partial approval, not the decision held back.
    expect(routeSemanticDecision({ ...input, userText: "1 和 2 做，3 以后再说" }).finalBand).toBe("high");
    // Without the reply to read, the rules' reading is not taken over the model.
    const { userText: _reply, ...unread } = input;
    expect(routeSemanticDecision(unread).finalBand).toBe("medium");
  });

  it("leaves a reply the rules were unsure of for the reader, whatever the model says of it", () => {
    expect(
      routeSemanticDecision({ ruleBand: "medium", modelBand: "low", answerRelation: "uncertain", modelIntent: "none", ruleSignals: ["answer_relation_uncertain"] }).finalBand,
    ).toBe("medium");
  });

  it("lets the model lift a request to see something first, which may come with the go-ahead", () => {
    // R8-SEM2 T08: "Show me the SQL first, then go ahead and apply it" read by the rules as a request alone.
    expect(
      routeSemanticDecision({ ruleBand: "low", modelBand: "high", answerRelation: "answers", ruleSignals: ["has_choice_prompt", "answer_only_requests_information"], modelIntent: "approval" }).finalBand,
    ).toBe("medium");
  });

  it.each([
    "answer_defers_decision",
    "answer_describes_current_state",
  ])("does not let the model alone lift a reply the rules read as taking no option (%s)", (signal) => {
    expect(
      routeSemanticDecision({
        ruleBand: "low",
        modelBand: "high",
        answerRelation: "answers",
        ruleSignals: ["has_choice_prompt", signal],
        modelIntent: "decision",
      }),
    ).toMatchObject({ finalBand: "low", signals: ["rule_read_no_answer"] });
  });

  it("still lifts a rule low the rules could not read, and an evaluation that may be a preference", () => {
    for (const ruleSignals of [[], ["has_choice_prompt", "answer_only_evaluates"]]) {
      expect(
        routeSemanticDecision({ ruleBand: "low", modelBand: "high", answerRelation: "answers", ruleSignals, modelIntent: "decision" }).finalBand,
      ).toBe("medium");
    }
  });

  it("keeps a completed-status veto over a timed-out model", () => {
    expect(
      routeSemanticDecision({
        ruleBand: "high",
        modelBand: "unavailable",
        answerRelation: null,
        ruleSignals: ["answer_is_status_update"],
        modelTimedOut: true,
      }).finalBand,
    ).toBe("low");
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

describe('RSI-016: grounded semantic selection', () => {
  const source = { ...pair, assistantText: 'A. SQLite\nB. PostgreSQL\n\nWhich one?', userText: 'B' };
  it('remaps selected positions after invalid option labels are removed', () => {
    const result = validateSemanticClassification(source, classification({ optionLabels: ['invented', 'PostgreSQL'], selectedOptionIndices: [2] }));
    expect(result.optionLabels).toEqual(['PostgreSQL']);
    expect(result.selectedOptionIndices).toEqual([1]);
    expect(result.selectionValid).toBe(true);
  });
  it.each([
    { optionLabels: ['invented', 'PostgreSQL'], selectedOptionIndices: [1] },
    { optionLabels: ['SQLite', 'PostgreSQL'], selectedOptionIndices: [3] },
    { optionLabels: ['PostgreSQL', 'PostgreSQL'], selectedOptionIndices: [2] },
  ])('does not convert ungrounded or ambiguous model selections into a real option', (output) => {
    const result = validateSemanticClassification(source, classification(output));
    expect(result.selectionValid).toBe(false);
    expect(result.selectedOptionIndices).toEqual([]);
  });
});
