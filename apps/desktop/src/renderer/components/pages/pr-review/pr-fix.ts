import { prCommentResponse, prRoundChanges, type LocalReviewJob, type LocalReviewState, type PrReceivedComment, type PrResponseKind } from "@cognelis/decision-protocol";

/**
 * 修 on the user's own PR (作者回应): the local review tasks made of its comments, and what each comment's fix stands at,
 * read from the local review's own state. Nothing here is kept beside it.
 */
export const fixJobsFor = (state: LocalReviewState, connectionId: string, reference: string): LocalReviewJob[] =>
  state.jobs.filter((job) => job.pr?.connectionId === connectionId && job.pr.reference === reference).sort((a, b) => b.createdAt.localeCompare(a.createdAt));

const RUNNING = new Set(["queued", "evaluating", "preparing_dependencies", "running_groups"]);
/** A task still to come back with something: the page reads the local review again until it has. */
export const fixRunning = (job: LocalReviewJob) => RUNNING.has(job.state) || job.groups.some((group) => ["fixing", "pushing", "opening_pr"].includes(group.state));

/** Lines added and removed in a unified diff, its headers aside. */
export const diffSize = (diff: string) => {
  let added = 0, removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
};

/** The PR's branch moved on before the push: the fix is redone on the new head, never pushed over it. */
export const fixMoved = (job: LocalReviewJob) => job.groups[0]?.state === "failed" && !job.groups[0].retryable && (job.groups[0].error ?? "").startsWith("推送前远端分支头变了");

/** What a comment's fix stands at, in the latest task that has it; null for one never handed over. */
export const fixStatus = (comment: Pick<PrReceivedComment, "id">, jobs: readonly LocalReviewJob[]): { job: LocalReviewJob; text: string; tone: "busy" | "ready" | "done" | "bad" } | null => {
  const job = jobs.find((item) => item.pr?.comments.some((link) => link.commentId === comment.id));
  if (!job) return null;
  const link = job.pr!.comments.find((item) => item.commentId === comment.id)!;
  const verdict = job.verdicts.find((item) => item.id === link.annotationId);
  const group = job.groups.find((item) => item.annotationIds.includes(link.annotationId));
  const outcome = group?.fix?.outcomes.find((item) => item.id === link.annotationId);
  if (job.state === "queued") return { job, text: "交给本地审阅了，排队中", tone: "busy" };
  if (job.state === "evaluating" || job.state === "preparing_dependencies") return { job, text: job.state === "evaluating" ? "本地审阅在评估这条意见" : "本地审阅在准备依赖", tone: "busy" };
  if (verdict && verdict.verdict !== "accept") return { job, text: `本地审阅${verdict.verdict === "reject" ? "没有采纳" : "要你补充"}：${verdict.reason}`, tone: "bad" };
  if (job.state === "failed" || job.state === "interrupted" || job.state === "cancelled") return { job, text: `本地审阅${job.state === "failed" ? "失败" : job.state === "interrupted" ? "被中断" : "已取消"}${job.error ? `：${job.error}` : ""}`, tone: "bad" };
  if (!group) return { job, text: job.state === "no_changes" ? "本地审阅没有改出东西" : "本地审阅还在处理", tone: job.state === "no_changes" ? "bad" : "busy" };
  if (group.state === "pending" || group.state === "fixing") return { job, text: "本地审阅正在修改", tone: "busy" };
  if (group.state === "pushing") return { job, text: "正在推送到原 PR", tone: "busy" };
  if (group.state === "pr_opened") return { job, text: `已推送到原 PR，提交 ${group.artifact?.commitOid.slice(0, 12) ?? ""}${job.pr!.replied.includes(comment.id) ? "，已回复已修" : ""}`, tone: "done" };
  if (outcome?.outcome === "skipped") return { job, text: `本地审阅没有改这条：${outcome.summary}`, tone: "bad" };
  if ((group.state === "blocked" || group.state === "committed") && group.artifact) {
    const size = diffSize(group.artifact.diff);
    return { job, text: `本地审阅已改好：+${size.added} −${size.removed}${outcome ? ` · ${outcome.outcome === "partial" ? "部分修复，" : ""}${outcome.summary}` : ""}`, tone: "ready" };
  }
  return { job, text: group.state === "no_changes" ? "本地审阅没有改出东西" : `本地审阅${group.state === "cancelled" ? "已取消" : "失败"}${group.error ? `：${group.error}` : ""}`, tone: "bad" };
};

/** The description's 本轮变化 as it will be written once the fix is pushed, from the task and the answers on the PR. */
export const roundPreview = (job: LocalReviewJob, comments: readonly PrReceivedComment[]): string | null => {
  const group = job.groups[0], pr = job.pr;
  if (!pr || !group?.artifact) return null;
  const fixed = pr.comments.flatMap((link) => {
    const outcome = group.fix?.outcomes.find((item) => item.id === link.annotationId);
    return outcome && outcome.outcome !== "skipped" ? [{ title: link.title, author: link.author, partial: outcome.outcome === "partial" }] : [];
  });
  const answered: Partial<Record<PrResponseKind, number>> = {};
  for (const comment of comments) {
    if (pr.comments.some((link) => link.commentId === comment.id)) continue;
    const said = prCommentResponse(comment);
    if (said) answered[said.kind] = (answered[said.kind] ?? 0) + 1;
  }
  return prRoundChanges({ commit: group.artifact.commitOid, fixed, answered });
};
