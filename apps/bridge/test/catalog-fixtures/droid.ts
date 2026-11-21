// Sources: https://docs.factory.ai/reference/hooks-reference.md (common fields; UserPromptSubmit `prompt`; Stop with no reply)
// transcript lines as Entire reads them (no official schema): https://github.com/entireio/cli/blob/2ea3c076cf60fbe1219c749af62be1f03fbd78db/cmd/entire/cli/agent/factoryaidroid/transcript_test.go
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const base = { session_id: "abc123", transcript_path: "{transcript}", cwd: "/work/droid", permission_mode: "off" };

export const droid: CatalogFixture = {
  id: "droid",
  events: [
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt: "存储怎么选？", has_images: false } },
    { operation: "stop", input: { ...base, hook_event_name: "Stop", stop_hook_active: false, tool_execution_count: 1, elapsed_time: 12345 } },
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", prompt: ANSWER, has_images: false } },
  ],
  transcript: [
    { type: "session_start", id: "s0" },
    { type: "message", id: "msg-1", message: { role: "user", content: [{ type: "text", text: "存储怎么选？" }] } },
    { type: "message", id: "msg-2", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
    { type: "message", id: "msg-3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
    { type: "message", id: "msg-4", message: { role: "assistant", content: [{ type: "text", text: QUESTION }] } },
  ],
  pair: { sessionId: "abc123", cwd: "/work/droid", assistantText: QUESTION, userText: ANSWER },
};
