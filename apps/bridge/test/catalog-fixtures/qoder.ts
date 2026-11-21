// Sources: https://docs.qoder.com/cli/hooks.md (UserPromptSubmit `prompt`, Stop `last_assistant_message`)
// https://docs.qoder.cn/cli/hooks-reference.md (the same for the 国内版)
import { ANSWER, QUESTION, type CatalogFixture } from "./types.js";

const base = (id: string) => ({ session_id: `${id}-s1`, transcript_path: `/home/u/.${id}/projects/w/${id}-s1.jsonl`, cwd: "/work/qoder" });

const fixture = (id: string): CatalogFixture => ({
  id,
  events: [
    { operation: "user-prompt-submit", input: { ...base(id), hook_event_name: "UserPromptSubmit", prompt: "存储怎么选？" } },
    { operation: "stop", input: { ...base(id), hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: QUESTION } },
    { operation: "user-prompt-submit", input: { ...base(id), hook_event_name: "UserPromptSubmit", prompt: ANSWER } },
  ],
  pair: { sessionId: `${id}-s1`, cwd: "/work/qoder", assistantText: QUESTION, userText: ANSWER },
});

export const qoder = fixture("qoder");
export const qoderCn = fixture("qoder-cn");
