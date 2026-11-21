import {
  modelProviderProfileSchema,
  type ModelProviderProfile,
  type NormalizedTokenUsage,
  type SemanticClassification,
  type StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { isAbsolute } from "node:path";
import { z } from "zod";

import type {
  SemanticClassifierInput,
  SemanticProviderAttempt,
} from "../../semantic/semantic-classifier.js";
import {
  createCliWorkspace,
  minimalClientEnvironment,
} from "../cli/cli-adapter-support.js";
import {
  ManagedChildProcessRunner,
  ManagedProcessError,
  type ManagedProcessRequest,
  type ManagedProcessResult,
} from "../cli/managed-child-process.js";
import { ModelProviderError } from "../http-model-transport.js";
import {
  MIN_GENERATION_TIMEOUT_MS,
  parseStructuredJson,
  type StructuredProviderAttempt,
} from "../structured-provider.js";
import {
  buildSemanticUserPrompt,
  SEMANTIC_PROMPT_VERSION,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../semantic-prompt.js";
import { parseSemanticOutput } from "./openai-responses-adapter.js";

interface ProcessRunnerLike {
  run(
    request: ManagedProcessRequest,
  ): Promise<ManagedProcessResult>;
}

export interface ClaudeCodeCliAdapterOptions {
  profile: ModelProviderProfile;
  runner?: ProcessRunnerLike;
  environment?: NodeJS.ProcessEnv;
}

const resultSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string().max(100),
    is_error: z.boolean(),
    duration_ms: z
      .number()
      .int()
      .nonnegative()
      .max(120_000)
      .optional(),
    duration_api_ms: z
      .number()
      .int()
      .nonnegative()
      .max(120_000)
      .optional(),
    result: z.string().max(20_000),
    structured_output: z.unknown().optional(),
    total_cost_usd: z.number().nonnegative().optional(),
    usage: z
      .object({
        input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        cache_read_input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        cache_creation_input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        output_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const normalizeUsage = (
  result: z.infer<typeof resultSchema>,
): NormalizedTokenUsage => {
  const outputTokens = result.usage?.output_tokens;
  const read = result.usage?.cache_read_input_tokens;
  const created =
    result.usage?.cache_creation_input_tokens;
  const cachedInputTokens =
    read === undefined && created === undefined
      ? undefined
      : (read ?? 0) + (created ?? 0);
  // Claude Code counts cache reads and writes apart from input_tokens; the rest of the app reads input as
  // including what was cached, as OpenAI reports it. Left apart, a call that read 17k tokens showed 65.
  const inputTokens =
    result.usage?.input_tokens === undefined
      ? undefined
      : result.usage.input_tokens + (cachedInputTokens ?? 0);
  const hasValue =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    result.total_cost_usd !== undefined;
  if (!hasValue) {
    return { source: "unavailable" };
  }
  return {
    source: "provider_reported",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
    ...(result.total_cost_usd === undefined
      ? {}
      : { costUsd: result.total_cost_usd }),
  };
};

const sameClassification = (
  left: SemanticClassification,
  right: SemanticClassification,
): boolean => JSON.stringify(left) === JSON.stringify(right);

export class ClaudeCodeCliAdapter {
  readonly id = "claude-code-cli" as const;
  readonly #profile: ModelProviderProfile;
  readonly #runner: ProcessRunnerLike;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: ClaudeCodeCliAdapterOptions) {
    const parsed = modelProviderProfileSchema.safeParse(
      options.profile,
    );
    if (
      !parsed.success ||
      parsed.data.kind !== "claude-code-cli" ||
      parsed.data.executablePath === undefined ||
      !isAbsolute(parsed.data.executablePath)
    ) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Claude Code CLI provider configuration is invalid",
      );
    }
    this.#profile = parsed.data;
    this.#runner =
      options.runner ?? new ManagedChildProcessRunner({ modelNetworkPolicy: "required" });
    this.#environment =
      options.environment ?? process.env;
  }

  async status() {
    return {
      id: this.id,
      availability: "available" as const,
      modelVersion: this.#profile.model ?? "claude-default",
      promptVersion: SEMANTIC_PROMPT_VERSION,
    };
  }

  async classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticClassification> {
    return (await this.invoke(input, signal)).classification;
  }

  async invoke(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticProviderAttempt> {
    const workspace = await createCliWorkspace(
      semanticOutputJsonSchema,
    );
    const model = this.#profile.model ?? "claude-default";
    const userPrompt = buildSemanticUserPrompt(input);
    const stdin = `${semanticSystemPrompt}\n\n${userPrompt}`;
    try {
      const processResult = await this.#runner.run({
        provider: this.#profile.kind,
        model,
        executable: this.#profile.executablePath!,
        args: [
          "-p",
          "--safe-mode",
          "--setting-sources",
          "",
          "--tools",
          "",
          "--disallowedTools",
          "mcp__*",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(semanticOutputJsonSchema),
          ...(this.#profile.model === undefined ? [] : ["--model", model]),
        ],
        stdin,
        cwd: workspace.directory,
        timeoutMs: this.#profile.timeoutMs,
        maximumStdoutBytes: 1_048_576,
        maximumStderrBytes: 65_536,
        environment: minimalClientEnvironment(
          this.#environment,
          ["CLAUDE_CONFIG_DIR"], this.#profile.proxy,
        ),
        ...(signal === undefined ? {} : { signal }),
      });
      let decoded: unknown;
      try {
        decoded = JSON.parse(processResult.stdout);
      } catch {
        throw new ModelProviderError(
          "invalid_output",
          "Claude Code returned malformed JSON",
        );
      }
      const parsed = resultSchema.safeParse(decoded);
      if (
        !parsed.success ||
        parsed.data.is_error ||
        parsed.data.subtype !== "success"
      ) {
        throw new ModelProviderError(
          "invalid_output",
          "Claude Code returned an unsuccessful result",
        );
      }
      const visibleClassification = parseSemanticOutput(
        parsed.data.result,
        this.id,
        model,
      );
      let classification = visibleClassification;
      if (parsed.data.structured_output !== undefined) {
        const structuredClassification =
          parseSemanticOutput(
            JSON.stringify(
              parsed.data.structured_output,
            ),
            this.id,
            model,
          );
        if (
          !sameClassification(
            visibleClassification,
            structuredClassification,
          )
        ) {
          throw new ModelProviderError(
            "invalid_output",
            "Claude Code visible and structured results disagree",
          );
        }
        classification = structuredClassification;
      }
      return {
        classification,
        visibleOutput: parsed.data.result,
        traceInput: {
          systemPrompt: semanticSystemPrompt,
          userPrompt,
          outputSchema: semanticOutputJsonSchema,
          clientSystemPromptVisibility: "opaque",
        },
        usage: normalizeUsage(parsed.data),
        providerDurationMs:
          parsed.data.duration_api_ms ??
          processResult.durationMs,
      };
    } catch (error) {
      if (
        error instanceof ManagedProcessError ||
        error instanceof ModelProviderError
      ) {
        throw error;
      }
      throw new ModelProviderError(
        "process_failed",
        "Claude Code CLI provider invocation failed",
      );
    } finally {
      await workspace.cleanup();
    }
  }

  async generate(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredProviderAttempt> {
    const workspace = await createCliWorkspace(
      request.outputSchema,
    );
    const model = this.#profile.model ?? "claude-default";
    const stdin = `${request.systemPrompt}\n\n${request.userPrompt}`;
    // The dialect zod names (draft 2020-12) is one Claude Code's --json-schema refuses outright, exit 1 before any call.
    const { $schema: _dialect, ...outputSchema } = request.outputSchema;
    try {
      const processResult = await this.#runner.run({
        provider: this.#profile.kind,
        model,
        executable: this.#profile.executablePath!,
        args: [
          "-p",
          "--safe-mode",
          "--setting-sources",
          "",
          "--tools",
          "",
          "--disallowedTools",
          "mcp__*",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(outputSchema),
          ...(this.#profile.model === undefined ? [] : ["--model", model]),
        ],
        stdin,
        cwd: workspace.directory,
        timeoutMs: Math.max(this.#profile.timeoutMs, MIN_GENERATION_TIMEOUT_MS),
        maximumStdoutBytes: 1_048_576,
        maximumStderrBytes: 65_536,
        environment: minimalClientEnvironment(
          this.#environment,
          ["CLAUDE_CONFIG_DIR"], this.#profile.proxy,
        ),
        ...(signal === undefined ? {} : { signal }),
      });
      let decoded: unknown;
      try {
        decoded = JSON.parse(processResult.stdout);
      } catch {
        throw new ModelProviderError(
          "invalid_output",
          "Claude Code returned malformed JSON",
        );
      }
      const parsed = resultSchema.safeParse(decoded);
      if (
        !parsed.success ||
        parsed.data.is_error ||
        parsed.data.subtype !== "success"
      ) {
        // A run that stopped short (error_max_turns, say) was still billed: what it cost goes with it.
        throw new ModelProviderError(
          "invalid_output",
          `Claude Code returned an unsuccessful result${parsed.success ? ` · subtype=${parsed.data.subtype}` : ""}`,
          parsed.success ? { usage: normalizeUsage(parsed.data) } : {},
        );
      }
      const visibleOutput = parseStructuredJson(
        parsed.data.result,
        undefined,
        undefined,
        normalizeUsage(parsed.data),
      );
      let parsedOutput = visibleOutput;
      if (parsed.data.structured_output !== undefined) {
        if (
          JSON.stringify(visibleOutput) !==
          JSON.stringify(parsed.data.structured_output)
        ) {
          throw new ModelProviderError(
            "invalid_output",
            "Claude Code visible and structured results disagree",
          );
        }
        parsedOutput = parsed.data.structured_output;
      }
      const usageModels = parsed.data.modelUsage && typeof parsed.data.modelUsage === "object" && !Array.isArray(parsed.data.modelUsage) ? Object.keys(parsed.data.modelUsage).filter(value => /^[\w./:-]{1,200}$/u.test(value)) : [];
      return {
        parsedOutput,
        visibleOutput: parsed.data.result,
        modelVersion: request.purpose === "local-review" && usageModels.length === 1 ? usageModels[0]! : model,
        traceInput: {
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          outputSchema: request.outputSchema,
          clientSystemPromptVisibility: "opaque",
        },
        usage: normalizeUsage(parsed.data),
        providerDurationMs:
          parsed.data.duration_api_ms ?? processResult.durationMs,
      };
    } catch (error) {
      if (
        error instanceof ManagedProcessError ||
        error instanceof ModelProviderError
      ) {
        Object.defineProperty(error, "traceInput", { value: { systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, outputSchema: request.outputSchema, clientSystemPromptVisibility: "opaque" }, enumerable: false, writable: true, configurable: true });
        throw error;
      }
      throw new ModelProviderError(
        "process_failed",
        "Claude Code CLI provider invocation failed",
      );
    } finally {
      await workspace.cleanup();
    }
  }

  async close(): Promise<void> {}
}
