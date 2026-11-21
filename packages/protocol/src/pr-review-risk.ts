import { z } from "zod";

/**
 * PR 的风险等级（docs/review-collaboration-design.md「风险等级」）：按改动的文件定，不由作者选，一个 PR 取其中最高的。
 * 路径表写在目标分支的 REVIEW.md「风险路径」一节，没写就用默认的判断。评审规则文件，以及本地审阅会拦下的 CI、Git
 * 行为文件，表里怎么写都是高风险：一个 PR 不能靠改表给自己降级。
 */
export const prRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type PrRiskLevel = z.infer<typeof prRiskLevelSchema>;
export const PR_RISK_LABELS: Record<PrRiskLevel, string> = { low: "低风险", medium: "中风险", high: "高风险" };
const RANK: Record<PrRiskLevel, number> = { low: 0, medium: 1, high: 2 };

export const prRiskSchema = z.object({
  level: prRiskLevelSchema,
  /** review_md: the target branch's REVIEW.md has a 风险路径 section; default: it has none, or there is no REVIEW.md. */
  table: z.enum(["review_md", "default"]),
  /** Each reason the PR reaches a level, highest first, with a few of the files behind it. */
  reasons: z.array(z.object({
    level: prRiskLevelSchema,
    reason: z.string().max(200),
    paths: z.array(z.string().max(1_000)).max(5),
    /** Files behind it beyond those listed. */
    more: z.number().int().nonnegative(),
  })).max(20),
  /** The PR changes a file that sets the review's own rules: REVIEW.md, AGENTS.md, CLAUDE.md or CODEOWNERS. */
  changesRules: z.boolean(),
  /** Rows of the REVIEW.md table that could not be read, said rather than skipped in silence. */
  problems: z.array(z.string().max(300)).max(10),
});
export type PrRisk = z.infer<typeof prRiskSchema>;

export interface ReviewRiskRow { level: PrRiskLevel; patterns: string[]; reason: string | null }
export interface ReviewRiskTable { rows: ReviewRiskRow[]; problems: string[] }

/**
 * A REVIEW.md path as a whole-path pattern: `**` is any run of characters, `/` included (`**\/x` is x at any depth);
 * `*` any run within one segment; `?` one character; the rest literal. A trailing `/` is the whole directory.
 */
