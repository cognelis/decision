import type { IndexedDecision } from "@cognelis/decision-storage";
import { describe, expect, it } from "vitest";

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
