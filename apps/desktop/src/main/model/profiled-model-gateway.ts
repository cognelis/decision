import {
  modelInvocationErrorCodeSchema,
  normalizedTokenUsageSchema,
  semanticRecognitionStatusSchema,
  structuredGenerationRequestSchema,
  type ModelInvocationErrorCode,
  type ModelInvocationStatus,
  type ModelInvocationTrace,
  type ModelProviderProfile,
  type NormalizedTokenUsage,
  type SemanticClassification,
  type SemanticRecognitionStatus,
  type StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import type {
  CaptureAuditRecordInput,
  CaptureAuditSummary,
  ModelTraceRecordInput,
} from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import type {
  SemanticClassificationAuditContext,
  SemanticClassificationService,
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
import { ModelProviderError } from "./http-model-transport.js";
import {
  supportsStructuredGeneration,
  type StructuredGenerationProvider,
  type StructuredProviderAttempt,
} from "./structured-provider.js";

interface ProfileRepositoryLike {
  load(): Promise<ModelProviderProfile[]>;
}

interface TraceStoreLike {
  record(
    input: ModelTraceRecordInput,
  ): Promise<ModelInvocationTrace>;
}

interface CaptureAuditLike {
  fingerprint(value: string): Promise<string>;
  record(input: CaptureAuditRecordInput): Promise<unknown>;
  summary(): Promise<CaptureAuditSummary>;
}

export interface ModelProviderTestResult {
  ok: boolean;
  profileId: string;
  latencyMs: number;
  requestId: string;
  modelVersion?: string;
  tokenSource?: NormalizedTokenUsage["source"];
  errorCode?: ModelInvocationErrorCode;
  availability?: SemanticRecognitionStatus["availability"];
  providerRequestId?: string;
  processExitCode?: number;
  diagnosticExcerpt?: string;
}

export interface ProfiledStructuredGenerationResult<T> {
  requestId: string;
  attemptId: string;
  profileId: string;
  backend: ModelProviderProfile["kind"];
  provider: string;
  model: string;
  visibleOutput: string;
  parsedOutput: T;
  usage: NormalizedTokenUsage;
  providerDurationMs: number;
  providerRequestId?: string;
}

export interface ProfiledModelGatewayOptions {
  profiles: ProfileRepositoryLike;
  providerFactory(
    profile: ModelProviderProfile,
  ): SemanticClassifier;
  traces: TraceStoreLike;
  audit: CaptureAuditLike;
  now?: () => Date;
  idFactory?: () => string;
}

interface NormalizedFailure {
  status: ModelInvocationStatus;
  errorCode: ModelInvocationErrorCode;
  providerRequestId?: string;
  processExitCode?: number;
  diagnosticExcerpt?: string;
  usage?: NormalizedTokenUsage;
}

const MAX_TIMING_MS = 120_000;

const clampTiming = (value: number): number =>
  Math.max(0, Math.min(MAX_TIMING_MS, Math.round(value)));

const safeDiagnosticExcerpt = (
  value: string,
): string => {
  const home = homedir();
  let diagnostic = value
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
      "Bearer [redacted]",
    )
    .replace(
      /\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}/giu,
      "[redacted]",
    );
  if (home.length > 0) {
    diagnostic = diagnostic
      .split(home)
      .join("[home]");
  }
  return diagnostic.trim().slice(0, 2_000);
};

const enabledProfiles = (
  profiles: ModelProviderProfile[],
): ModelProviderProfile[] =>
  profiles
    .filter((profile) => profile.enabled)
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.profileId.localeCompare(right.profileId),
    );

const isLongLived = (profile: ModelProviderProfile): boolean =>
  profile.kind === "apple" || profile.kind === "qwen";

export class ProfiledModelGatewayError extends Error {
  readonly code = "provider_unavailable" as const;

  constructor(message: string) {
    super(message);
    this.name = "ProfiledModelGatewayError";
  }
}

