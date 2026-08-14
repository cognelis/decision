import {
  type DecisionAnalyticsGroup,
  type DecisionAnalyticsSnapshot,
  type DecisionAnalyticsTotals,
  type DecisionAnalyticsTrend,
  type OutcomeVerdict,
} from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";

const VERDICTS: OutcomeVerdict[] = [
  "better",
  "as_expected",
  "mixed",
  "worse",
  "unclear",
];

const FAVORABLE_VERDICTS: ReadonlySet<string> = new Set([
  "better",
  "as_expected",
]);
const ATTENTION_VERDICTS: ReadonlySet<string> = new Set(["mixed", "worse"]);

const isOutcomeVerdict = (value: string | null): value is OutcomeVerdict =>
  value !== null && VERDICTS.some((verdict) => verdict === value);

const percentage = (value: number, total: number): number =>
  total === 0 ? 0 : Math.round((value / total) * 1_000) / 10;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const normalizeProject = (project: string): string => {
  const normalized = project.trim();
  return normalized.length === 0 ? "未命名项目" : normalized;
};

const trendPeriod = (created: string): string | null => {
  const parsed = new Date(created);
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toISOString().slice(0, 7);
};

const createGroup = (key: string): DecisionAnalyticsGroup => ({
  key,
  label: key,
  decisionCount: 0,
  rationaleCaptured: 0,
  outcomesRecorded: 0,
  outcomesReviewed: 0,
  favorableOutcomes: 0,
  attentionOutcomes: 0,
  latestCreated: "",
});

const addToGroup = (
  groups: Map<string, DecisionAnalyticsGroup>,
  key: string,
  decision: IndexedDecision,
): void => {
  const group = groups.get(key) ?? createGroup(key);
  group.decisionCount += 1;
  group.rationaleCaptured += Number(decision.rationaleStatus === "captured");
  group.outcomesRecorded += Number(decision.outcome !== null);
  group.outcomesReviewed += Number(decision.outcomeVerdict !== null);
  group.favorableOutcomes += Number(
    decision.outcomeVerdict !== null &&
      FAVORABLE_VERDICTS.has(decision.outcomeVerdict),
  );
  group.attentionOutcomes += Number(
    decision.outcomeVerdict !== null &&
      ATTENTION_VERDICTS.has(decision.outcomeVerdict),
  );
  if (compareText(decision.created, group.latestCreated) > 0) {
    group.latestCreated = decision.created;
  }
  groups.set(key, group);
};

const sortProjects = (
  groups: Map<string, DecisionAnalyticsGroup>,
): DecisionAnalyticsGroup[] =>
  [...groups.values()]
    .sort(
      (left, right) =>
        right.decisionCount - left.decisionCount ||
        compareText(right.latestCreated, left.latestCreated) ||
        compareText(left.label, right.label),
    )
    .slice(0, 12);

const sortSources = (
  groups: Map<string, DecisionAnalyticsGroup>,
): DecisionAnalyticsGroup[] =>
  [...groups.values()].sort(
    (left, right) =>
      right.decisionCount - left.decisionCount ||
      compareText(left.label, right.label),
  );

export class DecisionAnalyticsService {
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async analyze(decisions: IndexedDecision[]): Promise<DecisionAnalyticsSnapshot> {
    const totals: DecisionAnalyticsTotals = {
      decisions: decisions.length,
      projects: 0,
      rationaleCaptured: 0,
      outcomesRecorded: 0,
      outcomesReviewed: 0,
    };
    const verdictCounts = new Map<OutcomeVerdict, number>();
    const projectGroups = new Map<string, DecisionAnalyticsGroup>();
    const sourceGroups = new Map<string, DecisionAnalyticsGroup>();
    const trends = new Map<string, DecisionAnalyticsTrend>();

    for (const decision of decisions) {
      const project = normalizeProject(decision.project);
      totals.rationaleCaptured += Number(
        decision.rationaleStatus === "captured",
      );
      totals.outcomesRecorded += Number(decision.outcome !== null);
      totals.outcomesReviewed += Number(decision.outcomeVerdict !== null);

      if (isOutcomeVerdict(decision.outcomeVerdict)) {
        verdictCounts.set(
          decision.outcomeVerdict,
          (verdictCounts.get(decision.outcomeVerdict) ?? 0) + 1,
        );
      }

      addToGroup(projectGroups, project, decision);
      addToGroup(sourceGroups, decision.sourceClient, decision);

      const period = trendPeriod(decision.created);
      if (period !== null) {
        const trend = trends.get(period) ?? {
          period,
          decisionCount: 0,
          outcomesReviewed: 0,
        };
        trend.decisionCount += 1;
        trend.outcomesReviewed += Number(decision.outcomeVerdict !== null);
        trends.set(period, trend);
      }
    }

    totals.projects = projectGroups.size;

    return {
      generatedAt: this.#now().toISOString(),
      engine: {
        name: "Local aggregation",
        version: "1",
        source: "SQLite snapshot",
      },
      totals,
      rates: {
        rationaleCaptured: percentage(
          totals.rationaleCaptured,
          totals.decisions,
        ),
        outcomesRecorded: percentage(totals.outcomesRecorded, totals.decisions),
        outcomesReviewed: percentage(
          totals.outcomesReviewed,
          totals.outcomesRecorded,
        ),
      },
      verdicts: VERDICTS.map((verdict) => {
        const count = verdictCounts.get(verdict) ?? 0;
        return {
          verdict,
          count,
          percentage: percentage(count, totals.outcomesReviewed),
        };
      }),
      projects: sortProjects(projectGroups),
      sources: sortSources(sourceGroups),
      trend: [...trends.values()]
        .sort((left, right) => compareText(right.period, left.period))
        .slice(0, 12)
        .reverse(),
    };
  }
}
