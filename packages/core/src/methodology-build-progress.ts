import type { MethodologyRecord } from "./methodology.js";
import type { PracticeAssetRecord } from "./practice-asset.js";

export interface MethodologyDecisionProgressFact {
  outcome: string | null;
  outcomeVerdict: string | null;
}

export interface MethodologyBuildProgress {
  decisions: {
    total: number;
    pendingOutcome: number;
    pendingReview: number;
    reviewed: number;
  };
  principles: {
    candidate: number;
    accepted: number;
    retired: number;
    dismissed: number;
  };
  practiceAssets: {
    candidate: number;
    accepted: number;
    dismissed: number;
  };
}

export const buildMethodologyBuildProgress = (
  decisions: MethodologyDecisionProgressFact[],
  methodologies: MethodologyRecord[],
  practiceAssets: PracticeAssetRecord[],
): MethodologyBuildProgress => ({
  decisions: {
    total: decisions.length,
    pendingOutcome: decisions.filter((decision) => decision.outcome === null)
      .length,
    pendingReview: decisions.filter(
      (decision) =>
        decision.outcome !== null && decision.outcomeVerdict === null,
    ).length,
    reviewed: decisions.filter((decision) => decision.outcomeVerdict !== null)
      .length,
  },
  principles: {
    candidate: methodologies.filter(
      (methodology) => methodology.status === "candidate",
    ).length,
    accepted: methodologies.filter(
      (methodology) => methodology.status === "accepted",
    ).length,
    retired: methodologies.filter(
      (methodology) => methodology.status === "retired",
    ).length,
    dismissed: methodologies.filter(
      (methodology) => methodology.status === "dismissed",
    ).length,
  },
  practiceAssets: {
    candidate: practiceAssets.filter((asset) => asset.status === "candidate")
      .length,
    accepted: practiceAssets.filter((asset) => asset.status === "accepted")
      .length,
    dismissed: practiceAssets.filter((asset) => asset.status === "dismissed")
      .length,
  },
});
