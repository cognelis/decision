import type {
  ModelProviderProfile,
  ModelInvocationTrace,
  NormalizedTokenUsage,
  SemanticClassification,
  SemanticRecognitionStatus,
  StructuredGenerationRequest,
} from "@cognelis/decision-protocol";
import type {
  CapturedDecisionCandidate,
  CapturedDecisionEvent,
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
import { SemanticDecisionCoordinator } from "../src/main/semantic/semantic-coordinator.js";
import { semanticPairFixture } from "./fixtures.js";
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

// The rules alone answered: their own detector version, whichever it is now, with no model routing (`+semantic-…`) in it.
const RULES_ONLY = expect.stringMatching(/^rules-v\d+$/);

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
  if (kind === "openrouter-decisions") {
    return { ...common, model: "typesafe/jev-1.14", credentialRef: `${profileId}-key` };
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
  onDeviceClassificationOnly?: () => boolean;
  onDeviceModelMissing?: (profile: ModelProviderProfile) => Promise<boolean>;
}) => {
  const traceInputs: ModelTraceRecordInput[] = [];
  const auditInputs: unknown[] = [];
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
      record: vi.fn(async (value: unknown) => { auditInputs.push(value); return {}; }),
      summary: vi.fn(async () => emptySummary()),
    },
    now: () => new Date("2026-07-30T00:00:00.000Z"),
    idFactory: () => `profiled-id-${sequence++}`,
    ...(options.unattendedGenerationMs === undefined ? {} : { unattendedGenerationMs: options.unattendedGenerationMs }),
    ...(options.onDeviceClassificationOnly === undefined ? {} : { onDeviceClassificationOnly: options.onDeviceClassificationOnly }),
    ...(options.onDeviceModelMissing === undefined ? {} : { onDeviceModelMissing: options.onDeviceModelMissing }),
  });
  return { auditFingerprint, auditInputs, gateway, traceInputs };
};

