import type { OutcomeVerdict } from "./record.js";

export interface DecisionAnalyticsTotals {
  decisions: number;
  projects: number;
  rationaleCaptured: number;
  outcomesRecorded: number;
  outcomesReviewed: number;
}

export interface DecisionAnalyticsRates {
  rationaleCaptured: number;
  outcomesRecorded: number;
  outcomesReviewed: number;
}

export interface DecisionAnalyticsVerdict {
  verdict: OutcomeVerdict;
  count: number;
  percentage: number;
}

export interface DecisionAnalyticsGroup {
  key: string;
  label: string;
  decisionCount: number;
  rationaleCaptured: number;
  outcomesRecorded: number;
  outcomesReviewed: number;
  favorableOutcomes: number;
  attentionOutcomes: number;
  latestCreated: string;
}

export interface DecisionAnalyticsTrend {
  period: string;
  decisionCount: number;
  outcomesReviewed: number;
}

/** A review completed inside a retrospective window, with what was learned. */
export interface DecisionRetrospectiveLesson {
  decisionId: string;
  question: string;
  project: string;
  sourceClient: string;
  verdict: OutcomeVerdict;
  lesson: string | null;
  /** What was expected before the outcome, when it was written down. */
  expectedOutcome: string | null;
  reviewedAt: string;
}

/** The same question decided more than once inside one window. */
export interface DecisionRetrospectiveRepeat {
  question: string;
  /** Newest first. */
  decisionIds: string[];
  projects: number;
  consistentAnswers: boolean;
}

export interface DecisionRetrospectiveProject {
  label: string;
  count: number;
}

/** A principle the window's decisions were recorded as applying. */
export interface DecisionRetrospectivePrinciple {
  id: string;
  title: string;
  count: number;
}

/**
 * One rolling window of local calendar days ending today, compared with the
 * window of the same length just before it.
 */
export interface DecisionRetrospectivePeriod {
  days: number;
  /** Local calendar dates, YYYY-MM-DD, both inclusive. */
  startDate: string;
  endDate: string;
  decisions: number;
  previousDecisions: number;
  rationaleCaptured: number;
  /** Still waiting for a rationale, unlike those skipped on purpose. */
  rationaleDeferred: number;
  /** With neither an expectation nor an outcome: one can still be written. */
  expectationMissing: number;
  reviews: number;
  previousReviews: number;
  /** Worst verdicts first; capped, `reviews` holds the full count. */
  lessons: DecisionRetrospectiveLesson[];
  repeats: DecisionRetrospectiveRepeat[];
  projects: DecisionRetrospectiveProject[];
  principles: DecisionRetrospectivePrinciple[];
}

export interface DecisionRetrospective {
  /** Same definition as the dashboard's review count: unreviewed decisions with an outcome or a due review date. */
  reviewAttention: number;
  periods: DecisionRetrospectivePeriod[];
}

export interface DecisionAnalyticsSnapshot {
  generatedAt: string;
  engine: {
    name: "Local aggregation";
    version: "1";
    source: "SQLite snapshot";
  };
  totals: DecisionAnalyticsTotals;
  rates: DecisionAnalyticsRates;
  verdicts: DecisionAnalyticsVerdict[];
  projects: DecisionAnalyticsGroup[];
  sources: DecisionAnalyticsGroup[];
  trend: DecisionAnalyticsTrend[];
  retrospective: DecisionRetrospective;
}
