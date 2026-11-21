#!/usr/bin/env node
// Real-path capture runs: for each scenario x model, drive the real claude/codex CLI through the user's registered
// Paraself hooks against an isolated packaged App, then record what the audit trail and spools say happened.
// grok and agy run on hooks this script writes into the run's own workspace (project hooks), so nothing the user has
// installed is used or changed; --sample-hooks swaps the bridge for scripts/lab/sample-hook.mjs and starts no App.
//
//   node scripts/lab/capture-run.mjs --models claude:sonnet,codex:gpt-6.1-sol --only s01,s03 --out runs.jsonl
//   node scripts/lab/capture-run.mjs --models grok:default,agy:default --root <dir outside /tmp> --sample-hooks <dir>
// --installed-hooks runs grok on the hooks the user installed through the App instead (no project hooks, no --trust, and
// the Claude compatibility layer left on, so the bridge's skip of Claude hooks called from grok is exercised too).
//
// Runs go one after another on purpose: the audit store only exposes salted session fingerprints, so a run's
// receipts are the ones created inside its own time window.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, appendFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CODEX_TOOLS_OFF, ISOLATION_KEYS, defaultBridge, defaultExecutable, isolationEnvironment, startIsolatedApp, writeCodexCatalog } from "./isolated-app.mjs";
import { ALLOWLIST, GUARD_FAULT, LEAK, guardCommand } from "./mcp-guard.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const LAB = process.env.PARASELF_LAB_ROOT ?? join(tmpdir(), "decision-lab");

const parseArgs = (argv) => {
  const options = {
    scenarios: join(here, "capture-scenarios.json"),
    only: undefined,
    models: "claude:sonnet,claude:haiku,codex:gpt-6.1-sol,codex:gpt-6-luna",
    out: join(LAB, "capture", "runs.jsonl"),
    root: join(LAB, "capture", "data"),
    app: undefined,
    bridge: undefined,
    localModels: false,
    sampleHooks: undefined,
    installedHooks: false,
    waitMs: 90_000,
    turnTimeoutMs: 240_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => argv[++index];
    if (flag === "--scenarios") options.scenarios = resolve(value());
    else if (flag === "--only") options.only = value().split(",").filter(Boolean);
    else if (flag === "--models") options.models = value();
    else if (flag === "--out") options.out = resolve(value());
    else if (flag === "--root") options.root = resolve(value());
    else if (flag === "--app") options.app = resolve(value());
    else if (flag === "--bridge") options.bridge = resolve(value());
    else if (flag === "--local-models") options.localModels = true;
    else if (flag === "--sample-hooks") options.sampleHooks = resolve(value());
    else if (flag === "--installed-hooks") options.installedHooks = true;
    else if (flag === "--wait-ms") options.waitMs = Number(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  return options;
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// CLI proxy environment variables do not enforce egress; required policy refuses the process.
const runProcess = async () => {
  throw new Error("ModelNetworkPolicy required: unmanaged lab model processes are blocked; use an HTTP provider");
};

/** Codex --json prints one event per line; the thread id and the final agent message are what a run needs. */
const parseCodexEvents = (stdout) => {
  let threadId;
  let text = "";
  for (const line of stdout.split("\n")) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started") threadId = event.thread_id;
    const item = event.item;
    if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") text = item.text;
  }
  return { threadId, text };
};

/** Copies every file that shows up under the watched directories, because the App may consume a spool file quickly. */
const startWatcher = (env) => {
  const roots = [
    env.PARASELF_CAPTURE_SPOOL,
    env.PARASELF_CANDIDATE_SPOOL,
    env.PARASELF_SEMANTIC_PAIR_SPOOL,
    env.PARASELF_TEXT_PENDING,
    env.PARASELF_MODEL_TRACES,
  ];
  const seen = new Map();
  const walk = async (directory, depth = 0) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) await walk(path, depth + 1);
      } else if (!seen.has(path) && !entry.name.endsWith(".tmp")) {
        try {
          const raw = await readFile(path, "utf8");
          let content = raw;
          try {
            content = JSON.parse(raw);
          } catch {
            // keep raw text
          }
          seen.set(path, { path, firstSeenAt: new Date().toISOString(), content });
        } catch {
          // consumed between listing and reading; picked up on the next pass if it comes back
        }
      }
    }
  };
  let stopped = false;
  const loop = (async () => {
    // Files already there belong to earlier runs.
    for (const root of roots) await walk(root);
    for (const key of seen.keys()) seen.set(key, undefined);
    while (!stopped) {
      for (const root of roots) await walk(root);
      await sleep(150);
    }
    for (const root of roots) await walk(root);
  })();
  return {
    take: () => [...seen.values()].filter((file) => file !== undefined),
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
};

