import { homedir } from "node:os";
import { join } from "node:path";

/** `probe`: a 接入新工具 probe's, recording what the client sends on that event (`hook probe <probe id> <event>`). */
export type HookOperation = "post-tool-use" | "stop" | "user-prompt-submit" | "probe";

/** One of the client's hook events this app listens on, and the bridge operation its handler runs. */
export interface ClientHookEvent {
  event: string;
  operation: HookOperation;
  matcher?: string;
}

/**
 * Where the hook input names what the bridge reads, in the client's own words. Each defaults to Claude Code's name;
 * a list field (Antigravity's `workspacePaths`) gives its first item.
 */
export interface ClientCaptureFields {
  sessionId?: string;
  cwd?: string;
  prompt?: string;
  reply?: string;
  transcript?: string;
  turnId?: string;
  promptId?: string;
}

/**
 * A client, as data: what the App and the bridge need to connect it, read it and take it out again. The four built in
 * are written this way, and one a reader adds is to be too.
 */
export interface ClientDescriptor {
  id: string;
  name: string;
  /** Two letters for its badge. */
  shortName: string;
  /** The command the reader runs it by, and its MCP commands run through; a client added without one has none to look for. */
  command?: string;
  /** Where it keeps its configuration: `env` moves it, else `home` under the reader's home folder. */
  configDir: { env?: string; home: string };
  hooks: {
    /** Under configDir. */
    file: string;
    /**
     * `claude`: `{ hooks: { <event>: [{ matcher?, hooks: [handler] }] } }`, this app's handlers among others'.
     * `antigravity`: `{ <hook name>: { <event>: [handler] } }`, this app's under `paraself`.
     * `flat`: `{ version: 1, hooks: { <event>: [handler] } }`, a handler with no group around it (Cursor's, Copilot's).
     */
    format: "claude" | "antigravity" | "flat";
    /** The whole file is this app's (Grok reads every file in its hooks folder): one not its own is left alone. */
    ownsFile?: boolean;
    /** Each command names its operation, for a client whose input does not name its event. */
    events: ClientHookEvent[];
    /** Fields each group of this app's carries beside its handlers (`claude` format): Auggie's `metadata`. */
    group?: Record<string, unknown>;
    /**
     * `argv`: the handler names the bridge in `command` and the rest in `args`, no shell and no variable before it, the
     * marker last (Auggie 0.x runs a command with no shell character in it split on spaces, its first word the program).
     * Left out: one command line, as the built-in clients' are.
     */
    invocation?: "argv";
    /** A file (`~/…`) whose being there makes the client read no hooks from this one: then not connected, said why. */
    shadowedBy?: string;
    /** The handler's time limit, in the client's own field and unit; `timeout: 5` (seconds) unless said. */
    timeout?: { field: string; value: number };
  };
  capture: {
    fields?: ClientCaptureFields;
    /** How its transcript's lines are read, where the input holds no reply. */
    transcript?: "claude-codex" | "antigravity" | "copilot" | "codebuddy" | "droid";
    /**
     * The turn's prompt and its reply come in one event (Auggie's Stop, Gemini CLI's AfterAgent): its one handler, the
     * `stop` operation, reads the prompt first (the answer to the turn before's question) and then the reply. Two
     * handlers on that event ran in whatever order the client chose, and a reply saved first was paired with its own prompt.
     */
    promptInStop?: true;
    /** A turn's end it records only for these reasons: the others (a session closing, a cancel) are not a reply. */
    stopReason?: { field: string; complete: string[] };
    /**
     * A prompt it reads only at a turn's start, for a client that sends it on every model call: where this field holds
     * one of these, or (`orTranscriptTurnStart`) where its transcript's last step is still the reader's message.
     */
    promptOnly?: { field: string; values: (string | number)[]; orTranscriptTurnStart?: boolean };
    /**
     * A turn that ended of itself with no reply it can read drops the reply waiting from the turn before: for a client
     * whose prompt may not be read either, so the answer that consumed it can go unseen and a later one take it.
     */
    dropPendingWithoutReply?: boolean;
    /** What the client wraps the reader's message in: the text inside `keep`, else the message without `drop`. */
    promptEnvelope?: { keep: string; drop: string[] };
    /** The structured question tool its PostToolUse hook reads, by the adapter written for it. */
    postToolUse?: "claude-code" | "codex";
  };
  /**
   * Left out: no MCP server registered with it (a client added on the 接入 page may say so). `file`: written into its own
   * MCP configuration (`~/…`), `mcpServers.paraself`, with `entry`'s fields beside the command; else by its own commands.
   */
  mcp?: McpByFile | McpByCommand;
  /** What the reader is still to do in the client once connected. */
  installNote?: string;
}

