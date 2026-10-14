import {
  hookBridgeReference,
  mergeHookDocument,
  type CommandSpec,
  type HookConfigDocument,
} from "./hooks.js";

export const mergeClaudeSettings = (
  settings: unknown,
  bridgePath: string,
  platform: NodeJS.Platform = process.platform,
): HookConfigDocument =>
  mergeHookDocument(settings, bridgePath, "claude-code", platform);

/** Takes the user-scoped server out, once it is seen to run this app's bridge. */
export const claudeMcpRemoveCommands = (): CommandSpec[] => [
  { command: "claude", args: ["mcp", "get", "decision"], tolerateFailure: true, expectsBridgeFor: "claude-code" },
  {
    command: "claude",
    args: ["mcp", "remove", "--scope", "user", "decision"],
    tolerateFailure: true,
    absentMcpName: "decision",
  },
];

/**
 * On Windows the bridge is a .cmd, which Claude Code cannot start without cmd (as npx, its docs say): `call`
 * first, so cmd leaves the quotes around a path with spaces where they are.
 */
export const claudeMcpCommands = (
  bridgePath: string,
  platform: NodeJS.Platform = process.platform,
): CommandSpec[] => [
  ...claudeMcpRemoveCommands(),
  {
    command: "claude",
    args: [
      "mcp",
      "add",
      "--scope",
      "user",
      "decision",
      "--",
      // A path cmd would read part of as its own is refused here too, not only by the hooks written first.
      ...(platform === "win32" ? ["cmd", "/d", "/v:off", "/c", "call", hookBridgeReference(bridgePath, platform)] : [bridgePath]),
      "mcp",
      "claude-code",
    ],
    tolerateFailure: false,
  },
];
