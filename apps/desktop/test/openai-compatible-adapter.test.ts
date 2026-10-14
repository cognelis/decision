import type {
  ModelProviderProfile,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  REASONING_HEADROOM_TOKENS,
} from "../src/main/model/structured-provider.js";

import {
  OpenAICompatibleAdapter,
} from "../src/main/model/adapters/openai-compatible-adapter.js";
import {
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

const input: SemanticClassifierInput = {
  pairId: "pair-3",
  assistantText: "现在修复还是稍后处理？",
  userText: "稍后处理",
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
  question: "现在修复还是稍后处理？",
  optionLabels: ["现在修复", "稍后处理"],
  answerExcerpt: "稍后处理",
  confidence: 0.88,
});

const profile = (
  apiProtocol: "responses" | "chat-completions",
  baseUrl: string,
): ModelProviderProfile => ({
  version: 1,
  profileId: `compatible-${apiProtocol}`,
  kind: "openai-compatible",
  label: "兼容服务",
  enabled: true,
  priority: 40,
  model: "local-model",
  timeoutMs: 12_000,
  baseUrl,
  apiProtocol,
  credentialRef: "compatible-key",
});

const responsesFixture: HttpModelResponse = {
  status: 200,
  headers: {},
  json: {
    id: "compatible-response-id",
    model: "local-model-v2",
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: visibleOutput },
        ],
      },
    ],
  },
};

const chatFixture = (
  usage?: Record<string, unknown>,
): HttpModelResponse => ({
  status: 200,
  headers: {},
  requestId: "chat-header-id",
  json: {
    id: "chatcmpl_789",
    model: "local-model-v3",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: visibleOutput,
        },
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  },
});

const setup = (
  selectedProfile: ModelProviderProfile,
  result: HttpModelResponse,
) => {
  const requests: HttpModelRequest[] = [];
  const postJson = vi.fn(
    async (request: HttpModelRequest) => {
      requests.push(request);
      return result;
    },
  );
  const adapter = new OpenAICompatibleAdapter({
    profile: selectedProfile,
    credentials: {
      get: vi.fn(async () => "compatible-secret"),
    },
    transport: { postJson },
    clock: (() => {
      const values = [10, 26];
      return () => values.shift() ?? 26;
    })(),
  });
  return { adapter, postJson, requests };
};

