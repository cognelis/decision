// Lab runs start the packaged App the way scripts/smoke.mjs does: every path the App and the bridge would
// otherwise take from the user's own Paraself data points under one throwaway root instead.
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveUserData } from "../../config/user-data-directory.mjs";
import { createMcpRequestManager } from "../smoke-support.mjs";

const packagedApp = fileURLToPath(new URL("../../out/Paraself-darwin-arm64/Paraself.app", import.meta.url));
export const defaultExecutable = () =>
  process.env.PARASELF_LAB_APP_EXECUTABLE ?? join(packagedApp, "Contents", "MacOS", "Paraself");
export const defaultBridge = () =>
  process.env.PARASELF_LAB_BRIDGE ?? join(packagedApp, "Contents", "Resources", "bridge", "paraself-bridge");

/** The environment for the App and for anything that runs its hooks or bridge (claude, codex, paraself-bridge mcp).
 * The bridge falls back to the user's real data for any of these that is missing, so all of them are always set. The
 * marker that turns hooks off goes by both its names: the bridge still reads the one it had as Decision. */
export const isolationEnvironment = (root, base = process.env) => {
  const { PARASELF_PROVIDER_CHILD: _hooksOff, DECISION_PROVIDER_CHILD: _legacyHooksOff, ...inherited } = base;
  const userData = join(root, "user-data");
  return {
    ...inherited,
    PARASELF_SMOKE: "1",
    PARASELF_USER_DATA: userData,
    PARASELF_VAULT_PATH: join(root, "vault"),
    PARASELF_RUNTIME_FILE: join(root, "runtime.json"),
    PARASELF_CAPTURE_SPOOL: join(userData, "capture-spool"),
    PARASELF_TEXT_PENDING: join(userData, "text-pending"),
    PARASELF_SEMANTIC_PAIR_SPOOL: join(userData, "semantic-pair-spool"),
    PARASELF_CAPTURE_AUDIT: join(userData, "capture-audit"),
    PARASELF_CUSTOM_CLIENTS: join(userData, "custom-clients.json"),
    PARASELF_CLIENT_PROBES: join(userData, "client-probes"),
    PARASELF_CANDIDATE_SPOOL: join(userData, "candidate-spool"),
    PARASELF_MODEL_TRACES: join(userData, "model-traces"),
  };
};

/** Every path variable isolationEnvironment points under root: a bridge missing any one reads the user's real one. */
export const ISOLATION_KEYS = Object.keys(isolationEnvironment("/", {})).filter((name) => name !== "PARASELF_SMOKE");

// What the lab's own App, bridge and guard are started with, and nothing else: the system's variables, the lab's two
// switches and the isolation paths. isolationEnvironment passes the rest of the caller's on (capture-run's sessions
// under test need the user's own configuration); these need none of it, so a credential under any name, NODE_OPTIONS
// or a runtime's injected hook stays behind whatever the outer shell left (R18: a token an outer filter missed reached
// an App and its bridge).
const LAB_PROCESS_KEYS = new Set(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "__CF_USER_TEXT_ENCODING",
  "PARASELF_SMOKE", "PARASELF_SMOKE_SHOW_WINDOW", "PARASELF_ORGANIZATION_LAB_IDLE", ...ISOLATION_KEYS]);
const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i;
/** Throws, naming the variables and never their values, unless env holds the lab's own names alone. */
export const assertLabProcessEnvironment = (env) => {
  const refused = Object.keys(env).filter((name) => !LAB_PROCESS_KEYS.has(name) || SECRET_NAME.test(name));
  if (refused.length > 0) throw new Error(`Lab process environment holds variables outside its allowlist: ${refused.join(", ")}`);
  return env;
};
/** The environment of the lab's App, bridge or guard, taken from env: its allowlist alone, asserted before any start. */
export const labProcessEnvironment = (env) =>
  assertLabProcessEnvironment(Object.fromEntries(Object.entries(env).filter(([name, value]) => LAB_PROCESS_KEYS.has(name) && value !== undefined)));

/**
 * A Codex session under test keeps MCP and nothing else that reads a file or runs code: the App's own switches for its
 * model calls (codex-cli-adapter.ts) and every such feature `codex features list` showed on in 0.165 (unified exec,
 * images, browsers, computer use, agents, skills, plugins, web search). The code-mode host stays: in 0.165 every tool
 * call, MCP among them, goes through it, and with it off paraself could not be called; the JavaScript it runs has no
 * file system. apply_patch has no switch: writeCodexCatalog takes it away. Hooks are left to the caller: capture runs
 * need them.
 */
export const CODEX_TOOLS_OFF = [
  ...["shell_tool", "unified_exec", "unified_exec_tty", "shell_snapshot", "code_mode", "view_image",
    "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser", "in_app_local_automation",
    "image_generation", "multi_agent", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies",
    "plugins", "remote_plugin", "apps", "tool_suggest", "goals", "sleep_tool"].map((feature) => `features.${feature}=false`),
  "tools.web_search=false", 'web_search="disabled"', "apps._default.enabled=false", "agents.enabled=false", "memories.generate_memories=false",
];

/**
 * The models Codex knows, as its own cache lists them, with apply_patch taken from every one: 0.165 has no switch for
 * the tool, which reads its target (and tells a line there from one not) before the read-only sandbox refuses the
 * write. Passed as `-c model_catalog_json=<file>`; with it Codex lists no apply_patch.
 */