export interface McpByFile {
  file: string;
  entry?: Record<string, unknown>;
  /** Files (`~/…`) the client reads its servers from only while `file` is absent: with one there, none is written. */
  olderFiles?: string[];
}

export interface McpByCommand {
  /**
   * Shows the server of this app's name, in one of the forms it is read in: `get` shows it alone (and, not there,
   * says so in words the installer knows); `json`, every server as `[{ name, command, args }]`; `table`, every server a
   * row under `header` (`NAME TYPE STATUS COMMAND/URL`), or `none` alone. A listing that failed or is in any other form
   * changes nothing of the client's: it cannot say whether a server of the reader's own by that name is there.
   */
  inspect:
    | { args: string[]; output: "get" }
    | { args: string[]; output: "json" }
    | { args: string[]; output: "table"; header: string[]; none: string };
  remove: string[];
  /**
   * `{bridge}` is the bridge's own argument(s); `{client}`, the client's id; `{name}`, the server's name (`paraself`, or
   * `decision` where the one Decision registered is looked at or taken out). A template of the reader's, written before
   * the rename, names it `decision` outright: read as `{name}`.
   */
  add: string[];
}

export const mcpByFile = (mcp: ClientDescriptor["mcp"]): mcp is McpByFile => mcp !== undefined && "file" in mcp;

const CLAUDE_CODE: ClientDescriptor = {
  id: "claude-code",
  name: "Claude Code",
  shortName: "CC",
  command: "claude",
  configDir: { env: "CLAUDE_CONFIG_DIR", home: ".claude" },
  hooks: {
    file: "settings.json",
    format: "claude",
    events: [
      { event: "PostToolUse", operation: "post-tool-use", matcher: "^AskUserQuestion$" },
      { event: "Stop", operation: "stop" },
      { event: "UserPromptSubmit", operation: "user-prompt-submit" },
    ],
  },
  capture: { transcript: "claude-codex", postToolUse: "claude-code" },
  mcp: {
    inspect: { args: ["mcp", "get", "{name}"], output: "get" },
    remove: ["mcp", "remove", "--scope", "user", "{name}"],
    add: ["mcp", "add", "--scope", "user", "{name}", "--", "{bridge}", "mcp", "{client}"],
  },
};

const CODEX: ClientDescriptor = {
  id: "codex",
  name: "Codex",
  shortName: "CX",
  command: "codex",
  configDir: { env: "CODEX_HOME", home: ".codex" },
  hooks: {
    file: "hooks.json",
    format: "claude",
    events: [
      { event: "PostToolUse", operation: "post-tool-use", matcher: "^(request_user_input|AskUserQuestion)$" },
      { event: "Stop", operation: "stop" },
      { event: "UserPromptSubmit", operation: "user-prompt-submit" },
    ],
  },
  capture: { transcript: "claude-codex", postToolUse: "codex" },
  mcp: {
    inspect: { args: ["mcp", "get", "{name}"], output: "get" },
    remove: ["mcp", "remove", "{name}"],
    add: ["mcp", "add", "{name}", "--", "{bridge}", "mcp", "{client}"],
  },
  // Codex holds a hook new or changed to it until the reader trusts it there: connected, it ran none.
  installNote: "Codex 只运行你信任过的 hook：打开 Codex 时若提示 Hooks need review，确认信任后才会开始自动记录",
};

// Grok sends Claude Code's snake_case names beside its own, the turn's reply among them, and no turn id: its
// promptId is the same in a turn's prompt and its Stop (CL1-LAB's samples). Its question tool, ask_user_question,
// is left for later.
const GROK: ClientDescriptor = {
  id: "grok",
  name: "Grok",
  shortName: "GK",
  command: "grok",
  configDir: { env: "GROK_HOME", home: ".grok" },
  hooks: {
    file: join("hooks", "paraself.json"),
    format: "claude",
    ownsFile: true,
    events: [
      { event: "Stop", operation: "stop" },
      { event: "UserPromptSubmit", operation: "user-prompt-submit" },
    ],
  },
  capture: {
    fields: { turnId: "promptId" },
    // A session's end fires Stop once more (`shutdown`, `channel_closed`), with no reply in it.
    stopReason: { field: "reason", complete: ["end_turn"] },
  },
  mcp: {
    // `--json`: grok 1.0.70's machine-readable listing, `[{ command, args, enabled, name, scope }]`.
    inspect: { args: ["mcp", "list", "--json"], output: "json" },
    remove: ["mcp", "remove", "{name}"],
    add: ["mcp", "add", "-s", "user", "{name}", "--", "{bridge}", "mcp", "{client}"],
  },
};

