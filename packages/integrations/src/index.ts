export {
  claudeMcpCommands,
  mergeClaudeSettings,
} from "./claude.js";
export {
  codexMcpCommands,
  mergeCodexHooks,
} from "./codex.js";
export {
  currentHookMarker,
  DECISION_HOOK_MARKER,
  hookBridgeReference,
  hookCommandLine,
  mergeHookDocument,
} from "./hooks.js";
export type {
  CommandSpec,
  HookConfigDocument,
  HookEvents,
  HookGroup,
  HookHandler,
} from "./hooks.js";
export { commandInvocation, installIntegrations, removeIntegrations } from "./install.js";
export { decisionProjectFor, resolveDecisionRepository, normalizeRepositoryRemote } from "./repository-context.js";
export { detectIntegrationStatus } from "./status.js";
export type { ClientIntegrationStatus, IntegrationStatus } from "./status.js";
export type {
  CommandResult,
  CommandRunner,
  InstallMode,
  InstallReport,
  InstallTargetReport,
  IntegrationClient,
} from "./install.js";
