import type {
  ModelProviderProfile,
  ModelInvocationTrace,
  NormalizedTokenUsage,
  SemanticClassification,
  SemanticRecognitionStatus,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import type {
  CaptureAuditRecordInput,
  CaptureAuditSummary,
  ModelTraceRecordInput,
} from "@cognelis/decision-storage";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  StructuredModelGateway,
} from "../src/main/model/model-gateway.js";
import {
  ProfiledModelGateway,
  outputValidationDiagnostic,
} from "../src/main/model/profiled-model-gateway.js";
import {
  qwenSemanticOutputJsonSchema,
} from "../src/main/model/semantic-prompt.js";
import {
  ModelProviderError,
} from "../src/main/model/http-model-transport.js";
import {
  QwenModelProvider,
  QwenProviderError,
  type QwenRuntimeModule,
} from "../src/main/semantic/qwen-provider.js";
import { QWEN_MODEL_MANIFEST } from "../src/main/semantic/model-manifest.js";
import type {
  SemanticClassifier,
  SemanticClassifierInput,
  SemanticProviderAttempt,
  SemanticProviderStatus,
} from "../src/main/semantic/semantic-classifier.js";

const input: SemanticClassifierInput = {
  pairId: "pair-1",
  assistantText: "先提交还是先修复？",
  userText: "先修复",
  locale: "zh-CN",
};

const outputLimitUsage = {
  source: "runtime_measured" as const,
  inputTokens: 580,
  outputTokens: 512,
  totalTokens: 1_092,
};

const outputLimitError = (): QwenProviderError =>
  new QwenProviderError(
    "output_limit",
    "Qwen output reached the 512-token limit before completing valid JSON",
    {
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
      usage: outputLimitUsage,
    },
  );

const classification = (
  provider: "apple" | "qwen",
): SemanticClassification => ({
  decisionIntent: "decision",
  answerRelation: "answers",
  question: "先提交还是先修复？",
  optionLabels: ["先提交", "先修复"],
  answerExcerpt: "先修复",
  confidence: 0.93,
  provider,
  modelVersion:
    provider === "apple"
      ? "system-language-model"
      : "qwen3.5-2b-q4-k-m",
  promptVersion: "semantic-v1",
});

const attempt = (
  id: "apple" | "qwen",
): SemanticProviderAttempt => ({
  classification: classification(id),
  visibleOutput: JSON.stringify({
    decisionIntent: "decision",
    answerRelation: "answers",
  }),
  traceInput: {
    systemPrompt: "Classify without reasoning.",
    userPrompt: "Assistant: choose A or B. User: A.",
    outputSchema: { type: "object" },
    clientSystemPromptVisibility: "visible",
  },
  usage:
    id === "qwen"
      ? {
          source: "runtime_measured",
          inputTokens: 40,
          outputTokens: 8,
          totalTokens: 48,
        }
      : { source: "unavailable" },
  providerDurationMs: 25,
});

const provider = (
  id: "apple" | "qwen",
  availability: SemanticProviderStatus["availability"],
  invoke: SemanticClassifier["invoke"] = vi.fn(async () =>
    attempt(id),
  ),
): SemanticClassifier => ({
  id,
  status: vi.fn(async () => ({
    id,
    availability,
    modelVersion: classification(id).modelVersion,
    promptVersion: "semantic-v1",
  })),
  invoke,
  classify: vi.fn(async (value, signal) =>
    (await invoke(value, signal)).classification,
  ),
  close: vi.fn(async () => undefined),
});

const emptySummary = (
  overrides: Partial<CaptureAuditSummary> = {},
): CaptureAuditSummary => ({
  total: 0,
  processed: 0,
  high: 0,
  medium: 0,
  failures: 0,
  stages: {},
  errorCodes: {},
  ...overrides,
});

const setup = (options: {
  apple: SemanticClassifier;
  qwen: SemanticClassifier;
  traceRecord?: (
    input: ModelTraceRecordInput,
  ) => Promise<ModelInvocationTrace>;
  summary?: CaptureAuditSummary;
  now?: () => Date;
}) => {
  const traceInputs: ModelTraceRecordInput[] = [];
  const auditInputs: CaptureAuditRecordInput[] = [];
  const auditFingerprint = vi.fn(async (value: string) =>
    value === "turn-1" ? "a".repeat(64) : "b".repeat(64),
  );
  let sequence = 0;
  const traceRecord =
    options.traceRecord ??
    vi.fn(async (traceInput: ModelTraceRecordInput) => {
      traceInputs.push(traceInput);
      return {
        version: 1,
        traceId: `stored-${sequence}`,
        contentMode: "full",
        createdAt: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-08-06T00:00:00.000Z",
        ...traceInput,
      } as ModelInvocationTrace;
    });
  const appleFactory = vi.fn(() => options.apple);
  const qwenFactory = vi.fn(() => options.qwen);
  const gateway = new StructuredModelGateway({
    appleFactory,
    qwenFactory,
    traces: { record: traceRecord },
    audit: {
      fingerprint: auditFingerprint,
      record: vi.fn(async (auditInput) => {
        auditInputs.push(auditInput);
        return {};
      }),
      summary: vi.fn(async () =>
        emptySummary(options.summary),
      ),
    },
    now:
      options.now ??
      (() => new Date("2026-07-30T00:00:00.000Z")),
    idFactory: () => `id-${sequence++}`,
  });
  return {
    appleFactory,
    auditFingerprint,
    auditInputs,
    gateway,
    qwenFactory,
    traceInputs,
  };
};

