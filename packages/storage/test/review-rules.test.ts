import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { combineReviewRules, loadReviewRules, matchReviewRules } from "../src/index.js";

const roots: string[] = [];
const rulesDirectory = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "decision-review-rules-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};
const rule = (frontmatter: string, body: string) => `---\n${frontmatter}\n---\n\n${body}\n`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("review rules in the code-meeseeks format", () => {
  it("applies enabled review rules scoped to the PR, highest priority first", async () => {
    const directory = await rulesDirectory({
      "general.md": rule("priority: 1", "检查错误处理。"),
      "team/fx.md": rule('applies_to:\n  project: "^FX$"\n  repo: "^fx-"\npriority: 50', "金额必须用整数分。"),
      "team/release.md": rule('applies_to:\n  target_branch: "^(main|master)$"\ntools: [review]', "发布分支禁止调试日志。"),
      "describe-only.md": rule("tools: [describe]", "只用于生成描述。"),
      "off.md": rule("enabled: false", "停用的规则。"),
      "empty.md": rule("priority: 99", ""),
      ".hidden/secret.md": rule("", "隐藏目录不读。"),
      "notes.txt": "不是规则。",
    });

    const { rules, warnings } = await loadReviewRules(directory);
    expect(warnings).toEqual([]);
    expect(rules.map((item) => item.id).sort()).toEqual(["general.md", "team/fx.md", "team/release.md"]);

    const matched = matchReviewRules(rules, { project: "FX", repo: "fx-payments", targetBranch: "main" });
    expect(matched.map((item) => item.id)).toEqual(["team/fx.md", "general.md", "team/release.md"]);
    expect(combineReviewRules(matched)).toBe(
      "## Ruleset 1\n\n金额必须用整数分。\n\n## Ruleset 2\n\n检查错误处理。\n\n## Ruleset 3\n\n发布分支禁止调试日志。",
    );
    // Case-sensitive like code-meeseeks, and an unknown branch cannot satisfy a branch-scoped rule.
    expect(
      matchReviewRules(rules, { project: "fx", repo: "fx-payments", targetBranch: null }).map((item) => item.id),
    ).toEqual(["general.md"]);
  });

  it("skips a rule it cannot understand instead of applying it everywhere", async () => {
    const directory = await rulesDirectory({
      "broken-regex.md": rule('applies_to:\n  repo: "fx-("', "括号没闭合。"),
      "list.md": "---\n- a\n- b\n---\n正文",
      "ok.md": rule("", "保留。"),
    });

    const { rules, warnings } = await loadReviewRules(directory);
    expect(rules.map((item) => item.id)).toEqual(["ok.md"]);
    expect(warnings).toEqual([
      "评审规则 broken-regex.md 已跳过：applies_to.repo 不是有效的正则表达式",
      "评审规则 list.md 已跳过：frontmatter 必须是键值对象",
    ]);
  });

  it("refuses an unclosed frontmatter instead of turning a scoped rule global, and reads one behind a BOM", async () => {
    const directory = await rulesDirectory({
      "unclosed.md": '---\napplies_to:\n  project: "^FX$"\npriority: 50\n\n金额必须用整数分。\n',
      "bom.md": `﻿${rule('applies_to:\n  repo: "^fx-"', "BOM 开头也要限定仓库。")}`,
    });

    const { rules, warnings } = await loadReviewRules(directory);
    expect(warnings).toEqual(["评审规则 unclosed.md 已跳过：frontmatter 缺少闭合的 --- 行"]);
    expect(rules.map((item) => item.id)).toEqual(["bom.md"]);
    expect(matchReviewRules(rules, { project: "FX", repo: "other", targetBranch: null })).toEqual([]);
  });

  it("follows linked rule folders once and reports a broken link", async () => {
    const shared = await rulesDirectory({ "team.md": rule("", "团队共享的规则。") });
    const directory = await rulesDirectory({ "own.md": rule("", "自己的规则。") });
    await symlink(shared, join(directory, "shared"));
    await symlink(directory, join(directory, "loop"));
    await symlink(join(directory, "missing.md"), join(directory, "broken.md"));

    const { rules, warnings } = await loadReviewRules(directory);
    expect(rules.map((item) => item.id).sort()).toEqual(["own.md", "shared/team.md"]);
    expect(warnings).toEqual(["评审规则 broken.md 是失效的符号链接，已跳过。"]);
  });

  it("treats a missing rules directory as having no rules", async () => {
    await expect(loadReviewRules(join(tmpdir(), "decision-review-rules-missing", "rules"))).resolves.toEqual({
      rules: [],
      warnings: [],
    });
  });
});