export const writeCodexCatalog = async (root, env = process.env) => {
  const cache = JSON.parse(await readFile(join(env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json"), "utf8"));
  if (!Array.isArray(cache.models) || cache.models.length === 0) throw new Error("Codex models_cache.json lists no models");
  const file = join(root, "codex-models.json");
  await writeFile(file, JSON.stringify({ models: cache.models.map((model) => ({ ...model, apply_patch_tool_type: null })) }));
  return file;
};

const waitFor = async (operation, description, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${description} timed out${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
};

// How long a start may take to answer its health check: under a load of 150 to 350, one with the local models took past
// 60 seconds, and some 180. Every runner that starts an App (context-run, run-fresh-vectors, capture-run) reads it here.
const startTimeoutMs = () => Number(process.env.PARASELF_LAB_START_TIMEOUT_MS) || 60_000;
// How long a quit may take before SIGTERM: an App may wait up to 60 seconds for its models to close (R9-QC), and one
// cut short at 20 was killed mid-dispose. 75 was too short on a build's first start, its Metal shaders still compiling,
// and under a load past 400: those quits took longer and were cut. A version that quits sooner is not held: the wait
// ends as it exits.
const stopTimeoutMs = () => Number(process.env.PARASELF_LAB_STOP_TIMEOUT_MS) || 120_000;

/**
 * useLocalModels links the real models directory (weights only, read-only use) so vectors and Qwen work. Off screen and
 * out of the Dock by default (smoke); `showWindow` puts the window up behind the app in front, unfocused.
 */
export const startIsolatedApp = async ({ root, executable = defaultExecutable(), useLocalModels = false, showWindow = false, debugPort, onSpawn, timeoutMs = startTimeoutMs(), base = process.env }) => {
  if (debugPort !== undefined && (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535)) throw new Error("Invalid isolated debugging port");
  const env = labProcessEnvironment({ ...isolationEnvironment(root, base), ...(showWindow ? { PARASELF_SMOKE_SHOW_WINDOW: "1" } : {}) });
  await mkdir(env.PARASELF_VAULT_PATH, { recursive: true });
  await mkdir(env.PARASELF_USER_DATA, { recursive: true });
  await rm(env.PARASELF_RUNTIME_FILE, { force: true });
  if (useLocalModels) {
    // The reader's own models where they are now, Decision's folder until the App has moved it: nothing is moved here.
    const models = join(resolveUserData(process.env, { migrate: false }).path, "models");
    await symlink(models, join(env.PARASELF_USER_DATA, "models")).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  const child = spawn(executable, debugPort === undefined ? [] : [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_000);
  });
  const exited = () => (child.exitCode === null && child.signalCode === null ? undefined : true);
  let runtime;
  try {
    onSpawn?.(child);
    runtime = await waitFor(async () => {
      if (exited()) throw Object.assign(new Error(`App exited with ${child.exitCode ?? child.signalCode}: ${stderr}`), { fatal: true });
      const parsed = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, "utf8"));
      return (await fetch(`http://127.0.0.1:${parsed.port}/health`)).ok ? parsed : undefined;
    }, "isolated App health", timeoutMs);
  } catch (error) {
    // A start that never became healthy must not leave its App running behind the caller.
    child.kill("SIGTERM");
    await waitFor(exited, "isolated App SIGTERM", 5_000).catch(() => child.kill("SIGKILL"));
    throw new Error(`${error.message} (pid ${child.pid})`);
  }
  const stop = async () => {
    if (exited()) return;
    // On a connection of its own (agent: false), and asked twice: fetch sent it on the keep-alive connection the health
    // polls opened without a token, which the App's server drops two seconds on, and the quit went unasked (R9-QC).
    const shutdown = () => new Promise((resolve, reject) => {
      const asked = request({ host: "127.0.0.1", port: runtime.port, path: "/v1/smoke/shutdown", method: "POST", agent: false,
        headers: { authorization: `Bearer ${runtime.token}` } }, (response) => { response.resume(); response.on("end", resolve); });
      asked.on("error", reject);
      asked.end();
    });
    try {
      await shutdown().catch(shutdown);
      await waitFor(exited, "isolated App shutdown", stopTimeoutMs());
    } catch {
      child.kill("SIGTERM");
      await waitFor(exited, "isolated App SIGTERM", 5_000).catch(() => child.kill("SIGKILL"));
    }
  };
  // The last of what it wrote to stderr: a native abort as it quits (node-llama-cpp at cleanup) is seen only there.
  return { child, env, runtime, stop, stderr: () => stderr };
};

/**
 * A stdio MCP session with the bridge, against whatever App env.PARASELF_RUNTIME_FILE names, started with env's lab
 * allowlist alone. `command` and `args` start something else that speaks MCP in the bridge's place (mcp-guard.mjs).
 */
export const connectMcp = async ({ env, bridge = defaultBridge(), client = "claude-code", command = bridge, args = ["mcp", client] }) => {
  const server = spawn(command, args, { env: labProcessEnvironment(env), stdio: ["pipe", "pipe", "pipe"] });
  const requests = createMcpRequestManager({ write: (line) => server.stdin.write(line) });
  let buffer = "";
  server.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) requests.accept(JSON.parse(line));
    }
  });
  server.once("close", (code) => requests.rejectAll(new Error(`bridge MCP exited with ${code}`)));
  let id = 0;
  const initialized = await requests.request(++id, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "decision-lab", version: "1.0.0" },
  });
  if (initialized.error !== undefined) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized.error)}`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return {
    listTools: async () => (await requests.request(++id, "tools/list")).result?.tools ?? [],
    /** Resolves to the raw JSON-RPC response so callers keep errors and isError results as evidence. */
    call: (name, args = {}) => requests.request(++id, "tools/call", { name, arguments: args }),
    close: () => {
      server.stdin.end();
      server.kill("SIGTERM");
    },
  };
};
