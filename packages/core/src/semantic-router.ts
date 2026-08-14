import {
  semanticClassificationSchema,
  semanticRouteDecisionSchema,
  type AnswerRelation,
  type SemanticBand,
  type SemanticClassification,
  type SemanticDecisionPair,
  type SemanticModelBand,
  type SemanticRouteDecision,
} from "@cognelis/decision-protocol";

export interface ValidatedSemanticClassification
  extends SemanticClassification {
  band: SemanticBand;
}

export interface SemanticRoutingInput {
  ruleBand: SemanticBand;
  ruleScore?: number;
  modelBand: SemanticModelBand;
  answerRelation: AnswerRelation | null;
  pairAgeMs?: number;
}

const RECOVERY_HIGH_LIMIT_MS = 15 * 60 * 1_000;

const defaultRuleScore = (band: SemanticBand): number =>
  band === "high" ? 75 : band === "medium" ? 50 : 0;

const classificationBand = (
  classification: SemanticClassification,
): SemanticBand => {
  const awaitsHumanDecision =
    classification.decisionIntent === "decision" ||
    classification.decisionIntent === "approval";
  const answersDecision =
    classification.answerRelation === "answers" ||
    classification.answerRelation === "mixed";
  if (!awaitsHumanDecision || !answersDecision) {
    return "low";
  }
  if (classification.confidence >= 0.8) {
    return "high";
  }
  return classification.confidence >= 0.55
    ? "medium"
    : "low";
};

const located = (
  source: string,
  excerpt: string | null,
): string | null =>
  excerpt !== null && source.includes(excerpt)
    ? excerpt
    : null;

export const validateSemanticClassification = (
  pair: SemanticDecisionPair,
  input: unknown,
): ValidatedSemanticClassification => {
  const classification =
    semanticClassificationSchema.parse(input);
  const validated: SemanticClassification = {
    ...classification,
    question: located(
      pair.assistantText,
      classification.question,
    ),
    optionLabels: classification.optionLabels.filter((option) =>
      pair.assistantText.includes(option),
    ),
    answerExcerpt: located(
      pair.userText,
      classification.answerExcerpt,
    ),
  };
  return {
    ...validated,
    band: classificationBand(validated),
  };
};

export const routeSemanticDecision = (
  input: SemanticRoutingInput,
): SemanticRouteDecision => {
  const signals: string[] = [];
  let finalBand: SemanticBand;
  if (input.modelBand === "unavailable") {
    finalBand = input.ruleBand;
    signals.push("semantic_unavailable");
  } else if (input.ruleBand === input.modelBand) {
    finalBand = input.ruleBand;
    signals.push("semantic_agreement");
  } else {
    finalBand = "medium";
    signals.push("semantic_disagreement");
  }
  if (input.answerRelation === "mixed") {
    signals.push("semantic_mixed");
  }
  if (
    finalBand === "high" &&
    (input.pairAgeMs ?? 0) > RECOVERY_HIGH_LIMIT_MS
  ) {
    finalBand = "medium";
    signals.push("stale_recovery_cap");
  }
  return semanticRouteDecisionSchema.parse({
    ruleBand: input.ruleBand,
    ruleScore:
      input.ruleScore ?? defaultRuleScore(input.ruleBand),
    modelBand: input.modelBand,
    finalBand,
    answerRelation: input.answerRelation,
    detectorVersion:
      input.modelBand === "unavailable"
        ? "rules-v1"
        : "rules-v1+semantic-v1",
    signals,
  });
};
