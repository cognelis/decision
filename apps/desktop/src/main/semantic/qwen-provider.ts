import {
  semanticClassificationSchema,
  type NormalizedTokenUsage,
  type SemanticClassification,
  type StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { homedir } from "node:os";

import {
  buildSemanticUserPrompt,
  qwenSemanticOutputJsonSchema,
  SEMANTIC_PROMPT_VERSION,
  semanticSystemPrompt,
} from "../model/semantic-prompt.js";
import { malformedJsonShape, MIN_GENERATION_TIMEOUT_MS, type StructuredProviderAttempt } from "../model/structured-provider.js";
import {
  QWEN_MODEL_MANIFEST,
  qwenModelManifest,
  verifyQwenModel,
  type QwenModelVerification,
  type QwenModelManifest,
} from "./model-manifest.js";
import type {
  SemanticClassifier,
  SemanticClassifierInput,
  SemanticProviderAttempt,
  SemanticProviderStatus,
} from "./semantic-classifier.js";

const DEFAULT_TIMEOUT_MS = 5_000;

const QWEN_MAX_OUTPUT_TOKENS = 512;
const QWEN_MAX_STRUCTURED_OUTPUT_TOKENS = 1_024;

// llama.cpp expands string length bounds into repetitions and rejects large limits.
// Keep the original schema for tracing/application validation; the grammar enforces shape.
export function qwenGenerationSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const stringType = object.type === "string" || (Array.isArray(object.type) && object.type.includes("string"));
    return Object.fromEntries(Object.entries(object).filter(([key]) => !stringType || (key !== "maxLength" && key !== "minLength")).map(([key, item]) => [key, visit(item)]));
  };
  return visit(schema) as Record<string, unknown>;
}

interface QwenSession {
  prompt(
    prompt: string,
    options: {
      grammar: unknown;
      maxTokens: number;
      signal: AbortSignal;
      temperature: number;
    },
  ): Promise<string>;
  resetChatHistory?(): void;
  dispose(): void;
}

interface QwenTokenMeter {
  getState(): {
    usedInputTokens: number;
    usedOutputTokens: number;
  };
}

interface QwenSequence {
  tokenMeter?: QwenTokenMeter;
}

interface QwenContext {
  getSequence(): QwenSequence;
  dispose(): Promise<void>;
}

interface QwenModel {
  createContext(options: {
    contextSize: number;
    sequences: number;
  }): Promise<QwenContext>;
  dispose(): Promise<void>;
}

interface QwenLlama {
  loadModel(options: { modelPath: string }): Promise<QwenModel>;
  createGrammarForJsonSchema(
    schema: Record<string, unknown>,
  ): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface QwenRuntimeModule {
  getLlama(options: {
    build: "never";
    gpu: "auto";
    skipDownload: true;
    progressLogs: false;
    logger: (level: unknown, message: string) => void;
  }): Promise<QwenLlama>;
  LlamaChatSession: new (options: {
    contextSequence: unknown;
    systemPrompt: string;
  }) => QwenSession;
}

interface QwenResources {
  llama: QwenLlama;
  model: QwenModel;
  context: QwenContext;
  sequence: QwenSequence;
  session: QwenSession;
  grammar: unknown;
  createSession(systemPrompt: string): QwenSession;
}

const MAX_DIAGNOSTIC_LENGTH = 2_000;

const replaceEvery = (
  value: string,
  search: string,
  replacement: string,
): string =>
  search.length === 0
    ? value
    : value.split(search).join(replacement);

const safeRuntimeDiagnostic = (
  error: unknown,
  sensitivePaths: string[],
): string => {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown local runtime error";
  let value = raw
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
      "Bearer [redacted]",
    )
    .replace(
      /\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}/giu,
      "[redacted]",
    );
  for (const path of [...sensitivePaths]
    .filter((candidate) => candidate.length > 0)
    .sort((left, right) => right.length - left.length)) {
    value = replaceEvery(
      value,
      path,
      path === homedir()
        ? "[home]"
        : "[model-directory]",
    );
  }
  return value.trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
};

export class QwenProviderError extends Error {
  readonly code:
    | "model_missing"
    | "checksum_failed"
    | "output_limit"
    | "provider_invalid_output"
    | "runtime_unavailable"
    | "invalid_configuration"
    | "timeout";
  readonly diagnosticExcerpt: string;
  readonly usage: NormalizedTokenUsage | undefined;

