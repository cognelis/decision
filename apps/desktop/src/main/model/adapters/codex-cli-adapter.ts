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

export interface CodexCliAdapterOptions {
  profile: ModelProviderProfile;
  runner?: ProcessRunnerLike;
  environment?: NodeJS.ProcessEnv;
}

const itemCompletedSchema = z
  .object({
    type: z.literal("item.completed"),
    item: z
      .object({
        type: z.string().max(100),
        text: z.string().max(20_000).optional(),
      })
      .passthrough(),
  })
  .passthrough();

const turnCompletedSchema = z
  .object({
    type: z.literal("turn.completed"),
    usage: z
      .object({
        input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        cached_input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        output_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        reasoning_output_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        total_tokens: z
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
  usage: z.infer<typeof turnCompletedSchema>["usage"],
): NormalizedTokenUsage => {
  const inputTokens = usage?.input_tokens;
  const outputTokens = usage?.output_tokens;
  const totalTokens = usage?.total_tokens;
  const cachedInputTokens = usage?.cached_input_tokens;
  const reasoningOutputTokens =
    usage?.reasoning_output_tokens;
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined ||
    totalTokens !== inputTokens + outputTokens ||
    (cachedInputTokens ?? 0) > inputTokens ||
    (reasoningOutputTokens ?? 0) > outputTokens
  ) {
    return { source: "unavailable" };
  }
  return {
    source: "provider_reported",
    inputTokens,
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens }),
    outputTokens,
    ...(reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens }),
    totalTokens,
  };
};

const parseProcessOutput = (
  stdout: string,
): {
  visibleOutput: string;
  usage: NormalizedTokenUsage;
} => {
  let visibleOutput: string | undefined;
  let usage: z.infer<typeof turnCompletedSchema>["usage"];
  const lines = stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > 10_000) {
    throw new ModelProviderError(
      "invalid_output",
      "Codex returned no bounded JSONL events",
    );
  }
  for (const line of lines) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new ModelProviderError(
        "invalid_output",
        "Codex returned malformed JSONL",
      );
    }
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      !("type" in decoded)
    ) {
      throw new ModelProviderError(
        "invalid_output",
        "Codex returned an invalid JSONL event",
      );
    }
    if (decoded.type === "item.completed") {
      const event = itemCompletedSchema.safeParse(decoded);
      if (!event.success) {
        throw new ModelProviderError(
          "invalid_output",
          "Codex returned an invalid completed item",
        );
      }
      if (
        event.data.item.type === "agent_message" &&
        event.data.item.text !== undefined
      ) {
        visibleOutput = event.data.item.text;
      }
    } else if (decoded.type === "turn.completed") {
      const event = turnCompletedSchema.safeParse(decoded);
      if (!event.success) {
        throw new ModelProviderError(
          "invalid_output",
          "Codex returned invalid turn usage",
        );
      }
      usage = event.data.usage;
    }
  }
  if (visibleOutput === undefined) {
    throw new ModelProviderError(
      "invalid_output",
      "Codex returned no final agent message",
    );
  }
  return {
    visibleOutput,
    usage: normalizeUsage(usage),
  };
};

const parseOutput = (
  stdout: string,
  model: string,
): {
  classification: SemanticClassification;
  visibleOutput: string;
  usage: NormalizedTokenUsage;
} => {
  const output = parseProcessOutput(stdout);
  return {
    ...output,
    classification: parseSemanticOutput(
      output.visibleOutput,
      "codex-cli",
      model,
    ),
  };
};