// Antigravity's input names no event and holds no reply: the operation is in the command, and the reply is read off
// its transcript. Every model call fires PreInvocation, the first of a turn with the reader's new message. Not tried on
// a real agy (CL1): written from antigravity.google/docs/hooks, agy 1.4.8's own hooks guide, and claude-mem's adapter
// (thedotmack/claude-mem, src/cli/adapters/antigravity-cli.ts, src/shared/transcript-parser.ts; issues #4057, #5078).
const ANTIGRAVITY: ClientDescriptor = {
  id: "antigravity",
  name: "Antigravity",
  shortName: "AG",
  command: "agy",
  configDir: { home: join(".gemini", "config") },
  hooks: {
    file: "hooks.json",
    format: "antigravity",
    events: [
      { event: "Stop", operation: "stop" },
      { event: "PreInvocation", operation: "user-prompt-submit" },
    ],
  },
  capture: {
    fields: {
      sessionId: "conversationId",
      cwd: "workspacePaths",
      prompt: "lastUserInput",
      transcript: "transcriptPath",
    },
    transcript: "antigravity",
    // agy 1.4.8's guide names a turn that ended of itself NO_TOOL_CALL; the web docs' example, model_stop.
    stopReason: { field: "terminationReason", complete: ["NO_TOOL_CALL", "model_stop"] },
    // "The first invocation is 0" (the web docs); not said whether per turn or per conversation, so a transcript whose
    // last step is the reader's message also starts a turn, as claude-mem reads it.
    promptOnly: { field: "invocationNum", values: [0], orTranscriptTurnStart: true },
    promptEnvelope: { keep: "USER_REQUEST", drop: ["ADDITIONAL_METADATA", "USER_SETTINGS_CHANGE"] },
    // Its message may be empty in the hook and in a form not known in the transcript: the turn's prompt then consumed
    // nothing, and the answer after its unread reply was paired with the turn before's (CL1-REVIEW-2).
    dropPendingWithoutReply: true,
  },
  mcp: {
    // agy 1.4.8 has no machine-readable listing: its table, as it prints it.
    inspect: { args: ["mcp", "list"], output: "table", header: ["NAME", "TYPE", "STATUS", "COMMAND/URL"], none: "No MCP servers configured." },
    remove: ["mcp", "remove", "{name}"],
    add: ["mcp", "add", "{name}", "--", "{bridge}", "mcp", "{client}"],
  },
  installNote: "Antigravity 的桌面 App、IDE 和 agy 共用这份钩子，三处的对话都会记录",
};

export const BUILT_IN_CLIENTS: readonly ClientDescriptor[] = [CLAUDE_CODE, CODEX, GROK, ANTIGRAVITY];

export const clientById = (
  id: string | undefined,
  clients: readonly ClientDescriptor[] = BUILT_IN_CLIENTS,
): ClientDescriptor | undefined => clients.find((client) => client.id === id);

/** The client's hook file, where its configuration folder is now: `env` read as the reader's shell sets it. */
export const clientHookPath = (
  client: ClientDescriptor,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string =>
  join(
    (client.configDir.env === undefined ? undefined : environment[client.configDir.env]) || join(home, client.configDir.home),
    client.hooks.file,
  );

/** Every client's hook file, by id. */
export const clientHookPaths = (
  clients: readonly ClientDescriptor[] = BUILT_IN_CLIENTS,
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Record<string, string> =>
  Object.fromEntries(clients.map((client) => [client.id, clientHookPath(client, environment, home)]));

/** What the renderer is told of each client. */
export interface ClientSummary {
  id: string;
  name: string;
  shortName: string;
  command?: string;
  /** Added by the reader on the 接入 page: theirs to edit and delete. */
  custom?: true;
  /** Registers no MCP server: its turns are recorded, and no check before a choice is made. */
  mcp?: false;
  /** Why one the reader added is not connected (it did not pass the checks a save makes, read back at start). */
  problem?: string;
  /** What changed of one the reader added as it was read back. */
  notice?: string;
  /** One of the reader's that a tool Paraself now ships under the same id or file takes the place of. */
  superseded?: true;
  /** Written from its docs and source, not run on a real install: why, for the 接入 page's 未实测 mark. */
  untested?: string;
  /** A file (`~/…`) whose being there makes the client read none of this app's hooks: said when it is. */
  shadowedBy?: string;
}

export const clientSummary = ({ id, name, shortName, command, mcp, hooks }: ClientDescriptor): ClientSummary => ({
  id,
  name,
  shortName,
  ...(command === undefined ? {} : { command }),
  ...(hooks.shadowedBy === undefined ? {} : { shadowedBy: hooks.shadowedBy }),
  ...(mcp === undefined ? { mcp: false as const } : {}),
});
