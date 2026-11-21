import {
  clipText,
  OPENROUTER_DECISIONS_URL,
  type ModelInvocationErrorCode,
  type ModelInvocationStatus,
  type ModelProviderProfile,
  type ModelPurpose,
  type NormalizedTokenUsage,
} from "@cognelis/decision-protocol";
import type { ModelTraceRecordInput } from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { CredentialVaultError } from "./credential-vault.js";
import type { ModelProviderTestResult } from "./profiled-model-gateway.js";
import { HttpModelTransport, ModelProviderError, type HttpModelRequest, type HttpModelResponse } from "./http-model-transport.js";

/** A judge's whole endpoint: the one it was given, else OpenRouter's. Its key goes there and nowhere else. */
const endpointOf = (profile: ModelProviderProfile | undefined): string => profile?.baseUrl ?? OPENROUTER_DECISIONS_URL;

/** Only OpenRouter takes a request's say over what is kept (a provider block, in its own shape): no other has one. */
const deniesCollection = (profile: ModelProviderProfile | undefined): boolean =>
  profile?.decisionsProtocol !== "openai" && new URL(endpointOf(profile)).origin === new URL(OPENROUTER_DECISIONS_URL).origin;
const MAXIMUM_RESPONSE_BYTES = 262_144;
const API_VERSION = "decisions-alpha";

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions?: string; criteria: Record<string, string> }
  | { type: "score"; instructions?: string; criteria: string[] };

export interface DecisionRequest {
  state: string | Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

const probability = z.number().min(0).max(1);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), confidence: probability, probabilities: z.record(z.string(), probability) }),
  // ponytail: score's answer shape is unmeasured; widen once a real answer is seen.
  z.object({ type: z.literal("score"), score: z.number() }),
]);
export type DecisionAnswer = z.infer<typeof answerSchema>;

/** Read on its own, before the answers: an answer refused was still billed, and its cost is kept with the failure. */
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cost: z.number().nonnegative().optional(),
});

/** The questions in OpenAI's shape: a named list, a yes/no as a predicate, the options and the levels as lists. */
const openAiQuestions = (questions: Record<string, DecisionQuestion>) =>
  Object.entries(questions).map(([name, question]) =>
    question.type === "noul"
      ? { type: "predicate", name, instructions: question.criteria === undefined ? question.instructions : `${question.instructions}\nTrue: ${question.criteria.true}\nFalse: ${question.criteria.false}` }
      : question.type === "choice"
        ? { type: "choice", name, instructions: question.instructions ?? "", choices: Object.entries(question.criteria).map(([value, description]) => ({ value, description })) }
        : { type: "score", name, instructions: question.instructions ?? "", levels: question.criteria.map((description, index) => ({ label: String(index), description })) });

const openAiAnswersSchema = z.array(z.object({
  name: z.string(),
  type: z.string(),
  probability: z.unknown().optional(),
  choice: z.union([z.string(), z.boolean()]).optional(),
  confidence: z.unknown().optional(),
  score: z.unknown().optional(),
  probabilities: z.array(z.object({ value: z.union([z.string(), z.boolean(), z.number()]), probability: z.unknown() })).optional(),
}));

/** OpenAI's answers, a list named after the questions, as the map read below: a refusal (or any other type) is none. */
const fromOpenAiAnswers = (answers: unknown): unknown => {
  const parsed = openAiAnswersSchema.safeParse(answers);
  if (!parsed.success) return answers;
  return Object.fromEntries(parsed.data.flatMap((answer): Array<[string, unknown]> => {
    if (answer.type === "predicate") return [[answer.name, { type: "noul", noul: answer.probability }]];
    if (answer.type === "score") return [[answer.name, { type: "score", score: answer.score }]];
    if (answer.type !== "choice") return [];
    // The options went out as strings: a choice or a probability keyed otherwise (missing, a boolean) is passed on
    // as it came, and refused below rather than read as an option of the same spelling.
    const { probabilities } = answer;
    return [[answer.name, {
      type: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: probabilities !== undefined && probabilities.every((entry): entry is { value: string; probability: unknown } => typeof entry.value === "string")
        ? Object.fromEntries(probabilities.map((entry) => [entry.value, entry.probability]))
        : probabilities,
    }]];
  }));
};

