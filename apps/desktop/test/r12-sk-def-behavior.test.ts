import type {
  CaptureAuditRecordInput,
  CaptureAuditSummary,
  ModelTraceRecordInput,
} from "@cognelis/decision-storage";
import type {
  ModelInvocationTrace,
  ModelProviderProfile,
  SemanticClassification,
} from "@cognelis/decision-protocol";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfiledModelGateway } from "../src/main/model/profiled-model-gateway.js";
import { SettingsRepository, withCaptureClassifier } from "../src/main/settings.js";
import { SemanticDecisionCoordinator } from "../src/main/semantic/semantic-coordinator.js";
import { qwenModelMissing, QWEN_4B_MODEL_MANIFEST, QWEN_MODEL_MANIFEST } from "../src/main/semantic/model-manifest.js";
import { QwenProviderError } from "../src/main/semantic/qwen-provider.js";
import type { SemanticClassifier, SemanticProviderAttempt } from "../src/main/semantic/semantic-classifier.js";
import { semanticPairFixture } from "./fixtures.js";

const QWEN_4B = "qwen3.5-4b-q4-k-m";
const QWEN_2B = "qwen3.5-2b-q4-k-m";
const temporaryDirectories: string[] = [];

const tempDirectory = async () => {
  const path = await mkdtemp(join(tmpdir(), "r12-sk-def-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const profile = (
  profileId: string,
  kind: ModelProviderProfile["kind"],
  priority: number,
  enabled = true,
  model = kind === "qwen" ? QWEN_4B : kind,
): ModelProviderProfile => ({
  version: 1,
  profileId,
  kind,
  label: profileId,
  enabled,
  priority,
  timeoutMs: 15_000,
  fallbackOnFailure: true,
  ...(kind === "qwen" ? { model } : {}),
  ...(kind === "openai" ? { model: "gpt-6", baseUrl: "https://example.invalid", apiProtocol: "responses" as const, credentialRef: profileId } : {}),
  ...(kind === "anthropic" ? { model: "claude-sonnet", baseUrl: "https://example.invalid", apiProtocol: "messages" as const, credentialRef: profileId } : {}),
  ...(kind === "codex-cli" || kind === "claude-code-cli" ? { model, executablePath: "/usr/bin/false" } : {}),
} as unknown as ModelProviderProfile);

const profilesForDefault = (qwenProfiles: ModelProviderProfile[]) => [
  profile("remote-first", "openai", -10),
  profile("cli-next", "codex-cli", -5),
  profile("local-apple", "apple", 0),
  ...qwenProfiles,
  profile("remote-last", "anthropic", 50),
  profile("compatible-last", "openai-compatible", 60),
  profile("claude-cli-last", "claude-code-cli", 70),
];

const modelResult = (profile: ModelProviderProfile): SemanticProviderAttempt => ({
  classification: {
    decisionIntent: "decision",
    answerRelation: "answers",
    question: "你希望选择哪一种？",
    optionLabels: ["前者", "后者"],
    answerExcerpt: "1",
    confidence: 0.95,
    provider: profile.kind,
    modelVersion: `${profile.profileId}-model`,
    promptVersion: "semantic-v1",
  } as SemanticClassification,
  visibleOutput: JSON.stringify({ decisionIntent: "decision", answerRelation: "answers" }),
  traceInput: {
    systemPrompt: "Classify the captured decision.",
    userPrompt: "Assistant offered two choices; user selected the first.",
    outputSchema: { type: "object" },
    clientSystemPromptVisibility: "visible",
  },
  usage: { source: "unavailable" },
  providerDurationMs: 8,
  providerRequestId: `${profile.profileId}-request`,
});

type TrackedProvider = SemanticClassifier & { counters: { status: number; invoke: number } };

const providerFor = (profileValue: ModelProviderProfile, failure?: Error): TrackedProvider => {
  const counters = { status: 0, invoke: 0 };
  const invoke: SemanticClassifier["invoke"] = async () => {
    counters.invoke += 1;
    if (failure !== undefined) throw failure;
    return modelResult(profileValue);
  };
  const status: SemanticClassifier["status"] = async () => {
    counters.status += 1;
    return {
      id: profileValue.kind,
      availability: "available",
      modelVersion: `${profileValue.profileId}-model`,
      promptVersion: "semantic-v1",
    };
  };
  const provider: SemanticClassifier = {
    id: profileValue.kind,
    status,
    invoke,
    classify: async (input, signal) => (await invoke(input, signal)).classification,
    close: async () => undefined,
  };
  return Object.assign(provider, { counters });
};

const emptyAuditSummary = (): CaptureAuditSummary => ({
  total: 0, processed: 0, high: 0, medium: 0, failures: 0, stages: {}, errorCodes: {},
});

const createHarness = async (options: {
  qwenProfiles: ModelProviderProfile[];
  installed4B?: boolean;
  failures?: Record<string, Error>;
}) => {
  const modelsDirectory = await tempDirectory();
  if (options.installed4B) {
    await writeFile(join(modelsDirectory, QWEN_4B_MODEL_MANIFEST.fileName), "test model placeholder");
  }
  const profiles = profilesForDefault(options.qwenProfiles);
  const providers = new Map(profiles.map((item) => [item.profileId, providerFor(item, options.failures?.[item.profileId])]));
  const factoryCalls: string[] = [];
  const factory = (item: ModelProviderProfile) => {
    factoryCalls.push(item.profileId);
    return providers.get(item.profileId)!;
  };
  const modelAudit: CaptureAuditRecordInput[] = [];
  const modelTraces: ModelTraceRecordInput[] = [];
  const gateway = new ProfiledModelGateway({
    profiles: { load: async () => profiles },
    providerFactory: factory,
    onDeviceClassificationOnly: () => true,
    onDeviceModelMissing: (item) => qwenModelMissing(modelsDirectory, item.model ?? ""),
    traces: {
      record: vi.fn(async (input) => {
        modelTraces.push(input);
        return { ...input, version: 1, traceId: `trace-${modelTraces.length}`, contentMode: "full", createdAt: "2026-10-26T00:00:00.000Z", expiresAt: "2026-11-02T00:00:00.000Z" } as ModelInvocationTrace;
      }),
    },
    audit: {
      fingerprint: vi.fn(async () => "a".repeat(64)),
      record: vi.fn(async (input) => { modelAudit.push(input); return {}; }),
      summary: vi.fn(async () => emptyAuditSummary()),
    },
  });
  const coordinatorAudit: Array<Record<string, unknown>> = [];
  const events: Array<{ detection?: { detectorVersion?: string; band?: string }; questions?: Array<{ answer?: { kind?: string; values?: string[] } }> }> = [];
  const coordinator = new SemanticDecisionCoordinator({
    runtime: {
      ingest: vi.fn(async (event) => { events.push(event); }),
      ingestCandidate: vi.fn(async (candidate) => { events.push(candidate.event); }),
    },
    audit: { record: vi.fn(async (input) => { coordinatorAudit.push(input); return {}; }) },
    classifier: gateway,
    modelEnabled: () => gateway.onDeviceClassifierInstalled(),
    now: () => new Date("2026-10-26T00:00:00.000Z"),
  });
  const pair = () => semanticPairFixture({
    assistantText: "前者风险小，后者速度快。\n\n1. 前者\n2. 后者\n\n你希望选择哪一种？",
    userText: "1",
    capturedAt: "2026-10-26T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
  });
  const processTurn = () => coordinator.process(pair());
  const calls = (kind: ModelProviderProfile["kind"]) => profiles
    .filter((item) => item.kind === kind)
    .reduce((sum, item) => sum + providers.get(item.profileId)!.counters.status + providers.get(item.profileId)!.counters.invoke, 0);
  const externalCalls = () => ["openai", "anthropic", "openai-compatible", "codex-cli", "claude-code-cli"]
    .reduce((sum, kind) => sum + calls(kind as ModelProviderProfile["kind"]), 0);
  const nonQwenCalls = () => profiles
    .filter((item) => item.kind !== "qwen")
    .reduce((sum, item) => sum + providers.get(item.profileId)!.counters.status + providers.get(item.profileId)!.counters.invoke, 0);
  return { calls, coordinator, coordinatorAudit, events, externalCalls, factoryCalls, gateway, modelAudit, modelTraces, modelsDirectory, nonQwenCalls, processTurn, profiles, providers };
};

const expectRulesAnswer = async (events: Awaited<ReturnType<typeof createHarness>>["events"]) => {
  const expected: Awaited<ReturnType<typeof createHarness>>["events"] = [];
  const rulesOnly = new SemanticDecisionCoordinator({
    runtime: {
      ingest: vi.fn(async (event) => { expected.push(event); }),
      ingestCandidate: vi.fn(async (candidate) => { expected.push(candidate.event); }),
    },
    audit: { record: vi.fn(async () => ({})) },
    modelEnabled: () => false,
    now: () => new Date("2026-10-26T00:00:00.000Z"),
  });
  await rulesOnly.process(semanticPairFixture({
    assistantText: "前者风险小，后者速度快。\n\n1. 前者\n2. 后者\n\n你希望选择哪一种？",
    userText: "1",
    capturedAt: "2026-10-26T00:00:00.000Z",
    expiresAt: "2026-11-02T00:00:00.000Z",
  }));
  expect(events).toHaveLength(1);
  expect(events[0]?.questions).toEqual(expected[0]?.questions);
};

describe("R12-DEF independent behavior probes on the final default-local interface", () => {
  it("uses only the local Qwen 4B on a normal captured turn", async () => {
    const harness = await createHarness({ qwenProfiles: [profile("builtin-qwen", "qwen", 10)], installed4B: true });
    await harness.processTurn();
    await expectRulesAnswer(harness.events);
    expect(harness.calls("qwen")).toBe(2); // local status + one inference
    expect(harness.externalCalls()).toBe(0);
    expect(harness.nonQwenCalls()).toBe(0);
    expect(harness.modelAudit.filter((item) => item.stage === "failed")).toEqual([]);
  });

  it("uses the rules and writes no failure audit when the 4B file is missing", async () => {
    const harness = await createHarness({ qwenProfiles: [profile("builtin-qwen", "qwen", 10)], installed4B: false });
    expect(await qwenModelMissing(harness.modelsDirectory, QWEN_4B)).toBe(true);
    await harness.processTurn();
    await expectRulesAnswer(harness.events);
    expect(harness.factoryCalls).toEqual([]);
    expect(harness.modelAudit.filter((item) => item.stage === "failed")).toEqual([]);
    expect(harness.coordinatorAudit.filter((item) => item.stage === "failed")).toEqual([]);
    expect(harness.externalCalls()).toBe(0);
  });

  it("ignores an installed 2B-only profile, uses rules, and writes no failure audit", async () => {
    const harness = await createHarness({ qwenProfiles: [profile("builtin-qwen-2b", "qwen", 10, true, QWEN_2B)] });
    await writeFile(join(harness.modelsDirectory, QWEN_MODEL_MANIFEST.fileName), "test 2B placeholder");
    await harness.processTurn();
    await expectRulesAnswer(harness.events);
    expect(harness.factoryCalls).toEqual([]);
    expect(harness.modelAudit.filter((item) => item.stage === "failed")).toEqual([]);
    expect(harness.coordinatorAudit.filter((item) => item.stage === "failed")).toEqual([]);
    expect(harness.externalCalls()).toBe(0);
  });

  it("uses rules without a failure audit when the 4B Qwen profile is disabled", async () => {
    const harness = await createHarness({ qwenProfiles: [profile("builtin-qwen", "qwen", 10, false)], installed4B: true });
    await harness.processTurn();
    await expectRulesAnswer(harness.events);
    expect(harness.factoryCalls).toEqual([]);
    expect(harness.modelAudit.filter((item) => item.stage === "failed")).toEqual([]);
    expect(harness.coordinatorAudit.filter((item) => item.stage === "failed")).toEqual([]);
    expect(harness.externalCalls()).toBe(0);
  });

  it.each([
    ["timeout", new QwenProviderError("timeout", "Qwen inference timed out")],
    ["error", new Error("Qwen inference failed")],
    ["utility process killed", new QwenProviderError("runtime_unavailable", "Qwen utility process exited after SIGKILL")],
  ])("returns the rules answer and never falls through to remote/CLI after a local %s", async (_name, failure) => {
    const harness = await createHarness({
      qwenProfiles: [profile("builtin-qwen", "qwen", 10)],
      installed4B: true,
      failures: { "builtin-qwen": failure },
    });
    await harness.processTurn();
    await expectRulesAnswer(harness.events);
    expect(harness.calls("qwen")).toBe(2);
    expect(harness.externalCalls()).toBe(0);
    expect(harness.nonQwenCalls()).toBe(0);
    expect(harness.coordinatorAudit.filter((item) => item.stage === "failed")).toHaveLength(1);
  });

  it("keeps a remote-first profile order from changing the default local-only route", async () => {
    const harness = await createHarness({ qwenProfiles: [profile("builtin-qwen", "qwen", 10)], installed4B: true });
    await harness.processTurn();
    await expectRulesAnswer(harness.events);
    expect(harness.factoryCalls).toEqual(["builtin-qwen"]);
    expect(harness.externalCalls()).toBe(0);
    expect(harness.nonQwenCalls()).toBe(0);
  });

  it("does not fall through to a user-created second Qwen profile after the selected 4B fails", async () => {
    const harness = await createHarness({
      qwenProfiles: [profile("builtin-qwen", "qwen", 10), profile("custom-qwen", "qwen", 20)],
      installed4B: true,
      failures: { "builtin-qwen": new QwenProviderError("runtime_unavailable", "local utility exited") },
    });
    await harness.processTurn();
    await expectRulesAnswer(harness.events);
    expect(harness.calls("qwen")).toBe(2);
    expect(harness.providers.get("custom-qwen")?.counters.status).toBe(0);
    expect(harness.externalCalls()).toBe(0);
    expect(harness.nonQwenCalls()).toBe(0);
  });

  it("keeps the model card and semantic refresh on the filtered local route", async () => {
    const harness = await createHarness({ qwenProfiles: [profile("builtin-qwen", "qwen", 10)], installed4B: true });
    await expect(harness.gateway.onDeviceClassifierInstalled()).resolves.toBe(true);
    await expect(harness.gateway.status()).resolves.toMatchObject({ provider: "qwen", mode: "hybrid" });
    harness.gateway.refresh();
    await expect(harness.gateway.status()).resolves.toMatchObject({ provider: "qwen", mode: "hybrid" });
    expect(harness.externalCalls()).toBe(0);
    expect(harness.nonQwenCalls()).toBe(0);
  });

  it("migrates the old rules default once, then preserves an explicit rules selection", async () => {
    const directory = await tempDirectory();
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ version: 3, vaultPath: "/vault", theme: "auto", modelTraceContentEnabled: true, captureClassifier: "rules" }));
    const first = new SettingsRepository(settingsPath);
    const moved = await first.moveCaptureClassifier(await first.load());
    expect(moved).toMatchObject({ captureClassifier: "local" });
    expect(first.captureClassifierMoveFailed).toBeNull();
    await expect(readFile(join(directory, "settings-migrations.json"), "utf8")).resolves.toContain('"captureClassifier": "decided"');

    const second = new SettingsRepository(settingsPath);
    await expect(second.moveCaptureClassifier(await second.load())).resolves.toMatchObject({ captureClassifier: "local" });
    expect(second.captureClassifierMoveFailed).toBeNull();
    await second.recordCaptureClassifierDecided();
    await second.save(withCaptureClassifier(await second.load(), "rules"));

    const afterChoice = new SettingsRepository(settingsPath);
    for (let start = 0; start < 2; start += 1) {
      await expect(afterChoice.moveCaptureClassifier(await afterChoice.load())).resolves.toMatchObject({ captureClassifier: "rules" });
      expect(afterChoice.captureClassifierMoveFailed).toBeNull();
    }
  });
});
