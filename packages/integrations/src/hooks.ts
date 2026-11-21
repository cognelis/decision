import { basename, dirname, join } from "node:path";

import { BUILT_IN_CLIENTS, clientById, type ClientDescriptor, type HookOperation, type McpByCommand } from "./clients.js";

export const PARASELF_HOOK_MARKER = "PARASELF_HOOK=";

/**
 * What marks a hook as this app's, in the form it writes now. On Windows that is `=2`: the `=1` hooks there
 * were cmd's own syntax, which Claude Code (it runs hooks in Git Bash or PowerShell) never ran.
 */
export const currentHookMarker = (platform: NodeJS.Platform): string =>
  `${PARASELF_HOOK_MARKER}${platform === "win32" ? 2 : 1}`;

/**
 * Whether a hook's command line carries this app's marker, as a word of its own (bare, or quoted by an older Windows
 * `set "DECISION_HOOK=1"`): `PARASELF_HOOK=`, or `DECISION_HOOK=` as it was written as Decision, still this app's to
 * replace at a connect and to take out at a disconnect. A reader's own `SKIP_DECISION_HOOK=1 ~/bin/notify-done.sh`,
 * the marker matched as text anywhere in the line, was taken for one and removed at each connect.
 */
export const hasHookMarker = (line: string): boolean =>
  /(?:^|[\s"'])(?:PARASELF|DECISION)_HOOK=\d+(?=[\s"']|$)/u.test(line);

/**
 * The file a client's own hooks file (`ownsFile`, named paraself.json) had as Decision's, beside it: the client runs
 * every file in that folder (Grok's hooks/, Copilot's), so this app's hooks left there ran twice. Read as this app's,
 * and taken away at a connect or a disconnect where it holds nothing else; never written.
 */
export const legacyHookFile = (client: ClientDescriptor, path: string): string | null =>
  client.hooks.ownsFile === true && basename(path) === "paraself.json" ? join(dirname(path), "decision.json") : null;

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
  /** The server it looks at or takes out, by name: the client saying none goes by that name is no failure. */
  absentMcpName?: string;
  /** A look at the server before it is removed: one that is not this app's bridge for this client is left alone. */
  expectsBridgeFor?: HookClient;
  /** How it shows the server, as the registry's `mcp.inspect` says; left out, alone (`get`). */
  shows?: McpByCommand["inspect"];
  /**
   * A step taking out the server Decision registered (`decision`): one not seen to be this app's is left, said in the
   * client's result, and the rest goes on; none there, its removal is not run.
   */
  legacy?: true;
}

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\"'\"'`)}'`;

// Read as their own by cmd or by PowerShell, in a path one hook line hands to either (Codex runs it in
// PowerShell, or in cmd when it has no shell): refused rather than escaped for both at once.
const windowsBridgePath = (value: string): string => {
  if (/["%$`^&|<>\0\r\n]/u.test(value)) {
    throw new Error(
      "Paraself 所在的路径里有命令行会另作解释的字符（\" % $ ` ^ & | < > 或换行），请把它装到路径里没有这些字符的文件夹再试",
    );
  }
  return value;
};

/** How a hook names the bridge it runs: status detection looks for it to tell a current hook from a stale one. */
export const hookBridgeReference = (bridgePath: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? windowsBridgePath(bridgePath) : shellQuote(bridgePath);

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
  argv = false,
  event?: string,
): { command: string; args?: string[] } => {
  const marker = currentHookMarker(platform);
  const bridge = hookBridgeReference(bridgePath, platform);
  // A probe's names its event too: the client's input may not. Event names are letters, digits and `_.-` alone.
  const target = operation === "probe" && event !== undefined ? [client, event] : [client];
  const words = target.join(" ");
  // Run with no shell (`argv`): the bridge and its arguments apart, no variable before it, the marker last.
  if (platform !== "win32") return argv ? { command: bridgePath, args: ["hook", operation, ...target, marker] } : { command: `${marker} ${bridge} hook ${operation} ${words}` };
  return client === "claude-code" || argv
    ? { command: "cmd.exe", args: ["/d", "/v:off", "/c", "call", bridge, "hook", operation, ...target, marker] }
    : { command: `cmd /d /v:off /c call "${bridge}" hook ${operation} ${words} ${marker}` };
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

/** A hook of this app's, in any form it ever wrote: its marker (hasHookMarker) and the bridge's `hook <operation> <client>`. */
const isOwnHook = (handler: HookHandler): boolean => {
  const line = hookCommandLine(handler);
  return (
    line !== null &&
    hasHookMarker(line) &&
    /\bhook (?:post-tool-use|stop|user-prompt-submit|probe) [a-z][a-z0-9-]{1,39}\b/u.test(line)
  );
};

const withoutOwnHooks = (groups: HookGroup[]): HookGroup[] =>
  groups.flatMap((group) => {
    const hooks = group.hooks.filter((handler) => !isOwnHook(handler));
    // A group this app's hooks alone filled goes with them; one the reader left empty is the reader's, and stays.
    return hooks.length === 0 && group.hooks.length > 0 ? [] : [{ ...group, hooks }];
  });

/** A client's id, as the registry names it. */
export type HookClient = string;

const descriptorOf = (client: HookClient | ClientDescriptor): ClientDescriptor => {
  if (typeof client !== "string") return client;
  const found = clientById(client, BUILT_IN_CLIENTS);
  if (found === undefined) throw new Error(`没有名为 ${client} 的客户端`);
  return found;
};

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
        const kept = withoutOwnHooks(groups);
        return kept.length === 0 && groups.length > 0 ? [] : [[event, kept]];
      }),
    ),
  };
};

