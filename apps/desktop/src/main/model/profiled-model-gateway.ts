import { withProviderDeadline } from "./provider-deadline.js";
import {
  modelInvocationErrorCodeSchema,
  modelInvocationInputSchema,
  type ModelInvocationInput,
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
  qwenSemanticOutputJsonSchema,
  SEMANTIC_PROMPT_VERSION,
  SEMANTIC_SCHEMA_VERSION,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "./semantic-prompt.js";
import { ModelProviderError } from "./http-model-transport.js";
import {
  MIN_GENERATION_TIMEOUT_MS,
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
  /** How long a generation no caller can stop (a draft from the knowledge page) may run in all. */
  unattendedGenerationMs?: number;
}

interface NormalizedFailure {
  traceInput?: ModelInvocationInput;
  status: ModelInvocationStatus;
  errorCode: ModelInvocationErrorCode;
  providerRequestId?: string;
  processExitCode?: number;
  diagnosticExcerpt?: string;
  usage?: NormalizedTokenUsage;
  visibleOutput?: string;
}

const MAX_TIMING_MS = Number.MAX_SAFE_INTEGER;

const clampTiming = (value: number): number =>
  Math.max(0, Math.min(MAX_TIMING_MS, Math.round(value)));

const safeDiagnosticExcerpt = (
  value: string,
): string | undefined => {
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
  const excerpt = diagnostic.trim().slice(0, 2_000);
  return excerpt.length === 0 ? undefined : excerpt;
};

const traceRequestSettings = (request: StructuredGenerationRequest, profile: ModelProviderProfile): NonNullable<ModelTraceRecordInput["request"]> => ({
  ...(profile.executablePath === undefined ? {} : { clientExecutable: safeDiagnosticExcerpt(profile.executablePath)! }),
  configuredTimeoutMs: profile.timeoutMs,
  generationTimeoutMs: Math.max(profile.timeoutMs, MIN_GENERATION_TIMEOUT_MS),
  requestedMaxOutputTokens: request.maxOutputTokens,
  systemPromptChars: request.systemPrompt.length,
  userPromptChars: request.userPrompt.length,
});

/** Validation paths and codes, never rejected values or custom error messages that may quote model output. */
export const outputValidationDiagnostic = (error: unknown, schema: Record<string, unknown>): string => {
  const names = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.properties && typeof node.properties === "object") {
      for (const [key, child] of Object.entries(node.properties)) { names.add(key); collect(child); }
    }
    for (const key of ["items", "anyOf", "oneOf", "allOf"]) collect(node[key]);
    for (const key of ["$defs", "definitions"]) if (node[key] && typeof node[key] === "object") Object.values(node[key]).forEach(collect);
  };
  collect(schema);
  const issues = error && typeof error === "object" && "issues" in error && Array.isArray(error.issues) ? error.issues : [];
  const details = issues.slice(0, 10).map((issue: unknown) => {
    if (!issue || typeof issue !== "object") return "校验未通过";
    const value = issue as Record<string, unknown>;
    const path = Array.isArray(value.path) ? value.path.slice(0, 12).map(key => typeof key === "number" && Number.isInteger(key) && key >= 0 && key <= 100_000 ? `[${key}]` : typeof key === "string" && names.has(key) && /^[A-Za-z_$][\w$-]{0,80}$/u.test(key) ? key : "[字段]").join(".") : "根对象";
    const code = typeof value.code === "string" && ["invalid_type", "too_big", "too_small", "invalid_format", "not_multiple_of", "unrecognized_keys", "invalid_union", "invalid_key", "invalid_element", "invalid_value", "custom"].includes(value.code) ? value.code : "validation_failed";
    const expected = typeof value.expected === "string" && ["string", "number", "int", "boolean", "object", "array", "null", "undefined"].includes(value.expected) ? `，期望 ${value.expected}` : "";
    return `${path || "根对象"}：${code}${expected}`;
  });
  return `模型已返回结果，但未通过应用输出校验。${details.length ? `\n${details.join("\n")}` : "校验器未提供结构化错误详情。"}`;
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

/** The gateway's deadline for a call: none for a backend that times its own (SemanticClassifier.queuesCalls). */
const attemptDeadline = (provider: SemanticClassifier, timeoutMs: number): number | undefined =>
  provider.queuesCalls === true ? undefined : timeoutMs;

