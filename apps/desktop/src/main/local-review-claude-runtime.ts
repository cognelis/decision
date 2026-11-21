import { z } from "zod";
import { dirname, join } from "node:path";
import type { ReviewCopy } from "./local-review-git.js";
import { reviewToolEnvironment, reviewToolReadPaths, REVIEW_SYSTEM_CA_FILES, type ReviewTool } from "./local-review-tools.js";

export const CLAUDE_REVIEW_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] as const;
export const CLAUDE_SECURITY_DENY = ["Bash(security:*)", "Bash(/usr/bin/security:*)", "Bash(security *)", "Bash(/usr/bin/security *)"];
// No /usr/bin directory grant, and no security executable grant. The CLI's
// command permission gate blocks direct security calls; indirect execution is
// an explicitly accepted risk, not an OS-level executable isolation claim.
export const CLAUDE_SYSTEM_FILES = ["env", "git", "uname", "which", "dirname", "basename", "sed", "grep", "awk", "head", "tail", "sort", "cut", "tr", "wc", "xargs", "readlink", "mktemp", "tee", "find", "stat", "touch"].map(name => `/usr/bin/${name}`);
const SYSTEM_READ = ["/bin", "/usr/lib", "/System", "/Library/Developer/CommandLineTools", "/private/etc", "/etc", "/var/select", "/private/var/select", "/dev", ...CLAUDE_SYSTEM_FILES];
const CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "MODEL_PROXY_URL", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
export interface ClaudeReviewRuntime { executable: string; tools: ReviewTool[]; git: string; home: string; configs: string[]; extraCAFiles?: string[]; extraCA?: string; fingerprint: string }

const strings = z.array(z.string());
export const claudeReviewSettingsSchema = z.object({
  env: z.record(z.string(), z.string()).refine(env => !("HOME" in env), "认证 HOME 不得被工具设置覆盖"),
  permissions: z.object({ allow: z.array(z.enum(CLAUDE_REVIEW_TOOLS)).length(6).refine(values => new Set(values).size === 6), deny: strings.refine(values => CLAUDE_SECURITY_DENY.every(rule => values.includes(rule))), blockReadsOutsideWorkingDirectories: z.literal(true), blockWritesOutsideWorkingDirectories: z.literal(true) }).strict(),
  sandbox: z.object({
    enabled: z.literal(true), failIfUnavailable: z.literal(true), autoAllowBashIfSandboxed: z.literal(true), allowUnsandboxedCommands: z.literal(false), excludedCommands: z.tuple([]),
    credentials: z.object({ envVars: z.array(z.object({ name: z.string(), mode: z.literal("deny") }).strict()) }).strict(),
    filesystem: z.object({ denyRead: strings.refine(paths => paths.includes("/")), allowRead: strings.refine(paths => !paths.some(path => ["/", "/usr/bin", "/usr/bin/security"].includes(path))), allowWrite: strings, denyWrite: strings }).strict(),
    network: z.object({ allowedDomains: z.tuple([]), deniedDomains: z.tuple([z.literal("*")]), strictAllowlist: z.literal(true), allowLocalBinding: z.literal(false), allowAllUnixSockets: z.literal(false) }).strict(),
  }).strict(),
}).strict();

export function claudeReviewSettings(copy: ReviewCopy, runtime: ClaudeReviewRuntime, alias: string, write: boolean, environmentKeys: string[] = []) {
  const toolEnv = reviewToolEnvironment(copy, runtime.tools.map(tool => dirname(tool.executable)), { NODE_EXTRA_CA_CERTS: runtime.extraCA });
  const { HOME: _home, ...env } = toolEnv; // Authentication keeps the real HOME.
  const scratch = join(copy.directory, "scratch");
  const settings = claudeReviewSettingsSchema.parse({
    env: { ...env, TMPDIR: alias, CLAUDE_CODE_TMPDIR: alias, PYTHONDONTWRITEBYTECODE: "1" },
    permissions: {
      allow: [...CLAUDE_REVIEW_TOOLS],
      deny: [...runtime.configs.map(path => `Read(/${path}${path.endsWith(".json") ? "" : "/**"})`), `Edit(/${copy.git}/**)`, `Write(/${copy.git}/**)`, `Edit(/${copy.tree}/.git)`, `Write(/${copy.tree}/.git)`, ...CLAUDE_SECURITY_DENY, ...(write ? [] : ["Edit", "Write"])],
      blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true,
    },
    sandbox: {
      enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, excludedCommands: [],
      credentials: { envVars: [...new Set([...CREDENTIAL_ENV, ...environmentKeys.filter(key => /key|token|auth|secret|password|credential|proxy/iu.test(key))])].map(name => ({ name, mode: "deny" })) },
      filesystem: {
        denyRead: ["/"],
        allowRead: [...new Set([copy.tree, copy.git, scratch, alias, join(copy.directory, "tool-bin"), runtime.executable, runtime.git, ...reviewToolReadPaths(runtime.tools), ...REVIEW_SYSTEM_CA_FILES, ...(runtime.extraCAFiles ?? []), ...SYSTEM_READ])],
        allowWrite: [scratch, alias, ...(write ? [copy.tree] : [])],
        denyWrite: [copy.git, join(copy.tree, ".git"), ...runtime.configs, ...(write ? [] : [copy.tree])],
      },
      network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false },
    },
  });
  if (settings.sandbox.filesystem.allowRead.some(path => ["/", runtime.home, "/usr/bin", "/usr/bin/security"].includes(path)) || !CLAUDE_SECURITY_DENY.every(rule => settings.permissions.deny.includes(rule))) throw new Error("Claude 宿主权限配置不符合边界，未启动。");
  return settings;
}

