import type { CustomClient } from "./custom-client.js";

/**
 * A tool Paraself connects as it ships: a client's description written as data, as the reader's own are, and read by
 * the App, the installer and the bridge alike. `untested` says why it is marked so on the 接入 page (none of these was
 * run on a real install: each is written from its docs and source); `installNote`, what the reader still does in it.
 */
export interface CatalogClient {
  client: CustomClient;
  untested: string;
  installNote?: string;
}

const UNTESTED = "按官方文档和源码接入，还没在真实环境里跑过；装好后请做一次选择，看「最近一次记录」是否出现。";

/** The catalog, in the order the 接入 page lists it. Checked against customClientSchema in its tests. */
export const CLIENT_CATALOG: readonly CatalogClient[] = [
  {
    // QwenLM/qwen-code docs/users/features/hooks.md; packages/core/src/hooks/types.ts. UserPromptSubmit also fires on a
    // tool result's and a hook's sends, `prompt` then not the reader's: `submitted_prompt` alone is what they typed, and
    // none is no prompt ("treat absence as unavailable rather than falling back to prompt").
    client: {
      id: "qwen-code",
      name: "Qwen Code",
      shortName: "QW",
      command: "qwen",
      hooks: { file: "~/.qwen/settings.json", format: "claude" },
      prompt: { event: "UserPromptSubmit", field: "submitted_prompt" },
      reply: { event: "Stop", source: "field", field: "last_assistant_message" },
      fields: { sessionId: "session_id", cwd: "cwd", turnId: "prompt_id" },
      mcp: { mode: "file", file: "~/.qwen/settings.json" },
    },
    untested: UNTESTED,
  },
  {
    // docs.qoder.com/cli/hooks: Stop's `last_assistant_message`, which its SDK's StopHookInput does not list; 1.1.80's
    // bundle (fireStopEventWithContext) always sends it.
    client: {
      id: "qoder",
      name: "Qoder CLI",
      shortName: "QD",
      command: "qodercli",
      hooks: { file: "~/.qoder/settings.json", format: "claude" },
      prompt: { event: "UserPromptSubmit", field: "prompt" },
      reply: { event: "Stop", source: "field", field: "last_assistant_message" },
      fields: { sessionId: "session_id", cwd: "cwd" },
      mcp: { mode: "file", file: "~/.qoder/settings.json" },
    },
    untested: UNTESTED,
  },
  {
    // docs.qoder.cn/cli: the same CLI under its own name and folder.
    client: {
      id: "qoder-cn",
      name: "Qoder CLI（国内版）",
      shortName: "QC",
      command: "qodercn",
      hooks: { file: "~/.qoder-cn/settings.json", format: "claude" },
      prompt: { event: "UserPromptSubmit", field: "prompt" },
      reply: { event: "Stop", source: "field", field: "last_assistant_message" },
      fields: { sessionId: "session_id", cwd: "cwd" },
      mcp: { mode: "file", file: "~/.qoder-cn/settings.json" },
    },
    untested: UNTESTED,
  },
  {
    // docs.augmentcode.com/cli/hooks: Stop carries the turn's prompt and reply only with includeConversationData set on
    // its group (0.36.0's augment.mjs reads it there alone); its timeout is in milliseconds. 0.36.0 sends no `cwd`:
    // the first of `workspace_roots`, which both lines send.
    client: {
      id: "auggie",
      name: "Augment Auggie",
      shortName: "AU",
      command: "auggie",
      hooks: {
        file: "~/.augment/settings.json",
        format: "claude",
        group: { metadata: { includeConversationData: true } },
        // 0.36.0's augment.mjs (dao) runs a command with no shell character in it split on spaces, its first word the
        // program: `PARASELF_HOOK=1 '<bridge>' …` was not run at all. With `args` it runs the command as it is.
        invocation: "argv",
        timeout: { field: "timeout", value: 5_000 },
      },
      prompt: { event: "Stop", field: "conversation.userPrompt" },
      reply: { event: "Stop", source: "field", field: "conversation.agentTextResponse" },
      fields: { sessionId: "conversation_id", cwd: "workspace_roots" },
      complete: { field: "agent_stop_cause", values: ["end_turn"] },
      mcp: { mode: "file", file: "~/.augment/settings.json" },
    },
    untested: UNTESTED,
  },
  {
    // google-gemini/gemini-cli docs/hooks/reference.md: AfterAgent holds the turn's prompt and its reply (each text of
    // the turn's, joined); its timeout is in milliseconds. One a Stop hook made run again (`stop_hook_active`) is no new
    // turn. Antigravity keeps its own hooks in ~/.gemini/config/hooks.json.
    client: {
      id: "gemini-cli",
      name: "Gemini CLI",
      shortName: "GM",
      command: "gemini",
      hooks: { file: "~/.gemini/settings.json", format: "claude", timeout: { field: "timeout", value: 5_000 } },
      prompt: { event: "AfterAgent", field: "prompt" },
      reply: { event: "AfterAgent", source: "field", field: "prompt_response" },
      fields: { sessionId: "session_id", cwd: "cwd" },
      complete: { field: "stop_hook_active", values: ["false"] },
      mcp: { mode: "file", file: "~/.gemini/settings.json" },
    },
    untested: UNTESTED,
    // hookRegistry.ts skips every hook, the user's too, in a folder not trusted; folderTrust is on by default.
    installNote: "Gemini CLI 只在信任过的文件夹里运行钩子，在新文件夹里打开时请选择信任；它现在只面向 Gemini Code Assist 企业用户，个人账号请用 Antigravity",
  },
  {
    // cursor.com/docs/hooks: a flat hooks.json; the reply comes in afterAgentResponse, each of a turn's messages in turn,
    // the last one kept. Looked for as cursor-agent: `agent`, its newer name, is also Grok Build's.
    client: {
      id: "cursor",
      name: "Cursor CLI",
      shortName: "CU",
      command: "cursor-agent",
      hooks: { file: "~/.cursor/hooks.json", format: "flat" },
      prompt: { event: "beforeSubmitPrompt", field: "prompt" },
      reply: { event: "afterAgentResponse", source: "field", field: "text" },
      fields: { sessionId: "conversation_id", cwd: "workspace_roots", turnId: "generation_id" },
      // Its docs' field table has `type` required for a stdio server, though their example leaves it out.
      mcp: { mode: "file", file: "~/.cursor/mcp.json", entry: { type: "stdio" } },
    },
    untested: UNTESTED,
  },
  {
    // docs.github.com copilot-cli hooks reference: a file of its own in ~/.copilot/hooks, a handler's `command` its
    // cross-platform field; Stop holds no reply, which is read off its events.jsonl (the transcript_path, @github/copilot
    // 1.0.62's app.js). It reads no hooks of ~/.claude's.
    client: {
      id: "copilot",
      name: "GitHub Copilot CLI",
      shortName: "CP",
      command: "copilot",
      hooks: { file: "~/.copilot/hooks/paraself.json", format: "flat-owned", timeout: { field: "timeoutSec", value: 5 } },
      prompt: { event: "UserPromptSubmit", field: "prompt" },
      reply: { event: "Stop", source: "transcript", format: "copilot", field: "transcript_path" },
      fields: { sessionId: "session_id", cwd: "cwd" },
      complete: { field: "stop_reason", values: ["end_turn"] },
      mcp: { mode: "file", file: "~/.copilot/mcp-config.json", entry: { type: "local", tools: ["*"] } },
    },
    untested: UNTESTED,
  },
  {
    // cnb.cool/codebuddy/codebuddy-code docs/hooks.md: Stop holds no reply, read off its transcript (Responses-style lines,
    // as 2.177.1's dist/codebuddy.js writes them). That bundle's Stop also sends an undocumented `last_assistant_message`,
    // read first where it is there.
    client: {
      id: "codebuddy",
      name: "CodeBuddy Code",
      shortName: "CB",
      command: "codebuddy",
      hooks: { file: "~/.codebuddy/settings.json", format: "claude" },
      prompt: { event: "UserPromptSubmit", field: "prompt" },
      reply: { event: "Stop", source: "transcript", format: "codebuddy", field: "transcript_path" },
      fields: { sessionId: "session_id", cwd: "cwd", turnId: "generation_id" },
      // docs/mcp.md: the first of these there is the one read and written, the others not at all.
      mcp: { mode: "file", file: "~/.codebuddy/.mcp.json", olderFiles: ["~/.codebuddy/mcp.json", "~/.codebuddy.json"] },
    },
    untested: UNTESTED,
  },
  {
    // docs.factory.ai hooks reference: Stop holds no reply, read off its transcript. Written to settings.json's `hooks`,
    // merged among the reader's settings: "If hooks.json is absent, Droid also reads hook declarations from the hooks
    // key in settings.json", so with a hooks.json there it is not connected, and says so.
    client: {
      id: "droid",
      name: "Factory Droid",
      shortName: "DR",
      command: "droid",
      hooks: { file: "~/.factory/settings.json", format: "claude", shadowedBy: "~/.factory/hooks.json" },
      prompt: { event: "UserPromptSubmit", field: "prompt" },
      reply: { event: "Stop", source: "transcript", format: "droid", field: "transcript_path" },
      fields: { sessionId: "session_id", cwd: "cwd" },
      mcp: { mode: "file", file: "~/.factory/mcp.json" },
    },
    untested: UNTESTED,
    installNote: "Droid 在启动时读取钩子，外部改动后要在它的 /hooks 里确认一次",
  },
];
