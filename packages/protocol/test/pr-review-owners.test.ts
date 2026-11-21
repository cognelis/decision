import { expect, it } from "vitest";

import { isCodeOwnerPerson, prCodeOwners, prFindingDuplicate, prReviewSummaryOn } from "../src/index.js";

it("reads CODEOWNERS as gitignore does, the last matching rule deciding each file", () => {
  const text = [
    "# 负责人", "* @lead", "*.md @docs-team", "/apps/auth/ @alice @@auth-group", "apps/billing @bob", "docs/* @carol", "/apps/auth/legacy/", "[Section]", "@@@Check(min=2)",
  ].join("\n");
  expect(prCodeOwners(text, ["apps/auth/session.ts"])).toEqual(["alice", "@auth-group"]);
  // At any depth when unrooted; a directory name covers what is under it.
  expect(prCodeOwners(text, ["packages/x/README.md"])).toEqual(["docs-team"]);
  expect(prCodeOwners(text, ["apps/billing/charge.ts"])).toEqual(["bob"]);
  // docs/* is one level only; deeper falls back to the earlier rule.
  expect(prCodeOwners(text, ["docs/a.txt", "docs/deep/b.txt"])).toEqual(["carol", "lead"]);
  // A rule with no owners leaves its files unowned.
  expect(prCodeOwners(text, ["apps/auth/legacy/old.ts"])).toEqual([]);
  expect([isCodeOwnerPerson("alice"), isCodeOwnerPerson("@auth-group"), isCodeOwnerPerson("org/team"), isCodeOwnerPerson("zhang.san@corp")]).toEqual([true, false, false, true]);
});

it("finds a comment already on the PR saying the same finding, and the PR's review summary", () => {
  const finding = { path: "apps/auth/session.ts", side: "new" as const, line: 88, priority: "P1", title: "续期没查吊销" };
  const comment = (body: string, line: number | null, side: "old" | "new" | null = "new", path: string | null = "apps/auth/session.ts") => ({ path, line, side, body, author: "示例审阅人 B" });
  // Another Paraself's comment of the same priority nearby, or any comment naming the title.
  expect(prFindingDuplicate(finding, [comment("**P1 · 别的说法**\n\n……\n\n— Paraself 预评审 · 依据 REVIEW.md · P1", 90)])).toBeDefined();
  expect(prFindingDuplicate(finding, [comment("这里续期没查吊销吧？", 86, null)])).toBeDefined();
  // Too far, another side, another priority, another file: not the same.
  expect(prFindingDuplicate(finding, [comment("**P1 · x**\n\n— Paraself 预评审 · P1", 92), comment("**P1 · x**\n\n— Paraself 预评审 · P1", 88, "old"),
    comment("**P2 · x**\n\n— Paraself 预评审 · 审阅人的个人经验，仓库暂无此规则 · P2 · 建议", 88), comment("续期没查吊销", 88, "new", "apps/auth/other.ts")])).toBeUndefined();
  const summary = { path: null, replyTo: null, body: "**AI 评审**：2 个问题（提交 `abc`）" };
  expect(prReviewSummaryOn([{ path: null, replyTo: "1", body: "**AI 评审**：回复" }, summary])).toBe(summary);
});