export const mergeHookDocument = (
  input: unknown,
  bridgePath: string,
  client: HookClient | ClientDescriptor,
  platform: NodeJS.Platform = process.platform,
): HookConfigDocument => {
  const descriptor = descriptorOf(client);
  const document = cloneDocument(input);
  const parsedEvents = parseEvents(document.hooks);
  const events: Record<string, HookGroup[]> = Object.fromEntries(
    Object.entries(parsedEvents).map(([event, groups]) => [
      event,
      withoutOwnHooks(groups),
    ]),
  );
  if (descriptor.hooks.ownsFile === true && (Object.values(events).some((groups) => groups.length > 0) || Object.keys(document).some((key) => key !== "hooks"))) {
    throw new Error("这个文件里有不是本应用写入的内容，没有改动它；如果不再需要，先自行删除或改名再试");
  }
  for (const { event, operation, matcher } of descriptor.hooks.events) {
    events[event] = [
      ...(events[event] ?? []),
      {
        ...structuredClone(descriptor.hooks.group ?? {}),
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [handlerFor(bridgePath, operation, descriptor, platform, event)],
      },
    ];
  }

  return {
    ...document,
    hooks: events as HookEvents,
  };
};

const handlerFor = (bridgePath: string, operation: HookOperation, client: ClientDescriptor, platform: NodeJS.Platform, event: string): HookHandler => {
  const timeout = client.hooks.timeout ?? { field: "timeout", value: 5 };
  const argv = client.hooks.invocation === "argv";
  // A client that splits its command on spaces (Auggie 0.x, which hands `cmd.exe /c` the bridge unquoted on Windows) runs
  // a bridge whose path has one as two words: not written, and said why.
  if (argv && /\s/u.test(bridgePath)) {
    throw new Error(`${client.name} 会把钩子命令按空格拆开，Paraself 所在的路径里有空格（${bridgePath}），这样接入后钩子运行不了；请把 Paraself 装到路径里没有空格的文件夹再试`);
  }
  return { type: "command", ...hookInvocation(bridgePath, operation, client.id, platform, argv, event), [timeout.field]: timeout.value };
};

/** A flat hooks file's events: each a list of handlers, no group around them. */
const parseFlatEvents = (value: unknown): Record<string, HookHandler[]> => {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("其中的 hooks 应当是一个对象");
  return Object.fromEntries(
    Object.entries(value).map(([event, handlers]) => {
      if (!Array.isArray(handlers)) throw new Error(`其中的 hooks.${event} 应当是一个数组`);
      return [event, handlers.map((handler, index) => parseHandler(handler, `hooks.${event}[${index}]`))];
    }),
  );
};

