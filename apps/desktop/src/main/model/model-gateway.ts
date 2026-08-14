import {
  normalizedTokenUsageSchema,
  semanticRecognitionStatusSchema,
  type ModelInvocationErrorCode,
  type ModelInvocationStatus,
  type ModelInvocationTrace,
  type NormalizedTokenUsage,
  type SemanticClassification,
  type SemanticRecognitionStatus,
} from "@cognelis/decision-protocol";
import type {
  CaptureAuditRecordInput,
  CaptureAuditSummary,
  ModelTraceRecordInput,
} from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";

import type {
  SemanticClassificationService,
  SemanticClassificationAuditContext,
  SemanticClassifier,
  SemanticClassifierInput,
  SemanticProviderAttempt,
  SemanticProviderStatus,
} from "../semantic/semantic-classifier.js";
import {
  buildSemanticUserPrompt,
  SEMANTIC_PROMPT_VERSION,
  SEMANTIC_SCHEMA_VERSION,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "./semantic-prompt.js";

interface ModelTraceStoreLike {
  record(
    input: ModelTraceRecordInput,
  ): Promise<ModelInvocationTrace>;
}

interface CaptureAuditLike {
  fingerprint(value: string): Promise<string>;
  record(input: CaptureAuditRecordInput): Promise<unknown>;
  summary(): Promise<CaptureAuditSummary>;
}

interface StructuredModelGatewayOptions {
  appleFactory(): SemanticClassifier;
  qwenFactory(): SemanticClassifier;
  traces: ModelTraceStoreLike;
  audit: CaptureAuditLike;
  now?: () => Date;
  idFactory?: () => string;
}

type ProviderId = "apple" | "qwen";

interface UnavailableProvider {
  provider: SemanticClassifier;
  status: SemanticProviderStatus;
}

interface ProviderSelection {
  provider: SemanticClassifier | null;
  status: SemanticProviderStatus;
  unavailable: UnavailableProvider[];
}

interface NormalizedFailure {
  status: ModelInvocationStatus;
  errorCode: ModelInvocationErrorCode;
  processExitCode?: number;
  usage?: NormalizedTokenUsage;
}

const providerLabels = {
  apple: "Apple 本地模型",
  qwen: "Qwen 本地模型",
  rules: "规则识别",
} as const;
const RUNTIME_RETRY_DELAY_MS = 30_000;
const MAX_TIMING_MS = 120_000;

const clampTiming = (value: number): number =>
  Math.max(
    0,
    Math.min(MAX_TIMING_MS, Math.round(value)),
  );

export class StructuredModelGatewayError extends Error {
  readonly code = "provider_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "StructuredModelGatewayError";
  }
}

