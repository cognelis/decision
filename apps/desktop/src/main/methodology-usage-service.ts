import type { MethodologyRecord, OutcomeVerdict } from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";

import type {
  MethodologyUsageSnapshot,
  MethodologyValidationItem,
} from "../shared/renderer-api.js";

const reviewedVerdict = (decision: IndexedDecision): OutcomeVerdict | null =>
  decision.outcomeReviewedAt !== null &&
  (decision.outcomeVerdict === "better" ||
    decision.outcomeVerdict === "as_expected" ||
    decision.outcomeVerdict === "mixed" ||
    decision.outcomeVerdict === "worse" ||
    decision.outcomeVerdict === "unclear")
    ? decision.outcomeVerdict
    : null;

const toUsageDecision = (
  decision: IndexedDecision,
): MethodologyUsageSnapshot["decisions"][number] => {
  const verdict = reviewedVerdict(decision);
  return {
    id: decision.id,
    created: decision.created,
    project: decision.project,
    question: decision.question,
    selectedAnswer: decision.selectedAnswer,
    outcome: decision.outcome,
    outcomeReview:
      verdict === null
        ? null
        : {
            verdict,
            lesson: decision.outcomeLesson,
            reviewedAt: decision.outcomeReviewedAt!,
          },
  };
};

export const buildMethodologyUsageSnapshot = (
  principleId: string,
  decisions: IndexedDecision[],
): MethodologyUsageSnapshot => {
  const linked = decisions
    .filter((decision) => decision.appliedPrincipleIds.includes(principleId))
    .sort(
      (left, right) =>
        right.created.localeCompare(left.created) ||
        right.id.localeCompare(left.id),
    );
  const verdicts = linked.flatMap((decision) => {
    const verdict = reviewedVerdict(decision);
    return verdict === null ? [] : [verdict];
  });
  return {
    principleId,
    linkedDecisionCount: linked.length,
    outcomeRecordedCount: linked.filter((decision) => decision.outcome !== null)
      .length,
    reviewedCount: verdicts.length,
    pendingOutcomeCount: linked.filter((decision) => decision.outcome === null)
      .length,
    pendingReviewCount: linked.filter(
      (decision) =>
        decision.outcome !== null && reviewedVerdict(decision) === null,
    ).length,
    favorableCount: verdicts.filter(
      (verdict) => verdict === "better" || verdict === "as_expected",
    ).length,
    mixedCount: verdicts.filter((verdict) => verdict === "mixed").length,
    attentionCount: verdicts.filter((verdict) => verdict === "worse").length,
    unclearCount: verdicts.filter((verdict) => verdict === "unclear").length,
    decisions: linked.slice(0, 50).map(toUsageDecision),
    nextPendingDecision:
      linked
        .filter(
          (decision) =>
            decision.outcome === null || reviewedVerdict(decision) === null,
        )
        .map(toUsageDecision)[0] ?? null,
  };
};

const reviewPositionAfter = (
  reviewedAt: string,
  decisionId: string,
  cursor: MethodologyRecord["usageValidation"],
): boolean =>
  cursor === undefined ||
  reviewedAt > cursor.reviewedAt ||
  (reviewedAt === cursor.reviewedAt && decisionId > cursor.decisionId);

const toValidationDecision = (
  decision: IndexedDecision,
  verdict: OutcomeVerdict,
): MethodologyValidationItem["decisions"][number] => ({
  id: decision.id,
  project: decision.project,
  question: decision.question,
  selectedAnswer: decision.selectedAnswer,
  verdict,
  lesson: decision.outcomeLesson,
  reviewedAt: decision.outcomeReviewedAt!,
});

export const buildMethodologyValidationInbox = (
  methodologies: MethodologyRecord[],
  decisions: IndexedDecision[],
): MethodologyValidationItem[] => {
  const revisionDraftBySource = new Map(
    methodologies
      .filter(
        (methodology) =>
          methodology.status === "candidate" &&
          methodology.origin === "principle_revision" &&
          methodology.sourcePrincipleIds?.[0] !== undefined,
      )
      .map((methodology) => [methodology.sourcePrincipleIds![0]!, methodology.id]),
  );
  const items = methodologies.flatMap((methodology) => {
    if (methodology.status !== "accepted") return [];
    const sourceIds = new Set(methodology.sourceDecisionIds);
    const reviewed = decisions
      .flatMap((decision) => {
        if (
          sourceIds.has(decision.id) ||
          !decision.appliedPrincipleIds.includes(methodology.id)
        ) {
          return [];
        }
        const verdict = reviewedVerdict(decision);
        if (
          verdict === null ||
          !reviewPositionAfter(
            decision.outcomeReviewedAt!,
            decision.id,
            methodology.usageValidation,
          )
        ) {
          return [];
        }
        return [{ decision, verdict }];
      })
      .sort(
        (left, right) =>
          right.decision.outcomeReviewedAt!.localeCompare(
            left.decision.outcomeReviewedAt!,
          ) || right.decision.id.localeCompare(left.decision.id),
      );
    if (reviewed.length === 0) return [];
    return [
      {
        principleId: methodology.id,
        title: methodology.title,
        principle: methodology.principle,
        newReviewedCount: reviewed.length,
        favorableCount: reviewed.filter(
          ({ verdict }) => verdict === "better" || verdict === "as_expected",
        ).length,
        attentionCount: reviewed.filter(
          ({ verdict }) => verdict === "mixed" || verdict === "worse",
        ).length,
        unclearCount: reviewed.filter(({ verdict }) => verdict === "unclear")
          .length,
        newestReviewedAt: reviewed[0]!.decision.outcomeReviewedAt!,
        revisionDraftId: revisionDraftBySource.get(methodology.id) ?? null,
        decisions: reviewed
          .slice(0, 3)
          .map(({ decision, verdict }) =>
            toValidationDecision(decision, verdict),
          ),
      },
    ];
  });
  return items.sort(
    (left, right) =>
      Number(right.attentionCount > 0) - Number(left.attentionCount > 0) ||
      right.newestReviewedAt.localeCompare(left.newestReviewedAt) ||
      left.title.localeCompare(right.title, "zh-CN"),
  );
};
