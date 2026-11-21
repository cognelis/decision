import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, realpath, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, delimiter, isAbsolute } from "node:path";
import { type ModelProviderProfile } from "@cognelis/decision-protocol";
import { reviewEvaluation, reviewFix, reviewEvaluationJsonSchema, reviewFixJsonSchema, reviewEvaluationPrompt, reviewFixPrompt, reviewDiscussion, reviewDiscussionJsonSchema, type DiscussionAnswer, type DiscussionRequest, type ReviewAnnotation, type ReviewEvaluation, type ReviewFix, type ReviewFixExtra } from "./local-review-worker.js";
import { reviewToolEnvironment, resolveReviewTools, reviewToolReadPaths, reviewExtraCAFiles, REVIEW_SYSTEM_CA_FILES, type ReviewTool } from "./local-review-tools.js";
import { constants } from "node:fs";
import { minimalClientEnvironment } from "./model/cli/cli-adapter-support.js";
import { ManagedChildProcessRunner, ManagedProcessError } from "./model/cli/managed-child-process.js";
import { codexOutputSchema } from "./model/cli/codex-output-schema.js";
import { LocalReviewGit, type ReviewCopy } from "./local-review-git.js";

export { reviewEvaluation, reviewFix } from "./local-review-worker.js";
export type { ReviewAnnotation, ReviewVerdict, ReviewPlanGroup, ReviewFix, ReviewEvaluation } from "./local-review-worker.js";
export { REVIEW_TOOL_NAMES, reviewToolReadRoot, reviewToolEnvironment } from "./local-review-tools.js";
export function reviewAgentOutput(stdout: string): unknown {
  let text: string | undefined, completed = false;
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length > 100_000) throw new Error("Codex 工具日志过长。");
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type === "turn.failed" || event.type === "error") throw new Error("Codex 运行失败。");
    if (event.type === "turn.completed") completed = true;
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      if (typeof event.item.text !== "string" || Buffer.byteLength(event.item.text) > 512_000) throw new Error("Codex 最终答案超过上限。");
      text = event.item.text;
    }
  }
  if (!completed || !text) throw new Error("Codex 没有返回完整结果。");
  return JSON.parse(text);
}

/** Only the shell tool can access files. Keep these settings identical in the live capability fixture. */
export const REVIEW_AGENT_SETTINGS = [
  ...["plugins", "remote_plugin", "apps", "unified_exec_tty", "shell_snapshot", "view_image", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser", "in_app_local_automation", "image_generation", "multi_agent", "multi_agent_v2", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "tool_suggest", "goals", "sleep_tool", "hooks"].map(f => `features.${f}=false`),
  "features.code_mode=true", "features.unified_exec=true", "features.shell_tool=true", "features.skip_host_skill_discovery=true", "features.omit_skill_descriptions=true", "features.respect_system_proxy=false", "features.system_proxy_fallback=false", "tools.web_search=false", 'web_search="disabled"', "apps._default.enabled=false", "agents.enabled=false", "memories.generate_memories=false", "mcp_servers={}", "project_doc_max_bytes=0", 'shell_environment_policy.inherit="none"',
];
export function reviewPermissionSettings(copy: ReviewCopy, executable: string, write: boolean, programs: string[] = [executable], toolPrefixes: string[] = [], extraCAFiles: string[] = []): string[] {
  const reads = [...programs, ...toolPrefixes, ...REVIEW_SYSTEM_CA_FILES, ...extraCAFiles, join(copy.directory, "tool-bin"), ...(process.platform === "darwin" ? ["/Library/Developer/CommandLineTools"] : []), copy.git, join(copy.tree, ".git")];
  const entries = { [join(copy.directory, "scratch")]: "write", ":minimal": "read", ":workspace_roots": write ? "write" : "read", ...Object.fromEntries(reads.map(p => [p, "read"])) };
  return ['default_permissions="lr"', `permissions.lr.filesystem={${Object.entries(entries).map(([key, access]) => `${JSON.stringify(key)}=${JSON.stringify(access)}`).join(",")}}`, "permissions.lr.network.enabled=false"];
}

interface ReviewRuntime { executable: string; launcher: string; leadingArgs: string[]; programs: string[]; tools: ReviewTool[]; extraCAFiles: string[]; catalog: string; fingerprint: string }
const checkedExecutors = new Set<string>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const shellSettings = (copy: ReviewCopy, bins: string[] = [], environment: NodeJS.ProcessEnv = process.env) => `shell_environment_policy.set={${Object.entries(reviewToolEnvironment(copy, bins, environment)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}`;

export function reviewToolEvents(stdout: string) {
  // ponytail: exec JSONL does not publish a complete tool manifest. Unknown emitted
  // tool items fail closed; silent code-mode entry points still need tests/live probes.
  const known = new Set(["agent_message", "reasoning", "command_execution", "todo_list", "error"]);
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.item?.type && !known.has(event.item.type)) throw new Error(`Codex 出现未知工具事件 ${String(event.item.type).slice(0, 80)}，已停止调用。`);
  }
}