export class CodexCliAdapter {
  readonly id = "codex-cli" as const;
  readonly #profile: ModelProviderProfile;
  readonly #runner: ProcessRunnerLike;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: CodexCliAdapterOptions) {
    const parsed = modelProviderProfileSchema.safeParse(
      options.profile,
    );
    if (
      !parsed.success ||
      parsed.data.kind !== "codex-cli" ||
      parsed.data.executablePath === undefined ||
      !isAbsolute(parsed.data.executablePath)
    ) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Codex CLI provider configuration is invalid",
      );
    }
    this.#profile = parsed.data;
    this.#runner =
      options.runner ?? new ManagedChildProcessRunner();
    this.#environment =
      options.environment ?? process.env;
  }

  async status() {
    return {
      id: this.id,
      availability: "available" as const,
      modelVersion:
        this.#profile.model ?? "gpt-5.6-terra",
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
    const model =
      this.#profile.model ?? "gpt-5.6-terra";
    const userPrompt = buildSemanticUserPrompt(input);
    const stdin = `${semanticSystemPrompt}\n\n${userPrompt}`;
    try {
      const processResult = await this.#runner.run({
        executable: this.#profile.executablePath!,
        args: [
          "--ask-for-approval",
          "never",
          "exec",
          "--ephemeral",
          "--json",
          "--ignore-user-config",
          "--output-schema",
          workspace.schemaPath,
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--cd",
          workspace.directory,
          "-c",
          "features.shell_tool=false",
          "-c",
          "tools.web_search=false",
          "-c",
          "apps._default.enabled=false",
          "-c",
          "agents.enabled=false",
          "-c",
          "memories.generate_memories=false",
          "--model",
          model,
          "-",
        ],
        stdin,
        cwd: workspace.directory,
        timeoutMs: this.#profile.timeoutMs,
        maximumStdoutBytes: 1_048_576,
        maximumStderrBytes: 65_536,
        environment: minimalClientEnvironment(
          this.#environment,
        ),
        ...(signal === undefined ? {} : { signal }),
      });
      const parsed = parseOutput(
        processResult.stdout,
        model,
      );
      return {
        classification: parsed.classification,
        visibleOutput: parsed.visibleOutput,
        traceInput: {
          systemPrompt: semanticSystemPrompt,
          userPrompt,
          outputSchema: semanticOutputJsonSchema,
          clientSystemPromptVisibility: "opaque",
        },
        usage: parsed.usage,
        providerDurationMs: processResult.durationMs,
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
        "Codex CLI provider invocation failed",
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
    const model =
      this.#profile.model ?? "gpt-5.6-terra";
    const stdin = `${request.systemPrompt}\n\n${request.userPrompt}`;
    try {
      const processResult = await this.#runner.run({
        executable: this.#profile.executablePath!,
        args: [
          "--ask-for-approval",
          "never",
          "exec",
          "--ephemeral",
          "--json",
          "--ignore-user-config",
          "--output-schema",
          workspace.schemaPath,
          "--sandbox",
          "read-only",
          "--skip-git-repo-check",
          "--cd",
          workspace.directory,
          "-c",
          "features.shell_tool=false",
          "-c",
          "tools.web_search=false",
          "-c",
          "apps._default.enabled=false",
          "-c",
          "agents.enabled=false",
          "-c",
          "memories.generate_memories=false",
          "--model",
          model,
          "-",
        ],
        stdin,
        cwd: workspace.directory,
        timeoutMs: this.#profile.timeoutMs,
        maximumStdoutBytes: 1_048_576,
        maximumStderrBytes: 65_536,
        environment: minimalClientEnvironment(
          this.#environment,
        ),
        ...(signal === undefined ? {} : { signal }),
      });
      const parsed = parseProcessOutput(processResult.stdout);
      return {
        parsedOutput: parseStructuredJson(parsed.visibleOutput),
        visibleOutput: parsed.visibleOutput,
        modelVersion: model,
        traceInput: {
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          outputSchema: request.outputSchema,
          clientSystemPromptVisibility: "opaque",
        },
        usage: parsed.usage,
        providerDurationMs: processResult.durationMs,
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
        "Codex CLI provider invocation failed",
      );
    } finally {
      await workspace.cleanup();
    }
  }

  async close(): Promise<void> {}
}
