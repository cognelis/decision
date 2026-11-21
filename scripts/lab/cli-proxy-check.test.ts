// @ts-expect-error ws is supplied by the existing test runtime.
import { WebSocketServer } from "ws";
import { spawn, execFileSync } from "node:child_process";
import { createServer as httpServer, type Server } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter, isAbsolute } from "node:path";
import { existsSync, statSync } from "node:fs";
import { expect, it } from "vitest";
import { ManagedChildProcessRunner, ManagedProcessError, type SpawnProcess } from "../../apps/desktop/src/main/model/cli/managed-child-process.js";
import { minimalClientEnvironment } from "../../apps/desktop/src/main/model/cli/cli-adapter-support.js";
// @ts-expect-error Shared isolation entry is an executable ESM module.
import { isolationEnvironment, ISOLATION_KEYS, CODEX_TOOLS_OFF } from "./isolated-app.mjs";

const authenticatedProxy = (port: number) => { const url = new URL(`http://127.0.0.1:${port}`); url.username = "fixture-proxy-user"; url.password = "fixture-proxy-password"; return url.href; };
const enabled = process.env.PARASELF_LIVE_CLI_PROXY === "1";
const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return address.port;
};
const message = { id: "msg_mock", type: "message", role: "assistant", model: "proxy-test-model", content: [{ type: "text", text: "PROXY_OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 2, output_tokens: 2 } };
const frames = (claude: boolean) => claude ? [
  { type: "message_start", message: { ...message, content: [], stop_reason: null } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROXY_OK" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
] : [
  { type: "response.created", response: { id: "resp_mock", object: "response", created_at: 1, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_mock", type: "message", role: "assistant", content: [] } },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_mock", delta: "PROXY_OK" },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_mock", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "PROXY_OK", annotations: [] }] } },
  { type: "response.completed", response: { id: "resp_mock", object: "response", created_at: 1, status: "completed", output: [], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } },
];

it.runIf(enabled).each(["codex", "codex-ws", "claude"] as const)("本机 %s CLI：代理成功、429 重试、断开及恢复", async client => {
  const root = await mkdtemp(join(tmpdir(), `paraself-cli-proxy-${client}-`));
  const sockets = new Set<Duplex>(); const proxyPorts = new Set<number>();
  const received: { proxied: boolean; path: string; proxyAuthForwarded: boolean }[] = []; const tunnels: string[] = [];
  let failures = 0, websocketUpgrades = 0, failureStatus = 429;
  const keyPath = join(root, "key.pem"), certPath = join(root, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  const target = httpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    req.resume();
    const modelRequest = req.method === "POST" && /\/(?:messages|responses)(?:\?|$)/u.test(req.url ?? "");
    if (!modelRequest) { res.writeHead(200, { "content-type": "application/json" }); res.end('{"input_tokens":2,"data":[]}'); return; }
    received.push({ proxied: proxyPorts.has(req.socket.remotePort!), path: req.url!, proxyAuthForwarded: req.headers["proxy-authorization"] !== undefined });
    if (failureStatus === 401 || failures-- > 0) { res.writeHead(failureStatus, { "content-type": "application/json", "retry-after": "0" }); res.end(JSON.stringify({ error: { type: failureStatus === 401 ? "authentication_error" : "rate_limit_error", message: failureStatus === 401 ? "synthetic invalid API key" : "synthetic retry" } })); return; }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    void (async () => { for (const frame of frames(client === "claude")) { res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`); await new Promise(resolve => setTimeout(resolve, 5)); } res.end(); })();
  });
  const websocket = new WebSocketServer({ noServer: true });
  target.on("upgrade", (req, socket, head) => {
    received.push({ proxied: proxyPorts.has(req.socket.remotePort!), path: req.url!, proxyAuthForwarded: req.headers["proxy-authorization"] !== undefined }); websocketUpgrades++;
    if (failureStatus === 401 || failures-- > 0) { socket.end(`HTTP/1.1 ${failureStatus} ${failureStatus === 401 ? "Unauthorized" : "Too Many Requests"}\r\nRetry-After: 0\r\nContent-Length: 0\r\n\r\n`); return; }
    websocket.handleUpgrade(req, socket, head, (ws: { on: (name: string, callback: () => void) => void; send: (value: string) => void }) => {
      ws.on("message", () => { for (const frame of frames(false)) ws.send(JSON.stringify(frame)); });
    });
  });
  target.on("connection", socket => sockets.add(socket));
  const proxy = httpServer();
  let targetPort = 0;
  proxy.on("connect", (req, socket, head) => {
    sockets.add(socket); tunnels.push(req.url!);
    if (req.headers["proxy-authorization"] !== `Basic ${Buffer.from("fixture-proxy-user:fixture-proxy-password").toString("base64")}`) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
    if (req.url !== `127.0.0.1:${targetPort}`) { socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); return; }
    const upstream = connect(targetPort, "127.0.0.1", () => {
      proxyPorts.add(upstream.localPort!);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy()); socket.on("close", () => upstream.destroy());
  });
  try {
    targetPort = await listen(target); const proxyPort = await listen(proxy);
    const base = isolationEnvironment(root, { PATH: process.env.PATH, HOME: join(root, "home"), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), SSL_CERT_FILE: certPath, NODE_EXTRA_CA_CERTS: certPath, CODEX_CA_CERTIFICATE: certPath });
    for (const path of [base.HOME, base.CODEX_HOME, base.CLAUDE_CONFIG_DIR, join(root, "work")]) await mkdir(path, { recursive: true });
    const environment = minimalClientEnvironment({ ...base, MODEL_PROXY_URL: authenticatedProxy(proxyPort), NO_PROXY: "*", no_proxy: "*" }, [...ISOLATION_KEYS, "CLAUDE_CONFIG_DIR"]);
    Object.assign(environment, { ANTHROPIC_BASE_URL: `https://127.0.0.1:${targetPort}`, ANTHROPIC_API_KEY: "synthetic-cli-key", CLI_TEST_API_KEY: "synthetic-cli-key", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_MAX_RETRIES: "1", API_TIMEOUT_MS: "3000" });
    const configured = client !== "claude" ? process.env.PARASELF_CODEX_EXECUTABLE : process.env.PARASELF_CLAUDE_EXECUTABLE;
    const command = configured ?? (process.env.PATH ?? "").split(delimiter).map(directory => join(directory, client === "claude" ? "claude" : "codex")).find(path => isAbsolute(path) && existsSync(path) && statSync(path).isFile());
    if (!command || !isAbsolute(command)) throw new Error("Set an absolute PARASELF_CODEX_EXECUTABLE / PARASELF_CLAUDE_EXECUTABLE");
    const args = client === "claude" ? ["-p", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "", "--no-session-persistence", "--permission-mode", "dontAsk", "--output-format", "json", "--model", "claude-sonnet-4-5"] : ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--model", "gpt-5.1-codex", ...CODEX_TOOLS_OFF.flatMap((setting: string) => ["-c", setting]), "-c", 'model_provider="proxy-test"', "-c", 'model_providers.proxy-test.name="Proxy Test"', "-c", `model_providers.proxy-test.base_url="https://127.0.0.1:${targetPort}/v1"`, "-c", 'model_providers.proxy-test.wire_api="responses"', "-c", 'model_providers.proxy-test.env_key="CLI_TEST_API_KEY"', "-c", `model_providers.proxy-test.supports_websockets=${client === "codex-ws"}`, "-c", `features.responses_websockets=${client === "codex-ws"}`, "-c", `features.responses_websockets_v2=${client === "codex-ws"}`, "-c", 'model_providers.proxy-test.request_max_retries=1', "-c", 'model_providers.proxy-test.stream_max_retries=1', "-"];
    let observed = "";
    const runner = new ManagedChildProcessRunner({ modelNetworkPolicy: "required", spawnProcess: (executable, args, options) => {
      const child = (spawn as SpawnProcess)(executable, args, options);
      child.stdout.on("data", chunk => { observed += chunk; });
      return child;
    } });
    const invoke = async (timeoutMs = 30_000) => {
      observed = "";
      try {
        const result = await runner.run({ provider: client === "claude" ? "claude-code-cli" : "codex-cli", model: "proxy-test-model", executable: command, args, environment, cwd: join(root, "work"), stdin: "Reply with PROXY_OK only.", timeoutMs, maximumStdoutBytes: 2 * 1024 * 1024, maximumStderrBytes: 1024 * 1024 });
        return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: false, errorCode: undefined };
      } catch (error) {
        if (!(error instanceof ManagedProcessError)) throw error;
        return { code: error.processExitCode ?? -1, stdout: observed, stderr: error.diagnosticExcerpt, timedOut: error.code === "timeout", errorCode: error.code };
      }
    };
    const version = await runner.run({ executable: command, args: ["--version"], environment, cwd: join(root, "work"), stdin: "", timeoutMs: 5_000, maximumStdoutBytes: 1024, maximumStderrBytes: 4096 });
    expect(version.exitCode).toBe(0);
    const ok = await invoke();
    expect(ok, JSON.stringify(ok)).toMatchObject({ code: 0, timedOut: false }); expect(ok.stdout).toContain("PROXY_OK");
    expect(received.length).toBeGreaterThan(0); expect(received.every(item => item.proxied)).toBe(true); expect(tunnels.length).toBeGreaterThan(0);
    if (client === "codex-ws") expect(websocketUpgrades).toBeGreaterThan(0);
    failures = 1; const beforeRetry = received.length;
    const retry = await invoke(); expect(retry, JSON.stringify(retry)).toMatchObject({ code: 0, timedOut: false }); expect(retry.stdout).toContain("PROXY_OK");
    expect(received.length - beforeRetry).toBeGreaterThanOrEqual(2); expect(received.every(item => item.proxied)).toBe(true);
    failureStatus = 401; const beforeAuth = received.length;
    const auth = await invoke(10_000);
    expect(auth, JSON.stringify(auth)).toMatchObject({ timedOut: false }); expect(auth.code).not.toBe(0);
    expect(`${auth.stdout}\n${auth.stderr}`).toMatch(/401|Unauthorized|authentication|API.?key/iu);
    expect(received.length).toBeGreaterThan(beforeAuth); expect(received.every(item => item.proxied)).toBe(true);
    failureStatus = 429;
    for (const socket of sockets) socket.destroy(); sockets.clear();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    const beforeDown = received.length; const down = await invoke(10_000);
    expect(down.code).not.toBe(0);
    expect(`${down.stdout}\n${down.stderr}`).toMatch(/connect|proxy|network|request|stream|connection|fetch|API Error/iu);
    expect(received).toHaveLength(beforeDown);
    const downRequests = received.length - beforeDown;
    const recoveredPort = await listen(proxy);
    Object.assign(environment, new (await import("../../apps/desktop/src/main/model/provider-network.js")).ModelNetworkPolicy({ MODEL_PROXY_URL: authenticatedProxy(recoveredPort) }).cliEnvironment());
    const recovered = await invoke(); expect(recovered, JSON.stringify(recovered)).toMatchObject({ code: 0, timedOut: false }); expect(recovered.stdout).toContain("PROXY_OK");
    expect(received.every(item => item.proxied)).toBe(true);
    expect(received.every(item => !item.proxyAuthForwarded)).toBe(true);
    const report = { client, version: version.stdout.trim(), streaming: "passed", websocketUpgrades, retry: "passed", authenticationFailure: "distinguished", proxyAuthentication: "passed", down: { exitCode: down.code, errorCode: down.errorCode, deadlineReached: down.timedOut, additionalModelRequests: downRequests }, recovery: "passed", directRequests: received.filter(item => !item.proxied).length };
    if (process.env.PARASELF_CLI_PROXY_REPORT) await writeFile(`${process.env.PARASELF_CLI_PROXY_REPORT}-${client}.json`, JSON.stringify(report, null, 2));
    console.info("cli-proxy-check", JSON.stringify(report));
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([proxy, target].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(root, { recursive: true, force: true });
  }
}, 100_000);
