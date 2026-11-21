// Sources: https://docs.augmentcode.com/cli/hooks.md ("Hook Input (Stop event with all metadata options)")
// https://docs.augmentcode.com/cli/v0/hooks.md, https://unpkg.com/@augmentcode/auggie@0.36.0/augment.mjs (0.x: no `cwd`)
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const stop = (userPrompt: string, agentTextResponse: string, cause = "end_turn") => ({
  hook_event_name: "Stop",
  conversation_id: "conv-xyz789",
  workspace_roots: ["/work/auggie"],
  agent_stop_cause: cause,
  conversation: { timestamp: "2026-10-28T06:00:00-08:00", userPrompt, agentTextResponse, agentCodeResponse: [] },
});

export const auggie: CatalogFixture = {
  id: "auggie",
  events: [
    { operation: "stop", input: stop("存储怎么选？", QUESTION) },
    // The turn the answer starts, its own reply cut off: the answer is still read, the cut reply is not kept.
    { operation: "stop", input: stop(ANSWER, "我先建表", "interrupted") },
  ],
  pair: { sessionId: "conv-xyz789", cwd: "/work/auggie", assistantText: QUESTION, userText: ANSWER },
};
