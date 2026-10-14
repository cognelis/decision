import { z } from "zod";

export const MODEL_TRACE_VERSION = 1 as const;

export const managedQwenModelIdSchema = z.enum(["qwen3.5-2b-q4-k-m", "qwen3.5-4b-q4-k-m"]);
export type ManagedQwenModelId = z.infer<typeof managedQwenModelIdSchema>;
export const managedQwenModelStatusSchema = z.object({
  modelId: managedQwenModelIdSchema,
  status: z.enum(["available", "missing", "checksum_failed", "installing", "failed"]),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  error: z.string().max(2000).optional(),
}).strict().refine((value) => value.downloadedBytes <= value.totalBytes);
export type ManagedQwenModelStatus = z.infer<typeof managedQwenModelStatusSchema>;

const boundedText = (maximum: number) =>
  z.string().trim().min(1).max(maximum);
const identifierSchema = boundedText(200);
const tokenPriceSchema = z.number().nonnegative().max(1_000_000);
export const modelPricingSchema = z.object({
  currency: z.string().trim().min(1).max(8),
  inputPerMillion: tokenPriceSchema,
  outputPerMillion: tokenPriceSchema,
  cachedInputPerMillion: tokenPriceSchema.optional(),
  peak: z.object({
    inputPerMillion: tokenPriceSchema,
    outputPerMillion: tokenPriceSchema,
    cachedInputPerMillion: tokenPriceSchema,
    holidayYear: z.number().int().min(2000).max(2100),
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((date) => Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date))).min(1).max(366),
  }).strict().superRefine((peak, context) => {
    if (peak.holidays.some((date) => !date.startsWith(`${peak.holidayYear}-`))) context.addIssue({ code: "custom", path: ["holidays"], message: "节假日日期必须属于日历年份" });
  }).optional(),
}).strict().superRefine((price, context) => {
  if (price.peak !== undefined && price.cachedInputPerMillion === undefined) context.addIssue({ code: "custom", path: ["cachedInputPerMillion"], message: "峰谷计费需要空闲时段缓存命中单价" });
});
export type ModelPricing = z.infer<typeof modelPricingSchema>;
/** A prompt's ceiling before it crosses a provider boundary. */
const PROMPT_CHARS = 20_000;
/**
 * A PR review's: it budgets its own prompts to the model it calls (a local model's stay far under the ordinary
 * ceiling) and needs the room only to read a whole PR with a remote model, as pr-agent and Claude Code do.
 */
const PR_REVIEW_PROMPT_CHARS = 120_000;
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => JSON.stringify(value).length <= 20_000,
    "JSON value exceeds 20000 characters",
  );

export const modelPurposeSchema = z.enum([
  "semantic-classification",
  "provider-health-check",
  "methodology-extraction",
  "skill-drafting",
  "workflow-drafting",
  "retrieval-answer",
  "pr-review",
]);

export const modelBackendKindSchema = z.enum([
  "apple",
  "qwen",
  "openai",
  "anthropic",
  "openai-compatible",
  "codex-cli",
  "claude-code-cli",
]);

export const modelProviderKindSchema = modelBackendKindSchema;
export const modelApiProtocolSchema = z.enum([
  "responses",
  "chat-completions",
  "messages",
]);

export const modelProxySchema = z.object({
  mode: z.enum(["environment", "direct", "custom"]),
  url: z.string().trim().min(1).max(2_000).refine((value) => {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash; } catch { return false; }
  }, "Proxy must be an HTTP(S) origin without credentials, path, query or fragment").optional(),
  noProxy: z.string().trim().max(2_000).refine((value) => !/[\0\r\n]/u.test(value), "Invalid proxy bypass list").optional(),
}).strict().superRefine((proxy, context) => {
  if ((proxy.mode === "custom") !== (proxy.url !== undefined)) context.addIssue({ code: "custom", path: ["url"], message: "Only custom proxy mode requires a proxy URL" });
  if (proxy.mode !== "custom" && proxy.noProxy !== undefined) context.addIssue({ code: "custom", path: ["noProxy"], message: "Only custom proxy mode configures bypass hosts" });
});
export type ModelProxy = z.infer<typeof modelProxySchema>;

