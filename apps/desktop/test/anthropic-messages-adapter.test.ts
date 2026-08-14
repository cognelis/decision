import type {
  ModelProviderProfile,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  AnthropicMessagesAdapter,
} from "../src/main/model/adapters/anthropic-messages-adapter.js";
import {
  ModelProviderError,
  type HttpModelRequest,
  type HttpModelResponse,
} from "../src/main/model/http-model-transport.js";
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
  profileId: "anthropic-primary",
  kind: "anthropic",
  label: "Anthropic",
  enabled: true,
  priority: 30,
  model: "claude-haiku-4-5",
  timeoutMs: 20_000,
  baseUrl: "https://api.anthropic.com/",
  apiProtocol: "messages",
  credentialRef: "anthropic-primary-key",
};

const input: SemanticClassifierInput = {
  pairId: "pair-2",
  assistantText: "采用兼容方案，可以吗？",
  userText: "可以",
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
  decisionIntent: "approval",
  answerRelation: "answers",
  question: "采用兼容方案，可以吗？",
  optionLabels: ["可以", "不可以"],
  answerExcerpt: "可以",
  confidence: 0.91,
});

const response = (
  overrides: Record<string, unknown> = {},
): HttpModelResponse => ({
  status: 200,
  headers: {},
  requestId: "anthropic-header-id",
  json: {
    id: "msg_456",
    model: "claude-haiku-4-5-20260720",
    stop_reason: "end_turn",
    content: [{ type: "text", text: visibleOutput }],
    usage: {
      input_tokens: 120,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 35,
      output_tokens: 22,
      output_tokens_details: { thinking_tokens: 6 },
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
  const times = [50, 82];
  const adapter = new AnthropicMessagesAdapter({
    profile,
    credentials: {
      get: vi.fn(async () => "anthropic-secret"),
    },
    transport: { postJson },
    clock: () => times.shift() ?? 82,
  });
  return { adapter, postJson, requests };
};

describe("AnthropicMessagesAdapter", () => {
  it("uses request-specific structured output for methodology extraction", async () => {
    const structuredOutput = JSON.stringify({ title: "可逆优先" });
    const { adapter, requests } = setup(
      response({
        content: [{ type: "text", text: structuredOutput }],
      }),
    );

    await expect(adapter.generate(methodologyRequest)).resolves.toMatchObject({
      parsedOutput: { title: "可逆优先" },
      visibleOutput: structuredOutput,
      modelVersion: "claude-haiku-4-5-20260720",
    });
    expect(requests[0]?.body).toMatchObject({
      max_tokens: 768,
      system: methodologyRequest.systemPrompt,
      messages: [{ role: "user", content: methodologyRequest.userPrompt }],
      output_config: {
        format: {
          schema: methodologyRequest.outputSchema,
        },
      },
    });
  });

  it("uses structured Messages without tools and maps provider telemetry", async () => {
    const { adapter, requests } = setup();

    const result = await adapter.invoke(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": "anthropic-secret",
      },
      body: {
        model: "claude-haiku-4-5",
        max_tokens: 256,
        system: semanticSystemPrompt,
        messages: [
          {
            role: "user",
            content: buildSemanticUserPrompt(input),
          },
        ],
        output_config: {
          format: {
            type: "json_schema",
            schema: semanticOutputJsonSchema,
          },
        },
      },
      timeoutMs: 20_000,
      maximumResponseBytes: 1_048_576,
      secrets: ["anthropic-secret"],
    });
    expect(result).toEqual({
      classification: {
        decisionIntent: "approval",
        answerRelation: "answers",
        question: "采用兼容方案，可以吗？",
        optionLabels: ["可以", "不可以"],
        answerExcerpt: "可以",
        confidence: 0.91,
        provider: "anthropic",
        modelVersion: "claude-haiku-4-5-20260720",
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
        inputTokens: 120,
        cachedInputTokens: 35,
        outputTokens: 22,
        reasoningOutputTokens: 6,
        totalTokens: 142,
      },
      providerDurationMs: 32,
      providerRequestId: "msg_456",
    });
    expect(JSON.stringify(result)).not.toContain(
      "anthropic-secret",
    );
  });

  it.each([
    [
      "refusal",
      {
        stop_reason: "refusal",
        content: [{ type: "text", text: visibleOutput }],
      },
    ],
    ["missing text", { content: [] }],
    [
      "unsupported content",
      {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "unexpected",
            input: {},
          },
        ],
      },
    ],
  ])("rejects %s responses", async (_label, fixture) => {
    const { adapter } = setup(response(fixture));

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      code: "invalid_output",
      providerRequestId: "msg_456",
    });
  });

  it("rejects malformed structured text", async () => {
    const { adapter } = setup(
      response({
        content: [{ type: "text", text: "{\"confidence\":2}" }],
      }),
    );

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      code: "invalid_output",
    });
  });

  it.each([
    [401, "authentication_failed"],
    [429, "rate_limited"],
    [400, "invalid_output"],
  ] as const)(
    "preserves HTTP %i and unsupported-output errors without retry",
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
});
