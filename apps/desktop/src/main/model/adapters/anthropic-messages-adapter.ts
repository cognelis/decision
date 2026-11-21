import {
  clipText,
  modelProviderProfileSchema,
  type ModelProviderProfile,
  type NormalizedTokenUsage,
  type SemanticClassification,
  type StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import type {
  SemanticClassifierInput,
  SemanticProviderAttempt,
} from "../../semantic/semantic-classifier.js";
import {
  HttpModelTransport,
  ModelProviderError,
  providerEndpoint,
} from "../http-model-transport.js";
import {
  buildSemanticUserPrompt,
  SEMANTIC_PROMPT_VERSION,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../semantic-prompt.js";
import {
  parseSemanticOutput,
  type ModelCredentialLookup,
  type ModelHttpTransport,
} from "./openai-responses-adapter.js";
import {
  MIN_GENERATION_TIMEOUT_MS,
  parseStructuredJson,
  type StructuredProviderAttempt,
} from "../structured-provider.js";
import { anthropicOutputSchema } from "./anthropic-output-schema.js";

const MAXIMUM_RESPONSE_BYTES = 1_048_576;

export interface AnthropicMessagesAdapterOptions {
  profile: ModelProviderProfile;
  credentials: ModelCredentialLookup;
  transport?: ModelHttpTransport;
  clock?: () => number;
}

const responseSchema = z
  .object({
    id: z.string().trim().min(1).max(500).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    stop_reason: z.string().max(100).nullable().optional(),
    content: z
      .array(
        z
          .object({
            type: z.string().max(100),
            text: z.string().max(20_000).optional(),
          })
          .passthrough(),
      )
      .max(100),
    usage: z
      .object({
        input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        cache_creation_input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        cache_read_input_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        output_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        output_tokens_details: z
          .object({
            thinking_tokens: z
              .number()
              .int()
              .nonnegative()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const invalidOutput = (
  message: string,
  providerRequestId?: string,
  /** What the call cost before it failed: one that ran out of budget was still billed. */
  usage?: NormalizedTokenUsage,
): ModelProviderError =>
  new ModelProviderError("invalid_output", message, {
    ...(providerRequestId === undefined
      ? {}
      : { providerRequestId }),
    ...(usage === undefined ? {} : { usage }),
  });

const normalizeUsage = (
  usage: z.infer<typeof responseSchema>["usage"],
): NormalizedTokenUsage => {
  if (usage === undefined) {
    return { source: "unavailable" };
  }
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const hasReportedValue =
    inputTokens !== undefined ||
    outputTokens !== undefined ||
    usage.cache_read_input_tokens !== undefined ||
    usage.output_tokens_details?.thinking_tokens !== undefined;
  if (!hasReportedValue) {
    return { source: "unavailable" };
  }
  return {
    source: "provider_reported",
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(usage.cache_read_input_tokens === undefined
      ? {}
      : {
          cachedInputTokens:
            usage.cache_read_input_tokens,
        }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(usage.output_tokens_details?.thinking_tokens ===
    undefined
      ? {}
      : {
          reasoningOutputTokens:
            usage.output_tokens_details.thinking_tokens,
        }),
    ...(inputTokens === undefined || outputTokens === undefined
      ? {}
      : { totalTokens: inputTokens + outputTokens }),
  };
};

/**
 * Anthropic's safety classifiers decline a request as a 200 with stop_reason "refusal", saying why in stop_details (a
 * policy category and an explanation of the decline, not the request); a part written before it is to be discarded.
 * Filed as output that would not parse, the same request was asked again and the reader sent to look at the model's answer.
 */
const refused = (
  data: z.infer<typeof responseSchema>,
  providerRequestId: string | undefined,
): ModelProviderError => {
  const details = data.stop_details !== null && typeof data.stop_details === "object" ? data.stop_details as Record<string, unknown> : {};
  const said = [
    typeof details.category === "string" ? `category=${clipText(details.category, 100)}` : "",
    typeof details.explanation === "string" ? clipText(details.explanation, 300) : "",
  ].filter((part) => part.length > 0);
  return new ModelProviderError("content_refused", ["Anthropic declined the request · stop_reason=refusal", ...said].join(" · "), {
    providerRequestId,
    // Some categories are billed before any output: what the call cost goes with it.
    usage: normalizeUsage(data.usage),
  });
};

export class AnthropicMessagesAdapter {
  readonly id = "anthropic" as const;
  readonly #profile: ModelProviderProfile;
  readonly #credentials: ModelCredentialLookup;
  readonly #transport: ModelHttpTransport;
  readonly #clock: () => number;

  constructor(options: AnthropicMessagesAdapterOptions) {
    const parsed = modelProviderProfileSchema.safeParse(
      options.profile,
    );
    if (
      !parsed.success ||
      parsed.data.kind !== "anthropic" ||
      parsed.data.apiProtocol !== "messages"
    ) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Anthropic Messages provider configuration is invalid",
      );
    }
    this.#profile = parsed.data;
    this.#credentials = options.credentials;
    this.#transport =
      options.transport ?? new HttpModelTransport();
    this.#clock = options.clock ?? (() => performance.now());
  }

  async status() {
    return {
      id: this.id,
      availability: "available" as const,
      ...(this.#profile.model === undefined
        ? {}
        : { modelVersion: this.#profile.model }),
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
    const apiKey = await this.#credentials.get(
      this.#profile.credentialRef!,
    );
    if (apiKey === null) {
      throw new ModelProviderError(
        "credential_unavailable",
        "Model provider credential is unavailable",
      );
    }
    const userPrompt = buildSemanticUserPrompt(input);
    const outputSchema = anthropicOutputSchema(semanticOutputJsonSchema);
    const startedAt = this.#clock();
    const response = await this.#transport.postJson({
      provider: this.#profile.kind,
      model: this.#profile.model,
      url: providerEndpoint(this.#profile.baseUrl!, "/messages"),
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: {
        model: this.#profile.model!,
        max_tokens: 256,
        system: semanticSystemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        output_config: {
          format: {
            type: "json_schema",
            schema: outputSchema,
          },
        },
      },
      timeoutMs: this.#profile.timeoutMs,
      ...(this.#profile.proxy === undefined ? {} : { proxy: this.#profile.proxy }),
      maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
      secrets: [apiKey],
      ...(signal === undefined ? {} : { signal }),
    });
    const providerDurationMs = Math.max(
      0,
      this.#clock() - startedAt,
    );
    const parsed = responseSchema.safeParse(response.json);
    const responseRequestId =
      parsed.success && parsed.data.id !== undefined
        ? parsed.data.id
        : response.requestId;
    if (!parsed.success) {
      throw invalidOutput(
        "Anthropic returned an invalid Messages payload",
        responseRequestId,
      );
    }
    if (parsed.data.stop_reason === "refusal") {
      throw refused(parsed.data, responseRequestId);
    }
    const visibleOutput = parsed.data.content
      .filter(
        (
          item,
        ): item is typeof item & { text: string } =>
          item.type === "text" && item.text !== undefined,
      )
      .map((item) => item.text)
      .join("");
    if (visibleOutput.trim().length === 0) {
      throw invalidOutput(
        "Anthropic returned no visible structured output",
        responseRequestId,
      );
    }
    const classification = parseSemanticOutput(
      visibleOutput,
      this.id,
      parsed.data.model ?? this.#profile.model!,
      responseRequestId,
    );
    return {
      classification,
      visibleOutput,
      traceInput: {
        systemPrompt: semanticSystemPrompt,
        userPrompt,
        outputSchema,
        clientSystemPromptVisibility: "visible",
      },
      usage: normalizeUsage(parsed.data.usage),
      providerDurationMs,
      ...(responseRequestId === undefined
        ? {}
        : { providerRequestId: responseRequestId }),
    };
  }

  async generate(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredProviderAttempt> {
    const outputSchema = anthropicOutputSchema(request.outputSchema);
    const apiKey = await this.#credentials.get(
      this.#profile.credentialRef!,
    );
    if (apiKey === null) {
      throw new ModelProviderError(
        "credential_unavailable",
        "Model provider credential is unavailable",
      );
    }
    const startedAt = this.#clock();
    const response = await this.#transport.postJson({
      provider: this.#profile.kind,
      model: this.#profile.model,
      url: providerEndpoint(this.#profile.baseUrl!, "/messages"),
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: {
        model: this.#profile.model!,
        max_tokens: request.maxOutputTokens,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userPrompt }],
        output_config: {
          format: {
            type: "json_schema",
            schema: outputSchema,
          },
        },
      },
      timeoutMs: Math.max(this.#profile.timeoutMs, MIN_GENERATION_TIMEOUT_MS),
      ...(this.#profile.proxy === undefined ? {} : { proxy: this.#profile.proxy }),
      maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
      secrets: [apiKey],
      ...(signal === undefined ? {} : { signal }),
    });
    const providerDurationMs = Math.max(
      0,
      this.#clock() - startedAt,
    );
    const parsed = responseSchema.safeParse(response.json);
    const responseRequestId =
      parsed.success && parsed.data.id !== undefined
        ? parsed.data.id
        : response.requestId;
    if (!parsed.success) {
      throw invalidOutput(
        "Anthropic returned an invalid Messages payload",
        responseRequestId,
      );
    }
    if (parsed.data.stop_reason === "refusal") {
      throw refused(parsed.data, responseRequestId);
    }
    const visibleOutput = parsed.data.content
      .filter(
        (
          item,
        ): item is typeof item & { text: string } =>
          item.type === "text" && item.text !== undefined,
      )
      .map((item) => item.text)
      .join("");
    // Cut off at max_tokens (thinking can spend it all), the call was still billed: kept with the failure.
    const usage = normalizeUsage(parsed.data.usage);
    const stopReason = parsed.data.stop_reason ?? null;
    if (visibleOutput.trim().length === 0) {
      throw invalidOutput(
        `Anthropic returned no visible structured output${stopReason === null ? "" : ` · stop_reason=${stopReason}`}`,
        responseRequestId,
        usage,
      );
    }
    return {
      parsedOutput: parseStructuredJson(
        visibleOutput,
        responseRequestId,
        stopReason,
        usage,
      ),
      visibleOutput,
      modelVersion: parsed.data.model ?? this.#profile.model!,
      traceInput: {
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        outputSchema,
        clientSystemPromptVisibility: "visible",
      },
      usage: normalizeUsage(parsed.data.usage),
      providerDurationMs,
      ...(responseRequestId === undefined
        ? {}
        : { providerRequestId: responseRequestId }),
    };
  }

  async close(): Promise<void> {}
}
