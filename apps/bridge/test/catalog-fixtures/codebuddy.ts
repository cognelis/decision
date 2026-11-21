// Sources: https://cnb.cool/codebuddy/codebuddy-code/-/git/raw/main/docs/hooks.md (UserPromptSubmit `prompt`, Stop with no reply,
// `generation_id`); transcript lines as third parties read them (no official schema): https://github.com/volcengine/OpenViking
// examples/agent-hook-plugin/hosts/codebuddy-turns.mjs
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const base = { session_id: "cb-s1", transcript_path: "{transcript}", cwd: "/work/codebuddy", permission_mode: "default" };

export const codebuddy: CatalogFixture = {
  id: "codebuddy",
  events: [
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", generation_id: "gen-1", prompt: "存储怎么选？" } },
    { operation: "stop", input: { ...base, hook_event_name: "Stop", generation_id: "gen-1", stop_hook_active: false } },
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", generation_id: "gen-2", prompt: ANSWER } },
  ],
  transcript: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "存储怎么选？" }], sessionId: "cb-s1", providerData: { messageId: "u1" } },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<system-reminder>内部提醒</system-reminder>" }], providerData: { isMeta: true } },
    { type: "function_call", name: "Read", arguments: "{}", call_id: "c1" },
    { type: "function_call_result", call_id: "c1", output: "..." },
    { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: QUESTION }], providerData: { messageId: "a1" } },
    { type: "turn-metrics", durationMs: 1200 },
  ],
  pair: { sessionId: "cb-s1", cwd: "/work/codebuddy", assistantText: QUESTION, userText: ANSWER, assistantTurnId: "gen-1", userTurnId: "gen-2" },
};
