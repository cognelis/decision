// Sources: https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md (AfterAgent)
// https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/core/src/hooks/types.ts (AfterAgentInput)
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const afterAgent = (prompt: string, response: string, again = false) => ({
  session_id: "8f3c2a10-1d2e-4c5b-9a7f-0e6d5c4b3a21",
  transcript_path: "",
  cwd: "/work/gemini",
  hook_event_name: "AfterAgent",
  timestamp: "2026-10-28T10:00:00.000Z",
  prompt,
  prompt_response: response,
  stop_hook_active: again,
});

export const geminiCli: CatalogFixture = {
  id: "gemini-cli",
  events: [
    { operation: "stop", input: afterAgent("存储怎么选？", `我先看看现有代码。\n${QUESTION}`) },
    // A turn a Stop hook made go on: its prompt is the one already read, its reply no new question.
    { operation: "stop", input: afterAgent("存储怎么选？", "补充说明", true) },
    { operation: "stop", input: afterAgent(ANSWER, "好的，用 SQLite。") },
  ],
  pair: { sessionId: "8f3c2a10-1d2e-4c5b-9a7f-0e6d5c4b3a21", cwd: "/work/gemini", assistantText: `我先看看现有代码。\n${QUESTION}`, userText: ANSWER },
};