const responseSchema = z.object({
  answers: z.record(z.string(), answerSchema),
  // Recorded when they are text; their shape is not the API's promise, so never a reason to refuse the answers.
  id: z.unknown().optional(),
  model: z.unknown().optional(),
  provider: z.unknown().optional(),
});

/** Who asked (a feature's name, or the connection test) and what it was about, for the call record. */
export interface DecisionCallContext {
  feature: string;
  correlationId?: string;
}

type Skipped = NonNullable<NonNullable<ModelTraceRecordInput["decision"]>["skipped"]>;
const SKIP_RECORD_INTERVAL_MS = 60 * 60 * 1_000;
const usageOf = (value: unknown): NormalizedTokenUsage => {
  const reported = usageSchema.safeParse(value);
  if (!reported.success) return { source: "unavailable" };
  const { input_tokens: input, output_tokens: output, cost } = reported.data;
  return {
    source: "provider_reported",
    ...(input === undefined ? {} : { inputTokens: input }),
    ...(output === undefined ? {} : { outputTokens: output }),
    ...(input === undefined ? {} : { totalTokens: input + (output ?? 0) }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
};

/**
 * Each question asked, answered as asked: its name, its type, a choice among its own criteria. One missing or
 * otherwise is the whole answer refused; answers to questions never asked are left out.
 */
const answersFor = (questions: Record<string, DecisionQuestion>, answers: Record<string, DecisionAnswer>): Record<string, DecisionAnswer> | null => {
  const checked: Record<string, DecisionAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const answer = Object.hasOwn(answers, name) ? answers[name] : undefined;
    if (answer?.type !== question.type) return null;
    if (answer.type === "choice" && question.type === "choice" && (!Object.hasOwn(question.criteria, answer.choice) || Object.keys(answer.probabilities).some((option) => !Object.hasOwn(question.criteria, option)))) return null;
    checked[name] = answer;
  }
  return checked;
};

/** A string with every occurrence of the key replaced, from the whole of it: cleaned before it is ever cut short. */
const scrubText = (value: string, secret: string | null): string =>
  secret === null ? value : value.split(secret).join("[REDACTED]");

/**
 * The shortest key a decisions profile takes. Shorter, a key could be a piece of "[REDACTED]" or a record's own field
 * name, and cleaning it would neither settle nor leave the record's shape alone; real OpenRouter keys are far longer.
 */
export const MINIMUM_DECISIONS_KEY_CHARS = 20;
const usableKey = (secret: string | null): string | null =>
  secret !== null && secret.length >= MINIMUM_DECISIONS_KEY_CHARS ? secret : null;

/**
 * The content a record carries, cleaned of an echoed key: every string value, walked. The record's own field names
 * are left alone; the maps whose keys came from outside (answers, an answer's probabilities) are cleaned in
 * scrubAnswers. Never throws, whatever the key is.
 */
const scrub = <T>(value: T, secret: string | null): T => {
  if (secret === null) return value;
  const walk = (item: unknown): unknown =>
    typeof item === "string" ? scrubText(item, secret)
    : Array.isArray(item) ? item.map(walk)
    : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]))
    : item;
  return walk(value) as T;
};

/** Answers keyed by the questions' names and their options: the names cleaned as their values are. */
const scrubAnswers = (answers: unknown, secret: string | null): unknown =>
  secret === null || answers === null || typeof answers !== "object" ? answers : Object.fromEntries(Object.entries(answers).map(([name, answer]) => {
    const cleaned = scrub(answer, secret) as Record<string, unknown>;
    const probabilities = cleaned !== null && typeof cleaned === "object" ? cleaned.probabilities : undefined;
    return [scrubText(name, secret), probabilities !== null && typeof probabilities === "object"
      ? { ...cleaned, probabilities: Object.fromEntries(Object.entries(probabilities).map(([option, value]) => [scrubText(option, secret), value])) }
      : cleaned];
  }));

/** Whether the key is anywhere in a value from outside: any string, any key at any depth. */
const carries = (value: unknown, secret: string): boolean =>
  typeof value === "string" ? value.includes(secret)
  : Array.isArray(value) ? value.some((item) => carries(item, secret))
  : value !== null && typeof value === "object" ? Object.entries(value).some(([key, item]) => key.includes(secret) || carries(item, secret))
  : false;

