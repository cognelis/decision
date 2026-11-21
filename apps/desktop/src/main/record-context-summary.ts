import { clipText, clipTextEnd, CONTEXT_SUMMARY_LINES, type ModelProviderProfile } from "@cognelis/decision-protocol";
import { z } from "zod";

import type { RecordContextSummary, RecordContextSummaryRequest } from "../shared/proactive-record.js";
import { modelFailureMessage, ProfiledModelGatewayError, type ProfiledModelGateway } from "./model/profiled-model-gateway.js";

export const CONTEXT_SUMMARY_PROMPT_VERSION = "context-summary-v1";
export const CONTEXT_SUMMARY_SCHEMA_VERSION = "context-summary-v1";

/**
 * How much of a context the model reads. Qwen runs in a 4,096-token window holding the instructions, this and the
 * answer; past it the runtime drops part of the prompt without a word (a 6,469-character one was read as 3,685
 * tokens), and the model summarized text it never saw whole. Sized so the longest prompt and the answer take at most
 * 85% of it in the densest Chinese measured (full-width punctuation, 0.82 tokens a character). The start says where
 * (PR, file, line) and the end what was said last, so the middle goes, and the reader is told.
 * ponytail: a character budget from measured ratios; a context full of emoji or rare Han (1.3–3 tokens a character)
 * can still overflow. Count with the model's own tokenizer if that is ever seen.
 */
const CONTEXT_CHARS = 2_200;
const CONTEXT_HEAD_CHARS = 700;
const TITLE_CHARS = 200;
const CHOICE_CHARS = 400;
/**
 * Loading the model and waiting behind another call on it are not timed by the model itself: without this a reader
 * could come back to a form still saying 总结中 long after.
 */
const SUMMARY_DEADLINE_MS = 120_000;

// No lengths that a verbose answer fails on: the output budget bounds it, the prompt asks for brevity.
export const contextSummaryOutputSchema = z.object({
  change: z.string().trim().min(1).max(2_000),
  views: z.array(z.string().trim().min(1).max(1_000)).max(6),
  decided: z.string().trim().min(1).max(2_000),
}).strict();
type ContextSummaryOutput = z.infer<typeof contextSummaryOutputSchema>;

export const contextSummarySystemPrompt = `你把用户正在记录的一段「当时上下文」压缩成简短的中文总结，用户会对照原文核对后再决定用不用。上下文可能有 PR 标题、代码位置、代码片段和按时间先后排列的评论讨论串。

用户消息先给出记录标题和最终选择，再给出当时上下文。最终选择是用户记下的决定；讨论串里标「本条」的评论，说的就是最终选择这段话。

只输出 JSON：
- change：上下文里的代码或改动本身在做什么，一句话，带上文件名和行号；不要写讨论的结论。
- views：讨论里出现过的不同观点，按出现先后，每项一句、30 字以内，不写人名；同样的意思只写一次；没有讨论时为空数组。
- decided：最后定了什么。给了最终选择时照最终选择写，不改动它的意思；没给时写讨论里明确的结论；都没有时写「上下文没有写明」。

要求：
- 只写记录标题、最终选择和上下文里写明的内容，不推测、不补充、不评价。
- 文件名、路径、行号、函数名、变量名和编号照原文抄写，不改写、不翻译。
- 三个字段合计不超过 400 字。`;

const LOCAL_ONLY = "总结只在本机进行，不会发给远端 API 或命令行工具。";

/** The prompt for one context, and whether it holds only the start and the end of it. */
export const contextSummaryPrompt = (request: Pick<RecordContextSummaryRequest, "context" | "title" | "choice">): { prompt: string; clipped: boolean } => {
  const context = request.context.trim();
  const head = clipText(context, CONTEXT_HEAD_CHARS);
  const tail = clipTextEnd(context, CONTEXT_CHARS - CONTEXT_HEAD_CHARS);
  const clipped = context.length > CONTEXT_CHARS;
  const line = (label: string, value: string | undefined, limit: number) => {
    const flat = value?.replace(/\s+/gu, " ").trim() ?? "";
    return flat ? [`${label}：${clipText(flat, limit)}`] : [];
  };
  return {
    clipped,
    prompt: [
      ...line("记录标题", request.title, TITLE_CHARS),
      ...line("最终选择", request.choice, CHOICE_CHARS),
      "当时上下文：",
      clipped ? `${head}\n……（中间省略 ${context.length - head.length - tail.length} 字）……\n${tail}` : context,
    ].join("\n"),
  };
};

