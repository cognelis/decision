import { PR_BUILD_LABELS, PR_DESCRIPTION_SECTION_LABELS, PR_REQUIRED_APPROVALS, PR_RISK_LABELS, isCodeOwnerPerson, prDescriptionSections, type PrReviewSnapshot, type PrReviewStatus, type PrRisk } from "@cognelis/decision-protocol";

import { ActionIcon } from "../../IconButton.js";
import { riskSource } from "./pr-risk.js";

/** A PR's platform status as the page last read it: its status, or why it could not be read. */
export interface ReadStatus { status: PrReviewStatus | null; error?: string | undefined }

/** The list's word on a PR's build, where there is one to look at: passed, running or failed. */
export const BuildBadge = ({ read }: { read: ReadStatus | undefined }) => {
  const build = read?.status?.build;
  return build === "passed" || build === "running" || build === "failed"
    ? <><span className="review-build" data-build={build}>{PR_BUILD_LABELS[build]}</span><span className="sr-only">，</span></> : null;
};

const BUILD = { passed: "通过", failed: "失败", running: "进行中", none: "没有构建", unknown: "读不到" } as const;
const Ok = ({ children }: { children: string }) => <span data-state="ok"><ActionIcon name="check" />{children}</span>;

/**
 * A high-risk PR's area owner among its approvers, by the target branch's CODEOWNERS: people are checked by the names
 * the platform gives, groups and teams cannot be and are said so.
 */
const ownerNote = (owners: PrReviewSnapshot["codeOwners"], logins: readonly string[]) => {
  if (owners === undefined) return <span> · 需含该区域负责人</span>;
  if (owners.file === null) return <span> · 需含该区域负责人（仓库没有 CODEOWNERS，无法核对）</span>;
  if (!owners.owners.length) return <span> · 需含该区域负责人（CODEOWNERS 没有覆盖这些文件）</span>;
  const approved = owners.owners.filter((owner) => isCodeOwnerPerson(owner) && logins.some((login) => login.toLowerCase() === owner.toLowerCase()));
  if (approved.length) return <><span> · </span><Ok>{`负责人 ${approved.join("、")} 已批准`}</Ok></>;
  const groups = owners.owners.some((owner) => !isCodeOwnerPerson(owner));
  return <span data-state="warn"> · 需含负责人：{owners.owners.slice(0, 3).join("、")}{owners.owners.length > 3 ? " 等" : ""}{groups ? "（组成员无法核对）" : ""}</span>;
};

/** What the author's merge still waits for, of what the platform holds it on: people's approvals, the build, open blockers. */
const waitingFor = (status: PrReviewStatus, required: number | null): string => {
  const missing = [
    status.approvals && required !== null && status.approvals.count < required ? `${required - status.approvals.count} 人批准` : null,
    status.build === "passed" || status.build === "none" ? null : "构建通过",
    status.blockers ? "阻塞项完成" : null,
  ].filter(Boolean);
  return missing.length ? `合并要等：${missing.join("、")}。` : "批准、构建和阻塞项都满足了。";
};

/**
 * 批准条件 above a review (docs/review-collaboration-design.md「批准」): its level, people's approvals against what the
 * level needs, the head commit's build, what still blocks, and the description's three parts. The platform's part is
 * read fresh each time the record opens; `read` undefined is reading still.
 */
