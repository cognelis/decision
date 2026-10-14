import type { IndexedDecision } from "@cognelis/decision-storage";

import type {
  DashboardSnapshot,
  RecentDecisionSummary,
} from "../shared/renderer-api.js";

interface DashboardIndex {
  count(): number;
  countSince(created: string): number;
  countReviewAttention(asOfDate: string): number;
  listRecent(limit: number): IndexedDecision[];
  revision(): number;
}

const EMPTY_DASHBOARD: DashboardSnapshot = {
  totalDecisions: 0,
  recorded7d: 0,
  reviewAttention: 0,
  recentDecisions: [],
};

const rationaleStatus = (
  value: string,
): RecentDecisionSummary["rationaleStatus"] =>
  value === "captured" ||
  value === "deferred" ||
  value === "skipped"
    ? value
    : "skipped";

export const readDashboardSnapshot = (
  index: DashboardIndex,
  now = new Date(),
  onFailure: (error: unknown) => void = () => undefined,
): DashboardSnapshot => {
  try {
    // Today and the six calendar days before it: the same "近 7 天" as the
    // retrospective and the knowledge page filter, so the numbers agree.
    const since = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 6,
    ).toISOString();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return {
      revision: index.revision(),
      totalDecisions: index.count(),
      recorded7d: index.countSince(since),
      reviewAttention: index.countReviewAttention(`${year}-${month}-${day}`),
      recentDecisions: index.listRecent(12).map((decision) => ({
        id: decision.id,
        created: decision.created,
        sourceClient: decision.sourceClient,
        project: decision.project,
        question: decision.question,
        selectedAnswer: decision.selectedAnswer,
        rationaleStatus: rationaleStatus(
          decision.rationaleStatus,
        ),
      })),
    };
  } catch (error) {
    onFailure(error);
    return { ...EMPTY_DASHBOARD, unavailable: true };
  }
};