/** The ceilings a record keeps, applied after scrubbing: cutting first could leave part of the key behind. */
const bounded = (record: ModelTraceRecordInput): ModelTraceRecordInput => {
  const { decision, output, profile } = record;
  return {
    ...record,
    profile: { ...profile, ...(profile.providerVersion === undefined ? {} : { providerVersion: clipText(profile.providerVersion, 200) }) },
    ...(output === undefined ? {} : { output: { ...output, visibleText: clipText(output.visibleText, 20_000) } }),
    ...(record.diagnosticExcerpt === undefined ? {} : { diagnosticExcerpt: clipText(record.diagnosticExcerpt, 2_000) }),
    ...(record.providerRequestId === undefined ? {} : { providerRequestId: clipText(record.providerRequestId, 500) }),
    ...(decision === undefined ? {} : {
      decision: {
        ...decision,
        source: clipText(decision.source, 100),
        ...(decision.correlationId === undefined ? {} : { correlationId: clipText(decision.correlationId, 200) }),
        ...(decision.responseId === undefined ? {} : { responseId: clipText(decision.responseId, 200) }),
        ...(decision.responseModel === undefined ? {} : { responseModel: clipText(decision.responseModel, 200) }),
        ...(decision.responseProvider === undefined ? {} : { responseProvider: clipText(decision.responseProvider, 200) }),
      },
    }),
  };
};

/**
 * What a record keeps of the questions and of the state (the protocol's prompt ceiling). A request is sent only when
 * both fit whole, so every call that goes out is recorded as it went.
 */
export const DECISION_RECORDED_INPUT_CHARS = 120_000;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

export interface DecisionResult {
  requestId: string;
  /** The judge that answered: probabilities differ between models, so a threshold is set for each one. */
  profileId: string;
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: NormalizedTokenUsage;
  latencyMs: number;
}

/** A fixed, synthetic question: the connection test sends nothing of the reader's. */
export const DECISIONS_HEALTH_CHECK: DecisionRequest = {
  state: "The sky is blue.",
  questions: { probe: { type: "noul", instructions: "Is the statement about the sky?" } },
};

export interface OpenRouterDecisionClientOptions {
  profiles: { load(): Promise<ModelProviderProfile[]> };
  credentials: { get(reference: string): Promise<string | null> };
  traces: { record(input: ModelTraceRecordInput): Promise<unknown> };
  transport?: { postJson(input: HttpModelRequest): Promise<HttpModelResponse> };
  idFactory?: () => string;
  now?: () => number;
}

const statusOf = (code: ModelInvocationErrorCode): ModelInvocationStatus =>
  code === "timeout" ? "timed_out"
  : code === "cancelled" ? "cancelled"
  : code === "authentication_failed" || code === "authorization_failed" ? "auth_failed"
  : code === "invalid_output" ? "invalid_output"
  : code === "provider_unavailable" || code === "credential_unavailable" || code === "credential_decryption_failed" ? "unavailable"
  : "failed";

/**
 * The typed entry to a decisions backend (jev, IMP-166), kept apart from every generation route: nothing in the app
 * calls it yet, and a later feature goes through decideIfAvailable. Each request to OpenRouter carries data_collection
 * "deny"; a judge elsewhere is asked at its own endpoint, in the shape it takes (System One or OpenAI's). Every
 * call is recorded whole (what was asked, what came back), in a store of its own that always keeps content; never
 * the key or its header.
 */
export class OpenRouterDecisionClient {
  readonly #options: OpenRouterDecisionClientOptions;
  readonly #transport: NonNullable<OpenRouterDecisionClientOptions["transport"]>;
  readonly #idFactory: () => string;
  readonly #now: () => number;
  /** When each reason a call was not made was last recorded, for each judge: once an hour, so a busy feature does not flood the log. */
  readonly #skipRecorded = new Map<string, number>();

