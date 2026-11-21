import { createHash, randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { z } from "zod";
import { prCommentSemanticKey } from "@cognelis/decision-core";
import { clipText } from "@cognelis/decision-protocol";
import type { ModelProviderProfile, PrCommentCandidates as CandidateList, PrConnection, PrDiscussion, PrListQuery, PrListResponse, PrReviewLoad } from "@cognelis/decision-protocol";
import { atomicWrite } from "./atomic-write.js";
import { modelFailureMessage, ProfiledModelGatewayError, type ProfiledModelGateway } from "./model/profiled-model-gateway.js";
import { PrPlatformError, type PrCommentCode, type PrDiscussionEntry } from "./pr-platform-client.js";
import { judgeBatch, recognitionBatches, type CommentVerdict, type RecognitionBatch } from "./pr-comment-recognition.js";

/** Model calls one link may spend on its comments in a day, whoever asks for them. */
export const PR_COMMENT_RECOGNITION_DAILY_CALLS = 20;
/** Calls one press of the button spends: a long history PR is read on over several, not all of a day's at once. */
const CALLS_PER_RUN = 3;
/** How far back a link's first look reads: older comments are left to the PR discussion, so turning it on spends no burst. */
const FIRST_LOOK_DAYS = 7;
const MAX_VERDICTS = 5_000;
const MAX_DISMISSED = 2_000;
const MAX_REFUSED = 2_000;

const verdictSchema = z.object({
  bodyHash: z.string(), decision: z.boolean(), question: z.string(), choice: z.string(), quote: z.string(), at: z.string(),
  // Where it was said, for the home page to list a decision by its PR.
  connectionId: z.string().optional(), reference: z.string().optional(), title: z.string().optional(), url: z.string().optional(),
}).strip();
const followSchema = z.object({
  since: z.string(), checkedAt: z.string().nullable(), error: z.string().nullable(),
  /** Refused by the platform (401, 403) or its token unreadable: not asked again until the link is saved again. */
  blocked: z.boolean(),
  /** The model failed on the last look: not tried again before then, so a broken client does not spend the day's calls. */
  retryAt: z.string().nullable().default(null),
  /** Each open PR followed, by what the list said of it when its comments were last read through. */
  prs: z.record(z.string(), z.object({ signal: z.string(), title: z.string() }).strip()),
}).strip();
const refusalSchema = z.object({ bodyHash: z.string(), at: z.string(), connectionId: z.string(), reference: z.string(), title: z.string(), url: z.string(),
  /** Its PR was found merged once it left the open list: kept, a merged PR's discussion still being recorded from. */
  merged: z.boolean().optional() }).strip();
const fileSchema = z.object({
  version: z.literal(1),
  verdicts: z.record(z.string(), verdictSchema).catch({}),
  dismissed: z.record(z.string(), z.string()).catch({}),
  usage: z.record(z.string(), z.object({ day: z.string(), calls: z.number().int().nonnegative() }).strip()).catch({}),
  follow: z.record(z.string(), followSchema).catch({}),
  /**
   * Comments in a batch the provider's moderation refused, by their words and where they were said: not read, which is
   * not "not a decision", and not sent again in the same words.
   */
  refused: z.record(z.string(), refusalSchema).catch({}),
}).strip();
type State = z.infer<typeof fileSchema>;
type Following = z.infer<typeof followSchema>;
type Where = { connectionId: string; reference: string; title: string; url: string };
const empty = (): State => ({ version: 1, verdicts: {}, dismissed: {}, usage: {}, follow: {}, refused: {} });

/** A comment's words as judged: edited, it is judged again; whitespace alone is not an edit. */
export const commentBodyHash = (body: string): string =>
  createHash("sha256").update(body.normalize("NFKC").replace(/\s+/gu, " ").trim()).digest("hex").slice(0, 32);

const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/**
 * What the recognizer said of each comment, which ones the reader turned down, the calls each link spent today and what
 * each following link last saw: one file, keyed like a recorded decision (`prCommentSemanticKey` of the comment's
 * link). Nothing in it is a record.
 */
export class PrCommentVerdicts {
  #state: State | null = null;
  #loading: Promise<State> | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly now: () => Date = () => new Date()) {}

  /** Read once, by one reader: two first reads at once each kept their own copy, and one's writes were lost. */
  #load(): Promise<State> {
    if (this.#state) return Promise.resolve(this.#state);
    this.#loading ??= this.#readFile().then(
      (state) => { this.#state = state; this.#loading = null; return state; },
      (error: unknown) => { this.#loading = null; throw error; });
    return this.#loading;
  }
  async #readFile(): Promise<State> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return empty();
      // Not readable just now (a permission, too many open files): taken for empty, the next write emptied the file,
      // and with it the comments turned down and the day's calls.
      throw error;
    }
    try { return fileSchema.parse(JSON.parse(text)); }
    catch {
      // Unreadable as written: kept beside it for a person to look at, and the reading starts over.
      await rename(this.path, `${this.path}.corrupt-${Date.now()}`).catch(() => undefined);
      return empty();
    }
  }
  #write<T>(change: (state: State) => T): Promise<T> {
    const result = this.#tail.then(async () => {
      const state = await this.#load();
      const value = change(state);
      await atomicWrite(this.path, JSON.stringify(state));
      return value;
    });
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /** The verdict on these words, or none; whether the reader said it is not a decision; a link's calls left today. */
  async read(): Promise<{ verdict(key: string, body: string): z.infer<typeof verdictSchema> | null; dismissed(key: string): boolean; refused(key: string, body: string): boolean; callsLeft(connectionId: string): number }> {
    const state = await this.#load();
    const today = localDay(this.now());
    return {
      verdict: (key, body) => { const found = state.verdicts[key]; return found && found.bodyHash === commentBodyHash(body) ? found : null; },
      refused: (key, body) => state.refused[key]?.bodyHash === commentBodyHash(body),
      dismissed: (key) => key in state.dismissed,
      callsLeft: (connectionId) => {
        const used = state.usage[connectionId];
        return Math.max(0, PR_COMMENT_RECOGNITION_DAILY_CALLS - (used?.day === today ? used.calls : 0));
      },
    };
  }

  /** Takes one of today's calls before it is made, so a crash mid-call still counts it; false when none is left. */
  spend(connectionId: string): Promise<boolean> {
    return this.#write((state) => {
      const today = localDay(this.now());
      const used = state.usage[connectionId]?.day === today ? state.usage[connectionId]!.calls : 0;
      if (used >= PR_COMMENT_RECOGNITION_DAILY_CALLS) return false;
      state.usage[connectionId] = { day: today, calls: used + 1 };
      return true;
    });
  }

  record(items: Array<{ key: string; body: string; verdict: CommentVerdict; where: Where }>): Promise<void> {
    return this.#write((state) => {
      const at = this.now().toISOString();
      for (const { key, body, verdict, where } of items) {
        state.verdicts[key] = { bodyHash: commentBodyHash(body), decision: verdict.decision, question: verdict.question, choice: verdict.choice, quote: verdict.quote, at,
          ...(verdict.decision ? where : {}) };
        // Read since, in other words: no longer one the moderation refused.
        delete state.refused[key];
      }
      const keys = Object.keys(state.verdicts);
      // ponytail: oldest verdicts forgotten first; a forgotten one is only read again if its PR is opened again.
      if (keys.length > MAX_VERDICTS) {
        for (const key of keys.sort((a, b) => state.verdicts[a]!.at.localeCompare(state.verdicts[b]!.at)).slice(0, keys.length - MAX_VERDICTS)) delete state.verdicts[key];
      }
    });
  }

  /** A batch the provider's moderation refused: which of its comments it took exception to, it does not say. */
  refuse(items: Array<{ key: string; body: string; where: Where }>): Promise<void> {
    return this.#write((state) => {
      const at = this.now().toISOString();
      for (const { key, body, where } of items) state.refused[key] = { bodyHash: commentBodyHash(body), at, ...where };
      const keys = Object.keys(state.refused);
      if (keys.length > MAX_REFUSED) {
        for (const old of keys.sort((a, b) => state.refused[a]!.at.localeCompare(state.refused[b]!.at)).slice(0, keys.length - MAX_REFUSED)) delete state.refused[old];
      }
    });
  }

  dismiss(key: string): Promise<void> {
    return this.#write((state) => {
      state.dismissed[key] = this.now().toISOString();
      const keys = Object.keys(state.dismissed);
      if (keys.length > MAX_DISMISSED) {
        for (const old of keys.sort((a, b) => state.dismissed[a]!.localeCompare(state.dismissed[b]!)).slice(0, keys.length - MAX_DISMISSED)) delete state.dismissed[old];
      }
    });
  }

  /** The decisions read and not turned down, each with where it was said. */
  async decisions(): Promise<Array<Where & { key: string; at: string }>> {
    const state = await this.#load();
    return Object.entries(state.verdicts).flatMap(([key, verdict]) =>
      verdict.decision && verdict.connectionId && verdict.reference && verdict.url && !(key in state.dismissed)
        ? [{ key, at: verdict.at, connectionId: verdict.connectionId, reference: verdict.reference, title: verdict.title ?? verdict.reference, url: verdict.url }] : []);
  }

  /** The comments the moderation refused and the reader has not turned down, each with where it was said. */
  async refusals(): Promise<Array<Where & { key: string }>> {
    const state = await this.#load();
    return Object.entries(state.refused).flatMap(([key, { connectionId, reference, title, url }]) => key in state.dismissed ? [] : [{ key, connectionId, reference, title, url }]);
  }

  /** What a link last saw; a link looking for the first time starts a week back. */
  async following(connectionId: string): Promise<Following> {
    const state = await this.#load();
    return structuredClone(state.follow[connectionId] ?? {
      since: new Date(this.now().getTime() - FIRST_LOOK_DAYS * 24 * 3_600_000).toISOString(), checkedAt: null, error: null, blocked: false, retryAt: null, prs: {},
    });
  }
  /** A link that starts over (turned on again, another token or site, removed): its next look is a first look. */
  forget(connectionId: string): Promise<void> {
    return this.#write((state) => {
      delete state.follow[connectionId];
      // Its refused comments go too: said on a link that is gone or starts over, nothing would ever take them back.
      for (const [key, mark] of Object.entries(state.refused)) if (mark.connectionId === connectionId) delete state.refused[key];
    });
  }
  /** A link's PRs with refused comments outside `open`, not found merged yet. */
  async refusedAway(connectionId: string, open: ReadonlySet<string>): Promise<string[]> {
    return [...new Set(Object.values((await this.#load()).refused)
      .filter((mark) => mark.connectionId === connectionId && !mark.merged && !open.has(mark.reference)).map((mark) => mark.reference))];
  }
  /**
   * Refused comments of PRs gone from the open list: kept for one among the merged, whose discussion can still be read
   * and recorded from; let go for one declined or closed, which no list offers any more and the link went on naming.
   */
  settleRefused(connectionId: string, away: readonly string[], merged: ReadonlySet<string>): Promise<void> {
    return this.#write((state) => {
      for (const [key, mark] of Object.entries(state.refused)) {
        if (mark.connectionId !== connectionId || !away.includes(mark.reference)) continue;
        if (merged.has(mark.reference)) mark.merged = true;
        else delete state.refused[key];
      }
    });
  }
  /**
   * A PR read in full: its decisions on comments no longer there, or reworded since, leave the home page (a reworded one
   * is read again). Writes only when there is something to drop.
   */
  async prune(connectionId: string, reference: string, present: ReadonlyMap<string, string>): Promise<void> {
    const changed = (key: string, mark: { bodyHash: string }) => !present.has(key) || commentBodyHash(present.get(key)!) !== mark.bodyHash;
    const stale = (state: State) => Object.entries(state.verdicts).filter(([key, verdict]) => verdict.decision
      && verdict.connectionId === connectionId && verdict.reference === reference && changed(key, verdict)).map(([key]) => key);
    // A refused comment gone or reworded goes too: gone, it was said to be unread with nothing left there to read.
    const unread = (state: State) => Object.entries(state.refused).filter(([key, mark]) =>
      mark.connectionId === connectionId && mark.reference === reference && changed(key, mark)).map(([key]) => key);
    const state = await this.#load();
    if (!stale(state).length && !unread(state).length) return;
    await this.#write((current) => {
      for (const key of stale(current)) delete current.verdicts[key];
      for (const key of unread(current)) delete current.refused[key];
    });
  }
  saveFollowing(connectionId: string, following: Following): Promise<void> {
    return this.#write((state) => { state.follow[connectionId] = following; });
  }
  async follows(): Promise<Record<string, Following>> { return structuredClone((await this.#load()).follow); }
  /** Saved again, the link may be asked again: a new token, or the same one with access granted since. */
  unblock(connectionId: string): Promise<void> {
    return this.#write((state) => {
      const following = state.follow[connectionId];
      if (following) { following.blocked = false; following.retryAt = null; following.error = null; }
    });
  }
}

