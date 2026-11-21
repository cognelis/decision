import {
  PR_RESPONSE_LABELS,
  PR_REVIEW_TOOLS_VERSION,
  clipText,
  prCommentRespondSchema,
  prCommentResponse,
  prCommentTitle,
  prReceivedCommentsRequestSchema,
  prReceivedCommentsSchema,
  prResponseReply,
  type PrCommentRespond,
  type PrCommentRespondResult,
  type PrCommentsToolQuery,
  type PrCommentsToolResult,
  type PrCommentUpdateTool,
  type PrCommentUpdateToolResult,
  type PrConnection,
  type PrReceivedComments,
  type PrReceivedCommentsRequest,
  type TodoListQuery,
  type TodoListResponse,
  type TodoManualRecord,
  type TodoRecordResult,
} from "@cognelis/decision-protocol";

import { resolveConnection } from "./pr-description-tools.js";
import type { PrThread } from "./pr-platform-client.js";

/** Not answered, and why: the comment is gone, answered already, or the user's own. Asked again, the same. */
export class PrResponseRefusal extends Error {}

/**
 * 作者回应（docs/review-collaboration-design.md「作者回应与修复」）: the comments the user's own PR received, each with
 * what they answered, read from the platform; and 不修 or 转后续 sent as a standard reply in its thread, with the user's
 * account. What was answered is the thread itself: nothing is kept here beside it.
 */
export interface PrResponseSources {
  client(connectionId: string): Promise<{
    account(): Promise<string>;
    threads(reference: string): Promise<{ threads: PrThread[]; more: boolean }>;
    reply(reference: string, thread: PrThread, body: string): Promise<string>;
  }>;
  todos: { list(query: TodoListQuery): Promise<TodoListResponse>; recordManual(input: TodoManualRecord): Promise<TodoRecordResult> };
}

const same = (login: string, me: string | null) => me !== null && login !== "" && login.toLowerCase() === me.toLowerCase();
const view = (thread: PrThread, me: string | null) => {
  const { login: _login, discussion: _discussion, replies, ...rest } = thread;
  return { ...rest, body: rest.body.slice(0, 65_536), replies: replies.slice(-200).map(({ login, ...reply }) => ({ ...reply, body: reply.body.slice(0, 65_536), mine: same(login, me) })) };
};

/** The user's standard reply in a comment's thread, if any: what they did with it. */
export const answeredIn = (thread: PrThread, me: string | null) => prCommentResponse(view(thread, me));

/** Someone else's comments opening a thread on the PR, with the replies under each; the user's own are left out. */
export const receivedComments = async (input: PrReceivedCommentsRequest, sources: PrResponseSources): Promise<PrReceivedComments> => {
  const request = prReceivedCommentsRequestSchema.parse(input);
  const client = await sources.client(request.connectionId);
  // Not known who the user is, no reply is theirs: every comment shows as waiting for an answer, none hidden.
  const [me, read] = await Promise.all([client.account().catch(() => null), client.threads(request.reference)]);
  return prReceivedCommentsSchema.parse({ me, more: read.more, comments: read.threads.filter((thread) => !same(thread.login, me)).map((thread) => view(thread, me)) });
};

/** Where 转后续 files its todos: one long-term list per repository. */
export const PR_FOLLOW_UPS = "PR 后续";

/**
 * The standard reply in the comment's thread, read fresh first: a comment answered already is not answered again. 转后续
 * files the todo before replying, so the reply can name it; the reply failing, the todo stays and is said.
 */
