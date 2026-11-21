import { PR_BLOCKING_RULE_LABEL, PR_FINDING_BASIS_LABELS, prFindingBasis, type PrReviewFinding, type PrReviewRuleRef } from "@cognelis/decision-protocol";

type Basis = { finding: PrReviewFinding; guides: readonly string[] | undefined; rules?: readonly PrReviewRuleRef[] | undefined };

/** 仓库规则 or 个人依据 · 只作建议; `only` shows it for that tier alone. Nothing for a finding on the code alone. */
export const BasisTag = ({ finding, guides, rules, only }: Basis & { only?: "repository" | "personal" }) => {
  const basis = prFindingBasis(finding, guides, rules);
  if (basis.tier === "none" || (only !== undefined && basis.tier !== only)) return null;
  // A P1 on a rule the reviewer marked blocking is pressed as one, not offered as a suggestion.
  const firm = basis.tier === "personal" && basis.blocking.length > 0 && finding.priority === "P1";
  return <span className="review-basis-tag" data-tier={basis.tier} data-blocking={firm || undefined}>{firm ? PR_BLOCKING_RULE_LABEL : PR_FINDING_BASIS_LABELS[basis.tier]}</span>;
};

/** The repository rules a finding names, or the local review rules alone; the decisions it cites have a line of their own. */
export const GuideBasis = ({ finding, guides, rules }: Basis) => {
  const basis = prFindingBasis(finding, guides, rules);
  if (basis.tier === "repository") return <p className="review-finding-basis"><span>依据</span>{basis.guides.join("、")}<BasisTag finding={finding} guides={guides} /></p>;
  if (basis.tier === "personal" && !basis.decisions) return <p className="review-finding-basis"><span>依据</span>本机评审规则{basis.blocking.length ? ` ${basis.blocking.map((rule) => rule.id.replace(/\.md$/u, "")).join("、")}` : ""}<BasisTag finding={finding} guides={guides} rules={rules} /></p>;
  return null;
};
