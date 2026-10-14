import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Personal PR review rules in the code-meeseeks format: one Markdown file per
 * rule, the frontmatter scopes it and the body is extra review instructions.
 *
 *   ---
 *   applies_to:
 *     project: "^FX$"                  # owner / namespace / Bitbucket project key
 *     repo: "^fx-.*"                   # repository name
 *     target_branch: "^(main|master)$"
 *   tools: [review]
 *   priority: 50                       # larger first
 *   enabled: true
 *   ---
 *
 * Matchers are unanchored, case-sensitive regular expressions, as in
 * code-meeseeks. Unlike code-meeseeks an invalid expression skips the rule
 * instead of matching every repository.
 */
export interface ReviewRule {
  id: string;
  priority: number;
  instructions: string;
  project: RegExp | null;
  repo: RegExp | null;
  targetBranch: RegExp | null;
}

export interface ReviewRuleTarget {
  project: string;
  repo: string;
  /** Unknown target branches never satisfy a rule that names one. */
  targetBranch: string | null;
}

const MAX_RULE_FILES = 200;
export const MAX_MATCHED_REVIEW_RULES = 20;

const pattern = (value: unknown, field: string): RegExp | null => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`applies_to.${field} 必须是正则表达式字符串`);
  try {
    return new RegExp(value);
  } catch {
    throw new Error(`applies_to.${field} 不是有效的正则表达式`);
  }
};

/** Returns null for rules that are disabled, empty or not meant for review. */
export function parseReviewRule(id: string, raw: string): ReviewRule | null {
  const text = raw.replace(/^﻿/u, "");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  // Read as "no frontmatter", an unclosed one would make a scoped rule global and feed its YAML to the model.
  if (!frontmatter && /^---[ \t]*\r?\n/u.test(text)) throw new Error("frontmatter 缺少闭合的 --- 行");
  const meta: unknown = frontmatter ? parseYaml(frontmatter[1]!) ?? {} : {};
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new Error("frontmatter 必须是键值对象");
  }
  const fields = meta as Record<string, unknown>;
  const instructions = (frontmatter ? text.slice(frontmatter[0].length) : text).trim();
  if (fields.enabled === false || instructions.length === 0) return null;
  // code-meeseeks knows describe and review; with neither listed a rule is a review rule.
  const tools = (Array.isArray(fields.tools) ? fields.tools : []).filter(
    (tool) => tool === "review" || tool === "describe",
  );
  if (tools.length > 0 && !tools.includes("review")) return null;
  const scope = fields.applies_to ?? {};
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) {
    throw new Error("applies_to 必须是键值对象");
  }
  const appliesTo = scope as Record<string, unknown>;
  return {
    id,
    priority:
      typeof fields.priority === "number" && Number.isFinite(fields.priority)
        ? fields.priority
        : 0,
    instructions,
    project: pattern(appliesTo.project, "project"),
    repo: pattern(appliesTo.repo, "repo"),
    targetBranch: pattern(appliesTo.target_branch, "target_branch"),
  };
}

/** Reads every `*.md` rule under a directory; a missing directory has no rules. */
export async function loadReviewRules(
  directory: string,
): Promise<{ rules: ReviewRule[]; warnings: string[] }> {
  const files: string[] = [];
  const warnings: string[] = [];
  let truncated = false;
  const visited = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    let entries;
    try {
      // Linked folders are followed (a shared team rules checkout is a common setup); a loop is walked once.
      const real = await realpath(join(directory, relative));
      if (visited.has(real)) return;
      visited.add(real);
      entries = await readdir(join(directory, relative), { withFileTypes: true });
    } catch (error) {
      const missing =
        error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
      if (!(missing && relative === "")) warnings.push(`评审规则目录无法读取：${relative || directory}`);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".")) continue;
      if (files.length >= MAX_RULE_FILES) {
        truncated = true;
        return;
      }
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const kind = entry.isSymbolicLink() ? await stat(join(directory, path)).catch(() => null) : entry;
      if (kind === null) warnings.push(`评审规则 ${path} 是失效的符号链接，已跳过。`);
      else if (kind.isDirectory()) await walk(path);
      else if (kind.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  };
  await walk("");
  if (truncated) warnings.push(`评审规则超过 ${MAX_RULE_FILES} 个文件，其余未读取。`);
  const rules: ReviewRule[] = [];
  for (const id of files) {
    try {
      const rule = parseReviewRule(id, await readFile(join(directory, id), "utf8"));
      if (rule !== null) rules.push(rule);
    } catch (error) {
      warnings.push(`评审规则 ${id} 已跳过：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rules, warnings };
}

export function matchReviewRules(rules: ReviewRule[], target: ReviewRuleTarget): ReviewRule[] {
  return rules
    .filter(
      (rule) =>
        (rule.project === null || rule.project.test(target.project)) &&
        (rule.repo === null || rule.repo.test(target.repo)) &&
        (rule.targetBranch === null ||
          (target.targetBranch !== null && rule.targetBranch.test(target.targetBranch))),
    )
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))
    .slice(0, MAX_MATCHED_REVIEW_RULES);
}

/** Same sectioning code-meeseeks hands to pr-agent. */
export const combineReviewRules = (rules: ReviewRule[]): string =>
  rules.map((rule, index) => `## Ruleset ${index + 1}\n\n${rule.instructions}`).join("\n\n");
