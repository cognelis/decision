import type {
  MethodologyRecord,
  MethodologyRelationRecord,
} from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";
import { describe, expect, it } from "vitest";

import { buildKnowledgeGraph } from "../src/main/knowledge-graph-service.js";

const methodology = (
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id: "principle-1",
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T09:00:00.000Z",
  title: "先验证再扩大",
  principle: "先通过可回退的小步改动验证效果，再扩大实施范围。",
  appliesWhen: "关键结果仍需上线验证时。",
  caution: "双轨成本过高时需要重新评估。",
  evidenceSummary: "两条结果一致的决策支持该原则。",
  sourceDecisionIds: ["decision-1", "decision-2"],
  confidence: "medium",
  generation: {
    requestId: "request-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5",
  },
  ...overrides,
});

const decision = (
  id: string,
  project: string,
  overrides: Partial<IndexedDecision> = {},
): IndexedDecision => ({
  id,
  created: "2026-08-01T08:00:00.000Z",
  status: "completed",
  sourceClient: "codex",
  project,
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
  question: `${project} 应该如何发布？`,
  rationale: "更容易验证。",
  context: null,
  outcome: "上线稳定，没有出现大范围回归。",
  outcomeVerdict: "as_expected",
  outcomeLesson: "保持可回退。",
  outcomeReviewedAt: "2026-08-02T08:00:00.000Z",
  reviewDueDate: null,
  appliedPrincipleIds: [],
  ...overrides,
});

const relation = (
  overrides: Partial<MethodologyRelationRecord> = {},
): MethodologyRelationRecord => ({
  id: "principle-relation-1",
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T09:00:00.000Z",
  principleIds: ["principle-1", "principle-2"],
  principleTitles: ["先验证再扩大", "先小步验证"],
  disposition: "duplicate",
  note: "两条原则表达的是同一条规则。",
  ...overrides,
});

describe("buildKnowledgeGraph", () => {
  it("links accepted principles to projects, decisions, and reviewed outcomes", () => {
    const graph = buildKnowledgeGraph(
      [
        methodology(),
        methodology({
          id: "candidate",
          status: "candidate",
          confirmedAt: null,
        }),
      ],
      [decision("decision-1", "Desktop"), decision("decision-2", "Desktop")],
    );

    expect(graph.principles).toHaveLength(1);
    expect(graph.projects).toEqual([
      expect.objectContaining({
        name: "Desktop",
        decisionIds: ["decision-1", "decision-2"],
        principleIds: ["principle-1"],
      }),
    ]);
    expect(graph.decisions).toHaveLength(2);
    expect(graph.outcomes).toHaveLength(2);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationship: "project-decision" }),
        expect.objectContaining({ relationship: "decision-outcome" }),
        expect.objectContaining({ relationship: "decision-principle" }),
      ]),
    );
  });

  it("reports missing source decisions without fabricating nodes", () => {
    const graph = buildKnowledgeGraph(
      [methodology({ sourceDecisionIds: ["decision-1", "missing"] })],
      [decision("decision-1", "Desktop")],
    );

    expect(graph.missingSourceDecisionIds).toEqual(["missing"]);
    expect(graph.decisions.map((item) => item.id)).toEqual(["decision-1"]);
  });

  it("projects confirmed duplicate and conflict facts only between accepted principles", () => {
    const graph = buildKnowledgeGraph(
      [
        methodology(),
        methodology({
          id: "principle-2",
          title: "先小步验证",
          sourceDecisionIds: ["decision-2"],
        }),
        methodology({
          id: "principle-3",
          title: "一次完成迁移",
          sourceDecisionIds: ["decision-3"],
        }),
        methodology({
          id: "candidate",
          status: "candidate",
          confirmedAt: null,
        }),
      ],
      [
        decision("decision-1", "Desktop"),
        decision("decision-2", "Bridge"),
        decision("decision-3", "Desktop"),
      ],
      [
        relation(),
        relation({
          id: "principle-relation-conflict",
          principleIds: ["principle-1", "principle-3"],
          disposition: "conflict",
          note: "适用范围重叠，但行动方向相反。",
          updatedAt: "2026-08-03T10:00:00.000Z",
        }),
        relation({
          id: "principle-relation-unrelated",
          disposition: "unrelated",
        }),
        relation({
          id: "principle-relation-candidate",
          principleIds: ["principle-1", "candidate"],
          disposition: "duplicate",
        }),
      ],
    );

    expect(graph.principleRelations).toEqual([
      expect.objectContaining({
        id: "principle-relation-conflict",
        disposition: "conflict",
      }),
      expect.objectContaining({
        id: "principle-relation-1",
        disposition: "duplicate",
      }),
    ]);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationship: "principle-conflict" }),
        expect.objectContaining({ relationship: "principle-duplicate" }),
      ]),
    );
  });
});
