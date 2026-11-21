// R10-LL active fault probes. All app/model data lives under the caller's isolated --root.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createMcpRequestManager } from "../smoke-support.mjs";
import { startIsolatedApp, connectMcp } from "./isolated-app.mjs";

const exec = promisify(execFile);
const { values } = parseArgs({ options: {
  app: { type: "string" }, bridge: { type: "string" }, root: { type: "string" }, out: { type: "string" },
  probe: { type: "string" }, label: { type: "string", default: "run" },
} });
if (!values.app || !values.bridge || !values.out || !values.probe) {
  throw new Error("--app, --bridge, --out and --probe are required");
}
const probes = new Set(["startup-concurrency", "sigkill-once", "sigkill-backoff", "cancel", "rss-drift", "shutdown", "stderr-burst"]);
if (!probes.has(values.probe)) throw new Error(`Unknown --probe ${values.probe}`);
const rootBase = resolve(values.root ?? join(process.env.PARASELF_LAB_ROOT ?? tmpdir(), "r10-ll-probes"));
const root = join(rootBase, `${values.label}-${values.probe}`);
const out = resolve(values.out);
await mkdir(root, { recursive: true });
await mkdir(resolve(out, ".."), { recursive: true });
const rows = [];
const record = (phase, data = {}) => rows.push({ at: new Date().toISOString(), phase, ...data });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const timeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const text = (prefix, n, length = 1_850) => `${prefix} ${n} ` + "关于服务部署与数据恢复的合成检索压力样本。".repeat(Math.ceil(length / 20)).slice(0, length);
const safeMcp = (client) => {
  const call = client.call.bind(client);
  return { ...client, call: (...args) => call(...args).catch((error) => ({ error: { message: String(error) } })) };
};

const descendants = async (parentPid) => {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid="]);
  const children = new Map();
  for (const line of stdout.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
  }
  const found = [];
  const queue = [parentPid];
  while (queue.length) {
    for (const pid of children.get(queue.shift()) ?? []) { found.push(pid); queue.push(pid); }
  }
  return found;
};

// Only a descendant other than the App itself with an open .gguf file qualifies for a kill.
const mappedModelChildren = async (appPid) => {
  const matches = [];
  for (const pid of await descendants(appPid)) {
    const { stdout } = await exec("lsof", ["-p", String(pid)]).catch(() => ({ stdout: "" }));
    const files = stdout.split("\n").filter((line) => /\.gguf(?:\s|$)/u.test(line))
      .map((line) => basename(line.trim().split(/\s+/u).at(-1) ?? "model.gguf"));
    if (files.length) matches.push({ pid, files: [...new Set(files)] });
  }
  return matches;
};

const isAlive = async (pid) => (await exec("ps", ["-p", String(pid), "-o", "pid="]).catch(() => ({ stdout: "" }))).stdout.trim() !== "";
const waitMapped = async (appPid, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const matches = await mappedModelChildren(appPid);
    if (matches.length) return matches;
    await delay(100);
  }
  return [];
};

const pair = (n) => {
  const now = Date.now();
  return {
    version: 1, pairId: `r10-ll-${values.label}-${n}`, sourceClient: "claude-code", sessionId: `r10-ll-${values.label}`,
    assistantTurnId: `assistant-${n}`, userTurnId: `user-${n}`, cwd: "/tmp/r10-ll-synthetic", assistantText: text("决定问题与方案", n),
    userText: "选第一个，先验证本机合成路径。", capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
  };
};

