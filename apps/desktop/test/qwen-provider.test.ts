import type {
  SemanticClassification,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  QwenModelProvider,
  type QwenRuntimeModule,
} from "../src/main/semantic/qwen-provider.js";
import {
  QWEN_MODEL_MANIFEST,
  type QwenModelVerification,
} from "../src/main/semantic/model-manifest.js";
import {
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../src/main/model/semantic-prompt.js";

const validOutput: SemanticClassification = {
  decisionIntent: "decision",
  answerRelation: "answers",
  question: "先提交还是先修复？",
  optionLabels: ["先提交", "先修复"],
  answerExcerpt: "先修复",
  confidence: 0.94,
  provider: "qwen",
  modelVersion: "qwen3.5-2b-q4-k-m",
  promptVersion: "semantic-v1",
};

const availableModel = (): QwenModelVerification => ({
  availability: "available",
  modelPath: "/models/Qwen_Qwen3.5-2B-Q4_K_M.gguf",
  manifest: QWEN_MODEL_MANIFEST,
});

const createRuntime = (
  promptImpl: (prompt: string, options: unknown) => Promise<string> = async () =>
    JSON.stringify({
      decisionIntent: "decision",
      answerRelation: "answers",
      question: "先提交还是先修复？",
      optionLabels: ["先提交", "先修复"],
      answerExcerpt: "先修复",
      confidence: 0.94,
    }),
) => {
  const calls: string[] = [];
  const tokenMeter = {
    getState: vi.fn(() => ({
      usedInputTokens: 0,
      usedOutputTokens: 0,
    })),
  };
  const sequence = { tokenMeter };
  const session = {
    prompt: vi.fn(promptImpl),
    dispose: vi.fn(() => {
      calls.push("session");
    }),
  };
  const context = {
    getSequence: vi.fn(() => sequence),
    dispose: vi.fn(async () => {
      calls.push("context");
    }),
  };
  const model = {
    createContext: vi.fn(async () => context),
    dispose: vi.fn(async () => {
      calls.push("model");
    }),
  };
  const grammar = {};
  const llama = {
    loadModel: vi.fn(async () => model),
    createGrammarForJsonSchema: vi.fn(async () => grammar),
    dispose: vi.fn(async () => {
      calls.push("llama");
    }),
  };
  const getLlama = vi.fn(async () => llama);
  const LlamaChatSession = vi.fn(function () {
    return session;
  });
  const runtime = {
    getLlama,
    LlamaChatSession,
  } as unknown as QwenRuntimeModule;
  return {
    calls,
    context,
    getLlama,
    grammar,
    llama,
    LlamaChatSession,
    model,
    runtime,
    sequence,
    session,
    tokenMeter,
  };
};

const input = {
  pairId: "pair-1",
  assistantText: "先提交还是先修复？",
  userText: "先修复",
  locale: "zh-CN" as const,
};

describe("QwenModelProvider", () => {
  it("uses a request-specific system prompt and grammar for generic structured generation", async () => {
    const fake = createRuntime(async () =>
      JSON.stringify({ title: "可逆优先" }),
    );
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });
    const outputSchema = {
      type: "object",
      required: ["title"],
      properties: { title: { type: "string" } },
    };
    const request: StructuredGenerationRequest = {
      requestId: "methodology-request",
      purpose: "methodology-extraction",
      promptVersion: "methodology-v1",
      schemaVersion: "methodology-schema-v1",
      locale: "zh-CN",
      systemPrompt: "只基于证据生成候选。",
      userPrompt: "证据 1：小步上线符合预期。",
      outputSchema,
      maxOutputTokens: 700,
    };

    await expect(provider.generate(request)).resolves.toMatchObject({
      parsedOutput: { title: "可逆优先" },
      visibleOutput: '{"title":"可逆优先"}',
      modelVersion: QWEN_MODEL_MANIFEST.id,
      traceInput: {
        systemPrompt: "只基于证据生成候选。",
        userPrompt: "证据 1：小步上线符合预期。",
        outputSchema,
      },
    });
    expect(fake.llama.createGrammarForJsonSchema).toHaveBeenLastCalledWith(
      outputSchema,
    );
    expect(fake.LlamaChatSession).toHaveBeenLastCalledWith({
      contextSequence: fake.sequence,
      systemPrompt: "只基于证据生成候选。",
    });
    expect(fake.session.prompt).toHaveBeenCalledWith(
      request.userPrompt,
      expect.objectContaining({ maxTokens: 700, temperature: 0 }),
    );
  });

  it("bounds copied semantic fields in the generation grammar", () => {
    const properties = semanticOutputJsonSchema.properties as Record<
      string,
      Record<string, unknown>
    >;

    expect(properties.question).toMatchObject({
      oneOf: [
        { type: "string", maxLength: 160 },
        { type: "null" },
      ],
    });
    expect(properties.answerExcerpt).toMatchObject({
      oneOf: [
        { type: "string", maxLength: 120 },
        { type: "null" },
      ],
    });
    expect(properties.optionLabels).toMatchObject({
      maxItems: 8,
      items: expect.objectContaining({ maxLength: 80 }),
    });
  });

  it("states copied-field limits because the runtime grammar does not enforce maxLength", () => {
    expect(semanticSystemPrompt).toContain(
      "question is not null, copy one exact contiguous excerpt of at most 160 characters",
    );
    expect(semanticSystemPrompt).toContain(
      "answerExcerpt is not null, copy one exact contiguous excerpt of at most 120 characters",
    );
    expect(semanticSystemPrompt).toContain(
      "Every option label must be an exact contiguous excerpt of at most 80 characters",
    );
  });

  it("returns the exact trace input, visible output, and measured token delta", async () => {
    const fake = createRuntime();
    fake.tokenMeter.getState
      .mockReturnValueOnce({
        usedInputTokens: 10,
        usedOutputTokens: 2,
      })
      .mockReturnValueOnce({
        usedInputTokens: 52,
        usedOutputTokens: 14,
      });
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });

    const attempt = await provider.invoke(input);

    expect(attempt).toMatchObject({
      classification: validOutput,
      visibleOutput: expect.stringContaining(
        "\"decisionIntent\"",
      ),
      traceInput: {
        systemPrompt: expect.stringContaining(
          "Do not reveal chain-of-thought",
        ),
        userPrompt: expect.stringContaining(
          "<assistant_message>",
        ),
        outputSchema: expect.objectContaining({
          type: "object",
        }),
        clientSystemPromptVisibility: "visible",
      },
      usage: {
        source: "runtime_measured",
        inputTokens: 42,
        outputTokens: 12,
        totalTokens: 54,
      },
      providerDurationMs: expect.any(Number),
    });
  });

  it("loads one offline runtime, model, context, session, and JSON grammar", async () => {
    const fake = createRuntime();
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: vi.fn(async () => availableModel()),
      loadRuntime: vi.fn(async () => fake.runtime),
      timeoutMs: 100,
    });

    await expect(provider.classify(input)).resolves.toEqual(
      validOutput,
    );
    await expect(provider.classify(input)).resolves.toEqual(
      validOutput,
    );

    expect(fake.getLlama).toHaveBeenCalledOnce();
    expect(fake.getLlama).toHaveBeenCalledWith({
      build: "never",
      gpu: "auto",
      skipDownload: true,
      progressLogs: false,
      logger: expect.any(Function),
    });
    expect(fake.llama.loadModel).toHaveBeenCalledWith({
      modelPath:
        "/models/Qwen_Qwen3.5-2B-Q4_K_M.gguf",
    });
    expect(fake.model.createContext).toHaveBeenCalledWith({
      contextSize: 4_096,
      sequences: 1,
    });
    expect(fake.context.getSequence).toHaveBeenCalledOnce();
    expect(fake.LlamaChatSession).toHaveBeenCalledWith({
      contextSequence: fake.sequence,
      systemPrompt: expect.stringContaining(
        "Do not reveal chain-of-thought",
      ),
    });
    expect(
      fake.llama.createGrammarForJsonSchema,
    ).toHaveBeenCalledOnce();
    expect(fake.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("<assistant_message>"),
      {
        grammar: fake.grammar,
        maxTokens: 512,
        signal: expect.any(AbortSignal),
        temperature: 0,
      },
    );
  });

  it("bounds untrusted prompt text and excludes internal identifiers", async () => {
    const fake = createRuntime();
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });

    await provider.classify({
      ...input,
      pairId: "secret-pair-id",
      assistantText: `question-end-${"问".repeat(8_000)}`,
      userText: `answer-start-${"答".repeat(2_000)}`,
    });

    const prompt = fake.session.prompt.mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toBe("");
    expect(prompt).not.toContain("secret-pair-id");
    expect(prompt.length).toBeLessThanOrEqual(3_500);
    expect(prompt).toContain("问".repeat(100));
    expect(prompt).toContain("answer-start");
  });

  it.each([
    ["model_missing", "model_missing"],
    ["checksum_failed", "checksum_failed"],
  ] as const)(
    "reports %s without importing or loading the runtime",
    async (availability, expected) => {
      const loadRuntime = vi.fn(async () => createRuntime().runtime);
      const provider = new QwenModelProvider({
        modelsDirectory: "/models",
        verifyModel: vi.fn(async () => ({ availability })),
        loadRuntime,
      });

      await expect(provider.status()).resolves.toMatchObject({
        id: "qwen",
        availability: expected,
      });
      await expect(provider.classify(input)).rejects.toMatchObject({
        code: expected,
      });
      expect(loadRuntime).not.toHaveBeenCalled();
    },
  );

  it("serializes inference so only one prompt runs at a time", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const fake = createRuntime(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return JSON.stringify({
        decisionIntent: "none",
        answerRelation: "new_task",
        question: null,
        optionLabels: [],
        answerExcerpt: null,
        confidence: 0.9,
      });
    });
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
      timeoutMs: 100,
    });

    const first = provider.classify(input);
    const second = provider.classify(input);
    await vi.waitFor(() =>
      expect(fake.session.prompt).toHaveBeenCalledTimes(1),
    );
    releases.shift()?.();
    await vi.waitFor(() =>
      expect(fake.session.prompt).toHaveBeenCalledTimes(2),
    );
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(maximumActive).toBe(1);
  });

  it("rejects timeouts, cancellation, and invalid structured output", async () => {
    const never = createRuntime(
      async () => new Promise<string>(() => undefined),
    );
    const timedProvider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => never.runtime,
      timeoutMs: 10,
    });
    await expect(
      timedProvider.classify(input),
    ).rejects.toMatchObject({
      code: "timeout",
      diagnosticExcerpt:
        "Qwen classification timed out after 10 ms",
    });

    const abortController = new AbortController();
    const cancelled = timedProvider.classify(
      input,
      abortController.signal,
    );
    abortController.abort();
    await expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });

    const invalid = createRuntime(async () => "{\"confidence\":2}");
    const invalidProvider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => invalid.runtime,
    });
    await expect(
      invalidProvider.classify(input),
    ).rejects.toMatchObject({
      code: "provider_invalid_output",
      diagnosticExcerpt: expect.stringContaining(
        "semantic schema",
      ),
    });
  });

  it("reports measured output-limit exhaustion separately", async () => {
    const fake = createRuntime(
      async () => "{\"question\":\"unfinished",
    );
    fake.tokenMeter.getState
      .mockReturnValueOnce({
        usedInputTokens: 10,
        usedOutputTokens: 0,
      })
      .mockReturnValueOnce({
        usedInputTokens: 590,
        usedOutputTokens: 512,
      });
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });

    await expect(provider.classify(input)).rejects.toMatchObject({
      code: "output_limit",
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
      usage: {
        source: "runtime_measured",
        inputTokens: 580,
        outputTokens: 512,
        totalTokens: 1_092,
      },
    });
  });

  it("keeps malformed JSON below the token limit distinct", async () => {
    const fake = createRuntime(
      async () => "{\"question\":\"unfinished",
    );
    fake.tokenMeter.getState
      .mockReturnValueOnce({
        usedInputTokens: 10,
        usedOutputTokens: 0,
      })
      .mockReturnValueOnce({
        usedInputTokens: 120,
        usedOutputTokens: 60,
      });
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });

    await expect(provider.classify(input)).rejects.toMatchObject({
      code: "provider_invalid_output",
      usage: {
        source: "runtime_measured",
        inputTokens: 110,
        outputTokens: 60,
        totalTokens: 170,
      },
    });
  });

  it("rebuilds resources after a transient initialization failure", async () => {
    const fake = createRuntime();
    fake.model.createContext
      .mockRejectedValueOnce(new Error("temporary Metal failure"))
      .mockResolvedValue(fake.context);
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
      timeoutMs: 100,
    });

    await expect(provider.classify(input)).rejects.toMatchObject({
      code: "runtime_unavailable",
      diagnosticExcerpt: expect.stringContaining(
        "temporary Metal failure",
      ),
    });
    await expect(provider.classify(input)).resolves.toEqual(
      validOutput,
    );

    expect(fake.getLlama).toHaveBeenCalledTimes(2);
    expect(fake.model.createContext).toHaveBeenCalledTimes(2);
  });

  it("keeps a safe diagnostic when the local inference runtime rejects", async () => {
    const fake = createRuntime(async () => {
      throw new Error(
        "Metal command buffer failed at /models/private/model.gguf",
      );
    });
    const provider = new QwenModelProvider({
      modelsDirectory: "/models/private",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });

    await expect(provider.classify(input)).rejects.toMatchObject({
      code: "runtime_unavailable",
      diagnosticExcerpt:
        "Qwen inference failed: Metal command buffer failed at [model-directory]/model.gguf",
    });
  });

  it("disposes resources in dependency order", async () => {
    const fake = createRuntime();
    const provider = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => availableModel(),
      loadRuntime: async () => fake.runtime,
    });
    await provider.classify(input);

    await provider.close();

    expect(fake.calls).toEqual([
      "session",
      "context",
      "model",
      "llama",
    ]);
  });
});
