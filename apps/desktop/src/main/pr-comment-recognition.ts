import { z } from "zod";
import { clipText, prReviewUnitChars, type ModelProviderKind } from "@cognelis/decision-protocol";
import type { ProfiledModelGateway } from "./model/profiled-model-gateway.js";

export const PR_COMMENT_RECOGNITION_PROMPT_VERSION = "pr-comment-recognition-v2";
export const PR_COMMENT_RECOGNITION_SCHEMA_VERSION = "pr-comment-verdicts-v1";

/** A comment as the discussion lists it; `replyTo` is the comment opening its thread. */
export interface RecognitionComment {
  id: string; author: string; body: string; createdAt: string; replyTo: string | null; path: string | null; line: number | null;
}

const verdictSchema = z.object({
  id: z.string().min(1).max(200),
  decision: z.boolean(),
  question: z.string().max(300),
  choice: z.string().max(600),
  quote: z.string().max(2_000),
}).strict();
export const recognitionOutputSchema = z.object({ verdicts: z.array(verdictSchema).max(40) }).strict();
/** A comment judged: a decision carries the question it settled, what was chosen and its own words saying so. */
export interface CommentVerdict { id: string; decision: boolean; question: string; choice: string; quote: string }

export const recognitionSystemPrompt = `你在代码评审（PR）的评论里找「决定」，帮团队把评审中定下的做法记成决策，以后评审同一个仓库时能查到。

算决定（这条评论里定下了一个做法或取舍，并且值得以后参考）：
- 在几种做法里选定一种：「用 A，不用 B」「统一改成 X」。
- 评审者明确要求的做法或规范，有没有人回复都算：「应该在上游做兼容，不要在这里处理」「禁止 ... 加三元的写法」「用 bulk 操作，避免频繁 updateOne」「常量要放在 consts 里」。
- 约定以后怎么做：「这类接口不传和传 null 都表示不修改」。
- 明确不做、先不做、推迟或缩小范围：「先不处理」「先删掉」「这次不做，单独提 PR」「先只支持单行文本」。对评审意见（包括评审机器人提的问题）只回一句「不处理」也算：接受了这个风险。
- 对讨论串里的提议拍板：「可以」「是的」「好的，就按你说的改」。算决定的是表态的这条回复，question 和 choice 写被同意的内容；提议本身不算。

不算决定：
- 提问、商量或建议，还没有定论：带问号的，「……吧？」「可以试试」「建议……」「感觉……」，以及注明「不阻塞」「可以之后处理」「个人意见」「视情况」的建议。
- 修复说明：「已改」「已修复」，或详细说明这次怎么修的、复核结果如何，只要没有在几种做法之间取舍、没有定下以后的约定，都不算。
- 说明问题不成立：误报、这种情况不会发生、代码其实已经处理了。不同的是，因为现有数据或当前范围里不会出现而先不处理，算决定。
- 只解释代码为什么这样写，或行业通常怎么做。
- 只影响这一处的修修补补：改名、typo、格式、文案、补注释、删多余代码或测试。
- 机器人和 CI 的消息：问题统计、测试报告、补丁下载链接。
- 只有「LGTM」「+1」「👍」。

对每条标了「待判断」的评论给出一项：
- id：评论编号，照抄「#」后面的内容。
- decision：是不是决定。
- question：是决定时，写成被决定的问题，一句问句，例如「多个 SN 字段现在要不要支持？」；不是决定时为空字符串。
- choice：是决定时，一句话写定下的做法，例如「先不支持，现有每个表最多一个 SN 字段」；不是决定时为空字符串。
- quote：是决定时，从这条评论原文里一字不差地摘一句最能说明决定的话，不改写、不拼接；不是决定时为空字符串。

标了「上下文」的评论只用来理解讨论，不要给出判断。拿不准时判为不是决定：漏掉的评论用户还可以手动记录，错报多了用户就不再看这些提示。只输出 JSON。`;

/**
 * What one call may hold. A local model (a 4,096-token context) reads a few comments at a time, a remote one or a CLI
 * agent a PR's worth; `subject` and `context` are how much of a comment to judge and of one only read around it.
 */
const budgetFor = (kind: ModelProviderKind) => prReviewUnitChars(kind) <= 4_000
  ? { chars: 2_400, subjects: 4, subject: 600, context: 240 }
  : { chars: 14_000, subjects: 15, subject: 1_500, context: 500 };

const squash = (text: string): string => text.replace(/\s+/gu, " ").trim();
/** Only to find a quote in a comment: full- and half-width punctuation, any whitespace, read alike. */
const comparable = (text: string): string => squash(text.normalize("NFKC"));
const said = (text: string, limit: number): string => {
  const flat = squash(text);
  return flat.length > limit ? `${clipText(flat, limit - 1)}…` : flat;
};

export interface RecognitionBatch { subjects: string[]; prompt: string }

/**
 * The comments in `subjects` laid out for calls, each among the thread it was said in (oldest first): a reply is judged
 * with what it answered. Threads go whole into a call while it has room; a thread too big for one goes in parts, each
 * with the comment opening it. Newest threads first, so the calls a day allows go to what was said last.
 */