export class StructuredModelGateway
  implements SemanticClassificationService
{
  readonly #appleFactory: () => SemanticClassifier;
  readonly #qwenFactory: () => SemanticClassifier;
  readonly #traces: ModelTraceStoreLike;
  readonly #audit: CaptureAuditLike;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #instances = new Map<
    ProviderId,
    SemanticClassifier
  >();

  #selection: Promise<ProviderSelection> | undefined;
  #runtimeRetryAfter: number | undefined;
  #closed = false;

  constructor(options: StructuredModelGatewayOptions) {
    this.#appleFactory = options.appleFactory;
    this.#qwenFactory = options.qwenFactory;
    this.#traces = options.traces;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<SemanticClassification> {
    if (this.#closed) {
      throw new StructuredModelGatewayError(
        "Structured model gateway is closed",
      );
    }
    const requestId = this.#idFactory();
    let attemptIndex = 0;
    const selection = await this.#select();
    for (const unavailable of selection.unavailable) {
      await this.#recordUnavailable(
        requestId,
        attemptIndex,
        unavailable,
        input,
        auditContext,
      );
      attemptIndex += 1;
    }
    if (selection.provider === null) {
      throw new StructuredModelGatewayError(
        "No local semantic model is available",
      );
    }

    try {
      const result = await this.#invoke(
        selection.provider,
        selection.status,
        requestId,
        attemptIndex,
        input,
        signal,
        auditContext,
      );
      return result;
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      return this.#classifyWithFallback(
        selection.provider.id as ProviderId,
        requestId,
        attemptIndex + 1,
        input,
        signal,
        auditContext,
      );
    }
  }

  async status(): Promise<SemanticRecognitionStatus> {
    const [selection, summary] = await Promise.all([
      this.#select(),
      this.#audit.summary(),
    ]);
    const selectedId = selection.provider?.id;
    const provider =
      selectedId === "apple" || selectedId === "qwen"
        ? selectedId
        : ("rules" as const);
    return semanticRecognitionStatusSchema.parse({
      provider,
      providerLabel: providerLabels[provider],
      availability: selection.status.availability,
      mode: "hybrid",
      ...(selection.provider === null ||
      selection.status.modelVersion === undefined
        ? {}
        : { modelVersion: selection.status.modelVersion }),
      ...(selection.provider === null ||
      selection.status.promptVersion === undefined
        ? {}
        : { promptVersion: selection.status.promptVersion }),
      processed7d: summary.processed,
      high7d: summary.high,
      medium7d: summary.medium,
      failures7d: summary.failures,
      updatedAt: this.#now().toISOString(),
    });
  }

  refresh(): void {
    if (!this.#closed) {
      this.#selection = undefined;
      this.#runtimeRetryAfter = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const errors: unknown[] = [];
    for (const provider of this.#instances.values()) {
      try {
        await provider.close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#instances.clear();
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Structured model gateway shutdown failed",
      );
    }
  }

  #select(): Promise<ProviderSelection> {
    if (this.#closed) {
      return Promise.resolve(
        this.#rulesSelection("runtime_unavailable"),
      );
    }
    if (
      this.#runtimeRetryAfter !== undefined &&
      this.#now().getTime() >= this.#runtimeRetryAfter
    ) {
      this.#selection = undefined;
      this.#runtimeRetryAfter = undefined;
    }
    this.#selection ??= this.#selectProvider();
    return this.#selection;
  }

  async #selectProvider(): Promise<ProviderSelection> {
    const apple = this.#provider("apple");
    const appleStatus = await this.#probe(apple);
    if (appleStatus.availability === "available") {
      this.#runtimeRetryAfter = undefined;
      return {
        provider: apple,
        status: appleStatus,
        unavailable: [],
      };
    }

    const qwen = this.#provider("qwen");
    const qwenStatus = await this.#probe(qwen);
    if (qwenStatus.availability === "available") {
      this.#runtimeRetryAfter = undefined;
      return {
        provider: qwen,
        status: qwenStatus,
        unavailable: [
          { provider: apple, status: appleStatus },
        ],
      };
    }
    return this.#rulesSelection(qwenStatus.availability, [
      { provider: apple, status: appleStatus },
      { provider: qwen, status: qwenStatus },
    ]);
  }

  async #classifyWithFallback(
    failedProvider: ProviderId,
    requestId: string,
    attemptIndex: number,
    input: SemanticClassifierInput,
    signal?: AbortSignal,
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<SemanticClassification> {
    const selection = await this.#select();
    const wasAlreadyUnavailable = selection.unavailable.some(
      (entry) => entry.provider.id !== failedProvider,
    );
    if (wasAlreadyUnavailable) {
      this.#selection = Promise.resolve(
        this.#runtimeFailureSelection(),
      );
      throw new StructuredModelGatewayError(
        "No fallback semantic provider is available",
      );
    }
    const fallbackId: ProviderId =
      failedProvider === "apple" ? "qwen" : "apple";
    const fallback = this.#provider(fallbackId);
    const fallbackStatus = await this.#probe(fallback);
    if (fallbackStatus.availability !== "available") {
      await this.#recordUnavailable(
        requestId,
        attemptIndex,
        { provider: fallback, status: fallbackStatus },
        input,
        auditContext,
      );
      this.#selection = Promise.resolve(
        this.#runtimeFailureSelection(),
      );
      throw new StructuredModelGatewayError(
        "No fallback semantic provider is available",
      );
    }

    try {
      const result = await this.#invoke(
        fallback,
        fallbackStatus,
        requestId,
        attemptIndex,
        input,
        signal,
        auditContext,
      );
      this.#selection = Promise.resolve({
        provider: fallback,
        status: fallbackStatus,
        unavailable: [],
      });
      this.#runtimeRetryAfter = undefined;
      return result;
    } catch {
      this.#selection = Promise.resolve(
        this.#runtimeFailureSelection(),
      );
      throw new StructuredModelGatewayError(
        "Every local semantic provider failed",
      );
    }
  }

  async #invoke(
    provider: SemanticClassifier,
    status: SemanticProviderStatus,
    requestId: string,
    attemptIndex: number,
    input: SemanticClassifierInput,
    signal?: AbortSignal,
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<SemanticClassification> {
    const startedAt = performance.now();
    try {
      const attempt = await provider.invoke(input, signal);
      await this.#recordTrace(
        {
          requestId,
          attemptId: this.#idFactory(),
          attemptIndex,
          purpose: "semantic-classification",
          profile: this.#profile(
            provider,
            status,
            attempt,
          ),
          input: attempt.traceInput,
          output: {
            visibleText: attempt.visibleOutput,
            parsed: attempt.classification,
          },
          usage: attempt.usage,
          timing: {
            queuedMs: 0,
            providerMs: clampTiming(
              attempt.providerDurationMs,
            ),
            totalMs: clampTiming(
              performance.now() - startedAt,
            ),
          },
          status: "succeeded",
        },
        auditContext,
      );
      return attempt.classification;
    } catch (error) {
      const failure = this.#normalizeFailure(error, signal);
      await this.#recordTrace(
        {
          requestId,
          attemptId: this.#idFactory(),
          attemptIndex,
          purpose: "semantic-classification",
          profile: this.#profile(provider, status),
          input: this.#traceInput(input),
          usage:
            failure.usage ?? { source: "unavailable" },
          timing: {
            queuedMs: 0,
            providerMs: clampTiming(
              performance.now() - startedAt,
            ),
            totalMs: clampTiming(
              performance.now() - startedAt,
            ),
          },
          status: failure.status,
          errorCode: failure.errorCode,
          ...(failure.processExitCode === undefined
            ? {}
            : {
                processExitCode:
                  failure.processExitCode,
              }),
        },
        auditContext,
      );
      throw error;
    }
  }

  async #recordUnavailable(
    requestId: string,
    attemptIndex: number,
    unavailable: UnavailableProvider,
    input: SemanticClassifierInput,
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<void> {
    await this.#recordTrace(
      {
        requestId,
        attemptId: this.#idFactory(),
        attemptIndex,
        purpose: "semantic-classification",
        profile: this.#profile(
          unavailable.provider,
          unavailable.status,
        ),
        input: this.#traceInput(input),
        usage: { source: "unavailable" },
        timing: {
          queuedMs: 0,
          providerMs: 0,
          totalMs: 0,
        },
        status: "unavailable",
        errorCode: "provider_unavailable",
      },
      auditContext,
    );
  }

  async #recordTrace(
    trace: ModelTraceRecordInput,
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<void> {
    try {
      const correlationFingerprint =
        auditContext === undefined
          ? undefined
          : await this.#audit.fingerprint(
              auditContext.turnId ??
                auditContext.sessionId,
            );
      await this.#traces.record({
        ...trace,
        ...(correlationFingerprint === undefined
          ? {}
          : { correlationFingerprint }),
      });
    } catch {
      if (auditContext === undefined) {
        return;
      }
      await this.#audit
        .record({
          sourceClient: auditContext.sourceClient,
          sessionId: auditContext.sessionId,
          ...(auditContext.turnId === undefined
            ? {}
            : { turnId: auditContext.turnId }),
          stage: "failed",
          errorCode: "trace_write_failed",
        })
        .catch(() => undefined);
    }
  }

  #traceInput(input: SemanticClassifierInput) {
    return {
      systemPrompt: semanticSystemPrompt,
      userPrompt: buildSemanticUserPrompt(input),
      outputSchema: semanticOutputJsonSchema,
      clientSystemPromptVisibility: "visible" as const,
    };
  }

  #profile(
    provider: SemanticClassifier,
    status: SemanticProviderStatus,
    attempt?: SemanticProviderAttempt,
  ) {
    return {
      profileId: provider.id,
      backend: provider.id,
      provider: provider.id,
      model:
        attempt?.classification.modelVersion ??
        status.modelVersion ??
        (provider.id === "apple"
          ? "system-language-model"
          : "qwen-local-model"),
      promptVersion:
        attempt?.classification.promptVersion ??
        status.promptVersion ??
        SEMANTIC_PROMPT_VERSION,
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
    } as const;
  }

  #normalizeFailure(
    error: unknown,
    signal?: AbortSignal,
  ): NormalizedFailure {
    if (
      signal?.aborted === true ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return {
        status: "cancelled",
        errorCode: "cancelled",
      };
    }
    const code =
      error !== null &&
      typeof error === "object" &&
      "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const processExitCode =
      error !== null &&
      typeof error === "object" &&
      "processExitCode" in error &&
      Number.isInteger(error.processExitCode)
        ? (error.processExitCode as number)
        : undefined;
    const parsedUsage = normalizedTokenUsageSchema.safeParse(
      error !== null &&
        typeof error === "object" &&
        "usage" in error
        ? error.usage
        : undefined,
    );
    const usage = parsedUsage.success
      ? parsedUsage.data
      : undefined;
    if (
      code === "provider_invalid_output" ||
      code === "output_limit"
    ) {
      return {
        status: "invalid_output",
        errorCode:
          code === "output_limit"
            ? "output_limit"
            : "invalid_output",
        ...(processExitCode === undefined
          ? {}
          : { processExitCode }),
        ...(usage === undefined ? {} : { usage }),
      };
    }
    return {
      status: "failed",
      errorCode: "provider_unavailable",
      ...(processExitCode === undefined
        ? {}
        : { processExitCode }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  #provider(id: ProviderId): SemanticClassifier {
    const existing = this.#instances.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const provider =
      id === "apple"
        ? this.#appleFactory()
        : this.#qwenFactory();
    if (provider.id !== id) {
      throw new Error(
        `Semantic provider factory returned ${provider.id} for ${id}`,
      );
    }
    this.#instances.set(id, provider);
    return provider;
  }

  async #probe(
    provider: SemanticClassifier,
  ): Promise<SemanticProviderStatus> {
    try {
      return await provider.status();
    } catch {
      return {
        id: provider.id,
        availability: "runtime_unavailable",
      };
    }
  }

  #rulesSelection(
    availability: SemanticProviderStatus["availability"],
    unavailable: UnavailableProvider[] = [],
  ): ProviderSelection {
    return {
      provider: null,
      status: {
        id: "qwen",
        availability,
      },
      unavailable,
    };
  }

  #runtimeFailureSelection(): ProviderSelection {
    this.#runtimeRetryAfter =
      this.#now().getTime() + RUNTIME_RETRY_DELAY_MS;
    return this.#rulesSelection("runtime_unavailable");
  }
}
