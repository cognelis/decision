import { z } from "zod";

/**
 * 作者回应（docs/review-collaboration-design.md「作者回应与修复」）: every comment an author's PR receives gets an answer,
 * sent as a standard reply in its thread: what was done with it, in the author's own words. It ends with a plain line, so
 * a reviewer's Paraself can read the answer back (the outcome of a published finding); nothing hidden.
 */
export const PR_RESPONSE_LABELS = { fixed: "已修", wrong: "误报", intended: "有意为之", wontfix: "不处理", later: "转后续" } as const;
export type PrResponseKind = keyof typeof PR_RESPONSE_LABELS;
export const prResponseKindSchema = z.enum(Object.keys(PR_RESPONSE_LABELS) as [PrResponseKind, ...PrResponseKind[]]);
export const PR_RESPONSE_MARK = "— Paraself 作者回应";

/** The reply as it is posted: the answer in bold, the author's words, the closing line. */
export const prResponseReply = (kind: PrResponseKind, words: string): string =>
  `**${PR_RESPONSE_LABELS[kind]}**：${words.trim()}\n\n${PR_RESPONSE_MARK}`;

/** A standard reply read back, by its answer and closing line: what it said and the author's words; null for any other comment. */
export const prResponseOf = (body: string): { kind: PrResponseKind; words: string } | null => {
  const text = body.trim();
  if (!text.endsWith(PR_RESPONSE_MARK)) return null;
  const found = /^\*\*([^*\n]+)\*\*[：:]/u.exec(text);
  const kind = (Object.keys(PR_RESPONSE_LABELS) as PrResponseKind[]).find((key) => PR_RESPONSE_LABELS[key] === found?.[1]);
  return kind ? { kind, words: text.slice(found![0].length, text.length - PR_RESPONSE_MARK.length).trim() } : null;
};

/** What a Paraself pre-review comment says of itself in its closing line (prFindingMarker): its priority and basis. */
export const prReviewMarkOf = (body: string): { priority: "P1" | "P2" | "P3"; basis: string | null; suggestion: boolean } | null => {
  const found = /— Paraself 预评审(?: · ([^\n]*?))? · (P[123])( · 建议)?\s*$/u.exec(body);
  return found ? { priority: found[2] as "P1" | "P2" | "P3", basis: found[1] ?? null, suggestion: found[3] !== undefined } : null;
};

