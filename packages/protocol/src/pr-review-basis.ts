/**
 * What a review finding stands on (docs/review-collaboration-design.md「意见的依据分三级」), read from what the reviewer
 * is told to write: the guide's file named in the body when it quotes one, the decisions it cites in decisionIndexes.
 *
 * - repository: a guide the target branch keeps (REVIEW.md, AGENTS.md…). The author can be asked to follow it.
 * - personal: only the reviewer's own decisions or local review rules. Teammates cannot see them, so it is a suggestion,
 *   never a demand; it waits to be written into the repository first. But for a P1 on a local rule the reviewer marked
 *   `enforcement: blocking`: that may block, its comment quoting the rule so the author sees what they are held to.
 * - none: no rule or decision, the code alone.
 */
export type PrFindingBasis =
  | { tier: "repository"; guides: string[] }
  | { tier: "personal"; decisions: boolean; localRules: boolean; blocking: Array<{ id: string; text: string }> }
  | { tier: "none" };

export const PR_FINDING_BASIS_LABELS = { repository: "仓库规则", personal: "个人依据 · 只作建议" } as const;
export const PR_BLOCKING_RULE_LABEL = "个人规则 · 标记为阻塞";

/** The local rules a review was given, in order, as its record keeps them. */
type RuleRefs = ReadonlyArray<{ id: string; enforcement?: "blocking" | undefined; text?: string | undefined }> | undefined;
/** The local rules a finding names ("Ruleset N", the N-th rule the review was given) that the reviewer marked blocking. */
const blockingRules = (body: string, rules: RuleRefs) => [...new Set([...body.matchAll(/\bRuleset\s*(\d+)/gu)].map(([, number]) => Number(number)))]
  .flatMap((number) => { const rule = rules?.[number - 1]; return rule?.enforcement === "blocking" && rule.text ? [{ id: rule.id, text: rule.text }] : []; });

// reviewRules reach the model as "## Ruleset N" sections of the reviewer's local rules.
const LOCAL_RULE = /\bRuleset\s*\d+|\breviewRules\b/u;

/** The guide's file name as a name of its own: AGENT_REVIEW.md does not name REVIEW.md; docs/REVIEW.md does. */
const names = (body: string, path: string): boolean =>
  new RegExp(`(?<![\\w.-])${path.slice(path.lastIndexOf("/") + 1).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w])`, "u").test(body);

export const prFindingBasis = (finding: { body: string; decisionIndexes: readonly number[] }, guides: readonly string[] | undefined, rules?: RuleRefs): PrFindingBasis => {
  const cited = (guides ?? []).filter((path) => names(finding.body, path));
  if (cited.length > 0) return { tier: "repository", guides: cited };
  const localRules = LOCAL_RULE.test(finding.body);
  return finding.decisionIndexes.length > 0 || localRules
    ? { tier: "personal", decisions: finding.decisionIndexes.length > 0, localRules, blocking: localRules ? blockingRules(finding.body, rules) : [] } : { tier: "none" };
};
/** A P1 on a rule the reviewer marked blocking: pressed as one, not offered as a suggestion. */
const pressed = (finding: { priority: string }, basis: PrFindingBasis) => basis.tier === "personal" && finding.priority === "P1" && basis.blocking.length > 0;

/** The rule a blocking comment quotes in full, so the author sees what they are held to: they cannot read the reviewer's rules. */
export const prRuleQuote = (rule: { id: string; text: string }): string =>
  [`> 审阅人的规则「${rule.id.replace(/\.md$/u, "")}」（标记为阻塞）：`, ...rule.text.trim().split("\n").map((line) => `> ${line}`.trimEnd())].join("\n");
