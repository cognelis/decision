// Sources: https://raw.githubusercontent.com/QwenLM/qwen-code/main/docs/users/features/hooks.md
// https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/hooks/types.ts (HookInput, StopInput)
// https://raw.githubusercontent.com/QwenLM/qwen-code/main/packages/core/src/core/client.ts (submittedPrompt on a UserQuery alone)
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const base = { session_id: "qw-s1", transcript_path: "/home/u/.qwen/tmp/p/chats/qw-s1.jsonl", cwd: "/work/qwen", timestamp: "2026-10-28T06:00:00Z" };

export const qwenCode: CatalogFixture = {
  id: "qwen-code",
  events: [
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "存储怎么选？", submitted_prompt: "存储怎么选？" } },
    // A tool result's continuation fires it again, with `prompt` alone: no prompt of the reader's.
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p1", prompt: "[tool result] ls: a b c" } },
    { operation: "stop", input: { ...base, hook_event_name: "Stop", prompt_id: "p1", stop_hook_active: false, last_assistant_message: QUESTION } },
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p2", prompt: ANSWER, submitted_prompt: ANSWER } },
  ],
  pair: { sessionId: "qw-s1", cwd: "/work/qwen", assistantText: QUESTION, userText: ANSWER, assistantTurnId: "p1", userTurnId: "p2" },
};
