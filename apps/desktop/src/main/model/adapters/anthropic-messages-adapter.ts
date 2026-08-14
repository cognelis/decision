import {
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
  parseStructuredJson,
  type StructuredProviderAttempt,
} from "../structured-provider.js";

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
): ModelProviderError =>
  new ModelProviderError("invalid_output", message, {
    ...(providerRequestId === undefined
      ? {}
      : { providerRequestId }),
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
    const startedAt = this.#clock();
    const response = await this.#transport.postJson({
      url: `${this.#profile.baseUrl!.replace(
        /\/+$/u,
        "",
      )}/v1/messages`,
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
            schema: semanticOutputJsonSchema,
          },
        },
      },
      timeoutMs: this.#profile.timeoutMs,
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
      throw invalidOutput(
        "Anthropic refused the structured request",
        responseRequestId,
      );
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
        outputSchema: semanticOutputJsonSchema,
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
      url: `${this.#profile.baseUrl!.replace(
        /\/+$/u,
        "",
      )}/v1/messages`,
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
            schema: request.outputSchema,
          },
        },
      },
      timeoutMs: this.#profile.timeoutMs,
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
      throw invalidOutput(
        "Anthropic refused the structured request",
        responseRequestId,
      );
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
    return {
      parsedOutput: parseStructuredJson(
        visibleOutput,
        responseRequestId,
      ),
      visibleOutput,
      modelVersion: parsed.data.model ?? this.#profile.model!,
      traceInput: {
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        outputSchema: request.outputSchema,
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
