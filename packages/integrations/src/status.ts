import { access, constants, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { BUILT_IN_CLIENTS, type ClientDescriptor } from "./clients.js";
import { customHookPath } from "./custom-clients.js";
import { ANTIGRAVITY_HOOK_NAME, currentHookMarker, hasHookMarker, hookCommandLine, LEGACY_ANTIGRAVITY_HOOK_NAME, legacyHookFile } from "./hooks.js";

/**
 * "disabled": the client's settings turn every hook off (Claude Code's `disableAllHooks`), or this app's (Antigravity's
 * `enabled`). "command-missing": not connected, and its command is nowhere on the PATH (withCommandsLookedFor).
 * "shadowed": this app's hooks are there, but a file the client reads in their place is too (Droid's hooks.json), so
 * they do not run.
 */
export type ClientIntegrationStatus = "installed" | "upgrade-required" | "not-installed" | "disabled" | "unknown" | "command-missing" | "shadowed";

/** Each client's status, by id. */
export type IntegrationStatus = Record<string, ClientIntegrationStatus>;

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The handlers under one event, with the matcher each was found under (Antigravity's and the flat files' lists have none).
 * Antigravity's under its hook's name now and the one it had as Decision: those are read as this app's too, to reconnect.
 */
const handlersOf = (record: Record<string, unknown>, client: ClientDescriptor, event: string): { matcher: unknown; handler: unknown }[] => {
  if (client.hooks.format === "antigravity") {
    return [ANTIGRAVITY_HOOK_NAME, LEGACY_ANTIGRAVITY_HOOK_NAME].flatMap((name) => {
      const handlers = asObject(record[name])?.[event];
      return Array.isArray(handlers) ? handlers.map((handler) => ({ matcher: undefined, handler })) : [];
    });
  }
  const groups = asObject(record.hooks)?.[event];
  if (!Array.isArray(groups)) return [];
  if (client.hooks.format === "flat") return groups.map((handler) => ({ matcher: undefined, handler }));
  return groups.flatMap((group) => {
    const object = asObject(group);
    return object === null || !Array.isArray(object.hooks)
      ? []
      : object.hooks.map((handler: unknown) => ({ matcher: object.matcher, handler }));
  });
};

/**
 * Every event this app listens on there, each with a hook of its that holds all of `required`: with none required, one
 * marked this app's in any form it ever wrote (hasHookMarker), Decision's `DECISION_HOOK=` among them.
 */
const hasPassiveHooks = (
  record: Record<string, unknown>,
  client: ClientDescriptor,
  required: readonly string[] = [],
): boolean =>
  client.hooks.events.every(({ event, operation, matcher }) =>
    handlersOf(record, client, event).some((found) => {
      if (matcher !== undefined && found.matcher !== matcher) return false;
      // Run without a shell (Claude Code on Windows), a hook's bridge and marker are in its arguments.
      const handler = asObject(found.handler);
      const line = handler === null ? null : hookCommandLine(handler);
      return (
        line !== null &&
        hasHookMarker(line) &&
        required.every((part) => line.includes(part)) &&
        line.includes(`hook ${operation} ${client.id}`)
      );
    }),
  );

/** The bridge's path as hookBridgeReference quotes it for a shell (`'…'`, a quote inside as `'"'"'`), unquoted. */
const unquoted = (reference: string): string =>
  reference.startsWith("'") && reference.endsWith("'") ? reference.slice(1, -1).replaceAll(`'"'"'`, "'") : reference;

const turnedOff = (record: Record<string, unknown>, client: ClientDescriptor): boolean =>
  client.hooks.format === "antigravity"
    ? asObject(record[ANTIGRAVITY_HOOK_NAME])?.enabled === false
    : client.hooks.format === "claude" && record.disableAllHooks === true;

const statusFor = async (
  path: string,
  client: ClientDescriptor,
  bridgeReference: string | undefined,
  platform: NodeJS.Platform,
  home: string,
): Promise<ClientIntegrationStatus> => {
  const status = await hookStatus(path, client, bridgeReference, platform);
  // This app's hooks still in the file they had as Decision's (Grok's hooks/decision.json), which the client goes on
  // running beside the new one: reconnect, which takes that file away.
  const legacy = legacyHookFile(client, path);
  if (legacy !== null && (await hookStatus(legacy, client, undefined, platform)) === "upgrade-required") return "upgrade-required";
  // Connected in a file the client does not read while another is there: not recording, said why.
  const shadow = client.hooks.shadowedBy === undefined ? null : customHookPath(client.hooks.shadowedBy, home);
  if (shadow !== null && status !== "not-installed" && status !== "unknown" && (await access(shadow).then(() => true, () => false))) {
    return "shadowed";
  }
  return status;
};

const hookStatus = async (
  path: string,
  client: ClientDescriptor,
  bridgeReference: string | undefined,
  platform: NodeJS.Platform,
): Promise<ClientIntegrationStatus> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    return isMissing(error) ? "not-installed" : "unknown";
  }
  try {
    const record = asObject(JSON.parse(raw) as unknown);
    if (record === null) {
      return "unknown";
    }
    // With this set the client runs no hook of this app's: connected, it recorded nothing. Set with none of this
    // app's hooks there, it was never connected, and is said so rather than "turned off".
    if (turnedOff(record, client) && hasPassiveHooks(record, client)) {
      return "disabled";
    }
    const current = currentHookMarker(platform);
    if (hasPassiveHooks(record, client, [current])) {
      // Hooks that run a bridge no longer where this app keeps it (the app moved, or upgraded into a new
      // folder) fail on every turn: they need reconnecting, not "connected". One run with no shell names it unquoted.
      const reference = bridgeReference !== undefined && client.hooks.invocation === "argv" ? unquoted(bridgeReference) : bridgeReference;
      return reference === undefined ||
        hasPassiveHooks(record, client, [current, reference])
        ? "installed"
        : "upgrade-required";
    }
    // This app's hooks in a form it no longer writes, such as the cmd-only ones Windows had before, or Decision's.
    return hasPassiveHooks(record, client)
      ? "upgrade-required"
      : "not-installed";
  } catch {
    return "unknown";
  }
};

