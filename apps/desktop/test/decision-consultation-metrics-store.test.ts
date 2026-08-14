import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DecisionConsultationMetricsStore } from "../src/main/decision-consultation-metrics-store.js";
import type { DecisionConsultationResponse } from "@cognelis/decision-protocol";

const response = (
  status: "matched" | "no_match",
  strengths: Array<"strong" | "possible"> = [],
): DecisionConsultationResponse => ({
  consultationVersion: 1,
  requestId: "request-with-private-question",
  status,
  generatedBy: "deterministic_local_match",
  feedback: null,
  matches: strengths.map((relevance, index) => ({
    principleId: `private-principle-${index}`,
    title: `原则 ${index}`,
    principle: "不应写入指标文件的原则正文",
    appliesWhen: "仅在测试时适用",
    caution: "不要持久化",
    confidence: "medium",
    evidenceCount: 2,
    relevanceScore: relevance === "strong" ? 32 : 14,
    relevance,
    reason: "测试匹配原因",
    matchedTerms: ["测试"],
  })),
  boundary: {
    advisoryOnly: true,
    noDecisionWritten: true,
    noPrincipleApplied: true,
  },
});

describe("DecisionConsultationMetricsStore", () => {
  it("persists only bounded aggregate counters", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-consultation-metrics-"));
    const path = join(root, "metrics.json");
    const store = new DecisionConsultationMetricsStore(path);

    await store.record({
      sourceClient: "codex",
      response: response("matched", ["strong", "possible"]),
      durationMs: 12,
      recordedAt: "2026-08-08T10:00:00.000Z",
    });
    await store.record({
      sourceClient: "claude-code",
      response: response("no_match"),
      durationMs: 8,
      recordedAt: "2026-08-09T11:00:00.000Z",
    });
    await store.recordFeedback({
      source: "preview",
      result: "possible",
      rating: "misleading",
      recordedAt: "2026-08-09T11:05:00.000Z",
    });
    await store.recordFeedback({
      source: "codex",
      result: "strong",
      rating: "helpful",
      recordedAt: "2026-08-09T11:06:00.000Z",
    });

    await expect(store.snapshot()).resolves.toMatchObject({
      requests: 2,
      matched: 1,
      noMatch: 1,
      matches: 2,
      strongMatches: 1,
      possibleMatches: 1,
      durationMs: 20,
      byClient: { claudeCode: 1, codex: 1 },
      feedback: {
        total: 2,
        helpful: 1,
        notHelpful: 0,
        misleading: 1,
        bySource: { claudeCode: 0, codex: 1, preview: 1 },
        byResult: {
          strong: { total: 1, helpful: 1 },
          possible: { total: 1, misleading: 1 },
          noMatch: { total: 0 },
        },
      },
      recent: [
        { date: "2026-08-08", requests: 1, feedback: { total: 0 } },
        { date: "2026-08-09", requests: 1, feedback: { total: 2 } },
      ],
      privacy: {
        storesFeedbackTokens: false,
        storesIndividualEvents: false,
      },
    });
    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain("private-question");
    expect(stored).not.toContain("private-principle");
    expect(stored).not.toContain("原则正文");
    expect(stored).not.toContain("opaque-token");
  });

  it("upgrades existing aggregate files without losing counters", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-consultation-metrics-"));
    const path = join(root, "metrics.json");
    await writeFile(
      path,
      JSON.stringify({
        metricsVersion: 1,
        requests: 1,
        matched: 0,
        noMatch: 1,
        matches: 0,
        strongMatches: 0,
        possibleMatches: 0,
        durationMs: 4,
        byClient: { claudeCode: 0, codex: 1 },
        recent: [
          {
            date: "2026-08-08",
            requests: 1,
            matched: 0,
            noMatch: 1,
            matches: 0,
            strongMatches: 0,
            possibleMatches: 0,
            durationMs: 4,
          },
        ],
        lastConsultedAt: "2026-08-08T10:00:00.000Z",
        privacy: {
          storesQuestionText: false,
          storesOptionText: false,
          storesPrincipleIds: false,
        },
      }),
      "utf8",
    );
    const store = new DecisionConsultationMetricsStore(path);

    await expect(store.snapshot()).resolves.toMatchObject({
      requests: 1,
      feedback: { total: 0 },
      recent: [{ requests: 1, feedback: { total: 0 } }],
      privacy: {
        storesFeedbackTokens: false,
        storesIndividualEvents: false,
      },
    });
  });

  it("fails closed on a corrupt metrics file", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-consultation-metrics-"));
    const path = join(root, "metrics.json");
    await writeFile(path, "{broken", "utf8");
    const store = new DecisionConsultationMetricsStore(path);

    await expect(store.snapshot()).rejects.toThrow("聚合指标损坏");
    await expect(
      store.record({
        sourceClient: "codex",
        response: response("no_match"),
        durationMs: 1,
        recordedAt: "2026-08-08T10:00:00.000Z",
      }),
    ).rejects.toThrow("聚合指标损坏");
  });
});
