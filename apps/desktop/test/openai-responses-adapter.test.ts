import type {
  ModelProviderProfile,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ModelProviderError,
  type HttpModelRequest,
  type HttpModelResponse,
} from "../src/main/model/http-model-transport.js";
import {
  OpenAIResponsesAdapter,
} from "../src/main/model/adapters/openai-responses-adapter.js";
import {
  buildSemanticUserPrompt,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../src/main/model/semantic-prompt.js";
import type {
  SemanticClassifierInput,
} from "../src/main/semantic/semantic-classifier.js";

const profile: ModelProviderProfile = {
  version: 1,
  profileId: "openai-primary",
  kind: "openai",
  label: "OpenAI",
  enabled: true,
  priority: 20,
  model: "gpt-5-mini",
  timeoutMs: 15_000,
  baseUrl: "https://api.openai.com",
  apiProtocol: "responses",
  credentialRef: "openai-primary-key",
};

const input: SemanticClassifierInput = {
  pairId: "pair-1",
  assistantText: "先修复还是先提交？",
  userText: "先修复",
  locale: "zh-CN",
};

const methodologyRequest: StructuredGenerationRequest = {
  requestId: "methodology-request",
  purpose: "methodology-extraction",
  promptVersion: "methodology-v1",
  schemaVersion: "methodology-schema-v1",
  locale: "zh-CN",
  systemPrompt: "只基于证据提炼候选。",
  userPrompt: "证据 1：分步上线符合预期。",
  outputSchema: {
    type: "object",
    required: ["title"],
    properties: { title: { type: "string" } },
  },
  maxOutputTokens: 768,
};

const visibleOutput = JSON.stringify({
  decisionIntent: "decision",
  answerRelation: "answers",
  question: "先修复还是先提交？",
  optionLabels: ["先修复", "先提交"],
  answerExcerpt: "先修复",
  confidence: 0.96,
});

const response = (
  overrides: Record<string, unknown> = {},
): HttpModelResponse => ({
  status: 200,
  headers: {},
  requestId: "header-request-id",
  json: {
    id: "resp_123",
    model: "gpt-5-mini-2026-07-15",
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: visibleOutput },
        ],
      },
    ],
    usage: {
      input_tokens: 150,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens: 28,
      output_tokens_details: { reasoning_tokens: 8 },
      total_tokens: 178,
    },
    ...overrides,
  },
});

const setup = (
  result: HttpModelResponse | Error = response(),
) => {
  const requests: HttpModelRequest[] = [];
  const postJson = vi.fn(
    async (request: HttpModelRequest) => {
      requests.push(request);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    },
  );
  const times = [100, 137];
  const adapter = new OpenAIResponsesAdapter({
    profile,
    credentials: {
      get: vi.fn(async () => "sk-super-private"),
    },
    transport: { postJson },
    clock: () => times.shift() ?? 137,
  });
  return { adapter, postJson, requests };
};

describe("OpenAIResponsesAdapter", () => {
  it("submits request-specific prompts and schemas for methodology extraction", async () => {
    const structuredOutput = JSON.stringify({ title: "可逆优先" });
    const { adapter, requests } = setup(
      response({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: structuredOutput }],
          },
        ],
      }),
    );

    await expect(adapter.generate(methodologyRequest)).resolves.toMatchObject({
      parsedOutput: { title: "可逆优先" },
      visibleOutput: structuredOutput,
      modelVersion: "gpt-5-mini-2026-07-15",
      traceInput: {
        systemPrompt: methodologyRequest.systemPrompt,
        userPrompt: methodologyRequest.userPrompt,
        outputSchema: methodologyRequest.outputSchema,
      },
    });
    expect(requests[0]?.body).toMatchObject({
      instructions: methodologyRequest.systemPrompt,
      input: methodologyRequest.userPrompt,
      max_output_tokens: 768,
      text: {
        format: {
          name: "decision_structured_output",
          schema: methodologyRequest.outputSchema,
        },
      },
    });
  });

  it("sends a non-persistent structured request and normalizes telemetry", async () => {
    const { adapter, requests } = setup();

    const result = await adapter.invoke(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "https://api.openai.com/v1/responses",
      headers: {
        authorization: "Bearer sk-super-private",
        "content-type": "application/json",
      },
      body: {
        model: "gpt-5-mini",
        store: false,
        tools: [],
        instructions: semanticSystemPrompt,
        input: buildSemanticUserPrompt(input),
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
      timeoutMs: 15_000,
      maximumResponseBytes: 1_048_576,
      secrets: ["sk-super-private"],
    });
    expect(result).toEqual({
      classification: {
        decisionIntent: "decision",
        answerRelation: "answers",
        question: "先修复还是先提交？",
        optionLabels: ["先修复", "先提交"],
        answerExcerpt: "先修复",
        confidence: 0.96,
        provider: "openai",
        modelVersion: "gpt-5-mini-2026-07-15",
        promptVersion: "semantic-v1",
      },
      visibleOutput,
      traceInput: {
        systemPrompt: semanticSystemPrompt,
        userPrompt: buildSemanticUserPrompt(input),
        outputSchema: semanticOutputJsonSchema,
        clientSystemPromptVisibility: "visible",
      },
      usage: {
        source: "provider_reported",
        inputTokens: 150,
        cachedInputTokens: 40,
        outputTokens: 28,
        reasoningOutputTokens: 8,
        totalTokens: 178,
      },
      providerDurationMs: 37,
      providerRequestId: "resp_123",
    });
    expect(JSON.stringify(result)).not.toContain(
      "sk-super-private",
    );
  });

  it.each([
    ["missing output", { output: [] }],
    [
      "malformed output JSON",
      {
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "{bad" },
            ],
          },
        ],
      },
    ],
    [
      "invalid semantic schema",
      {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({ confidence: 2 }),
              },
            ],
          },
        ],
      },
    ],
  ])("rejects %s", async (_label, fixture) => {
    const { adapter } = setup(response(fixture));

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      code: "invalid_output",
      providerRequestId: "resp_123",
    });
  });

  it.each([
    [401, "authentication_failed"],
    [429, "rate_limited"],
  ] as const)(
    "preserves HTTP %i error mapping without retry",
    async (_status, code) => {
      const failure = new ModelProviderError(
        code,
        "provider rejected request",
      );
      const { adapter, postJson } = setup(failure);

      await expect(adapter.invoke(input)).rejects.toBe(failure);
      expect(postJson).toHaveBeenCalledTimes(1);
    },
  );

  it("fails before transport when the credential is absent", async () => {
    const postJson = vi.fn();
    const adapter = new OpenAIResponsesAdapter({
      profile,
      credentials: { get: vi.fn(async () => null) },
      transport: { postJson },
    });

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      code: "credential_unavailable",
    });
    expect(postJson).not.toHaveBeenCalled();
  });
});
