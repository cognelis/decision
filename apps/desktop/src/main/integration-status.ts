import { DECISION_HOOK_MARKER } from "@cognelis/decision-integrations";
import { readFile } from "node:fs/promises";

import type { IntegrationStatus } from "../shared/renderer-api.js";

interface IntegrationStatusPaths {
  claudeSettingsPath: string;
  codexHooksPath: string;
}

type IntegrationClient = "claude-code" | "codex";

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
  marker: string,
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
    return group.hooks.some(
      (handler: unknown) =>
        typeof handler === "object" &&
        handler !== null &&
        !Array.isArray(handler) &&
        "command" in handler &&
        typeof handler.command === "string" &&
        handler.command.includes(marker) &&
        handler.command.includes(
          `hook ${operation} ${client}`,
        ),
    );
  });
};

const hasHybridPassiveHooks = (
  input: Record<string, unknown>,
  client: IntegrationClient,
  marker: string,
): boolean =>
  hasPassiveHook(
    input,
    client,
    "PostToolUse",
    "post-tool-use",
    marker,
  ) &&
  hasPassiveHook(input, client, "Stop", "stop", marker) &&
  hasPassiveHook(
    input,
    client,
    "UserPromptSubmit",
    "user-prompt-submit",
    marker,
  );

const statusFor = async (
  path: string,
  client: IntegrationClient,
): Promise<
  "installed" | "upgrade-required" | "not-installed" | "unknown"
> => {
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
    if (hasHybridPassiveHooks(
      parsed as Record<string, unknown>,
      client,
      `${DECISION_HOOK_MARKER}1`,
    )) {
      return "installed";
    }
    return hasHybridPassiveHooks(
      parsed as Record<string, unknown>,
      client,
      "DECISION_ISLAND_HOOK=3",
    )
      ? "upgrade-required"
      : "not-installed";
  } catch {
    return "unknown";
  }
};

export const detectIntegrationStatus = async (
  paths: IntegrationStatusPaths,
): Promise<IntegrationStatus> => {
  const [claudeCode, codex] = await Promise.all([
    statusFor(paths.claudeSettingsPath, "claude-code"),
    statusFor(paths.codexHooksPath, "codex"),
  ]);
  return { claudeCode, codex };
};