export class LocalReviewAgent {
  private tools: Promise<ReviewTool[]> | null = null;
  private readonly runner = new ManagedChildProcessRunner({ modelNetworkPolicy: "required" });
  constructor(readonly profile: ModelProviderProfile, private readonly environment: NodeJS.ProcessEnv = process.env) {
    if (profile.kind !== "codex-cli" || !profile.enabled || !profile.executablePath) throw new Error("请选择已启用的 Codex CLI 档案。");
  }
  private async runtime(copy: ReviewCopy): Promise<ReviewRuntime> {
    if (process.platform !== "darwin") throw new Error("当前平台尚未通过本地审阅读隔离验证。");
    const executable = await realpath(this.profile.executablePath!), programs = [executable];
    const tools = await (this.tools ??= resolveReviewTools(copy.directory, this.environment, this.runner, this.clientEnvironment()));
    const extraCAFiles = await reviewExtraCAFiles(this.environment);
    const bin = join(copy.directory, "tool-bin"); await mkdir(bin, { recursive: true, mode: 0o700 });
    for (const tool of tools) { const alias = join(bin, tool.name); if (await readlink(alias).catch(() => null) !== tool.executable) { await rm(alias, { force: true }); await symlink(tool.executable, alias); } }
    programs.push(...tools.map(tool => tool.executable));
    let launcher = executable, leadingArgs: string[] = [];
    for (const name of ["codex-code-mode-host", "codex-exec-server"]) {
      const path = join(dirname(executable), name);
      if (await access(path).then(() => true, () => false)) programs.push(await realpath(path));
    }
    const handle = await open(executable, "r");
    let header: string;
    try { const buffer = Buffer.alloc(256); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); header = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!; } finally { await handle.close(); }
    if (header.startsWith("#!")) {
      const parts = header.slice(2).trim().split(/\s+/u);
      let interpreter = parts[0]!, interpreterIndex = 0;
      if (interpreter.endsWith("/env")) {
        interpreterIndex = parts.findIndex((part, index) => index > 0 && !part.startsWith("-"));
        const name = parts[interpreterIndex];
        const candidates = (this.environment.PATH ?? "").split(delimiter).filter(isAbsolute).map(directory => join(directory, name ?? ""));
        interpreter = (await Promise.all(candidates.map(async path => await access(path, constants.X_OK).then(() => path, () => null)))).find((path): path is string => path !== null) ?? "";
      }
      if (!interpreter) throw new Error("无法定位 Codex CLI 解释器。");
      launcher = await realpath(interpreter);
      leadingArgs = [...parts.slice(interpreterIndex + 1), executable];
      programs.push(launcher);
    }
    const catalogText = this.profile.model ? await readFile(join(this.environment.CODEX_HOME ?? join(this.environment.HOME!, ".codex"), "models_cache.json"), "utf8") : (await this.runner.run({ executable: launcher, args: [...leadingArgs, ...REVIEW_AGENT_SETTINGS.flatMap(setting => ["-c", setting]), "debug", "models", "--bundled"], cwd: copy.tree, stdin: "", timeoutMs: 30_000, maximumStdoutBytes: 16 * 1024 * 1024, maximumStderrBytes: 16_000, environment: this.clientEnvironment() })).stdout;
    const cache = JSON.parse(catalogText);
    if (!Array.isArray(cache.models) || !cache.models.length || (this.profile.model && !cache.models.some((m: { slug?: string }) => m.slug === this.profile.model))) throw new Error("Codex 模型目录不可用或不兼容，请刷新模型列表后重试。");
    const catalog = JSON.stringify({ models: cache.models.map((m: Record<string, unknown>) => ({ ...m, tool_mode: undefined, apply_patch_tool_type: null, node_repl_disabled: true, experimental_supported_tools: [] })) });
    const identities = await Promise.all([...new Set(programs)].map(async path => { const file = await stat(path); return { path, size: file.size, mtime: file.mtimeMs }; }));
    const permissions = reviewPermissionSettings({ directory: "<job>", tree: "<workspace>", git: "<git>" }, executable, true, programs, reviewToolReadPaths(tools), extraCAFiles);
    return { executable, launcher, leadingArgs, programs: [...new Set(programs)], tools, extraCAFiles, catalog, fingerprint: digest({ identities, launcher, leadingArgs, permissions, tools, settings: REVIEW_AGENT_SETTINGS, shell: reviewToolEnvironment({ ...copy, directory: "<job>", tree: "<workspace>" }, tools.map(tool => dirname(tool.executable)), this.environment), catalog, model: this.profile.model, platform: process.platform }) };
  }
  private clientEnvironment() {
    const environment = minimalClientEnvironment(this.environment, [], this.profile.proxy);
    environment.PATH = (environment.PATH ?? "/usr/bin:/bin").split(delimiter).filter(isAbsolute).join(delimiter);
    return environment;
  }
  private async raw(copy: ReviewCopy, schema: Record<string, unknown>, prompt: string, write: boolean, runtime: ReviewRuntime, signal?: AbortSignal, timeoutMs = write ? 45 * 60_000 : 15 * 60_000) {
    const control = join(copy.directory, `control-${randomUUID()}`);
    await mkdir(join(copy.directory, "scratch"), { recursive: true, mode: 0o700 });
    await mkdir(control, { mode: 0o700 });
    try {
      const schemaPath = join(control, "schema.json"), catalogPath = join(control, "models.json");
      await writeFile(schemaPath, JSON.stringify(codexOutputSchema(schema)), { mode: 0o600 });
      await writeFile(catalogPath, runtime.catalog, { mode: 0o600 });
      const settings = [...REVIEW_AGENT_SETTINGS, ...reviewPermissionSettings(copy, runtime.executable, write, runtime.programs, reviewToolReadPaths(runtime.tools), runtime.extraCAFiles), shellSettings(copy, runtime.tools.map(tool => dirname(tool.executable)), this.environment), `model_catalog_json=${JSON.stringify(catalogPath)}`];
      const args = ["--ask-for-approval", "never", "exec", "--ephemeral", "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--output-schema", schemaPath, "--cd", copy.tree, ...(this.profile.model ? ["--model", this.profile.model] : []), ...settings.flatMap(s => ["-c", s]), "-"];
      const result = await this.runner.run({ provider: "codex-cli", model: this.profile.model ?? "codex-default", executable: runtime.launcher, args: [...runtime.leadingArgs, ...args], cwd: copy.tree, stdin: prompt, timeoutMs, maximumStdoutBytes: 32 * 1024 * 1024, maximumStderrBytes: 256 * 1024, environment: this.clientEnvironment(), ...(signal ? { signal } : {}) });
      reviewToolEvents(result.stdout);
      return result;
    } finally { await rm(control, { recursive: true, force: true }); }
  }
  private async quick(copy: ReviewCopy, runtime: ReviewRuntime, write: boolean, signal?: AbortSignal) {
    const control = join(copy.directory, `probe-control-${randomUUID()}`), canary = join(copy.directory, `private-${randomUUID()}`), allowed = join(copy.tree, `probe-${randomUUID()}`), outsideWrite = join(copy.directory, `outside-${randomUUID()}`);
    const program = join(control, "runtime-file"), adjacent = join(control, "runtime-private-canary");
    try {
      await mkdir(join(copy.directory, "scratch"), { recursive: true, mode: 0o700 });
      await mkdir(control, { mode: 0o700 });
      await mkdir(join(control, "codex"));
      await writeFile(canary, randomUUID(), { mode: 0o600 }); await writeFile(allowed, "workspace-canary\n");
      await writeFile(program, "program-read-canary\n", { mode: 0o600 });
      await writeFile(adjacent, randomUUID(), { mode: 0o600 });
      const catalog = join(control, "models.json"); await writeFile(catalog, runtime.catalog, { mode: 0o600 });
      const deny = (command: string, token: string) => `if ${command} >/dev/null 2>&1; then echo ${token}_LEAK; else echo ${token}_DENIED; fi`;
      const node = runtime.tools.find(tool => tool.name === "node");
      const command = [...(node ? [ `${quote(join(copy.directory, "tool-bin", "node"))} -e "process.stdout.write('LR_NODE_OK\\n')"` ] : []), `cat ${quote(allowed)}`, deny(`cat ${quote(canary)}`, "LR_READ"), `cat ${quote(program)}`, deny(`cat ${quote(adjacent)}`, "LR_PROGRAM"), deny(`printf changed >> ${quote(join(copy.git, "config"))}`, "LR_GIT"), deny(`printf changed > ${quote(outsideWrite)}`, "LR_OUTSIDE"), `if printf changed >> ${quote(allowed)} 2>/dev/null; then echo LR_WRITE_ALLOWED; else echo LR_WRITE_DENIED; fi`].join("; ");
      const settings = [...REVIEW_AGENT_SETTINGS, ...reviewPermissionSettings(copy, runtime.executable, write, [...runtime.programs, program], reviewToolReadPaths(runtime.tools), runtime.extraCAFiles), shellSettings(copy, runtime.tools.map(tool => dirname(tool.executable)), this.environment), `model_catalog_json=${JSON.stringify(catalog)}`];
      // sandbox has no --ignore-user-config/--ignore-rules options. An empty CODEX_HOME
      // removes user config; direct sandbox commands do not evaluate execpolicy rules.
      const environment = { ...this.clientEnvironment(), CODEX_HOME: join(control, "codex") };
      const result = await this.runner.run({ executable: runtime.launcher, args: [...runtime.leadingArgs, "sandbox", "--permission-profile", "lr", "--cd", copy.tree, ...settings.flatMap(s => ["-c", s]), "--", "/usr/bin/env", "-i", ...Object.entries(reviewToolEnvironment(copy, runtime.tools.map(tool => dirname(tool.executable)))).map(([key, value]) => `${key}=${value}`), "/bin/sh", "-c", command], cwd: copy.tree, stdin: "", timeoutMs: 30_000, maximumStdoutBytes: 16_000, maximumStderrBytes: 16_000, environment, ...(signal ? { signal } : {}) });
      if (!result.stdout.includes("workspace-canary") || !result.stdout.includes("program-read-canary") || (node && !result.stdout.includes("LR_NODE_OK")) || /LR_[A-Z]+_LEAK/u.test(result.stdout) || ["LR_READ_DENIED", "LR_PROGRAM_DENIED", "LR_GIT_DENIED", "LR_OUTSIDE_DENIED", write ? "LR_WRITE_ALLOWED" : "LR_WRITE_DENIED"].some(token => !result.stdout.includes(token))) throw new Error("读写金丝雀未满足全部边界。");
    } finally { await Promise.all([control, canary, allowed, outsideWrite].map(path => rm(path, { recursive: true, force: true }))); }
  }
  private async selfTest(copy: ReviewCopy, runtime: ReviewRuntime, signal?: AbortSignal) {
    if (checkedExecutors.has(runtime.fingerprint)) return;
    const canary = join(copy.directory, `exec-canary-${randomUUID()}`), git = new LocalReviewGit("/usr/bin/git", this.environment);
    const nonce = randomUUID(), secret = randomUUID(), outputPath = join(copy.tree, `.probe-result-${randomUUID()}.json`);
    try {
      if (!await git.isClean(copy, signal)) throw new Error("正式 exec 自检前副本不是干净的固定提交。");
      await writeFile(canary, secret, { mode: 0o600 });
      await this.quick(copy, runtime, true, signal);
      const command = `value=$(cat ${quote(canary)} 2>/dev/null); code=$?; printf '{"nonce":"${nonce}","exitCode":%s,"output":"%s"}\\n' "$code" "$value" > ${quote(outputPath)}`;
      const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };
      // ponytail: exec self-check covers command-tool access. Direct code-mode entry
      // points rely on separate tests/live probes, not on the model's safety claim.
      await this.raw(copy, schema, `LR_EXEC_SELFCHECK：原样执行给定 command，由这个命令生成结果文件。禁止另行读取其它文件、伪造或改写结果文件。完成后返回 {"ok":true}。\n${JSON.stringify({ command, outputPath, nonce })}`, true, runtime, signal, 120_000);
      const file = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let text: string;
      try { const info = await file.stat(); if (!info.isFile() || info.size > 16_000) throw new Error("exec 自检结果文件无效。"); text = await file.readFile("utf8"); } finally { await file.close(); }
      const result = JSON.parse(text);
      if (result.nonce !== nonce || typeof result.output !== "string" || !Number.isInteger(result.exitCode) || result.exitCode === 0 || text.includes(secret)) throw new Error("exec 自检未证明金丝雀读取被拒绝。");
      if ((await this.runtime(copy)).fingerprint !== runtime.fingerprint) throw new Error("CLI 或模型目录在自检期间发生变化。");
    } finally { await rm(outputPath, { force: true }); await rm(canary, { force: true }); }
    if (!await git.isClean(copy)) throw new Error("exec 自检改动了探针文件之外的副本内容。");
    checkedExecutors.add(runtime.fingerprint);
  }
  private async ready(copy: ReviewCopy, write: boolean, signal?: AbortSignal) {
    try {
      const runtime = await this.runtime(copy);
      await this.quick(copy, runtime, write, signal);
      await this.selfTest(copy, runtime, signal);
      if ((await this.runtime(copy)).fingerprint !== runtime.fingerprint) throw new Error("CLI 或模型目录在探测后发生变化。");
      return runtime;
    } catch (error) {
      signal?.throwIfAborted();
      const reason = error instanceof ManagedProcessError ? error.diagnosticExcerpt : error instanceof Error ? error.message : "未知错误";
      throw new Error(`Codex 权限或配置能力探测失败，已禁止调用；不会退回默认沙箱。${reason.slice(0, 2000)}`);
    }
  }
  private async invoke(copy: ReviewCopy, schema: Record<string, unknown>, prompt: string, write: boolean, signal?: AbortSignal) {
    const runtime = await this.ready(copy, write, signal);
    return this.raw(copy, schema, prompt, write, runtime, signal);
  }
  async capability(copy: ReviewCopy, signal?: AbortSignal) {
    await this.ready(copy, false, signal);
    await this.ready(copy, true, signal);
  }
  async evaluate(copy: ReviewCopy, annotations: ReviewAnnotation[], signal?: AbortSignal): Promise<ReviewEvaluation> {
    const deadline = AbortSignal.timeout(15 * 60_000);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const schema = reviewEvaluationJsonSchema;
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let output: string;
      // Transport/process failures are not malformed conclusions and are never retried here.
      output = (await this.invoke(copy, schema, reviewEvaluationPrompt(annotations), false, signal)).stdout;
      try {
        return reviewEvaluation(reviewAgentOutput(output), annotations.map(a => a.id));
      } catch (error) { signal?.throwIfAborted(); last = error; }
    }
    throw last;
  }
  // ponytail: dependency preparation can degrade; tests needing node_modules may
  // still be unavailable. Verification must state what was not run and why.
  /** Same read-only permission profile and per-call canary as evaluation (write=false); never a prompt-only restriction. */
  async discuss(view: ReviewCopy, request: DiscussionRequest, signal?: AbortSignal): Promise<DiscussionAnswer> {
    const deadline = AbortSignal.timeout(15 * 60_000);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = (await this.invoke(view, reviewDiscussionJsonSchema, `${attempt ? "上次结构化回答无效，请完整修正一次。\n" : ""}${request.system}\n${request.viewNotes}\n${request.input}`, false, signal)).stdout;
      try { return reviewDiscussion(reviewAgentOutput(output)); } catch (error) { signal?.throwIfAborted(); last = error; }
    }
    throw last;
  }
  async fix(copy: ReviewCopy, annotations: ReviewAnnotation[], signal?: AbortSignal, extra?: ReviewFixExtra): Promise<ReviewFix> {
    const result = await this.invoke(copy, reviewFixJsonSchema, reviewFixPrompt(annotations, extra), true, signal);
    return reviewFix(reviewAgentOutput(result.stdout), annotations.map(a => a.id));
  }
}
