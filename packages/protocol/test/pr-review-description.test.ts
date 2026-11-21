import { expect, it } from "vitest";

import { prDescriptionDraft, prDescriptionFactsFrom, prDescriptionVersion, prOverviewRollback, type PrReviewHistoryEntry, type PrReviewStatus } from "../src/index.js";

const status: PrReviewStatus = { sourceCommit: "a".repeat(40), build: "passed", approvals: null, blockers: 0, blocking: "tasks", blockersHold: null, sections: null, problems: [] };
const risk = { level: "medium" as const, table: "review_md" as const, reasons: [{ level: "medium" as const, reason: "导出模块", paths: ["apps/export/job.ts"], more: 2 }], changesRules: false, problems: [] };

it("adds the parts a description lacks under their headings, keeping what the author wrote", () => {
  const facts = { risk, status, files: ["apps/export/job.ts", "apps/export/routes.ts", "docs/export.md"], rollback: "回滚本 PR 即可。",
    review: { round: 2, findings: 3, published: 2, dismissed: [{ title: "文件名带时区", reason: "统一用 UTC" }] } };
  const draft = prDescriptionDraft("导出改为异步任务。\n\n## 风险\n只改导出。", facts);
  expect(draft.added).toEqual(["verification", "rollback"]);
  expect(draft.text).toBe([
    "导出改为异步任务。\n\n## 风险\n只改导出。",
    "## 验证\n\n构建通过。Paraself 预评审第 2 轮发现 3 个问题，2 条已发到 PR，1 条不采纳：文件名带时区（统一用 UTC）。（补上跑了哪些检查：单元测试、lint、手工验证……）",
    "## 撤回\n\n回滚本 PR 即可。",
  ].join("\n\n"));
  // Nothing known: each part says what to write. All three there: nothing to add.
  const empty = prDescriptionDraft("", { risk: null, status: null, files: [], rollback: null, review: null });
  expect(empty.text).toBe("## 验证\n\n（补上跑了哪些检查：单元测试、lint、手工验证……）\n\n## 风险\n\n（写明风险等级、依据和影响到的模块）\n\n## 撤回\n\n（写明怎么撤回，以及哪些撤不掉：数据迁移、已发出的消息、对外接口等）");
  expect(prDescriptionDraft(draft.text.replace("## 风险", "## 风险"), facts)).toEqual({ text: draft.text, added: [] });
  expect(prDescriptionDraft("x", { ...facts, rollback: null }).text).toContain("## 风险\n\n中风险：导出模块（apps/export/job.ts 等 3 个文件）。影响 apps/export、docs。");
});

it("tells a moved description by its version, and reads an overview's rollback note", () => {
  expect(prDescriptionVersion("abc")).toMatch(/^[0-9a-f]{16}$/u);
  expect(prDescriptionVersion("abc")).toBe(prDescriptionVersion("abc"));
  expect(prDescriptionVersion("abc")).not.toBe(prDescriptionVersion("abd"));
  expect(prDescriptionVersion(null)).toBe(prDescriptionVersion(""));
  expect(prOverviewRollback("**类型**：新功能\n\n**撤回**\n回滚即可；已发出的通知撤不回。\n\n**评审关注点**\n- x")).toBe("回滚即可；已发出的通知撤不回。");
  expect(prOverviewRollback("**类型**：新功能\n\n**评审关注点**\n- x")).toBeNull();
});

it("takes the latest review and the latest overview of the PR from the records", () => {
  const entry = (id: string, at: string, kind: "review" | "chat", extra: Partial<PrReviewHistoryEntry> = {}) => ({
    id, kind, at, model: "m", focus: "", draft: "", events: [], connectionId: "c", state: "finished", error: "", published: [], verdicts: [], rechecks: [], turns: [],
    snapshot: { reference: "team/app#1" }, report: kind === "review" ? { findings: [{ title: "甲" }, { title: "乙" }] } : null, ...extra,
  }) as unknown as PrReviewHistoryEntry;
  const entries = [
    entry("r1", "2026-11-10T00:00:00Z", "review"),
    entry("r2", "2026-11-12T00:00:00Z", "review", { published: [{ finding: 0, at: "2026-11-12T01:00:00Z" }], verdicts: [{ finding: 1, verdict: "drop", reason: "有意为之", replacement: null, at: "x", model: "评审者", by: "reviewer" }] }),
    entry("c1", "2026-11-11T00:00:00Z", "chat", { turns: [{ id: "t", at: "2026-11-11T00:00:00Z", model: "m", question: "/describe", answer: "**撤回**\n回滚即可。", state: "done" }] }),
  ];
  expect(prDescriptionFactsFrom(entries, "c", "team/app#1", { risk: null, status: null, files: [] })).toEqual({
    risk: null, status: null, files: [], rollback: "回滚即可。", review: { round: 2, findings: 2, published: 1, dismissed: [{ title: "乙", reason: "有意为之" }] },
  });
});
