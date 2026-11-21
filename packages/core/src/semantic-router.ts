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

import { withholdsDecision } from "./text-decision-analyzer.js";

export interface ValidatedSemanticClassification
  extends SemanticClassification {
  band: SemanticBand;
  selectionValid?: boolean;
}

export interface SemanticRoutingInput {
  ruleBand: SemanticBand;
  ruleScore?: number;
  modelBand: SemanticModelBand;
  answerRelation: AnswerRelation | null;
  pairAgeMs?: number;
  ruleSignals?: string[];
  modelIntent?: SemanticClassification["decisionIntent"];
  /**
   * A model was there and asked, and ran out of time. That is no reading of the exchange, so it cannot agree with
   * the rules' high, and it is not a model that is missing or turned off either, where the rules stand alone.
   */
  modelTimedOut?: boolean;
  /** The reply itself, for the one branch that takes the rules' reading over the model's. */
  userText?: string;
}

const RECOVERY_HIGH_LIMIT_MS = 15 * 60 * 1_000;

/**
 * The rules read the reply as putting the choice off, or saying how things are: a reading
 * of what the reply is, not a failure to find the choice in it. The model alone does not overrule that into a
 * pending candidate. Evaluations stay out: "2 比 1 好" is scored as one, and is a preference the model may be
 * right about.
 */
/** The rules found the reply taking or approving something itself, not only naming an option. */
const RULE_READ_COMMITMENT = [
  "answer_partially_approves",
  "answer_is_explicit_approval",
  "answer_is_short_decision",
  "answer_takes_one_option",
  "answer_is_directional_approval",
];

const RULE_READ_NO_ANSWER = [
  // Not a request to see something: "Show me the SQL first, then go ahead and apply it" is read as one by the
  // rules and is an approval (R8-SEM2 T08).
  "answer_defers_decision",
  "answer_describes_current_state",
  // The reply answers another message; a model reading this pair has only this one to go on.
  "answer_numbers_not_asked",
];

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
  // Only the analyzer's source-derived labels, which may already have Markdown removed.
  sourceOptionLabels: readonly string[] = [],
): ValidatedSemanticClassification => {
  const classification =
    semanticClassificationSchema.parse(input);
  const optionLabels = classification.optionLabels.filter((option) => sourceOptionLabels.includes(option) || isLabelledOption(pair.assistantText, option));
  const declared = classification.selectedOptionIndices;
  const selectionValid = declared !== undefined && declared.every((index) => {
    const label = classification.optionLabels[index - 1];
    return label !== undefined && optionLabels.includes(label) && classification.optionLabels.filter((other) => other === label).length === 1;
  });
  const validated: SemanticClassification = {
    ...classification,
    question: located(
      pair.assistantText,
      classification.question,
    ),
    optionLabels,
    ...(declared === undefined ? {} : { selectedOptionIndices: selectionValid ? [...new Set(declared.map((index) => optionLabels.indexOf(classification.optionLabels[index - 1]!) + 1))] : [] }),
    answerExcerpt: located(
      pair.userText,
      classification.answerExcerpt,
    ),
  };
  return {
    ...validated,
    band: classificationBand(validated),
    ...(declared === undefined ? {} : { selectionValid }),
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
  } else if (input.ruleBand !== "medium" && input.modelBand === "low" && input.modelIntent === "none" && !strongAnswer && (input.answerRelation === "new_task" || input.answerRelation === "uncertain")) {
    // A medium is the rules saying they could not tell: the reader decides that, not a model that saw no decision.
    finalBand = "low";
    signals.push("semantic_no_decision_without_answer_evidence");
  } else if (input.modelBand === "unavailable" && input.modelTimedOut === true) {
    finalBand = input.ruleBand === "high" ? "medium" : input.ruleBand;
    signals.push("semantic_timeout");
  } else if (input.modelBand === "unavailable") {
    finalBand = input.ruleBand;
    signals.push("semantic_unavailable");
  } else if (input.ruleBand === "low" && (input.ruleSignals ?? []).some((signal) => RULE_READ_NO_ANSWER.includes(signal))) {
    finalBand = "low";
    signals.push("rule_read_no_answer");
  } else if (
    // The model says the reply answers, and in the same reading that nothing was asked: it contradicts itself,
    // and does not pull down a commitment the rules read in the reply.
    input.ruleBand === "high" &&
    input.modelBand === "low" &&
    (input.answerRelation === "answers" || input.answerRelation === "mixed") &&
    input.modelIntent !== "decision" &&
    input.modelIntent !== "approval" &&
    (input.ruleSignals ?? []).some((signal) => RULE_READ_COMMITMENT.includes(signal)) &&
    // "可以，不过我还没决定合不合，等 QA 的结果" carries an approval word and holds the decision back (R8-SEM2 F03).
    input.userText !== undefined &&
    !withholdsDecision(input.userText)
  ) {
    finalBand = "high";
    signals.push("semantic_intent_contradiction");
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
        ? "rules-v10"
        : "rules-v10+semantic-v2",
    signals,
  });
};