/** A model call's failure as the reader is told it, by its code. */
export const modelFailureMessage = (code: string): string =>
  code === "invalid_configuration" ? "模型配置或输出格式不受支持，请检查模型设置或选择其他模型。" :
  code === "authentication_failed" || code === "authorization_failed" || code === "credential_unavailable" || code === "credential_decryption_failed" ? "模型凭据或访问权限不可用，请在模型设置中检查。" :
  code === "timeout" ? "模型调用超时，请重试或调整模型超时设置。" :
  code === "rate_limited" ? "模型服务限流：请求太密，稍后再试或减少同时进行的评审。" :
  code === "quota_exhausted" ? "模型服务的额度或余额不足，请到服务商处充值或检查套餐后再试。" :
  code === "invalid_output" || code === "output_limit" ? "模型的回答不符合要求的格式（例如超出长度），请重试或换一个模型。" :
  code === "network_error" ? "连不上模型服务，请检查网络后重试。" :
  code === "provider_unavailable" ? "所选模型不可用，请在模型页检查运行状态。" : "模型调用或结构化输出失败，请查看模型调用记录。";

export class ProfiledModelGatewayError extends Error {
  readonly code = "provider_unavailable" as const;

  constructor(
    message: string,
    readonly failureCode: ModelInvocationErrorCode = "provider_unavailable",
    /** What the last failed call cost, when the provider said: a turn that retries still paid for it. */
    readonly usage?: NormalizedTokenUsage,
    /** What the model answered, when the answer was refused for its shape: the reader can see what it said. */
    readonly output?: string,
  ) {
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
  readonly #unattendedGenerationMs: number;
  readonly #longLivedProviders = new Map<
    string,
    SemanticClassifier
  >();
  #closed = false;
  /**
   * Aborted by close(). A call still running at quit (an answer, a methodology draft) is cancelled
   * rather than left to finish on its own: a CLI backend runs in its own process group, which nothing
   * else would stop, and goes on with a call that is billed.
   */
  readonly #closing = new AbortController();

  constructor(options: ProfiledModelGatewayOptions) {
    this.#profiles = options.profiles;
    this.#providerFactory = options.providerFactory;
    this.#traces = options.traces;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#unattendedGenerationMs = options.unattendedGenerationMs ?? 5 * 60_000;
  }

  async classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
    auditContext?: SemanticClassificationAuditContext,
  ): Promise<SemanticClassification> {
    this.#requireOpen();
    signal = this.#cancellable(signal);
    if (signal?.aborted) throw new ModelProviderError("cancelled", "Model call was cancelled");
    const requestId = this.#idFactory();
    const profiles = enabledProfiles(
      await this.#profiles.load(),
    );
    let attemptIndex = 0;
    for (const profile of profiles) {
      this.#requireOpen();
      if (signal?.aborted) throw new ModelProviderError("cancelled", "Model call was cancelled");
      let invocationStarted = false;
      let provider: SemanticClassifier | undefined;
      try {
        provider = this.#provider(profile);
        // Timed as its calls are: Qwen checks its whole model file the first time, seconds on a slow or busy Mac,
        // and cut off at five it was filed as failed and the conversation went down the chain to a remote backend.
        const status = await withProviderDeadline(() => provider!.status(), attemptDeadline(provider, Math.min(profile.timeoutMs, 5_000)), signal);
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
          if (profile.fallbackOnFailure === false) break;
          continue;
        }
        invocationStarted = true;
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
        if (signal?.aborted === true || this.#normalizeFailure(error).errorCode === "cancelled") {
          throw error;
        }
        if (!invocationStarted) {
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
        if (profile.fallbackOnFailure === false) throw error;
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
      "The model fallback chain failed or was stopped",
    );
  }

  /**
   * Runs the enabled providers in priority order, or exactly one when
   * `profileId` names it. A named profile never falls back to another
   * provider: the caller picked this model, and silently answering from a
   * different one — possibly a remote one — would break that choice.
   */
  async generate<T>(
    requestInput: StructuredGenerationRequest,
    parseOutput: (value: unknown) => T,
    signal?: AbortSignal,
    profileId?: string,
  ): Promise<ProfiledStructuredGenerationResult<T>> {
    if (signal !== undefined) return this.#generate(requestInput, parseOutput, signal, profileId);
    // No caller to stop it (a principle or skill draft): bounded as a whole, where a Qwen stuck checking or loading
    // its model kept the button turning until the app quit. Unhurried enough to wait its turn behind an answer.
    const unattended = AbortSignal.timeout(this.#unattendedGenerationMs);
    try {
      return await this.#generate(requestInput, parseOutput, unattended, profileId);
    } catch (error) {
      // Its own bound, not the reader, cut it short: said to be cancelled, it read as stopped by them.
      if (unattended.aborted && !this.#closed) throw new ProfiledModelGatewayError("Model call timed out", "timeout");
      throw error;
    }
  }

  async #generate<T>(
    requestInput: StructuredGenerationRequest,
    parseOutput: (value: unknown) => T,
    signal: AbortSignal,
    profileId?: string,
  ): Promise<ProfiledStructuredGenerationResult<T>> {
    this.#requireOpen();
    signal = this.#cancellable(signal);
    if (signal?.aborted) throw new ModelProviderError("cancelled", "Model call was cancelled");
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
    const available = enabledProfiles(
      await this.#profiles.load(),
    );
    const profiles =
      profileId === undefined
        ? available
        : available.filter(
            (candidate) => candidate.profileId === profileId,
          );
    if (profiles.length === 0 && profileId !== undefined) {
      throw new ProfiledModelGatewayError(
        `Model profile ${profileId} is not enabled`,
      );
    }
    let attemptIndex = 0;
    let failureCode: ModelInvocationErrorCode = "provider_unavailable";
    let failureUsage: NormalizedTokenUsage | undefined;
    let failureOutput: string | undefined;
    for (const profile of profiles) {
      this.#requireOpen();
      if (signal?.aborted) throw new ModelProviderError("cancelled", "Model call was cancelled");
      let invocationStarted = false;
      let provider: SemanticClassifier | undefined;
      try {
        provider = this.#provider(profile);
        // A backend that cannot generate at all (Apple's) is passed over, as the docs say: that is not
        // a failure for "fall back on failure" to stop at, and whether it is up does not matter here.
        if (!supportsStructuredGeneration(provider)) {
          failureCode = "unsupported_client";
          // An earlier profile's refused answer is not this failure's: the chain's error carried it as if it were.
          failureOutput = undefined;
          await this.#recordStructuredFailure({
            request,
            attemptIndex,
            profile,
            statusKind: "unavailable",
            errorCode: "unsupported_client",
          });
          continue;
        }
        // Timed as its calls are (see classify).
        const status = await withProviderDeadline(() => provider!.status(), attemptDeadline(provider, Math.min(profile.timeoutMs, 5_000)), signal);
        if (status.availability !== "available") {
          failureCode = "provider_unavailable";
          failureOutput = undefined;
          await this.#recordStructuredFailure({
            request,
            attemptIndex,
            profile,
            status,
            statusKind: "unavailable",
            errorCode: "provider_unavailable",
          });
          if (profile.fallbackOnFailure === false) break;
          continue;
        }
        invocationStarted = true;
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
        const failure = this.#normalizeFailure(error);
        failureCode = failure.errorCode;
        failureUsage = failure.usage;
        failureOutput = error instanceof ModelProviderError ? error.visibleOutput : undefined;
        if (signal?.aborted === true || failure.errorCode === "cancelled") {
          throw error;
        }
        if (!invocationStarted) {
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
        // Stopped here by the reader's choice, the chain still ends as a chain does: with the gateway's
        // error, which a turn retries and reports, not the provider's own.
        if (profile.fallbackOnFailure === false) break;
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
      "The structured model fallback chain failed or was stopped",
      failureCode,
      failureUsage,
      failureOutput,
    );
  }

