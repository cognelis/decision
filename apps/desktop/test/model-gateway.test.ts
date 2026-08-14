import type {
  ModelProviderProfile,
  ModelInvocationTrace,
  SemanticClassification,
  SemanticRecognitionStatus,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import type {
  CaptureAuditRecordInput,
  CaptureAuditSummary,
  ModelTraceRecordInput,
} from "@cognelis/decision-storage";
import { describe, expect, it, vi } from "vitest";

import {
  StructuredModelGateway,
} from "../src/main/model/model-gateway.js";
import {
  ProfiledModelGateway,
} from "../src/main/model/profiled-model-gateway.js";
import {
  ModelProviderError,
} from "../src/main/model/http-model-transport.js";
import {
  QwenProviderError,
} from "../src/main/semantic/qwen-provider.js";
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

    now = new Date(now.getTime() + 30_001);
    await expect(gateway.classify(input)).resolves.toEqual(
      classification("qwen"),
    );
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
          : "qwen-local-model",
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
  });
  return { auditFingerprint, gateway, traceInputs };
};

describe("ProfiledModelGateway", () => {
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