const readReceipts = async (env) => {
  const directory = join(env.PARASELF_CAPTURE_AUDIT, "items");
  const names = await readdir(directory).catch(() => []);
  const receipts = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      receipts.push(JSON.parse(await readFile(join(directory, name), "utf8")));
    } catch {
      // being written
    }
  }
  return receipts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

const TERMINAL = new Set(["routed", "failed", "user_prompt_unpaired", "pending_expired"]);

/** A session's first prompt has nothing pending, so its user_prompt_unpaired is not the end of any pair. */
const terminalCount = (receipts) => {
  const first = receipts.findIndex((receipt) => receipt.stage === "user_prompt_unpaired");
  return receipts.filter((receipt, index) => TERMINAL.has(receipt.stage) && index !== first).length;
};

// Project hooks for the clients this script installs itself: event -> bridge op, undefined for events only --sample-hooks
// records. Grok reads Claude-shaped files in .grok/hooks/; agy reads named hooks in .agents/hooks.json, and its payload has
// no event name, so the op is in the command.
const PROJECT_HOOKS = {
  grok: { id: "grok", events: { UserPromptSubmit: "user-prompt-submit", Stop: "stop", PostToolUse: undefined, SessionEnd: undefined } },
  agy: { id: "antigravity", events: { PreInvocation: "user-prompt-submit", Stop: "stop", PostInvocation: undefined, SessionStart: undefined } },
};
const SECRET_ENV = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;
// Grok loads ~/.claude and ~/.cursor hooks and MCP servers by default, the user's real Decision hooks among them.
const GROK_COMPAT_OFF = {
  GROK_CLAUDE_HOOKS_ENABLED: "false",
  GROK_CLAUDE_MCPS_ENABLED: "false",
  GROK_CURSOR_HOOKS_ENABLED: "false",
  GROK_CURSOR_MCPS_ENABLED: "false",
};
const sampleHook = join(here, "sample-hook.mjs");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const writeProjectHooks = async ({ client, cwd, options, label }) => {
  const { id, events } = PROJECT_HOOKS[client];
  const command = (event) =>
    options.sampleHooks !== undefined
      ? `${quote(process.execPath)} ${quote(sampleHook)} ${quote(join(options.sampleHooks, label))} ${event}`
      : events[event] === undefined
        ? undefined
        : `DECISION_HOOK=1 ${quote(defaultBridge())} hook ${events[event]} ${id}`;
  const handlers = (event) => {
    const line = command(event);
    return line === undefined ? undefined : [{ type: "command", command: line, timeout: 10 }];
  };
  if (client === "grok") {
    const hooks = {};
    for (const event of Object.keys(events)) {
      const list = handlers(event);
      if (list !== undefined) hooks[event] = [{ hooks: list }];
    }
    await mkdir(join(cwd, ".grok", "hooks"), { recursive: true });
    await writeFile(join(cwd, ".grok", "hooks", "decision-lab.json"), `${JSON.stringify({ hooks }, null, 2)}\n`);
    return;
  }
  const hook = {};
  for (const event of Object.keys(events)) {
    const list = handlers(event);
    if (list !== undefined) hook[event] = list;
  }
  if (options.sampleHooks !== undefined) hook.PostToolUse = [{ matcher: ".*", hooks: handlers("PostToolUse") ?? [] }];
  await mkdir(join(cwd, ".agents"), { recursive: true });
  await writeFile(join(cwd, ".agents", "hooks.json"), `${JSON.stringify({ "decision-lab": hook }, null, 2)}\n`);
};

