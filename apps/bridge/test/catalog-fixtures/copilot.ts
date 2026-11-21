// Sources: https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-hooks-reference (UserPromptSubmit, Stop)
// https://raw.githubusercontent.com/github/copilot-sdk/main/docs/features/streaming-events.md and
// nodejs/src/generated/session-events.ts (events.jsonl: user.message, assistant.message with apiCallId/chunkIndex/phase)
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const base = { session_id: "4f6c1b2e-0d3a-4c1e-9a7b-2f1e8d9c0a11", cwd: "/work/copilot" };

export const copilot: CatalogFixture = {
  id: "copilot",
  events: [
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", timestamp: "2026-10-28T06:00:00.000Z", prompt: "存储怎么选？" } },
    { operation: "stop", input: { ...base, hook_event_name: "Stop", timestamp: "2026-10-28T06:00:42.000Z", transcript_path: "{transcript}", stop_reason: "end_turn", stop_hook_active: false } },
    { operation: "user-prompt-submit", input: { ...base, hook_event_name: "UserPromptSubmit", timestamp: "2026-10-28T06:01:00.000Z", prompt: ANSWER } },
  ],
  transcript: [
    { id: "e1", timestamp: "2026-10-28T06:00:00.100Z", parentId: null, type: "user.message", data: { content: "存储怎么选？" } },
    { id: "e2", parentId: "e1", type: "assistant.turn_start", data: { turnId: "0" } },
    { id: "e3", parentId: "e2", type: "assistant.message", data: { messageId: "m1", content: "先看看现有配置。", toolRequests: [{ toolCallId: "t1", name: "view" }] } },
    { id: "e4", parentId: "e3", type: "assistant.message", agentId: "sub-1", data: { messageId: "m2", content: "（子 agent 的输出）" } },
    { id: "e5", parentId: "e4", type: "assistant.message", data: { messageId: "m3", content: "想一想", phase: "thinking", apiCallId: "call-9" } },
    // One model call's reply in two chunks.
    { id: "e6", parentId: "e5", type: "assistant.message", data: { messageId: "m4", content: "方案 A 用 SQLite，", phase: "response", apiCallId: "call-9", chunkIndex: 0, chunkCount: 2 } },
    { id: "e7", parentId: "e6", type: "assistant.message", data: { messageId: "m5", content: "方案 B 用 JSON 文件，选哪个？", phase: "response", apiCallId: "call-9", chunkIndex: 1, chunkCount: 2 } },
    { id: "e8", parentId: "e7", type: "assistant.turn_end", data: { turnId: "1" } },
  ],
  pair: { sessionId: base.session_id, cwd: "/work/copilot", assistantText: QUESTION, userText: ANSWER },
};
