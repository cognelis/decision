import {
  buildMethodologyRecall,
  type MethodologyRecallMatch,
  type MethodologyRecord,
} from "@cognelis/decision-core";
import {
  DECISION_CONSULTATION_VERSION,
  decisionConsultationRequestSchema,
  decisionConsultationResponseSchema,
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
} from "@cognelis/decision-protocol";

export const buildDecisionConsultation = (
  input: DecisionConsultationRequest,
  methodologies: MethodologyRecord[],
  recalled?: MethodologyRecallMatch[],
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

  return decisionConsultationResponseSchema.parse({
    consultationVersion: DECISION_CONSULTATION_VERSION,
    requestId: request.requestId,
    status: matches.length === 0 ? "no_match" : "matched",
    generatedBy: "deterministic_local_match",
    matches,
    boundary: {
      advisoryOnly: true,
      noDecisionWritten: true,
      noPrincipleApplied: true,
    },
  });
};
