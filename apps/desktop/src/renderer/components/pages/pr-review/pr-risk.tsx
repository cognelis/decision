import { PR_RISK_LABELS, type PrRisk } from "@cognelis/decision-protocol";

/** Why the PR is at its level: its highest level's reasons, each with how many files are behind it. */
export const riskReasons = (risk: PrRisk): string =>
  risk.reasons.filter((reason) => reason.level === risk.level).slice(0, 2)
    .map((reason) => `${reason.reason}：${reason.paths[0] ?? ""}${reason.paths.length + reason.more > 1 ? ` 等 ${reason.paths.length + reason.more} 个文件` : ""}`)
    .join("；");

/** Where the levels came from, so nobody takes the badge for the author's own say. */
export const riskSource = (risk: PrRisk, branch: string | undefined): string => {
  const target = branch ? `目标分支 ${branch} ` : "目标分支";
  return risk.table === "review_md" ? `按${target}的 REVIEW.md 风险路径判定` : `${target}没有 REVIEW.md 风险路径表，按默认规则判定`;
};

/** The PR's level as the list and the review page show it; nothing before a snapshot was read with one. */
export const RiskBadge = ({ risk }: { risk: PrRisk | undefined }) =>
  risk ? <><span className="review-risk" data-level={risk.level} title={riskReasons(risk) || undefined}>{PR_RISK_LABELS[risk.level]}</span><span className="sr-only">，</span></> : null;

/** The 风险等级 tile of what a review takes along: level, why, by whose rules, and what in them could not be read. */
export const RiskTile = ({ risk, branch }: { risk: PrRisk; branch: string | undefined }) => (
  <div data-risk={risk.level}>
    <strong>{PR_RISK_LABELS[risk.level]}</strong><span>风险等级</span>
    <small>
      {riskReasons(risk) ? `${riskReasons(risk)} · ` : ""}{riskSource(risk, branch)}；等级按改动的文件定，不由作者选。
      {risk.level === "high" ? " 高风险建议深度评审。" : ""}
      {risk.changesRules ? " 这个 PR 改了评审规则文件，本次仍按目标分支上原来的规则评审，规则改动请人工确认。" : ""}
      {risk.problems.length ? ` ${risk.problems[0]}${risk.problems.length > 1 ? ` 等 ${risk.problems.length} 处` : ""}。` : ""}
    </small>
  </div>
);