  constructor(options: OpenRouterDecisionClientOptions) {
    this.#options = options;
    this.#transport = options.transport ?? new HttpModelTransport();
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The entry every feature uses: judges are optional. The enabled ones are asked in their order, as generation
   * backends are: one with no key, or whose call fails, hands over to the next unless 失败后切换 is off for it. With
   * no decisions profile, none enabled, or none answering, the answer is null (each failure's trace still written).
   * A caller given null goes on as it would without a judge, so leaving them unset never breaks anything.
   */
  async decideIfAvailable(request: DecisionRequest, context: DecisionCallContext, signal?: AbortSignal): Promise<DecisionResult | null> {
    try {
      const judges = (await this.#options.profiles.load())
        .filter((candidate) => candidate.kind === "openrouter-decisions")
        .sort((left, right) => left.priority - right.priority || left.profileId.localeCompare(right.profileId));
      const enabled = judges.filter((candidate) => candidate.enabled);
      if (enabled.length === 0) {
        await this.#recordSkipped(judges.length === 0 ? "not_configured" : "disabled", judges[0], context);
        return null;
      }
      // One request, its attempts numbered down the chain, as a generation's are.
      const requestId = this.#idFactory();
      let attemptIndex = 0;
      for (const profile of enabled) {
        const secret = usableKey(profile.credentialRef === undefined ? null : await this.#options.credentials.get(profile.credentialRef).catch(() => null));
        if (secret === null) {
          await this.#recordSkipped("no_credential", profile, context);
        } else {
          try {
            return await this.#call(profile, request, "structured-judgment", context, signal, requestId, attemptIndex++);
          } catch {
            // Only a cancelled call ends the chain here: one too long for a judge's record may fit the next one's, as
            // OpenAI's shape spells the same questions out longer.
            if (signal?.aborted === true) return null;
          }
        }
        if (profile.fallbackOnFailure === false) return null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** For explicit actions only (the connection test): it throws. Features call decideIfAvailable instead. */
  async decide(profileId: string, request: DecisionRequest, context: DecisionCallContext, signal?: AbortSignal): Promise<DecisionResult> {
    const profile = await this.#profile(profileId);
    if (!profile.enabled) throw new ModelProviderError("invalid_configuration", "Decisions profile is not enabled");
    return this.#call(profile, request, "structured-judgment", context, signal);
  }

  /** The connection test: the fixed synthetic question, enabled or not, as every backend is tested before it is switched on. */
  async test(profileId: string): Promise<ModelProviderTestResult> {
    const startedAt = performance.now();
    try {
      const result = await this.#call(await this.#profile(profileId), DECISIONS_HEALTH_CHECK, "provider-health-check", { feature: "provider-health-check" });
      return {
        ok: true,
        profileId,
        latencyMs: result.latencyMs,
        requestId: result.requestId,
        tokenSource: result.usage.source,
        ...(result.usage.costUsd === undefined ? {} : { costUsd: result.usage.costUsd }),
      };
    } catch (error) {
      const failure = error instanceof ModelProviderError ? error : new ModelProviderError("unknown", "Decisions test failed");
      return {
        ok: false,
        profileId,
        latencyMs: Math.round(performance.now() - startedAt),
        requestId: this.#idFactory(),
        errorCode: failure.code,
        diagnosticExcerpt: failure.diagnosticExcerpt,
        ...(failure.providerRequestId === undefined ? {} : { providerRequestId: failure.providerRequestId }),
        ...(failure.usage === undefined ? {} : { tokenSource: failure.usage.source }),
        ...(failure.usage?.costUsd === undefined ? {} : { costUsd: failure.usage.costUsd }),
      };
    }
  }

  async #profile(profileId: string): Promise<ModelProviderProfile> {
    const profile = (await this.#options.profiles.load()).find((candidate) => candidate.profileId === profileId);
    if (profile?.kind !== "openrouter-decisions") throw new ModelProviderError("invalid_configuration", "Decisions profile was not found");
    return profile;
  }

  /** A call not made, said once an hour for each reason: metadata only, as there was nothing asked. */
  async #recordSkipped(skipped: Skipped, profile: ModelProviderProfile | undefined, context: DecisionCallContext, secret: string | null = null): Promise<void> {
    const now = this.#now();
    // An input too long is one call's own matter, said each time; the others say how a judge is set, once an hour.
    if (skipped !== "input_too_large") {
      const key = `${skipped}:${profile?.profileId ?? ""}`;
      if (now - (this.#skipRecorded.get(key) ?? Number.NEGATIVE_INFINITY) < SKIP_RECORD_INTERVAL_MS) return;
      this.#skipRecorded.set(key, now);
    }
    const requestId = this.#idFactory();
    await this.#record({
      requestId,
      attemptId: `${requestId}:0`,
      attemptIndex: 0,
      purpose: "structured-judgment",
      profile: { profileId: profile?.profileId ?? "openrouter-decisions", backend: "openrouter-decisions", provider: profile?.label ?? "jev", model: profile?.model ?? "未配置", promptVersion: API_VERSION, schemaVersion: API_VERSION },
      usage: { source: "unavailable" },
      timing: { queuedMs: 0, providerMs: 0, totalMs: 0 },
      status: "unavailable",
      errorCode: skipped === "no_credential" ? "credential_unavailable" : skipped === "input_too_large" ? "invalid_configuration" : "provider_unavailable",
      decision: { endpoint: endpointOf(profile), ...(deniesCollection(profile) ? { dataCollection: "deny" as const } : {}), ...this.#source(context), skipped },
    }, secret);
  }

  /**
   * Every record goes out cleaned, then bounded. Its input comes already cleaned, the one time it is, by the check
   * that let it be sent. Nothing here, its cleaning included, ever fails the call it records.
   */
  async #record(record: ModelTraceRecordInput, secret: string | null): Promise<void> {
    try {
      const { input, ...rest } = record;
      const cleaned = scrub(rest, secret);
      await this.#options.traces.record(bounded({
        ...cleaned,
        ...(input === undefined ? {} : { input }),
        ...(cleaned.output === undefined ? {} : { output: { ...cleaned.output, parsed: scrubAnswers(cleaned.output.parsed, secret) } }),
      }));
    } catch (error) {
      // Named only: a store's refusal can quote the value it refused.
      console.error(`[paraself] decision-model call record not written (${error instanceof Error ? error.name : "unknown"})`);
    }
  }

  #source(context: DecisionCallContext) {
    return { source: context.feature, ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }) };
  }

