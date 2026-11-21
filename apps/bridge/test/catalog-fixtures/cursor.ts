// Sources: https://cursor.com/docs/hooks.md (common schema; beforeSubmitPrompt `prompt`, afterAgentResponse `text`, stop `status`)
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const base = (generation: string) => ({
  conversation_id: "c-1a2b",
  generation_id: generation,
  model: "claude-opus",
  cursor_version: "2026.10.22",
  workspace_roots: ["/work/cursor"],
  user_email: null,
  transcript_path: null,
});

export const cursor: CatalogFixture = {
  id: "cursor",
  events: [
    { operation: "user-prompt-submit", input: { ...base("g-0001"), hook_event_name: "beforeSubmitPrompt", prompt: "存储怎么选？", attachments: [] } },
    // Each of the turn's messages in turn: the last is its reply.
    { operation: "stop", input: { ...base("g-0001"), hook_event_name: "afterAgentResponse", text: "先看看现有配置。" } },
    { operation: "stop", input: { ...base("g-0001"), hook_event_name: "afterAgentResponse", text: QUESTION } },
    { operation: "user-prompt-submit", input: { ...base("g-0002"), hook_event_name: "beforeSubmitPrompt", prompt: ANSWER, attachments: [] } },
  ],
  pair: { sessionId: "c-1a2b", cwd: "/work/cursor", assistantText: QUESTION, userText: ANSWER, assistantTurnId: "g-0001", userTurnId: "g-0002" },
};