export function recognitionBatches(pr: { title: string; reference: string }, comments: readonly RecognitionComment[],
  subjects: ReadonlySet<string>, kind: ModelProviderKind): RecognitionBatch[] {
  const budget = budgetFor(kind);
  const ids = new Set(comments.map((comment) => comment.id));
  const threads = new Map<string, RecognitionComment[]>();
  for (const comment of comments) {
    const opener = comment.replyTo && ids.has(comment.replyTo) ? comment.replyTo : comment.id;
    threads.set(opener, [...threads.get(opener) ?? [], comment]);
  }
  const line = (comment: RecognitionComment) => subjects.has(comment.id)
    ? `#${comment.id} ${comment.author || "未知作者"}（待判断）：${said(comment.body, budget.subject)}`
    : `#${comment.id} ${comment.author || "未知作者"}（上下文）：${said(comment.body, budget.context)}`;
  const blocks: Array<{ subjects: string[]; text: string; newest: number }> = [];
  const newest = (items: readonly RecognitionComment[]) => Math.max(...items.map((comment) => Date.parse(comment.createdAt) || 0));
  for (const thread of threads.values()) {
    // Oldest first, as the prompt says: a reply "可以" read before what it agreed to reads as agreeing to nothing.
    thread.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const judged = thread.filter((comment) => subjects.has(comment.id));
    if (!judged.length) continue;
    const opener = thread[0]!;
    const head = `【讨论串 · ${opener.path ? `${opener.path}${opener.line ? `:${opener.line}` : ""}` : "PR 整体"}】`;
    const whole = [head, ...thread.map(line)].join("\n");
    if (judged.length <= budget.subjects && whole.length <= budget.chars) {
      blocks.push({ subjects: judged.map((comment) => comment.id), text: whole, newest: newest(judged) });
      continue;
    }
    // Too big for one call: its opener, then as many of the ones to judge as fit, the rest in the next part; each part
    // goes in line by its own newest comment, so the latest part of a long thread is read first.
    let part: RecognitionComment[] = [];
    const flush = () => {
      if (!part.length) return;
      const shown = [opener, ...part.filter((comment) => comment !== opener)];
      blocks.push({ subjects: part.map((comment) => comment.id), newest: newest(part),
        text: [head, ...shown.map(line), `（这个讨论串另有 ${thread.length - shown.length} 条未列出）`].join("\n") });
      part = [];
    };
    for (const comment of judged) {
      const size = [head, line(opener), ...[...part, comment].map(line)].join("\n").length;
      if (part.length && (part.length >= budget.subjects || size > budget.chars)) flush();
      part.push(comment);
    }
    flush();
  }
  blocks.sort((a, b) => b.newest - a.newest);
  const batches: Array<{ subjects: string[]; texts: string[] }> = [];
  for (const block of blocks) {
    const last = batches.at(-1);
    if (last && last.subjects.length + block.subjects.length <= budget.subjects
      && [...last.texts, block.text].join("\n\n").length <= budget.chars) {
      last.subjects.push(...block.subjects); last.texts.push(block.text);
    } else batches.push({ subjects: [...block.subjects], texts: [block.text] });
  }
  return batches.map(({ subjects: judged, texts }) => ({ subjects: judged, prompt: [
    `PR：${said(pr.title, 300)}（${pr.reference}）`,
    "下面按讨论串列出这个 PR 上的评论，每个讨论串里按时间从早到晚。",
    `需要判断的有 ${judged.length} 条：${judged.map((id) => `#${id}`).join("、")}。`,
    texts.join("\n\n"),
  ].join("\n") }));
}

/**
 * What a call answered, kept only where it holds: an id from this call, said once, and a decision with its question,
 * its choice and words found in the comment itself (a quote from another comment is an answer about another comment).
 * Anything else is left unjudged, to be asked again.
 */
export function acceptVerdicts(output: z.infer<typeof recognitionOutputSchema>, subjects: readonly string[],
  bodies: ReadonlyMap<string, string>): { verdicts: CommentVerdict[]; refused: number } {
  const open = new Set(subjects);
  const verdicts: CommentVerdict[] = [];
  let refused = 0;
  for (const item of output.verdicts) {
    const id = item.id.trim().replace(/^#/u, "");
    if (!open.has(id)) { refused += 1; continue; }
    open.delete(id);
    if (!item.decision) { verdicts.push({ id, decision: false, question: "", choice: "", quote: "" }); continue; }
    const question = squash(item.question), choice = squash(item.choice), quote = squash(item.quote);
    if (!question || !choice || !quote || !comparable(bodies.get(id) ?? "").includes(comparable(quote))) { refused += 1; continue; }
    verdicts.push({ id, decision: true, question: said(question, 200), choice: said(choice, 300), quote: said(quote, 500) });
  }
  return { verdicts, refused };
}

/** One call over one batch, with the profile the link chose: it never answers from another model. */
export async function judgeBatch(gateway: Pick<ProfiledModelGateway, "generate">, request: {
  requestId: string; profileId: string; batch: RecognitionBatch; bodies: ReadonlyMap<string, string>; signal?: AbortSignal | undefined;
}) {
  const output = await gateway.generate({
    requestId: request.requestId, purpose: "pr-comment-recognition", locale: "zh-CN",
    promptVersion: PR_COMMENT_RECOGNITION_PROMPT_VERSION, schemaVersion: PR_COMMENT_RECOGNITION_SCHEMA_VERSION,
    systemPrompt: recognitionSystemPrompt, userPrompt: request.batch.prompt,
    outputSchema: z.toJSONSchema(recognitionOutputSchema), maxOutputTokens: Math.min(4_096, 256 + 200 * request.batch.subjects.length),
  }, (value) => recognitionOutputSchema.parse(value), request.signal, request.profileId);
  return { ...acceptVerdicts(output.parsedOutput, request.batch.subjects, request.bodies), usage: output.usage, model: output.model };
}