export const riskPathPattern = (glob: string): RegExp => {
  const path = glob.replace(/^\/+/u, "").replace(/\/$/u, "/**");
  let source = "";
  for (let index = 0; index < path.length; index++) {
    const char = path[index]!;
    if (char === "*" && path[index + 1] === "*") {
      const directory = path[index + 2] === "/";
      source += directory ? "(?:.*/)?" : ".*";
      index += directory ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
};

const LEVELS: Record<string, PrRiskLevel> = { 高: "high", 中: "medium", 低: "low", high: "high", medium: "medium", low: "low" };
const SECTION = /^##\s+(?:风险路径|risk\s+paths?)\s*#*$/iu;
const COLUMNS = {
  level: new Set(["等级", "风险", "风险等级", "level", "risk"]),
  path: new Set(["路径", "path", "paths"]),
  reason: new Set(["说明", "原因", "备注", "reason", "description"]),
};
const cellsOf = (line: string) => line.replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
const LIMITS = { rows: 200, patterns: 50 };

/**
 * The 风险路径 (Risk paths) section of a REVIEW.md: the first table under that level-2 heading, with 等级 and 路径
 * columns (说明 optional). Null when there is no such section. A row it cannot read is left out and said in problems.
 */
export const parseReviewRiskTable = (markdown: string): ReviewRiskTable | null => {
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex((line) => SECTION.test(line.trim()));
  if (start < 0) return null;
  const rows: ReviewRiskRow[] = [];
  const problems: string[] = [];
  let columns: { level: number; path: number; reason: number } | null = null;
  let number = 0;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^#{1,2}\s/u.test(line)) break;
    if (!line.startsWith("|")) {
      if (columns !== null) break;
      continue;
    }
    const cells = cellsOf(line);
    if (columns === null) {
      const at = (names: Set<string>) => cells.findIndex((cell) => names.has(cell.toLowerCase()));
      columns = { level: at(COLUMNS.level), path: at(COLUMNS.path), reason: at(COLUMNS.reason) };
      if (columns.level < 0 || columns.path < 0) {
        problems.push("风险路径表要有“等级”和“路径”两列");
        return { rows, problems };
      }
      continue;
    }
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) continue;
    number += 1;
    if (rows.length >= LIMITS.rows) {
      problems.push(`风险路径表最多读 ${LIMITS.rows} 行，其余没有读`);
      break;
    }
    const word = (cells[columns.level] ?? "").replace(/`/gu, "").replace(/风险$/u, "").trim().toLowerCase();
    const level = LEVELS[word];
    const patterns = (cells[columns.path] ?? "").replace(/`/gu, " ").split(/[、,，;；\s]+/u).filter(Boolean);
    const reason = columns.reason < 0 ? "" : (cells[columns.reason] ?? "").replace(/`/gu, "").trim().slice(0, 200);
    const unsafe = patterns.find((pattern) => pattern.includes("\\") || pattern.split("/").includes(".."));
    if (level === undefined) problems.push(`风险路径表第 ${number} 行的等级「${word}」不认识，只能写高、中、低`);
    else if (patterns.length === 0 || patterns.length > LIMITS.patterns) problems.push(`风险路径表第 ${number} 行要写 1 到 ${LIMITS.patterns} 个路径`);
    else if (unsafe !== undefined) problems.push(`风险路径表第 ${number} 行的路径「${unsafe.slice(0, 100)}」不能含 \\ 或 ..`);
    else rows.push({ level, patterns, reason: reason === "" ? null : reason });
  }
  return { rows, problems: problems.slice(0, 10) };
};

/** The review's own rules: changing them changes what reviews this very PR. */
const RULE_FILE = /(?:^|\/)(?:REVIEW|AGENTS|CLAUDE)\.md$|^(?:\.github\/|\.gitlab\/|docs\/)?CODEOWNERS$/u;
export const isReviewRuleFile = (path: string): boolean => RULE_FILE.test(path);
const ALWAYS_HIGH: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: RULE_FILE, reason: "评审规则文件" },
  { pattern: /^(?:\.github\/workflows\/|\.github\/actions\/|\.circleci\/|\.buildkite\/|\.gitlab\/ci\/)|^(?:\.gitlab-ci\.yml|Jenkinsfile|bitbucket-pipelines\.yml|azure-pipelines\.yml|\.travis\.yml|\.drone\.yml)$/u, reason: "CI 与发布流程" },
  { pattern: /(?:^|\/)(?:\.gitattributes|\.gitmodules|\.lfsconfig)$|^(?:\.githooks|\.husky)\//u, reason: "Git 行为文件" },
];
const DOCUMENT = /^docs?\/|\.(?:md|mdx|rst|adoc|txt)$/iu;
// Here and not in pr-review.ts, which imports from this file: the other way round would make the two import each other.
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^./]+$/u;
/** A test: in a tests directory, or named *.test.* / *.spec.*. */
export const isPrReviewTestPath = (path: string): boolean => TEST_FILE.test(path);

export const assessPrRisk = (paths: readonly string[], table: ReviewRiskTable | null): PrRisk => {
  const rows = (table?.rows ?? []).map((row) => ({ ...row, compiled: row.patterns.map(riskPathPattern) }));
  const reasons = new Map<string, { level: PrRiskLevel; reason: string; paths: string[] }>();
  const add = (level: PrRiskLevel, reason: string, path: string) => {
    const key = `${level}\n${reason}`;
    const found = reasons.get(key) ?? { level, reason, paths: [] };
    found.paths.push(path);
    reasons.set(key, found);
  };
  for (const path of paths) {
    const fixed = ALWAYS_HIGH.find((item) => item.pattern.test(path));
    if (fixed !== undefined) { add("high", fixed.reason, path); continue; }
    const matched = rows.filter((row) => row.compiled.some((pattern) => pattern.test(path)));
    if (matched.length > 0) {
      const top = matched.reduce((best, row) => (RANK[row.level] > RANK[best.level] ? row : best));
      add(top.level, top.reason ?? `REVIEW.md：${top.patterns.join("、")}`.slice(0, 200), path);
    } else if (isPrReviewTestPath(path)) add("low", "测试", path);
    else if (DOCUMENT.test(path)) add("low", "文档", path);
    else add("medium", "普通改动", path);
  }
  const ordered = [...reasons.values()].sort((first, second) => RANK[second.level] - RANK[first.level] || second.paths.length - first.paths.length);
  return {
    level: ordered[0]?.level ?? "low",
    table: table === null ? "default" : "review_md",
    reasons: ordered.slice(0, 20).map(({ level, reason, paths: behind }) => ({ level, reason, paths: behind.slice(0, 5), more: Math.max(0, behind.length - 5) })),
    changesRules: paths.some(isReviewRuleFile),
    problems: table?.problems ?? [],
  };
};