  constructor(
    code: QwenProviderError["code"],
    message: string,
    options: {
      diagnosticExcerpt?: string;
      usage?: NormalizedTokenUsage;
    } = {},
  ) {
    super(message);
    this.name = "QwenProviderError";
    this.code = code;
    this.diagnosticExcerpt = (
      options.diagnosticExcerpt ?? message
    ).slice(0, MAX_DIAGNOSTIC_LENGTH);
    this.usage = options.usage;
  }
}

export interface QwenModelProviderOptions {
  modelsDirectory: string;
  model?: string;
  verifyModel?: (options: {
    modelsDirectory: string;
  }) => Promise<QwenModelVerification>;
  loadRuntime?: () => Promise<QwenRuntimeModule>;
  timeoutMs?: number;
}

const defaultRuntimeLoader =
  async (): Promise<QwenRuntimeModule> =>
    (await import(
      "node-llama-cpp"
    )) as unknown as QwenRuntimeModule;

const abortError = (): Error => {
  const error = new Error("Qwen classification aborted");
  error.name = "AbortError";
  return error;
};

const isAborted = (signal?: AbortSignal): boolean =>
  signal?.aborted === true;

export class QwenModelProvider implements SemanticClassifier {
  readonly id = "qwen" as const;
  // One inference at a time (#inferenceTail), each timed by #promptWithDeadline as it starts. ponytail: loading
  // the model has no timer of its own, only the caller's cancellation; time it too if a load is ever seen to hang.
  readonly queuesCalls = true;

  readonly #modelsDirectory: string;
  readonly #verifyModel: NonNullable<
    QwenModelProviderOptions["verifyModel"]
  >;
  readonly #loadRuntime: NonNullable<
    QwenModelProviderOptions["loadRuntime"]
  >;
  #timeoutMs: number;
  #manifest: QwenModelManifest = QWEN_MODEL_MANIFEST;
  readonly #activeControllers = new Set<AbortController>();

  #resources: Promise<QwenResources> | undefined;
  #resourcesModelId: string | undefined;
  #inferenceTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: QwenModelProviderOptions) {
    this.#modelsDirectory = options.modelsDirectory;
    this.#manifest = qwenModelManifest(options.model ?? QWEN_MODEL_MANIFEST.id);
    this.#verifyModel = options.verifyModel ?? ((input) => verifyQwenModel({ ...input, manifest: this.#manifest }));
    this.#loadRuntime =
      options.loadRuntime ?? defaultRuntimeLoader;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  setTimeoutMs(timeoutMs: number): void {
    this.#timeoutMs = timeoutMs;
  }

  setModel(model: string): void {
    this.#manifest = qwenModelManifest(model);
  }