export function ApprovalConditions({ risk, branch, read, description, commit, owners, onDraft, responses, author }: {
  risk: PrRisk | undefined; branch: string | undefined; read: ReadStatus | undefined; description: string;
  /** The changed files' owners by CODEOWNERS, which a high-risk PR needs one of. */
  owners?: PrReviewSnapshot["codeOwners"];
  /** Drafts the description's missing parts (PrDescriptionDialog). */
  onDraft?: () => void;
  /** The commit the review read: a status of a newer one says so. */
  commit: string;
  /** The user's own PR: how many of the comments it received have an answer (作者回应). */
  responses?: { answered: number; total: number } | undefined;
  /** The user's own PR: said first, what its merge still waits for. */
  author?: boolean;
}) {
  const status = read?.status ?? null;
  const unread = read === undefined ? "读取中…" : "读不到";
  // The description as the platform has it now (written back since the review, say), else as the review read it.
  const sections = status?.sections ?? prDescriptionSections(description);
  const parts = Object.keys(sections) as Array<keyof typeof sections>;
  const missing = parts.filter((part) => !sections[part]).map((part) => PR_DESCRIPTION_SECTION_LABELS[part]);
  const approvals = status?.approvals;
  const required = risk ? PR_REQUIRED_APPROVALS[risk.level] : null;
  return <section className="review-approval" aria-label="批准条件">
    <dl>
      {risk ? <div><dt>风险等级</dt><dd><span className="review-risk" data-level={risk.level}>{PR_RISK_LABELS[risk.level]}</span>{risk.reasons.find((reason) => reason.level === risk.level)?.reason}</dd></div> : null}
      <div><dt>批准</dt><dd title={approvals?.users.join("、") || undefined}>{approvals ? <span data-state={required !== null && approvals.count >= required ? "ok" : undefined}>{approvals.count}{required === null ? " 人" : ` / ${required}`}</span> : unread}
        {approvals?.stale.length ? <span data-state="warn"> · {approvals.stale.length} 人的批准在旧提交上</span> : null}{risk?.level === "high" ? ownerNote(owners, approvals?.logins ?? []) : null}</dd></div>
      <div><dt>构建</dt><dd>{!status ? unread : status.build === "passed" ? <Ok>通过</Ok> : <span data-state={status.build === "failed" ? "bad" : status.build === "running" ? "warn" : undefined}>{BUILD[status.build]}</span>}</dd></div>
      <div><dt>阻塞项</dt><dd>{status?.blockers == null ? unread : status.blockers ? <span data-state="warn">{status.blockers} 项未完成</span> : <Ok>没有</Ok>}</dd></div>
      {responses ? <div><dt>回应</dt><dd>{responses.answered === responses.total ? <Ok>{responses.total ? `${responses.total} 条都有去向` : "还没有意见"}</Ok> : <span data-state="warn">{responses.answered} / {responses.total} 条有去向</span>}</dd></div> : null}
      <div><dt>PR 描述</dt><dd>{missing.length ? <span data-state="warn">{missing.length === parts.length ? "没写验证、风险、撤回" : `缺${missing.join("、")}`}</span> : <Ok>验证、风险、撤回</Ok>}
        {missing.length && onDraft ? <button type="button" className="review-note-link" onClick={onDraft}>起草</button> : null}</dd></div>
    </dl>
    <p>
      {author && status ? `${waitingFor(status, required)} ` : ""}等级按改动的文件定，不由作者选{risk ? `；${riskSource(risk, branch)}` : ""}。AI 的批准不算人{approvals?.users.length ? `；已批准：${approvals.users.join("、")}` : ""}{approvals?.stale.length ? `；${approvals.stale.join("、")} 批准的是旧提交，新提交还要再看` : ""}。
      {status?.blocking === "discussions" ? " 这个平台的阻塞项是未解决的讨论。" : ""}
      {status?.blockersHold === false ? ` 仓库没有开启${status.blocking === "tasks" ? "“没有未完成任务”的合并检查" : "“讨论解决后才能合并”"}，阻塞项拦不住合并。` : ""}
      {status && status.sourceCommit !== commit ? ` PR 之后有新提交（${status.sourceCommit.slice(0, 8)}）：构建、批准和阻塞项是新提交的。` : ""}
      {read?.error ? ` 平台状态读不到：${read.error}` : ""}
      {status?.problems.length ? ` ${status.problems.join("；")}` : ""}
    </p>
  </section>;
}
