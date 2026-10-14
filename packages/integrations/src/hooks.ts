export const DECISION_HOOK_MARKER = "DECISION_HOOK=";

/**
 * What marks a hook as this app's, in the form it writes now. On Windows that is `=2`: the `=1` hooks there
 * were cmd's own syntax, which Claude Code (it runs hooks in Git Bash or PowerShell) never ran.
 */
export const currentHookMarker = (platform: NodeJS.Platform): string =>
  `${DECISION_HOOK_MARKER}${platform === "win32" ? 2 : 1}`;

/** A hook handler's whole command line: its command and, run without a shell, its arguments. */
export const hookCommandLine = (handler: { command?: unknown; args?: unknown }): string | null =>
  typeof handler.command !== "string"
    ? null
    : [handler.command, ...(Array.isArray(handler.args) ? handler.args.filter((arg) => typeof arg === "string") : [])].join(" ");

export interface HookHandler {
  [key: string]: unknown;
  type?: unknown;
  command?: unknown;
  timeout?: number;
  statusMessage?: string;
}

export interface HookGroup {
  [key: string]: unknown;
  matcher?: string;
  hooks: HookHandler[];
}

export interface HookEvents {
  [event: string]: HookGroup[];
}

export interface HookConfigDocument {
  [key: string]: unknown;
  hooks: HookEvents;
}