describe("OpenAICompatibleAdapter", () => {
  it("normalizes DeepSeek cache hits and misses without counting cached input twice", async () => {
    const { adapter } = setup(profile("chat-completions", "https://api.deepseek.com"), chatFixture({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20, completion_tokens: 15, total_tokens: 115 }));
    expect((await adapter.invoke(input)).usage).toMatchObject({ source: "provider_reported", inputTokens: 100, cachedInputTokens: 80, outputTokens: 15, totalTokens: 115 });
    const invalid = setup(profile("chat-completions", "https://api.deepseek.com"), chatFixture({ prompt_tokens: 100, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 30, completion_tokens: 15, total_tokens: 115 }));
    expect((await invalid.adapter.invoke(input)).usage.source).toBe("unavailable");
  });
  it("uses generic JSON Schema output over Chat Completions", async () => {
    const structuredOutput = JSON.stringify({ title: "可逆优先" });
    const fixture = chatFixture();
    (fixture.json as { choices: Array<{ message: { content: string } }> })
      .choices[0]!.message.content = structuredOutput;
    const { adapter, requests } = setup(
      profile("chat-completions", "https://models.example.com"),
      fixture,
    );

    await expect(adapter.generate(methodologyRequest)).resolves.toMatchObject({
      parsedOutput: { title: "可逆优先" },
      visibleOutput: structuredOutput,
      modelVersion: "local-model-v3",
    });
    // A generation the reader waits on gets the gateway's thirty-second floor here too, not the
    // profile's twelve seconds: otherwise the shorter of the two timers wins.
    expect(requests[0]?.timeoutMs).toBe(30_000);
    expect(requests[0]?.body).toMatchObject({
      messages: [
        { role: "system", content: methodologyRequest.systemPrompt },
        { role: "user", content: methodologyRequest.userPrompt },
      ],
      max_tokens: 768 + REASONING_HEADROOM_TOKENS,
      response_format: {
        json_schema: {
          name: "decision_structured_output",
          schema: methodologyRequest.outputSchema,
        },
      },
    });
  });

  it("asks for a plain json object when the service rejects json_schema", async () => {
    const structuredOutput = JSON.stringify({ title: "可逆优先" });
    const fixture = chatFixture();
    (fixture.json as { choices: Array<{ message: { content: string } }> })
      .choices[0]!.message.content = structuredOutput;
    const { adapter, requests } = setup(
      {
        ...profile("chat-completions", "https://api.deepseek.com"),
        jsonMode: "object",
      },
      fixture,
    );

    await expect(adapter.generate(methodologyRequest)).resolves.toMatchObject({
      parsedOutput: { title: "可逆优先" },
    });
    const body = requests[0]?.body as {
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    // DeepSeek accepts json_object only, and its docs require the word "json"
    // plus the shape to appear in the prompt.
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]?.content).toContain("json");
    expect(body.messages[0]?.content).toContain(
      JSON.stringify(methodologyRequest.outputSchema),
    );
    expect(body.messages[0]?.content).toContain(methodologyRequest.systemPrompt);
  });

  it("uses the explicit Responses protocol and asks the service not to keep what it is sent", async () => {
    const { adapter, requests } = setup(
      profile("responses", "http://127.0.0.1:11434/"),
      responsesFixture,
    );

    const result = await adapter.invoke(input);

    expect(requests[0]?.url).toBe(
      "http://127.0.0.1:11434/v1/responses",
    );
    // Left out, OpenAI or Azure reached through this type kept the captured conversation for 30 days.
    expect(requests[0]?.body).toEqual({
      model: "local-model",
      store: false,
      tools: [],
      instructions: semanticSystemPrompt,
      input: buildSemanticUserPrompt(input),
      max_output_tokens: 256 + REASONING_HEADROOM_TOKENS,
      text: {
        format: {
          type: "json_schema",
          name: "decision_semantic_classification",
          strict: true,
          schema: semanticOutputJsonSchema,
        },
      },
    });
    expect(result).toMatchObject({
      classification: {
        provider: "openai-compatible",
        modelVersion: "local-model-v2",
      },
      usage: { source: "unavailable" },
      providerDurationMs: 16,
      providerRequestId: "compatible-response-id",
    });
    // A generation too: a vault's notes for an answer, a PR's diff for a review.
    await adapter.generate(methodologyRequest).catch(() => undefined);
    expect(requests[1]?.body).toMatchObject({ store: false, input: methodologyRequest.userPrompt });
  });

  it("uses the explicit Chat Completions protocol over HTTPS", async () => {
    const { adapter, requests } = setup(
      profile(
        "chat-completions",
        "https://models.example.com",
      ),
      chatFixture({
        prompt_tokens: 90,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens: 18,
        completion_tokens_details: {
          reasoning_tokens: 4,
        },
        total_tokens: 108,
      }),
    );

    const result = await adapter.invoke(input);

    expect(requests[0]?.url).toBe(
      "https://models.example.com/v1/chat/completions",
    );
    expect(requests[0]?.body).toEqual({
      model: "local-model",
      messages: [
        { role: "system", content: semanticSystemPrompt },
        {
          role: "user",
          content: buildSemanticUserPrompt(input),
        },
      ],
      max_tokens: 256 + REASONING_HEADROOM_TOKENS,
      tools: [],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "decision_semantic_classification",
          strict: true,
          schema: semanticOutputJsonSchema,
        },
      },
    });
    expect(result).toMatchObject({
      classification: {
        provider: "openai-compatible",
        modelVersion: "local-model-v3",
      },
      usage: {
        source: "provider_reported",
        inputTokens: 90,
        cachedInputTokens: 20,
        outputTokens: 18,
        reasoningOutputTokens: 4,
        totalTokens: 108,
      },
      providerRequestId: "chatcmpl_789",
    });
  });

  it.each([
    ["missing usage", undefined],
    [
      "ambiguous total-only usage",
      { total_tokens: 108 },
    ],
    [
      "inconsistent usage",
      {
        prompt_tokens: 90,
        completion_tokens: 18,
        total_tokens: 999,
      },
    ],
    [
      "cached tokens exceed input",
      {
        prompt_tokens: 10,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens: 2,
        total_tokens: 12,
      },
    ],
  ])("marks %s as unavailable", async (_label, usage) => {
    const { adapter } = setup(
      profile(
        "chat-completions",
        "https://models.example.com",
      ),
      chatFixture(usage),
    );

    await expect(adapter.invoke(input)).resolves.toMatchObject({
      usage: { source: "unavailable" },
    });
  });

  it.each([
    {
      ...profile(
        "responses",
        "https://models.example.com",
      ),
      apiProtocol: "messages",
    },
    {
      ...profile(
        "responses",
        "https://models.example.com",
      ),
      kind: "openai",
    },
    profile("responses", "http://models.example.com"),
  ] as ModelProviderProfile[])(
    "rejects invalid endpoint or profile combinations before network access",
    (invalidProfile) => {
      const postJson = vi.fn();

      expect(
        () =>
          new OpenAICompatibleAdapter({
            profile: invalidProfile,
            credentials: {
              get: vi.fn(async () => "secret"),
            },
            transport: { postJson },
          }),
      ).toThrow(/configuration/u);
      expect(postJson).not.toHaveBeenCalled();
    },
  );

  it("rejects non-text chat output", async () => {
    const { adapter } = setup(
      profile(
        "chat-completions",
        "https://models.example.com",
      ),
      {
        status: 200,
        headers: {},
        json: {
          id: "chatcmpl_bad",
          choices: [
            {
              message: { role: "assistant", content: null },
            },
          ],
        },
      },
    );

    await expect(adapter.invoke(input)).rejects.toMatchObject({
      code: "invalid_output",
      providerRequestId: "chatcmpl_bad",
    });
  });
});
