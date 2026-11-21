import { localReviewTaskTitle, LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS, LOCAL_REVIEW_MAX_TURN_ATTEMPTS, LOCAL_REVIEW_USER_MESSAGE_MAX } from "@cognelis/decision-protocol";
import type { LocalReviewConversationAction, LocalReviewExecution, LocalReviewJob, LocalReviewReference, LocalReviewTurn } from "@cognelis/decision-protocol";

import { zonedFormatter } from "../../../calendar-date.js";

const taskDateTime = zonedFormatter({ year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
export const reviewTaskTitle = (job: LocalReviewJob): string => localReviewTaskTitle({ annotations: job.annotations, createdAt: taskDateTime.format(new Date(job.createdAt)) });

/** A reference chip kept with the text block that was inserted for it; the chip is only sent while that block is still in the draft. */
export interface DraftReference extends LocalReviewReference { token: string }
export interface ConversationDraft { body: string; references: DraftReference[] }
export const emptyDraft: ConversationDraft = { body: "", references: [] };
export const DRAFT_MAX = LOCAL_REVIEW_USER_MESSAGE_MAX;

export const EXECUTION_ACTIVE = new Set(["pending", "fixing", "committed", "pushing", "commenting"]);
export const JOB_BUSY = new Set(["queued", "evaluating", "preparing_dependencies", "running_groups"]);

export const executionLabels: Record<string, string> = { pending: "等待执行", fixing: "正在修改", committed: "已提交", pushing: "正在推送", commenting: "正在发布评论", done: "已完成", done_comment_failed: "已推送，评论未发布", no_changes: "没有产生改动", blocked: "等待风险授权", remote_changed: "远端分支已变化", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
export const turnLabels: Record<string, string> = { queued: "排队中", running: "思考中", answered: "已回答", failed: "回合失败", cancelled: "回合已取消", interrupted: "回合已中断" };

export const shortOid = (oid: string) => oid.slice(0, 10);
export const annotationRange = (a: { startLine: number; endLine: number }) => a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}-${a.endLine}`;

/** The quoted block inserted at the cursor. Only the ids go to the host; it re-reads the ledger text for the prompt. */
export function quoteBlock(job: LocalReviewJob, ref: LocalReviewReference): string | null {
  if (ref.kind === "annotation") {
    const a = job.annotations.find(item => item.id === ref.id); if (!a) return null;
    return [`> ${a.path}:${annotationRange(a)}（${a.side === "old" ? "旧版本" : "新版本"}）`, ...a.body.split("\n").map(line => `> ${line}`)].join("\n");
  }
  const g = job.groups.find(item => item.id === ref.id); if (!g) return null;
  const commit = g.artifact?.commitOid ? `提交 ${shortOid(g.artifact.commitOid)}` : "尚无提交";
  return [`> 组 ${g.ordinal}「${g.title}」`, `> 分支 ${g.branch} · ${commit}${g.pr ? ` · ${g.pr.url}` : ""}`].join("\n");
}

export function insertQuote(draft: ConversationDraft, block: string, ref: LocalReviewReference, cursor: number | null): { draft: ConversationDraft; caret: number } {
  const known = draft.references.find(item => item.kind === ref.kind && item.id === ref.id);
  if (known && draft.body.includes(known.token)) return { draft, caret: draft.body.indexOf(known.token) + known.token.length };
  const at = Math.max(0, Math.min(cursor ?? draft.body.length, draft.body.length)), before = draft.body.slice(0, at), after = draft.body.slice(at);
  const insert = `${before && !before.endsWith("\n") ? "\n" : ""}${block}\n\n`;
  const references = draft.references.filter(item => !(item.kind === ref.kind && item.id === ref.id));
  if (references.length < 20) references.push({ kind: ref.kind, id: ref.id, token: block });
  return { draft: { body: before + insert + after, references }, caret: (before + insert).length };
}

/** The references that go with a message: still quoted in the text, each once, within the host's limit. */
export const sendableReferences = (draft: ConversationDraft): LocalReviewReference[] => {
  const seen = new Set<string>(), result: LocalReviewReference[] = [];
  for (const item of draft.references) { const key = `${item.kind}:${item.id}`; if (!seen.has(key) && draft.body.includes(item.token)) { seen.add(key); result.push({ kind: item.kind, id: item.id }); } }
  return result.slice(0, 20);
};

export const unreadCount = (job: LocalReviewJob) => job.conversation.messages.filter(message => message.seq > job.conversation.readSeq && message.role !== "user").length;
export const activeTurn = (job: LocalReviewJob): LocalReviewTurn | undefined => job.turns.find(turn => turn.state === "queued" || turn.state === "running");
export const executionFor = (job: LocalReviewJob, messageId: string) => job.executions.find(execution => execution.messageId === messageId);

export type ConversationButton = { key: string; label: string; secondary?: boolean; action: Pick<LocalReviewConversationAction, "action"> & { executionId?: string; turnId?: string } | "review_risk" };

/** Buttons are derived from the turn or execution as it is now, never from stored actions. A token hit only ever offers discard. */
export function executionButtons(job: LocalReviewJob, e: LocalReviewExecution): ConversationButton[] {
  const group = job.groups.find(g => g.id === e.groupId), secret = !!(e.artifact?.secretFindings?.length || group?.artifact?.secretFindings?.length);
  const exhausted = e.attempts >= LOCAL_REVIEW_MAX_EXECUTION_ATTEMPTS, discard: ConversationButton = { key: "discard", label: "丢弃本次追加", secondary: true, action: { action: "discard_execution", executionId: e.id } };
  switch (e.state) {
    case "pending": case "fixing": case "committed": return [{ key: "cancel", label: "取消执行", secondary: true, action: { action: "cancel_execution", executionId: e.id } }];
    case "blocked": return secret ? [discard] : [{ key: "risk", label: "审阅风险改动", action: "review_risk" }, discard];
    case "failed": case "interrupted": case "cancelled": return exhausted ? [] : [{ key: "retry", label: "重试执行", action: { action: "retry_execution", executionId: e.id } }, discard];
    case "done_comment_failed": return e.pushed && !exhausted ? [{ key: "comment", label: "重试评论", action: { action: "retry_comment", executionId: e.id } }] : [];
    default: return [];
  }
}

export function turnButtons(t: LocalReviewTurn): ConversationButton[] {
  if (t.state === "queued" || t.state === "running") return [{ key: "cancel", label: "取消本回合", secondary: true, action: { action: "cancel_turn", turnId: t.id } }];
  if ((t.state === "failed" || t.state === "cancelled" || t.state === "interrupted") && t.attempts < LOCAL_REVIEW_MAX_TURN_ATTEMPTS) return [{ key: "retry", label: "重试此回合", action: { action: "retry_turn", turnId: t.id } }];
  return [];
}

/** Authorization for a risky append: the execution's own new artifact and original base, never the group's previous commit. */
export function executionAuthorization(job: LocalReviewJob, e: LocalReviewExecution) {
  const group = job.groups.find(g => g.id === e.groupId);
  if (e.kind === "new") {
    const artifact = group?.artifact; if (!artifact || artifact.secretFindings?.length) return null;
    return { artifact, authorization: { executionId: e.id, groupId: e.groupId, commitOid: artifact.commitOid, planBaseOid: job.snapshot.headSha, risks: artifact.risks, pushUrl: job.pushUrl } };
  }
  if (!e.artifact || e.artifact.secretFindings?.length || !e.newCommitOid || !e.planBaseOid) return null;
  return { artifact: e.artifact, authorization: { executionId: e.id, groupId: e.groupId, commitOid: e.newCommitOid, planBaseOid: e.planBaseOid, risks: e.artifact.risks, pushUrl: job.pushUrl } };
}
