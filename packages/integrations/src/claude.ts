import {
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

export const claudeMcpCommands = (bridgePath: string): CommandSpec[] => [
  {
    command: "claude",
    args: ["mcp", "remove", "--scope", "user", "decision-island"],
    tolerateFailure: true,
    absentMcpName: "decision-island",
  },
  {
    command: "claude",
    args: ["mcp", "remove", "--scope", "user", "decision"],
    tolerateFailure: true,
    absentMcpName: "decision",
  },
  {
    command: "claude",
    args: [
      "mcp",
      "add",
      "--scope",
      "user",
      "decision",
      "--",
      bridgePath,
      "mcp",
      "claude-code",
    ],
    tolerateFailure: false,
  },
];