/**
 * A flat hooks file (`{ version: 1, hooks: { <event>: [handler] } }`, Cursor's and Copilot's) with this app's handlers:
 * the reader's own stay, and a file wholly this app's (`ownsFile`) with anything else in it is not touched.
 */
export const mergeFlatHooks = (
  input: unknown,
  bridgePath: string,
  client: HookClient | ClientDescriptor,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> => {
  const descriptor = descriptorOf(client);
  const document = cloneDocument(input);
  const events = Object.fromEntries(
    Object.entries(parseFlatEvents(document.hooks)).map(([event, handlers]) => [event, handlers.filter((handler) => !isOwnHook(handler))]),
  );
  if (
    descriptor.hooks.ownsFile === true &&
    (Object.values(events).some((handlers) => handlers.length > 0) || Object.keys(document).some((key) => key !== "hooks" && key !== "version"))
  ) {
    throw new Error("这个文件里有不是本应用写入的内容，没有改动它；如果不再需要，先自行删除或改名再试");
  }
  for (const { event, operation } of descriptor.hooks.events) {
    events[event] = [...(events[event] ?? []), handlerFor(bridgePath, operation, descriptor, platform, event)];
  }
  return { version: 1, ...document, hooks: events };
};

/** A flat hooks file without this app's handlers: an event they alone filled goes with them. */
export const removeFlatHooks = (input: unknown): Record<string, unknown> => {
  const document = cloneDocument(input);
  if (document.hooks === undefined) return document;
  return {
    ...document,
    hooks: Object.fromEntries(
      Object.entries(parseFlatEvents(document.hooks)).flatMap(([event, handlers]) => {
        const kept = handlers.filter((handler) => !isOwnHook(handler));
        return kept.length === 0 && handlers.length > 0 ? [] : [[event, kept]];
      }),
    ),
  };
};

/** The name Antigravity's hooks file keeps this app's hook under. */
export const ANTIGRAVITY_HOOK_NAME = "paraself";

/** The name it kept it under as Decision: read as this app's, renamed at a connect, taken out at a disconnect. */
export const LEGACY_ANTIGRAVITY_HOOK_NAME = "decision";

/** The events this app's hook in Antigravity's file listens on, of every client of that format: the fields it manages. */
const antigravityEvents = (): Set<string> =>
  new Set(BUILT_IN_CLIENTS.filter((client) => client.hooks.format === "antigravity").flatMap((client) => client.hooks.events.map(({ event }) => event)));

/**
 * A hook whose handlers, under the events this app listens on, are all this app's: any other field is no handler. What
 * an install may write over; a removal goes by each handler instead (removeAntigravityHooks).
 */
const isOwnAntigravityHook = (value: unknown, events: Set<string> = antigravityEvents()): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const handlers = Object.entries(value).flatMap(([key, handlers]) => (events.has(key) && Array.isArray(handlers) ? handlers : []));
  return handlers.length > 0 && handlers.every((handler) =>
    typeof handler === "object" && handler !== null && !Array.isArray(handler) && isOwnHook(handler as HookHandler));
};

/**
 * The document without this app's handlers in the hook of that name. Its own handlers alone, under the events it
 * listens on: an event the reader added to the hook and a handler of theirs beside this app's stay, and the hook with
 * them. An event this app's handlers alone filled goes with them. With no handler left on it at all, what is left
 * (`enabled`, a field the client added) runs nothing: the hook goes whole, as before it was connected, and connecting
 * again finds none in the way.
 */