/** An author named in a link's list: the whole name, or its first word ("ci" for "ci bot"). */
export const skipsAuthor = (author: string, skip: readonly string[]): boolean => {
  const name = author.trim().toLowerCase();
  const first = name.split(/[\s-]/u)[0] ?? "";
  return skip.some((entry) => { const value = entry.trim().toLowerCase(); return value !== "" && (value === name || value === first); });
};

type Entry = PrDiscussionEntry & { code: PrCommentCode | null };
type Read = { at: number; more: boolean; comments: Entry[] };

export interface PrCommentCandidatesOptions {
  verdicts: PrCommentVerdicts;
  connections: {
    list(): Promise<PrConnection[]>;
    discussion(request: PrReviewLoad): Promise<{ comments: Entry[]; more: boolean }>;
    recentComments(request: PrReviewLoad): Promise<{ comments: PrDiscussionEntry[]; more: boolean }>;
    pullRequests(query: PrListQuery): Promise<PrListResponse>;
  };
  gateway: Pick<ProfiledModelGateway, "generate" | "listGenerationProfiles">;
  /** The decision recorded from a comment's link, if any. */
  recorded(url: string): string | null;
  now?: () => number;
}

/** Why something stopped, in a line the page can hold: a platform's answer out of shape said a kilobyte of JSON. */
const failure = (error: unknown): string =>
  clipText(error instanceof ProfiledModelGatewayError ? modelFailureMessage(error.failureCode) : error instanceof Error ? error.message : String(error), 480);
