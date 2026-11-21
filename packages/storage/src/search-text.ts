import { CONTEXT_SUMMARY_LINES } from "@cognelis/decision-protocol";

/**
 * Text as the app's own searches hold it, in one width and one case: typed with the IME in full-width mode
 * (ＳＱＬｉｔｅ), or written so in a note (ＡＰＩ), a word was not found under the other width, and É not under é
 * where only ASCII case was folded. The vault's notes were already compared so (obsidian-search-service).
 */
export const foldedText = (text: string): string => text.normalize("NFKC").toLowerCase();

/**
 * A query's words, folded as the text they are looked for in. A control character (a NUL pasted in with text) is a
 * space: kept, it ended FTS5's quoted phrase, and the whole list failed. So is Chinese punctuation between keywords
 * ("Redis、缓存"), read as one literal word, and where Han meets Latin, as the agents' search splits them: "使用Redis缓存"
 * missed a note that spaces them.
 */
export const searchTokens = (query: string): string[] => {
  const tokens = foldedText(query.replace(/[\p{Cc}、。，；：！？]/gu, " "))
    .replace(/(?<=\p{Script=Han})(?=[a-z0-9])|(?<=[a-z0-9])(?=\p{Script=Han})/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    // The first 32 words only: a pasted page, each word a clause of its own, outgrew SQLite's expression depth
    // (1000) and the whole list failed. More than these narrow nothing a person types.
    .slice(0, 32);
  if (tokens.length > 0) return tokens;
  // Punctuation alone (an input method's "。" first, a "？" looked for): looked for as typed. Split away, it left no
  // word, and every decision was listed as a match.
  const typed = foldedText(query.replace(/\p{Cc}/gu, "")).trim();
  return typed === "" ? [] : [typed];
};

const SUMMARY_LINES: ReadonlySet<string> = new Set(Object.values(CONTEXT_SUMMARY_LINES));

/**
 * A decision's context as its search row and its vector are made from: without the lines the App writes around an
 * adopted local summary (CONTEXT_SUMMARY_LINES), which the decision-context search leaves out as template lines too.
 * Kept, every decision with one was found by 上下文, 采用 and 本机模型总结. What is shown is the context as written.
 */
export const searchedContext = (context: string): string =>
  context.split("\n").filter((line) => !SUMMARY_LINES.has(line.trim())).join("\n");
