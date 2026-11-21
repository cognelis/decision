import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, realpath, readlink, rm, rmdir, stat, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import type { ModelProviderProfile } from "@cognelis/decision-protocol";
import { ManagedChildProcessRunner, ManagedProcessError } from "./model/cli/managed-child-process.js";
import { minimalClientEnvironment } from "./model/cli/cli-adapter-support.js";
import { resolveReviewTools, reviewExtraCAFiles } from "./local-review-tools.js";
import type { ReviewCopy } from "./local-review-git.js";
import { reviewEvaluation, reviewFix, reviewEvaluationJsonSchema, reviewFixJsonSchema, reviewEvaluationPrompt, reviewFixPrompt, reviewDiscussion, reviewDiscussionJsonSchema, type DiscussionAnswer, type DiscussionRequest, type LocalReviewWorker, type ReviewAnnotation, type ReviewEvaluation, type ReviewFix, type ReviewFixExtra } from "./local-review-worker.js";
import { claudeReviewSettings, claudeReviewArguments, claudeReviewOutput, validateClaudeToolStage, type ClaudeReviewRuntime } from "./local-review-claude-runtime.js";
import { probeClaudeReview } from "./local-review-claude-probe.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const checked = new Set<string>();

export class ClaudeReviewWorker implements LocalReviewWorker {
  constructor(readonly profile: ModelProviderProfile, private readonly environment: NodeJS.ProcessEnv = process.env, private readonly runner = new ManagedChildProcessRunner({ modelNetworkPolicy: "required" })) {
    if (profile.kind !== "claude-code-cli" || !profile.enabled || !profile.executablePath) throw new Error("请选择已启用的 Claude Code CLI 档案。");
  }
  private clientEnvironment() { return minimalClientEnvironment(this.environment, ["CLAUDE_CONFIG_DIR"], this.profile.proxy); }
  private async runtime(copy: ReviewCopy, signal?: AbortSignal): Promise<ClaudeReviewRuntime> {
    if (process.platform !== "darwin") throw new Error("当前平台尚未通过 Claude 原生审阅读隔离验证。");
    signal?.throwIfAborted();
    const executable = await realpath(this.profile.executablePath!); await access(executable, constants.X_OK);
    const environment = this.clientEnvironment(), home = await realpath(environment.HOME ?? "");
    const configs = [join(home, ".claude"), join(home, ".claude.json"), ...(environment.CLAUDE_CONFIG_DIR ? [await realpath(environment.CLAUDE_CONFIG_DIR).catch(() => resolve(environment.CLAUDE_CONFIG_DIR!))] : [])];
    const tools = await resolveReviewTools(copy.directory, this.environment, this.runner, environment, signal);
    if (!["node", "python3"].every(name => tools.some(tool => tool.name === name))) throw new Error("Claude 自检需要可用的 Node 和 Python 工具链。");
    const found = await this.runner.run({ executable: "/usr/bin/xcrun", args: ["--find", "git"], stdin: "", cwd: copy.directory, timeoutMs: 10_000, maximumStdoutBytes: 16000, maximumStderrBytes: 16000, environment, ...(signal ? { signal } : {}) });
    const git = await realpath(found.stdout.trim()); await access(git, constants.X_OK);
    const runtime: ClaudeReviewRuntime = { executable, tools, git, home, extraCAFiles: await reviewExtraCAFiles(this.environment), ...(this.environment.NODE_EXTRA_CA_CERTS !== undefined ? { extraCA: this.environment.NODE_EXTRA_CA_CERTS } : {}), configs: [...new Set(configs)], fingerprint: "" };
    const identities = await Promise.all([...new Set([executable, git, ...tools.map(tool => tool.executable)])].map(async path => { const info = await stat(path); return { path, size: info.size, mtimeMs: info.mtimeMs }; }));
    const normalized = { directory: "/LR_JOB", tree: "/LR_TREE", git: "/LR_GIT" };
    runtime.fingerprint = digest({ schemas: [reviewEvaluationJsonSchema, reviewFixJsonSchema, reviewDiscussionJsonSchema], identities, platform: process.platform, model: this.profile.model, environment: { HOME: home, CLAUDE_CONFIG_DIR: environment.CLAUDE_CONFIG_DIR, MODEL_PROXY_URL: environment.MODEL_PROXY_URL, HTTPS_PROXY: environment.HTTPS_PROXY },
      argv: claudeReviewArguments(claudeReviewSettings(normalized, runtime, "/LR_TMP", true, Object.keys(environment)), {}, "/LR_JOB/scratch", this.profile.model),
      readSettings: claudeReviewSettings(normalized, runtime, "/LR_TMP", false, Object.keys(environment)),
    });
    return runtime;
  }
  private async raw(copy: ReviewCopy, schema: Record<string, unknown>, prompt: string, write: boolean, runtime: ClaudeReviewRuntime, signal?: AbortSignal, timeoutMs = write ? 45 * 60_000 : 15 * 60_000) {
    signal?.throwIfAborted();
    const scratch = join(copy.directory, "scratch"), bin = join(copy.directory, "tool-bin");
    await mkdir(scratch, { recursive: true, mode: 0o700 }); await mkdir(bin, { recursive: true, mode: 0o700 });
    for (const tool of [...runtime.tools, { name: "git", executable: runtime.git }]) {
      const path = join(bin, tool.name);
      if (await readlink(path).catch(() => null) !== tool.executable) { await rm(path, { force: true }); await symlink(tool.executable, path); }
    }
    const alias = await mkdtemp("/private/tmp/lrc-"); await rmdir(alias); await symlink(scratch, alias);
    try {
      if (await realpath(alias) !== await realpath(scratch)) throw new Error("Claude 临时目录别名不匹配。");
      await mkdir(join(scratch, `claude-${process.getuid?.() ?? "user"}`), { recursive: true, mode: 0o700 });
      const base = this.clientEnvironment(), settings = claudeReviewSettings(copy, runtime, alias, write, Object.keys(base));
      const result = await this.runner.run({ provider: "claude-code-cli", model: this.profile.model ?? "claude-default", executable: runtime.executable,
        args: claudeReviewArguments(settings, schema, scratch, this.profile.model), stdin: prompt, cwd: copy.tree,
        environment: { ...base, ...settings.env, HOME: runtime.home, TMPDIR: alias, CLAUDE_CODE_TMPDIR: alias, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" },
        timeoutMs, maximumStdoutBytes: 32 * 1024 * 1024, maximumStderrBytes: 256 * 1024, ...(signal ? { signal } : {}),
      });
      if (await realpath(alias) !== await realpath(scratch)) throw new Error("Claude 运行期间临时目录别名发生变化。");
      const output = claudeReviewOutput(result.stdout); validateClaudeToolStage(output, write);
      return { ...output, stdout: result.stdout };
    } finally { await rm(alias, { force: true }); }
  }
  private async ready(copy: ReviewCopy, signal?: AbortSignal) {
    try {
      const runtime = await this.runtime(copy, signal);
      if (!checked.has(runtime.fingerprint)) {
        await probeClaudeReview(copy, runtime, this.raw.bind(this), false, signal);
        await probeClaudeReview(copy, runtime, this.raw.bind(this), true, signal);
        if ((await this.runtime(copy, signal)).fingerprint !== runtime.fingerprint) throw new Error("Claude 可执行文件或权限配置在自检期间变化。");
        checked.add(runtime.fingerprint);
      }
      return runtime;
    } catch (error) {
      signal?.throwIfAborted();
      const reason = error instanceof ManagedProcessError ? error.diagnosticExcerpt || error.message : error instanceof Error ? error.message : "未知错误";
      throw new Error(`Claude 权限或配置能力自检失败，已禁止调用；不会回退默认或无沙箱执行。${reason.slice(0, 1600)}`);
    }
  }
  async capability(copy: ReviewCopy, signal?: AbortSignal) { await this.ready(copy, signal); }
  async evaluate(copy: ReviewCopy, annotations: ReviewAnnotation[], signal?: AbortSignal): Promise<ReviewEvaluation> {
    const deadline = AbortSignal.timeout(15 * 60_000); signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const runtime = await this.ready(copy, signal); let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await this.raw(copy, reviewEvaluationJsonSchema, `${attempt ? "上次结构化结论无效，请完整修正一次。\n" : ""}${reviewEvaluationPrompt(annotations)}`, false, runtime, signal);
      try { return { ...reviewEvaluation(output.result, annotations.map(a => a.id)), actualModel: output.model, actualBackend: "claude-code-cli" }; }
      catch (error) { last = error; }
    }
    throw new Error(`Claude 两次评估结论未通过校验：${last instanceof Error ? last.message.slice(0, 1000) : "结果无效"}`);
  }
  /** Same settings as evaluation: Edit/Write and tree writes denied, Git metadata read-only, sandboxed Bash with no network. */
  async discuss(view: ReviewCopy, request: DiscussionRequest, signal?: AbortSignal): Promise<DiscussionAnswer> {
    const deadline = AbortSignal.timeout(15 * 60_000); signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const runtime = await this.ready(view, signal); let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await this.raw(view, reviewDiscussionJsonSchema, `${attempt ? "上次结构化回答无效，请完整修正一次。\n" : ""}${request.system}\n${request.viewNotes}\n${request.input}`, false, runtime, signal);
      try { return { ...reviewDiscussion(output.result), actualModel: output.model, actualBackend: "claude-code-cli" }; }
      catch (error) { last = error; }
    }
    throw new Error(`Claude 两次讨论回答未通过校验：${last instanceof Error ? last.message.slice(0, 1000) : "结果无效"}`);
  }
  async fix(copy: ReviewCopy, annotations: ReviewAnnotation[], signal?: AbortSignal, extra?: ReviewFixExtra): Promise<ReviewFix> {
    const deadline = AbortSignal.timeout(45 * 60_000); signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const runtime = await this.ready(copy, signal); let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const output = await this.raw(copy, reviewFixJsonSchema, `${attempt ? "上次结构化结论无效，请完整修正一次。\n" : ""}修改前后均运行本组现有测试，verification 分别记录命令、结果和退出码。\n${reviewFixPrompt(annotations, extra)}`, true, runtime, signal);
      try { return { ...reviewFix(output.result, annotations.map(a => a.id)), actualModel: output.model, actualBackend: "claude-code-cli" }; }
      catch (error) { last = error; }
    }
    throw new Error(`Claude 两次修改结论未通过校验：${last instanceof Error ? last.message.slice(0, 1000) : "结果无效"}`);
  }
}