const postPair = async (app, n) => {
  const response = await fetch(`http://127.0.0.1:${app.runtime.port}/v1/semantic-pairs`, {
    method: "POST", headers: { authorization: `Bearer ${app.runtime.token}`, "content-type": "application/json" },
    body: JSON.stringify(pair(n)), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.text() };
};

const connectCancelableMcp = async (env, bridge) => {
  const child = spawn(bridge, ["mcp", "claude-code"], { env, stdio: ["pipe", "pipe", "ignore"] });
  const requests = createMcpRequestManager({ write: (line) => child.stdin.write(line) });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (line) requests.accept(JSON.parse(line));
    }
  });
  child.once("close", (code) => requests.rejectAll(new Error(`bridge MCP exited ${code}`)));
  let id = 0;
  const initialized = await requests.request(++id, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "r10-ll-probe", version: "1" },
  });
  if (initialized.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    call(name, args) { const requestId = ++id; return { requestId, promise: requests.request(requestId, "tools/call", { name, arguments: args }) }; },
    cancel(requestId) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId, reason: "R10-SK-LL cancellation probe" } })}\n`); },
    close() { child.stdin.end(); child.kill("SIGTERM"); },
  };
};

const percentile = (values, part) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * part) - 1)] : null;
const app = await startIsolatedApp({ root, executable: resolve(values.app), useLocalModels: true });
record("app-started", { appPid: app.child.pid, probe: values.probe, root });
let mcp;
try {
  if (values.probe === "cancel") {
    mcp = await connectCancelableMcp(app.env, resolve(values.bridge));
    const started = Date.now();
    const request = mcp.call("search_decision_context", { query: text("冷启动取消中的长查询", 1, 1_900), project: "r10-synthetic", limit: 8 });
    await delay(100);
    mcp.cancel(request.requestId);
    const result = await timeout(request.promise.catch((error) => ({ error: error.message })), 25_000, "cancelled MCP call")
      .catch((error) => ({ timeout: error.message }));
    record("cancelled-call", { elapsedMs: Date.now() - started, result });
    const follow = await mcp.call("search_decision_context", { query: "取消后本地服务还能回答吗？", project: "r10-synthetic", limit: 2 }).promise;
    record("cancel-follow-up", { isError: follow.result?.isError === true, response: follow.result?.structuredContent ?? follow.error });
    record("mapped-model-children", { children: await mappedModelChildren(app.child.pid) });
  } else if (values.probe === "startup-concurrency") {
    mcp = safeMcp(await connectMcp({ env: app.env, bridge: resolve(values.bridge) }));
    const started = Date.now();
    const queries = Array.from({ length: 12 }, (_, n) => mcp.call("search_decision_context", { query: text("冷启动并发检索", n), project: "r10-synthetic", limit: 3 }));
    const captures = Array.from({ length: 8 }, (_, n) => postPair(app, n));
    const [searchResults, captureResults] = await Promise.all([Promise.allSettled(queries), Promise.allSettled(captures)]);
    await delay(20_000);
    record("cold-concurrent-search-and-capture", {
      elapsedMs: Date.now() - started,
      searches: searchResults.map((r) => r.status === "fulfilled" ? { isError: r.value.result?.isError === true, error: r.value.error?.message,
        availability: r.value.result?.structuredContent?.availability } : { error: String(r.reason) }),
      captures: captureResults.map((r) => r.status === "fulfilled" ? r.value.status : `error:${String(r.reason)}`),
      mappedChildren: await mappedModelChildren(app.child.pid),
    });
  } else if (values.probe === "sigkill-once" || values.probe === "sigkill-backoff") {
    mcp = safeMcp(await connectMcp({ env: app.env, bridge: resolve(values.bridge) }));
    let injected = false;
    const rounds = values.probe === "sigkill-once" ? 1 : 3;
    for (let round = 1; round <= rounds; round += 1) {
      const started = Date.now();
      const inflight = Array.from({ length: 12 }, (_, n) => mcp.call("search_decision_context", {
        query: text(`SIGKILL round ${round}`, n, 1_900), project: "r10-synthetic", limit: 2,
      }));
      await delay(50);
      const matches = await waitMapped(app.child.pid, 20_000);
      record("mapped-before-kill", { round, elapsedMs: Date.now() - started, matches });
      const target = matches[0];
      if (!target) {
        record("kill-skipped", { round, reason: "no App descendant mapped a .gguf; App PID is deliberately ineligible" });
        await Promise.allSettled(inflight);
        break;
      }
      // Re-enumerate and re-check the same exact PID immediately before signalling.
      const confirmed = (await mappedModelChildren(app.child.pid)).find((item) => item.pid === target.pid);
      if (!confirmed) throw new Error(`PID ${target.pid} no longer qualifies as an App child mapping .gguf`);
      const signalAt = Date.now();
      process.kill(confirmed.pid, "SIGKILL");
      injected = true;
      record("sigkill-sent", { round, pid: confirmed.pid, mappedFiles: confirmed.files, elapsedMs: signalAt - started });
      const settled = await Promise.allSettled(inflight);
      record("killed-inflight-results", { round, completed: settled.filter((item) => item.status === "fulfilled").length,
        rejected: settled.filter((item) => item.status === "rejected").map((item) => String(item.reason)),
        sampleResponses: settled.slice(0, 4).map((item) => item.status === "fulfilled"
          ? { isError: item.value.result?.isError === true, error: item.value.error?.message,
            availability: item.value.result?.structuredContent?.availability,
            guidance: item.value.result?.structuredContent?.context?.guidance }
          : { error: String(item.reason) }) });
      if (round === 2 && rounds > 1) {
        const immediateAt = Date.now();
        const immediate = await mcp.call("search_decision_context", { query: "检测连续崩溃后的快速重试退避", project: "r10-synthetic", limit: 2 });
        record("second-crash-immediate-retry", { elapsedMs: Date.now() - immediateAt,
          guidance: immediate.result?.structuredContent?.context?.guidance, isError: immediate.result?.isError === true, error: immediate.error?.message });
      }
      if (round < rounds) await delay(round === 1 ? 100 : 2_100);
    }
    const recoveryStarted = Date.now();
    if (injected && rounds > 1) await delay(10_200);
    if (injected && rounds === 1) await delay(1_000);
    const recovered = await mcp.call("search_decision_context", { query: "连续崩溃退避结束后的恢复检查", project: "r10-synthetic", limit: 2 });
    record("post-backoff-recovery", { elapsedMs: Date.now() - recoveryStarted, isError: recovered.result?.isError === true,
      guidance: recovered.result?.structuredContent?.context?.guidance, error: recovered.error?.message });
  } else if (values.probe === "rss-drift") {
    mcp = safeMcp(await connectMcp({ env: app.env, bridge: resolve(values.bridge) }));
    await mcp.call("search_decision_context", { query: "RSS 测量预热", project: "r10-synthetic", limit: 2 });
    const durations = [];
    const samples = [];
    for (let n = 0; n < 80; n += 1) {
      const start = Date.now();
      await mcp.call("search_decision_context", { query: `RSS 漂移探针 ${n} 会话恢复与本地服务可用性`, project: "r10-synthetic", limit: 2 });
      durations.push(Date.now() - start);
      if (n % 10 === 9 || n === 0) {
        const children = await mappedModelChildren(app.child.pid);
        const rss = [];
        for (const pid of [app.child.pid, ...children.map((item) => item.pid)]) {
          const ps = await exec("ps", ["-p", String(pid), "-o", "rss="]).catch(() => ({ stdout: "" }));
          rss.push({ pid, rssKb: Number(ps.stdout.trim()) || null });
        }
        samples.push({ calls: n + 1, rss });
      }
    }
    record("rss-and-latency-drift", { calls: durations.length, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), firstMs: durations[0], lastMs: durations.at(-1), samples });
  } else if (values.probe === "shutdown") {
    mcp = safeMcp(await connectMcp({ env: app.env, bridge: resolve(values.bridge) }));
    await mcp.call("search_decision_context", { query: "SIGTERM 前模型预热", project: "r10-synthetic", limit: 2 });
    const inFlight = Array.from({ length: 12 }, (_, n) => mcp.call("search_decision_context", {
      query: text("SIGTERM 在途长查询", n, 1_900), project: "r10-synthetic", limit: 2,
    }));
    const captures = Array.from({ length: 8 }, (_, n) => postPair(app, n));
    await delay(50);
    const mapped = await mappedModelChildren(app.child.pid);
    record("sigterm-during-model-calls", { mappedChildren: mapped });
    const start = Date.now();
    const appExited = new Promise((resolve) => app.child.once("exit", resolve));
    app.child.kill("SIGTERM");
    await timeout(appExited, 20_000, "SIGTERM app exit");
    const settled = await Promise.allSettled(inFlight);
    const captureResults = await Promise.allSettled(captures);
    record("sigterm-exit", { elapsedMs: Date.now() - start, exitCode: app.child.exitCode, signalCode: app.child.signalCode,
      runtimeFileExists: await readFile(app.env.PARASELF_RUNTIME_FILE, "utf8").then(() => true, () => false),
      mappedChildPidsStillAlive: await Promise.all(mapped.map(async (item) => ({ pid: item.pid, alive: await isAlive(item.pid) }))),
      inFlightCompleted: settled.filter((item) => item.status === "fulfilled").length,
      inFlightRejected: settled.filter((item) => item.status === "rejected").length,
      inFlightErrors: settled.slice(0, 4).map((item) => item.status === "fulfilled" ? item.value.error?.message : String(item.reason)),
      captureAccepted: captureResults.filter((item) => item.status === "fulfilled" && item.value.status === 202).length });
    mcp.close(); mcp = undefined;
  } else if (values.probe === "stderr-burst") {
    mcp = safeMcp(await connectMcp({ env: app.env, bridge: resolve(values.bridge) }));
    const started = Date.now();
    const traffic = [
      ...Array.from({ length: 8 }, (_, n) => postPair(app, n)),
      ...Array.from({ length: 32 }, (_, n) => mcp.call("search_decision_context", { query: text("stderr 与 IPC 背压", n), project: "r10-synthetic", limit: 2 })),
    ];
    const results = await Promise.allSettled(traffic);
    await delay(20_000);
    const follow = await mcp.call("search_decision_context", { query: "背压压力后服务检查", project: "r10-synthetic", limit: 2 });
    record("stderr-and-channel-burst", { elapsedMs: Date.now() - started, fulfilled: results.filter((r) => r.status === "fulfilled").length,
      rejected: results.filter((r) => r.status === "rejected").map((r) => String(r.reason)), appStderrTailChars: app.stderr().length,
      appStderrTail: app.stderr(), followupIsError: follow.result?.isError === true, followupError: follow.error?.message,
      mappedChildren: await mappedModelChildren(app.child.pid) });
  }
} catch (error) {
  record("probe-error", { message: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally {
  mcp?.close();
  if (app.child.exitCode === null && app.child.signalCode === null) {
    const start = Date.now();
    await app.stop();
    record("smoke-shutdown", { elapsedMs: Date.now() - start });
  }
  record("app-exit", { exitCode: app.child.exitCode, signalCode: app.child.signalCode, stderrTail: app.stderr() });
  await writeFile(out, JSON.stringify({ probe: values.probe, label: values.label, appPid: app.child.pid, rows }, null, 2));
  console.log(JSON.stringify({ out, probe: values.probe, appPid: app.child.pid, rows: rows.map(({ phase, ...rest }) => ({ phase, ...rest })) }));
}