  async status(): Promise<SemanticProviderStatus> {
    if (this.#closed) {
      return {
        id: this.id,
        availability: "runtime_unavailable",
        promptVersion: SEMANTIC_PROMPT_VERSION,
      };
    }
    const verification = await this.#verifyModel({
      modelsDirectory: this.#modelsDirectory,
    });
    return {
      id: this.id,
      availability: verification.availability,
      modelVersion: verification.availability === "available" ? verification.manifest.id : this.#manifest.id,
      promptVersion: SEMANTIC_PROMPT_VERSION,
    };
  }

  classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticClassification> {
    return this.invoke(input, signal).then(
      (attempt) => attempt.classification,
    );
  }

  invoke(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticProviderAttempt> {
    const attempt = this.#inferenceTail.then(() =>
      this.#invokeNow(input, signal),
    );
    this.#inferenceTail = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  generate(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredProviderAttempt> {
    const attempt = this.#inferenceTail.then(() =>
      this.#generateNow(request, signal),
    );
    this.#inferenceTail = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const controller of this.#activeControllers) {
      controller.abort();
    }

    await this.#releaseResources();
  }

  async #releaseResources(): Promise<void> {
    if (this.#resources === undefined) {
      return;
    }
    let resources: QwenResources;
    try {
      resources = await this.#resources;
    } catch {
      return;
    }
    resources.session.dispose();
    await resources.context.dispose();
    await resources.model.dispose();
    await resources.llama.dispose();
    this.#resources = undefined;
    this.#resourcesModelId = undefined;
  }

  async #invokeNow(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticProviderAttempt> {
    if (this.#closed) {
      throw new QwenProviderError(
        "runtime_unavailable",
        "Qwen provider is closed",
      );
    }
    if (isAborted(signal)) {
      throw abortError();
    }

    const verification = await this.#verifyModel({
      modelsDirectory: this.#modelsDirectory,
    });
    if (verification.availability !== "available") {
      throw new QwenProviderError(
        verification.availability,
        "The managed Qwen model is unavailable",
      );
    }

    let resources: QwenResources;
    try {
      resources = await this.#getResources(verification);
    } catch (error) {
      if (error instanceof QwenProviderError) {
        throw error;
      }
      throw new QwenProviderError(
        "runtime_unavailable",
        "Unable to initialize the local Qwen runtime",
        {
          diagnosticExcerpt: `Qwen runtime initialization failed: ${safeRuntimeDiagnostic(
            error,
            [this.#modelsDirectory, homedir()],
          )}`,
        },
      );
    }
    if (this.#closed) {
      throw new QwenProviderError(
        "runtime_unavailable",
        "Qwen provider is closed",
      );
    }
    if (isAborted(signal)) {
      throw abortError();
    }

    const controller = new AbortController();
    this.#activeControllers.add(controller);
    const removeExternalAbort =
      signal === undefined
        ? undefined
        : (() => {
            const onAbort = () => controller.abort();
            signal.addEventListener("abort", onAbort, {
              once: true,
            });
            return () =>
              signal.removeEventListener("abort", onAbort);
          })();

    try {
      const userPrompt = buildSemanticUserPrompt(input);
      const usageBefore = this.#tokenState(resources.sequence);
      const providerStartedAt = Date.now();
      const output = await this.#promptWithDeadline(
        resources.session,
        resources.grammar,
        userPrompt,
        QWEN_MAX_OUTPUT_TOKENS,
        this.#timeoutMs,
        controller,
        signal,
      );
      const providerDurationMs = Math.max(
        0,
        Date.now() - providerStartedAt,
      );
      const usageAfter = this.#tokenState(resources.sequence);
      const usage = this.#tokenUsage(usageBefore, usageAfter);
      let decoded: unknown;
      try {
        decoded = JSON.parse(output);
      } catch {
        if (
          usage.source === "runtime_measured" &&
          (usage.outputTokens ?? 0) >=
            QWEN_MAX_OUTPUT_TOKENS
        ) {
          throw new QwenProviderError(
            "output_limit",
            "Qwen output exceeded its generation budget",
            {
              diagnosticExcerpt:
                "Qwen output reached the 512-token limit before completing valid JSON",
              usage,
            },
          );
        }
        throw new QwenProviderError(
          "provider_invalid_output",
          "Qwen returned malformed JSON",
          {
            // By shape, as the other providers say it: V8's message quotes the text it could not parse, and the
            // excerpt is kept with trace content turned off.
            diagnosticExcerpt: `Qwen output was not valid JSON · ${malformedJsonShape(output)}`,
            usage,
          },
        );
      }
      const result = semanticClassificationSchema.safeParse({
        ...(decoded as Record<string, unknown>),
        provider: this.id,
        modelVersion: verification.manifest.id,
        promptVersion: SEMANTIC_PROMPT_VERSION,
      });
      if (!result.success) {
        throw new QwenProviderError(
          "provider_invalid_output",
          "Qwen returned an invalid semantic classification",
          {
            diagnosticExcerpt: `Qwen output did not match the semantic schema: ${result.error.issues
              .slice(0, 3)
              .map(
                (issue) =>
                  `${issue.path.join(".") || "output"}: ${issue.message}`,
              )
              .join("; ")}`,
          },
        );
      }
      return {
        classification: result.data,
        visibleOutput: output,
        traceInput: {
          systemPrompt: semanticSystemPrompt,
          userPrompt,
          outputSchema: qwenSemanticOutputJsonSchema,
          clientSystemPromptVisibility: "visible",
        },
        usage,
        providerDurationMs,
      };
    } finally {
      removeExternalAbort?.();
      this.#activeControllers.delete(controller);
      resources.session.resetChatHistory?.();
    }
  }

  async #generateNow(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredProviderAttempt> {
    if (this.#closed) {
      throw new QwenProviderError(
        "runtime_unavailable",
        "Qwen provider is closed",
      );
    }
    if (isAborted(signal)) {
      throw abortError();
    }

    const verification = await this.#verifyModel({
      modelsDirectory: this.#modelsDirectory,
    });
    if (verification.availability !== "available") {
      throw new QwenProviderError(
        verification.availability,
        "The managed Qwen model is unavailable",
      );
    }

    let resources: QwenResources;
    try {
      resources = await this.#getResources(verification);
    } catch (error) {
      if (error instanceof QwenProviderError) {
        throw error;
      }
      throw new QwenProviderError(
        "runtime_unavailable",
        "Unable to initialize the local Qwen runtime",
        {
          diagnosticExcerpt: `Qwen runtime initialization failed: ${safeRuntimeDiagnostic(
            error,
            [this.#modelsDirectory, homedir()],
          )}`,
        },
      );
    }
    if (this.#closed) {
      throw new QwenProviderError(
        "runtime_unavailable",
        "Qwen provider is closed",
      );
    }
    if (isAborted(signal)) {
      throw abortError();
    }

    const controller = new AbortController();
    this.#activeControllers.add(controller);
    const removeExternalAbort =
      signal === undefined
        ? undefined
        : (() => {
            const onAbort = () => controller.abort();
            signal.addEventListener("abort", onAbort, {
              once: true,
            });
            return () =>
              signal.removeEventListener("abort", onAbort);
          })();
    const maxOutputTokens = Math.min(
      request.maxOutputTokens,
      QWEN_MAX_STRUCTURED_OUTPUT_TOKENS,
    );
    let session: QwenSession | undefined;
    try {
      let grammar: unknown;
      try {
        grammar = await resources.llama.createGrammarForJsonSchema(qwenGenerationSchema(request.outputSchema));
      } catch {
        throw new QwenProviderError("invalid_configuration", "本机 Qwen 无法编译本次结构化输出格式，请更新应用或选择其他模型。", { diagnosticExcerpt: "Qwen structured output grammar compilation failed" });
      }
      session = resources.createSession(request.systemPrompt);
      const usageBefore = this.#tokenState(resources.sequence);
      const providerStartedAt = Date.now();
      const output = await this.#promptWithDeadline(
        session,
        grammar,
        request.userPrompt,
        maxOutputTokens,
        // Whatever the gateway allowed this call, with the profile's value as
        // the floor: a reader waiting on an answer is not the capture path.
        Math.max(this.#timeoutMs, MIN_GENERATION_TIMEOUT_MS),
        controller,
        signal,
      );
      const providerDurationMs = Math.max(
        0,
        Date.now() - providerStartedAt,
      );
      const usageAfter = this.#tokenState(resources.sequence);
      const usage = this.#tokenUsage(usageBefore, usageAfter);
      let parsedOutput: unknown;
      try {
        parsedOutput = JSON.parse(output) as unknown;
      } catch {
        if (
          usage.source === "runtime_measured" &&
          (usage.outputTokens ?? 0) >= maxOutputTokens
        ) {
          throw new QwenProviderError(
            "output_limit",
            "Qwen output exceeded its generation budget",
            {
              diagnosticExcerpt: `Qwen output reached the ${maxOutputTokens}-token limit before completing valid JSON`,
              usage,
            },
          );
        }
        throw new QwenProviderError(
          "provider_invalid_output",
          "Qwen returned malformed structured JSON",
          {
            diagnosticExcerpt: `Qwen output was not valid JSON · ${malformedJsonShape(output)}`,
            usage,
          },
        );
      }
      return {
        parsedOutput,
        visibleOutput: output,
        modelVersion: verification.manifest.id,
        traceInput: {
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          outputSchema: request.outputSchema,
          clientSystemPromptVisibility: "visible",
        },
        usage,
        providerDurationMs,
      };
    } finally {
      removeExternalAbort?.();
      this.#activeControllers.delete(controller);
      session?.dispose();
    }
  }

  async #getResources(
    verification: Extract<
      QwenModelVerification,
      { availability: "available" }
    >,
  ): Promise<QwenResources> {
    // Calls are serialized; switching releases the old model only after its inference finishes.
    if (this.#resources !== undefined && this.#resourcesModelId !== verification.manifest.id) await this.#releaseResources();
    if (this.#closed) throw new QwenProviderError("runtime_unavailable", "Qwen provider is closed");
    if (this.#resources === undefined) {
      this.#resourcesModelId = verification.manifest.id;
      this.#resources = (async () => {
        const runtime = await this.#loadRuntime();
        const llama = await runtime.getLlama({
          build: "never",
          gpu: "auto",
          skipDownload: true,
          progressLogs: false,
          logger: () => undefined,
        });
        let model: QwenModel | undefined;
        let context: QwenContext | undefined;
        let session: QwenSession | undefined;
        try {
          model = await llama.loadModel({
            modelPath: verification.modelPath,
          });
          context = await model.createContext({
            contextSize: 4_096,
            sequences: 1,
          });
          const sequence = context.getSequence();
          session = new runtime.LlamaChatSession({
            contextSequence: sequence,
            systemPrompt: semanticSystemPrompt,
          });
          const grammar =
            await llama.createGrammarForJsonSchema(
              qwenSemanticOutputJsonSchema,
            );
          return {
            llama,
            model,
            context,
            sequence,
            session,
            grammar,
            createSession: (systemPrompt) =>
              new runtime.LlamaChatSession({
                contextSequence: sequence,
                systemPrompt,
              }),
          };
        } catch (error) {
          session?.dispose();
          await context?.dispose();
          await model?.dispose();
          await llama.dispose();
          throw error;
        }
      })();
    }
    const resources = this.#resources;
    try {
      return await resources;
    } catch (error) {
      if (this.#resources === resources) {
        this.#resources = undefined;
      }
      throw error;
    }
  }

  /**
   * `timeoutMs` is the caller's, not the profile's. The profile's value is a
   * classification budget — capture must not wait — and this same helper runs
   * structured generation, where the reader is waiting for a whole answer. The
   * timer stays because a local inference can ignore an abort; only the number
   * it counts to belongs to the caller.
   */
  #promptWithDeadline(
    session: QwenSession,
    grammar: unknown,
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
    controller: AbortController,
    externalSignal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new QwenProviderError(
            "timeout",
            "Qwen inference timed out",
            {
              diagnosticExcerpt: `Qwen inference timed out after ${timeoutMs} ms`,
            },
          ),
        );
        controller.abort();
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          externalSignal?.aborted === true
            ? abortError()
            : new QwenProviderError(
                "runtime_unavailable",
                "Qwen classification was interrupted",
              ),
        );
      };
      controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });

      session
        .prompt(prompt, {
          grammar,
          maxTokens,
          signal: controller.signal,
          temperature: 0,
        })
        .then(resolve, (error: unknown) => {
          reject(
            error instanceof QwenProviderError ||
              (error instanceof Error &&
                error.name === "AbortError")
              ? error
              : new QwenProviderError(
                  "runtime_unavailable",
                  "Qwen classification failed",
                  {
                    diagnosticExcerpt: `Qwen inference failed: ${safeRuntimeDiagnostic(
                      error,
                      [
                        this.#modelsDirectory,
                        homedir(),
                      ],
                    )}`,
                  },
                ),
          );
        })
        .finally(() => {
          clearTimeout(timer);
          controller.signal.removeEventListener(
            "abort",
            onAbort,
          );
        });
    });
  }

  #tokenState(sequence: QwenSequence):
    | {
        usedInputTokens: number;
        usedOutputTokens: number;
      }
    | undefined {
    try {
      const state = sequence.tokenMeter?.getState();
      if (
        state === undefined ||
        !Number.isFinite(state.usedInputTokens) ||
        !Number.isFinite(state.usedOutputTokens)
      ) {
        return undefined;
      }
      return state;
    } catch {
      return undefined;
    }
  }

  #tokenUsage(
    before:
      | {
          usedInputTokens: number;
          usedOutputTokens: number;
        }
      | undefined,
    after:
      | {
          usedInputTokens: number;
          usedOutputTokens: number;
        }
      | undefined,
  ): NormalizedTokenUsage {
    if (before === undefined || after === undefined) {
      return { source: "unavailable" };
    }
    const inputTokens = Math.max(
      0,
      Math.trunc(
        after.usedInputTokens - before.usedInputTokens,
      ),
    );
    const outputTokens = Math.max(
      0,
      Math.trunc(
        after.usedOutputTokens - before.usedOutputTokens,
      ),
    );
    return {
      source: "runtime_measured",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }
}