export const detectIntegrationStatus = async (
  /** Each client's hook file, by id (Claude Code's and Codex's also as their old names): the clients looked at. */
  paths: Record<string, string> & { claudeSettingsPath?: string; codexHooksPath?: string },
  /** How this app's hooks name its bridge (hookBridgeReference); a hook naming another one is stale. */
  bridgeReference?: string,
  platform: NodeJS.Platform = process.platform,
  clients: readonly ClientDescriptor[] = BUILT_IN_CLIENTS,
  /** The reader's home folder, where a file shadowing a client's hooks (`~/…`) is. */
  home: string = homedir(),
): Promise<IntegrationStatus> => {
  const byId: Record<string, string | undefined> = {
    ...paths,
    ...(paths.claudeSettingsPath === undefined ? {} : { "claude-code": paths.claudeSettingsPath }),
    ...(paths.codexHooksPath === undefined ? {} : { codex: paths.codexHooksPath }),
  };
  const looked = clients.flatMap((client) => {
    const path = byId[client.id];
    return path === undefined ? [] : [[client, path] as const];
  });
  return Object.fromEntries(
    await Promise.all(
      looked.map(async ([client, path]) => [client.id, await statusFor(path, client, bridgeReference, platform, home)] as const),
    ),
  );
};

/** Whether a command is on the PATH, as a shell would find it (on Windows, with the extensions PATHEXT names). */
export const commandOnPath = async (
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> => {
  const extensions = platform === "win32" ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const candidates = (environment.PATH ?? "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter((folder) => folder.length > 0)
    .flatMap((folder) => extensions.map((extension) => join(folder, `${command}${extension}`)));
  for (const candidate of candidates) {
    if (await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return true;
  }
  return false;
};

/** A client not connected whose command is not there either, said so: there is nothing to connect yet. */
export const withCommandsLookedFor = async (
  status: IntegrationStatus,
  clients: readonly ClientDescriptor[] = BUILT_IN_CLIENTS,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<IntegrationStatus> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(status).map(async ([id, value]) => {
        const client = clients.find((entry) => entry.id === id);
        return [
          id,
          value === "not-installed" && client?.command !== undefined && !(await commandOnPath(client.command, environment, platform))
            ? "command-missing"
            : value,
        ] as const;
      }),
    ),
  );
