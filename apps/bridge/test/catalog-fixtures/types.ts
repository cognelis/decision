/**
 * A catalog tool's hook inputs, built from its docs and source (no real install was run): the events of two turns in the
 * order the tool sends them, and the pair the second turn's prompt should make with the first turn's reply.
 * `{transcript}` in an input is the transcript file the test writes from `transcript`.
 */
export interface CatalogFixture {
  id: string;
  events: { operation: "stop" | "user-prompt-submit"; input: Record<string, unknown> }[];
  transcript?: unknown[];
  pair: { sessionId: string; cwd: string; assistantText: string; userText: string; assistantTurnId?: string; userTurnId?: string };
}

export const QUESTION = "方案 A 用 SQLite，方案 B 用 JSON 文件，选哪个？";
export const ANSWER = "就用方案 A。";
