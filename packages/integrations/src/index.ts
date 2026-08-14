export {
  claudeMcpCommands,
  mergeClaudeSettings,
} from "./claude.js";
export {
  codexMcpCommands,
  mergeCodexHooks,
} from "./codex.js";
export {
  DECISION_HOOK_MARKER,
  mergeHookDocument,
} from "./hooks.js";
export type {
  CommandSpec,
  HookConfigDocument,
  HookEvents,
  HookGroup,
  HookHandler,
} from "./hooks.js";
export { installIntegrations } from "./install.js";
export type {
  CommandResult,
  CommandRunner,
  InstallMode,
  InstallReport,
  InstallTargetReport,
  IntegrationClient,
} from "./install.js";
