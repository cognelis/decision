import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelInvocationTrace, ModelProviderProfile, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import type { ModelTraceRecordInput } from "@cognelis/decision-storage";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicMessagesAdapter } from "../src/main/model/adapters/anthropic-messages-adapter.js";
import { OpenAICompatibleAdapter } from "../src/main/model/adapters/openai-compatible-adapter.js";
import { OpenAIResponsesAdapter } from "../src/main/model/adapters/openai-responses-adapter.js";
import { HttpModelTransport, type ModelProviderError } from "../src/main/model/http-model-transport.js";
import { ProfiledModelGateway } from "../src/main/model/profiled-model-gateway.js";
import type { SemanticClassifier } from "../src/main/semantic/semantic-classifier.js";

const servers: Server[] = [];

/** A loopback endpoint answering every request with `status` and `body`, as a provider's API would. */
const serve = async (status: number, body: unknown): Promise<string> => {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

// What the reader sent, which a moderation refusal quotes back (OpenRouter's flagged_input): a trace keeps the
// diagnostic even with trace content off, so it may say why, never this.
const typed = "我们决定裁掉B项目团队";

const refusal = (url: string) => new HttpModelTransport()
  .postJson({ url, headers: {}, body: { input: typed }, timeoutMs: 2_000, maximumResponseBytes: 10_000, secrets: [] })
  .then(() => { throw new Error("expected a refusal"); }, (error: unknown) => error as ModelProviderError);

/** OpenRouter's moderation refusal, as its errors page documents it: a 403 naming what the input was flagged for. */
const moderated = {
  error: {
    code: 403,
    message: "openai/gpt-4o requires moderation on OpenAI. Your input was flagged for \"harassment\". No credits were charged.",
    metadata: { reasons: ["harassment"], flagged_input: typed, provider_name: "OpenAI", model_slug: "openai/gpt-4o" },
  },
};

describe("a provider's content moderation refusing a request", () => {
  it("is filed as content_refused for each documented form, saying why and never what was sent", async () => {
    for (const [status, body, said] of [
      // OpenRouter (openrouter.ai/docs/api-reference/errors): moderation, then its typed errors where each API puts them.
      [403, moderated, "flagged for \\\"harassment\\\""],
      [403, { error: { code: 403, message: "Input flagged by a content filter", metadata: { error_type: "content_policy_violation" } } }, "content filter"],
      [403, { error: { code: "refusal", message: "The model declined the request" }, error_type: "refusal" }, "declined"],
      [403, { type: "error", error: { type: "permission_error", message: "Output flagged by a content filter", error_type: "content_policy_violation" } }, "content filter"],
      // Azure OpenAI (learn.microsoft.com, content filtering): a filtered prompt is a 400 with code content_filter.
      [400, { error: { message: "The response was filtered", type: null, param: "prompt", code: "content_filter", status: 400,
        innererror: { code: "ResponsibleAIPolicyViolation", content_filter_result: { hate: { filtered: true, severity: "high", excerpt: typed } } } } }, "was filtered"],
      // Kimi (platform.kimi.com/docs/api/errors): 400 of type content_filter.
      [400, { error: { type: "content_filter", message: "The request was rejected because it was considered high risk" } }, "considered high risk"],
      // DashScope (help.aliyun.com/zh/model-studio/error-code): 400 DataInspectionFailed / data_inspection_failed.
      [400, { error: { code: "data_inspection_failed", type: "data_inspection_failed", message: "Input data may contain inappropriate content.", param: null } }, "inappropriate content"],
      [400, { code: "DataInspectionFailed", message: "Input or output data may contain inappropriate content.", request_id: "request-1" }, "DataInspectionFailed"],
      // ... and its custom content rules and FAQ rule intervention: 400 CustomRoleBlocked, 400 FaqRuleBlocked.
      [400, { code: "CustomRoleBlocked", message: "Input or output data may contain inappropriate content with custom rule.", request_id: "request-2" }, "with custom rule"],
      [400, { error: { code: "FaqRuleBlocked", message: "Input or output data is blocked by faq rule." } }, "blocked by faq rule"],
      // Zhipu (docs.bigmodel.cn/cn/faq/api-code): 400 with code 1301.
      [400, { error: { code: "1301", message: "系统检测到输入或生成内容可能包含不安全或敏感内容，请您避免输入易产生敏感内容的提示语，感谢您的配合" } }, "不安全或敏感内容"],
    ] as const) {
      const failure = await refusal(await serve(status, body));

      expect([status, failure.code]).toEqual([status, "content_refused"]);
      expect(failure.diagnosticExcerpt).toContain(`HTTP ${status}`);
      expect(failure.diagnosticExcerpt).toContain(said);
      expect(failure.diagnosticExcerpt).not.toContain(typed);
    }
  });

  it("is filed as content_refused for each of Volcano Ark's codes for sensitive text in and out", async () => {
    // docs.volcengine.com/docs/82379/1299023: each a 400 BadRequest. Its risk service failing to answer is not a refusal.
    for (const code of ["SensitiveContentDetected", "SensitiveContentDetected.SevereViolation", "SensitiveContentDetected.Violence",
      "InputTextSensitiveContentDetected", "InputTextSensitiveContentDetected.PolicyViolation", "OutputTextSensitiveContentDetected",
      "InputTextRiskDetection", "OutputTextRiskDetection", "ContentSecurityDetectionError"]) {
      const failure = await refusal(await serve(400, { error: { code, message: "The request failed because the input text may contain sensitive information.Request ID: 0217-ark", param: "", type: "BadRequest" } }));

      expect([code, failure.code]).toEqual([code, code === "ContentSecurityDetectionError" ? "invalid_configuration" : "content_refused"]);
      expect(failure.diagnosticExcerpt).toContain(code);
    }
  });

  it("leaves a refusal of the key, the account's own guardrail or the request itself where it was", async () => {
    for (const [status, body, code] of [
      // OpenRouter's guardrail is the account's policy, typed permission_denied as a key without access is.
      [403, { error: { code: 403, message: "Request blocked: prompt injection patterns detected", metadata: { error_type: "permission_denied", patterns: ["ignore previous instructions"] } } }, "authorization_failed"],
      [403, { error: { message: "Project does not have access to model gpt-x", type: "invalid_request_error", code: "model_not_found" } }, "authorization_failed"],
      [401, { error: { code: 401, message: "No auth credentials found" } }, "authentication_failed"],
      [400, { error: { type: "invalid_request_error", message: "max_tokens: 100000 > 8192" } }, "invalid_configuration"],
    ] as const) {
      expect([status, (await refusal(await serve(status, body))).code]).toEqual([status, code]);
    }
  });
});

describe("the gateway meeting a moderation refusal", () => {
  const openrouter = (url: string, fallbackOnFailure?: boolean): ModelProviderProfile => ({
    version: 1, profileId: "openrouter", kind: "openai-compatible", label: "OpenRouter", enabled: true, priority: 0, timeoutMs: 10_000,
    model: "openai/gpt-4o", baseUrl: url, apiProtocol: "chat-completions", credentialRef: "openrouter-key",
    ...(fallbackOnFailure === undefined ? {} : { fallbackOnFailure }),
  });
  const local: ModelProviderProfile = { version: 1, profileId: "local", kind: "anthropic", label: "备用", enabled: true, priority: 1, timeoutMs: 10_000,
    model: "claude-haiku-4-5", baseUrl: "https://api.anthropic.com", apiProtocol: "messages", credentialRef: "local-key" };
  const request: StructuredGenerationRequest = { requestId: "draft", purpose: "methodology-extraction", promptVersion: "v1", schemaVersion: "v1", locale: "zh-CN",
    systemPrompt: "只返回结构化候选。", userPrompt: typed, outputSchema: { type: "object" }, maxOutputTokens: 256 };
  /** A backend that answers: one that does not run the same moderation. */
  const answering = () => ({
    id: "anthropic" as const,
    status: async () => ({ id: "anthropic" as const, availability: "available" as const }),
    invoke: async (): Promise<never> => { throw new Error("not asked to classify"); },
    classify: async (): Promise<never> => { throw new Error("not asked to classify"); },
    close: async () => undefined,
    generate: async (sent: StructuredGenerationRequest) => ({ parsedOutput: { title: "可逆优先" }, visibleOutput: "{\"title\":\"可逆优先\"}", usage: { source: "unavailable" as const }, providerDurationMs: 5,
      traceInput: { systemPrompt: sent.systemPrompt, userPrompt: sent.userPrompt, outputSchema: sent.outputSchema, clientSystemPromptVisibility: "visible" as const } }),
  });
  const gatewayOver = (profiles: ModelProviderProfile[]) => {
    const traces: ModelTraceRecordInput[] = [];
    const factory = vi.fn((profile: ModelProviderProfile): SemanticClassifier => profile.profileId === "openrouter"
      ? new OpenAICompatibleAdapter({ profile, credentials: { get: async () => "openrouter-test-key" } })
      : answering());
    const gateway = new ProfiledModelGateway({
      profiles: { load: async () => profiles },
      providerFactory: factory,
      traces: { record: async (trace) => { traces.push(trace); return trace as ModelInvocationTrace; } },
      audit: { fingerprint: async () => "f".repeat(64), record: async () => ({}), summary: async () => ({ total: 0, processed: 0, high: 0, medium: 0, failures: 0, stages: {}, errorCodes: {} }) },
    });
    return { gateway, traces, factory };
  };

  it("files it as a failed call, not a refused key, and answers from the next backend", async () => {
    const { gateway, traces } = gatewayOver([openrouter(await serve(403, moderated)), local]);

    await expect(gateway.generate(request, (value) => value)).resolves.toMatchObject({ profileId: "local" });
    expect(traces.map((trace) => [trace.profile.profileId, trace.status, trace.errorCode])).toEqual([
      ["openrouter", "failed", "content_refused"],
      ["local", "succeeded", undefined],
    ]);
    expect(traces[0]!.diagnosticExcerpt).toContain("flagged for");
    expect(traces[0]!.diagnosticExcerpt).not.toContain(typed);
  });

  it("stops there when the reader turned its fallback off, saying why", async () => {
    const { gateway, traces, factory } = gatewayOver([openrouter(await serve(403, moderated), false), local]);

    await expect(gateway.generate(request, (value) => value)).rejects.toMatchObject({ name: "ProfiledModelGatewayError", failureCode: "content_refused" });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(traces).toHaveLength(1);
  });

  it("tells the settings test what the moderation said", async () => {
    const { gateway } = gatewayOver([openrouter(await serve(403, moderated))]);

    const result = await gateway.testProfile("openrouter");

    expect(result).toMatchObject({ ok: false, errorCode: "content_refused" });
    expect(result.diagnosticExcerpt).toContain("flagged for");
    expect(result.diagnosticExcerpt).not.toContain(typed);
  });
});

describe("an answer the provider's moderation stopped, sent back as a 200", () => {
  const remote = (kind: "openai" | "anthropic" | "openai-compatible", apiProtocol: "responses" | "messages" | "chat-completions", url: string): ModelProviderProfile => ({
    version: 1, profileId: `remote-${kind}`, kind, label: kind, enabled: true, priority: 0, timeoutMs: 10_000, model: "test-model", baseUrl: url, apiProtocol, credentialRef: "remote-key" });
  const credentials = { get: async () => "remote-test-key" };
  const request: StructuredGenerationRequest = { requestId: "draft", purpose: "methodology-extraction", promptVersion: "v1", schemaVersion: "v1", locale: "zh-CN",
    systemPrompt: "只返回结构化候选。", userPrompt: typed, outputSchema: { type: "object" }, maxOutputTokens: 256 };
  const refused = (call: Promise<unknown>) => call.then(() => { throw new Error("expected a refusal"); }, (error: unknown) => error as ModelProviderError);

  it("is content_refused from Anthropic's safety classifiers, with the category and explanation they gave", async () => {
    // A refusal is a 200 with stop_reason refusal and stop_details (platform.claude.com, Refusals and fallback); a part
    // written before it is to be discarded, so the text here is not read as an answer.
    const url = await serve(200, { id: "msg_refused", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "{\"title\":\"可逆优先\"}" }],
      stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "This request was declined because it could enable cyber harm." },
      usage: { input_tokens: 412, output_tokens: 0 } });
    const adapter = new AnthropicMessagesAdapter({ profile: remote("anthropic", "messages", url), credentials });

    for (const failure of [await refused(adapter.generate(request)), await refused(adapter.invoke({ pairId: "pair-1", assistantText: "先提交还是先修复？", userText: "先修复", locale: "zh-CN" }))]) {
      expect(failure).toMatchObject({ code: "content_refused", providerRequestId: "msg_refused", usage: { source: "provider_reported", inputTokens: 412 } });
      expect(failure.diagnosticExcerpt).toContain("stop_reason=refusal · category=cyber · This request was declined because it could enable cyber harm.");
    }
  });

  it("is content_refused when a chat answer ends at the content filter, whatever it holds", async () => {
    // finish_reason content_filter: content left out for a flag from the content filters (OpenAI's ChatCompletion); Azure
    // may send a part of it, OpenRouter a model's refusal in message.refusal. Neither is quoted.
    for (const message of [{ role: "assistant", content: null, refusal: "I can't help with that." }, { role: "assistant", content: "{\"title\":\"可" }]) {
      const url = await serve(200, { id: "chatcmpl_filtered", model: "test-model", choices: [{ index: 0, finish_reason: "content_filter", message }],
        usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 } });

      const failure = await refused(new OpenAICompatibleAdapter({ profile: remote("openai-compatible", "chat-completions", url), credentials }).generate(request));

      expect(failure).toMatchObject({ code: "content_refused", providerRequestId: "chatcmpl_filtered", usage: { inputTokens: 30 } });
      expect(failure.diagnosticExcerpt).toContain("finish_reason=content_filter");
      expect(failure.diagnosticExcerpt).not.toMatch(/help with that|title/u);
    }
  });

  it("is content_refused when a Responses answer stops incomplete at the content filter", async () => {
    // incomplete_details.reason content_filter (OpenAI's Response object), for OpenAI and a compatible service alike.
    const url = await serve(200, { id: "resp_filtered", model: "test-model", status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] });

    for (const adapter of [new OpenAIResponsesAdapter({ profile: remote("openai", "responses", url), credentials }),
      new OpenAICompatibleAdapter({ profile: remote("openai-compatible", "responses", url), credentials })]) {
      const failure = await refused(adapter.generate(request));

      expect(failure).toMatchObject({ code: "content_refused", providerRequestId: "resp_filtered" });
      expect(failure.diagnosticExcerpt).toContain("incomplete_reason=content_filter");
    }
  });
});

beforeEach(() => vi.stubEnv("MODEL_ALLOW_LOOPBACK", "true"));
afterEach(() => vi.unstubAllEnvs());
