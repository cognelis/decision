import type { MethodologyRecord } from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SemanticVectorIndex } from "@cognelis/decision-storage";
import { SemanticSearchService } from "../src/main/semantic-search-service.js";

const decision = (id: string, question: string): IndexedDecision => ({
  id,
  created: "2026-08-01T00:00:00.000Z",
  status: "completed",
  sourceClient: "codex",
  project: "decision",
  workflow: null,
  decisionType: "architecture",
  selectedAnswer: "先小步验证",
  captureMode: null,
  captureSemanticKey: null,
  sourceEventId: null,
  batchId: null,
  questionIndex: null,
  rationaleStatus: "captured",
  filePath: `/vault/${id}.md`,
  contentHash: `source-${id}`,
  question,
  rationale: null,
  context: null,
  outcome: null,
  outcomeVerdict: null,
  outcomeLesson: null,
  outcomeReviewedAt: null,
  reviewDueDate: null,
  appliedPrincipleIds: [],
});

const methodology = (id: string, principle: string): MethodologyRecord => ({
  id,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  origin: "manual_entry",
  status: "accepted",
  confirmedAt: "2026-08-02T00:00:00.000Z",
  title: principle,
  principle,
  appliesWhen: "面对高不确定性时",
  caution: "成本过高时重新评估",
  evidenceSummary: "人工原则",
  sourceDecisionIds: [],
  confidence: "medium",
  generation: {
    requestId: "manual",
    profileId: "manual",
    provider: "manual",
    model: "manual",
  },
});

const defaultVector = (text: string): number[] =>
  /午餐/u.test(text)
    ? [0, 1]
    : /回退|验证|风险/u.test(text)
      ? [1, 0]
      : [0, 1];

const makeService = async (
  vectorFor: (text: string) => number[] = defaultVector,
) => {
  const root = await mkdtemp(join(tmpdir(), "semantic-search-"));
  const vectors = new SemanticVectorIndex(join(root, "vectors.sqlite"));
  const gateway = {
    embed: async (texts: string[]) => {
      if (texts.some((text) => text.length > 700)) {
        throw new Error("embedding context exceeded");
      }
      return {
        model: "test-embedding",
        vectors: texts.map(vectorFor),
      };
    },
  };
  return {
    service: new SemanticSearchService({ vectors, gateway }),
    vectors,
  };
};

describe("SemanticSearchService", () => {
  it("adds semantic-only decisions without displacing exact keyword matches", async () => {
    const { service } = await makeService();
    const exact = decision("exact", "如何部署服务？");
    const semantic = decision("semantic", "先准备可回退路径再扩大改动");
    const unrelated = decision("unrelated", "午餐选择什么？");

    const matches = await service.searchDecisions({
      query: "如何降低上线风险？",
      candidates: [exact, semantic, unrelated],
      lexical: [exact],
      limit: 10,
    });

    expect(matches.map((match) => [match.decision.id, match.matchKind])).toEqual([
      ["exact", "hybrid"],
      ["semantic", "semantic"],
    ]);
    await service.close();
  });

  it("recalls a principle through vectors when wording does not overlap", async () => {
    const { service } = await makeService();
    const matches = await service.recallMethodologies(
      [
        methodology("safe", "先建立回退能力，再逐步扩大范围"),
        methodology("food", "优先选择清淡午餐"),
      ],
      {
        question: "怎样控制上线风险？",
        selectedAnswer: "分批实施",
        optionLabels: ["分批实施", "一次完成"],
        context: null,
      },
      3,
    );

    expect(matches[0]).toMatchObject({
      principleId: "safe",
      strength: "strong",
      matchedTerms: [],
    });
    expect(matches[0]?.reason).toMatch(/本地语义向量/u);
    await service.close();
  });

  it("indexes later batches even when a decision contains a very long rationale", async () => {
    const { service, vectors } = await makeService();
    const decisions = Array.from({ length: 17 }, (_, index) => ({
      ...decision(`decision-${index}`, `第 ${index + 1} 个上线方案`),
      rationale:
        index === 16
          ? "先验证回退路径。".repeat(600)
          : "保留回退路径。",
    }));

    await service.synchronize(decisions, []);

    expect(vectors.metadata("decision")).toHaveLength(17);
    await service.close();
  });

  it("accepts calibrated related results while excluding lower-similarity noise", async () => {
    const { service } = await makeService((text) => {
      if (text.includes("改写后的问题")) return [1, 0];
      if (text.includes("目标方案")) {
        return [0.5, Math.sqrt(0.75)];
      }
      return [0.4, Math.sqrt(0.84)];
    });

    const matches = await service.searchDecisions({
      query: "改写后的问题",
      candidates: [
        decision("related", "目标方案"),
        decision("noise", "其它主题"),
      ],
      lexical: [],
      limit: 10,
    });

    expect(matches.map((match) => match.decision.id)).toEqual(["related"]);
    await service.close();
  });

  it("recalls a compact topic when its best matches sit just below the fixed floor", async () => {
    const { service } = await makeService((text) => {
      if (text.includes("Query:命名规范")) return [1, 0];
      if (text.includes("限流配置改成什么名字")) {
        return [0.433, Math.sqrt(1 - 0.433 ** 2)];
      }
      if (text.includes("字段改叫什么名")) {
        return [0.413, Math.sqrt(1 - 0.413 ** 2)];
      }
      if (text.includes("午餐")) {
        return [0.31, Math.sqrt(1 - 0.31 ** 2)];
      }
      return [0, 1];
    });

    const matches = await service.searchDecisions({
      query: "命名规范",
      candidates: [
        decision("config-name", "限流配置改成什么名字？"),
        decision("field-name", "字段改叫什么名？"),
        decision("food", "午餐选择什么？"),
      ],
      lexical: [],
      limit: 10,
    });

    expect(matches.map((match) => match.decision.id)).toEqual([
      "config-name",
      "field-name",
    ]);
    await service.close();
  });

  it("does not manufacture results when even the best semantic match is weak", async () => {
    const { service } = await makeService((text) =>
      text.includes("Query:天气")
        ? [1, 0]
        : [0.39, Math.sqrt(1 - 0.39 ** 2)],
    );

    const matches = await service.searchDecisions({
      query: "天气",
      candidates: [decision("unrelated", "部署方式怎么选？")],
      lexical: [],
      limit: 10,
    });

    expect(matches).toEqual([]);
    await service.close();
  });
});
