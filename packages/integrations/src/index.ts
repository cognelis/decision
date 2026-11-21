export {
  claudeMcpCommands,
  mergeClaudeSettings,
} from "./claude.js";
export {
  codexMcpCommands,
  mergeCodexHooks,
} from "./codex.js";
export {
  BUILT_IN_CLIENTS,
  clientById,
  mcpByFile,
  clientHookPath,
  clientHookPaths,
  clientSummary,
} from "./clients.js";
export { CATALOG_CLIENTS, catalogSummaries, KNOWN_CLIENTS } from "./catalog.js";
export {
  assertHookTargetLock,
  customClientDescriptor,
  lockHookTarget,
  writeLockedHookFile,
  customClientProblems,
  customHookPath,
  readCustomClients,
  setAsideCustomClients,
  supersededBy,
  writeCustomClients,
} from "./custom-clients.js";
export type { HookTargetLock } from "./custom-clients.js";
export type { ClientCaptureFields, ClientDescriptor, ClientHookEvent, ClientSummary, HookOperation, McpByCommand, McpByFile } from "./clients.js";
export {
  ANTIGRAVITY_HOOK_NAME,
  currentHookMarker,
  PARASELF_HOOK_MARKER,
  hookBridgeReference,
  hookCommandLine,
  mergeAntigravityHooks,
  mergeFlatHooks,
  mergeHookDocument,
  removeAntigravityHooks,
  removeFlatHooks,
} from "./hooks.js";
export { mergeMcpFile, removeMcpFile } from "./mcp-file.js";
export type {
  CommandSpec,
  HookConfigDocument,
  HookEvents,
  HookGroup,
  HookHandler,
} from "./hooks.js";
export {
  commandInvocation,
  inIntegrationsTurn,
  installIntegrations,
  installIntegrationsWithinTurn,
  mcpCommands,
  mcpRemoveCommands,
  removeIntegrations,
  removeIntegrationsWithinTurn,
} from "./install.js";
export { decisionProjectFor, resolveDecisionRepository, normalizeRepositoryRemote } from "./repository-context.js";
export { commandOnPath, detectIntegrationStatus, withCommandsLookedFor } from "./status.js";
export type { ClientIntegrationStatus, IntegrationStatus } from "./status.js";
export type {
  CommandResult,
  CommandRunner,
  InstallMode,
  InstallReport,
  InstallTargetReport,
  IntegrationClient,
} from "./install.js";
export { probeDescriptor, transcriptReaders } from "./client-probe.js";
export { SKILL_CLIENTS, bundledSkillFingerprints, clientsBehindOnSkills, isSkillClient, skillLocations, skillSummary, syncBundledSkills } from "./skills.js";
export type { SkillClient, SkillInstallReport, SkillInstallStatus, SkillSyncOptions } from "./skills.js";
export { LEGACY_SKILL, SKILL_FINGERPRINTS } from "./skill-fingerprints.js";
export type { SkillFingerprint } from "./skill-fingerprints.js";
