import { OpenAICompatibleAdapter } from "../src/main/model/adapters/openai-compatible-adapter.js";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { modelProviderProfileSchema, modelProxySchema } from "@cognelis/decision-protocol";
import { HttpModelTransport } from "../src/main/model/http-model-transport.js";
import { minimalClientEnvironment } from "../src/main/model/cli/cli-adapter-support.js";
const servers: Server[] = []; const sockets = new Set<Duplex>();
// The targets here are loopback servers standing in for remote endpoints; real loopback traffic never takes a proxy.
const standIn = { proxyLoopback: true };
const listen = async (server: Server) => { servers.push(server); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); if (!address || typeof address === "string") throw new Error("no address"); return `http://127.0.0.1:${address.port}`; };
afterEach(async () => { for (const socket of sockets) socket.destroy(); sockets.clear(); await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });
const setup = async (reply: unknown = { ok: true }) => {
  const received: { url: string | undefined; auth: string | undefined; proxyAuth: string | undefined }[] = []; const tunnels: string[] = []; const proxyAuth: (string | undefined)[] = [];
  const target = await listen(createServer((req, res) => { received.push({ url: req.url, auth: req.headers.authorization, proxyAuth: req.headers["proxy-authorization"] as string | undefined }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(reply)); }));
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
  return { proxy, target, request, received, tunnels, proxyAuth };
};
describe("model provider network routing", () => {
  it("uses a real CONNECT proxy and overrides an inherited bypass-all setting", async () => {
    const fixture = await setup();
    const result = await new HttpModelTransport({ NO_PROXY: "*" }, standIn).postJson({ ...fixture.request, proxy: { mode: "custom", url: fixture.proxy } });
    expect(result.json).toEqual({ ok: true }); expect(fixture.tunnels).toEqual([new URL(fixture.target).host]);
    expect(fixture.received).toEqual([{ url: "/v1/responses", auth: "Bearer test-model-credential", proxyAuth: undefined }]);
  });
  it("routes an actual remote adapter generation through the configured proxy", async () => {
    const fixture = await setup({ model: "test-model", choices: [{ message: { content: JSON.stringify({ title: "代理链路通过" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
    const adapter = new OpenAICompatibleAdapter({ profile: { version: 1, profileId: "proxied", kind: "openai-compatible", label: "test", enabled: true, priority: 0, model: "test-model", baseUrl: fixture.target, apiProtocol: "chat-completions", timeoutMs: 1000, credentialRef: "test-credential", proxy: { mode: "custom", url: fixture.proxy } }, credentials: { get: async () => "test-model-credential" }, transport: new HttpModelTransport(process.env, standIn) });
    const result = await adapter.generate({ requestId: "proxy-generation", purpose: "methodology-extraction", promptVersion: "test", schemaVersion: "test", locale: "zh-CN", systemPrompt: "返回 JSON", userPrompt: "测试", outputSchema: { type: "object", properties: { title: { type: "string" } } }, maxOutputTokens: 100 });
    expect(result.parsedOutput).toEqual({ title: "代理链路通过" }); expect(fixture.tunnels).toHaveLength(1); expect(fixture.received[0]?.url).toBe("/v1/chat/completions");
  });
  it("inherits lowercase proxy variables with authentication, but keeps proxy auth off the target", async () => {
    const fixture = await setup(); const uri = new URL(fixture.proxy); uri.username = "proxy-user"; uri.password = "proxy-password";
    await new HttpModelTransport({ http_proxy: uri.toString() }, standIn).postJson(fixture.request);
    expect(fixture.proxyAuth[0]).toBe(`Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`);
    expect(fixture.received[0]?.proxyAuth).toBeUndefined();
  });
  it("honors explicit bypass hosts and direct mode without using inherited proxy connections", async () => {
    const fixture = await setup();
    const transport = new HttpModelTransport({ HTTPS_PROXY: fixture.proxy, HTTP_PROXY: fixture.proxy });
    await transport.postJson({ ...fixture.request, proxy: { mode: "custom", url: fixture.proxy, noProxy: "127.0.0.1" } });
    await transport.postJson({ ...fixture.request, proxy: { mode: "direct" } });
    expect(fixture.received).toHaveLength(2); expect(fixture.tunnels).toEqual([]);
  });
  it("does not fall back to a direct connection when the configured proxy refuses a tunnel", async () => {
    const fixture = await setup();
    const failedProxy = createServer(); failedProxy.on("connect", (_req, socket) => { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); });
    const url = await listen(failedProxy);
    await expect(new HttpModelTransport({}, standIn).postJson({ ...fixture.request, proxy: { mode: "custom", url } })).rejects.toMatchObject({ code: "network_error" });
    expect(fixture.received).toHaveLength(0);
  });
  it("cancels before sending, times out response bodies, and classifies non-JSON rate-limit errors", async () => {
    const fixture = await setup(); const controller = new AbortController(); controller.abort();
    await expect(new HttpModelTransport({}).postJson({ ...fixture.request, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" }); expect(fixture.received).toHaveLength(0);
    const stalled = await listen(createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.write('{"partial":'); }));
    await expect(new HttpModelTransport({}).postJson({ ...fixture.request, url: stalled, timeoutMs: 25 })).rejects.toMatchObject({ code: "timeout" });
    const limited = await listen(createServer((_req, res) => { res.writeHead(429); res.end("try later"); }));
    await expect(new HttpModelTransport({}).postJson({ ...fixture.request, url: limited })).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("builds isolated CLI environments for inherited, custom and direct modes", () => {
    const environment = { HOME: "/home/test", PATH: "/bin", http_proxy: "http://old:8080", HTTPS_PROXY: "http://old:8080", ALL_PROXY: "http://old:8080", NO_PROXY: "*", no_proxy: "*", PRIVATE_KEY: "not inherited" };
    expect(minimalClientEnvironment(environment)).toMatchObject({ http_proxy: environment.http_proxy, NO_PROXY: "*", no_proxy: "*", ALL_PROXY: environment.ALL_PROXY, DECISION_PROVIDER_CHILD: "1" });
    const custom = minimalClientEnvironment(environment, [], { mode: "custom", url: "http://127.0.0.1:7890" });
    expect(custom).toMatchObject({ HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7890", https_proxy: "http://127.0.0.1:7890", NO_PROXY: "", no_proxy: "" });
    const direct = minimalClientEnvironment(environment, ["HTTP_PROXY"], { mode: "direct" });
    expect(Object.keys(direct).some((key) => /proxy/i.test(key))).toBe(false); expect(direct.PRIVATE_KEY).toBeUndefined(); expect(environment.NO_PROXY).toBe("*");
  });
  it("rejects stored proxy secrets and unsupported configurations", () => {
    const authenticated = new URL("http://proxy:8080"); authenticated.username = "user"; authenticated.password = "password";
    for (const url of ["socks5://localhost:1080", authenticated.toString(), "http://proxy/path", "http://proxy?token=x"]) expect(modelProxySchema.safeParse({ mode: "custom", url }).success).toBe(false);
    expect(modelProxySchema.safeParse({ mode: "custom" }).success).toBe(false);
    expect(modelProviderProfileSchema.safeParse({ version: 1, profileId: "local", kind: "qwen", label: "local", enabled: true, priority: 0, model: "qwen", timeoutMs: 1000, proxy: { mode: "direct" } }).success).toBe(false);
  });
});