// R12-DEF (synthetic): the default capture classifier asks this machine's Qwen 4B and nothing else (IMP-153).
describe("ProfiledModelGateway on this machine only", () => {
  const qwen4b = (enabled = true): ModelProviderProfile => ({ ...profiled("builtin-qwen", "qwen", 10, enabled), model: "qwen3.5-4b-q4-k-m" });
  // Everything else a reader could have on the chain, a remote one put before Qwen among them.
  const others = [profiled("builtin-apple", "apple", 0), profiled("remote-first", "openai", 1), profiled("builtin-codex", "codex-cli", 20), profiled("builtin-claude-code", "claude-code-cli", 30), profiled("remote-last", "anthropic", 40)];
  const chain = (qwenProfile: ModelProviderProfile | undefined, qwen: SemanticClassifier = profiledProvider("qwen"), modelMissing = false) => {
    const providers = new Map<string, SemanticClassifier>(others.map((profile) => [profile.profileId, profiledProvider(profile.kind)]));
    const factory = vi.fn((profile: ModelProviderProfile) => (profile.kind === "qwen" ? qwen : providers.get(profile.profileId)!));
    const onDeviceModelMissing = vi.fn(async () => modelMissing);
    const { auditInputs, gateway, traceInputs } = profiledGateway({
      load: async () => [...others, ...(qwenProfile === undefined ? [] : [qwenProfile])],
      factory,
      onDeviceClassificationOnly: () => true,
      onDeviceModelMissing,
    });
    const otherCalls = () => [...providers.values()].reduce((sum, provider) => sum + vi.mocked(provider.invoke).mock.calls.length + vi.mocked(provider.status).mock.calls.length, 0);
    return { auditInputs, gateway, factory, onDeviceModelMissing, otherCalls, traceInputs };
  };

  // As main/index.ts wires the coordinator on the default.
  const coordinated = (gateway: ProfiledModelGateway) => {
    const events: CapturedDecisionEvent[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const coordinator = new SemanticDecisionCoordinator({
      runtime: {
        ingest: vi.fn(async (event: CapturedDecisionEvent) => { events.push(event); }),
        ingestCandidate: vi.fn(async (candidate: CapturedDecisionCandidate) => { events.push(candidate.event); }),
      },
      audit: { record: vi.fn(async (value: Record<string, unknown>) => { audits.push(value); return {}; }) },
      classifier: gateway,
      modelEnabled: () => gateway.onDeviceClassifierInstalled(),
      now: () => new Date("2026-07-27T00:05:00.000Z"),
    });
    const turn = () => coordinator.process(semanticPairFixture({
      assistantText: "前者风险小，后者速度快。\n\n1. 前者\n2. 后者\n\n你希望选择哪一种？",
      userText: "1",
      capturedAt: "2026-07-27T00:04:00.000Z",
      expiresAt: "2026-08-03T00:04:00.000Z",
    }));
    return { audits, events, turn };
  };

  it("says the on-device classifier is there only for an enabled Qwen set to 4B with its model downloaded, probing no backend", async () => {
    const cases: Array<[ModelProviderProfile | undefined, boolean, boolean]> = [
      [qwen4b(), false, true],
      [qwen4b(), true, false],
      [profiled("builtin-qwen", "qwen", 10), false, false],
      [qwen4b(false), false, false],
      [undefined, false, false],
    ];
    for (const [qwenProfile, missing, installed] of cases) {
      const qwen = profiledProvider("qwen");
      const { gateway, factory, otherCalls } = chain(qwenProfile, qwen, missing);
      await expect(gateway.onDeviceClassifierInstalled()).resolves.toBe(installed);
      expect(factory).not.toHaveBeenCalled();
      expect(qwen.status).not.toHaveBeenCalled();
      expect(otherCalls()).toBe(0);
    }
  });

  it.each([
    ["not downloaded", qwen4b(), true],
    ["set to 2B", profiled("builtin-qwen", "qwen", 10), false],
    ["turned off", qwen4b(false), false],
  ] as const)("reads a turn as the rules alone do, with no trace and no failure, when Qwen 4B is %s", async (_case, qwenProfile, missing) => {
    const qwen = profiledProvider("qwen");
    const { auditInputs, gateway, factory, otherCalls, traceInputs } = chain(qwenProfile, qwen, missing);
    const { audits, events, turn } = coordinated(gateway);
    await turn();
    await turn();
    expect(events.map((event) => event.detection?.detectorVersion)).toEqual([RULES_ONLY, RULES_ONLY]);
    expect(events.map((event) => event.detection?.band)).toEqual(["high", "high"]);
    expect(audits.filter((audit) => audit.stage === "failed")).toEqual([]);
    expect(traceInputs).toEqual([]);
    expect(auditInputs).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
    expect(qwen.invoke).not.toHaveBeenCalled();
    expect(otherCalls()).toBe(0);
  });

  it.each([
    ["times out", () => profiledProvider("qwen", vi.fn(async () => { throw new QwenProviderError("timeout", "Qwen inference timed out"); })), "classification_timeout"],
    ["fails", () => profiledProvider("qwen", vi.fn(async () => { throw new QwenProviderError("runtime_unavailable", "helper crashed"); })), "provider_unavailable"],
    ["has its process down", () => provider("qwen", "runtime_unavailable", vi.fn()), "provider_unavailable"],
  ] as const)("still files it when a downloaded Qwen 4B %s, asking no other backend", async (_case, qwen, errorCode) => {
    const { gateway, otherCalls, traceInputs } = chain(qwen4b(), qwen());
    const { audits, events, turn } = coordinated(gateway);
    await turn();
    expect(audits.filter((audit) => audit.stage === "failed")).toEqual([expect.objectContaining({ errorCode })]);
    expect(traceInputs.map((trace) => trace.profile.profileId)).toEqual(["builtin-qwen"]);
    expect(events.map((event) => event.detection?.detectorVersion)).toEqual([RULES_ONLY]);
    expect(otherCalls()).toBe(0);
  });

  it("classifies on Qwen 4B without building any other backend", async () => {
    const { gateway, factory, otherCalls, traceInputs } = chain(qwen4b());
    await expect(gateway.classify(input)).resolves.toMatchObject({ provider: "qwen" });
    expect(factory.mock.calls.map(([profile]) => profile.profileId)).toEqual(["builtin-qwen"]);
    expect(otherCalls()).toBe(0);
    expect(traceInputs.map((trace) => trace.profile.profileId)).toEqual(["builtin-qwen"]);
  });

  it.each([
    ["not installed", () => provider("qwen", "model_missing", vi.fn()), "provider_unavailable"],
    ["timed out", () => profiledProvider("qwen", vi.fn(async () => { throw new QwenProviderError("timeout", "Qwen inference timed out"); })), "timeout"],
    ["failing", () => profiledProvider("qwen", vi.fn(async () => { throw new QwenProviderError("runtime_unavailable", "helper crashed"); })), "provider_unavailable"],
    ["unable to check its file", () => { const qwen = profiledProvider("qwen"); vi.mocked(qwen.status).mockRejectedValue(new Error("process gone")); return qwen; }, "provider_unavailable"],
  ] as const)("ends with no reading and calls no other backend when Qwen 4B is %s", async (_case, qwen, failureCode) => {
    const { gateway, factory, otherCalls } = chain(qwen4b(), qwen());
    await expect(gateway.classify(input)).rejects.toMatchObject({ code: "provider_unavailable", failureCode });
    expect(factory.mock.calls.map(([profile]) => profile.profileId)).toEqual(["builtin-qwen"]);
    expect(otherCalls()).toBe(0);
  });

  it.each([
    ["set to 2B", profiled("builtin-qwen", "qwen", 10)],
    ["turned off", qwen4b(false)],
    ["not there at all", undefined],
  ] as const)("asks no backend at all when Qwen is %s", async (_case, qwenProfile) => {
    const qwen = profiledProvider("qwen");
    const { gateway, factory, otherCalls } = chain(qwenProfile, qwen);
    await expect(gateway.classify(input)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(factory).not.toHaveBeenCalled();
    expect(qwen.invoke).not.toHaveBeenCalled();
    expect(otherCalls()).toBe(0);
  });

  it("names Qwen 4B as the engine, or the rules, without probing any other backend", async () => {
    const ready = chain(qwen4b());
    await expect(ready.gateway.status()).resolves.toMatchObject({ provider: "qwen", mode: "hybrid" });
    const twoB = chain(profiled("builtin-qwen", "qwen", 10));
    await expect(twoB.gateway.status()).resolves.toMatchObject({ provider: "rules", mode: "rules_only", unavailableModels: [] });
    expect(ready.otherCalls() + twoB.otherCalls()).toBe(0);
    expect(twoB.factory).not.toHaveBeenCalled();
  });

  it("leaves the rules to answer a turn Qwen 4B could not, with no other backend asked", async () => {
    for (const failing of [
      () => provider("qwen", "model_missing", vi.fn()),
      () => profiledProvider("qwen", vi.fn(async () => { throw new QwenProviderError("timeout", "Qwen inference timed out"); })),
    ]) {
      const { gateway, otherCalls } = chain(qwen4b(), failing());
      const events: CapturedDecisionEvent[] = [];
      const coordinator = new SemanticDecisionCoordinator({
        runtime: {
          ingest: vi.fn(async (event: CapturedDecisionEvent) => { events.push(event); }),
          ingestCandidate: vi.fn(async (candidate: CapturedDecisionCandidate) => { events.push(candidate.event); }),
        },
        audit: { record: vi.fn(async () => ({})) },
        classifier: gateway,
        modelEnabled: () => true,
        now: () => new Date("2026-07-27T00:05:00.000Z"),
      });
      await coordinator.process(semanticPairFixture({
        assistantText: "前者风险小，后者速度快。\n\n1. 前者\n2. 后者\n\n你希望选择哪一种？",
        userText: "1",
        capturedAt: "2026-07-27T00:04:00.000Z",
        expiresAt: "2026-08-03T00:04:00.000Z",
      }));
      expect(events.map((event) => event.detection?.detectorVersion)).toEqual([RULES_ONLY]);
      expect(otherCalls()).toBe(0);
    }
  });

  it("goes down the whole chain again when the reader picks 规则加模型", async () => {
    let onDevice = true;
    const providers = new Map(others.map((profile) => [profile.profileId, profiledProvider(profile.kind)]));
    const { gateway } = profiledGateway({
      load: async () => [...others, qwen4b()],
      factory: (profile) => (profile.kind === "qwen" ? profiledProvider("qwen") : providers.get(profile.profileId)!),
      onDeviceClassificationOnly: () => onDevice,
    });
    await expect(gateway.classify(input)).resolves.toMatchObject({ provider: "qwen" });
    onDevice = false;
    await expect(gateway.classify(input)).resolves.toMatchObject({ provider: "apple" });
  });
});

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

  it("gives a record's context to no API or CLI backend, even one put first or named, only to one on this machine", async () => {
    const summaryRequest: StructuredGenerationRequest = { ...draftRequest, requestId: "summary-request", purpose: "context-summary" };
    const providers = {
      openai: Object.assign(profiledProvider("openai"), { generate: vi.fn(async (request: StructuredGenerationRequest) => drafted(request)) }),
      "claude-code-cli": Object.assign(profiledProvider("claude-code-cli"), { generate: vi.fn(async (request: StructuredGenerationRequest) => drafted(request)) }),
      qwen: Object.assign(profiledProvider("qwen"), { generate: vi.fn(async (request: StructuredGenerationRequest) => drafted(request)) }),
    };
    const factory = vi.fn((profile: ModelProviderProfile) => providers[profile.kind as keyof typeof providers]);
    const { gateway, traceInputs } = profiledGateway({
      load: async () => [profiled("remote-first", "openai", 0), profiled("cli-second", "claude-code-cli", 1), profiled("qwen-last", "qwen", 10)],
      factory,
    });

    await expect(gateway.generate(summaryRequest, (value) => value)).resolves.toMatchObject({ profileId: "qwen-last" });
    await expect(gateway.generate(summaryRequest, (value) => value, undefined, "remote-first")).rejects.toMatchObject({ failureCode: "provider_unavailable" });
    expect(providers.openai.generate).not.toHaveBeenCalled();
    expect(providers["claude-code-cli"].generate).not.toHaveBeenCalled();
    expect(factory.mock.calls.map(([profile]) => profile.kind)).toEqual(["qwen"]);
    expect(traceInputs.map((trace) => [trace.purpose, trace.profile.profileId, trace.status])).toEqual([["context-summary", "qwen-last", "succeeded"]]);
    // Any other purpose still goes to the backend put first.
    await expect(gateway.generate(draftRequest, (value) => value)).resolves.toMatchObject({ profileId: "remote-first" });
  });

  it("ends a chain with what went wrong on the backend that tried, not the skip of one after it that cannot generate", async () => {
    const failing = (fail: (provider: SemanticClassifier & { generate: ReturnType<typeof vi.fn> }) => void) => {
      const qwen = Object.assign(profiledProvider("qwen"), { generate: vi.fn(async (request: StructuredGenerationRequest) => drafted(request)) });
      fail(qwen);
      // Qwen put before Apple, which stays enabled for capture and is passed over here.
      const { gateway } = profiledGateway({ load: async () => [profiled("qwen-first", "qwen", 0), profiled("apple-after", "apple", 10)], factory: (profile) => profile.kind === "apple" ? profiledProvider("apple") : qwen });
      return gateway.generate(draftRequest, (value) => value);
    };
    await expect(failing((qwen) => vi.mocked(qwen.status).mockResolvedValue({ id: "qwen", availability: "model_missing", promptVersion: "semantic-v1" })))
      .rejects.toMatchObject({ failureCode: "provider_unavailable" });
    await expect(failing((qwen) => qwen.generate.mockRejectedValue(new QwenProviderError("timeout", "Qwen inference timed out"))))
      .rejects.toMatchObject({ failureCode: "timeout" });
    // Refused for its shape, the answer goes with its failure: the reader can see what it said.
    await expect(failing((qwen) => qwen.generate.mockRejectedValue(new ModelProviderError("invalid_output", "Model output failed validation", { visibleOutput: "{\"title\":" }))))
      .rejects.toMatchObject({ failureCode: "invalid_output", output: "{\"title\":" });
    // With nothing that could generate, that is the failure.
    const { gateway } = profiledGateway({ load: async () => [profiled("apple-only", "apple", 0)], factory: () => profiledProvider("apple") });
    await expect(gateway.generate(draftRequest, (value) => value)).rejects.toMatchObject({ failureCode: "unsupported_client" });
  });

  it("ends a context summary with no backend on this machine enabled without calling the remote one there is", async () => {
    const remote = Object.assign(profiledProvider("openai"), { generate: vi.fn(async (request: StructuredGenerationRequest) => drafted(request)) });
    const factory = vi.fn(() => remote);
    const { gateway, traceInputs } = profiledGateway({ load: async () => [profiled("remote-only", "openai", 0)], factory });

    await expect(gateway.generate({ ...draftRequest, purpose: "context-summary" }, (value) => value)).rejects.toMatchObject({ failureCode: "provider_unavailable" });
    expect(factory).not.toHaveBeenCalled();
    expect(remote.generate).not.toHaveBeenCalled();
    expect(traceInputs).toEqual([]);
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

  it("files a draft its own bound cut short as timed out, while its backend was checked or called", async () => {
    // Nobody stopped it: it was filed as 已取消 while the caller was told 超时, and cut off during the check, not at all.
    const stuckCheck = Object.assign(profiledProvider("qwen"), { queuesCalls: true, status: vi.fn(() => new Promise<never>(() => undefined)), generate: vi.fn() });
    const stuckCall = Object.assign(profiledProvider("openai"), { generate: vi.fn(() => new Promise<never>(() => undefined)) });
    for (const [kind, stuck] of [["qwen", stuckCheck], ["openai", stuckCall]] as const) {
      const { gateway, traceInputs } = profiledGateway({ load: async () => [profiled("only", kind, 0)], factory: () => stuck, unattendedGenerationMs: 50 });

      await expect(gateway.generate(draftRequest, (value) => value)).rejects.toMatchObject({ failureCode: "timeout" });
      expect(traceInputs).toEqual([expect.objectContaining({ status: "timed_out", errorCode: "timeout" })]);
    }
  });

  it("files a call its caller's deadline cut short as timed out and one the reader stopped as cancelled, falling back from neither", async () => {
    // The capture's overall budget aborts with a TimeoutError: the app's own deadline, not a stop.
    const deadline = () => new DOMException("Semantic classification timed out", "TimeoutError");
    for (const [stage, reason, status] of [
      ["call", deadline(), "timed_out"],
      ["check", deadline(), "timed_out"],
      ["call", undefined, "cancelled"],
    ] as const) {
      const controller = new AbortController();
      const hang = vi.fn(() => new Promise<never>(() => undefined));
      const first = profiledProvider("qwen", stage === "call" ? hang : undefined);
      if (stage === "check") Object.assign(first, { queuesCalls: true, status: hang });
      const { gateway, traceInputs } = profiledGateway({
        load: async () => [profiled("first", "qwen", 0), profiled("second", "openai", 1)],
        factory: (profile) => (profile.kind === "qwen" ? first : profiledProvider("openai")),
      });

      const pending = gateway.classify(input, controller.signal);
      await vi.waitFor(() => expect(hang).toHaveBeenCalledOnce());
      controller.abort(reason);

      await expect(pending).rejects.toBeInstanceOf(Error);
      expect(traceInputs).toEqual([expect.objectContaining({ attemptIndex: 0, status, errorCode: status === "timed_out" ? "timeout" : "cancelled" })]);
    }
  });

  it("files how long its backend was checked when a deadline ends the check", async () => {
    // Filed as taking 0 ms, a check the capture's budget cut off read 超时 · 0 ms and pulled the average down.
    let clock = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      for (const call of ["classify", "generate"] as const) {
        const controller = new AbortController();
        const hang = vi.fn(() => new Promise<never>(() => undefined));
        const stuck = Object.assign(profiledProvider("qwen"), { queuesCalls: true, status: hang, generate: vi.fn() });
        const { gateway, traceInputs } = profiledGateway({ load: async () => [profiled("first", "qwen", 0)], factory: () => stuck });

        const pending = call === "classify"
          ? gateway.classify(input, controller.signal)
          : gateway.generate(draftRequest, (value) => value, controller.signal);
        await vi.waitFor(() => expect(hang).toHaveBeenCalledOnce());
        clock += 30_000;
        controller.abort(new DOMException("Semantic classification timed out", "TimeoutError"));

        await expect(pending).rejects.toBeInstanceOf(Error);
        expect(traceInputs).toEqual([expect.objectContaining({ status: "timed_out", timing: expect.objectContaining({ providerMs: 30_000, totalMs: 30_000 }) })]);
      }
    } finally {
      now.mockRestore();
    }
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
  it("ends a chain whose backend ran out of time as a timeout, and one with nothing ready as unavailable", async () => {
    vi.useFakeTimers();
    try {
      const slow = { ...profiled("slow", "openai", 0), timeoutMs: 1000 };
      const { gateway } = profiledGateway({ load: async () => [slow], factory: () => profiledProvider("openai", async () => new Promise(() => undefined)) });
      const pending = gateway.classify(input);
      const ended = expect(pending).rejects.toMatchObject({ code: "provider_unavailable", failureCode: "timeout" });
      await vi.advanceTimersByTimeAsync(1001);
      await ended;
    } finally { vi.useRealTimers(); }
    const { gateway } = profiledGateway({ load: async () => [profiled("local", "qwen", 0)], factory: () => provider("qwen", "model_missing", vi.fn()) });
    await expect(gateway.classify(input)).rejects.toMatchObject({ code: "provider_unavailable", failureCode: "provider_unavailable" });
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

// R15-JEVSET: a decisions backend (jev) writes no text; no generation route may reach it, however it is set (IMP-166).
describe("ProfiledModelGateway never routes to a decisions backend", () => {
  const jev = profiled("jev-first", "openrouter-decisions", 0);
  const generation = (purpose: StructuredGenerationRequest["purpose"]): StructuredGenerationRequest => ({
    requestId: `request-${purpose}`, purpose, promptVersion: "test", schemaVersion: "test", locale: "zh-CN",
    systemPrompt: "JSON", userPrompt: "test", outputSchema: { type: "object" }, maxOutputTokens: 100,
  });
  const setupWith = (profiles: ModelProviderProfile[], onDevice = false) => {
    const generate = vi.fn(async (request: StructuredGenerationRequest) => ({
      parsedOutput: {}, visibleOutput: "{}", usage: { source: "runtime_measured" as const }, providerDurationMs: 1,
      traceInput: { systemPrompt: request.systemPrompt, userPrompt: request.userPrompt, outputSchema: request.outputSchema, clientSystemPromptVisibility: "visible" as const },
    }));
    const factory = vi.fn((profile: ModelProviderProfile) => Object.assign(profiledProvider(profile.kind), { generate }));
    const { gateway } = profiledGateway({ load: async () => profiles, factory, onDeviceClassificationOnly: () => onDevice });
    return { gateway, factory };
  };

  it("leaves it out of the classification chain under 规则加模型, and leaves the rules alone when it is the only one", async () => {
    const withQwen = setupWith([jev, { ...profiled("qwen-later", "qwen", 10), model: "qwen3.5-4b-q4-k-m" }]);
    await expect(withQwen.gateway.classify(input)).resolves.toMatchObject({ provider: "qwen" });
    expect(withQwen.factory.mock.calls.map(([profile]) => profile.kind)).toEqual(["qwen"]);
    const alone = setupWith([jev]);
    await expect(alone.gateway.classify(input)).rejects.toThrow();
    await expect(alone.gateway.status()).resolves.toMatchObject({ mode: "rules_only" });
    expect(alone.factory).not.toHaveBeenCalled();
  });

  it("never picks it for any generation purpose, put first or named", async () => {
    const { gateway, factory } = setupWith([jev, profiled("qwen-later", "qwen", 10)]);
    for (const purpose of ["methodology-extraction", "skill-drafting", "workflow-drafting", "retrieval-answer", "pr-review", "pr-comment-recognition", "context-summary"] as const) {
      await expect(gateway.generate(generation(purpose), (value) => value)).resolves.toMatchObject({ profileId: "qwen-later" });
      await expect(gateway.generate(generation(purpose), (value) => value, undefined, "jev-first")).rejects.toThrow("not enabled");
    }
    await expect(gateway.generate(generation("structured-judgment"), (value) => value)).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(factory.mock.calls.every(([profile]) => profile.kind === "qwen")).toBe(true);
  });

  it("is not among the backends PR review, answers and summaries choose from, on either capture setting", async () => {
    for (const onDevice of [false, true]) {
      const { gateway } = setupWith([jev, profiled("remote", "openai", 10)], onDevice);
      expect((await gateway.listGenerationProfiles()).map((profile) => profile.profileId)).toEqual(["remote"]);
    }
  });

  it("will not build a generation provider for it from the test path either", async () => {
    const { gateway, factory } = setupWith([jev]);
    await expect(gateway.testProfile("jev-first")).resolves.toMatchObject({ ok: false, errorCode: "invalid_configuration" });
    expect(factory).not.toHaveBeenCalled();
  });
});
