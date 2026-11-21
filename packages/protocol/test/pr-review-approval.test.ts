import { expect, it } from "vitest";

import { PR_REQUIRED_APPROVALS, prDescriptionSections, prFindingBlocksByDefault, prFindingCanBlock, prPublishedFindingDraft, prQuickApprovalChecks, type PrReviewStatus } from "../src/index.js";

it("finds the PR template's three parts as headings or bold labels, in Chinese or English", () => {
  expect(prDescriptionSections("## 验证\n跑了单测。\n\n## 风险\n低。\n\n## 撤回\n回退这个提交。")).toEqual({ verification: true, risk: true, rollback: true });
  expect(prDescriptionSections("**Testing**: unit tests\n- **Risk**: low\n### Rollback\nrevert")).toEqual({ verification: true, risk: true, rollback: true });
  // Words inside a sentence, or the start of a longer word, are no parts.
  expect(prDescriptionSections("修了登录。没有风险。Riskless change.")).toEqual({ verification: false, risk: false, rollback: false });
});

it("lets a finding block unless only the reviewer's own decisions or rules stand behind it", () => {
  expect(prFindingCanBlock({ priority: "P2", body: "违反 REVIEW.md 第 2 条。", decisionIndexes: [1] }, ["REVIEW.md"])).toBe(true);
  expect(prFindingCanBlock({ priority: "P2", body: "这里会空指针。", decisionIndexes: [] }, ["REVIEW.md"])).toBe(true);
  expect(prFindingCanBlock({ priority: "P1", body: "和你以前的决定不一致。", decisionIndexes: [1] }, ["REVIEW.md"])).toBe(false);
  expect(PR_REQUIRED_APPROVALS).toEqual({ low: 1, medium: 1, high: 2 });
  // Blocking unless said otherwise: a P1 that may block, nothing else.
  expect(prFindingBlocksByDefault({ priority: "P1", body: "这里会空指针。", decisionIndexes: [] }, [])).toBe(true);
  expect(prFindingBlocksByDefault({ priority: "P2", body: "违反 REVIEW.md 第 2 条。", decisionIndexes: [] }, ["REVIEW.md"])).toBe(false);
  expect(prFindingBlocksByDefault({ priority: "P1", body: "和你以前的决定不一致。", decisionIndexes: [1] }, [])).toBe(false);
  // Posted with the words given, the marker still says what it stands on.
  expect(prPublishedFindingDraft({ priority: "P1", title: "续期没查吊销", body: "违反 REVIEW.md 第 2 条。", decisionIndexes: [] }, ["REVIEW.md"], "请先查吊销。"))
    .toBe("请先查吊销。\n\n— Paraself 预评审 · 依据 REVIEW.md · P1");
});

it("allows a quick approval only for a low-risk PR whose every check holds", () => {
  const status: PrReviewStatus = { sourceCommit: "a".repeat(40), build: "passed", approvals: { count: 0, users: [], logins: [], stale: [] }, blockers: 0, blocking: "tasks", blockersHold: null, sections: null, problems: [] };
  const description = "## 验证\nx\n## 风险\nx\n## 撤回\nx";
  expect(prQuickApprovalChecks({ risk: "low", status, openFindings: 0, description }).eligible).toBe(true);
  expect(prQuickApprovalChecks({ risk: "medium", status, openFindings: 0, description }).eligible).toBe(false);
  const failing = prQuickApprovalChecks({ risk: "low", status: { ...status, build: "running", blockers: null }, openFindings: 1, description: "" });
  expect(failing.eligible).toBe(false);
  expect(failing.checks.filter((check) => !check.ok).map((check) => check.label)).toEqual(["构建通过", "没有未完成的阻塞项", "预评审没有成立的问题", "PR 描述三段齐全"]);
  // No finished review is no "nothing found".
  expect(prQuickApprovalChecks({ risk: "low", status, openFindings: null, description }).eligible).toBe(false);
});

it("lets a P1 on a local rule the reviewer marked blocking block, its comment quoting the rule; nothing else of theirs", async () => {
  const { prBlockingQuoted, prPublishedFindingDraft, prReviewMarkOf } = await import("../src/index.js");
  const rules = [{ id: "list-pagination.md", source: "decision" as const }, { id: "money.md", source: "decision" as const, enforcement: "blocking" as const, text: "金额一律用整数分。\n不用浮点数。" }];
  const onMoney = { priority: "P1", title: "金额用了浮点", body: "违反 Ruleset 2：金额要用整数分。", decisionIndexes: [] };
  expect(prFindingCanBlock(onMoney, [], rules)).toBe(true);
  expect(prFindingBlocksByDefault(onMoney, [], rules)).toBe(true);
  // Not a P1; or on a rule left advisory; or with the rules not known: a suggestion, as before.
  expect(prFindingCanBlock({ ...onMoney, priority: "P2" }, [], rules)).toBe(false);
  expect(prFindingCanBlock({ ...onMoney, body: "违反 Ruleset 1：要分页。" }, [], rules)).toBe(false);
  expect(prFindingCanBlock(onMoney, [])).toBe(false);
  const draft = prPublishedFindingDraft(onMoney, [], undefined, rules);
  expect(draft).toBe("**P1 · 金额用了浮点**\n\n违反 Ruleset 2：金额要用整数分。\n\n> 审阅人的规则「money」（标记为阻塞）：\n> 金额一律用整数分。\n> 不用浮点数。\n\n— Paraself 预评审 · 依据 审阅人的规则（标记为阻塞） · P1");
  expect(prReviewMarkOf(draft)).toEqual({ priority: "P1", basis: "依据 审阅人的规则（标记为阻塞）", suggestion: false });
  // The quote edited out, it may not block; given in the words already, it is not repeated.
  expect(prBlockingQuoted(draft, onMoney, [], rules)).toBe(true);
  expect(prBlockingQuoted("**P1 · 金额用了浮点**\n\n改一下。", onMoney, [], rules)).toBe(false);
  expect(prPublishedFindingDraft(onMoney, [], draft.slice(0, draft.lastIndexOf("\n\n— ")), rules)).toBe(draft);
});