const modelProviderProfileBaseSchema = z
  .object({
    version: z.literal(1),
    profileId: identifierSchema,
    kind: modelProviderKindSchema,
    label: boundedText(100),
    enabled: z.boolean(),
    priority: z.number().int().min(0).max(10_000),
    model: boundedText(200).optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000),
    executablePath: boundedText(2_000).optional(),
    baseUrl: z.string().url().max(2_000).optional(),
    apiProtocol: modelApiProtocolSchema.optional(),
    credentialRef: identifierSchema.optional(),
    proxy: modelProxySchema.optional(),
    /**
     * How an OpenAI-compatible endpoint is asked for JSON. "schema" sends a
     * strict json_schema response_format; "object" sends json_object and
     * describes the shape in the prompt instead, for services such as
     * DeepSeek that accept json_object only. Defaults to "schema".
     */
    jsonMode: z.enum(["schema", "object"]).optional(),
    fallbackOnFailure: z.boolean().optional(),
    /**
     * What this backend charges, supplied by the user. Deliberately not a
     * built-in table: vendor prices change, and a stale table would print
     * confident numbers that are quietly wrong. Absent means costs are shown
     * in tokens only.
     */
    pricing: modelPricingSchema.optional(),
  })
  .strict();

const remoteKinds = new Set([
  "openai",
  "anthropic",
  "openai-compatible",
]);
const cliKinds = new Set(["codex-cli", "claude-code-cli"]);

const isSecureModelBaseUrl = (value: string): boolean => {
  const url = new URL(value);
  if (url.username.length > 0 || url.password.length > 0) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol !== "http:") {
    return false;
  }
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"
  );
};

const refineProviderProfile = (
  profile: {
    kind: z.infer<typeof modelProviderKindSchema>;
    model?: string | undefined;
    executablePath?: string | undefined;
    baseUrl?: string | undefined;
    apiProtocol?:
      | z.infer<typeof modelApiProtocolSchema>
      | undefined;
    credentialRef?: string | undefined;
    proxy?: ModelProxy | undefined;
  },
  context: z.RefinementCtx,
  credentialRequired: boolean,
): void => {
  const remote = remoteKinds.has(profile.kind);
  const cli = cliKinds.has(profile.kind);
  if (profile.kind === "qwen" && !managedQwenModelIdSchema.safeParse(profile.model).success) context.addIssue({ code: "custom", path: ["model"], message: "请选择受支持的 2B 或 4B 本地模型" });
  if (!remote && !cli && profile.proxy !== undefined) context.addIssue({ code: "custom", path: ["proxy"], message: "Only remote and CLI providers support proxy settings" });
  if (!cli && profile.model === undefined) {
    context.addIssue({
      code: "custom",
      message: "model is required for this provider kind",
      path: ["model"],
    });
  }
  if (remote) {
    if (profile.baseUrl === undefined) {
      context.addIssue({
        code: "custom",
        message: "baseUrl is required for remote providers",
        path: ["baseUrl"],
      });
    } else if (!isSecureModelBaseUrl(profile.baseUrl)) {
      context.addIssue({
        code: "custom",
        message:
          "model provider URLs require HTTPS or HTTP loopback",
        path: ["baseUrl"],
      });
    }
    if (profile.apiProtocol === undefined) {
      context.addIssue({
        code: "custom",
        message: "apiProtocol is required for remote providers",
        path: ["apiProtocol"],
      });
    }
    if (credentialRequired && profile.credentialRef === undefined) {
      context.addIssue({
        code: "custom",
        message: "credentialRef is required for remote providers",
        path: ["credentialRef"],
      });
    }
    if (profile.executablePath !== undefined) {
      context.addIssue({
        code: "custom",
        message: "remote providers cannot configure an executable",
        path: ["executablePath"],
      });
    }
    if (
      profile.kind === "openai" &&
      profile.apiProtocol !== "responses"
    ) {
      context.addIssue({
        code: "custom",
        message: "OpenAI profiles use the Responses protocol",
        path: ["apiProtocol"],
      });
    }
    if (
      profile.kind === "anthropic" &&
      profile.apiProtocol !== "messages"
    ) {
      context.addIssue({
        code: "custom",
        message: "Anthropic profiles use the Messages protocol",
        path: ["apiProtocol"],
      });
    }
    if (
      profile.kind === "openai-compatible" &&
      profile.apiProtocol !== "responses" &&
      profile.apiProtocol !== "chat-completions"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "OpenAI-compatible profiles use Responses or Chat Completions",
        path: ["apiProtocol"],
      });
    }
    return;
  }
  if (
    profile.baseUrl !== undefined ||
    profile.apiProtocol !== undefined ||
    profile.credentialRef !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "local providers cannot configure remote credentials",
      path: ["kind"],
    });
  }
  if (!cli && profile.executablePath !== undefined) {
    context.addIssue({
      code: "custom",
      message: "only CLI providers can configure an executable",
      path: ["executablePath"],
    });
  }
};