/** A comment's title for a list: a Paraself one's own (**P1 · title**), else its first line. */
export const prCommentTitle = (body: string): string => {
  const own = /^\*\*P[123] · ([^*\n]+)\*\*/u.exec(body.trim());
  const first = (own?.[1] ?? body.trim().split("\n").find((line) => line.trim()) ?? "").replace(/^[#>*\s-]+/u, "").trim();
  return first.length > 80 ? `${first.slice(0, 79)}…` : first || "（空评论）";
};

const text = (max: number) => z.string().max(max);
const replySchema = z.object({ id: text(200), author: text(300), mine: z.boolean(), body: text(65_536), createdAt: text(100) }).strict();
/** A comment opening a thread on the author's PR, someone else's, with what was said under it. */
export const prReceivedCommentSchema = z.object({
  id: text(200), url: text(2_000), author: text(300), path: text(2_000).nullable(), line: z.number().int().positive().nullable(), body: text(65_536), createdAt: text(100),
  /** Which version of the file its line is on; null for a comment on the PR as a whole. */
  side: z.enum(["old", "new"]).nullable(),
  /** A Bitbucket task, open or done; null for a comment that is none, or a platform without tasks. */
  task: z.enum(["open", "resolved"]).nullable(),
  /** Its thread resolved; null where the platform does not say. */
  resolved: z.boolean().nullable(),
  replies: z.array(replySchema).max(200),
}).strict();
export type PrReceivedComment = z.infer<typeof prReceivedCommentSchema>;
export const prReceivedCommentsRequestSchema = z.object({ connectionId: z.string().uuid(), reference: z.string().trim().min(1).max(2_000) }).strict();
export type PrReceivedCommentsRequest = z.infer<typeof prReceivedCommentsRequestSchema>;
export const prReceivedCommentsSchema = z.object({
  comments: z.array(prReceivedCommentSchema).max(1_000),
  /** Pages left unread past what is read at once. */
  more: z.boolean(),
  /** The account the link signs in as, whose replies are the author's; null when the platform did not say. */
  me: text(300).nullable(),
}).strict();
export type PrReceivedComments = z.infer<typeof prReceivedCommentsSchema>;

/** The author's latest standard reply in a comment's thread: what they did with it. */
export const prCommentResponse = (comment: Pick<PrReceivedComment, "replies">): { kind: PrResponseKind; words: string; at: string } | null => {
  const answered = comment.replies.filter((reply) => reply.mine).flatMap((reply) => {
    const said = prResponseOf(reply.body);
    return said ? [{ ...said, at: reply.createdAt }] : [];
  });
  return answered.at(-1) ?? null;
};

/**
 * 不修 (误报, 有意为之, 不处理) or 转后续, sent as a standard reply with the author's account; 转后续 also files a todo
 * first, its title said in the reply. 已修 is sent by the fix itself.
 */
export const prCommentRespondSchema = prReceivedCommentsRequestSchema.extend({
  commentId: text(200).min(1),
  kind: z.enum(["wrong", "intended", "wontfix", "later"]),
  /** The author's words: why not, or (转后续) anything to add; needed but for 转后续. */
  reason: z.string().trim().max(4_000).default(""),
  /** 转后续: the todo's title; left out, the comment's. */
  todo: z.string().trim().min(1).max(200).optional(),
}).strict().refine((request) => request.kind === "later" || request.reason.length > 0, { message: "不修要写明理由。", path: ["reason"] });
export type PrCommentRespond = z.input<typeof prCommentRespondSchema>;
export const prCommentRespondResultSchema = z.object({
  message: text(2_000),
  /** The todo filed for 转后续: its list and number. */
  todo: z.object({ listId: text(200), item: z.number().int().positive(), title: text(200) }).nullable(),
}).strict();
export type PrCommentRespondResult = z.infer<typeof prCommentRespondResultSchema>;

/**
 * 发布后跟踪结果 (docs/review-collaboration-design.md「跟踪每条已发布意见的结果」): what became of a finding posted to a PR,
 * as its thread says. The first five come from the author's standard reply; 可能修了 is a change at its place in a later
 * commit with no reply, kept apart from them; 未回应 is neither yet.
 */
export const PR_OUTCOME_LABELS = { fixed: "修了", wrong: "说错了", intended: "有意为之", wontfix: "无所谓", later: "转后续", maybe_fixed: "可能修了", none: "未回应" } as const;
export type PrOutcomeKind = keyof typeof PR_OUTCOME_LABELS;
export const prPublishedOutcomeSchema = z.object({
  kind: z.enum(Object.keys(PR_OUTCOME_LABELS) as [PrOutcomeKind, ...PrOutcomeKind[]]),
  /** The author's words in their reply. */
  words: z.string().max(2_000).optional(),
  /** When it was read from the PR. */
  at: z.string().datetime(),
}).strict();
export type PrPublishedOutcome = z.infer<typeof prPublishedOutcomeSchema>;
/** Answered with a standard reply: it is read no more. */
export const prOutcomeSettled = (kind: PrOutcomeKind) => kind !== "maybe_fixed" && kind !== "none";

/** The description's 本轮变化 (协作总线): what this round of fixes changed and answered, written in after the push. */
export const PR_ROUND_HEADING = "## 本轮变化";
export const prRoundChanges = (round: { commit: string; fixed: ReadonlyArray<{ title: string; author: string; partial: boolean }>; answered: Partial<Record<PrResponseKind, number>> }): string => {
  const partial = round.fixed.filter((item) => item.partial).length;
  const others = (Object.entries(round.answered) as Array<[PrResponseKind, number]>).filter(([kind, count]) => kind !== "fixed" && count > 0);
  const total = others.reduce((sum, [, count]) => sum + count, 0);
  return [
    `提交 \`${round.commit.slice(0, 12)}\` 修复 ${round.fixed.length} 条意见${partial ? `（其中 ${partial} 条部分修复）` : ""}：`,
    ...round.fixed.map((item) => `- ${item.title}（回应 ${item.author || "审阅人"}）`),
    ...(total ? [`另 ${total} 条已回复：${others.map(([kind, count]) => `${PR_RESPONSE_LABELS[kind]} ${count} 条`).join("，")}。`] : []),
  ].join("\n");
};
/** The description with its 本轮变化 replaced by this round's, or added at its end; the rest stays as written. */
export const prDescriptionWithRound = (description: string, round: string): string => {
  const section = `${PR_ROUND_HEADING}\n\n${round}`;
  const found = /(?:^|\n)## 本轮变化[ \t]*\n/u.exec(description);
  if (!found) return [description.trimEnd(), section].filter(Boolean).join("\n\n");
  const start = found.index + (found[0].startsWith("\n") ? 1 : 0);
  const rest = description.slice(found.index + found[0].length);
  const next = rest.search(/\n## /u);
  return `${description.slice(0, start)}${section}${next < 0 ? "" : `\n${rest.slice(next)}`}`.trimEnd();
};
