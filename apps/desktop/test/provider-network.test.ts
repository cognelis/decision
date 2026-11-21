import { AnthropicMessagesAdapter } from "../src/main/model/adapters/anthropic-messages-adapter.js";
import { OpenAIResponsesAdapter } from "../src/main/model/adapters/openai-responses-adapter.js";
import { CodexCliAdapter } from "../src/main/model/adapters/codex-cli-adapter.js";
import { ClaudeCodeCliAdapter } from "../src/main/model/adapters/claude-code-cli-adapter.js";
import { ManagedChildProcessRunner } from "../src/main/model/cli/managed-child-process.js";
import { OpenRouterDecisionClient } from "../src/main/model/openrouter-decision-client.js";
import { ProfiledModelGateway } from "../src/main/model/profiled-model-gateway.js";
import type { ModelProviderProfile, ModelInvocationTrace, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import type { ModelNetworkAudit } from "../src/main/model/http-model-transport.js";
import { OpenAICompatibleAdapter } from "../src/main/model/adapters/openai-compatible-adapter.js";
import { createServer, type Server, type RequestListener } from "node:http";
import { connect } from "node:net";
import { createServer as createSecureServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelProviderProfileSchema, modelProxySchema } from "@cognelis/decision-protocol";
import { HttpModelTransport } from "../src/main/model/http-model-transport.js";
import { ModelNetworkPolicy, modelNetworkEnvironment } from "../src/main/model/provider-network.js";
import { minimalClientEnvironment } from "../src/main/model/cli/cli-adapter-support.js";
const servers: Server[] = []; const sockets = new Set<Duplex>();
// Loopback fixtures receive the default required policy; direct exceptions are tested separately.
const listen = async (server: Server) => { servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("no address"); return `http://127.0.0.1:${address.port}`; };
afterEach(async () => { for (const socket of sockets) socket.destroy(); sockets.clear(); await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
const setup = async (reply: unknown = { ok: true }, tls?: { key: string; cert: string }) => {
  const response = { status: 200, reply, chunks: false, disconnect: false, raw: undefined as string | undefined, contentType: "application/json" };
  const received: { url: string | undefined; auth: string | undefined; proxyAuth: string | undefined }[] = []; const tunnels: string[] = []; const proxyAuth: (string | undefined)[] = [];
  const handler: RequestListener = (req, res) => { received.push({ url: req.url, auth: req.headers.authorization, proxyAuth: req.headers["proxy-authorization"] as string | undefined }); res.writeHead(response.status, { "content-type": response.contentType });
    const body = response.raw ?? JSON.stringify(response.reply);
    if (response.disconnect) { res.write(body.slice(0, 10)); setTimeout(() => res.destroy(), 5); }
    else if (response.chunks) { res.write(body.slice(0, 10)); setTimeout(() => res.end(body.slice(10)), 5); }
    else res.end(body); };
  const address = await listen(tls ? createSecureServer(tls, handler) : createServer(handler));
  const target = tls ? address.replace("http:", "https:") : address;
  const server = createServer();
  server.on("connect", (req, client, head) => {
    tunnels.push(req.url!); proxyAuth.push(req.headers["proxy-authorization"] as string | undefined);
    const destination = new URL(target);
    if (req.url !== destination.host) { client.destroy(); return; }
    const upstream = connect(Number(destination.port), "127.0.0.1", () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    sockets.add(client); sockets.add(upstream); client.on("error", () => upstream.destroy()); upstream.on("error", () => client.destroy()); client.on("close", () => upstream.destroy());
  });
  const proxy = await listen(server);
  const request = { url: `${target}/v1/responses`, headers: { authorization: "Bearer test-model-credential" }, body: { input: "test" }, timeoutMs: 1000, maximumResponseBytes: 1024, secrets: ["test-model-credential"] };
  return { proxy, target, request, received, tunnels, proxyAuth, response };
};
describe("model provider network routing", () => {
  it("uses a real CONNECT proxy and overrides an inherited bypass-all setting", async () => {
    const fixture = await setup();
    const result = await new HttpModelTransport({ NO_PROXY: "*" }).postJson({ ...fixture.request, proxy: { mode: "custom", url: fixture.proxy } });
    expect(result.json).toEqual({ ok: true }); expect(fixture.tunnels).toEqual([new URL(fixture.target).host]);
    expect(fixture.received).toEqual([{ url: "/v1/responses", auth: "Bearer test-model-credential", proxyAuth: undefined }]);
  });
  it("routes an actual remote adapter generation through the configured proxy", async () => {
    const fixture = await setup({ model: "test-model", choices: [{ message: { content: JSON.stringify({ title: "代理链路通过" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    const adapter = new OpenAICompatibleAdapter({ profile: { version: 1, profileId: "proxied", kind: "openai-compatible", label: "test", enabled: true, priority: 0, model: "test-model", baseUrl: fixture.target, apiProtocol: "chat-completions", timeoutMs: 1000, credentialRef: "test-credential", proxy: { mode: "custom", url: fixture.proxy } }, credentials: { get: async () => "test-model-credential" }, transport: new HttpModelTransport({}) });
    const result = await adapter.generate({ requestId: "proxy-generation", purpose: "methodology-extraction", promptVersion: "test", schemaVersion: "test", locale: "zh-CN", systemPrompt: "返回 JSON", userPrompt: "测试", outputSchema: { type: "object", properties: { title: { type: "string" } } }, maxOutputTokens: 100 });
    expect(result.parsedOutput).toEqual({ title: "代理链路通过" }); expect(fixture.tunnels).toHaveLength(1); expect(fixture.received[0]?.url).toBe("/v1/chat/completions");
  });
  it("uses authenticated MODEL_PROXY_URL, keeping proxy auth off the target", async () => {
    const fixture = await setup(); const uri = new URL(fixture.proxy); uri.username = "proxy-user"; uri.password = "proxy-password";
    await new HttpModelTransport({ MODEL_PROXY_URL: uri.toString() }).postJson(fixture.request);
    expect(fixture.proxyAuth[0]).toBe(`Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`);
    expect(fixture.received[0]?.proxyAuth).toBeUndefined();
  });
  it("allows direct loopback only when explicitly configured", async () => {
    const fixture = await setup();
    const transport = new HttpModelTransport({});
    await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(transport.postJson({ ...fixture.request, proxy: { mode: "custom", url: fixture.proxy, noProxy: "127.0.0.1" } })).rejects.toMatchObject({ code: "invalid_configuration" });
    await transport.postJson({ ...fixture.request, proxy: { mode: "direct" } });
    expect(fixture.received).toHaveLength(1); expect(fixture.tunnels).toEqual([]);
  });
  it("does not fall back to a direct connection when the configured proxy refuses a tunnel", async () => {
    const fixture = await setup();
    const failedProxy = createServer(); failedProxy.on("connect", (_req, socket) => { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); });
    const url = await listen(failedProxy);
    await expect(new HttpModelTransport({}).postJson({ ...fixture.request, proxy: { mode: "custom", url } })).rejects.toMatchObject({ code: "network_error" });
    expect(fixture.received).toHaveLength(0);
  });
  it("cancels before sending, times out response bodies, and classifies non-JSON rate-limit errors", async () => {
    const fixture = await setup(); const controller = new AbortController(); controller.abort();
    await expect(new HttpModelTransport({}).postJson({ ...fixture.request, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" }); expect(fixture.received).toHaveLength(0);
    const stalled = await listen(createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"partial":'); }));
    await expect(new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({ ...fixture.request, url: stalled, timeoutMs: 25 })).rejects.toMatchObject({ code: "timeout" });
    const limited = await listen(createServer((_req, res) => { res.writeHead(429); res.end("try later"); }));
    await expect(new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" }).postJson({ ...fixture.request, url: limited })).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("builds one required CLI proxy environment, clearing every bypass", () => {
    const environment = { MODEL_PROXY_URL: "http://127.0.0.1:7890", HOME: "/home/test", PATH: "/bin", http_proxy: "http://old:8080", HTTPS_PROXY: "http://old:8080", NO_PROXY: "*", no_proxy: "*", PRIVATE_KEY: "not inherited" };
    const required = minimalClientEnvironment(environment);
    expect(required).toMatchObject({ MODEL_PROXY_URL: environment.MODEL_PROXY_URL, HTTP_PROXY: environment.MODEL_PROXY_URL, HTTPS_PROXY: environment.MODEL_PROXY_URL, ALL_PROXY: environment.MODEL_PROXY_URL, http_proxy: environment.MODEL_PROXY_URL, https_proxy: environment.MODEL_PROXY_URL, all_proxy: environment.MODEL_PROXY_URL, NO_PROXY: "", no_proxy: "", PARASELF_PROVIDER_CHILD: "1", DECISION_PROVIDER_CHILD: "1" });
    expect(required.PRIVATE_KEY).toBeUndefined(); expect(environment.NO_PROXY).toBe("*");
    expect(minimalClientEnvironment({}, [], { mode: "custom", url: "http://proxy.test:8080" })).toMatchObject({ MODEL_PROXY_URL: "http://proxy.test:8080", NO_PROXY: "", no_proxy: "" });
    for (const proxy of [{ mode: "direct" }, { mode: "custom", url: "http://proxy.test:8080", noProxy: "*" }] as const) expect(() => minimalClientEnvironment(environment, [], proxy)).toThrow();
    for (const value of [undefined, "", "invalid", "socks5://proxy.test:1080"]) expect(() => minimalClientEnvironment(value === undefined ? {} : { MODEL_PROXY_URL: value })).toThrow();
  });
  it("rejects stored proxy secrets and unsupported configurations", () => {
    const authenticated = new URL("http://proxy:8080"); authenticated.username = "user"; authenticated.password = "password";
    for (const url of ["socks5://localhost:1080", authenticated.toString(), "http://proxy/path", "http://proxy?token=x"]) expect(modelProxySchema.safeParse({ mode: "custom", url }).success).toBe(false);
    expect(modelProxySchema.safeParse({ mode: "custom" }).success).toBe(false);
    expect(modelProviderProfileSchema.safeParse({ version: 1, profileId: "local", kind: "qwen", label: "local", enabled: true, priority: 0, model: "qwen", timeoutMs: 1000, proxy: { mode: "direct" } }).success).toBe(false);
  });
});


const generation: StructuredGenerationRequest = {
  requestId: "proxy-integration", purpose: "methodology-extraction", promptVersion: "test", schemaVersion: "test",
  locale: "zh-CN", systemPrompt: "返回 JSON", userPrompt: "敏感测试内容不可进入网络日志", outputSchema: { type: "object", properties: { decisionIntent: { type: "string" } }, required: ["decisionIntent"] }, maxOutputTokens: 100,
};
const semantic = { pairId: "proxy-test", assistantText: "先修复还是先提交？", userText: "先修复", locale: "zh-CN" as const };
const visible = JSON.stringify({ decisionIntent: "decision", answerRelation: "answers", question: "先修复还是先提交？", optionLabels: ["先修复", "先提交"], answerExcerpt: "先修复", confidence: 0.95 });
const reply = {
  model: "test-model", choices: [{ message: { content: visible }, finish_reason: "stop" }],
  output: [{ type: "message", content: [{ type: "output_text", text: visible }] }],
  content: [{ type: "text", text: visible }], stop_reason: "end_turn",
  answers: { adopted: { type: "noul", noul: 0.91 } },
};
const profileFor = (kind: ModelProviderProfile["kind"], target: string, protocol: ModelProviderProfile["apiProtocol"] = "chat-completions"): ModelProviderProfile => ({
  version: 1, profileId: kind, kind, label: kind, enabled: true, priority: 0, model: "test-model", baseUrl: target,
  apiProtocol: protocol, timeoutMs: 1_000, credentialRef: "fake-key-ref",
});
const credentials = { get: async () => "synthetic-model-key-123456789" };
const protocols = [
  ["openai", "responses", OpenAIResponsesAdapter],
  ["anthropic", "messages", AnthropicMessagesAdapter],
  ["openai-compatible", "chat-completions", OpenAICompatibleAdapter],
  ["openai-compatible", "responses", OpenAICompatibleAdapter],
] as const;

describe("Fail-Closed 模型网络故障注入", () => {
  it.each(protocols)("%s / %s 的生成、分类、分块响应和代理断开", async (kind, protocol, Adapter) => {
    const fixture = await setup(reply);
    fixture.response.chunks = true;
    const events: ModelNetworkAudit[] = [];
    const environment = { MODEL_PROXY_URL: fixture.proxy, NO_PROXY: "*", no_proxy: "*" };
    const transport = new HttpModelTransport(environment, { audit: event => events.push(event) });
    const adapter = new Adapter({ profile: profileFor(kind, fixture.target, protocol), credentials, transport });
    expect((await adapter.generate(generation)).parsedOutput).toMatchObject({ decisionIntent: "decision" });
    expect((await adapter.invoke(semantic)).classification.decisionIntent).toBe("decision");
    expect(fixture.tunnels).toHaveLength(2); expect(fixture.received).toHaveLength(2);
    // A closed ephemeral port is a proxy connection failure, not an API/model error.
    const closed = createServer(); const dead = await listen(closed); await new Promise<void>(resolve => closed.close(() => resolve()));
    environment.MODEL_PROXY_URL = dead;
    await expect(adapter.generate(generation)).rejects.toMatchObject({ code: "network_error", message: "Model proxy connection failed" });
    await expect(adapter.invoke(semantic)).rejects.toMatchObject({ code: "network_error" });
    expect(fixture.received).toHaveLength(2);
    expect(events.slice(-2).every(event => event.result === "proxy_failed")).toBe(true);
    environment.MODEL_PROXY_URL = fixture.proxy;
    expect((await adapter.generate(generation)).parsedOutput).toMatchObject({ decisionIntent: "decision" });
    expect(fixture.received).toHaveLength(3);
    expect(events[0]).toMatchObject({ provider: kind, model: "test-model", policy: "required", route: "proxy", result: "succeeded" });
    expect(JSON.stringify(events)).not.toContain(generation.userPrompt);
    expect(JSON.stringify(events)).not.toContain(await credentials.get());
  });

  it.each([undefined, "", "not-a-url", "socks5://127.0.0.1:1080", "http://proxy/path", "http://proxy?token=secret", "http://pro\nxy:8080"])("缺失或异常代理 %s 时没有模型出站", async value => {
    const fixture = await setup();
    const transport = new HttpModelTransport(value === undefined ? { HTTPS_PROXY: fixture.proxy } : { MODEL_PROXY_URL: value });
    await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(transport.getJson(fixture.request)).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fixture.received).toEqual([]); expect(fixture.tunnels).toEqual([]);
  });

  it("环境 NO_PROXY 不能绕过，配置 bypass 和外部 direct 被拒绝，动态地址重新检查", async () => {
    const fixture = await setup();
    const transport = new HttpModelTransport({ MODEL_PROXY_URL: fixture.proxy, NO_PROXY: "*", no_proxy: "*" });
    await transport.postJson(fixture.request);
    await expect(transport.postJson({ ...fixture.request, proxy: { mode: "custom", url: fixture.proxy, noProxy: "*" } })).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(transport.postJson({ ...fixture.request, url: "https://external.invalid/v1/responses", proxy: { mode: "direct" } })).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fixture.received).toHaveLength(1); expect(fixture.tunnels).toHaveLength(1);
    const local = new HttpModelTransport({ MODEL_ALLOW_LOOPBACK: "true" });
    await local.postJson(fixture.request);
    await expect(local.postJson({ ...fixture.request, url: "https://external.invalid/v1/responses" })).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fixture.received).toHaveLength(2);
  });

  it("loopback 例外只允许明确的本机地址，并固定 localhost 的目标", () => {
    const policy = new ModelNetworkPolicy({ MODEL_ALLOW_LOOPBACK: "true" });
    const localhost = new URL("http://localhost:1234/v1/responses");
    expect(policy.route(localhost)).toEqual({ kind: "loopback" });
    expect(localhost.hostname).toBe("127.0.0.1");
    expect(policy.route(new URL("http://[::1]:1234/v1/responses"))).toEqual({ kind: "loopback" });
    expect(() => policy.route(new URL("https://192.168.1.1/v1/responses"))).toThrow();
    expect(() => new ModelNetworkPolicy({}).route(new URL("http://127.0.0.1:1234"))).toThrow();
  });

  it("无效 MODEL_PROXY_URL 不会降级到有效的 profile 代理，GET 探测成功也须 CONNECT", async () => {
    const fixture = await setup();
    await expect(new HttpModelTransport({ MODEL_PROXY_URL: "" }).getJson({ ...fixture.request, proxy: { mode: "custom", url: fixture.proxy } })).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fixture.received).toHaveLength(0);
    const events: ModelNetworkAudit[] = [];
    const uri = new URL(fixture.proxy); uri.username = "private-proxy-user"; uri.password = "private-proxy-password";
    const transport = new HttpModelTransport({ MODEL_PROXY_URL: uri.href }, { audit: event => events.push(event) });
    await transport.getJson({ ...fixture.request, provider: "catalog", model: "private-proxy-password" });
    expect(fixture.tunnels).toHaveLength(1); expect(fixture.received).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("private-proxy-user");
    expect(JSON.stringify(events)).not.toContain("private-proxy-password");
    expect(JSON.stringify(events)).not.toContain(uri.href);
  });

  it("鉴权、模型和限流错误来自模型服务，代理错误不触达服务", async () => {
    const fixture = await setup({ error: { message: "synthetic error" } });
    const events: ModelNetworkAudit[] = [];
    const transport = new HttpModelTransport({ MODEL_PROXY_URL: fixture.proxy }, { audit: event => events.push(event) });
    for (const [status, code] of [[401, "authentication_failed"], [404, "invalid_configuration"], [429, "rate_limited"], [503, "provider_unavailable"]]) {
      fixture.response.status = Number(status);
      await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code });
      expect(events.at(-1)).toMatchObject({ route: "proxy", result: "failed", status });
    }
    expect(fixture.received).toHaveLength(4);
    expect(fixture.tunnels).toHaveLength(4);
  });

  it("Decisions 两种协议和判定 fallback 也没有直连退路", async () => {
    const fixture = await setup(reply);
    const deadServer = createServer(); const dead = await listen(deadServer); await new Promise<void>(resolve => deadServer.close(() => resolve()));
    const profiles: ModelProviderProfile[] = [
      { ...profileFor("openrouter-decisions", `${fixture.target}/v1/decisions`), profileId: "bad-proxy", proxy: { mode: "custom", url: dead } },
      { ...profileFor("openrouter-decisions", `${fixture.target}/v1/decisions`), profileId: "good-proxy", priority: 1, proxy: { mode: "custom", url: fixture.proxy } },
    ];
    const client = new OpenRouterDecisionClient({ profiles: { load: async () => profiles }, credentials, traces: { record: async () => undefined }, transport: new HttpModelTransport({}) });
    const request = { state: "test", questions: { adopted: { type: "noul" as const, instructions: "adopted?" } } };
    expect((await client.decideIfAvailable(request, { feature: "proxy-test" }))?.profileId).toBe("good-proxy");
    expect(fixture.received).toHaveLength(1); expect(fixture.tunnels).toHaveLength(1);
    profiles[1] = { ...profiles[1]!, decisionsProtocol: "openai" };
    fixture.response.reply = { ...reply, answers: [{ name: "adopted", type: "predicate", probability: 0.91 }] };
    expect((await client.decideIfAvailable(request, { feature: "proxy-test" }))?.answers.adopted).toEqual({ type: "noul", noul: 0.91 });
    expect(fixture.received).toHaveLength(2);
    profiles[1] = { ...profiles[1]!, proxy: { mode: "custom", url: dead } };
    expect(await client.decideIfAvailable(request, { feature: "proxy-test" })).toBeNull();
    expect(fixture.received).toHaveLength(2);
  });

  it("Gateway fallback 和重复重试始终重新执行网络策略", async () => {
    const fixture = await setup(reply);
    const deadServer = createServer(); const dead = await listen(deadServer); await new Promise<void>(resolve => deadServer.close(() => resolve()));
    const events: ModelNetworkAudit[] = [];
    const transport = new HttpModelTransport({}, { audit: event => events.push(event) });
    const profiles = [
      { ...profileFor("openai", fixture.target, "responses"), proxy: { mode: "custom" as const, url: dead } },
      { ...profileFor("anthropic", fixture.target, "messages"), priority: 1, proxy: { mode: "custom" as const, url: fixture.proxy } },
    ];
    const gateway = new ProfiledModelGateway({
      profiles: { load: async () => profiles },
      providerFactory: profile => profile.kind === "openai" ? new OpenAIResponsesAdapter({ profile, credentials, transport }) : new AnthropicMessagesAdapter({ profile, credentials, transport }),
      traces: { record: async input => ({ ...input, version: 1, traceId: "test-trace", contentMode: "full", createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() }) as ModelInvocationTrace },
      audit: { fingerprint: async () => "a".repeat(64), record: async () => ({}), summary: async () => ({ total: 0, processed: 0, high: 0, medium: 0, failures: 0, stages: {}, errorCodes: {} }) },
    });
    expect((await gateway.generate(generation, value => value)).parsedOutput).toMatchObject({ decisionIntent: "decision" });
    expect(fixture.received).toHaveLength(1);
    expect(events.map(event => event.result)).toEqual(["proxy_failed", "succeeded"]);
    profiles[1]!.proxy.url = dead;
    for (let retry = 0; retry < 2; retry++) await expect(gateway.generate(generation, value => value)).rejects.toThrow();
    expect(fixture.received).toHaveLength(1);
    expect(events.slice(2).every(event => event.result === "proxy_failed")).toBe(true);
  });

  it("CLI 无有效代理时在 spawn 前拒绝，有代理时统一变量并清空绕过", async () => {
    const spawnProcess = vi.fn();
    const blocked = new ManagedChildProcessRunner({ modelNetworkPolicy: "required", spawnProcess });
    const request = { executable: process.execPath, args: ["-e", ""], stdin: "", cwd: process.cwd(), timeoutMs: 1000, maximumStdoutBytes: 1024, maximumStderrBytes: 1024, environment: {} };
    await expect(blocked.run(request)).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(spawnProcess).not.toHaveBeenCalled();
    const runner = new ManagedChildProcessRunner({ modelNetworkPolicy: "required" });
    const output = await runner.run({ ...request, args: ["-e", 'console.log(JSON.stringify(process.env))'], environment: { MODEL_PROXY_URL: "http://127.0.0.1:7890", HTTP_PROXY: "http://old:8080", NO_PROXY: "*", no_proxy: "*", CLAUDE_CODE_PROXY_URL: "http://untrusted:8080" } });
    expect(JSON.parse(output.stdout)).toMatchObject({ MODEL_PROXY_URL: "http://127.0.0.1:7890", HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "", no_proxy: "" });
    expect(JSON.parse(output.stdout).CLAUDE_CODE_PROXY_URL).toBeUndefined();
    for (const [kind, Adapter] of [["codex-cli", CodexCliAdapter], ["claude-code-cli", ClaudeCodeCliAdapter]] as const) {
      const adapter = new Adapter({ profile: { version: 1, profileId: kind, kind, label: kind, enabled: true, priority: 0, timeoutMs: 1000, executablePath: process.execPath }, environment: {} });
      await expect(adapter.generate(generation)).rejects.toMatchObject({ code: "invalid_configuration" });
      await expect(adapter.invoke(semantic)).rejects.toMatchObject({ code: "invalid_configuration" });
    }
  });

});


describe("TLS 与流中断", () => {
  it("HTTPS CONNECT 验证服务证书，代理断开后不发送直连 TLS 请求", async () => {
    const directory = await mkdtemp(join(tmpdir(), "model-proxy-tls-"));
    const previous = getCACertificates("default");
    try {
      const keyPath = join(directory, "key.pem"); const certPath = join(directory, "cert.pem");
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
      const cert = await readFile(certPath, "utf8");
      setDefaultCACertificates([...previous, cert]);
      const fixture = await setup({ ok: true }, { key: await readFile(keyPath, "utf8"), cert });
      const environment = { MODEL_PROXY_URL: fixture.proxy };
      const transport = new HttpModelTransport(environment);
      expect((await transport.postJson(fixture.request)).json).toEqual({ ok: true });
      expect(fixture.tunnels).toEqual([new URL(fixture.target).host]);
      const closed = createServer(); environment.MODEL_PROXY_URL = await listen(closed); await new Promise<void>(resolve => closed.close(() => resolve()));
      await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code: "network_error" });
      expect(fixture.received).toHaveLength(1);
    } finally {
      setDefaultCACertificates(previous);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("现有 JSON 入口通过代理接收 SSE 后拒绝，不另开连接", async () => {
    const fixture = await setup(); fixture.response.raw = 'data: {"token":"hello"}\n\ndata: [DONE]\n\n'; fixture.response.contentType = "text/event-stream";
    await expect(new HttpModelTransport({ MODEL_PROXY_URL: fixture.proxy }).postJson(fixture.request)).rejects.toMatchObject({ code: "invalid_output" });
    expect(fixture.tunnels).toHaveLength(1); expect(fixture.received).toHaveLength(1);
  });

  it("响应流中断不会触发隐式重试或直连", async () => {
    const fixture = await setup(); fixture.response.disconnect = true;
    const transport = new HttpModelTransport({ MODEL_PROXY_URL: fixture.proxy });
    await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code: "network_error" });
    expect(fixture.received).toHaveLength(1); expect(fixture.tunnels).toHaveLength(1);
    fixture.response.disconnect = false;
    await transport.postJson(fixture.request);
    expect(fixture.received).toHaveLength(2); expect(fixture.tunnels).toHaveLength(2);
  });
});

it("applies saved global proxy changes immediately to HTTP and CLI while preserving environment precedence", async () => {
  const fixture = await setup(); let saved: string | null = null;
  const environment = modelNetworkEnvironment({}, () => saved);
  const transport = new HttpModelTransport(environment);
  await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(() => minimalClientEnvironment(environment)).toThrow();
  saved = fixture.proxy;
  await transport.postJson(fixture.request);
  expect(minimalClientEnvironment(environment)).toMatchObject({ MODEL_PROXY_URL: saved, NO_PROXY: "", no_proxy: "" });
  saved = "invalid";
  await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(() => minimalClientEnvironment(environment)).toThrow(); expect(fixture.received).toHaveLength(1);
  saved = null;
  await expect(transport.postJson(fixture.request)).rejects.toMatchObject({ code: "invalid_configuration" });
  await transport.postJson({ ...fixture.request, proxy: { mode: "custom", url: fixture.proxy } });
  const overridden = new HttpModelTransport(modelNetworkEnvironment({ MODEL_PROXY_URL: "invalid" }, () => fixture.proxy));
  await expect(overridden.postJson(fixture.request)).rejects.toMatchObject({ code: "invalid_configuration" });
  expect(fixture.received).toHaveLength(2);
});

it("keeps delayed login-shell environment updates visible to CLI discovery", () => {
  const source: NodeJS.ProcessEnv = { PATH: "/initial" };
  const environment = modelNetworkEnvironment(source, () => "http://127.0.0.1:7890");
  source.PATH = "/updated"; source.CODEX_HOME = "/client-home";
  expect(environment.PATH).toBe("/updated");
  expect(minimalClientEnvironment(environment)).toMatchObject({ PATH: "/updated", CODEX_HOME: "/client-home", MODEL_PROXY_URL: "http://127.0.0.1:7890" });
  expect(source.MODEL_PROXY_URL).toBeUndefined();
});

it.each(["systemone", "openai"] as const)("global proxy also governs %s decision models", async decisionsProtocol => {
  const fixture = await setup(decisionsProtocol === "openai" ? { ...reply, answers: [{ name: "adopted", type: "predicate", probability: 0.91 }] } : reply);
  const closed = createServer(); const dead = await listen(closed); await new Promise<void>(resolve => closed.close(() => resolve()));
  let savedProxy = fixture.proxy;
  const transport = new HttpModelTransport(modelNetworkEnvironment({}, () => savedProxy));
  const client = new OpenRouterDecisionClient({ profiles: { load: async () => [{ version: 1, profileId: "global-judge", kind: "openrouter-decisions", label: "Judge", enabled: true, priority: 0, model: "test-model", timeoutMs: 1000, credentialRef: "test-key", baseUrl: fixture.target + "/v1/decisions", decisionsProtocol }] }, credentials, traces: { record: async () => undefined }, transport });
  const request = { state: "synthetic", questions: { adopted: { type: "noul" as const, instructions: "adopted?" } } };
  expect((await client.decide("global-judge", request, { feature: "global-proxy-test" })).answers.adopted).toEqual({ type: "noul", noul: 0.91 });
  expect(fixture.tunnels).toHaveLength(1); expect(fixture.received).toHaveLength(1);
  savedProxy = dead;
  await expect(client.decide("global-judge", request, { feature: "global-proxy-test" })).rejects.toMatchObject({ code: "network_error" });
  expect(fixture.received).toHaveLength(1);
});