export interface CommandSpec {
  command: string;
  args: string[];
  tolerateFailure: boolean;
  absentMcpName?: string;
  /** A look at the server before it is removed: one that is not this app's bridge for this client is left alone. */
  expectsBridgeFor?: HookClient;
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\"'\"'`)}'`;

// Read as their own by cmd or by PowerShell, in a path one hook line hands to either (Codex runs it in
// PowerShell, or in cmd when it has no shell): refused rather than escaped for both at once.
const windowsBridgePath = (value: string): string => {
  if (/["%$`^&|<>\0\r\n]/u.test(value)) {
    throw new Error(
      "Decision 所在的路径里有命令行会另作解释的字符（\" % $ ` ^ & | < > 或换行），请把它装到路径里没有这些字符的文件夹再试",
    );
  }
  return value;
};

/** How a hook names the bridge it runs: status detection looks for it to tell a current hook from a stale one. */
export const hookBridgeReference = (bridgePath: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? windowsBridgePath(bridgePath) : shellQuote(bridgePath);

type HookOperation = "post-tool-use" | "stop" | "user-prompt-submit";

/**
 * How a client runs this app's hook. On Windows the bridge is a .cmd, which takes cmd to run: Claude Code
 * runs it without a shell (`args`; its own shells are Git Bash and PowerShell, which cmd's syntax failed in),
 * and Codex hands one line to PowerShell, or to cmd when it has no shell, so that line reads alike in both.
 * The marker goes last there, an argument the bridge leaves alone.
 */
const hookInvocation = (
  bridgePath: string,
  operation: HookOperation,
  client: HookClient,
  platform: NodeJS.Platform,
): { command: string; args?: string[] } => {
  const marker = currentHookMarker(platform);
  const bridge = hookBridgeReference(bridgePath, platform);
  if (platform !== "win32") return { command: `${marker} ${bridge} hook ${operation} ${client}` };
  return client === "claude-code"
    ? { command: "cmd.exe", args: ["/d", "/v:off", "/c", "call", bridge, "hook", operation, client, marker] }
    : { command: `cmd /d /v:off /c call "${bridge}" hook ${operation} ${client} ${marker}` };
};

const parseHandler = (value: unknown, path: string): HookHandler => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} 里有一项不是有效的 hook 处理器`);
  }
  return structuredClone(value) as HookHandler;
};

const parseGroup = (value: unknown, path: string): HookGroup => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("hooks" in value) ||
    !Array.isArray(value.hooks)
  ) {
    throw new Error(`${path} 里有一项不是有效的 hook 分组`);
  }
  return {
    ...structuredClone(value),
    hooks: value.hooks.map((handler, index) =>
      parseHandler(handler, `${path}.hooks[${index}]`),
    ),
  };
};

const parseEvents = (value: unknown): Record<string, HookGroup[]> => {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("其中的 hooks 应当是一个对象");
  }
  return Object.fromEntries(
    Object.entries(value).map(([event, groups]) => {
      if (!Array.isArray(groups)) {
        throw new Error(`其中的 hooks.${event} 应当是一个数组`);
      }
      return [
        event,
        groups.map((group, index) =>
          parseGroup(group, `hooks.${event}[${index}]`),
        ),
      ];
    }),
  );
};

/**
 * A hook of this app's, in any form it ever wrote: its marker as a word of its own (bare, or quoted by an older
 * Windows `set "DECISION_HOOK=1"`) and the bridge's `hook <operation> <client>`. Matched as text anywhere in the
 * line, a reader's own `SKIP_DECISION_HOOK=1 ~/bin/notify-done.sh` was taken for one and removed at each connect.
 */
const isDecisionHook = (handler: HookHandler): boolean => {
  const line = hookCommandLine(handler);
  return (
    line !== null &&
    /(?:^|[\s"'])DECISION_HOOK=\d+(?=[\s"']|$)/u.test(line) &&
    /\bhook (?:post-tool-use|stop|user-prompt-submit) (?:claude-code|codex)\b/u.test(line)
  );
};

const withoutDecisionHooks = (groups: HookGroup[]): HookGroup[] =>
  groups.flatMap((group) => {
    const hooks = group.hooks.filter((handler) => !isDecisionHook(handler));
    // A group this app's hooks alone filled goes with them; one the reader left empty is the reader's, and stays.
    return hooks.length === 0 && group.hooks.length > 0 ? [] : [{ ...group, hooks }];
  });

export type HookClient = "claude-code" | "codex";

const cloneDocument = (input: unknown): Record<string, unknown> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("整个文件应当是一个 JSON 对象，以 { 开头");
  }
  return structuredClone(input) as Record<string, unknown>;
};

/** The document without this app's hooks: the reader's own stay, and an event left with none of them goes. */
export const removeHookDocument = (input: unknown): Record<string, unknown> => {
  const document = cloneDocument(input);
  if (document.hooks === undefined) return document;
  return {
    ...document,
    hooks: Object.fromEntries(
      Object.entries(parseEvents(document.hooks)).flatMap(([event, groups]) => {
        const kept = withoutDecisionHooks(groups);
        return kept.length === 0 && groups.length > 0 ? [] : [[event, kept]];
      }),
    ),
  };
};

export const mergeHookDocument = (
  input: unknown,
  bridgePath: string,
  client: HookClient,
  platform: NodeJS.Platform = process.platform,
): HookConfigDocument => {
  const document = cloneDocument(input);
  const parsedEvents = parseEvents(document.hooks);
  const events: Record<string, HookGroup[]> = Object.fromEntries(
    Object.entries(parsedEvents).map(([event, groups]) => [
      event,
      withoutDecisionHooks(groups),
    ]),
  );
  const handler = (operation: HookOperation): HookHandler => ({
    type: "command",
    ...hookInvocation(bridgePath, operation, client, platform),
    timeout: 5,
  });
  events.PostToolUse = [
    ...(events.PostToolUse ?? []),
    {
      matcher:
        client === "claude-code"
          ? "^AskUserQuestion$"
          : "^(request_user_input|AskUserQuestion)$",
      hooks: [handler("post-tool-use")],
    },
  ];
  events.Stop = [
    ...(events.Stop ?? []),
    {
      hooks: [handler("stop")],
    },
  ];
  events.UserPromptSubmit = [
    ...(events.UserPromptSubmit ?? []),
    {
      hooks: [handler("user-prompt-submit")],
    },
  ];

  return {
    ...document,
    hooks: events as HookEvents,
  };
};