  /** Enabled providers in priority order; the first is the default. */
  async listGenerationProfiles(): Promise<ModelProviderProfile[]> {
    this.#requireOpen();
    return enabledProfiles(await this.#profiles.load());
  }

  /**
   * What to report when nothing will be asked of a model. Probing a backend
   * to name it as the engine would be a lie: the reader turned the model out
   * of the capture path, and the rules are what read every turn now.
   */
  async statusWithoutModel(): Promise<SemanticRecognitionStatus> {
    this.#requireOpen();
    const summary = await this.#audit.summary();
    return semanticRecognitionStatusSchema.parse({
      provider: "rules",
      providerLabel: "规则识别",
      availability: "available",
      mode: "rules_only",
      processed7d: summary.processed,
      high7d: summary.high,
      medium7d: summary.medium,
      failures7d: summary.failures,
      updatedAt: this.#now().toISOString(),
    });
  }

  async status(): Promise<SemanticRecognitionStatus> {
    this.#requireOpen();
    const [profiles, summary] = await Promise.all([
      this.#profiles.load(),
      this.#audit.summary(),
    ]);
    const unavailableModels: NonNullable<SemanticRecognitionStatus["unavailableModels"]> = [];
    for (const profile of enabledProfiles(profiles)) {
      let provider: SemanticClassifier | undefined;
      let availability: SemanticRecognitionStatus["availability"] = "unavailable";
      try {
        provider = this.#provider(profile);
        const status = await withProviderDeadline(() => provider!.status(), Math.min(profile.timeoutMs, 5_000), this.#closing.signal);
        availability = status.availability;
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
      unavailableModels.push({ providerLabel: profile.label, availability });
      if (profile.fallbackOnFailure === false) break;
    }
    // The rules read every turn now, and work: named "temporarily unavailable" in 混合模式, they hid that Apple
    // Intelligence was off or the model not installed, which the reader has to fix.
    return semanticRecognitionStatusSchema.parse({
      provider: "rules",
      providerLabel: "规则识别",
      availability: "available",
      mode: "rules_only",
      unavailableModels,
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
      const status = await withProviderDeadline(() => provider!.status(), Math.min(profile.timeoutMs, 5_000), this.#closing.signal);
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
        signal: this.#closing.signal,
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
    this.#closing.abort();
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
        // Kept for the life of the app, it takes the profile's timeout as it is now: changed in
        // settings, it applies from the next call, as it does for every other backend.
        existing.setTimeoutMs?.(profile.timeoutMs);
        if (profile.model !== undefined) existing.setModel?.(profile.model);
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
      // The settings test keeps the profile's time: it falls back to nothing, and untimed, a Qwen busy with the
      // reader's answer (or stuck loading) kept the test button turning with no way to stop it.
      const timeoutMs = options.purpose === "provider-health-check"
        ? options.profile.timeoutMs
        : attemptDeadline(options.provider, options.profile.timeoutMs);
      const attempt = await withProviderDeadline((signal) => options.provider.invoke(options.input, signal), timeoutMs, options.signal);
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
          input: this.#traceInput(
            options.input,
            options.profile,
          ),
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
      const attempt = await withProviderDeadline((signal) => options.provider.generate(options.request, signal), attemptDeadline(options.provider, Math.max(options.profile.timeoutMs, MIN_GENERATION_TIMEOUT_MS)), options.signal);
      let parsedOutput: T;
      try {
        parsedOutput = options.parseOutput(
          attempt.parsedOutput,
        );
      } catch (error) {
        // Answered and billed, just not in the shape this purpose takes: what it cost and what it said
        // go to the trace, and the cost to the turn.
        throw new ModelProviderError(
          "invalid_output",
          "Model provider output failed application schema validation",
          {
            diagnosticExcerpt: outputValidationDiagnostic(error, options.request.outputSchema),
            traceInput: attempt.traceInput,
            usage: attempt.usage,
            visibleOutput: attempt.visibleOutput,
            providerRequestId: attempt.providerRequestId,
          },
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
        request: traceRequestSettings(options.request, options.profile),
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
        ...(failure.traceInput === undefined ? {} : { traceInput: failure.traceInput }),
        errorCode: failure.errorCode,
        ...(failure.usage === undefined
          ? {}
          : { usage: failure.usage }),
        ...(failure.visibleOutput === undefined
          ? {}
          : { visibleOutput: failure.visibleOutput }),
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
    traceInput?: ModelInvocationInput;
    attemptIndex: number;
    attemptId?: string;
    profile: ModelProviderProfile;
    status?: SemanticProviderStatus;
    statusKind: ModelInvocationStatus;
    errorCode: ModelInvocationErrorCode;
    usage?: NormalizedTokenUsage;
    visibleOutput?: string;
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
      request: traceRequestSettings(options.request, options.profile),
      input: options.traceInput ?? {
        systemPrompt: options.request.systemPrompt,
        userPrompt: options.request.userPrompt,
        outputSchema: options.request.outputSchema,
        clientSystemPromptVisibility: options.profile.kind === "codex-cli" || options.profile.kind === "claude-code-cli" ? "opaque" : "visible",
      },
      usage: options.usage ?? { source: "unavailable" },
      // `parsed` is null on purpose: nothing parsed, and the field is what
      // separates "the model answered and we could read it" from this.
      ...(options.visibleOutput === undefined
        ? {}
        : {
            output: {
              visibleText: options.visibleOutput,
              parsed: null,
            },
          }),
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
      ...(profile.pricing === undefined ? {} : { pricing: profile.pricing }),
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
        input: this.#traceInput(input, profile),
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
        input: this.#traceInput(input, profile),
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
      ...(profile.pricing === undefined ? {} : { pricing: profile.pricing }),
    };
  }

  #traceInput(
    input: SemanticClassifierInput,
    profile: ModelProviderProfile,
  ) {
    return {
      systemPrompt: semanticSystemPrompt,
      userPrompt: buildSemanticUserPrompt(input),
      outputSchema:
        profile.kind === "qwen"
          ? qwenSemanticOutputJsonSchema
          : semanticOutputJsonSchema,
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
    const traceInput = modelInvocationInputSchema.safeParse(error && typeof error === "object" && "traceInput" in error ? error.traceInput : undefined);
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
    const visibleOutput =
      error !== null &&
      typeof error === "object" &&
      "visibleOutput" in error &&
      typeof error.visibleOutput === "string" &&
      error.visibleOutput.length > 0
        ? error.visibleOutput
        : undefined;
    return {
      status,
      errorCode,
      ...(visibleOutput === undefined ? {} : { visibleOutput }),
      ...(traceInput.success ? { traceInput: traceInput.data } : {}),
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

  #cancellable(signal: AbortSignal | undefined): AbortSignal {
    return signal === undefined ? this.#closing.signal : AbortSignal.any([signal, this.#closing.signal]);
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new ProfiledModelGatewayError(
        "Profiled model gateway is closed",
      );
    }
  }
}