/** How long a link waits after its model failed before trying it again. */
const MODEL_RETRY_MS = 2 * 3_600_000;
const refusedContent = (error: unknown): boolean => error instanceof ProfiledModelGatewayError && error.failureCode === "content_refused";

/**
 * A PR's discussion as the reader sees it: each comment with the decision recorded from it, or the one the link's model
 * read there. The reading is done on the reader's word in the dialog, or by following the link's open PRs; either way
 * within the link's calls for the day, and nothing it finds is recorded until the reader says so.
 */
export class PrCommentCandidates {
  readonly #reads = new Map<string, Read>();
  readonly #running = new Set<string>();
  #following = false;
  constructor(private readonly options: PrCommentCandidatesOptions) {}

  async #read(request: PrReviewLoad, reuse: boolean): Promise<Read> {
    const key = `${request.connectionId}\n${request.reference}`;
    const now = this.options.now?.() ?? Date.now();
    const kept = this.#reads.get(key);
    // What the dialog just showed is what gets judged; ten minutes on, it is read again.
    if (reuse && kept && now - kept.at < 10 * 60_000) return kept;
    const { comments, more } = await this.options.connections.discussion(request);
    const read = { at: now, more, comments: comments.map((comment) => ({ ...comment, ...this.#fitted(comment) })) };
    this.#reads.delete(key);
    this.#reads.set(key, read);
    while (this.#reads.size > 8) this.#reads.delete(this.#reads.keys().next().value!);
    return read;
  }
  // A decision holds at most 8,000 characters; mark the cut rather than hide it.
  #fitted(comment: PrDiscussionEntry) {
    return { url: new URL(comment.url).href, author: comment.author.slice(0, 300), body: comment.body.length > 8_000 ? `${comment.body.slice(0, 7_999)}…` : comment.body };
  }

  async #view(request: PrReviewLoad, read: Read, stopped: string | null = null): Promise<PrDiscussion> {
    const connection = (await this.options.connections.list()).find((item) => item.id === request.connectionId);
    if (!read.more) await this.#prune(request, read.comments);
    const marks = await this.options.verdicts.read();
    const recognition = connection?.recognition;
    let pending = 0;
    const comments = read.comments.map(({ side: _side, ...comment }) => {
      const key = prCommentSemanticKey(comment.url);
      const decisionId = this.options.recorded(comment.url);
      const open = decisionId === null && !marks.dismissed(key);
      const verdict = open ? marks.verdict(key, comment.body) : null;
      const refused = open && !verdict && marks.refused(key, comment.body);
      if (recognition && open && !verdict && !refused && comment.body.trim() && !skipsAuthor(comment.author, recognition.skipAuthors)) pending += 1;
      return { ...comment, decisionId, candidate: verdict?.decision ? { question: verdict.question, choice: verdict.choice, quote: verdict.quote } : null, ...(refused ? { refused: true as const } : {}) };
    });
    return { more: read.more, comments, recognition: recognition && connection ? { pending, callsLeft: marks.callsLeft(connection.id), stopped: stopped && clipText(stopped, 500) } : null };
  }
  /** Every comment of the PR in hand: a decision read on one gone or reworded leaves the home page. */
  #prune(request: PrReviewLoad, comments: readonly { url: string; body: string }[]): Promise<void> {
    return this.options.verdicts.prune(request.connectionId, request.reference, new Map(comments.map((comment) => [prCommentSemanticKey(comment.url), comment.body])));
  }

  /** The link's model, when it chose one that is still enabled and can write an answer. */
  async #profile(connection: PrConnection): Promise<ModelProviderProfile | null> {
    const chosen = connection.recognition?.profileId;
    return (await this.options.gateway.listGenerationProfiles()).find((item) => item.profileId === chosen && item.kind !== "apple") ?? null;
  }

