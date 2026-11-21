import { expect, it } from "vitest";

import { prFindingBasis, prFindingMarker } from "../src/index.js";

it("reads a finding's basis from the guide it names and the decisions it cites, and says it in one plain line", () => {
  const guides = ["REVIEW.md", "docs/AGENT_REVIEW.md"];
  const repository = { priority: "P1", body: "违反 AGENT_REVIEW.md 第 3 条：续期前要检查吊销。", decisionIndexes: [2] };
  expect(prFindingBasis(repository, guides)).toEqual({ tier: "repository", guides: ["docs/AGENT_REVIEW.md"] });
  expect(prFindingMarker(repository, guides)).toBe("— Paraself 预评审 · 依据 docs/AGENT_REVIEW.md · P1");
  // A guide the target branch does not keep is no repository rule, whatever the body says.
  const decided = { priority: "P2", body: "按 CLAUDE.md 的说法应当返回 401。", decisionIndexes: [1] };
  expect(prFindingBasis(decided, guides)).toEqual({ tier: "personal", decisions: true, localRules: false, blocking: [] });
  expect(prFindingMarker(decided, guides)).toBe("— Paraself 预评审 · 审阅人的个人经验，仓库暂无此规则 · P2 · 建议");
  expect(prFindingBasis({ body: "见 Ruleset 2。", decisionIndexes: [] }, undefined)).toEqual({ tier: "personal", decisions: false, localRules: true, blocking: [] });
  const plain = { priority: "P3", body: "这里会空指针。", decisionIndexes: [] };
  expect(prFindingBasis(plain, guides)).toEqual({ tier: "none" });
  expect(prFindingMarker(plain, guides)).toBe("— Paraself 预评审 · P3");
});
