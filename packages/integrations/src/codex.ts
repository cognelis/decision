import {
  mergeHookDocument,
  type CommandSpec,
  type HookConfigDocument,
} from "./hooks.js";

export const mergeCodexHooks = (
  hooks: unknown,
  bridgePath: string,
  platform: NodeJS.Platform = process.platform,
): HookConfigDocument =>
  mergeHookDocument(hooks, bridgePath, "codex", platform);

/** Takes the server out, once it is seen to run this app's bridge. */
export const codexMcpRemoveCommands = (): CommandSpec[] => [
  { command: "codex", args: ["mcp", "get", "decision"], tolerateFailure: true, expectsBridgeFor: "codex" },
  {
    command: "codex",
    args: ["mcp", "remove", "decision"],
    tolerateFailure: true,
    absentMcpName: "decision",
  },
];

export const codexMcpCommands = (bridgePath: string): CommandSpec[] => [
  ...codexMcpRemoveCommands(),
  {
    command: "codex",
    args: [
      "mcp",
      "add",
      "decision",
      "--",
      bridgePath,
      "mcp",
      "codex",
    ],
    tolerateFailure: false,
  },
];