export function claudeReviewArguments(settings: ReturnType<typeof claudeReviewSettings>, schema: Record<string, unknown>, scratch: string, model?: string) {
  claudeReviewSettingsSchema.parse(settings);
  // Match the existing Claude generation adapter: this CLI rejects the Zod dialect declaration.
  // The business constraints stay intact and are validated again by the shared Zod parser.
  const { $schema: _dialect, ...outputSchema } = schema;
  return ["-p", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--tools", CLAUDE_REVIEW_TOOLS.join(","), "--allowedTools", CLAUDE_REVIEW_TOOLS.join(","), "--disallowedTools", "mcp__*", "--no-session-persistence", "--permission-mode", "dontAsk", "--output-format", "stream-json", "--verbose", "--json-schema", JSON.stringify(outputSchema), ...(model ? ["--model", model] : []), "--add-dir", scratch, "--settings", JSON.stringify(settings)];
}

export interface ClaudeToolCall { id: string; name: string; input: Record<string, unknown>; result?: { content: unknown; is_error?: boolean } }
export interface ClaudeReviewOutput { result: unknown; calls: ClaudeToolCall[]; model?: string | undefined; init: Record<string, unknown> }
export function claudeReviewOutput(stdout: string): ClaudeReviewOutput {
  const known = new Set<string>([...CLAUDE_REVIEW_TOOLS, "StructuredOutput", "DeferredToolPlaceholder"]);
  const calls = new Map<string, ClaudeToolCall>();
  let init: Record<string, unknown> | undefined, result: Record<string, any> | undefined;
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length > 100_000) throw new Error("Claude 工具日志超过上限。");
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === "system" && event.subtype === "init") {
      init = event;
      if (!Array.isArray(event.tools) || event.tools.some((name: string) => !known.has(name)) || event.mcp_servers?.length || event.skills?.length || event.slash_commands?.length || event.permissionMode !== "dontAsk" || event.plugins?.some((plugin: { path?: string }) => plugin.path !== "builtin")) throw new Error("Claude 工具、定制加载或权限模式与宿主配置不匹配。");
    }
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (block.type === "tool_use") {
        if (!known.has(block.name) || calls.has(block.id)) throw new Error("Claude 出现未知或重复工具事件，已停止。");
        calls.set(block.id, { id: block.id, name: block.name, input: block.input });
      } else if (block.type === "tool_result") {
        const call = calls.get(block.tool_use_id);
        if (!call || call.result) throw new Error("Claude 工具回执不匹配，已停止。");
        call.result = { content: block.content, ...(block.is_error === undefined ? {} : { is_error: block.is_error }) };
      }
    }
    if (event.type === "result" && event.origin?.kind !== "task-notification") {
      if (result) throw new Error("Claude 返回了重复主结论，已停止。");
      result = event;
    }
  }
  if (!init || !result || result.is_error || result.subtype !== "success") throw new Error("Claude 未成功完成受管调用。");
  const models = Object.keys(result.modelUsage ?? {});
  return { result: result.structured_output, calls: [...calls.values()], init, model: models.length === 1 ? models[0] : typeof init.model === "string" ? init.model : undefined };
}

export function validateClaudeToolStage(output: ClaudeReviewOutput, write: boolean) {
  const tools = output.init.tools as string[];
  const required = ["Read", "Glob", "Grep", "Bash", ...(write ? ["Edit", "Write"] : [])];
  if (required.some(name => !tools.includes(name)) || !write && ["Edit", "Write"].some(name => tools.includes(name))) throw new Error("Claude 分阶段工具授权与宿主配置不匹配。");
}
