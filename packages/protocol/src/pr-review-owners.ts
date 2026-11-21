import { riskPathPattern } from "./pr-review-risk.js";

/**
 * CODEOWNERS (docs/review-collaboration-design.md「风险等级」：高风险要 2 人，含该区域负责人): where GitHub, GitLab and
 * Bitbucket Data Center look for it, the first found being the one that counts, read from the target branch as every
 * rule is.
 */
export const CODEOWNERS_PATHS = [".bitbucket/CODEOWNERS", ".github/CODEOWNERS", ".gitlab/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"] as const;

/**
 * A CODEOWNERS pattern as gitignore reads it: rooted when it has a slash before its end, at any depth when not; a name
 * covers the directory of that name and everything under it. One ending in `*` does not reach deeper (GitHub's
 * `docs/*` owns docs/a.md, not docs/build/b.md).
 */
const ownedPattern = (pattern: string): RegExp => {
  const inner = pattern.replace(/\/$/u, "");
  const rooted = pattern.startsWith("/") || inner.includes("/");
  const glob = rooted ? inner.replace(/^\//u, "") : `**/${inner}`;
  return new RegExp(`^${riskPathPattern(glob).source.slice(1, -1)}${inner.endsWith("*") ? "" : "(?:/.*)?"}$`, "u");
};

/**
 * Its rules in order: a pattern and its owners as written, a leading `@` dropped (`alice`, `@group` for a Bitbucket
 * `@@group`, `org/team`, an email). GitLab's `[Section]` headers, directives and comments are read past.
 */
export const parseCodeOwners = (text: string): Array<{ pattern: RegExp; owners: string[] }> =>
  text.split(/\r?\n/u).flatMap((raw) => {
    const line = raw.replace(/(?:^|\s)#.*$/u, "").trim();
    const [pattern, ...owners] = line.split(/\s+/u);
    if (!pattern || /^(?:\^?\[|@|!)/u.test(pattern) || pattern.includes("(")) return [];
    return [{ pattern: ownedPattern(pattern), owners: owners.map((owner) => owner.replace(/^@/u, "")).filter(Boolean) }];
  });

/** The owners of these files, the last rule matching each as CODEOWNERS has it: a rule with no owners leaves a file unowned. */
export const prCodeOwners = (text: string, paths: readonly string[]): string[] => {
  const rules = parseCodeOwners(text);
  const owners = new Set<string>();
  for (const path of paths) for (const owner of [...rules].reverse().find((rule) => rule.pattern.test(path))?.owners ?? []) owners.add(owner);
  return [...owners].slice(0, 50);
};

/** A person, as against a group or team (`@group`, `org/team`), whose approval can be checked by name. */
export const isCodeOwnerPerson = (owner: string): boolean => !owner.startsWith("@") && !owner.includes("/");
