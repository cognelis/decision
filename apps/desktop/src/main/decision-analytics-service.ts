import {
  type DecisionAnalyticsGroup,
  type DecisionAnalyticsSnapshot,
  type DecisionAnalyticsTotals,
  type DecisionAnalyticsTrend,
  type DecisionRetrospective,
  type DecisionRetrospectiveLesson,
  type DecisionRetrospectivePeriod,
  type DecisionRetrospectiveRepeat,
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

const RETROSPECTIVE_WINDOWS = [7, 30];
const RETROSPECTIVE_LESSON_LIMIT = 8;

/** A retrospective is read for what went wrong before what went right. */
const VERDICT_SEVERITY: Record<OutcomeVerdict, number> = {
  worse: 0,
  mixed: 1,
  unclear: 2,
  as_expected: 3,
  better: 4,
};

const localCalendarDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * The first instant of the calendar day `days` days before `date`. Built from
 * the target day itself: where summer time starts at midnight, today's day
 * begins at 01:00, and carrying that hour back would cut an earlier day short.
 */
const localDayStart = (date: Date, days: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() - days);

const timestamp = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/** Width, case, spacing and closing punctuation do not make a different question. */
const textKey = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[?!.。]+$/u, "");

const repeatedQuestions = (
  decisions: Array<{ decision: IndexedDecision; created: number }>,
): DecisionRetrospectiveRepeat[] => {
  const groups = new Map<string, Array<{ decision: IndexedDecision; created: number }>>();
  for (const entry of decisions) {
    const key = textKey(entry.decision.question);
    if (key.length === 0) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [entry]);
    else group.push(entry);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort((left, right) => right.created - left.created))
    .sort(
      (left, right) =>
        right.length - left.length ||
        (right[0]?.created ?? 0) - (left[0]?.created ?? 0),
    )
    .map((group) => ({
      question: group[0]?.decision.question ?? "",
      decisionIds: group.map(({ decision }) => decision.id),
      projects: new Set(
        group.map(({ decision }) => normalizeProject(decision.project)),
      ).size,
      consistentAnswers:
        new Set(group.map(({ decision }) => textKey(decision.selectedAnswer)))
          .size === 1,
    }));
};

const retrospectivePeriod = (
  decisions: IndexedDecision[],
  now: Date,
  days: number,
  principleTitles: ReadonlyMap<string, string>,
): DecisionRetrospectivePeriod => {
  const startDate = localDayStart(now, days - 1);
  const start = startDate.getTime();
  const previousStart = localDayStart(now, days * 2 - 1).getTime();
  const current: Array<{ decision: IndexedDecision; created: number }> = [];
  const lessons: Array<{ lesson: DecisionRetrospectiveLesson; reviewed: number }> = [];
  let previousDecisions = 0;
  let previousReviews = 0;

  for (const decision of decisions) {
    const created = timestamp(decision.created);
    if (created !== null && created >= start) current.push({ decision, created });
    else if (created !== null && created >= previousStart) previousDecisions += 1;

    const reviewedAt = decision.outcomeReviewedAt;
    const reviewed = reviewedAt === null ? null : timestamp(reviewedAt);
    if (
      reviewedAt === null ||
      reviewed === null ||
      !isOutcomeVerdict(decision.outcomeVerdict)
    ) {
      continue;
    }
    if (reviewed >= start) {
      lessons.push({
        reviewed,
        lesson: {
          decisionId: decision.id,
          question: decision.question,
          project: normalizeProject(decision.project),
          sourceClient: decision.sourceClient,
          verdict: decision.outcomeVerdict,
          lesson: decision.outcomeLesson?.trim() || null,
          expectedOutcome: decision.expectedOutcome?.trim() || null,
          reviewedAt,
        },
      });
    } else if (reviewed >= previousStart) {
      previousReviews += 1;
    }
  }

  const projectCounts = new Map<string, number>();
  const principleCounts = new Map<string, number>();
  for (const { decision } of current) {
    const project = normalizeProject(decision.project);
    projectCounts.set(project, (projectCounts.get(project) ?? 0) + 1);
    for (const id of new Set(decision.appliedPrincipleIds)) {
      principleCounts.set(id, (principleCounts.get(id) ?? 0) + 1);
    }
  }

  return {
    days,
    startDate: localCalendarDate(startDate),
    endDate: localCalendarDate(now),
    decisions: current.length,
    previousDecisions,
    rationaleCaptured: current.filter(
      ({ decision }) => decision.rationaleStatus === "captured",
    ).length,
    rationaleDeferred: current.filter(
      ({ decision }) => decision.rationaleStatus === "deferred",
    ).length,
    expectationMissing: current.filter(
      ({ decision }) => !decision.expectedOutcome && decision.outcome === null,
    ).length,
    reviews: lessons.length,
    previousReviews,
    lessons: lessons
      .sort(
        (left, right) =>
          VERDICT_SEVERITY[left.lesson.verdict] -
            VERDICT_SEVERITY[right.lesson.verdict] ||
          right.reviewed - left.reviewed,
      )
      .slice(0, RETROSPECTIVE_LESSON_LIMIT)
      .map(({ lesson }) => lesson),
    repeats: repeatedQuestions(current),
    projects: [...projectCounts]
      .map(([label, count]) => ({ label, count }))
      .sort(
        (left, right) =>
          right.count - left.count || compareText(left.label, right.label),
      ),
    // Only principles that still exist can be named or opened.
    principles: [...principleCounts]
      .flatMap(([id, count]) => {
        const title = principleTitles.get(id);
        return title === undefined ? [] : [{ id, title, count }];
      })
      .sort(
        (left, right) =>
          right.count - left.count || compareText(left.title, right.title),
      ),
  };
};

const buildRetrospective = (
  decisions: IndexedDecision[],
  now: Date,
  principleTitles: ReadonlyMap<string, string>,
): DecisionRetrospective => {
  const today = localCalendarDate(now);
  return {
    reviewAttention: decisions.filter(
      (decision) =>
        decision.outcomeVerdict === null &&
        (decision.outcome !== null ||
          (decision.reviewDueDate !== null && decision.reviewDueDate <= today)),
    ).length,
    periods: RETROSPECTIVE_WINDOWS.map((days) =>
      retrospectivePeriod(decisions, now, days, principleTitles),
    ),
  };
};

export class DecisionAnalyticsService {
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  async analyze(
    decisions: IndexedDecision[],
    principleTitles: ReadonlyMap<string, string> = new Map(),
  ): Promise<DecisionAnalyticsSnapshot> {
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
    const now = this.#now();

    return {
      generatedAt: now.toISOString(),
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
      retrospective: buildRetrospective(decisions, now, principleTitles),
    };
  }
}
