import type { IndexedDecision } from "@cognelis/decision-storage";
import { describe, expect, it } from "vitest";

import { readDashboardSnapshot } from "../src/main/dashboard-snapshot.js";
import { DecisionAnalyticsService } from "../src/main/decision-analytics-service.js";

const decision = (
  id: string,
  overrides: Partial<IndexedDecision> = {},
): IndexedDecision => ({
  id,
  created: "2026-08-01T08:00:00.000Z",
  status: "completed",
  sourceClient: "codex",
  project: "Decision",
  workflow: null,
  decisionType: "implementation",
  selectedAnswer: "小步上线",
  captureMode: "text",
  captureSemanticKey: null,
  sourceEventId: null,
  batchId: null,
  questionIndex: null,
  rationaleStatus: "captured",
  filePath: `/vault/${id}.md`,
  contentHash: `hash-${id}`,
  question: "应该如何发布？",
  rationale: "更容易验证。",
  context: null,
  outcome: "发布正常。",
  outcomeVerdict: "as_expected",
  outcomeLesson: "保持小步。",
  outcomeReviewedAt: "2026-08-02T08:00:00.000Z",
  reviewDueDate: null,
  appliedPrincipleIds: [],
  ...overrides,
});

describe("DecisionAnalyticsService", () => {
  it("locally aggregates snapshot totals, groups, verdicts, and trends", async () => {
    const service = new DecisionAnalyticsService(
      () => new Date("2026-08-03T00:00:00.000Z"),
    );
    const snapshot = await service.analyze([
      decision("one"),
      decision("two", {
        created: "2026-07-20T08:00:00.000Z",
        project: "Bridge",
        sourceClient: "claude-code",
        rationaleStatus: "skipped",
        rationale: null,
        outcome: "出现部分兼容问题。",
        outcomeVerdict: "mixed",
      }),
      decision("three", {
        created: "2026-07-10T08:00:00.000Z",
        outcome: null,
        outcomeVerdict: null,
        outcomeLesson: null,
        outcomeReviewedAt: null,
      }),
    ]);

    expect(snapshot.engine).toMatchObject({
      name: "Local aggregation",
      version: "1",
      source: "SQLite snapshot",
    });
    expect(snapshot.generatedAt).toBe("2026-08-03T00:00:00.000Z");
    expect(snapshot.totals).toEqual({
      decisions: 3,
      projects: 2,
      rationaleCaptured: 2,
      outcomesRecorded: 2,
      outcomesReviewed: 2,
    });
    expect(snapshot.rates).toEqual({
      rationaleCaptured: 66.7,
      outcomesRecorded: 66.7,
      outcomesReviewed: 100,
    });
    expect(snapshot.verdicts).toEqual(
      expect.arrayContaining([
        { verdict: "as_expected", count: 1, percentage: 50 },
        { verdict: "mixed", count: 1, percentage: 50 },
      ]),
    );
    expect(snapshot.projects[0]).toMatchObject({
      key: "Decision",
      decisionCount: 2,
      favorableOutcomes: 1,
    });
    expect(snapshot.sources.map(({ key }) => key).sort()).toEqual([
      "claude-code",
      "codex",
    ]);
    expect(snapshot.trend).toEqual([
      { period: "2026-07", decisionCount: 2, outcomesReviewed: 1 },
      { period: "2026-08", decisionCount: 1, outcomesReviewed: 1 },
    ]);
  });

  it("returns a complete empty snapshot without creating persistent data", async () => {
    const snapshot = await new DecisionAnalyticsService().analyze([]);

    expect(snapshot.totals.decisions).toBe(0);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.sources).toEqual([]);
    expect(snapshot.trend).toEqual([]);
    expect(snapshot.verdicts.every(({ count }) => count === 0)).toBe(true);
  });

  it("normalizes blank projects and uses deterministic group ordering", async () => {
    const snapshot = await new DecisionAnalyticsService().analyze([
      decision("blank", {
        created: "2026-08-03T00:00:00.000Z",
        project: "   ",
        sourceClient: "zeta",
      }),
      decision("trimmed", {
        created: "2026-08-02T00:00:00.000Z",
        project: "  Alpha  ",
        sourceClient: "alpha",
      }),
      decision("alpha-later", {
        created: "2026-08-04T00:00:00.000Z",
        project: "Alpha",
        sourceClient: "zeta",
      }),
      decision("beta", {
        created: "2026-08-05T00:00:00.000Z",
        project: "Beta",
        sourceClient: "alpha",
      }),
    ]);

    expect(snapshot.totals.projects).toBe(3);
    expect(snapshot.projects.map(({ key }) => key)).toEqual([
      "Alpha",
      "Beta",
      "未命名项目",
    ]);
    expect(snapshot.projects[0]).toMatchObject({
      decisionCount: 2,
      latestCreated: "2026-08-04T00:00:00.000Z",
    });
    expect(snapshot.sources.map(({ key }) => key)).toEqual(["alpha", "zeta"]);
  });

  it("keeps only the newest 12 projects and UTC trend periods", async () => {
    const decisions = Array.from({ length: 13 }, (_, index) => {
      const month = index + 1;
      return decision(`month-${month}`, {
        created: new Date(Date.UTC(2025, month - 1, 1)).toISOString(),
        project: `Project ${String(month).padStart(2, "0")}`,
        outcomeVerdict: index % 2 === 0 ? "better" : null,
      });
    });
    decisions.push(
      decision("invalid-date", {
        created: "not-a-date",
        project: "Invalid Date",
      }),
    );

    const snapshot = await new DecisionAnalyticsService().analyze(decisions);

    expect(snapshot.projects).toHaveLength(12);
    expect(snapshot.projects[0]?.key).toBe("Invalid Date");
    expect(snapshot.projects.some(({ key }) => key === "Project 01")).toBe(
      false,
    );
    expect(snapshot.trend).toHaveLength(12);
    expect(snapshot.trend[0]?.period).toBe("2025-02");
    expect(snapshot.trend.at(-1)?.period).toBe("2026-01");
    expect(snapshot.trend.every(({ period }) => period !== "not-a-date")).toBe(
      true,
    );
  });

  it("builds local-calendar retrospectives with worst lessons and repeated questions first", async () => {
    // Local-time constructors keep the day boundaries right in any test time zone.
    const at = (day: number, hour = 12, minute = 0, second = 0): string =>
      new Date(2026, 8, day, hour, minute, second).toISOString();
    const reviewed = (day: number) => ({ outcomeReviewedAt: at(day) });
    const snapshot = await new DecisionAnalyticsService(
      () => new Date(2026, 8, 26, 10, 0, 0),
    ).analyze(
      [
      decision("first-of-window", {
        created: at(20, 0, 0, 0),
        question: "发布窗口放在周几？",
        selectedAnswer: "周二",
        rationaleStatus: "deferred",
        ...reviewed(25),
        outcomeVerdict: "better",
      }),
      decision("repeat-other-project", {
        created: at(24),
        project: " Bridge ",
        question: "发布窗口 放在周几?",
        selectedAnswer: "周四",
        outcome: null,
        outcomeVerdict: null,
        outcomeLesson: null,
        outcomeReviewedAt: null,
        reviewDueDate: "2026-09-26",
      }),
      decision("worst", {
        created: at(21),
        appliedPrincipleIds: ["p-verify", "p-missing"],
        question: "缓存要不要预热？",
        outcomeVerdict: "worse",
        outcomeLesson: "  冷启动比预期更慢。  ",
        expectedOutcome: "  预热后首屏两秒内可用。 ",
        ...reviewed(22),
      }),
      decision("unclear-blank-lesson", {
        created: at(23),
        appliedPrincipleIds: ["p-verify"],
        question: "日志要不要落盘？",
        outcomeVerdict: "unclear",
        outcomeLesson: "   ",
        ...reviewed(24),
      }),
      decision("previous-window", {
        created: at(19, 23, 59, 59),
        question: "上周的问题",
        outcome: "已上线。",
        outcomeVerdict: null,
        outcomeLesson: null,
        outcomeReviewedAt: null,
      }),
      decision("reviewed-last-week", {
        created: "2026-08-01T00:00:00.000Z",
        ...reviewed(15),
      }),
      decision("scheduled-later", {
        created: at(10),
        outcome: null,
        outcomeVerdict: null,
        outcomeLesson: null,
        outcomeReviewedAt: null,
        reviewDueDate: "2026-09-27",
      }),
      ],
      new Map([["p-verify", "先验证再扩大"]]),
    );

    const [week, month] = snapshot.retrospective.periods;
    // Only principles that still exist can be named; the missing id is dropped.
    expect(week?.principles).toEqual([
      { id: "p-verify", title: "先验证再扩大", count: 2 },
    ]);
    // Unreviewed with an outcome, or due today: the dashboard's review count.
    expect(snapshot.retrospective.reviewAttention).toBe(2);
    expect(week).toMatchObject({
      days: 7,
      startDate: "2026-09-20",
      endDate: "2026-09-26",
      decisions: 4,
      previousDecisions: 1,
      rationaleCaptured: 3,
      rationaleDeferred: 1,
      // Only the one with neither an outcome nor an expectation.
      expectationMissing: 1,
      reviews: 3,
      previousReviews: 1,
    });
    expect(week?.lessons.map(({ decisionId }) => decisionId)).toEqual([
      "worst",
      "unclear-blank-lesson",
      "first-of-window",
    ]);
    expect(week?.lessons[0]).toMatchObject({
      verdict: "worse",
      lesson: "冷启动比预期更慢。",
      expectedOutcome: "预热后首屏两秒内可用。",
    });
    expect(week?.lessons[1]?.expectedOutcome).toBeNull();
    expect(week?.lessons[1]?.lesson).toBeNull();
    expect(week?.repeats).toEqual([
      {
        question: "发布窗口 放在周几?",
        decisionIds: ["repeat-other-project", "first-of-window"],
        projects: 2,
        consistentAnswers: false,
      },
    ]);
    expect(week?.projects).toEqual([
      { label: "Decision", count: 3 },
      { label: "Bridge", count: 1 },
    ]);
    expect(month).toMatchObject({
      days: 30,
      startDate: "2026-08-28",
      decisions: 6,
      reviews: 4,
    });
  });

  it("keeps every project, principle and repeated question so the headings count them all", async () => {
    const six = Array.from({ length: 6 }, (_, index) => index + 1);
    const snapshot = await new DecisionAnalyticsService(
      () => new Date(2026, 8, 26, 10, 0, 0),
    ).analyze(
      six.flatMap((n) =>
        ["a", "b"].map((copy) =>
          decision(`${copy}${n}`, {
            created: new Date(2026, 8, 25, 9, n).toISOString(),
            project: `项目 ${n}`,
            question: `问题 ${n}？`,
            appliedPrincipleIds: [`p${n}`],
          }),
        ),
      ),
      new Map(six.map((n) => [`p${n}`, `原则 ${n}`])),
    );
    const [week] = snapshot.retrospective.periods;
    expect(week?.projects).toHaveLength(6);
    expect(week?.principles).toHaveLength(6);
    expect(week?.repeats).toHaveLength(6);
  });

  it("starts the windows at midnight where summer time starts at midnight", async () => {
    const zone = process.env.TZ;
    // Cairo skips from 00:00 to 01:00 on the last Friday of April.
    process.env.TZ = "Africa/Cairo";
    try {
      const now = new Date(2026, 3, 24, 10, 0);
      const firstDay = new Date(2026, 3, 18, 0, 30);
      const snapshot = await new DecisionAnalyticsService(() => now).analyze([
        decision("half-past-midnight", { created: firstDay.toISOString() }),
      ]);
      expect(snapshot.retrospective.periods[0]).toMatchObject({
        startDate: "2026-04-18",
        decisions: 1,
        previousDecisions: 0,
      });

      let since = "";
      readDashboardSnapshot(
        {
          count: () => 1,
          countSince: (value) => {
            since = value;
            return 1;
          },
          countReviewAttention: () => 0,
          listRecent: () => [],
          revision: () => 0,
        },
        now,
      );
      expect(since).toBe("2026-04-17T22:00:00.000Z");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("does not mutate the input snapshot", async () => {
    const input = [
      decision("frozen", {
        project: "  Frozen  ",
        appliedPrincipleIds: Object.freeze(["PRN-001"]) as string[],
      }),
    ];
    Object.freeze(input[0]);
    Object.freeze(input);

    await expect(
      new DecisionAnalyticsService().analyze(input),
    ).resolves.toEqual(expect.any(Object));
    expect(input[0]?.project).toBe("  Frozen  ");
  });
});
