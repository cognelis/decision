import {
  modelProviderProfileSchema,
  semanticClassificationSchema,
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
  type HttpModelRequest,
  type HttpModelResponse,
} from "../http-model-transport.js";
import {
  buildSemanticUserPrompt,
  SEMANTIC_PROMPT_VERSION,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../semantic-prompt.js";
import {
  parseStructuredJson,
  type StructuredProviderAttempt,
} from "../structured-provider.js";

const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const MAXIMUM_OUTPUT_TEXT = 20_000;

export interface ModelCredentialLookup {
  get(reference: string): Promise<string | null>;
}

export interface ModelHttpTransport {
  postJson(
    input: HttpModelRequest,
  ): Promise<HttpModelResponse>;
}

export interface OpenAIResponsesAdapterOptions {
  profile: ModelProviderProfile;
  credentials: ModelCredentialLookup;
  transport?: ModelHttpTransport;
  clock?: () => number;
  includeStoreFlag?: boolean;
}

const outputContentSchema = z
  .object({
    type: z.string().max(100),
    text: z.string().max(MAXIMUM_OUTPUT_TEXT).optional(),
  })
  .passthrough();

const responseSchema = z
  .object({
    id: z.string().trim().min(1).max(500).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    output: z
      .array(
        z
          .object({
            type: z.string().max(100),
            content: z
              .array(outputContentSchema)
              .max(100)
              .optional(),
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
        input_tokens_details: z
          .object({
            cached_tokens: z
              .number()
              .int()
              .nonnegative()
              .optional(),
          })
          .passthrough()
          .optional(),
        output_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        output_tokens_details: z
          .object({
            reasoning_tokens: z
              .number()
              .int()
              .nonnegative()
              .optional(),
          })
          .passthrough()
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

const endpoint = (
  baseUrl: string,
  path: string,
): string => `${baseUrl.replace(/\/+$/u, "")}${path}`;

const invalidOutput = (
  message: string,
  providerRequestId?: string,
): ModelProviderError =>
  new ModelProviderError("invalid_output", message, {
    ...(providerRequestId === undefined
      ? {}
      : { providerRequestId }),
  });

export const parseSemanticOutput = (
  visibleOutput: string,
  provider: string,
  modelVersion: string,
  providerRequestId?: string,
): SemanticClassification => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(visibleOutput);
  } catch {
    throw invalidOutput(
      "Model provider returned malformed semantic JSON",
      providerRequestId,
    );
  }
  const classification = semanticClassificationSchema.safeParse({
    ...(decoded !== null && typeof decoded === "object"
      ? decoded
      : {}),
    provider,
    modelVersion,
    promptVersion: SEMANTIC_PROMPT_VERSION,
  });
  if (!classification.success) {
    throw invalidOutput(
      "Model provider returned an invalid semantic classification",
      providerRequestId,
    );
  }
  return classification.data;
};

const usageFrom = (
  usage: z.infer<typeof responseSchema>["usage"],
  requireConsistentTotals: boolean,
): NormalizedTokenUsage =>
  usage === undefined ||
  usage.input_tokens === undefined ||
  usage.output_tokens === undefined ||
  usage.total_tokens === undefined ||
  (requireConsistentTotals &&
    (usage.total_tokens !==
      usage.input_tokens + usage.output_tokens ||
      (usage.input_tokens_details?.cached_tokens ?? 0) >
        usage.input_tokens ||
      (usage.output_tokens_details?.reasoning_tokens ?? 0) >
        usage.output_tokens))
    ? { source: "unavailable" }
    : {
        source: "provider_reported",
        inputTokens: usage.input_tokens,
        ...(usage.input_tokens_details?.cached_tokens === undefined
          ? {}
          : {
              cachedInputTokens:
                usage.input_tokens_details.cached_tokens,
            }),
        outputTokens: usage.output_tokens,
        ...(usage.output_tokens_details?.reasoning_tokens ===
        undefined
          ? {}
          : {
              reasoningOutputTokens:
                usage.output_tokens_details.reasoning_tokens,
            }),
        totalTokens: usage.total_tokens,
      };

export interface DecodedOpenAIResponses {
  classification: SemanticClassification;
  visibleOutput: string;
  usage: NormalizedTokenUsage;
  providerRequestId?: string;
}

export interface DecodedStructuredOpenAIResponses {
  parsedOutput: unknown;
  visibleOutput: string;
  usage: NormalizedTokenUsage;
  modelVersion: string;
  providerRequestId?: string;
}

export const decodeStructuredOpenAIResponses = (
  response: HttpModelResponse,
  options: {
    fallbackModel: string;
    requireConsistentTotals: boolean;
  },
): DecodedStructuredOpenAIResponses => {
  const parsed = responseSchema.safeParse(response.json);
  const responseRequestId =
    parsed.success && parsed.data.id !== undefined
      ? parsed.data.id
      : response.requestId;
  if (!parsed.success) {
    throw invalidOutput(
      "OpenAI-compatible endpoint returned an invalid Responses payload",
      responseRequestId,
    );
  }
  const visibleOutput = parsed.data.output
    .flatMap((item) => item.content ?? [])
    .filter(
      (
        item,
      ): item is typeof item & { text: string } =>
        item.type === "output_text" &&
        item.text !== undefined,
    )
    .map((item) => item.text)
    .join("");
  if (visibleOutput.trim().length === 0) {
    throw invalidOutput(
      "Model provider returned no visible structured output",
      responseRequestId,
    );
  }
  return {
    parsedOutput: parseStructuredJson(
      visibleOutput,
      responseRequestId,
    ),
    visibleOutput,
    usage: usageFrom(
      parsed.data.usage,
      options.requireConsistentTotals,
    ),
    modelVersion: parsed.data.model ?? options.fallbackModel,
    ...(responseRequestId === undefined
      ? {}
      : { providerRequestId: responseRequestId }),
  };
};

export const decodeOpenAIResponses = (
  response: HttpModelResponse,
  options: {
    provider: string;
    fallbackModel: string;
    requireConsistentTotals: boolean;
  },
): DecodedOpenAIResponses => {
  const decoded = decodeStructuredOpenAIResponses(response, {
    fallbackModel: options.fallbackModel,
    requireConsistentTotals: options.requireConsistentTotals,
  });
  const classification = parseSemanticOutput(
    decoded.visibleOutput,
    options.provider,
    decoded.modelVersion,
    decoded.providerRequestId,
  );
  return {
    classification,
    visibleOutput: decoded.visibleOutput,
    usage: decoded.usage,
    ...(decoded.providerRequestId === undefined
      ? {}
      : { providerRequestId: decoded.providerRequestId }),
  };
};

export class OpenAIResponsesAdapter {
  readonly id = "openai" as const;
  readonly #profile: ModelProviderProfile;
  readonly #credentials: ModelCredentialLookup;
  readonly #transport: ModelHttpTransport;
  readonly #clock: () => number;
  readonly #includeStoreFlag: boolean;

  constructor(options: OpenAIResponsesAdapterOptions) {
    const parsed = modelProviderProfileSchema.safeParse(
      options.profile,
    );
    if (
      !parsed.success ||
      parsed.data.kind !== "openai" ||
      parsed.data.apiProtocol !== "responses"
    ) {
      throw new ModelProviderError(
        "invalid_configuration",
        "OpenAI Responses provider configuration is invalid",
      );
    }
    this.#profile = parsed.data;
    this.#credentials = options.credentials;
    this.#transport =
      options.transport ?? new HttpModelTransport();
    this.#clock = options.clock ?? (() => performance.now());
    this.#includeStoreFlag =
      options.includeStoreFlag ?? true;
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
    const credentialReference = this.#profile.credentialRef;
    const apiKey = await this.#credentials.get(
      credentialReference!,
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
      url: endpoint(this.#profile.baseUrl!, "/v1/responses"),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: {
        model: this.#profile.model!,
        ...(this.#includeStoreFlag ? { store: false } : {}),
        tools: [],
        instructions: semanticSystemPrompt,
        input: userPrompt,
        max_output_tokens: 256,
        text: {
          format: {
            type: "json_schema",
            name: "decision_semantic_classification",
            strict: true,
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
    const decoded = decodeOpenAIResponses(response, {
      provider: this.id,
      fallbackModel: this.#profile.model!,
      requireConsistentTotals: false,
    });
    return {
      classification: decoded.classification,
      visibleOutput: decoded.visibleOutput,
      traceInput: {
        systemPrompt: semanticSystemPrompt,
        userPrompt,
        outputSchema: semanticOutputJsonSchema,
        clientSystemPromptVisibility: "visible",
      },
      usage: decoded.usage,
      providerDurationMs,
      ...(decoded.providerRequestId === undefined
        ? {}
        : {
            providerRequestId:
              decoded.providerRequestId,
          }),
    };
  }

  async generate(
    request: StructuredGenerationRequest,
    signal?: AbortSignal,
  ): Promise<StructuredProviderAttempt> {
    const credentialReference = this.#profile.credentialRef;
    const apiKey = await this.#credentials.get(
      credentialReference!,
    );
    if (apiKey === null) {
      throw new ModelProviderError(
        "credential_unavailable",
        "Model provider credential is unavailable",
      );
    }

    const startedAt = this.#clock();
    const response = await this.#transport.postJson({
      url: endpoint(this.#profile.baseUrl!, "/v1/responses"),
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: {
        model: this.#profile.model!,
        ...(this.#includeStoreFlag ? { store: false } : {}),
        tools: [],
        instructions: request.systemPrompt,
        input: request.userPrompt,
        max_output_tokens: request.maxOutputTokens,
        text: {
          format: {
            type: "json_schema",
            name: "decision_structured_output",
            strict: true,
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
    const decoded = decodeStructuredOpenAIResponses(response, {
      fallbackModel: this.#profile.model!,
      requireConsistentTotals: false,
    });
    return {
      parsedOutput: decoded.parsedOutput,
      visibleOutput: decoded.visibleOutput,
      modelVersion: decoded.modelVersion,
      traceInput: {
        systemPrompt: request.systemPrompt,
        userPrompt: request.userPrompt,
        outputSchema: request.outputSchema,
        clientSystemPromptVisibility: "visible",
      },
      usage: decoded.usage,
      providerDurationMs,
      ...(decoded.providerRequestId === undefined
        ? {}
        : { providerRequestId: decoded.providerRequestId }),
    };
  }

  async close(): Promise<void> {}
}
