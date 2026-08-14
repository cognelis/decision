export const DECISION_HOOK_MARKER = "DECISION_HOOK=";
const LEGACY_HOOK_MARKER = "DECISION_ISLAND_HOOK=";
const CURRENT_HOOK_MARKER = `${DECISION_HOOK_MARKER}1`;

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
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\"'\"'`)}'`;

const parseHandler = (value: unknown, path: string): HookHandler => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} contains an invalid hook handler`);
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
    throw new Error(`${path} contains an invalid hook group`);
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
    throw new Error("hooks must be an object");
  }
  return Object.fromEntries(
    Object.entries(value).map(([event, groups]) => {
      if (!Array.isArray(groups)) {
        throw new Error(`hooks.${event} must be an array`);
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

const withoutDecisionHooks = (groups: HookGroup[]): HookGroup[] =>
  groups.flatMap((group) => {
    const hooks = group.hooks.filter(
      (handler) =>
        typeof handler.command !== "string" ||
        !handler.command.includes(DECISION_HOOK_MARKER) &&
        !handler.command.includes(LEGACY_HOOK_MARKER),
    );
    return hooks.length === 0 ? [] : [{ ...group, hooks }];
  });

export type HookClient = "claude-code" | "codex";

export const mergeHookDocument = (
  input: unknown,
  bridgePath: string,
  client: HookClient,
): HookConfigDocument => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("settings must be a JSON object");
  }
  const document = structuredClone(input) as Record<string, unknown>;
  const parsedEvents = parseEvents(document.hooks);
  const events: Record<string, HookGroup[]> = Object.fromEntries(
    Object.entries(parsedEvents).map(([event, groups]) => [
      event,
      withoutDecisionHooks(groups),
    ]),
  );
  const handler = (
    operation: "post-tool-use" | "stop" | "user-prompt-submit",
  ): HookHandler => ({
    type: "command",
    command:
      `${CURRENT_HOOK_MARKER} ${shellQuote(bridgePath)} ` +
      `hook ${operation} ${client}`,
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
