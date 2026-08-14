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
  type HttpModelResponse,
} from "../http-model-transport.js";
import {
  buildSemanticUserPrompt,
  SEMANTIC_PROMPT_VERSION,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../semantic-prompt.js";
import {
  decodeOpenAIResponses,
  decodeStructuredOpenAIResponses,
  parseSemanticOutput,
  type ModelCredentialLookup,
  type ModelHttpTransport,
} from "./openai-responses-adapter.js";
import {
  parseStructuredJson,
  type StructuredProviderAttempt,
} from "../structured-provider.js";

const MAXIMUM_RESPONSE_BYTES = 1_048_576;

export interface OpenAICompatibleAdapterOptions {
  profile: ModelProviderProfile;
  credentials: ModelCredentialLookup;
  transport?: ModelHttpTransport;
  clock?: () => number;
}

const chatResponseSchema = z
  .object({
    id: z.string().trim().min(1).max(500).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    choices: z
      .array(
        z
          .object({
            finish_reason: z
              .string()
              .max(100)
              .nullable()
              .optional(),
            message: z
              .object({
                role: z.string().max(100).optional(),
                content: z
                  .string()
                  .max(20_000)
                  .nullable()
                  .optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .max(100),
    usage: z
      .object({
        prompt_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        prompt_tokens_details: z
          .object({
            cached_tokens: z
              .number()
              .int()
              .nonnegative()
              .optional(),
          })
          .passthrough()
          .optional(),
        completion_tokens: z
          .number()
          .int()
          .nonnegative()
          .optional(),
        completion_tokens_details: z
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

const invalidOutput = (
  message: string,
  providerRequestId?: string,
): ModelProviderError =>
  new ModelProviderError("invalid_output", message, {
    ...(providerRequestId === undefined
      ? {}
      : { providerRequestId }),
  });

const normalizeChatUsage = (
  usage: z.infer<typeof chatResponseSchema>["usage"],
): NormalizedTokenUsage => {
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;
  const cachedInputTokens =
    usage?.prompt_tokens_details?.cached_tokens;
  const reasoningOutputTokens =
    usage?.completion_tokens_details?.reasoning_tokens;
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

const decodeChatResponse = (
  response: HttpModelResponse,
  fallbackModel: string,
): {
  classification: SemanticClassification;
  visibleOutput: string;
  usage: NormalizedTokenUsage;
  providerRequestId?: string;
} => {
  const parsed = chatResponseSchema.safeParse(response.json);
  const responseRequestId =
    parsed.success && parsed.data.id !== undefined
      ? parsed.data.id
      : response.requestId;
  if (!parsed.success) {
    throw invalidOutput(
      "OpenAI-compatible endpoint returned an invalid Chat Completions payload",
      responseRequestId,
    );
  }
  const visibleOutput =
    parsed.data.choices.find(
      (choice) =>
        typeof choice.message.content === "string" &&
        choice.message.content.trim().length > 0,
    )?.message.content ?? "";
  if (visibleOutput.length === 0) {
    throw invalidOutput(
      "OpenAI-compatible endpoint returned no visible chat output",
      responseRequestId,
    );
  }
  const classification = parseSemanticOutput(
    visibleOutput,
    "openai-compatible",
    parsed.data.model ?? fallbackModel,
    responseRequestId,
  );
  return {
    classification,
    visibleOutput,
    usage: normalizeChatUsage(parsed.data.usage),
    ...(responseRequestId === undefined
      ? {}
      : { providerRequestId: responseRequestId }),
  };
};

const decodeStructuredChatResponse = (
  response: HttpModelResponse,
  fallbackModel: string,
): {
  parsedOutput: unknown;
  visibleOutput: string;
  usage: NormalizedTokenUsage;
  modelVersion: string;
  providerRequestId?: string;
} => {
  const parsed = chatResponseSchema.safeParse(response.json);
  const responseRequestId =
    parsed.success && parsed.data.id !== undefined
      ? parsed.data.id
      : response.requestId;
  if (!parsed.success) {
    throw invalidOutput(
      "OpenAI-compatible endpoint returned an invalid Chat Completions payload",
      responseRequestId,
    );
  }
  const visibleOutput =
    parsed.data.choices.find(
      (choice) =>
        typeof choice.message.content === "string" &&
        choice.message.content.trim().length > 0,
    )?.message.content ?? "";
  if (visibleOutput.length === 0) {
    throw invalidOutput(
      "OpenAI-compatible endpoint returned no visible chat output",
      responseRequestId,
    );
  }
  return {
    parsedOutput: parseStructuredJson(
      visibleOutput,
      responseRequestId,
    ),
    visibleOutput,
    usage: normalizeChatUsage(parsed.data.usage),
    modelVersion: parsed.data.model ?? fallbackModel,
    ...(responseRequestId === undefined
      ? {}
      : { providerRequestId: responseRequestId }),
  };
};

export class OpenAICompatibleAdapter {
  readonly id = "openai-compatible" as const;
  readonly #profile: ModelProviderProfile;
  readonly #credentials: ModelCredentialLookup;
  readonly #transport: ModelHttpTransport;
  readonly #clock: () => number;

  constructor(options: OpenAICompatibleAdapterOptions) {
    const parsed = modelProviderProfileSchema.safeParse(
      options.profile,
    );
    if (
      !parsed.success ||
      parsed.data.kind !== "openai-compatible" ||
      (parsed.data.apiProtocol !== "responses" &&
        parsed.data.apiProtocol !== "chat-completions")
    ) {
      throw new ModelProviderError(
        "invalid_configuration",
        "OpenAI-compatible provider configuration is invalid",
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
    const protocol = this.#profile.apiProtocol;
    const startedAt = this.#clock();
    const response = await this.#transport.postJson({
      url: `${this.#profile.baseUrl!.replace(
        /\/+$/u,
        "",
      )}${
        protocol === "responses"
          ? "/v1/responses"
          : "/v1/chat/completions"
      }`,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body:
        protocol === "responses"
          ? {
              model: this.#profile.model!,
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
            }
          : {
              model: this.#profile.model!,
              messages: [
                {
                  role: "system",
                  content: semanticSystemPrompt,
                },
                { role: "user", content: userPrompt },
              ],
              max_tokens: 256,
              tools: [],
              response_format: {
                type: "json_schema",
                json_schema: {
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
    const decoded =
      protocol === "responses"
        ? decodeOpenAIResponses(response, {
            provider: this.id,
            fallbackModel: this.#profile.model!,
            requireConsistentTotals: true,
          })
        : decodeChatResponse(
            response,
            this.#profile.model!,
          );
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
    const apiKey = await this.#credentials.get(
      this.#profile.credentialRef!,
    );
    if (apiKey === null) {
      throw new ModelProviderError(
        "credential_unavailable",
        "Model provider credential is unavailable",
      );
    }
    const protocol = this.#profile.apiProtocol;
    const startedAt = this.#clock();
    const response = await this.#transport.postJson({
      url: `${this.#profile.baseUrl!.replace(
        /\/+$/u,
        "",
      )}${
        protocol === "responses"
          ? "/v1/responses"
          : "/v1/chat/completions"
      }`,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body:
        protocol === "responses"
          ? {
              model: this.#profile.model!,
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
            }
          : {
              model: this.#profile.model!,
              messages: [
                {
                  role: "system",
                  content: request.systemPrompt,
                },
                { role: "user", content: request.userPrompt },
              ],
              max_tokens: request.maxOutputTokens,
              tools: [],
              response_format: {
                type: "json_schema",
                json_schema: {
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
    const decoded =
      protocol === "responses"
        ? decodeStructuredOpenAIResponses(response, {
            fallbackModel: this.#profile.model!,
            requireConsistentTotals: true,
          })
        : decodeStructuredChatResponse(
            response,
            this.#profile.model!,
          );
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