/**
 * The three parts as the reader checks them, and as the record keeps them once adopted, each label a line of its own
 * that searching leaves out (CONTEXT_SUMMARY_LINES). A small model at times wrote one view two or three times over:
 * said once.
 */
export const composeContextSummary = (output: ContextSummaryOutput): string => {
  const views = [...new Set(output.views)];
  return [
    CONTEXT_SUMMARY_LINES.change, output.change,
    ...(views.length === 0 ? [] : [CONTEXT_SUMMARY_LINES.views, ...views.map((view) => `- ${view}`)]),
    CONTEXT_SUMMARY_LINES.decided, output.decided,
  ].join("\n");
};

const failureCode = (error: unknown): string => error instanceof ProfiledModelGatewayError ? error.failureCode
  : error !== null && typeof error === "object" && "code" in error ? String(error.code) : "unknown";

/**
 * A local model's summary of a record's context. Only a backend on this machine writes it (the gateway holds to that
 * for this purpose); with none that can, the reader is told what to turn on, and a failure says what went wrong. The
 * reader's text is never touched here: what to do with the summary is theirs.
 */
export async function summarizeRecordContext(
  gateway: Pick<ProfiledModelGateway, "generate" | "listGenerationProfiles">,
  request: RecordContextSummaryRequest,
  signal?: AbortSignal,
  deadlineMs = SUMMARY_DEADLINE_MS,
): Promise<RecordContextSummary> {
  const local = (await gateway.listGenerationProfiles()).filter((profile: ModelProviderProfile) => profile.kind === "apple" || profile.kind === "qwen");
  // Apple's model only classifies here: offered as the one to use, it could only fail.
  if (!local.some((profile) => profile.kind === "qwen")) {
    return {
      status: "unavailable",
      reason: `${local.length === 0 ? "没有启用本机模型。" : "Apple 本机模型只做分类，不能写总结。"}请先在“模型”中启用 Qwen 本机模型；${LOCAL_ONLY}`,
    };
  }
  const { prompt, clipped } = contextSummaryPrompt(request);
  const deadline = AbortSignal.timeout(deadlineMs);
  try {
    const result = await gateway.generate({
      requestId: `context-summary:${request.requestId}`, purpose: "context-summary", locale: "zh-CN",
      promptVersion: CONTEXT_SUMMARY_PROMPT_VERSION, schemaVersion: CONTEXT_SUMMARY_SCHEMA_VERSION,
      systemPrompt: contextSummarySystemPrompt, userPrompt: prompt,
      outputSchema: z.toJSONSchema(contextSummaryOutputSchema), maxOutputTokens: 768,
    }, (value) => contextSummaryOutputSchema.parse(value), signal === undefined ? deadline : AbortSignal.any([signal, deadline]));
    return { status: "summarized", summary: composeContextSummary(result.parsedOutput), model: result.model, clipped };
  } catch (error) {
    const code = failureCode(error);
    if (code === "provider_unavailable") {
      return { status: "unavailable", reason: "Qwen 本机模型暂时不可用（模型可能还没下载，或校验没有通过），请在“模型”中检查。" };
    }
    throw new Error(
      code === "cancelled" ? "总结已取消。"
        : code === "timeout" ? "本机模型没有在限定时间内写完总结（可能正忙于其它调用，或上下文较长），可以稍后重试。"
          : `总结没有完成：${modelFailureMessage(code)}`,
      { cause: error },
    );
  }
}