export const modelProviderProfileSchema =
  modelProviderProfileBaseSchema.superRefine((profile, context) =>
    refineProviderProfile(profile, context, true),
  );

export const redactedModelProviderProfileSchema =
  modelProviderProfileBaseSchema
    .omit({ credentialRef: true })
    .extend({
      credentialConfigured: z.boolean(),
    })
    .strict()
    .superRefine((profile, context) =>
      refineProviderProfile(
        { ...profile, credentialRef: undefined },
        context,
        false,
      ),
    );

export const modelProviderProfilesDocumentSchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(modelProviderProfileSchema).max(100),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    const priorities = new Set<number>();
    for (const [index, profile] of document.profiles.entries()) {
      if (ids.has(profile.profileId)) {
        context.addIssue({
          code: "custom",
          message: `duplicate provider profile ID: ${profile.profileId}`,
          path: ["profiles", index, "profileId"],
        });
      }
      if (priorities.has(profile.priority)) {
        context.addIssue({
          code: "custom",
          message: `duplicate provider priority: ${profile.priority}`,
          path: ["profiles", index, "priority"],
        });
      }
      ids.add(profile.profileId);
      priorities.add(profile.priority);
    }
  });

export const localModelClientStatusSchema = z
  .object({
    kind: z.enum(["codex-cli", "claude-code-cli"]),
    executablePath: boundedText(2_000).optional(),
    version: boundedText(200).optional(),
    authenticated: z.boolean(),
    supported: z.boolean(),
    availability: z.enum([
      "available",
      "not_found",
      "not_executable",
      "logged_out",
      "unsupported",
      "diagnostics_failed",
    ]),
    checkedAt: z.string().datetime(),
    modelsSource: z.enum(["server", "client", "cache"]).optional(),
    models: z.array(z.object({ id: boundedText(200), label: boundedText(200) }).strict()).max(100).optional(),
  })
  .strict();

export const modelTraceContentModeSchema = z.enum([
  "full",
  "metadata-only",
]);

export const modelInvocationStatusSchema = z.enum([
  "succeeded",
  "timed_out",
  "cancelled",
  "auth_failed",
  "unavailable",
  "invalid_output",
  "failed",
]);

export const modelInvocationErrorCodeSchema = z.enum([
  "timeout",
  "cancelled",
  "authentication_failed",
  "authorization_failed",
  "rate_limited",
  "quota_exhausted",
  "provider_unavailable",
  "invalid_output",
  "output_limit",
  "invalid_configuration",
  "credential_unavailable",
  "credential_decryption_failed",
  "network_error",
  "response_too_large",
  "redirect_rejected",
  "process_failed",
  "executable_missing",
  "unsupported_client",
  "trace_write_failed",
  "unknown",
]);