const withoutOwnAntigravityHandlers = (document: Record<string, unknown>, name: string, events: Set<string>): Record<string, unknown> => {
  const hook = document[name];
  if (typeof hook !== "object" || hook === null || Array.isArray(hook)) return document;
  let removed = false;
  const kept = Object.fromEntries(
    Object.entries(hook).flatMap(([key, value]) => {
      if (!events.has(key) || !Array.isArray(value)) return [[key, value]];
      const theirs = value.filter((handler) =>
        !(typeof handler === "object" && handler !== null && !Array.isArray(handler) && isOwnHook(handler as HookHandler)));
      removed ||= theirs.length < value.length;
      return theirs.length > 0 || value.length === 0 ? [[key, theirs]] : [];
    }),
  );
  if (!removed) return document;
  // Any list of objects left may be handlers (an event of the reader's, under whatever name): kept, hook and all.
  const handlersLeft = Object.values(kept).some((value) =>
    Array.isArray(value) && value.some((item) => typeof item === "object" && item !== null && !Array.isArray(item)));
  if (handlersLeft) return { ...document, [name]: kept };
  const { [name]: _removed, ...rest } = document;
  return rest;
};

/**
 * Antigravity's hooks file, with this app's hook as `paraself`: each event's handlers in a flat list, the operation in
 * each command (its input names no event). The reader's other hooks and fields stay; a `paraself` of the reader's own is
 * not replaced. The hook as Decision named it (`decision`), wholly this app's, is renamed, its `enabled` and the
 * client's fields with it; one with the reader's handlers in it keeps them, without this app's.
 */
export const mergeAntigravityHooks = (
  input: unknown,
  bridgePath: string,
  client: HookClient | ClientDescriptor,
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> => {
  const descriptor = descriptorOf(client);
  const events = new Set([...antigravityEvents(), ...descriptor.hooks.events.map(({ event }) => event)]);
  let document = cloneDocument(input);
  if (document[ANTIGRAVITY_HOOK_NAME] !== undefined && !isOwnAntigravityHook(document[ANTIGRAVITY_HOOK_NAME], events)) {
    throw new Error(
      `其中已有一个名为 ${ANTIGRAVITY_HOOK_NAME} 的钩子，不是本应用的：${ANTIGRAVITY_HOOK_NAME} 钩子里有别的处理器，Paraself 不会改动它；` +
        "如果不再需要这些处理器，先自行删除或把它们移到别的钩子再试",
    );
  }
  const legacy = document[LEGACY_ANTIGRAVITY_HOOK_NAME];
  if (legacy !== undefined) {
    if (document[ANTIGRAVITY_HOOK_NAME] === undefined && isOwnAntigravityHook(legacy, events)) {
      const { [LEGACY_ANTIGRAVITY_HOOK_NAME]: _legacy, ...rest } = document;
      document = { ...rest, [ANTIGRAVITY_HOOK_NAME]: legacy };
    } else {
      document = withoutOwnAntigravityHandlers(document, LEGACY_ANTIGRAVITY_HOOK_NAME, events);
    }
  }
  // Only the events it listens on are its own to write; anything else there stays as it was, of whatever type
  // (`enabled: false` as Claude Code's disableAllHooks does, and fields the client adds later).
  const own = (document[ANTIGRAVITY_HOOK_NAME] ?? {}) as Record<string, unknown>;
  return {
    ...document,
    [ANTIGRAVITY_HOOK_NAME]: {
      ...Object.fromEntries(Object.entries(own).filter(([key]) => !events.has(key))),
      // One event may carry both operations (a client's question and answer on one event): each keeps its handler.
      ...descriptor.hooks.events.reduce<Record<string, HookHandler[]>>((byEvent, { event, operation }) => ({
        ...byEvent,
        [event]: [...(byEvent[event] ?? []), handlerFor(bridgePath, operation, descriptor, platform, event)],
      }), {}),
    },
  };
};

/**
 * Antigravity's hooks file without this app's hook, under its name now or the one it had as Decision. The reader's
 * `enabled` is kept through an install or a repair, not through a disconnect.
 */
export const removeAntigravityHooks = (input: unknown, client?: HookClient | ClientDescriptor): Record<string, unknown> => {
  // The built-in events, and a client's own (one added on the 接入 page names its own).
  const events = new Set([...antigravityEvents(), ...(client === undefined ? [] : descriptorOf(client).hooks.events.map(({ event }) => event))]);
  return [ANTIGRAVITY_HOOK_NAME, LEGACY_ANTIGRAVITY_HOOK_NAME].reduce(
    (document, name) => withoutOwnAntigravityHandlers(document, name, events),
    cloneDocument(input),
  );
};
