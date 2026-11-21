import { BUILT_IN_CLIENTS } from "./clients.js";
import { mergeHookDocument, type CommandSpec, type HookConfigDocument } from "./hooks.js";
import { mcpCommands, mcpRemoveCommands } from "./install.js";

const claudeCode = BUILT_IN_CLIENTS.find((client) => client.id === "claude-code")!;

export const mergeClaudeSettings = (
  settings: unknown,
  bridgePath: string,
  platform: NodeJS.Platform = process.platform,
): HookConfigDocument =>
  mergeHookDocument(settings, bridgePath, claudeCode, platform);

/** Takes the user-scoped server out, once it is seen to run this app's bridge. */
export const claudeMcpRemoveCommands = (): CommandSpec[] => mcpRemoveCommands(claudeCode);

export const claudeMcpCommands = (
  bridgePath: string,
  platform: NodeJS.Platform = process.platform,
): CommandSpec[] => mcpCommands(claudeCode, bridgePath, platform);
