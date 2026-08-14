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
}