  /** The comments of `comments` not judged yet: not recorded, not turned down, said by someone the link reads. */
  async #open<T extends { url: string; body: string; author: string; createdAt: string }>(connection: PrConnection, comments: readonly T[], since?: string): Promise<T[]> {
    const marks = await this.options.verdicts.read();
    return comments.filter((comment) => {
      const key = prCommentSemanticKey(comment.url);
      return comment.body.trim() !== "" && (since === undefined || Date.parse(comment.createdAt) >= Date.parse(since))
        && this.options.recorded(comment.url) === null && !marks.dismissed(key) && !marks.verdict(key, comment.body) && !marks.refused(key, comment.body)
        && !skipsAuthor(comment.author, connection.recognition?.skipAuthors ?? []);
    });
  }

  /**
   * Spends a call and judges one batch; false when the day's calls are gone. A failed call throws, judged nothing; one
   * the provider's moderation refused first keeps the batch's comments as refused, unread: set down as "not a decision",
   * a real one in another thread of the batch was lost, and sent again as they were they were refused again, a call of
   * the day's each time. Which comment it took exception to the provider does not say, and finding out by sending them
   * one by one would spend the day's calls on the refusal. Reworded, a comment is read again.
   */
  async #judge(connection: PrConnection, profile: ModelProviderProfile, pr: { reference: string; title: string },
    batch: RecognitionBatch, comments: ReadonlyMap<string, { url: string; body: string }>): Promise<boolean> {
    if (!(await this.options.verdicts.spend(connection.id))) return false;
    const bodies = new Map([...comments].map(([id, comment]) => [id, comment.body]));
    const comment = (id: string) => {
      const { url, body } = comments.get(id)!;
      return { key: prCommentSemanticKey(url), body, where: { connectionId: connection.id, reference: pr.reference, title: pr.title, url } };
    };
    const { verdicts } = await judgeBatch(this.options.gateway, { requestId: `pr-comments:${randomUUID()}`, profileId: profile.profileId, batch, bodies }).catch(async (error: unknown) => {
      if (refusedContent(error)) await this.options.verdicts.refuse(batch.subjects.map(comment));
      throw error;
    });
    await this.options.verdicts.record(verdicts.map((verdict) => ({ ...comment(verdict.id), verdict })));
    return true;
  }

  async discussion(request: PrReviewLoad): Promise<PrDiscussion> {
    return this.#view(request, await this.#read(request, false));
  }

  /**
   * Judges the comments not judged yet, newest threads first, in at most a few calls with the model the link chose. A
   * failed call stops the run and says why; what was judged before it stays.
   */
  async recognize(request: PrReviewLoad & { title: string }): Promise<PrDiscussion> {
    const connection = (await this.options.connections.list()).find((item) => item.id === request.connectionId);
    if (!connection) throw new Error("请先在设置 › 链接中添加并选择代码平台。");
    if (!connection.recognition) throw new Error("这个链接没有开启评论识别，请先在 设置 › 链接 里为它选择识别用的模型。");
    const profile = await this.#profile(connection);
    if (!profile) throw new Error("这个链接选的识别模型已停用或已删除，请在 设置 › 链接 里重新选择。");
    const running = `${request.connectionId}\n${request.reference}`;
    if (this.#running.has(running)) throw new Error("这个 PR 的评论正在识别，请等这一轮结束。");
    this.#running.add(running);
    try {
      const read = await this.#read(request, true);
      const open = await this.#open(connection, read.comments);
      const byId = new Map(read.comments.map((comment) => [comment.id, comment]));
      let stopped: string | null = null;
      for (const batch of recognitionBatches(request, read.comments, new Set(open.map((comment) => comment.id)), profile.kind).slice(0, CALLS_PER_RUN)) {
        try {
          if (!(await this.#judge(connection, profile, request, batch, byId))) { stopped = `今天这个链接的 ${PR_COMMENT_RECOGNITION_DAILY_CALLS} 次识别已用完，明天可以继续。`; break; }
        } catch (error) {
          // Refused by the provider's moderation, the batch is kept as refused (#judge), said so on each of its comments,
          // and the next one read.
          if (refusedContent(error)) continue;
          stopped = `识别没有完成：${failure(error)}`; break;
        }
      }
      return await this.#view(request, read, stopped);
    } finally {
      this.#running.delete(running);
    }
  }

  async dismiss(url: string): Promise<void> {
    await this.options.verdicts.dismiss(prCommentSemanticKey(new URL(url).href));
  }

  /**
   * One look by every link that reads its comments: the open PRs it reviews or created, as its own token lists them, and
   * of those only the ones whose comments moved since the last look (a PR gone from the list is read once more, its last
   * comments before merging). New comments are judged within the day's calls; a PR is marked read only when all of its
   * new comments were, so one the calls ran out on is read again next time. Returns whether anything new was found.
   */
  async follow(): Promise<boolean> {
    if (this.#following) return false;
    this.#following = true;
    let found = false;
    try {
      for (const connection of (await this.options.connections.list()).filter((item) => item.recognition)) {
        found = (await this.#followLink(connection)) || found;
      }
    } finally {
      this.#following = false;
    }
    return found;
  }

  async #followLink(connection: PrConnection): Promise<boolean> {
    const following = await this.options.verdicts.following(connection.id);
    const now = this.options.now?.() ?? Date.now();
    if (following.blocked || (following.retryAt !== null && Date.parse(following.retryAt) > now)) return false;
    const finish = async (error: string | null, blocked = false, retryAt: string | null = null) => this.options.verdicts.saveFollowing(connection.id,
      { ...following, checkedAt: new Date(now).toISOString(), error: error && clipText(error, 500), blocked, retryAt });
    const profile = await this.#profile(connection);
    if (!profile) { await finish("识别模型已停用或已删除，请在 设置 › 链接 里重新选择。"); return false; }
    const listed = new Map<string, { title: string; signal: string }>();
    try {
      for (const filter of ["review-requested", "created"] as const) {
        for (const item of (await this.options.connections.pullRequests({ connectionId: connection.id, filter, state: "open", page: 1 })).items) {
          listed.set(item.reference, { title: item.title, signal: `${item.updatedAt}#${item.comments ?? ""}` });
        }
      }
    } catch (error) {
      // Refused, it stays refused until the link is saved again; any other failure is tried at the next look.
      const refused = error instanceof PrPlatformError ? error.status === 401 || error.status === 403 : /令牌|钥匙串/u.test(String(error));
      await finish(failure(error), refused);
      return false;
    }
    const moved = [...listed].filter(([reference, item]) => following.prs[reference]?.signal !== item.signal);
    const gone = Object.keys(following.prs).filter((reference) => !listed.has(reference));
    let found = false;
    let error: string | null = null;
    let retryAt: string | null = null;
    for (const [reference, item] of [...moved, ...gone.map((reference) => [reference, { title: following.prs[reference]!.title, signal: "" }] as const)]) {
      try {
        const { comments, more } = await this.options.connections.recentComments({ connectionId: connection.id, reference });
        const fitted = comments.map((comment) => ({ ...comment, ...this.#fitted(comment) }));
        if (!more) await this.#prune({ connectionId: connection.id, reference }, fitted);
        const open = await this.#open(connection, fitted, following.since);
        const byId = new Map(fitted.map((comment) => [comment.id, comment]));
        let done = true;
        for (const batch of recognitionBatches({ reference, title: item.title }, fitted, new Set(open.map((comment) => comment.id)), profile.kind)) {
          if (!(await this.#judge(connection, profile, { reference, title: item.title }, batch, byId))) { done = false; break; }
        }
        if (!done) { error = `今天的 ${PR_COMMENT_RECOGNITION_DAILY_CALLS} 次识别已用完，剩下的评论明天再看。`; break; }
        found = found || open.length > 0;
        if (listed.has(reference)) following.prs[reference] = { signal: item.signal, title: item.title };
        else delete following.prs[reference];
      } catch (cause) {
        // Its moderation refusing this PR's comments is not the model failing: they are kept as refused (#judge), said on
        // the link for as long as they are, and the next PR is read.
        if (refusedContent(cause)) continue;
        error = failure(cause);
        // The model, not this PR, failed: the next PR would only spend another call on it. Tried again in a while.
        if (cause instanceof ProfiledModelGatewayError) { retryAt = new Date(now + MODEL_RETRY_MS).toISOString(); break; }
        // Gone from the platform as well as the list: nothing left to read there.
        if (cause instanceof PrPlatformError && cause.status === 404 && !listed.has(reference)) delete following.prs[reference];
        if (cause instanceof PrPlatformError && cause.status === 429) break;
      }
    }
    // Refused comments wait for the reader in their PR's discussion. A PR that left the open list is looked for among the
    // merged ones the lists offer, once: there, they stay; declined or closed, no list offers it, and they go. After the
    // PRs are read: let go first, they went out again on a gone PR's last read, refused again and kept for good. Asked
    // again at the next look when the lists cannot be read. ponytail: the merged lists' first page (30) only; a PR merged
    // further back by the time it is missed is taken for closed.
    const away = await this.options.verdicts.refusedAway(connection.id, new Set(listed.keys()));
    if (away.length) {
      try {
        const merged = new Set<string>();
        for (const filter of ["review-requested", "created"] as const) {
          for (const item of (await this.options.connections.pullRequests({ connectionId: connection.id, filter, state: "merged", page: 1 })).items) merged.add(item.reference);
        }
        await this.options.verdicts.settleRefused(connection.id, away, merged);
      } catch { /* Asked again at the next look. */ }
    }
    await finish(error, false, retryAt);
    return found;
  }

  /** What the links following their PRs found and have not had recorded or turned down, by PR, newest first. */
  async candidates(): Promise<CandidateList> {
    const connections = await this.options.connections.list();
    const ids = new Set(connections.map((item) => item.id));
    const prs = new Map<string, CandidateList["prs"][number]>();
    for (const decision of await this.options.verdicts.decisions()) {
      if (!ids.has(decision.connectionId) || this.options.recorded(decision.url) !== null) continue;
      const key = `${decision.connectionId}\n${decision.reference}`;
      const kept = prs.get(key);
      prs.set(key, kept ? { ...kept, count: kept.count + 1, latest: kept.latest > decision.at ? kept.latest : decision.at }
        : { connectionId: decision.connectionId, reference: decision.reference, title: decision.title, count: 1, latest: decision.at });
    }
    const follows = await this.options.verdicts.follows();
    const refusals = (await this.options.verdicts.refusals()).filter((item) => this.options.recorded(item.url) === null);
    // Said with the link's last look for as long as they are unread, not only after the look that met them: the next
    // look's line took their place.
    const unread = (connectionId: string) => {
      const mine = refusals.filter((item) => item.connectionId === connectionId);
      return mine.length ? `有 ${mine.length} 条评论因审核拒绝未能识别，可以手动查看并记录：${[...new Set(mine.map((item) => item.reference))].join("、")}` : null;
    };
    return {
      prs: [...prs.values()].sort((a, b) => b.latest.localeCompare(a.latest)).slice(0, 200),
      links: connections.filter((item) => item.recognition).map((item) => {
        const error = [follows[item.id]?.error, unread(item.id)].filter(Boolean).join(" · ");
        return { connectionId: item.id, checkedAt: follows[item.id]?.checkedAt ?? null, error: error ? clipText(error, 500) : null };
      }),
    };
  }

  /**
   * A link saved: turned on again, given another token or moved to another site, it starts over with a first look a
   * week back (an old one would read everything since, in one day's calls); otherwise one refused or waiting on its
   * model may be asked again now.
   */
  linkSaved(previous: PrConnection | undefined, saved: PrConnection, tokenChanged: boolean): Promise<void> {
    const fresh = !saved.recognition || !previous?.recognition || tokenChanged || previous.baseUrl !== saved.baseUrl || previous.platform !== saved.platform;
    return fresh ? this.options.verdicts.forget(saved.id) : this.options.verdicts.unblock(saved.id);
  }
  linkRemoved(connectionId: string): Promise<void> { return this.options.verdicts.forget(connectionId); }
}