  async #call(profile: ModelProviderProfile, request: DecisionRequest, purpose: ModelPurpose, context: DecisionCallContext, signal?: AbortSignal, requestId = this.#idFactory(), attemptIndex = 0): Promise<DecisionResult> {
    const endpoint = endpointOf(profile);
    const openAi = profile.decisionsProtocol === "openai";
    const denied = deniesCollection(profile);
    const asked = {
      endpoint,
      ...(denied ? { dataCollection: "deny" as const } : {}),
      ...this.#source(context),
      timeoutMs: profile.timeoutMs,
      // The way it connects, never a proxy's address: one could carry credentials.
      proxyMode: profile.proxy?.mode ?? "environment",
    };
    const startedAt = performance.now();
    const elapsed = () => Math.round(performance.now() - startedAt);
    let secret: string | null = null;
    // The whole question as sent, once there is one to send: questions with their instructions and criteria, the state.
    let input: ModelTraceRecordInput["input"];
    const trace = (fields: Partial<ModelTraceRecordInput>) => this.#record({
      requestId,
      attemptId: `${requestId}:${attemptIndex}`,
      attemptIndex,
      purpose,
      profile: { profileId: profile.profileId, backend: profile.kind, provider: profile.label, model: profile.model!, promptVersion: API_VERSION, schemaVersion: API_VERSION },
      ...(input === undefined ? {} : { input }),
      usage: { source: "unavailable" },
      timing: { queuedMs: 0, providerMs: elapsed(), totalMs: elapsed() },
      status: "succeeded",
      decision: asked,
      ...fields,
    }, secret);
    const tooLarge = new ModelProviderError("invalid_configuration", `The questions or the state exceed the ${DECISION_RECORDED_INPUT_CHARS} characters a call record keeps; nothing was sent`);
    try {
      // A key too short to be one is no key: nothing is sent with it.
      secret = usableKey(profile.credentialRef === undefined ? null : await this.#options.credentials.get(profile.credentialRef));
      if (secret === null) throw new ModelProviderError("credential_unavailable", "Decisions profile has no usable API key");
      // What goes out, in the shape the judge takes; the record keeps it as it went.
      const questions = openAi ? openAiQuestions(request.questions) : request.questions;
      const state = typeof request.state === "string" ? request.state : JSON.stringify(request.state, null, 2);
      const recorded = {
        systemPrompt: scrubText(JSON.stringify(questions, null, 2), secret),
        userPrompt: scrubText(state, secret),
        outputSchema: {},
      };
      // Sent only if it can be recorded whole: one sent and another kept would make the record a different call.
      if ([recorded.systemPrompt, recorded.userPrompt].some((value) => value.length > DECISION_RECORDED_INPUT_CHARS || value.trim().length === 0)) {
        await this.#recordSkipped("input_too_large", profile, context, secret);
        throw tooLarge;
      }
      input = recorded;
      const response = await this.#transport.postJson({
        provider: profile.kind,
        model: profile.model,
        url: endpoint,
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        // Built field by field: no request can carry a provider block of its own and turn retention back on.
        body: openAi
          ? { model: profile.model, input: state, questions }
          : { model: profile.model, state: request.state, questions, ...(denied ? { provider: { data_collection: "deny" } } : {}) },
        timeoutMs: profile.timeoutMs,
        maximumResponseBytes: MAXIMUM_RESPONSE_BYTES,
        secrets: [secret],
        ...(profile.proxy === undefined ? {} : { proxy: profile.proxy }),
        ...(signal === undefined ? {} : { signal }),
      });
      const body = response.json !== null && typeof response.json === "object" ? response.json as Record<string, unknown> : {};
      const usage = usageOf(body.usage);
      const parsed = responseSchema.safeParse(openAi ? { ...body, answers: fromOpenAiAnswers(body.answers) } : body);
      const answers = parsed.success ? answersFor(request.questions, parsed.data.answers) : null;
      // An answer that carries the key back is no answer to hand anyone: refused, as one of the wrong shape is.
      if (answers === null || carries(body.answers, secret)) {
        throw new ModelProviderError("invalid_output", "Decisions API returned answers that do not match the questions", {
          ...(response.requestId === undefined ? {} : { providerRequestId: response.requestId }),
          usage,
        });
      }
      const latencyMs = elapsed();
      const responseId = text(parsed.data!.id);
      const responseModel = text(parsed.data!.model);
      const responseProvider = text(parsed.data!.provider);
      const providerRequestId = responseId ?? response.requestId;
      await trace({
        profile: { profileId: profile.profileId, backend: profile.kind, provider: profile.label, model: profile.model!, ...(responseModel === undefined ? {} : { providerVersion: responseModel }), promptVersion: API_VERSION, schemaVersion: API_VERSION },
        output: { visibleText: JSON.stringify(answers), parsed: answers },
        usage,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
        decision: {
          ...asked,
          httpStatus: response.status,
          ...(responseId === undefined ? {} : { responseId }),
          ...(responseModel === undefined ? {} : { responseModel }),
          ...(responseProvider === undefined ? {} : { responseProvider }),
        },
      });
      return { requestId, profileId: profile.profileId, model: profile.model!, answers, usage, latencyMs };
    } catch (error) {
      // Not sent, and recorded as such: no failure record of a call that never went out.
      if (error === tooLarge) throw tooLarge;
      const caught = error instanceof ModelProviderError ? error
        : error instanceof CredentialVaultError ? new ModelProviderError(error.code, error.message)
        : signal?.aborted === true ? new ModelProviderError("cancelled", "Decisions call was cancelled")
        : new ModelProviderError("unknown", "Decisions call failed");
      // What goes back to the caller (and from the test, to the window) is scrubbed as the record is.
      const failure = new ModelProviderError(caught.code, scrubText(caught.message, secret), {
        diagnosticExcerpt: scrubText(caught.diagnosticExcerpt, secret),
        ...(caught.providerRequestId === undefined ? {} : { providerRequestId: scrubText(caught.providerRequestId, secret) }),
        ...(caught.usage === undefined ? {} : { usage: caught.usage }),
      });
      await trace({
        status: statusOf(failure.code),
        errorCode: failure.code,
        diagnosticExcerpt: failure.diagnosticExcerpt,
        ...(failure.usage === undefined ? {} : { usage: failure.usage }),
        ...(failure.providerRequestId === undefined ? {} : { providerRequestId: failure.providerRequestId }),
      });
      throw failure;
    }
  }
}