// With sample hooks nothing needs the bridge, so DECISION_PROVIDER_CHILD=1 makes any real Decision hook the client still
// loads (agy's loading of ~/.claude is unverified) exit at once.
const clientEnvironment = (client, env, options) => {
  if (!(client in PROJECT_HOOKS)) return env;
  const filtered = Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));
  if (options.sampleHooks !== undefined) filtered.DECISION_PROVIDER_CHILD = "1";
  return client === "grok" && !options.installedHooks ? { ...filtered, ...GROK_COMPAT_OFF } : filtered;
};

/** grok prints one pretty-printed object; agy's field names are not documented, so any of the usual spellings is taken. */
const parseJsonReply = (stdout) => {
  const trimmed = stdout.trim();
  try {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = JSON.parse(trimmed.split("\n").filter(Boolean).at(-1));
    }
    return {
      sessionId: parsed.sessionId ?? parsed.session_id ?? parsed.conversationId ?? parsed.conversation_id,
      text: parsed.text ?? parsed.result ?? parsed.response ?? "",
    };
  } catch {
    return { sessionId: undefined, text: stdout.trim() };
  }
};

const turnCommand = ({ client, model, sessionId, resumeId, prompt, cwd, options }) => {
  const modelArgs = (flag) => (model === "default" ? [] : [flag, model]);
  if (client === "grok") {
    // --trust records this workspace in ~/.grok/trusted_folders.toml: project hooks run only in a trusted folder.
    // Headless grok runs in auto permission mode and ran shell commands over the lab directory, so only the question
    // tool is left (the one a capture would observe).
    return {
      command: "grok",
      args: ["-p", prompt, ...(options.installedHooks ? [] : ["--trust"]), "--output-format", "json", "--tools", "ask_user_question", ...modelArgs("-m"), ...(resumeId === undefined ? ["-s", sessionId] : ["-r", resumeId])],
    };
  }
  if (client === "agy") {
    return {
      command: "agy",
      args: ["-p", prompt, "--output-format", "json", ...modelArgs("--model"), ...(resumeId === undefined ? [] : ["--conversation", resumeId])],
    };
  }
  if (client === "claude") {
    return {
      command: "claude",
      args: ["-p", ...(resumeId === undefined ? ["--session-id", sessionId] : ["--resume", resumeId]), "--model", model, prompt],
    };
  }
  // The user's config stays for its hooks, so everything else it brings is switched off: every tool that reads a file
  // or runs code, and every MCP server but paraself. Codex hands an MCP server only an allow-list of variables, so the
  // user's paraself entry would reach the real App: it goes through the guard instead, its paths forwarded by env_vars
  // and an empty catalog, so no record at all reaches the session.
  const common = ["--json", "--skip-git-repo-check", "-m", model, "-c", 'sandbox_mode="read-only"',
    ...[...CODEX_TOOLS_OFF, `model_catalog_json=${JSON.stringify(options.codexCatalog)}`, ...options.codexMcpOff.map((name) => `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`)].flatMap((setting) => ["-c", setting]),
    "-c", `mcp_servers.paraself.command=${JSON.stringify(options.guard.command)}`, "-c", `mcp_servers.paraself.args=${JSON.stringify(options.guard.args)}`,
    "-c", `mcp_servers.paraself.env_vars=${JSON.stringify(ISOLATION_KEYS)}`];
  return resumeId === undefined
    ? { command: "codex", args: ["exec", ...common, "-C", cwd, prompt] }
    : { command: "codex", args: ["exec", "resume", ...common, resumeId, prompt] };
};