/** Whether a comment's text still quotes every rule a blocking finding stands on: one edited out may not block. */
export const prBlockingQuoted = (text: string, finding: { priority: string; body: string; decisionIndexes: readonly number[] }, guides: readonly string[] | undefined, rules?: RuleRefs): boolean => {
  const basis = prFindingBasis(finding, guides, rules);
  return !pressed(finding, basis) || (basis.tier === "personal" && basis.blocking.every((rule) => text.includes(prRuleQuote(rule))));
};

/**
 * The line a published comment ends with, so its readers and their own Paraself know where it came from and what it
 * stands on. Plain words, no hidden fields; never a personal note's title, link or number.
 */
export const prFindingMarker = (finding: { priority: string; body: string; decisionIndexes: readonly number[] }, guides: readonly string[] | undefined, rules?: RuleRefs): string => {
  const basis = prFindingBasis(finding, guides, rules), firm = pressed(finding, basis);
  const said = basis.tier === "repository" ? `依据 ${basis.guides.join("、")}` : basis.tier === "personal" ? firm ? "依据 审阅人的规则（标记为阻塞）" : "审阅人的个人经验，仓库暂无此规则" : null;
  return ["— Paraself 预评审", said, finding.priority, basis.tier === "personal" && !firm ? "建议" : null].filter(Boolean).join(" · ");
};

/** A finding as a comment starts out: its priority and title, then its body. */
export const prFindingCommentDraft = (finding: { priority: string; title: string; body: string }): string =>
  `**${finding.priority} · ${finding.title}**\n\n${finding.body}`;

/** As it is posted, from the review page or by record_pr_comments: the draft (or the words given), then the marker line. */
export const prPublishedFindingDraft = (finding: { priority: string; title: string; body: string; decisionIndexes: readonly number[] }, guides: readonly string[] | undefined,
  text = prFindingCommentDraft(finding), rules?: RuleRefs): string => {
  const basis = prFindingBasis(finding, guides, rules);
  // A P1 pressed on a rule of the reviewer's own quotes it, unless the text given already does.
  const quotes = pressed(finding, basis) && basis.tier === "personal" ? basis.blocking.map(prRuleQuote).filter((quote) => !text.includes(quote)) : [];
  return [text, ...quotes, prFindingMarker(finding, guides, rules)].join("\n\n");
};

/** The priority a Paraself pre-review comment ends with (its marker line, as prFindingMarker writes it); null for any other comment. */
const markedPriority = (body: string): string | null => /— Paraself 预评审(?: · [^\n]*?)? · (P[123])(?: · 建议)?\s*$/u.exec(body)?.[1] ?? null;

/**
 * A comment already on the PR saying this finding (the design's 同位置同类意见): on its file within three lines, on the
 * same side where the platform says which, and either naming its title or being another Paraself pre-review comment of
 * the same priority. Checked before posting, beside what the review is told: a finding another reviewer's Paraself
 * already posted is not posted again.
 */
export const prFindingDuplicate = <C extends { path: string | null; line: number | null; side?: "old" | "new" | null; body: string }>(
  finding: { path: string; side: "old" | "new"; line: number; priority: string; title: string }, comments: readonly C[]): C | undefined =>
  comments.find((comment) => comment.path === finding.path && comment.line !== null && Math.abs(comment.line - finding.line) <= 3
    && (comment.side == null || comment.side === finding.side)
    && (comment.body.includes(finding.title) || markedPriority(comment.body) === finding.priority));

/** How a review summary posted from Paraself opens (the review page's 发布评审摘要): each PR keeps one, later rounds answer under it. */
export const PR_REVIEW_SUMMARY_HEAD = "**AI 评审**：";
/** The PR's review summary already there, by whoever's Paraself posted it: a comment on the PR as a whole opening a thread. */
export const prReviewSummaryOn = <C extends { path: string | null; replyTo?: string | null; body: string }>(comments: readonly C[]): C | undefined =>
  comments.find((comment) => comment.path === null && !comment.replyTo && comment.body.trimStart().startsWith(PR_REVIEW_SUMMARY_HEAD));
