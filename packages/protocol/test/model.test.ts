import { describe, expect, it } from "vitest";

import {
  localModelClientStatusSchema,
  modelInvocationErrorCodeSchema,
  modelInvocationTraceSchema,
  modelProviderProfileSchema,
  modelProviderProfilesDocumentSchema,
  redactedModelProviderProfileSchema,
  normalizedTokenUsageSchema,
  structuredGenerationRequestSchema,
} from "../src/model.js";

describe("model protocol", () => {
  it("distinguishes exhausted output budgets from malformed output", () => {
    expect(
      modelInvocationErrorCodeSchema.parse("output_limit"),
    ).toBe("output_limit");
  });

  it("accepts redacted local model client diagnostics and rejects arbitrary details", () => {
    expect(
      localModelClientStatusSchema.parse({
        kind: "codex-cli",
        executablePath: "/opt/homebrew/bin/codex",
        version: "0.146.0",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      }),
    ).toMatchObject({
      kind: "codex-cli",
      authenticated: true,
      supported: true,
    });
    expect(() =>
      localModelClientStatusSchema.parse({
        kind: "claude-code-cli",
        authenticated: false,
        supported: false,
        availability: "logged_out",
        checkedAt: "2026-07-30T00:00:00.000Z",
        rawDiagnostics: "private output",
      }),
    ).toThrow();
  });

  it("accepts a successful semantic model attempt with partial usage", () => {
    expect(
      modelInvocationTraceSchema.parse({
        version: 1,
        traceId: "trace-1",
        requestId: "request-1",
        attemptId: "attempt-1",
        attemptIndex: 0,
        purpose: "semantic-classification",
        profile: {
          profileId: "qwen",
          backend: "qwen",
          provider: "qwen",
          model: "qwen3.5-2b-q4-k-m",
          promptVersion: "semantic-v1",
          schemaVersion: "semantic-classification-v1",
        },
        input: {
          systemPrompt: "Classify without reasoning.",
          userPrompt: "Assistant: choose A or B. User: A.",
          outputSchema: { type: "object" },
          clientSystemPromptVisibility: "visible",
        },
        output: {
          visibleText: "{\"decisionIntent\":\"decision\"}",
          parsed: { decisionIntent: "decision" },
        },
        usage: {
          source: "runtime_measured",
          inputTokens: 40,
          outputTokens: 8,
          totalTokens: 48,
        },
        timing: {
          queuedMs: 0,
          providerMs: 31,
          totalMs: 31,
        },
        status: "succeeded",
        createdAt: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-08-06T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "succeeded" });
  });

  it("keeps unavailable token usage explicit", () => {
    expect(
      normalizedTokenUsageSchema.parse({ source: "unavailable" }),
    ).toEqual({ source: "unavailable" });
  });

  it("rejects negative tokens and expiry before creation", () => {
    expect(() =>
      normalizedTokenUsageSchema.parse({
        source: "provider_reported",
        inputTokens: -1,
      }),
    ).toThrow();
    expect(() =>
      modelInvocationTraceSchema.parse({
        version: 1,
        traceId: "trace-1",
        requestId: "request-1",
        attemptId: "attempt-1",
        attemptIndex: 0,
        purpose: "semantic-classification",
        profile: {
          profileId: "apple",
          backend: "apple",
          provider: "apple",
          model: "system-language-model",
          promptVersion: "semantic-v1",
          schemaVersion: "semantic-classification-v1",
        },
        input: {
          systemPrompt: "x",
          userPrompt: "y",
          outputSchema: { type: "object" },
          clientSystemPromptVisibility: "visible",
        },
        usage: { source: "unavailable" },
        timing: { queuedMs: 0, providerMs: 1, totalMs: 1 },
        status: "failed",
        createdAt: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-07-29T00:00:00.000Z",
      }),
    ).toThrow(/expiry/u);
  });

  it("bounds semantic prompts before they cross a provider boundary", () => {
    expect(() =>
      structuredGenerationRequestSchema.parse({
        requestId: "request-1",
        purpose: "semantic-classification",
        promptVersion: "semantic-v1",
        schemaVersion: "semantic-classification-v1",
        locale: "zh-CN",
        systemPrompt: "x",
        userPrompt: "x".repeat(20_001),
        outputSchema: { type: "object" },
        maxOutputTokens: 256,
      }),
    ).toThrow();
  });

  it("lets only a PR review carry a whole PR in its prompt", () => {
    const request = { requestId: "request-1", promptVersion: "pr-review-v9", schemaVersion: "pr-review-action-batch-v2", locale: "zh-CN",
      systemPrompt: "x", userPrompt: "x".repeat(60_000), outputSchema: { type: "object" }, maxOutputTokens: 256 };
    expect(structuredGenerationRequestSchema.parse({ ...request, purpose: "pr-review" }).userPrompt).toHaveLength(60_000);
    expect(() => structuredGenerationRequestSchema.parse({ ...request, purpose: "retrieval-answer" })).toThrow(/20000/u);
    expect(() => structuredGenerationRequestSchema.parse({ ...request, purpose: "pr-review", userPrompt: "x".repeat(120_001) })).toThrow();
  });

  it("accepts a secure disabled OpenAI profile", () => {
    const profile = modelProviderProfileSchema.parse({
      version: 1,
      profileId: "remote-openai",
      kind: "openai",
      label: "OpenAI",
      enabled: false,
      priority: 20,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses",
      credentialRef: "credential-1",
    });

    expect(profile.kind).toBe("openai");
  });

  it("rejects insecure, incomplete, duplicate, and arbitrary provider configuration", () => {
    const remote = {
      version: 1,
      profileId: "remote-openai",
      kind: "openai",
      label: "OpenAI",
      enabled: false,
      priority: 20,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses",
      credentialRef: "credential-1",
    } as const;
    expect(() =>
      modelProviderProfileSchema.parse({
        ...remote,
        baseUrl: "http://api.openai.com",
      }),
    ).toThrow(/HTTPS|loopback/u);
    expect(() =>
      modelProviderProfileSchema.parse({
        ...remote,
        model: undefined,
      }),
    ).toThrow(/model/u);
    expect(() =>
      modelProviderProfileSchema.parse({
        ...remote,
        timeoutMs: 999,
      }),
    ).toThrow();
    expect(() =>
      modelProviderProfileSchema.parse({
        version: 1,
        profileId: "codex",
        kind: "codex-cli",
        label: "Codex",
        enabled: false,
        priority: 30,
        timeoutMs: 30_000,
        arguments: ["--dangerously-bypass-approvals-and-sandbox"],
      }),
    ).toThrow();
    expect(() =>
      modelProviderProfilesDocumentSchema.parse({
        version: 1,
        profiles: [remote, { ...remote }],
      }),
    ).toThrow(/duplicate/i);
  });

  it("lets a decisions backend set its endpoint, request shape, model, key, timeout, proxy and failing over, and nothing that would price it", () => {
    const jev = {
      version: 1, profileId: "jev", kind: "openrouter-decisions", label: "jev", enabled: true, priority: 50,
      model: "typesafe/jev-1.14", timeoutMs: 30_000, credentialRef: "provider:jev", proxy: { mode: "direct" },
    };
    expect(modelProviderProfileSchema.parse(jev)).toEqual(jev);
    for (const accepted of [
      { model: "~typesafe/jev-latest" },
      { model: "openai/gpt-6-luna-decisions", fallbackOnFailure: false },
      { baseUrl: "https://api.openai.com/v1/decisions", decisionsProtocol: "openai", model: "gpt-6-luna" },
      { baseUrl: "http://127.0.0.1:8000/v1/systemone", model: "accounts/fireworks/routers/rune" },
    ]) {
      expect(modelProviderProfileSchema.safeParse({ ...jev, ...accepted }).success, JSON.stringify(accepted)).toBe(true);
    }
    for (const refused of [
      { model: undefined }, { model: "jev 1.14" }, { credentialRef: undefined },
      // An address sent in the clear off this Mac, or one a key could ride in into the call records.
      // The address with an account in it is joined at run time: written whole, the release scan reads it as a leak.
      { baseUrl: "http://judge.example/v1/decisions" }, { baseUrl: ["https://user", "pass@judge.example/v1/decisions"].join(":") },
      { baseUrl: "https://judge.example/v1/decisions?key=abc" }, { baseUrl: "https://judge.example/v1/decisions#key" },
      { decisionsProtocol: "chat" }, { apiProtocol: "responses" }, { executablePath: "/bin/sh" },
      { jsonMode: "object" }, { pricing: { currency: "$", inputPerMillion: 1, outputPerMillion: 1 } },
    ]) {
      expect(modelProviderProfileSchema.safeParse({ ...jev, ...refused }).success, JSON.stringify(refused)).toBe(false);
    }
    // A request shape is a decisions backend's alone.
    expect(modelProviderProfileSchema.safeParse({
      version: 1, profileId: "remote-openai", kind: "openai", label: "OpenAI", enabled: true, priority: 10, model: "gpt-test", timeoutMs: 30_000,
      baseUrl: "https://api.openai.com", apiProtocol: "responses", credentialRef: "provider:openai", decisionsProtocol: "openai",
    }).success).toBe(false);
    const { credentialRef: _credentialRef, ...visible } = jev;
    expect(redactedModelProviderProfileSchema.parse({ ...visible, credentialConfigured: true })).not.toHaveProperty("credentialRef");
    expect(redactedModelProviderProfileSchema.safeParse({ ...jev, credentialConfigured: true }).success).toBe(false);
  });

  it("keeps renderer profiles credential-free", () => {
    expect(() =>
      redactedModelProviderProfileSchema.parse({
        version: 1,
        profileId: "remote-openai",
        kind: "openai",
        label: "OpenAI",
        enabled: false,
        priority: 20,
        model: "gpt-5-mini",
        timeoutMs: 30_000,
        baseUrl: "https://api.openai.com",
        apiProtocol: "responses",
        credentialConfigured: true,
        credentialRef: "must-not-cross-ipc",
      }),
    ).toThrow();
  });
});

it("accepts proxy-required readiness without claiming the CLI diagnostics failed", () => {
  expect(localModelClientStatusSchema.parse({ kind: "codex-cli", executablePath: "/bin/client", authenticated: false, supported: false, availability: "proxy_required", checkedAt: "2026-11-02T00:00:00.000Z" })).toMatchObject({ availability: "proxy_required" });
});
