import type { ModelProviderProfile } from "@cognelis/decision-protocol";
import { ModelTraceStore } from "@cognelis/decision-storage";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { combinedTraces, createDecisionCallStore, DECISION_CALLS_MAXIMUM_AGE_MS, DECISION_CALLS_MAXIMUM_ITEMS } from "../src/main/model/decision-call-log.js";
import { writeFile } from "node:fs/promises";
import { ModelProviderError, type HttpModelRequest } from "../src/main/model/http-model-transport.js";
import { OPENROUTER_DECISIONS_URL } from "@cognelis/decision-protocol";
import { DECISION_RECORDED_INPUT_CHARS, DECISIONS_HEALTH_CHECK, OpenRouterDecisionClient } from "../src/main/model/openrouter-decision-client.js";

const SECRET = "or-key-SYNTHETIC-SECRET";
const feature = { feature: "r15-test", correlationId: "turn-7" };

const jev = (overrides: Partial<ModelProviderProfile> = {}): ModelProviderProfile => ({
  version: 1, profileId: "jev", kind: "openrouter-decisions", label: "jev", enabled: true, priority: 50,
  model: "typesafe/jev-1.14", timeoutMs: 20_000, credentialRef: "provider:jev", proxy: { mode: "custom", url: "http://127.0.0.1:7890" }, ...overrides,
});

const answered = {
  id: "gen-dec-123",
  model: "typesafe/jev-1.14-20261014",
  provider: "TypeSafe",
  answers: {
    adopted: { type: "noul", noul: 0.91 },
    option: { type: "choice", choice: "B", confidence: 0.8, probabilities: { A: 0.2, B: 0.8 } },
  },
  usage: { input_tokens: 120, output_tokens: 0, cost: 0.000012 },
};

/** The two questions the canned answer above answers, as asked. */
const asked = {
  adopted: { type: "noul" as const, instructions: "Was option B adopted?" },
  option: { type: "choice" as const, instructions: "Which was chosen?", criteria: { A: "keep", B: "rewrite" } },
};

