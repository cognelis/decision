import { BUILT_IN_CLIENTS } from "./clients.js";
import { mergeHookDocument, type CommandSpec, type HookConfigDocument } from "./hooks.js";
import { mcpCommands, mcpRemoveCommands } from "./install.js";

const codex = BUILT_IN_CLIENTS.find((client) => client.id === "codex")!;

export const mergeCodexHooks = (
  hooks: unknown,
  bridgePath: string,
  platform: NodeJS.Platform = process.platform,
): HookConfigDocument =>
  mergeHookDocument(hooks, bridgePath, codex, platform);

/** Takes the server out, once it is seen to run this app's bridge. */
export const codexMcpRemoveCommands = (): CommandSpec[] => mcpRemoveCommands(codex);

// The bridge as it is on every platform: Codex starts a .cmd itself.
export const codexMcpCommands = (bridgePath: string): CommandSpec[] => mcpCommands(codex, bridgePath, "linux");