export const normalizedTokenUsageSchema = z
  .object({
    source: z.enum([
      "provider_reported",
      "runtime_measured",
      "estimated",
      "unavailable",
    ]),
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningOutputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .strict();

export const modelTimingSchema = z
  .object({
    queuedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    providerMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    firstOutputMs: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    totalMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const structuredGenerationRequestSchema = z
  .object({
    requestId: identifierSchema,
    purpose: modelPurposeSchema,
    correlationFingerprint: fingerprintSchema.optional(),
    promptVersion: boundedText(100),
    schemaVersion: boundedText(100),
    locale: boundedText(50),
    systemPrompt: boundedText(PR_REVIEW_PROMPT_CHARS),
    userPrompt: boundedText(PR_REVIEW_PROMPT_CHARS),
    outputSchema: jsonObjectSchema,
    maxOutputTokens: z.number().int().positive().max(8_192),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.purpose === "pr-review") return;
    for (const key of ["systemPrompt", "userPrompt"] as const) {
      if (request[key].length > PROMPT_CHARS) context.addIssue({ code: "custom", path: [key], message: `Prompt exceeds ${PROMPT_CHARS} characters` });
    }
  });

export const modelInvocationProfileSchema = z
  .object({
    profileId: identifierSchema,
    backend: modelBackendKindSchema,
    provider: boundedText(100),
    model: boundedText(200),
    providerVersion: boundedText(200).optional(),
    promptVersion: boundedText(100),
    schemaVersion: boundedText(100),
    pricing: modelPricingSchema.optional(),
  })
  .strict();

export const modelInvocationInputSchema = z
  .object({
    systemPrompt: boundedText(PR_REVIEW_PROMPT_CHARS),
    userPrompt: boundedText(PR_REVIEW_PROMPT_CHARS),
    outputSchema: jsonObjectSchema,
    clientSystemPromptVisibility: z
      .enum(["visible", "opaque"])
      .optional(),
  })
  .strict();

export const modelInvocationOutputSchema = z
  .object({
    visibleText: boundedText(20_000),
    parsed: z.unknown(),
  })
  .strict();

export const modelInvocationTraceSchema = z
  .object({
    version: z.literal(MODEL_TRACE_VERSION),
    traceId: identifierSchema,
    requestId: identifierSchema,
    attemptId: identifierSchema,
    attemptIndex: z.number().int().nonnegative().max(1_000),
    purpose: modelPurposeSchema,
    correlationFingerprint: fingerprintSchema.optional(),
    contentMode: modelTraceContentModeSchema.optional(),
    profile: modelInvocationProfileSchema,
    input: modelInvocationInputSchema.optional(),
    output: modelInvocationOutputSchema.optional(),
    usage: normalizedTokenUsageSchema,
    timing: modelTimingSchema,
    status: modelInvocationStatusSchema,
    errorCode: modelInvocationErrorCodeSchema.optional(),
    providerRequestId: boundedText(500).optional(),
    processExitCode: z.number().int().optional(),
    diagnosticExcerpt: boundedText(2_000).optional(),
    request: z.object({
      clientExecutable: boundedText(2_000).optional(),
      configuredTimeoutMs: z.number().int().min(1_000).max(120_000),
      generationTimeoutMs: z.number().int().min(1_000).max(120_000),
      requestedMaxOutputTokens: z.number().int().positive().max(8_192),
      systemPromptChars: z.number().int().nonnegative().max(PR_REVIEW_PROMPT_CHARS),
      userPromptChars: z.number().int().nonnegative().max(PR_REVIEW_PROMPT_CHARS),
    }).strict().optional(),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict()
  .superRefine((trace, context) => {
    if (Date.parse(trace.expiresAt) <= Date.parse(trace.createdAt)) {
      context.addIssue({
        code: "custom",
        message: "model trace expiry must follow creation",
        path: ["expiresAt"],
      });
    }
    if (trace.contentMode === "metadata-only") {
      if (trace.input !== undefined) {
        context.addIssue({
          code: "custom",
          message: "metadata-only trace cannot contain input",
          path: ["input"],
        });
      }
      if (trace.output !== undefined) {
        context.addIssue({
          code: "custom",
          message: "metadata-only trace cannot contain output",
          path: ["output"],
        });
      }
    }
  });

export const modelTraceSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    requests: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    contentMode: modelTraceContentModeSchema,
    oldestCreatedAt: z.string().datetime().optional(),
    newestCreatedAt: z.string().datetime().optional(),
  })
  .strict();

export type ModelPurpose = z.infer<typeof modelPurposeSchema>;
export type ModelBackendKind = z.infer<
  typeof modelBackendKindSchema
>;
export type ModelProviderKind = z.infer<
  typeof modelProviderKindSchema
>;
export type ModelApiProtocol = z.infer<
  typeof modelApiProtocolSchema
>;
export type ModelProviderProfile = z.infer<
  typeof modelProviderProfileSchema
>;
export type RedactedModelProviderProfile = z.infer<
  typeof redactedModelProviderProfileSchema
>;
export type ModelProviderProfilesDocument = z.infer<
  typeof modelProviderProfilesDocumentSchema
>;
export type LocalModelClientStatus = z.infer<
  typeof localModelClientStatusSchema
>;
export type ModelTraceContentMode = z.infer<
  typeof modelTraceContentModeSchema
>;
export type ModelInvocationStatus = z.infer<
  typeof modelInvocationStatusSchema
>;
export type ModelInvocationErrorCode = z.infer<
  typeof modelInvocationErrorCodeSchema
>;
export type NormalizedTokenUsage = z.infer<
  typeof normalizedTokenUsageSchema
>;
export type ModelTiming = z.infer<typeof modelTimingSchema>;
export type StructuredGenerationRequest = z.infer<
  typeof structuredGenerationRequestSchema
>;
export type ModelInvocationProfile = z.infer<
  typeof modelInvocationProfileSchema
>;
export type ModelInvocationInput = z.infer<
  typeof modelInvocationInputSchema
>;
export type ModelInvocationOutput = z.infer<
  typeof modelInvocationOutputSchema
>;
export type ModelInvocationTrace = z.infer<
  typeof modelInvocationTraceSchema
>;
export type ModelTraceSummary = z.infer<
  typeof modelTraceSummarySchema
>;