const setup = async (options: { profiles?: ModelProviderProfile[]; profile?: ModelProviderProfile; json?: unknown; fail?: ModelProviderError; secret?: string | null | ((reference: string) => string | null); now?: () => number } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "decisions-client-"));
  const traces = createDecisionCallStore(root);
  const postJson = vi.fn(async (_request: HttpModelRequest) => {
    if (options.fail !== undefined) throw options.fail;
    return { status: 200, headers: {}, requestId: "or-header-request", json: options.json ?? answered };
  });
  let sequence = 0;
  const client = new OpenRouterDecisionClient({
    profiles: { load: async () => options.profiles ?? [options.profile ?? jev()] },
    credentials: { get: async (reference) => (typeof options.secret === "function" ? options.secret(reference) : options.secret === undefined ? SECRET : options.secret) },
    traces,
    transport: { postJson },
    idFactory: () => `decision-${sequence++}`,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const traceFiles = async () => Promise.all((await readdir(root)).filter((name) => name.endsWith(".json")).map((name) => readFile(join(root, name), "utf8")));
  return { client, postJson, traces, traceFiles };
};

describe("OpenRouterDecisionClient", () => {
  it("asks only openrouter.ai, always with data collection denied, and the key only in its header", async () => {
    const { client, postJson } = await setup();
    const questions = { adopted: { type: "noul" as const, instructions: "Was option B adopted?" } };
    // A caller cannot hand in a provider block of its own: the request is built field by field.
    await client.decide("jev", { state: "User: go with B", questions, provider: { data_collection: "allow" } } as never, feature);
    const request = postJson.mock.calls[0]![0];
    expect(request.url).toBe(OPENROUTER_DECISIONS_URL);
    expect(request.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(request.body).toEqual({ model: "typesafe/jev-1.14", state: "User: go with B", questions, provider: { data_collection: "deny" } });
    expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(request.secrets).toEqual([SECRET]);
    expect(request).toMatchObject({ timeoutMs: 20_000, proxy: { mode: "custom" } });
  });

  it("returns typed answers and the provider's cost", async () => {
    const { client } = await setup();
    const result = await client.decide("jev", { state: { turn: 1 }, questions: asked }, feature);
    expect(result).toMatchObject({ profileId: "jev", model: "typesafe/jev-1.14" });
    expect(result.answers.adopted).toEqual({ type: "noul", noul: 0.91 });
    expect(result.answers.option).toMatchObject({ type: "choice", choice: "B" });
    expect(result.usage).toEqual({ source: "provider_reported", inputTokens: 120, outputTokens: 0, totalTokens: 120, costUsd: 0.000012 });
  });

  // A judge elsewhere is asked at its own endpoint, in the shape it takes.
  it("asks a System One judge elsewhere at its endpoint, without OpenRouter's provider block", async () => {
    const fireworks = jev({ profileId: "fw", baseUrl: "https://api.fireworks.ai/inference/v1/systemone", model: "accounts/fireworks/routers/rune" });
    const { client, postJson, traces } = await setup({ profile: fireworks });
    await client.decide("fw", { state: "s", questions: asked }, feature);
    const request = postJson.mock.calls[0]![0];
    expect(request.url).toBe("https://api.fireworks.ai/inference/v1/systemone");
    expect(request.body).toEqual({ model: "accounts/fireworks/routers/rune", state: "s", questions: asked });
    const [trace] = await traces.list();
    expect(trace!.decision).toMatchObject({ endpoint: "https://api.fireworks.ai/inference/v1/systemone" });
    expect(trace!.decision).not.toHaveProperty("dataCollection");
  });

  it("records a call to an address as long as a profile may hold", async () => {
    const endpoint = `https://judge.example/${"p".repeat(1_900)}`;
    const { client, traces } = await setup({ profile: jev({ profileId: "far", baseUrl: endpoint }) });
    await client.decide("far", { state: "s", questions: asked }, feature);
    expect((await traces.list())[0]!.decision).toMatchObject({ endpoint });
  });

  it("asks OpenAI in its own shape and reads its answers back as the questions were asked", async () => {
    const luna = jev({ profileId: "luna", baseUrl: "https://api.openai.com/v1/decisions", decisionsProtocol: "openai", model: "gpt-6-luna" });
    const questions = {
      adopted: { type: "noul" as const, instructions: "Was option B adopted?", criteria: { true: "B was chosen", false: "anything else" } },
      option: { type: "choice" as const, instructions: "Which was chosen?", criteria: { A: "keep", B: "rewrite" } },
      urgency: { type: "score" as const, criteria: ["can wait", "this week", "now"] },
    };
    const { client, postJson, traces } = await setup({ profile: luna, json: {
      model: "gpt-6-luna-2026-10-06",
      answers: [
        { name: "adopted", type: "predicate", probability: 0.91 },
        { name: "option", type: "choice", choice: "B", confidence: 0.8, probabilities: [{ value: "A", probability: 0.2 }, { value: "B", probability: 0.8 }] },
        { name: "urgency", type: "score", score: 1.1, confidence: 0.7, probabilities: [{ value: 0, label: "0", probability: 0.1 }, { value: 1, label: "1", probability: 0.7 }, { value: 2, label: "2", probability: 0.2 }] },
      ],
      usage: { input_tokens: 90, output_tokens: 0, total_tokens: 90 },
    } });
    const result = await client.decide("luna", { state: { turn: 1 }, questions }, feature);
    const request = postJson.mock.calls[0]![0];
    expect(request.url).toBe("https://api.openai.com/v1/decisions");
    expect(request.body).toEqual({
      model: "gpt-6-luna",
      input: JSON.stringify({ turn: 1 }, null, 2),
      questions: [
        { type: "predicate", name: "adopted", instructions: "Was option B adopted?\nTrue: B was chosen\nFalse: anything else" },
        { type: "choice", name: "option", instructions: "Which was chosen?", choices: [{ value: "A", description: "keep" }, { value: "B", description: "rewrite" }] },
        { type: "score", name: "urgency", instructions: "", levels: [{ label: "0", description: "can wait" }, { label: "1", description: "this week" }, { label: "2", description: "now" }] },
      ],
    });
    expect(result.answers).toEqual({
      adopted: { type: "noul", noul: 0.91 },
      option: { type: "choice", choice: "B", confidence: 0.8, probabilities: { A: 0.2, B: 0.8 } },
      urgency: { type: "score", score: 1.1 },
    });
    expect(result.usage).toMatchObject({ source: "provider_reported", inputTokens: 90 });
    // Recorded as it went: the questions in OpenAI's shape, and no data-collection ask that was never made.
    const [trace] = await traces.list();
    expect(JSON.parse(trace!.input!.systemPrompt)).toEqual((request.body as { questions: unknown }).questions);
    expect(trace!.decision).not.toHaveProperty("dataCollection");
  });

  it("refuses an OpenAI choice that names no option, or one keyed otherwise than as it was sent", async () => {
    const luna = jev({ profileId: "luna", baseUrl: "https://api.openai.com/v1/decisions", decisionsProtocol: "openai", model: "gpt-6-luna" });
    // Options spelled as a missing value or a boolean would come out of String() once converted.
    const questions = { q: { type: "choice" as const, instructions: "?", criteria: { undefined: "spelled so", true: "this one" } } };
    for (const answer of [
      { name: "q", type: "choice", confidence: 0.8, probabilities: [{ value: "undefined", probability: 0.8 }, { value: "true", probability: 0.2 }] },
      { name: "q", type: "choice", choice: true, confidence: 0.8, probabilities: [{ value: "undefined", probability: 0.2 }, { value: "true", probability: 0.8 }] },
      { name: "q", type: "choice", choice: "true", confidence: 0.8, probabilities: [{ value: true, probability: 0.8 }, { value: "undefined", probability: 0.2 }] },
    ]) {
      const { client } = await setup({ profile: luna, json: { answers: [answer] } });
      await expect(client.decide("luna", { state: "s", questions }, feature), JSON.stringify(answer)).rejects.toMatchObject({ code: "invalid_output" });
    }
  });

  it("takes an OpenAI refusal as no answer, and hands the call to the next judge", async () => {
    const luna = jev({ profileId: "luna", priority: 10, baseUrl: "https://api.openai.com/v1/decisions", decisionsProtocol: "openai", model: "gpt-6-luna", credentialRef: "provider:luna" });
    const { client, postJson } = await setup({ profiles: [luna, jev()] });
    postJson.mockResolvedValueOnce({ status: 200, headers: {}, requestId: "req-luna", json: { answers: [
      { name: "adopted", type: "refusal" },
      { name: "option", type: "choice", choice: "B", confidence: 0.8, probabilities: [{ value: "A", probability: 0.2 }, { value: "B", probability: 0.8 }] },
    ] } });
    await expect(client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toMatchObject({ profileId: "jev" });
    expect(postJson.mock.calls.map(([call]) => call.url)).toEqual(["https://api.openai.com/v1/decisions", OPENROUTER_DECISIONS_URL]);
  });

  it("refuses a disabled, missing or keyless profile, and an answer of the wrong shape", async () => {
    const request = { state: "s", questions: { q: { type: "noul" as const, instructions: "?" } } };
    await expect((await setup({ profile: jev({ enabled: false }) })).client.decide("jev", request, feature)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect((await setup()).client.decide("other", request, feature)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect((await setup({ secret: null })).client.decide("jev", request, feature)).rejects.toMatchObject({ code: "credential_unavailable" });
    await expect((await setup({ json: { answers: { q: { type: "noul", noul: "yes" } } } })).client.decide("jev", request, feature)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("tests with its fixed synthetic question, enabled or not, and says the cost", async () => {
    const { client, postJson, traces } = await setup({ profile: jev({ enabled: false }), json: { answers: { probe: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 30, cost: 0.000003 } } });
    await expect(client.test("jev")).resolves.toMatchObject({ ok: true, profileId: "jev", tokenSource: "provider_reported", costUsd: 0.000003 });
    expect(postJson.mock.calls[0]![0].body).toMatchObject({ state: DECISIONS_HEALTH_CHECK.state, questions: DECISIONS_HEALTH_CHECK.questions });
    expect((await traces.list())[0]).toMatchObject({ purpose: "provider-health-check", decision: { source: "provider-health-check" } });
  });

  it("says why a test failed (key, permission, model, timeout, proxy) and records the failure without the key", async () => {
    for (const code of ["authentication_failed", "authorization_failed", "invalid_configuration", "timeout", "network_error"] as const) {
      const { client, traces, traceFiles } = await setup({ fail: new ModelProviderError(code, `HTTP failure ${code}`) });
      await expect(client.test("jev")).resolves.toMatchObject({ ok: false, errorCode: code, diagnosticExcerpt: `HTTP failure ${code}` });
      const [trace] = await traces.list();
      expect(trace).toMatchObject({ purpose: "provider-health-check", errorCode: code, input: { userPrompt: DECISIONS_HEALTH_CHECK.state } });
      expect((await traceFiles()).join("")).not.toContain(SECRET);
    }
  });

  // R15-JEVSET-B2: jev is optional; left unset it does nothing, and a failure is no answer rather than an error.
  describe("decideIfAvailable", () => {
    const request = { state: "s", questions: { q: { type: "noul" as const, instructions: "?" } } };
    const qwen: ModelProviderProfile = { version: 1, profileId: "builtin-qwen", kind: "qwen", label: "Qwen", enabled: true, priority: 0, model: "qwen3.5-4b-q4-k-m", timeoutMs: 15_000 };

    it("sends nothing and answers null with no jev, jev off, or jev without a key, and nothing is sent when it is built", async () => {
      const cases: Array<[Parameters<typeof setup>[0], string]> = [[{ profiles: [qwen] }, "not_configured"], [{ profiles: [] }, "not_configured"], [{ profile: jev({ enabled: false }) }, "disabled"], [{ secret: null }, "no_credential"]];
      for (const [options, skipped] of cases) {
        const { client, postJson, traces } = await setup(options);
        expect(postJson).not.toHaveBeenCalled();
        await expect(client.decideIfAvailable(request, feature)).resolves.toBeNull();
        expect(postJson).not.toHaveBeenCalled();
        // Said once, as metadata: nothing was asked, so there is no input to keep.
        const [trace, ...rest] = await traces.list();
        expect(rest).toEqual([]);
        expect(trace).toMatchObject({ status: "unavailable", decision: { skipped, source: "r15-test", correlationId: "turn-7", dataCollection: "deny" } });
        expect(trace!.input).toBeUndefined();
      }
    });

    it("records a call not made once an hour for each reason, not on every call", async () => {
      let now = 0;
      const { client, traces } = await setup({ profiles: [], now: () => now });
      for (let index = 0; index < 5; index += 1) await client.decideIfAvailable(request, feature);
      expect(await traces.list()).toHaveLength(1);
      now += 60 * 60 * 1_000;
      await client.decideIfAvailable(request, feature);
      expect(await traces.list()).toHaveLength(2);
    });

    it("answers with the enabled jev that has a key", async () => {
      const { client, postJson } = await setup({ profiles: [qwen, jev({ profileId: "jev-off", enabled: false, priority: 10 }), jev({ priority: 20 })] });
      await expect(client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toMatchObject({ profileId: "jev", answers: { adopted: { type: "noul", noul: 0.91 } } });
      expect(postJson).toHaveBeenCalledOnce();
    });

    it("says each judge's missing key once an hour, apart from the others'", async () => {
      let now = 0;
      const { client, traces } = await setup({ profiles: [jev(), jev({ profileId: "luna", priority: 60, credentialRef: "provider:luna" })], secret: null, now: () => now });
      for (let index = 0; index < 3; index += 1) await client.decideIfAvailable(request, feature);
      expect((await traces.list()).map((trace) => trace.profile.profileId).sort()).toEqual(["jev", "luna"]);
      now += 60 * 60 * 1_000;
      await client.decideIfAvailable(request, feature);
      expect(await traces.list()).toHaveLength(4);
    });

    // Judges are asked in their order and fail over as generation backends do.
    const luna = jev({ profileId: "luna", label: "Luna", priority: 60, model: "openai/gpt-6-luna-decisions", credentialRef: "provider:luna" });

    it("hands a failed call to the next judge, its attempts numbered under one request, and says who answered", async () => {
      const { client, postJson, traces } = await setup({ profiles: [luna, jev()] });
      postJson.mockRejectedValueOnce(new ModelProviderError("provider_unavailable", "HTTP 503"));
      await expect(client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toMatchObject({ profileId: "luna", model: "openai/gpt-6-luna-decisions", answers: { adopted: { type: "noul", noul: 0.91 } } });
      expect(postJson.mock.calls.map(([call]) => (call.body as { model: string }).model)).toEqual(["typesafe/jev-1.14", "openai/gpt-6-luna-decisions"]);
      const attempts = (await traces.list()).sort((left, right) => left.attemptIndex - right.attemptIndex);
      expect(attempts).toMatchObject([
        { attemptIndex: 0, attemptId: `${attempts[0]!.requestId}:0`, profile: { profileId: "jev" }, status: "unavailable" },
        { requestId: attempts[0]!.requestId, attemptIndex: 1, attemptId: `${attempts[0]!.requestId}:1`, profile: { profileId: "luna" }, status: "succeeded" },
      ]);
    });

    it("stops at a judge with 失败后切换 off or when cancelled, and passes over one with no key", async () => {
      const stopping = await setup({ profiles: [jev({ fallbackOnFailure: false }), luna] });
      stopping.postJson.mockRejectedValueOnce(new ModelProviderError("timeout", "timed out"));
      await expect(stopping.client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toBeNull();
      expect(stopping.postJson).toHaveBeenCalledOnce();

      const controller = new AbortController();
      const cancelled = await setup({ profiles: [jev(), luna] });
      cancelled.postJson.mockImplementationOnce(async () => {
        controller.abort();
        throw new ModelProviderError("cancelled", "cancelled");
      });
      await expect(cancelled.client.decideIfAvailable({ state: "s", questions: asked }, feature, controller.signal)).resolves.toBeNull();
      expect(cancelled.postJson).toHaveBeenCalledOnce();

      const keyless = await setup({ profiles: [jev(), luna], secret: (reference) => (reference === "provider:jev" ? null : SECRET) });
      await expect(keyless.client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toMatchObject({ profileId: "luna" });
      expect(keyless.postJson).toHaveBeenCalledOnce();
      expect(await keyless.traces.list()).toContainEqual(expect.objectContaining({ profile: expect.objectContaining({ profileId: "jev" }), decision: expect.objectContaining({ skipped: "no_credential" }) }));

      const keylessStopping = await setup({ profiles: [jev({ fallbackOnFailure: false }), luna], secret: (reference) => (reference === "provider:jev" ? null : SECRET) });
      await expect(keylessStopping.client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toBeNull();
      expect(keylessStopping.postJson).not.toHaveBeenCalled();
    });

    it("sends a request too long to record to no judge, each saying so", async () => {
      const { client, postJson, traces } = await setup({ profiles: [jev(), luna] });
      await expect(client.decideIfAvailable({ state: "x".repeat(DECISION_RECORDED_INPUT_CHARS + 1), questions: asked }, feature)).resolves.toBeNull();
      expect(postJson).not.toHaveBeenCalled();
      expect((await traces.list()).map((trace) => trace.decision?.skipped)).toEqual(["input_too_large", "input_too_large"]);
    });

    it("hands a request too long for OpenAI's shape to a judge whose shape it fits", async () => {
      // OpenAI's shape spells a question out longer: this one fits a System One record and not OpenAI's.
      const openAi = jev({ profileId: "luna", priority: 10, baseUrl: "https://api.openai.com/v1/decisions", decisionsProtocol: "openai", model: "gpt-6-luna", credentialRef: "provider:luna" });
      const { client, postJson } = await setup({ profiles: [openAi, jev()], json: { answers: { q: { type: "noul", noul: 0.5 } } } });
      const questions = { q: { type: "noul" as const, instructions: "x".repeat(119_930) } };
      await expect(client.decideIfAvailable({ state: "s", questions }, feature)).resolves.toMatchObject({ profileId: "jev" });
      expect(postJson.mock.calls.map(([call]) => call.url)).toEqual([OPENROUTER_DECISIONS_URL]);
    });

    it("answers null when the call fails or the answer is malformed, and records the failure", async () => {
      for (const options of [{ fail: new ModelProviderError("authentication_failed", "HTTP 401") }, { fail: new ModelProviderError("timeout", "timed out") }, { json: { answers: { q: { type: "noul", noul: "yes" } } } }]) {
        const { client, traces } = await setup(options);
        await expect(client.decideIfAvailable(request, feature)).resolves.toBeNull();
        expect(await traces.list()).toEqual([expect.objectContaining({ purpose: "structured-judgment", status: expect.not.stringMatching(/^succeeded$/u) })]);
      }
    });
  });

  // R15-JEVSET-B3: jev's records keep what was asked and what came back, whatever the shared content switch says.
  describe("call records", () => {
    it("keep the whole question and answer, the response's id, model and provider, and never the key", async () => {
      const { client, traces, traceFiles } = await setup();
      const questions = asked;
      await client.decideIfAvailable({ state: "Assistant: A or B?\nUser: B", questions }, feature);
      const [trace] = await traces.list();
      expect(trace).toMatchObject({
        contentMode: "full",
        purpose: "structured-judgment",
        status: "succeeded",
        profile: { backend: "openrouter-decisions", model: "typesafe/jev-1.14", providerVersion: "typesafe/jev-1.14-20261014" },
        input: { userPrompt: "Assistant: A or B?\nUser: B" },
        output: { parsed: answered.answers },
        usage: { inputTokens: 120, outputTokens: 0, costUsd: 0.000012 },
        providerRequestId: "gen-dec-123",
        decision: {
          endpoint: OPENROUTER_DECISIONS_URL, dataCollection: "deny", source: "r15-test", correlationId: "turn-7", timeoutMs: 20_000, proxyMode: "custom",
          httpStatus: 200, responseId: "gen-dec-123", responseModel: "typesafe/jev-1.14-20261014", responseProvider: "TypeSafe",
        },
      });
      expect(JSON.parse(trace!.input!.systemPrompt)).toEqual(questions);
      const written = (await traceFiles()).join("");
      expect(written).not.toContain(SECRET);
      expect(written).not.toMatch(/authorization|Bearer|7890/iu);
    });

    it("keep their content in their own store while the shared traces keep none", async () => {
      const root = await mkdtemp(join(tmpdir(), "decisions-shared-"));
      const shared = new ModelTraceStore(join(root, "shared"), { contentMode: () => "metadata-only" });
      const { client, traces } = await setup();
      await client.decideIfAvailable({ state: "PRIVATE STATE", questions: { ...asked, adopted: { type: "noul", instructions: "PRIVATE QUESTION" } } }, feature);
      const [trace] = await traces.list();
      expect(trace!.input!.userPrompt).toBe("PRIVATE STATE");
      expect(trace!.output).toBeDefined();
      await expect(shared.list()).resolves.toEqual([]);
    });

    it("are kept 90 days and 5,000 calls", async () => {
      expect(DECISION_CALLS_MAXIMUM_AGE_MS).toBe(90 * 24 * 60 * 60 * 1_000);
      expect(DECISION_CALLS_MAXIMUM_ITEMS).toBe(5_000);
      const root = await mkdtemp(join(tmpdir(), "decisions-retention-"));
      let now = Date.parse("2026-10-27T00:00:00.000Z");
      const store = createDecisionCallStore(root, () => new Date(now));
      const record = (requestId: string) => store.record({
        requestId, attemptId: `${requestId}:0`, attemptIndex: 0, purpose: "structured-judgment",
        profile: { profileId: "jev", backend: "openrouter-decisions", provider: "jev", model: "typesafe/jev-1.14", promptVersion: "decisions-alpha", schemaVersion: "decisions-alpha" },
        usage: { source: "unavailable" }, timing: { queuedMs: 0, providerMs: 0, totalMs: 0 }, status: "succeeded",
      });
      await record("old");
      now += 89 * 24 * 60 * 60 * 1_000;
      expect((await store.list()).map((trace) => trace.requestId)).toEqual(["old"]);
      now += 2 * 24 * 60 * 60 * 1_000;
      await expect(store.list()).resolves.toEqual([]);
      for (let index = 0; index <= DECISION_CALLS_MAXIMUM_ITEMS; index += 1) {
        now += 1;
        await record(`call-${index}`);
      }
      const kept = await store.list();
      expect(kept).toHaveLength(DECISION_CALLS_MAXIMUM_ITEMS);
      expect(kept.some((trace) => trace.requestId === "call-0")).toBe(false);
    }, 120_000);
  });

  it("lists jev's records with the shared traces in time order, and deletes and clears both", async () => {
    const root = await mkdtemp(join(tmpdir(), "decisions-combined-"));
    let now = Date.parse("2026-10-27T00:00:00.000Z");
    const clock = () => new Date(now);
    const shared = new ModelTraceStore(join(root, "shared"), { now: clock });
    const calls = createDecisionCallStore(join(root, "calls"), clock);
    const record = (store: ModelTraceStore, requestId: string, backend: "qwen" | "openrouter-decisions") => {
      now += 1_000;
      return store.record({
        requestId, attemptId: `${requestId}:0`, attemptIndex: 0, purpose: backend === "qwen" ? "semantic-classification" : "structured-judgment",
        profile: { profileId: backend, backend, provider: backend, model: "m", promptVersion: "p", schemaVersion: "s" },
        usage: { source: "unavailable" }, timing: { queuedMs: 0, providerMs: 0, totalMs: 0 }, status: "succeeded",
      });
    };
    await record(shared, "first", "qwen");
    await record(calls, "second", "openrouter-decisions");
    await record(shared, "third", "qwen");
    const all = combinedTraces(shared, [calls], () => undefined);
    expect((await all.list()).map((trace) => trace.requestId)).toEqual(["first", "second", "third"]);
    await expect(all.deleteRequest("second")).resolves.toBe(1);
    expect((await all.list()).map((trace) => trace.requestId)).toEqual(["first", "third"]);
    await record(calls, "fourth", "openrouter-decisions");
    await expect(all.clear()).resolves.toBe(3);
    await expect(all.list()).resolves.toEqual([]);
  });

  // R15-JEVSET-B4 (review C1): a key the service echoes back reaches neither the record nor the caller or the window.
  describe("a key echoed back", () => {
    const probe = { answers: { probe: { type: "noul", noul: 0.99 } }, usage: { input_tokens: 30, cost: 0.000003 } };
    const echoing = (status: 200 | 401, where: "requestId" | "body" | "answerKey") => {
      const postJson = vi.fn(async (_request: HttpModelRequest) => {
        if (status === 401) {
          throw new ModelProviderError("authentication_failed", where === "body" ? `HTTP 401: invalid key ${SECRET}` : "HTTP 401", { providerRequestId: where === "requestId" ? SECRET : "req-1" });
        }
        const json = where === "answerKey" ? { ...probe, answers: { ...probe.answers, [SECRET]: { type: "noul", noul: 0.5 } } }
          : where === "body" ? { ...probe, id: `gen-dec-${SECRET}` } : probe;
        return { status: 200, headers: {}, ...(where === "requestId" ? { requestId: SECRET } : {}), json };
      });
      return postJson;
    };
    for (const status of [200, 401] as const) {
      for (const where of ["requestId", "body", "answerKey"] as const) {
        for (const content of ["full", "metadata-only"] as const) {
          it(`stays out of the record and the result: HTTP ${status}, echoed in ${where}, ${content}`, async () => {
            const root = await mkdtemp(join(tmpdir(), "decisions-echo-"));
            // The shared store's switch, either way: jev's own store keeps content regardless, and must stay clean.
            const traces = content === "full" ? createDecisionCallStore(root) : new ModelTraceStore(root, { contentMode: () => "metadata-only" });
            const client = new OpenRouterDecisionClient({
              profiles: { load: async () => [jev()] },
              credentials: { get: async () => SECRET },
              traces,
              transport: { postJson: echoing(status, where) },
            });
            const tested = await client.test("jev");
            const decided = await client.decideIfAvailable({ state: "s", questions: DECISIONS_HEALTH_CHECK.questions }, feature);
            const files = await Promise.all((await readdir(root)).filter((name) => name.endsWith(".json")).map((name) => readFile(join(root, name), "utf8")));
            expect(files.length).toBeGreaterThan(0);
            expect(files.join("") + JSON.stringify([tested, decided])).not.toContain(SECRET);
            if (where === "answerKey" && status === 200) {
              // An answer carrying the key is refused, never handed on.
              expect(tested).toMatchObject({ ok: false, errorCode: "invalid_output" });
              expect(decided).toBeNull();
            }
          });
        }
      }
    }
  });

  // R15-JEVSET-B4 (review C2): every question answered as asked, or the answer is refused.
  it("refuses a missing answer, a wrong type, an unknown option or a probability out of range, and drops answers never asked", async () => {
    const choice = { option: { type: "choice", choice: "B", confidence: 0.8, probabilities: { A: 0.2, B: 0.8 } } };
    for (const answers of [
      {},
      { adopted: { type: "noul", noul: 0.9 } },
      { adopted: { type: "choice", choice: "B", confidence: 0.8, probabilities: { B: 0.8 } }, ...choice },
      { adopted: { type: "noul", noul: 0.9 }, option: { ...choice.option, choice: "unrequested" } },
      { adopted: { type: "noul", noul: 0.9 }, option: { ...choice.option, probabilities: { A: 0.2, Z: 0.8 } } },
      { adopted: { type: "noul", noul: 0.9 }, option: { ...choice.option, confidence: 9 } },
      { adopted: { type: "noul", noul: 0.9 }, option: { ...choice.option, probabilities: { A: -2, B: 0.8 } } },
    ]) {
      const { client } = await setup({ json: { answers } });
      await expect(client.decide("jev", { state: "s", questions: asked }, feature), JSON.stringify(answers)).rejects.toMatchObject({ code: "invalid_output" });
    }
    const { client, traces } = await setup({ json: { answers: { ...answered.answers, extra: { type: "noul", noul: 0.1 } } } });
    const result = await client.decide("jev", { state: "s", questions: asked }, feature);
    expect(Object.keys(result.answers).sort()).toEqual(["adopted", "option"]);
    expect(JSON.stringify((await traces.list())[0]!.output)).not.toContain("extra");
  });

  // R15-JEVSET-B4 (review C3): an answer refused was still billed; its reported cost stays with the failure.
  it("keeps the reported usage and cost when the answer is refused, in the error, the record and the test result", async () => {
    const json = { answers: { probe: { type: "noul", noul: "invalid" } }, usage: { input_tokens: 120, output_tokens: 0, cost: 0.000012 } };
    const { client, traces } = await setup({ json });
    await expect(client.test("jev")).resolves.toMatchObject({ ok: false, errorCode: "invalid_output", tokenSource: "provider_reported", costUsd: 0.000012 });
    await expect(client.decide("jev", { state: "s", questions: DECISIONS_HEALTH_CHECK.questions }, feature)).rejects.toMatchObject({ code: "invalid_output", usage: { inputTokens: 120, costUsd: 0.000012 } });
    expect((await traces.list()).map((trace) => trace.usage)).toEqual([
      { source: "provider_reported", inputTokens: 120, outputTokens: 0, totalTokens: 120, costUsd: 0.000012 },
      { source: "provider_reported", inputTokens: 120, outputTokens: 0, totalTokens: 120, costUsd: 0.000012 },
    ]);
  });

  // R15-JEVSET-B6 (review C2-1): cleaned from the whole string before anything is cut short; no piece of the key stays.
  it("leaves no long piece of the key when an echoed value is longer than a record keeps", async () => {
    const secret = "or-key-SYNTHETIC-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHI";
    const windows = Array.from({ length: secret.length - 15 }, (_, index) => secret.slice(index, index + 16));
    for (const content of ["full", "metadata-only"] as const) {
      const root = await mkdtemp(join(tmpdir(), "decisions-clip-"));
      const traces = content === "full" ? createDecisionCallStore(root) : new ModelTraceStore(root, { contentMode: () => "metadata-only" });
      const long = `${"x".repeat(150)}${secret}`;
      const client = new OpenRouterDecisionClient({
        profiles: { load: async () => [jev()] },
        credentials: { get: async () => secret },
        traces,
        transport: { postJson: async () => ({ status: 200, headers: {}, requestId: long, json: { ...answered, id: long, model: long, provider: long } }) },
      });
      const decided = await client.decideIfAvailable({ state: `${"y".repeat(150)}${secret}`, questions: asked }, { feature: long, correlationId: long });
      const written = (await Promise.all((await readdir(root)).filter((name) => name.endsWith(".json")).map((name) => readFile(join(root, name), "utf8")))).join("") + JSON.stringify(decided);
      expect(written).toContain("[REDACTED]");
      for (const piece of windows) expect(written, piece).not.toContain(piece);
    }
  });

  // R15-JEVSET-B6/B7 (review C2-2, C3-2, C3-3): a key too short to be one is no key; a long one with any characters
  // is cleaned from the content alone, once, and the record keeps its shape, its numbers and its failure.
  it("treats a key under 20 characters as none, sending nothing, whatever it is", async () => {
    for (const secret of ["ACT", "profile", "\"", "\\", "1", "0.9", "x".repeat(19)]) {
      const { client, postJson, traces } = await setup({ secret });
      await expect(client.test("jev")).resolves.toMatchObject({ ok: false, errorCode: "credential_unavailable" });
      await expect(client.decide("jev", { state: "s", questions: asked }, feature)).rejects.toMatchObject({ code: "credential_unavailable" });
      await expect(client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toBeNull();
      expect(postJson, secret).not.toHaveBeenCalled();
      expect((await traces.list()).every((trace) => trace.profile.backend === "openrouter-decisions"), secret).toBe(true);
    }
  });

  it("keeps the structure, the numbers and the failure for a long key of quotes, backslashes and digits", async () => {
    for (const secret of ["\"or-key-\"quoted-0.91-0.8-x", "\\or\\key\\back\\slash\\long\\", "0.91000000000000000000", "[REDACTED]aaaaaaaaaaaa"]) {
      const failing = await setup({ secret, fail: new ModelProviderError("authentication_failed", `HTTP 401: bad key ${secret}`) });
      await expect(failing.client.test("jev")).resolves.toMatchObject({ ok: false, errorCode: "authentication_failed" });
      expect(await failing.traces.list(), secret).toEqual([expect.objectContaining({ errorCode: "authentication_failed", status: "auth_failed" })]);

      const answering = await setup({ secret });
      const result = await answering.client.decide("jev", { state: `s ${secret}`, questions: asked }, feature);
      expect(result.answers.adopted, secret).toEqual({ type: "noul", noul: 0.91 });
      expect(result.answers.option, secret).toMatchObject({ confidence: 0.8, probabilities: { A: 0.2, B: 0.8 } });
      const [trace] = await answering.traces.list();
      expect(trace!.output!.parsed, secret).toEqual(answered.answers);
      expect(trace!.usage.costUsd).toBe(0.000012);
      expect(trace!.input!.userPrompt, secret).toBe("s [REDACTED]");
    }
  });

  // R15-JEVSET-B7 (review C3-1): the record of an input refused for its length is cleaned with the key in hand.
  it("cleans the key from the record of an input too long to send, in either mode", async () => {
    for (const content of ["full", "metadata-only"] as const) {
      const root = await mkdtemp(join(tmpdir(), "decisions-oversized-"));
      const traces = content === "full" ? createDecisionCallStore(root) : new ModelTraceStore(root, { contentMode: () => "metadata-only" });
      const postJson = vi.fn();
      const client = new OpenRouterDecisionClient({ profiles: { load: async () => [jev()] }, credentials: { get: async () => SECRET }, traces, transport: { postJson } });
      await expect(client.decideIfAvailable(
        { state: "x".repeat(DECISION_RECORDED_INPUT_CHARS + 1), questions: asked },
        { feature: `feature-${SECRET}`, correlationId: `corr-${SECRET}` },
      )).resolves.toBeNull();
      expect(postJson).not.toHaveBeenCalled();
      const [trace] = await traces.list();
      expect(trace).toMatchObject({ decision: { skipped: "input_too_large", source: "feature-[REDACTED]", correlationId: "corr-[REDACTED]" } });
      const written = (await Promise.all((await readdir(root)).filter((name) => name.endsWith(".json")).map((name) => readFile(join(root, name), "utf8")))).join("");
      expect(written).not.toContain(SECRET);
    }
  });

  // R15-JEVSET-B7 (review C3-2): the input is cleaned once; what the length check passed is what is recorded.
  it("records an input at the ceiling once cleaned, even when cleaning could have made it grow again", async () => {
    const secret = "[REDACTED]aaaaaaaaaaaa";
    const { client, traces } = await setup({ secret, json: { answers: { probe: { type: "noul", noul: 0.5 } } } });
    const tail = `${secret}aaaaaaaaaaaa`;
    const state = "x".repeat(DECISION_RECORDED_INPUT_CHARS - "[REDACTED]".length - 12) + tail;
    await client.decide("jev", { state, questions: DECISIONS_HEALTH_CHECK.questions }, feature);
    const [trace] = await traces.list();
    expect(trace!.input!.userPrompt).toHaveLength(DECISION_RECORDED_INPUT_CHARS);
    expect(trace!.input!.userPrompt.endsWith("[REDACTED]aaaaaaaaaaaa")).toBe(true);
  });

  // R15-JEVSET-B7: a record that cannot be prepared or written never changes what the call returns.
  it("answers as it would when its record cannot be written", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = new OpenRouterDecisionClient({
      profiles: { load: async () => [jev()] },
      credentials: { get: async () => SECRET },
      traces: { record: () => { throw new TypeError("synchronous failure"); } },
      transport: { postJson: async () => ({ status: 200, headers: {}, json: answered }) },
    });
    await expect(client.decide("jev", { state: "s", questions: asked }, feature)).resolves.toMatchObject({ answers: { adopted: { noul: 0.91 } } });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not written (TypeError)"));
    error.mockRestore();
  });

  // R15-JEVSET-B6 (review C2-3): jev's records are optional; their folder broken never hides the shared ones.
  it("lists the shared records, for the log and its usage counts, when jev's folder cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "decisions-broken-"));
    const shared = new ModelTraceStore(join(root, "shared"));
    await shared.record({
      requestId: "pr", attemptId: "pr:0", attemptIndex: 0, purpose: "pr-review",
      profile: { profileId: "remote-openai", backend: "openai", provider: "OpenAI", model: "gpt-test", promptVersion: "p", schemaVersion: "s" },
      usage: { source: "provider_reported", totalTokens: 12 }, timing: { queuedMs: 0, providerMs: 1, totalMs: 1 }, status: "succeeded",
    });
    await writeFile(join(root, "calls"), "taken by a file", "utf8");
    const reported: unknown[] = [];
    const all = combinedTraces(shared, [createDecisionCallStore(join(root, "calls"))], (error) => reported.push(error));
    expect((await all.list()).map((trace) => [trace.requestId, trace.usage.totalTokens])).toEqual([["pr", 12]]);
    await expect(all.deleteRequest("pr")).resolves.toBe(1);
    expect(reported).toHaveLength(2);
    // With no jev set up, nothing is asked of it either.
    const { client, postJson } = await setup({ profiles: [] });
    await expect(client.decideIfAvailable({ state: "s", questions: asked }, feature)).resolves.toBeNull();
    expect(postJson).not.toHaveBeenCalled();
  });

  // R15-JEVSET-B6 (review C2-4): what is sent is what is recorded; what could not be recorded whole is not sent.
  it("sends and records whole an input at the ceiling, and sends nothing above it", async () => {
    const atCeiling = await setup({ json: { answers: { probe: { type: "noul", noul: 0.5 } } } });
    const state = "x".repeat(DECISION_RECORDED_INPUT_CHARS - 4) + "TAIL";
    await atCeiling.client.decide("jev", { state, questions: DECISIONS_HEALTH_CHECK.questions }, feature);
    expect(atCeiling.postJson.mock.calls[0]![0].body).toMatchObject({ state });
    expect((await atCeiling.traces.list())[0]!.input!.userPrompt).toBe(state);

    const above = await setup();
    const tooLong = { state: `${state}!`, questions: DECISIONS_HEALTH_CHECK.questions };
    await expect(above.client.decide("jev", tooLong, feature)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(above.client.decideIfAvailable(tooLong, feature)).resolves.toBeNull();
    expect(above.postJson).not.toHaveBeenCalled();
    const records = await above.traces.list();
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record).toMatchObject({ status: "unavailable", decision: { skipped: "input_too_large" } });
      expect(record.input).toBeUndefined();
    }
  });
});