const runOne = async ({ scenario, client, model, env, root, options, appState }) => {
  await runProcess();
  const startedAt = new Date();
  const label = `${scenario.id}__${client}-${model}`;
  // agy trusts a folder only through its interactive dialog, so all agy runs share one workspace the user trusted once.
  const cwd = client === "agy" ? join(root, "projects", "agy-workspace") : join(root, "projects", label);
  if (client !== "agy") await rm(cwd, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd });
  if (client in PROJECT_HOOKS && !options.installedHooks) await writeProjectHooks({ client, cwd, options, label });
  const turnEnv = clientEnvironment(client, env, options);
  const record = {
    scenario: scenario.id,
    client,
    model,
    startedAt: startedAt.toISOString(),
    turns: [],
    errors: [],
  };
  const watcher = startWatcher(env);
  let sessionId = client === "claude" || client === "grok" ? randomUUID() : undefined;
  for (const [index, prompt] of scenario.turns.entries()) {
    const resumeId = index === 0 ? undefined : sessionId;
    const { command, args } = turnCommand({ client, model, sessionId, resumeId, prompt, cwd, options });
    const result = await runProcess(command, args, { env: turnEnv, cwd, timeoutMs: options.turnTimeoutMs });
    let assistantText = result.stdout.trim();
    if (client === "codex") {
      const parsed = parseCodexEvents(result.stdout);
      assistantText = parsed.text;
      sessionId ??= parsed.threadId;
    }
    if (client in PROJECT_HOOKS) {
      const parsed = parseJsonReply(result.stdout);
      assistantText = parsed.text;
      sessionId ??= parsed.sessionId;
    }
    record.turns.push({
      prompt,
      assistantText,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      stderrTail: result.stderr,
    });
    if (result.code !== 0 || result.timedOut || sessionId === undefined) {
      record.errors.push(`turn ${index + 1} failed: exit=${result.code} timedOut=${result.timedOut} sessionId=${sessionId ?? "none"}`);
      break;
    }
  }
  record.sessionId = sessionId;
  if (options.sampleHooks !== undefined) {
    await sleep(1_500);
    await watcher.stop();
    const names = await readdir(join(options.sampleHooks, label)).catch(() => []);
    record.samples = names.sort().map((name) => join(label, name));
    if (record.samples.length === 0) record.errors.push("no hook sample written (untrusted folder?)");
    record.durationMs = Date.now() - startedAt.getTime();
    return record;
  }
  const expectedPairs = scenario.turns.length - 1;
  const waitStarted = Date.now();
  const deadline = waitStarted + options.waitMs;
  let receipts = [];
  while (Date.now() < deadline) {
    receipts = (await readReceipts(env)).filter((receipt) => receipt.createdAt >= record.startedAt);
    if (terminalCount(receipts) >= expectedPairs && record.errors.length === 0) break;
    if (appState.exited !== undefined) break;
    if (record.errors.length > 0 && Date.now() > waitStarted + 5_000) break;
    await sleep(400);
  }
  await sleep(1_500);
  receipts = (await readReceipts(env)).filter((receipt) => receipt.createdAt >= record.startedAt);
  await watcher.stop();
  record.receipts = receipts.map(({ stage, ruleBand, modelBand, finalBand, errorCode, textSource, durationMs, createdAt, sessionFingerprint, turnFingerprint }) => ({
    stage, ruleBand, modelBand, finalBand, errorCode, textSource, durationMs, createdAt, sessionFingerprint, turnFingerprint,
  }));
  record.files = watcher.take().map((file) => ({
    path: file.path.replace(`${root}/`, ""),
    firstSeenAt: file.firstSeenAt,
    content: file.content,
  }));
  if (!receipts.some((receipt) => receipt.stage === "hook_received")) record.errors.push("no hook_received in isolated audit");
  if (appState.exited !== undefined) record.errors.push(`isolated App exited during the run: ${appState.exited}`);
  if (terminalCount(receipts) < expectedPairs) record.errors.push("terminal stage not reached before timeout");
  record.durationMs = Date.now() - startedAt.getTime();
  return record;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.app !== undefined) process.env.PARASELF_LAB_APP_EXECUTABLE = options.app;
  if (options.bridge !== undefined) process.env.PARASELF_LAB_BRIDGE = options.bridge;
  const file = JSON.parse(await readFile(options.scenarios, "utf8"));
  const scenarios = file.scenarios.filter((scenario) => options.only === undefined || options.only.some((prefix) => scenario.id.startsWith(prefix)));
  const models = options.models.split(",").map((entry) => {
    const [client, ...rest] = entry.split(":");
    if (!["claude", "codex", "grok", "agy"].includes(client) || rest.length === 0) throw new Error(`Bad model ${entry}`);
    return { client, model: rest.join(":") };
  });
  // Grok skips project hooks in a shared temporary directory.
  if (models.some(({ client }) => client === "grok") && [tmpdir(), "/tmp", "/private/tmp"].some((dir) => options.root.startsWith(dir))) {
    throw new Error("grok needs --root (or DECISION_LAB_ROOT) outside the temporary directory");
  }
  if (options.sampleHooks !== undefined && models.some(({ client }) => !(client in PROJECT_HOOKS))) {
    throw new Error("--sample-hooks only drives grok and agy");
  }
  if (options.installedHooks && (options.sampleHooks !== undefined || models.some(({ client }) => client !== "grok"))) {
    throw new Error("--installed-hooks only drives grok, without --sample-hooks");
  }
  await mkdir(options.root, { recursive: true });
  await mkdir(resolve(options.out, ".."), { recursive: true });
  const env = isolationEnvironment(options.root);
  const appState = { exited: undefined };
  const app = options.sampleHooks === undefined
    ? await startIsolatedApp({ root: options.root, executable: defaultExecutable(), useLocalModels: options.localModels })
    : undefined;
  if (app !== undefined) {
    options.guard = guardCommand(options.root, defaultBridge(), "codex");
    await writeFile(join(options.root, ALLOWLIST), "[]\n");
    options.codexMcpOff = [];
    if (models.some(({ client }) => client === "codex")) {
      // Listed with the tool switches on: a plugin's server is gone with plugins off, and a switch for one not in the
      // user's config would leave a table without a transport, which Codex refuses to load.
      const listed = spawnSync("codex", [...CODEX_TOOLS_OFF.flatMap((setting) => ["-c", setting]), "mcp", "list", "--json"], { encoding: "utf8" });
      const servers = JSON.parse(listed.stdout);
      if (listed.status !== 0 || !Array.isArray(servers)) throw new Error("codex mcp list --json failed");
      options.codexMcpOff = servers.map((server) => server.name).filter((name) => name !== "paraself");
      options.codexCatalog = await writeCodexCatalog(options.root);
    }
    await writeFile(join(options.root, "app.pid"), String(app.child.pid));
    console.error(`isolated App pid=${app.child.pid} port=${app.runtime.port} bridge=${defaultBridge()}`);
    app.child.on("exit", (code, signal) => {
      appState.exited = `code=${code} signal=${signal} at ${new Date().toISOString()}`;
    });
  }
  let failures = 0;
  try {
    for (const scenario of scenarios) {
      for (const { client, model } of models) {
        const record = await runOne({ scenario, client, model, env, root: options.root, options, appState });
        record.appPid = app?.child.pid;
        const flagged = [LEAK, GUARD_FAULT].filter((file) => existsSync(join(options.root, file)));
        if (flagged.length > 0) record.errors.push(`lab guard wrote ${flagged.join(", ")}`);
        await appendFile(options.out, `${JSON.stringify(record)}\n`);
        if (flagged.length > 0) {
          console.error(`lab guard wrote ${flagged.join(", ")}; stopping the batch`);
          process.exitCode = 2;
          return;
        }
        if (record.errors.length > 0) failures += 1;
        if (appState.exited !== undefined) {
          console.error(`isolated App exited early (${appState.exited}); stopping the batch`);
          process.exitCode = 1;
          return;
        }
        console.error(`${scenario.id} ${client}:${model} ${record.durationMs}ms errors=${JSON.stringify(record.errors)} stages=${(record.receipts ?? []).map((r) => r.stage + (r.finalBand ? `(${r.finalBand})` : "")).join(">")} samples=${record.samples?.length ?? "-"}`);
      }
    }
  } finally {
    if (app !== undefined) {
      await app.stop();
      console.error(`isolated App stopped, exit=${app.child.exitCode} signal=${app.child.signalCode}`);
    }
  }
  process.exitCode = failures > 0 ? 1 : 0;
};

await main();
