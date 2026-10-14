import {
  buildJournalRecall,
  buildMethodologyRecall,
  normalizedLanguages,
  type JournalEntry,
  type MethodologyRecallMatch,
  type MethodologyRecord,
} from "@cognelis/decision-core";
import {
  clipText,
  DECISION_CONSULTATION_VERSION,
  decisionConsultationRequestSchema,
  decisionConsultationResponseSchema,
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
} from "@cognelis/decision-protocol";

/** As long as a recalled preference's or idea's summary or qualifier may be in a consultation. */
const SIGNAL_TEXT_LIMIT = 4_000;

export const buildDecisionConsultation = (
  input: DecisionConsultationRequest,
  methodologies: MethodologyRecord[],
  recalled?: MethodologyRecallMatch[],
  /** null: they could not be read this time, which the answer says (signalsUnavailable). */
  journal: JournalEntry[] | null = [],
): DecisionConsultationResponse => {
  const request = decisionConsultationRequestSchema.parse(input);
  const byId = new Map(methodologies.map((record) => [record.id, record]));
  const matches = (recalled ??
    buildMethodologyRecall(
      methodologies,
      {
        question: request.question,
        selectedAnswer: null,
        optionLabels: request.options.map((option) => option.label),
        context: request.context,
      },
      3,
    )).flatMap((match) => {
    const methodology = byId.get(match.principleId);
    if (methodology === undefined || methodology.status !== "accepted") {
      return [];
    }
    return [
      {
        principleId: methodology.id,
        title: methodology.title,
        principle: methodology.principle,
        appliesWhen: methodology.appliesWhen,
        caution: methodology.caution,
        confidence: methodology.confidence,
        evidenceCount: methodology.sourceDecisionIds.length,
        relevanceScore: match.score,
        relevance: match.strength,
        reason: match.reason,
        matchedTerms: match.matchedTerms,
      },
    ];
  });

  // Recalled beside the principles, never folded into them: `status` and
  // `noMatchReason` stay statements about accepted principles, because that is
  // what a caller asking "is there a rule about this" needs to know.
  // A preference or idea may be longer than a consultation carries: it is cut and says so, rather
  // than the whole consultation refused, and the principles with it. Nor does a recall that fails.
  const excerpt = (text: string): string =>
    text.length <= SIGNAL_TEXT_LIMIT ? text : `${clipText(text, SIGNAL_TEXT_LIMIT - 5)}…（节选）`;
  let journalMatches: ReturnType<typeof buildJournalRecall> = [];
  try {
    journalMatches = buildJournalRecall(
      journal ?? [],
      {
        question: request.question,
        selectedAnswer: null,
        optionLabels: request.options.map((option) => option.label),
        context: request.context,
      },
      3,
      // Those of the code the choice is about, by one name each; left out by an older client, not known.
      request.languages === undefined ? null : normalizedLanguages(request.languages),
    );
  } catch {
    journalMatches = [];
  }
  const signals = journalMatches.map((match) => ({
    recordId: match.recordId,
    kind: match.kind,
    title: match.title,
    summary: excerpt(match.summary),
    standing: match.standing,
    qualifier: match.qualifier === null ? null : excerpt(match.qualifier),
    relevanceScore: match.score,
    relevance: match.strength,
    reason: match.reason,
    matchedTerms: match.matchedTerms,
  }));

  return decisionConsultationResponseSchema.parse({
    consultationVersion: DECISION_CONSULTATION_VERSION,
    requestId: request.requestId,
    status: matches.length === 0 ? "no_match" : "matched",
    ...(matches.length > 0 ? {} : {
      noMatchReason: methodologies.some((record) => record.status === "accepted")
        ? "no_relevant_principles" : "no_accepted_principles",
    }),
    generatedBy: "deterministic_local_match",
    matches,
    signals,
    ...(journal === null ? { signalsUnavailable: true } : {}),
    boundary: {
      advisoryOnly: true,
      noDecisionWritten: true,
      noPrincipleApplied: true,
      noPreferencePromoted: true,
    },
  });
};