export const respondToComment = async (input: PrCommentRespond, sources: PrResponseSources): Promise<PrCommentRespondResult> => {
  const request = prCommentRespondSchema.parse(input);
  const client = await sources.client(request.connectionId);
  const [me, read] = await Promise.all([client.account(), client.threads(request.reference)]);
  const thread = read.threads.find((item) => item.id === request.commentId);
  if (!thread) throw new PrResponseRefusal("PR 上没有找到这条意见：可能已被删除，或在读取的范围之外。");
  if (same(thread.login, me)) throw new PrResponseRefusal("这是你自己的评论，不用回应。");
  const answered = prCommentResponse(view(thread, me));
  if (answered) throw new PrResponseRefusal(`这条意见已经回应过：${PR_RESPONSE_LABELS[answered.kind]}。`);
  let todo: PrCommentRespondResult["todo"] = null;
  if (request.kind === "later") {
    const title = request.todo ?? prCommentTitle(thread.body);
    const project = request.reference.split("#")[0]!;
    const found = (await sources.todos.list({ query: PR_FOLLOW_UPS, project, includeClosed: true, limit: 50 })).lists.find((list) => list.title === PR_FOLLOW_UPS);
    const detail = [`${thread.author} 在 ${request.reference} 的意见：${thread.url}`, clipText(thread.body.trim(), 600), request.reason].filter(Boolean).join("\n\n");
    const recorded = await sources.todos.recordManual({ ...(found ? { listId: found.id } : { title: PR_FOLLOW_UPS, project, longTerm: true }), items: [{ title, detail: clipText(detail, 2_000) }] });
    const item = recorded.added[0] ?? recorded.skipped[0];
    if (!recorded.list || !item) throw new Error(recorded.status === "list_full" ? `「${PR_FOLLOW_UPS}」清单已满：没有建待办，也没有回复。` : "没能建待办，也没有回复。");
    todo = { listId: recorded.list.id, item: item.number, title: item.title };
  }
  const words = todo ? `已建待办「${todo.title}」。${request.reason}` : request.reason;
  try {
    await client.reply(request.reference, thread, prResponseReply(request.kind, words));
  } catch (error) {
    if (!todo) throw error;
    throw new Error(`待办「${todo.title}」已建好，回复没有发出：${error instanceof Error ? error.message : String(error)}`);
  }
  return { message: `已回复「${prCommentTitle(thread.body)}」：${PR_RESPONSE_LABELS[request.kind]}${todo ? `，并建了待办「${todo.title}」` : ""}。`, todo };
};

/** For an agent: the link named or the only one, and one platform write at a time, as the page's are. */
export interface PrResponseToolSources extends PrResponseSources {
  connections(): Promise<PrConnection[]>;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
}
const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1_000);

/** list_pr_comments: the comments on the user's PR, each with what they answered. */
export const commentsForAgent = async (query: PrCommentsToolQuery, sources: PrResponseToolSources): Promise<PrCommentsToolResult> => {
  const { connection, connections, status } = await resolveConnection(sources, query.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections } as const;
  if (!connection) return { ...base, status, reason: null, read: null };
  try { return { ...base, status: "listed", reason: null, read: await receivedComments({ connectionId: connection.id, reference: query.reference }, sources) }; }
  catch (error) { return { ...base, status: "failed", reason: said(error), read: null }; }
};

/** update_pr_comment: 不修 or 转后续 for one comment, as the page's dialog sends it. */
export const updateCommentForAgent = async (request: PrCommentUpdateTool, sources: PrResponseToolSources): Promise<PrCommentUpdateToolResult> => {
  const { connection, connections, status } = await resolveConnection(sources, request.connection);
  const base = { prReviewToolsVersion: PR_REVIEW_TOOLS_VERSION, connections } as const;
  if (!connection) return { ...base, status, reason: null, result: null };
  try {
    const result = await sources.exclusive(() => respondToComment({ connectionId: connection.id, reference: request.reference, commentId: request.comment, kind: request.response,
      reason: request.reason, ...(request.todo ? { todo: request.todo } : {}) }, sources));
    return { ...base, status: "answered", reason: null, result };
  } catch (error) {
    return { ...base, status: error instanceof PrResponseRefusal || (error instanceof Error && error.name === "ZodError") ? "refused" : "failed", reason: said(error), result: null };
  }
};
