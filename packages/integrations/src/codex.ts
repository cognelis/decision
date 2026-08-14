import {
  mergeHookDocument,
  type CommandSpec,
  type HookConfigDocument,
} from "./hooks.js";

export const mergeCodexHooks = (
  hooks: unknown,
  bridgePath: string,
): HookConfigDocument =>
  mergeHookDocument(hooks, bridgePath, "codex");

export const codexMcpCommands = (bridgePath: string): CommandSpec[] => [
  {
    command: "codex",
    args: ["mcp", "remove", "decision-island"],
    tolerateFailure: true,
    absentMcpName: "decision-island",
  },
  {
    command: "codex",
    args: ["mcp", "remove", "decision"],
    tolerateFailure: true,
    absentMcpName: "decision",
  },
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
