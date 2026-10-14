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
  ruleSignals?: string[];
  modelIntent?: SemanticClassification["decisionIntent"];
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

/**
 * An excerpt that runs across a blank line is not one sentence of the source,
 * it is a slab of it. A small model that cannot find the question answers with
 * the opening of the message instead, and `includes` alone cannot tell that
 * apart from a real quotation — both are verbatim substrings.
 */
const located = (
  source: string,
  excerpt: string | null,
): string | null =>
  excerpt !== null &&
  !/\n\s*\n/u.test(excerpt) &&
  source.includes(excerpt)
    ? excerpt
    : null;

/**
 * An option label has to be a label where it stands, not a run of characters
 * that happens to fall inside a longer word: `F` is in `activityFormat.util`,
 * and a model that answers with the alphabet gets every letter the message
 * spells anywhere accepted as a choice.
 *
 * Only Latin letters and digits are held to that boundary. Chinese writes no
 * spaces, so `处理技术债` inside `先处理技术债` is an ordinary excerpt of a real
 * option, not an accident — a boundary rule applied to Han would reject every
 * label the model gets right.
 */
const LATIN_WORD = /[A-Za-z0-9]/u;

const isLabelledOption = (
  source: string,
  option: string,
): boolean => {
  const first = option.slice(0, 1);
  const last = option.slice(-1);
  if (first.length === 0 || /\n\s*\n/u.test(option)) {
    return false;
  }
  for (
    let index = source.indexOf(option);
    index >= 0;
    index = source.indexOf(option, index + 1)
  ) {
    const before = index === 0 ? "" : source.slice(index - 1, index);
    const after = source.slice(
      index + option.length,
      index + option.length + 1,
    );
    if (
      !(LATIN_WORD.test(first) && LATIN_WORD.test(before)) &&
      !(LATIN_WORD.test(last) && LATIN_WORD.test(after))
    ) {
      return true;
    }
  }
  return false;
};

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
      isLabelledOption(pair.assistantText, option),
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
  const strongAnswer = (input.ruleSignals ?? []).some((signal) => ["answer_matches_option", "answer_is_explicit_approval", "answer_is_short_decision"].includes(signal));
  if (input.ruleSignals?.includes("answer_is_status_update")) {
    finalBand = "low";
    signals.push("completed_status_not_approval");
  } else if (input.modelBand === "low" && input.modelIntent === "none" && !strongAnswer && (input.answerRelation === "new_task" || input.answerRelation === "uncertain")) {
    finalBand = "low";
    signals.push("semantic_no_decision_without_answer_evidence");
  } else if (input.modelBand === "unavailable") {
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
