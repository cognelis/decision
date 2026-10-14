import { readFile } from "node:fs/promises";

import { currentHookMarker, DECISION_HOOK_MARKER, hookCommandLine } from "./hooks.js";
import type { IntegrationClient } from "./install.js";

/** "disabled": the client's settings turn every hook off (Claude Code's `disableAllHooks`). */
export type ClientIntegrationStatus = "installed" | "upgrade-required" | "not-installed" | "disabled" | "unknown";

export interface IntegrationStatus {
  claudeCode: ClientIntegrationStatus;
  codex: ClientIntegrationStatus;
}

interface IntegrationStatusPaths {
  claudeSettingsPath: string;
  codexHooksPath: string;
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

const hasPassiveHook = (
  input: Record<string, unknown>,
  client: IntegrationClient,
  event: "PostToolUse" | "Stop" | "UserPromptSubmit",
  operation:
    | "post-tool-use"
    | "stop"
    | "user-prompt-submit",
  required: readonly string[],
): boolean => {
  const hooks = input.hooks;
  if (
    typeof hooks !== "object" ||
    hooks === null ||
    Array.isArray(hooks)
  ) {
    return false;
  }
  const groups = (hooks as Record<string, unknown>)[event];
  if (!Array.isArray(groups)) {
    return false;
  }
  const expectedMatcher =
    event === "PostToolUse"
      ? client === "claude-code"
        ? "^AskUserQuestion$"
        : "^(request_user_input|AskUserQuestion)$"
      : undefined;
  return groups.some((group) => {
    if (
      typeof group !== "object" ||
      group === null ||
      Array.isArray(group) ||
      !("hooks" in group) ||
      !Array.isArray(group.hooks)
    ) {
      return false;
    }
    if (
      expectedMatcher !== undefined &&
      (!("matcher" in group) ||
        group.matcher !== expectedMatcher)
    ) {
      return false;
    }
    return group.hooks.some((handler: unknown) => {
      // Run without a shell (Claude Code on Windows), a hook's bridge and marker are in its arguments.
      const line =
        typeof handler === "object" && handler !== null && !Array.isArray(handler)
          ? hookCommandLine(handler)
          : null;
      return (
        line !== null &&
        required.every((part) => line.includes(part)) &&
        line.includes(`hook ${operation} ${client}`)
      );
    });
  });
};

const hasHybridPassiveHooks = (
  input: Record<string, unknown>,
  client: IntegrationClient,
  required: readonly string[],
): boolean =>
  hasPassiveHook(
    input,
    client,
    "PostToolUse",
    "post-tool-use",
    required,
  ) &&
  hasPassiveHook(input, client, "Stop", "stop", required) &&
  hasPassiveHook(
    input,
    client,
    "UserPromptSubmit",
    "user-prompt-submit",
    required,
  );

const statusFor = async (
  path: string,
  client: IntegrationClient,
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
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return "unknown";
    }
    const record = parsed as Record<string, unknown>;
    // With this set Claude Code runs no hook at all, this app's among them: connected, it recorded nothing. Set
    // with none of this app's hooks there, it was never connected, and is said so rather than "turned off".
    if (client === "claude-code" && record.disableAllHooks === true && hasHybridPassiveHooks(record, client, [DECISION_HOOK_MARKER])) {
      return "disabled";
    }
    const current = currentHookMarker(platform);
    if (hasHybridPassiveHooks(record, client, [current])) {
      // Hooks that run a bridge no longer where this app keeps it (the app moved, or upgraded into a new
      // folder) fail on every turn: they need reconnecting, not "connected".
      return bridgeReference === undefined ||
        hasHybridPassiveHooks(record, client, [current, bridgeReference])
        ? "installed"
        : "upgrade-required";
    }
    // This app's hooks in a form it no longer writes, such as the cmd-only ones Windows had before.
    return hasHybridPassiveHooks(record, client, [DECISION_HOOK_MARKER])
      ? "upgrade-required"
      : "not-installed";
  } catch {
    return "unknown";
  }
};

export const detectIntegrationStatus = async (
  paths: IntegrationStatusPaths,
  /** How this app's hooks name its bridge (hookBridgeReference); a hook naming another one is stale. */
  bridgeReference?: string,
  platform: NodeJS.Platform = process.platform,
): Promise<IntegrationStatus> => {
  const [claudeCode, codex] = await Promise.all([
    statusFor(paths.claudeSettingsPath, "claude-code", bridgeReference, platform),
    statusFor(paths.codexHooksPath, "codex", bridgeReference, platform),
  ]);
  return { claudeCode, codex };
};