describe("StructuredModelGateway", () => {
  it("records unavailable Apple and the successful Qwen fallback as separate attempts", async () => {
    const apple = provider(
      "apple",
      "device_not_eligible",
    );
    const qwen = provider("qwen", "available");
    const { gateway, traceInputs } = setup({ apple, qwen });

    await expect(gateway.classify(input)).resolves.toEqual(
      classification("qwen"),
    );
    expect(traceInputs).toEqual([
      expect.objectContaining({
        attemptIndex: 0,
        profile: expect.objectContaining({
          backend: "apple",
        }),
        status: "unavailable",
        errorCode: "provider_unavailable",
      }),
      expect.objectContaining({
        attemptIndex: 1,
        profile: expect.objectContaining({
          backend: "qwen",
        }),
        status: "succeeded",
        output: expect.objectContaining({
          visibleText: attempt("qwen").visibleOutput,
        }),
      }),
    ]);
  });

  it("uses available Apple without instantiating Qwen", async () => {
    const apple = provider("apple", "available");
    const qwen = provider("qwen", "available");
    const { gateway, qwenFactory, traceInputs } = setup({
      apple,
      qwen,
    });

    await expect(gateway.classify(input)).resolves.toEqual(
      classification("apple"),
    );
    expect(qwenFactory).not.toHaveBeenCalled();
    expect(traceInputs).toHaveLength(1);
    expect(traceInputs[0]).toMatchObject({
      attemptIndex: 0,
      status: "succeeded",
      profile: { backend: "apple" },
    });
  });

  it("records Qwen output exhaustion as invalid output with measured token usage", async () => {
    const apple = provider(
      "apple",
      "device_not_eligible",
    );
    const qwen = provider(
      "qwen",
      "available",
      vi.fn(async () => {
        throw outputLimitError();
      }),
    );
    const { gateway, traceInputs } = setup({ apple, qwen });

    await expect(gateway.classify(input)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(traceInputs[1]).toMatchObject({
      profile: { backend: "qwen" },
      status: "invalid_output",
      errorCode: "output_limit",
      usage: outputLimitUsage,
    });
  });

  it("tries the other available provider once and returns a stable error when both fail", async () => {
    const apple = provider(
      "apple",
      "available",
      vi.fn(async () => {
        throw new Error("private Apple failure");
      }),
    );
    const qwen = provider(
      "qwen",
      "available",
      vi.fn(async () => {
        throw new Error("private Qwen failure");
      }),
    );
    const { gateway, traceInputs } = setup({ apple, qwen });

    await expect(gateway.classify(input)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(traceInputs).toHaveLength(2);
    expect(
      traceInputs.every((trace) => trace.status === "failed"),
    ).toBe(true);
    expect(JSON.stringify(traceInputs)).not.toContain("private");
  });

  it("keeps a successful classification when private trace persistence fails", async () => {
    const apple = provider("apple", "available");
    const qwen = provider("qwen", "available");
    const { auditInputs, gateway } = setup({
      apple,
      qwen,
      traceRecord: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });

    await expect(
      gateway.classify(input, undefined, {
        sourceClient: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    ).resolves.toEqual(
      classification("apple"),
    );
    expect(auditInputs).toEqual([
      expect.objectContaining({
        sourceClient: "codex",
        sessionId: "session-1",
        turnId: "turn-1",
        stage: "failed",
        errorCode: "trace_write_failed",
      }),
    ]);
  });

  it("links traces to content-free audit receipts without storing raw IDs", async () => {
    const apple = provider("apple", "available");
    const qwen = provider("qwen", "available");
    const {
      auditFingerprint,
      gateway,
      traceInputs,
    } = setup({ apple, qwen });

    await gateway.classify(input, undefined, {
      sourceClient: "codex",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(auditFingerprint).toHaveBeenCalledWith("turn-1");
    expect(traceInputs[0]).toMatchObject({
      correlationFingerprint: "a".repeat(64),
    });
    expect(JSON.stringify(traceInputs[0])).not.toContain(
      "turn-1",
    );
  });

  it("reports active status and retries runtime failures after the cooldown", async () => {
    let now = new Date("2026-07-30T00:00:00.000Z");
    const apple = provider(
      "apple",
      "device_not_eligible",
    );
    const invoke = vi
      .fn<SemanticClassifier["invoke"]>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue(attempt("qwen"));
    const qwen = provider("qwen", "available", invoke);
    const { gateway } = setup({
      apple,
      qwen,
      summary: emptySummary({
        processed: 12,
        high: 4,
        medium: 3,
        failures: 1,
      }),
      now: () => now,
    });

    await expect(gateway.classify(input)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    await expect(gateway.status()).resolves.toMatchObject({
      provider: "rules",
      availability: "runtime_unavailable",
      processed7d: 12,
      high7d: 4,
      medium7d: 3,
      failures7d: 1,
    } satisfies Partial<SemanticRecognitionStatus>);

    // Half a minute on, though the Mac's clock was set back an hour meanwhile.
    now = new Date(now.getTime() - 3_600_000);
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 30_001);
    try {
      await expect(gateway.classify(input)).resolves.toEqual(
        classification("qwen"),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("closes every provider it instantiated exactly once", async () => {
    const apple = provider(
      "apple",
      "device_not_eligible",
    );
    const qwen = provider("qwen", "available");
    const { gateway } = setup({ apple, qwen });
    await gateway.status();

    await gateway.close();
    await gateway.close();

    expect(apple.close).toHaveBeenCalledOnce();
    expect(qwen.close).toHaveBeenCalledOnce();
  });
});

const profiled = (
  profileId: string,
  kind: ModelProviderProfile["kind"],
  priority: number,
  enabled = true,
): ModelProviderProfile => {
  const common = {
    version: 1 as const,
    profileId,
    kind,
    label: profileId,
    enabled,
    priority,
    timeoutMs: 10_000,
  };
  if (kind === "openai") {
    return {
      ...common,
      model: "gpt-5-mini",
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses",
      credentialRef: `${profileId}-key`,
    };
  }
  if (kind === "anthropic") {
    return {
      ...common,
      model: "claude-haiku-4-5",
      baseUrl: "https://api.anthropic.com",
      apiProtocol: "messages",
      credentialRef: `${profileId}-key`,
    };
  }
  if (kind === "openai-compatible") {
    return {
      ...common,
      model: "local-model",
      baseUrl: "http://127.0.0.1:11434",
      apiProtocol: "responses",
      credentialRef: `${profileId}-key`,
    };
  }
  if (kind === "apple" || kind === "qwen") {
    return {
      ...common,
      model:
        kind === "apple"
          ? "system-language-model"
          : "qwen3.5-2b-q4-k-m",
    };
  }
  return common;
};

const profiledAttempt = (
  providerId: ModelProviderProfile["kind"],
): SemanticProviderAttempt => ({
  ...attempt(providerId === "apple" ? "apple" : "qwen"),
  classification: {
    ...classification(
      providerId === "apple" ? "apple" : "qwen",
    ),
    provider: providerId,
    modelVersion: `${providerId}-model`,
  },
  providerRequestId: `${providerId}-request`,
});

const profiledProvider = (
  id: ModelProviderProfile["kind"],
  invoke: SemanticClassifier["invoke"] = vi.fn(async () =>
    profiledAttempt(id),
  ),
): SemanticClassifier => ({
  id,
  status: vi.fn(async () => ({
    id,
    availability: "available" as const,
    modelVersion: `${id}-model`,
    promptVersion: "semantic-v1",
  })),
  invoke,
  classify: vi.fn(async (value, signal) =>
    (await invoke(value, signal)).classification,
  ),
  close: vi.fn(async () => undefined),
});

const profiledGateway = (options: {
  load: () => Promise<ModelProviderProfile[]>;
  factory: (
    profile: ModelProviderProfile,
  ) => SemanticClassifier;
  unattendedGenerationMs?: number;
}) => {
  const traceInputs: ModelTraceRecordInput[] = [];
  const auditFingerprint = vi.fn(async (value: string) =>
    value === "profiled-turn" ? "c".repeat(64) : "d".repeat(64),
  );
  let sequence = 0;
  const gateway = new ProfiledModelGateway({
    profiles: { load: options.load },
    providerFactory: options.factory,
    traces: {
      record: vi.fn(async (traceInput) => {
        traceInputs.push(traceInput);
        return {
          version: 1,
          traceId: `profiled-trace-${sequence}`,
          contentMode: "full",
          createdAt: "2026-07-30T00:00:00.000Z",
          expiresAt: "2026-08-06T00:00:00.000Z",
          ...traceInput,
        } as ModelInvocationTrace;
      }),
    },
    audit: {
      fingerprint: auditFingerprint,
      record: vi.fn(async () => ({})),
      summary: vi.fn(async () => emptySummary()),
    },
    now: () => new Date("2026-07-30T00:00:00.000Z"),
    idFactory: () => `profiled-id-${sequence++}`,
    ...(options.unattendedGenerationMs === undefined ? {} : { unattendedGenerationMs: options.unattendedGenerationMs }),
  });
  return { auditFingerprint, gateway, traceInputs };
};

describe("ProfiledModelGateway", () => {
  it("preserves structured failure codes when the provider chain ends", async () => {
    const { gateway, traceInputs } = profiledGateway({ load: async () => [profiled("local", "qwen", 0)], factory: () => Object.assign(profiledProvider("qwen"), { generate: async () => { throw new QwenProviderError("invalid_configuration", "Unsupported grammar"); } }) });
    await expect(gateway.generate({ requestId: "grammar", purpose: "pr-review", promptVersion: "test", schemaVersion: "test", locale: "zh-CN", systemPrompt: "JSON", userPrompt: "test", outputSchema: { type: "object" }, maxOutputTokens: 100 }, (value) => value)).rejects.toMatchObject({ failureCode: "invalid_configuration" });
    expect(traceInputs[0]).toMatchObject({ errorCode: "invalid_configuration" });
  });
  it("traces preparation failures before moving to the next enabled provider", async () => {
    const first = profiled("first", "openai", 0); const second = profiled("second", "anthropic", 1);
    const broken = profiledProvider("openai"); vi.mocked(broken.status).mockRejectedValue(new Error("probe failed"));
    const { gateway, traceInputs } = profiledGateway({ load: async () => [first, second], factory: (profile) => profile.profileId === "first" ? broken : profiledProvider("anthropic") });
    await gateway.classify(input);
    expect(traceInputs.map((trace) => [trace.attemptIndex, trace.status])).toEqual([[0, "unavailable"], [1, "succeeded"]]);
    expect(traceInputs[0]!.requestId).toBe(traceInputs[1]!.requestId);
  });
  it("stops at a failed profile when fallback is explicitly disabled", async () => {
    const first = { ...profiled("first", "openai", 0), fallbackOnFailure: false };
    const factory = vi.fn(() => profiledProvider("openai", async () => { throw new Error("request failed"); }));
    const { gateway, traceInputs } = profiledGateway({ load: async () => [first, profiled("second", "anthropic", 1)], factory });
    await expect(gateway.classify(input)).rejects.toThrow("request failed"); expect(factory).toHaveBeenCalledTimes(1); expect(traceInputs).toHaveLength(1);
  });
  const draftRequest: StructuredGenerationRequest = {
    requestId: "draft-request",
    purpose: "methodology-extraction",
    promptVersion: "methodology-v1",
    schemaVersion: "methodology-schema-v1",
    locale: "zh-CN",
    systemPrompt: "只返回结构化候选。",
    userPrompt: "证据 1：小步改动按预期上线。",
    outputSchema: { type: "object" },
    maxOutputTokens: 512,
  };
  const drafted = (request: StructuredGenerationRequest, usage: NormalizedTokenUsage = { source: "runtime_measured" }) => ({
    parsedOutput: { title: "可逆优先" },
    visibleOutput: '{"title":"可逆优先"}',
    traceInput: {
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      outputSchema: request.outputSchema,
      clientSystemPromptVisibility: "visible" as const,
    },
    usage,
    providerDurationMs: 21,
  });

  it("does not truncate a provider duration greater than two minutes", async () => {
    const provider = Object.assign(profiledProvider("qwen"), { generate: async () => ({ ...drafted(draftRequest), providerDurationMs: 180123 }) });
    const { gateway, traceInputs } = profiledGateway({ load: async () => [profiled("local", "qwen", 0)], factory: () => provider });
    await gateway.generate(draftRequest, value => value);
    expect(traceInputs[0]!.timing.providerMs).toBe(180123);
  });

  it("keeps validation paths and request limits without quoting rejected values", async () => {
    const logical = z.object({ title: z.string() }).strict();
    const request = { ...draftRequest, outputSchema: z.toJSONSchema(logical) };
    const provider = Object.assign(profiledProvider("qwen"), { generate: async () => ({ ...drafted(request), parsedOutput: { title: null, PRIVATE_FIELD: "PRIVATE_BODY" }, visibleOutput: "PRIVATE_OUTPUT", traceInput: { ...drafted(request).traceInput, clientSystemPromptVisibility: "opaque" as const } }) });
    const { gateway, traceInputs } = profiledGateway({ load: async () => [profiled("local", "qwen", 0)], factory: () => provider });
    await expect(gateway.generate(request, value => logical.parse(value))).rejects.toThrow();
    expect(traceInputs[0]).toMatchObject({ errorCode: "invalid_output", input: { clientSystemPromptVisibility: "opaque" }, request: { configuredTimeoutMs: 10000, generationTimeoutMs: 30000, requestedMaxOutputTokens: 512 } });
    expect(traceInputs[0]!.diagnosticExcerpt).toContain("title：invalid_type");
    expect(traceInputs[0]!.diagnosticExcerpt).not.toMatch(/PRIVATE_FIELD|PRIVATE_BODY|PRIVATE_OUTPUT/);
    expect(outputValidationDiagnostic({ issues: [{ path: ["PRIVATE_FIELD"], code: "usersecret", message: "PRIVATE_BODY", expected: "PRIVATE_OUTPUT" }] }, request.outputSchema)).not.toMatch(/PRIVATE_FIELD|PRIVATE_BODY|PRIVATE_OUTPUT|usersecret/);
  });

  it("passes over a backend that cannot generate even with its fallback turned off", async () => {
    // Apple only classifies. Its "fall back on failure" switch is about Apple failing, and Apple
    // cannot fail at a generation it never attempts.
    const apple = { ...profiled("apple-first", "apple", 0), fallbackOnFailure: false };
    const generate = vi.fn(async (request: StructuredGenerationRequest) => drafted(request));
    const { gateway } = profiledGateway({
      load: async () => [apple, profiled("qwen-second", "qwen", 10)],
      factory: (profile) => profile.kind === "apple" ? profiledProvider("apple") : Object.assign(profiledProvider("qwen"), { generate }),
    });

    await expect(gateway.generate(draftRequest, (value) => value)).resolves.toMatchObject({ profileId: "qwen-second" });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("lets a capture wait its turn on the bundled model rather than time out behind the reader's own answer", async () => {
    // Qwen takes one call at a time. Timed from the call, a capture classified while it wrote an answer was
    // filed as Qwen's timeout and went down the chain, its text to a remote backend.
    let finishAnswer!: () => void;
    const answering = new Promise<void>((resolve) => { finishAnswer = resolve; });
    const prompts: string[] = [];
    const session = {
      prompt: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        if (prompt === "ANSWER") { await answering; return JSON.stringify({ title: "可逆优先" }); }
        return JSON.stringify({ decisionIntent: "decision", answerRelation: "answers", question: "先提交还是先修复？", optionLabels: ["先提交", "先修复"], answerExcerpt: "先修复", confidence: 0.9 });
      }),
      dispose: vi.fn(),
    };
    const context = { getSequence: () => ({}), dispose: async () => undefined };
    const llama = {
      loadModel: async () => ({ createContext: async () => context, dispose: async () => undefined }),
      createGrammarForJsonSchema: async () => ({}),
      dispose: async () => undefined,
    };
    const qwen = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => ({ availability: "available", modelPath: "/models/qwen.gguf", manifest: QWEN_MODEL_MANIFEST }),
      loadRuntime: async () => ({ getLlama: async () => llama, LlamaChatSession: function () { return session; } }) as unknown as QwenRuntimeModule,
    });
    const remote = profiledProvider("openai");
    const { gateway, traceInputs } = profiledGateway({
      load: async () => [{ ...profiled("local", "qwen", 0), timeoutMs: 100 }, profiled("remote", "openai", 1)],
      factory: (profile) => (profile.kind === "qwen" ? qwen : remote),
    });

    const answer = gateway.generate({ ...draftRequest, userPrompt: "ANSWER" }, (value) => value, undefined, "local");
    await vi.waitFor(() => expect(prompts).toEqual(["ANSWER"]));
    const classified = gateway.classify(input);
    // Three times the profile's classification budget.
    await new Promise((resolve) => setTimeout(resolve, 300));
    finishAnswer();

    await expect(classified).resolves.toMatchObject({ provider: "qwen" });
    await expect(answer).resolves.toMatchObject({ parsedOutput: { title: "可逆优先" } });
    expect(remote.invoke).not.toHaveBeenCalled();
    expect(traceInputs.map((trace) => trace.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("waits for the bundled model to check its file rather than send the text on when that takes a while", async () => {
    // Qwen hashes its whole model file the first time it is asked whether it is ready: seconds on a slow Mac.
    const slowCheck = (): SemanticClassifier => Object.assign(profiledProvider("qwen"), {
      queuesCalls: true,
      status: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { id: "qwen" as const, availability: "available" as const, modelVersion: "qwen-model", promptVersion: "semantic-v1" };
      }),
    });
    const remote = profiledProvider("openai");
    const { gateway } = profiledGateway({
      load: async () => [{ ...profiled("local", "qwen", 0), timeoutMs: 100 }, profiled("remote", "openai", 1)],
      factory: (profile) => (profile.kind === "qwen" ? slowCheck() : remote),
    });

    await expect(gateway.classify(input)).resolves.toMatchObject({ provider: "qwen" });
    expect(remote.invoke).not.toHaveBeenCalled();
  });

  it("ends a draft nobody can stop as a timeout when the bundled model never says it is ready", async () => {
    // Its file check stuck (a disk gone quiet): no timer of its own, and none from a caller to stop it.
    const stuck = Object.assign(profiledProvider("qwen"), {
      queuesCalls: true,
      status: vi.fn(() => new Promise<never>(() => undefined)),
      generate: vi.fn(),
    });
    const { gateway } = profiledGateway({ load: async () => [profiled("local", "qwen", 0)], factory: () => stuck, unattendedGenerationMs: 100 });

    // Unbounded, the knowledge page's button turned until the app quit.
    await expect(gateway.generate(draftRequest, (value) => value)).rejects.toMatchObject({ failureCode: "timeout" });
    expect(stuck.generate).not.toHaveBeenCalled();
  });

  it("still times the settings test of the bundled model while it writes the reader's answer", async () => {
    let finishAnswer!: () => void;
    const answering = new Promise<void>((resolve) => { finishAnswer = resolve; });
    const prompts: string[] = [];
    const session = {
      prompt: vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        await answering;
        return JSON.stringify({ title: "可逆优先" });
      }),
      dispose: vi.fn(),
    };
    const context = { getSequence: () => ({}), dispose: async () => undefined };
    const llama = {
      loadModel: async () => ({ createContext: async () => context, dispose: async () => undefined }),
      createGrammarForJsonSchema: async () => ({}),
      dispose: async () => undefined,
    };
    const qwen = new QwenModelProvider({
      modelsDirectory: "/models",
      verifyModel: async () => ({ availability: "available", modelPath: "/models/qwen.gguf", manifest: QWEN_MODEL_MANIFEST }),
      loadRuntime: async () => ({ getLlama: async () => llama, LlamaChatSession: function () { return session; } }) as unknown as QwenRuntimeModule,
    });
    const { gateway } = profiledGateway({
      load: async () => [{ ...profiled("local", "qwen", 0), timeoutMs: 100 }],
      factory: () => qwen,
    });

    const answer = gateway.generate({ ...draftRequest, userPrompt: "ANSWER" }, (value) => value, undefined, "local");
    await vi.waitFor(() => expect(prompts).toEqual(["ANSWER"]));
    // Untimed, it waited out the whole answer, its button turning with no way to stop it.
    await expect(gateway.testProfile("local")).resolves.toMatchObject({ ok: false, profileId: "local", errorCode: "timeout" });
    finishAnswer();
    await answer;
  });

  it("ends a chain stopped by a disabled fallback with its own error, for a turn to retry and report", async () => {
    const only = { ...profiled("only", "openai", 0), fallbackOnFailure: false };
    const { gateway } = profiledGateway({
      load: async () => [only],
      factory: () => Object.assign(profiledProvider("openai"), {
        generate: async () => { throw new ModelProviderError("timeout", "Model provider attempt timed out"); },
      }),
    });

    await expect(gateway.generate(draftRequest, (value) => value, undefined, "only")).rejects.toMatchObject({
      name: "ProfiledModelGatewayError",
      failureCode: "timeout",
    });
  });

  it("keeps what a rejected answer cost and said, for the trace and for the turn", async () => {
    const usage: NormalizedTokenUsage = { source: "provider_reported", inputTokens: 1_000, outputTokens: 500 };
    const { gateway, traceInputs } = profiledGateway({
      load: async () => [profiled("only", "openai", 0)],
      factory: () => Object.assign(profiledProvider("openai"), {
        generate: async (request: StructuredGenerationRequest) => ({ ...drafted(request, usage), providerRequestId: "resp-1" }),
      }),
    });

    await expect(gateway.generate(draftRequest, () => { throw new Error("not this shape"); })).rejects.toMatchObject({
      failureCode: "invalid_output",
      usage: { inputTokens: 1_000, outputTokens: 500 },
      // What it said, for a review's step to show beside "错误类别：invalid_output".
      output: '{"title":"可逆优先"}',
    });
    expect(traceInputs.at(-1)).toMatchObject({
      errorCode: "invalid_output",
      usage: { inputTokens: 1_000, outputTokens: 500 },
      output: { visibleText: '{"title":"可逆优先"}', parsed: null },
      providerRequestId: "resp-1",
    });
  });

  it("cancels a generation still running when it closes, so no backend is left to run on its own", async () => {
    let attemptSignal: AbortSignal | undefined;
    const { gateway } = profiledGateway({
      load: async () => [profiled("cli", "openai", 0)],
      factory: () => Object.assign(profiledProvider("openai"), {
        generate: (_request: StructuredGenerationRequest, signal?: AbortSignal) => {
          attemptSignal = signal;
          return new Promise<never>(() => undefined);
        },
      }),
    });
    const pending = gateway.generate(draftRequest, (value) => value);
    await vi.waitFor(() => expect(attemptSignal).toBeDefined());

    await gateway.close();

    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(attemptSignal?.aborted).toBe(true);
  });

  it("gives a backend kept for the life of the app the timeout its profile has now", async () => {
    let timeoutMs = 5_000;
    const qwen = Object.assign(profiledProvider("qwen"), { setTimeoutMs: vi.fn() });
    const factory = vi.fn(() => qwen);
    const { gateway } = profiledGateway({
      load: async () => [{ ...profiled("local", "qwen", 0), timeoutMs }],
      factory,
    });

    await gateway.classify(input);
    timeoutMs = 9_000;
    await gateway.classify(input);

    expect(factory).toHaveBeenCalledOnce();
    expect(qwen.setTimeoutMs).toHaveBeenLastCalledWith(9_000);
  });

  it("keeps readiness consistent with a stopped fallback chain", async () => {
    const first = { ...profiled("first", "openai", 0), fallbackOnFailure: false };
    const provider = profiledProvider("openai"); vi.mocked(provider.status).mockResolvedValue({ id: "openai", availability: "runtime_unavailable" });
    const factory = vi.fn(() => provider);
    const { gateway } = profiledGateway({ load: async () => [first, profiled("next", "anthropic", 1)], factory });
    expect(await gateway.status()).toMatchObject({ provider: "rules", mode: "rules_only", unavailableModels: [{ providerLabel: "first", availability: "runtime_unavailable" }] });
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("says which backend could not be used and why, with the rules reading on their own meanwhile", async () => {
    const apple = profiledProvider("apple"); vi.mocked(apple.status).mockResolvedValue({ id: "apple", availability: "apple_intelligence_disabled" });
    const qwen = profiledProvider("qwen"); vi.mocked(qwen.status).mockRejectedValue(new Error("helper crashed"));
    const { gateway } = profiledGateway({
      load: async () => [profiled("Apple", "apple", 0), profiled("Qwen", "qwen", 1), profiled("off", "openai", 2, false)],
      factory: (profile) => (profile.kind === "apple" ? apple : qwen),
    });
    // It said the rules, which were working, were "temporarily unavailable" in 混合模式, and dropped both reasons.
    expect(await gateway.status()).toMatchObject({
      provider: "rules", availability: "available", mode: "rules_only",
      unavailableModels: [{ providerLabel: "Apple", availability: "apple_intelligence_disabled" }, { providerLabel: "Qwen", availability: "unavailable" }],
    });
    const none = profiledGateway({ load: async () => [profiled("off", "openai", 0, false)], factory: () => apple });
    expect(await none.gateway.status()).toMatchObject({ provider: "rules", mode: "rules_only", unavailableModels: [] });
  });
  it("bounds a stuck provider, signals cancellation to it and succeeds through fallback", async () => {
    vi.useFakeTimers();
    try {
      let attemptSignal: AbortSignal | undefined;
      const first = { ...profiled("stuck", "openai", 0), timeoutMs: 1000 };
      const { gateway, traceInputs } = profiledGateway({ load: async () => [first, profiled("next", "anthropic", 1)], factory: (profile) => profile.profileId === "stuck" ? profiledProvider("openai", async (_input, signal) => { attemptSignal = signal; return new Promise(() => undefined); }) : profiledProvider("anthropic") });
      const pending = gateway.classify(input); await vi.advanceTimersByTimeAsync(1001); await pending;
      expect(attemptSignal?.aborted).toBe(true); expect(traceInputs[0]).toMatchObject({ errorCode: "timeout", status: "timed_out" }); expect(traceInputs[1]).toMatchObject({ status: "succeeded", attemptIndex: 1 });
    } finally { vi.useRealTimers(); }
  });
  it("gives a generation longer than the classification budget the profile sets", async () => {
    vi.useFakeTimers();
    try {
      // The built-in local profile's five seconds is a classification budget:
      // capture must not wait. A generation the reader is waiting on has the
      // opposite need, and five seconds is not enough to write a cited answer.
      let attemptSignal: AbortSignal | undefined;
      const short = { ...profiled("short", "qwen", 0), timeoutMs: 5_000 };
      const { gateway } = profiledGateway({
        load: async () => [short],
        factory: () =>
          Object.assign(profiledProvider("qwen"), {
            generate: vi.fn(
              async (_request: StructuredGenerationRequest, signal?: AbortSignal) => {
                attemptSignal = signal;
                return new Promise<never>(() => undefined);
              },
            ),
          }),
      });
      const pending = gateway
        .generate(
          {
            requestId: "long-answer",
            purpose: "retrieval-answer",
            promptVersion: "assistant-v1",
            schemaVersion: "assistant-step-v1",
            locale: "zh-CN",
            systemPrompt: "只返回一个动作。",
            userPrompt: "问题",
            outputSchema: { type: "object" },
            maxOutputTokens: 512,
          },
          (value) => value,
        )
        .catch(() => undefined);

      await vi.advanceTimersByTimeAsync(5_001);
      expect(attemptSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(25_000);
      expect(attemptSignal?.aborted).toBe(true);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a provider for an already cancelled request or fall back after cancellation", async () => {
    const controller = new AbortController(); controller.abort(); const factory = vi.fn(() => profiledProvider("openai"));
    const { gateway } = profiledGateway({ load: async () => [profiled("first", "openai", 0)], factory });
    await expect(gateway.classify(input, controller.signal)).rejects.toMatchObject({ code: "cancelled" }); expect(factory).not.toHaveBeenCalled();
    const aborting = vi.fn(() => profiledProvider("openai", async () => { const error = new Error("cancelled"); error.name = "AbortError"; throw error; }));
    const other = profiledGateway({ load: async () => [profiled("first", "openai", 0), profiled("second", "anthropic", 1)], factory: aborting });
    await expect(other.gateway.classify(input)).rejects.toMatchObject({ name: "AbortError" }); expect(aborting).toHaveBeenCalledTimes(1);
  });

  it("routes generic structured extraction through capable providers and traces unsupported fallbacks", async () => {
    const apple = profiled("apple-first", "apple", 0);
    const qwen = profiled("qwen-second", "qwen", 10);
    const appleProvider = profiledProvider("apple");
    const qwenProvider = Object.assign(profiledProvider("qwen"), {
      generate: vi.fn(async (request: StructuredGenerationRequest) => ({
        parsedOutput: { title: "可逆优先" },
        visibleOutput: '{"title":"可逆优先"}',
        modelVersion: "qwen-methodology",
        traceInput: {
          systemPrompt: request.systemPrompt,
          userPrompt: request.userPrompt,
          outputSchema: request.outputSchema,
          clientSystemPromptVisibility: "visible" as const,
        },
        usage: { source: "runtime_measured" as const },
        providerDurationMs: 21,
      })),
    });
    const { gateway, traceInputs } = profiledGateway({
      load: vi.fn(async () => [apple, qwen]),
      factory: vi.fn((profile) =>
        profile.kind === "apple" ? appleProvider : qwenProvider,
      ),
    });
    const request: StructuredGenerationRequest = {
      requestId: "methodology-request",
      purpose: "methodology-extraction",
      promptVersion: "methodology-v1",
      schemaVersion: "methodology-schema-v1",
      locale: "zh-CN",
      systemPrompt: "只返回结构化候选。",
      userPrompt: "证据 1：小步改动按预期上线。",
      outputSchema: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
      maxOutputTokens: 512,
    };

    await expect(
      gateway.generate(request, (value) =>
        value as { title: string },
      ),
    ).resolves.toMatchObject({
      requestId: "methodology-request",
      profileId: "qwen-second",
      model: "qwen-methodology",
      parsedOutput: { title: "可逆优先" },
    });
    expect(traceInputs).toHaveLength(2);
    expect(traceInputs[0]).toMatchObject({
      purpose: "methodology-extraction",
      status: "unavailable",
      errorCode: "unsupported_client",
      profile: { profileId: "apple-first" },
    });
    expect(traceInputs[1]).toMatchObject({
      purpose: "methodology-extraction",
      status: "succeeded",
      profile: {
        profileId: "qwen-second",
        promptVersion: "methodology-v1",
        schemaVersion: "methodology-schema-v1",
      },
      output: { parsed: { title: "可逆优先" } },
    });
  });

  it("skips disabled profiles and invokes the first enabled profile by persisted priority", async () => {
    const disabled = profiled(
      "disabled-openai",
      "openai",
      0,
      false,
    );
    const qwen = profiled("qwen-second", "qwen", 20);
    const apple = profiled("apple-first", "apple", 10);
    const appleProvider = profiledProvider("apple");
    const factory = vi.fn((selected: ModelProviderProfile) =>
      selected.kind === "apple"
        ? appleProvider
        : profiledProvider(selected.kind),
    );
    const { gateway, traceInputs } = profiledGateway({
      load: vi.fn(async () => [qwen, disabled, apple]),
      factory,
    });

    await expect(gateway.classify(input)).resolves.toMatchObject({
      provider: "apple",
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(apple);
    expect(traceInputs[0]).toMatchObject({
      attemptIndex: 0,
      profile: {
        profileId: "apple-first",
        backend: "apple",
      },
      providerRequestId: "apple-request",
      status: "succeeded",
    });
  });

  it("records authentication failure and continues to the next enabled profile", async () => {
    const openai = profiled("openai-first", "openai", 0);
    const qwen = profiled("qwen-fallback", "qwen", 10);
    const remoteFailure = new ModelProviderError(
      "authentication_failed",
      "Model API returned HTTP 401",
      {
        providerRequestId: "req-auth-failed",
        diagnosticExcerpt: "HTTP 401",
      },
    );
    const factory = vi.fn((selected: ModelProviderProfile) =>
      selected.kind === "openai"
        ? profiledProvider(
            "openai",
            vi.fn(async () => {
              throw remoteFailure;
            }),
          )
        : profiledProvider(selected.kind),
    );
    const { gateway, traceInputs } = profiledGateway({
      load: vi.fn(async () => [openai, qwen]),
      factory,
    });

    await expect(gateway.classify(input)).resolves.toMatchObject({
      provider: "qwen",
    });
    expect(traceInputs).toHaveLength(2);
    expect(traceInputs[0]).toMatchObject({
      profile: {
        profileId: "openai-first",
        backend: "openai",
      },
      status: "auth_failed",
      errorCode: "authentication_failed",
      providerRequestId: "req-auth-failed",
      diagnosticExcerpt: "HTTP 401",
    });
    expect(traceInputs[1]).toMatchObject({
      profile: {
        profileId: "qwen-fallback",
        backend: "qwen",
      },
      status: "succeeded",
    });
  });

  it("records Qwen output exhaustion and continues to the next enabled profile", async () => {
    const qwen = profiled("qwen-first", "qwen", 0);
    const apple = profiled("apple-fallback", "apple", 10);
    const factory = vi.fn((selected: ModelProviderProfile) =>
      selected.kind === "qwen"
        ? profiledProvider(
            "qwen",
            vi.fn(async () => {
              throw outputLimitError();
            }),
          )
        : profiledProvider(selected.kind),
    );
    const { gateway, traceInputs } = profiledGateway({
      load: vi.fn(async () => [qwen, apple]),
      factory,
    });

    await expect(gateway.classify(input)).resolves.toMatchObject({
      provider: "apple",
    });
    expect(traceInputs[0]).toMatchObject({
      profile: {
        profileId: "qwen-first",
        backend: "qwen",
      },
      status: "invalid_output",
      errorCode: "output_limit",
      usage: outputLimitUsage,
      input: {
        outputSchema: qwenSemanticOutputJsonSchema,
      },
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
    });
  });

  it("records correlation fingerprints and CLI process exit codes across fallback attempts", async () => {
    const codex = profiled(
      "codex-failure",
      "codex-cli",
      0,
    );
    const qwen = profiled("qwen-fallback", "qwen", 10);
    const processFailure = Object.assign(
      new Error("private CLI failure"),
      {
        code: "process_failed",
        processExitCode: 17,
        diagnosticExcerpt: "client exited with status 17",
      },
    );
    const factory = vi.fn((selected: ModelProviderProfile) =>
      selected.kind === "codex-cli"
        ? profiledProvider(
            "codex-cli",
            vi.fn(async () => {
              throw processFailure;
            }),
          )
        : profiledProvider(selected.kind),
    );
    const {
      auditFingerprint,
      gateway,
      traceInputs,
    } = profiledGateway({
      load: vi.fn(async () => [codex, qwen]),
      factory,
    });

    await expect(
      gateway.classify(input, undefined, {
        sourceClient: "codex",
        sessionId: "profiled-session",
        turnId: "profiled-turn",
      }),
    ).resolves.toMatchObject({ provider: "qwen" });

    expect(auditFingerprint).toHaveBeenCalledTimes(2);
    expect(auditFingerprint).toHaveBeenCalledWith(
      "profiled-turn",
    );
    expect(traceInputs).toHaveLength(2);
    expect(traceInputs[0]).toMatchObject({
      correlationFingerprint: "c".repeat(64),
      processExitCode: 17,
      status: "failed",
      errorCode: "process_failed",
    });
    expect(traceInputs[1]).toMatchObject({
      correlationFingerprint: "c".repeat(64),
      status: "succeeded",
    });
  });

  it("loads profile changes at the start of every classification", async () => {
    const apple = profiled("apple-first", "apple", 0);
    const qwen = profiled("qwen-now-first", "qwen", 0);
    const load = vi
      .fn<() => Promise<ModelProviderProfile[]>>()
      .mockResolvedValueOnce([apple])
      .mockResolvedValueOnce([qwen]);
    const factory = vi.fn((selected: ModelProviderProfile) =>
      profiledProvider(selected.kind),
    );
    const { gateway } = profiledGateway({ load, factory });

    await expect(gateway.classify(input)).resolves.toMatchObject({
      provider: "apple",
    });
    await expect(gateway.classify(input)).resolves.toMatchObject({
      provider: "qwen",
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("records provider tests with a health-check purpose", async () => {
    const openai = profiled("openai-test", "openai", 0, false);
    const { gateway, traceInputs } = profiledGateway({
      load: vi.fn(async () => [openai]),
      factory: vi.fn(() => profiledProvider("openai")),
    });

    await expect(
      gateway.testProfile("openai-test"),
    ).resolves.toMatchObject({
      ok: true,
      profileId: "openai-test",
      modelVersion: "openai-model",
      tokenSource: "runtime_measured",
    });
    expect(traceInputs).toHaveLength(1);
    expect(traceInputs[0]).toMatchObject({
      purpose: "provider-health-check",
      profile: { profileId: "openai-test" },
    });
  });

  it("keeps the health-check purpose when a tested provider is unavailable", async () => {
    const openai = profiled("openai-test", "openai", 0, false);
    const unavailable = profiledProvider("openai");
    unavailable.status = vi.fn(async () => ({
      id: "openai" as const,
      availability: "runtime_unavailable" as const,
      modelVersion: "openai-model",
      promptVersion: "semantic-v1",
    }));
    const { gateway, traceInputs } = profiledGateway({
      load: vi.fn(async () => [openai]),
      factory: vi.fn(() => unavailable),
    });

    await expect(
      gateway.testProfile("openai-test"),
    ).resolves.toMatchObject({
      ok: false,
      profileId: "openai-test",
      errorCode: "provider_unavailable",
      availability: "runtime_unavailable",
    });
    expect(traceInputs).toHaveLength(1);
    expect(traceInputs[0]).toMatchObject({
      purpose: "provider-health-check",
      status: "unavailable",
      profile: { profileId: "openai-test" },
    });
  });

  it("returns safe failure diagnostics from a provider health check", async () => {
    const openai = profiled("openai-test", "openai", 0, false);
    const failed = profiledProvider(
      "openai",
      vi.fn(async () => {
        throw {
          code: "process_failed",
          processExitCode: 23,
          providerRequestId: "provider-request-23",
          diagnosticExcerpt: "客户端退出，无法读取模型响应",
        };
      }),
    );
    const { gateway } = profiledGateway({
      load: vi.fn(async () => [openai]),
      factory: vi.fn(() => failed),
    });

    await expect(
      gateway.testProfile("openai-test"),
    ).resolves.toMatchObject({
      ok: false,
      profileId: "openai-test",
      errorCode: "process_failed",
      processExitCode: 23,
      providerRequestId: "provider-request-23",
      diagnosticExcerpt: "客户端退出，无法读取模型响应",
    });
  });

  it("omits empty failure diagnostics from a provider health check", async () => {
    const codex = profiled(
      "codex-test",
      "codex-cli",
      0,
      false,
    );
    const failed = profiledProvider(
      "codex-cli",
      vi.fn(async () => {
        throw {
          code: "process_failed",
          diagnosticExcerpt: "   ",
        };
      }),
    );
    const { gateway, traceInputs } = profiledGateway({
      load: vi.fn(async () => [codex]),
      factory: vi.fn(() => failed),
    });

    const result = await gateway.testProfile("codex-test");

    expect(result).toMatchObject({
      ok: false,
      profileId: "codex-test",
      errorCode: "process_failed",
    });
    expect(result).not.toHaveProperty("diagnosticExcerpt");
    expect(traceInputs[0]).not.toHaveProperty(
      "diagnosticExcerpt",
    );
  });

  it("returns the concrete Qwen failure from a provider health check", async () => {
    const qwen = profiled("qwen-test", "qwen", 0, false);
    const failed = profiledProvider(
      "qwen",
      vi.fn(async () => {
        throw outputLimitError();
      }),
    );
    const { gateway } = profiledGateway({
      load: vi.fn(async () => [qwen]),
      factory: vi.fn(() => failed),
    });

    await expect(
      gateway.testProfile("qwen-test"),
    ).resolves.toMatchObject({
      ok: false,
      profileId: "qwen-test",
      errorCode: "output_limit",
      diagnosticExcerpt:
        "Qwen output reached the 512-token limit before completing valid JSON",
    });
  });
});