export class ProfiledModelGateway
  implements SemanticClassificationService
{
  readonly #profiles: ProfileRepositoryLike;
  readonly #providerFactory: (
    profile: ModelProviderProfile,
  ) => SemanticClassifier;
  readonly #traces: TraceStoreLike;
  readonly #audit: CaptureAuditLike;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #longLivedProviders = new Map<
    string,
    SemanticClassifier
  >();
  #closed = false;

  constructor(options: ProfiledModelGatewayOptions) {
    this.#profiles = options.profiles;
    this.#providerFactory = options.providerFactory;
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
    this.#requireOpen();
    const requestId = this.#idFactory();
    const profiles = enabledProfiles(
      await this.#profiles.load(),
    );
    let attemptIndex = 0;
    for (const profile of profiles) {
      let provider: SemanticClassifier | undefined;
      try {
        provider = this.#provider(profile);
        const status = await provider.status();
        if (status.availability !== "available") {
          await this.#recordUnavailable(
            requestId,
            attemptIndex,
            profile,
            status,
            input,
            "semantic-classification",
            auditContext,
          );
          continue;
        }
        const attempt = await this.#invokeAndTrace({
          provider,
          profile,
          status,
          requestId,
          attemptIndex,
          purpose: "semantic-classification",
          input,
          ...(signal === undefined ? {} : { signal }),
          ...(auditContext === undefined
            ? {}
            : { auditContext }),
        });
        return attempt.classification;
      } catch (error) {
        if (signal?.aborted === true) {
          throw error;
        }
        if (provider === undefined) {
          await this.#recordCreationFailure(
            requestId,
            attemptIndex,
            profile,
            input,
            error,
            "semantic-classification",
            auditContext,
          );
        }
      } finally {
        if (
          provider !== undefined &&
          !isLongLived(profile)
        ) {
          await provider.close().catch(() => undefined);
        }
        attemptIndex += 1;
      }
    }
    throw new ProfiledModelGatewayError(
      "Every enabled model provider was unavailable or failed",
    );
  }

  async generate<T>(
    requestInput: StructuredGenerationRequest,
    parseOutput: (value: unknown) => T,
    signal?: AbortSignal,
  ): Promise<ProfiledStructuredGenerationResult<T>> {
    this.#requireOpen();
    const request = structuredGenerationRequestSchema.parse(
      requestInput,
    );
    if (
      request.purpose === "semantic-classification" ||
      request.purpose === "provider-health-check"
    ) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Generic structured generation requires a drafting or extraction purpose",
      );
    }
    const profiles = enabledProfiles(
      await this.#profiles.load(),
    );
    let attemptIndex = 0;
    for (const profile of profiles) {
      let provider: SemanticClassifier | undefined;
      try {
        provider = this.#provider(profile);
        const status = await provider.status();
        if (status.availability !== "available") {
          await this.#recordStructuredFailure({
            request,
            attemptIndex,
            profile,
            status,
            statusKind: "unavailable",
            errorCode: "provider_unavailable",
          });
          continue;
        }
        if (!supportsStructuredGeneration(provider)) {
          await this.#recordStructuredFailure({
            request,
            attemptIndex,
            profile,
            status,
            statusKind: "unavailable",
            errorCode: "unsupported_client",
          });
          continue;
        }
        return await this.#invokeStructuredAndTrace({
          provider,
          profile,
          status,
          request,
          attemptIndex,
          parseOutput,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (signal?.aborted === true) {
          throw error;
        }
        if (provider === undefined) {
          const failure = this.#normalizeFailure(error);
          await this.#recordStructuredFailure({
            request,
            attemptIndex,
            profile,
            statusKind: failure.status,
            errorCode: failure.errorCode,
            ...(failure.diagnosticExcerpt === undefined
              ? {}
              : { diagnosticExcerpt: failure.diagnosticExcerpt }),
          });
        }
      } finally {
        if (
          provider !== undefined &&
          !isLongLived(profile)
        ) {
          await provider.close().catch(() => undefined);
        }
        attemptIndex += 1;
      }
    }
    throw new ProfiledModelGatewayError(
      "Every enabled model provider was unavailable or failed for structured generation",
    );
  }

  async status(): Promise<SemanticRecognitionStatus> {
    this.#requireOpen();
    const [profiles, summary] = await Promise.all([
      this.#profiles.load(),
      this.#audit.summary(),
    ]);
    for (const profile of enabledProfiles(profiles)) {
      let provider: SemanticClassifier | undefined;
      try {
        provider = this.#provider(profile);
        const status = await provider.status();
        if (status.availability === "available") {
          return semanticRecognitionStatusSchema.parse({
            provider: profile.kind,
            providerLabel: profile.label,
            availability: status.availability,
            mode: "hybrid",
            ...(status.modelVersion === undefined
              ? {}
              : { modelVersion: status.modelVersion }),
            ...(status.promptVersion === undefined
              ? {}
              : { promptVersion: status.promptVersion }),
            processed7d: summary.processed,
            high7d: summary.high,
            medium7d: summary.medium,
            failures7d: summary.failures,
            updatedAt: this.#now().toISOString(),
          });
        }
      } catch {
        // Status probing continues to the next configured profile.
      } finally {
        if (
          provider !== undefined &&
          !isLongLived(profile)
        ) {
          await provider.close().catch(() => undefined);
        }
      }
    }
    return semanticRecognitionStatusSchema.parse({
      provider: "rules",
      providerLabel: "规则识别",
      availability: "runtime_unavailable",
      mode: "hybrid",
      processed7d: summary.processed,
      high7d: summary.high,
      medium7d: summary.medium,
      failures7d: summary.failures,
      updatedAt: this.#now().toISOString(),
    });
  }

  async testProfile(
    profileId: string,
  ): Promise<ModelProviderTestResult> {
    this.#requireOpen();
    const profile = (await this.#profiles.load()).find(
      (candidate) => candidate.profileId === profileId,
    );
    if (profile === undefined) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Model provider profile was not found",
      );
    }
    const requestId = this.#idFactory();
    const input: SemanticClassifierInput = {
      pairId: `health-check:${profile.profileId}`,
      assistantText: "Proceed with the safe option?",
      userText: "Yes.",
      locale: "en",
    };
    const startedAt = performance.now();
    let provider: SemanticClassifier | undefined;
    try {
      provider = this.#provider(profile);
      const status = await provider.status();
      if (status.availability !== "available") {
        await this.#recordUnavailable(
          requestId,
          0,
          profile,
          status,
          input,
          "provider-health-check",
        );
        return {
          ok: false,
          profileId,
          latencyMs: clampTiming(
            performance.now() - startedAt,
          ),
          requestId,
          errorCode: "provider_unavailable",
          availability: status.availability,
        };
      }
      const attempt = await this.#invokeAndTrace({
        provider,
        profile,
        status,
        requestId,
        attemptIndex: 0,
        purpose: "provider-health-check",
        input,
      });
      return {
        ok: true,
        profileId,
        latencyMs: clampTiming(
          performance.now() - startedAt,
        ),
        requestId,
        modelVersion: attempt.classification.modelVersion,
        tokenSource: attempt.usage.source,
      };
    } catch (error) {
      if (provider === undefined) {
        await this.#recordCreationFailure(
          requestId,
          0,
          profile,
          input,
          error,
          "provider-health-check",
        );
      }
      const failure = this.#normalizeFailure(error);
      return {
        ok: false,
        profileId,
        latencyMs: clampTiming(
          performance.now() - startedAt,
        ),
        requestId,
        errorCode: failure.errorCode,
        ...(failure.providerRequestId === undefined
          ? {}
          : {
              providerRequestId:
                failure.providerRequestId,
            }),
        ...(failure.processExitCode === undefined
          ? {}
          : { processExitCode: failure.processExitCode }),
        ...(failure.diagnosticExcerpt === undefined
          ? {}
          : {
              diagnosticExcerpt:
                failure.diagnosticExcerpt,
            }),
      };
    } finally {
      if (
        provider !== undefined &&
        !isLongLived(profile)
      ) {
        await provider.close().catch(() => undefined);
      }
    }
  }

  refresh(): void {
    // Profiles are intentionally loaded at every operation boundary.
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const providers = [...this.#longLivedProviders.values()];
    this.#longLivedProviders.clear();
    const results = await Promise.allSettled(
      providers.map((provider) => provider.close()),
    );
    const errors = results
      .filter(
        (
          result,
        ): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => result.reason);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Model provider shutdown failed",
      );
    }
  }

  #provider(profile: ModelProviderProfile): SemanticClassifier {
    if (isLongLived(profile)) {
      const existing = this.#longLivedProviders.get(
        profile.profileId,
      );
      if (existing !== undefined) {
        return existing;
      }
    }
    const provider = this.#providerFactory(profile);
    if (provider.id !== profile.kind) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Model provider factory returned the wrong backend kind",
      );
    }
    if (isLongLived(profile)) {
      this.#longLivedProviders.set(
        profile.profileId,
        provider,
      );
    }
    return provider;
  }

  async #invokeAndTrace(options: {
    provider: SemanticClassifier;
    profile: ModelProviderProfile;
    status: SemanticProviderStatus;
    requestId: string;
    attemptIndex: number;
    purpose:
      | "semantic-classification"
      | "provider-health-check";
    input: SemanticClassifierInput;
    signal?: AbortSignal;
    auditContext?: SemanticClassificationAuditContext;
  }): Promise<SemanticProviderAttempt> {
    const startedAt = performance.now();
    try {
      const attempt = await options.provider.invoke(
        options.input,
        options.signal,
      );
      await this.#recordTrace(
        {
          requestId: options.requestId,
          attemptId: this.#idFactory(),
          attemptIndex: options.attemptIndex,
          purpose: options.purpose,
          profile: this.#traceProfile(
            options.profile,
            options.status,
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
          ...(attempt.providerRequestId === undefined
            ? {}
            : {
                providerRequestId:
                  attempt.providerRequestId,
              }),
        },
        options.auditContext,
      );
      return attempt;
    } catch (error) {
      const failure = this.#normalizeFailure(
        error,
        options.signal,
      );
      await this.#recordTrace(
        {
          requestId: options.requestId,
          attemptId: this.#idFactory(),
          attemptIndex: options.attemptIndex,
          purpose: options.purpose,
          profile: this.#traceProfile(
            options.profile,
            options.status,
          ),
          input: this.#traceInput(options.input),
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
          ...(failure.providerRequestId === undefined
            ? {}
            : {
                providerRequestId:
                  failure.providerRequestId,
              }),
          ...(failure.processExitCode === undefined
            ? {}
            : {
                processExitCode:
                  failure.processExitCode,
              }),
          ...(failure.diagnosticExcerpt === undefined
            ? {}
            : {
                diagnosticExcerpt:
                  failure.diagnosticExcerpt,
              }),
        },
        options.auditContext,
      );
      throw error;
    }
  }

  async #invokeStructuredAndTrace<T>(options: {
    provider: StructuredGenerationProvider;
    profile: ModelProviderProfile;
    status: SemanticProviderStatus;
    request: StructuredGenerationRequest;
    attemptIndex: number;
    parseOutput: (value: unknown) => T;
    signal?: AbortSignal;
  }): Promise<ProfiledStructuredGenerationResult<T>> {
    const startedAt = performance.now();
    const attemptId = this.#idFactory();
    try {
      const attempt = await options.provider.generate(
        options.request,
        options.signal,
      );
      let parsedOutput: T;
      try {
        parsedOutput = options.parseOutput(
          attempt.parsedOutput,
        );
      } catch {
        throw new ModelProviderError(
          "invalid_output",
          "Model provider output failed application schema validation",
        );
      }
      await this.#recordTrace({
        requestId: options.request.requestId,
        attemptId,
        attemptIndex: options.attemptIndex,
        purpose: options.request.purpose,
        ...(options.request.correlationFingerprint === undefined
          ? {}
          : {
              correlationFingerprint:
                options.request.correlationFingerprint,
            }),
        profile: this.#structuredTraceProfile(
          options.profile,
          options.request,
          options.status,
          attempt,
        ),
        input: attempt.traceInput,
        output: {
          visibleText: attempt.visibleOutput,
          parsed: parsedOutput,
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
        ...(attempt.providerRequestId === undefined
          ? {}
          : { providerRequestId: attempt.providerRequestId }),
      });
      return {
        requestId: options.request.requestId,
        attemptId,
        profileId: options.profile.profileId,
        backend: options.profile.kind,
        provider: options.profile.label,
        model:
          attempt.modelVersion ??
          options.status.modelVersion ??
          options.profile.model ??
          options.profile.kind,
        visibleOutput: attempt.visibleOutput,
        parsedOutput,
        usage: attempt.usage,
        providerDurationMs: clampTiming(
          attempt.providerDurationMs,
        ),
        ...(attempt.providerRequestId === undefined
          ? {}
          : { providerRequestId: attempt.providerRequestId }),
      };
    } catch (error) {
      const failure = this.#normalizeFailure(
        error,
        options.signal,
      );
      await this.#recordStructuredFailure({
        request: options.request,
        attemptIndex: options.attemptIndex,
        attemptId,
        profile: options.profile,
        status: options.status,
        statusKind: failure.status,
        errorCode: failure.errorCode,
        ...(failure.usage === undefined
          ? {}
          : { usage: failure.usage }),
        providerMs: clampTiming(
          performance.now() - startedAt,
        ),
        ...(failure.providerRequestId === undefined
          ? {}
          : { providerRequestId: failure.providerRequestId }),
        ...(failure.processExitCode === undefined
          ? {}
          : { processExitCode: failure.processExitCode }),
        ...(failure.diagnosticExcerpt === undefined
          ? {}
          : { diagnosticExcerpt: failure.diagnosticExcerpt }),
      });
      throw error;
    }
  }

  async #recordStructuredFailure(options: {
    request: StructuredGenerationRequest;
    attemptIndex: number;
    attemptId?: string;
    profile: ModelProviderProfile;
    status?: SemanticProviderStatus;
    statusKind: ModelInvocationStatus;
    errorCode: ModelInvocationErrorCode;
    usage?: NormalizedTokenUsage;
    providerMs?: number;
    providerRequestId?: string;
    processExitCode?: number;
    diagnosticExcerpt?: string;
  }): Promise<void> {
    const timing = options.providerMs ?? 0;
    await this.#recordTrace({
      requestId: options.request.requestId,
      attemptId: options.attemptId ?? this.#idFactory(),
      attemptIndex: options.attemptIndex,
      purpose: options.request.purpose,
      ...(options.request.correlationFingerprint === undefined
        ? {}
        : {
            correlationFingerprint:
              options.request.correlationFingerprint,
          }),
      profile: this.#structuredTraceProfile(
        options.profile,
        options.request,
        options.status,
      ),
      input: {
        systemPrompt: options.request.systemPrompt,
        userPrompt: options.request.userPrompt,
        outputSchema: options.request.outputSchema,
        clientSystemPromptVisibility: "visible",
      },
      usage: options.usage ?? { source: "unavailable" },
      timing: {
        queuedMs: 0,
        providerMs: timing,
        totalMs: timing,
      },
      status: options.statusKind,
      errorCode: options.errorCode,
      ...(options.providerRequestId === undefined
        ? {}
        : { providerRequestId: options.providerRequestId }),
      ...(options.processExitCode === undefined
        ? {}
        : { processExitCode: options.processExitCode }),
      ...(options.diagnosticExcerpt === undefined
        ? {}
        : { diagnosticExcerpt: options.diagnosticExcerpt }),
    });
  }

  #structuredTraceProfile(
    profile: ModelProviderProfile,
    request: StructuredGenerationRequest,
    status?: SemanticProviderStatus,
    attempt?: StructuredProviderAttempt,
  ) {
    return {
      profileId: profile.profileId,
      backend: profile.kind,
      provider: profile.label,
      model:
        attempt?.modelVersion ??
        status?.modelVersion ??
        profile.model ??
        profile.kind,
      promptVersion: request.promptVersion,
      schemaVersion: request.schemaVersion,
    };
  }

  async #recordUnavailable(
    requestId: string,
    attemptIndex: number,
    profile: ModelProviderProfile,
    status: SemanticProviderStatus,
    input: SemanticClassifierInput,
    purpose:
      | "semantic-classification"
      | "provider-health-check",
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<void> {
    await this.#recordTrace(
      {
        requestId,
        attemptId: this.#idFactory(),
        attemptIndex,
        purpose,
        profile: this.#traceProfile(profile, status),
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

  async #recordCreationFailure(
    requestId: string,
    attemptIndex: number,
    profile: ModelProviderProfile,
    input: SemanticClassifierInput,
    error: unknown,
    purpose:
      | "semantic-classification"
      | "provider-health-check",
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<void> {
    const failure = this.#normalizeFailure(error);
    await this.#recordTrace(
      {
        requestId,
        attemptId: this.#idFactory(),
        attemptIndex,
        purpose,
        profile: this.#traceProfile(profile),
        input: this.#traceInput(input),
        usage:
          failure.usage ?? { source: "unavailable" },
        timing: {
          queuedMs: 0,
          providerMs: 0,
          totalMs: 0,
        },
        status: failure.status,
        errorCode: failure.errorCode,
        ...(failure.providerRequestId === undefined
          ? {}
          : {
              providerRequestId:
                failure.providerRequestId,
            }),
        ...(failure.processExitCode === undefined
          ? {}
          : {
              processExitCode:
                failure.processExitCode,
            }),
        ...(failure.diagnosticExcerpt === undefined
          ? {}
          : {
              diagnosticExcerpt:
                failure.diagnosticExcerpt,
            }),
      },
      auditContext,
    );
  }

  #traceProfile(
    profile: ModelProviderProfile,
    status?: SemanticProviderStatus,
    attempt?: SemanticProviderAttempt,
  ) {
    return {
      profileId: profile.profileId,
      backend: profile.kind,
      provider: profile.label,
      model:
        attempt?.classification.modelVersion ??
        status?.modelVersion ??
        profile.model ??
        profile.kind,
      promptVersion:
        attempt?.classification.promptVersion ??
        status?.promptVersion ??
        SEMANTIC_PROMPT_VERSION,
      schemaVersion: SEMANTIC_SCHEMA_VERSION,
    };
  }

  #traceInput(input: SemanticClassifierInput) {
    return {
      systemPrompt: semanticSystemPrompt,
      userPrompt: buildSemanticUserPrompt(input),
      outputSchema: semanticOutputJsonSchema,
      clientSystemPromptVisibility: "visible" as const,
    };
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
    const candidateCode =
      error !== null &&
      typeof error === "object" &&
      "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const parsedCode =
      modelInvocationErrorCodeSchema.safeParse(candidateCode);
    const errorCode: ModelInvocationErrorCode =
      parsedCode.success
        ? parsedCode.data
        : candidateCode === "provider_invalid_output"
          ? "invalid_output"
          : candidateCode === "classification_timeout"
            ? "timeout"
            : "provider_unavailable";
    const status: ModelInvocationStatus =
      errorCode === "timeout"
        ? "timed_out"
        : errorCode === "cancelled"
          ? "cancelled"
          : errorCode === "authentication_failed" ||
              errorCode === "authorization_failed"
            ? "auth_failed"
            : errorCode === "invalid_output" ||
                errorCode === "output_limit"
              ? "invalid_output"
              : errorCode === "provider_unavailable" ||
                  errorCode === "credential_unavailable" ||
                  errorCode ===
                    "credential_decryption_failed" ||
                  errorCode === "executable_missing" ||
                  errorCode === "unsupported_client"
                ? "unavailable"
                : "failed";
    const providerRequestId =
      error !== null &&
      typeof error === "object" &&
      "providerRequestId" in error &&
      typeof error.providerRequestId === "string"
        ? error.providerRequestId
        : undefined;
    const processExitCode =
      error !== null &&
      typeof error === "object" &&
      "processExitCode" in error &&
      Number.isInteger(error.processExitCode)
        ? (error.processExitCode as number)
        : undefined;
    const explicitDiagnostic =
      error !== null &&
      typeof error === "object" &&
      "diagnosticExcerpt" in error &&
      typeof error.diagnosticExcerpt === "string"
        ? error.diagnosticExcerpt
        : undefined;
    const fallbackDiagnostic =
      error instanceof Error &&
      (error.name === "QwenProviderError" ||
        error.name === "AppleFoundationProviderError")
        ? error.message
        : undefined;
    const diagnosticCandidate =
      explicitDiagnostic ?? fallbackDiagnostic;
    const diagnosticExcerpt =
      diagnosticCandidate === undefined
        ? undefined
        : safeDiagnosticExcerpt(diagnosticCandidate);
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
    return {
      status,
      errorCode,
      ...(providerRequestId === undefined
        ? {}
        : { providerRequestId }),
      ...(processExitCode === undefined
        ? {}
        : { processExitCode }),
      ...(diagnosticExcerpt === undefined
        ? {}
        : { diagnosticExcerpt }),
      ...(usage === undefined ? {} : { usage }),
    };
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

  #requireOpen(): void {
    if (this.#closed) {
      throw new ProfiledModelGatewayError(
        "Profiled model gateway is closed",
      );
    }
  }
}
