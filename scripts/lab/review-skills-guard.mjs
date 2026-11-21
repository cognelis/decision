#!/usr/bin/env node
// The MCP command a client under test starts: node review-skills-guard.mjs --root R --bridge B --client C --seed D --pin SHA --server-version X [--task-repo D].
// It starts the bridge only when every isolation path is under R and holds the four review tools, answers the client
// from checked pieces only (review-skills-lab.mjs: each result bound to the seeded record it names; unknown wording refused),
// and rebuilds every result from the checked structuredContent. A failed check writes R/LEAK (reason only), ends the bridge
// and exits 3; a fault of its own writes R/GUARD_FAULT. docs/review-skills-lab.md has the boundary.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { join } from "node:path";
import { ISOLATION_KEYS, labProcessEnvironment } from "./isolated-app.mjs";
import { ALLOWLIST, checkPaths, consultForward, errorNotice } from "./mcp-guard.mjs";
import { TOOLS, verifyFrozen, checkArgs, checkInitialize, checkToolMessage, loadSeed, noteForward, rebuildContext, sha256 } from "./review-skills-lab.mjs";

export const guardArgs = ({ root, bridge, client, seed, pin, version, taskRepo }) => [fileURLToPath(import.meta.url), "--root", root, "--bridge", bridge, "--client", client, "--seed", seed, ...(pin ? ["--pin", pin] : []), ...(version ? ["--server-version", version] : []), ...(taskRepo ? ["--task-repo", taskRepo] : [])];

const NOTICE = "守卫已拦下或替换此结果（固定说明，不含任何内容）。";
const LINE_LIMIT = 256 * 1024;

/** The tools/list answer: the four tools, nothing the bridge adds. Its digest is what --pin holds the definitions to. */
export const reviewTools = (listed) => listed.filter((tool) => TOOLS.includes(tool.name)).sort((a, b) => a.name.localeCompare(b.name));
export const toolsDigest = (tools) => sha256(JSON.stringify(tools));

async function main() {
  const { values } = parseArgs({ options: { root: { type: "string" }, bridge: { type: "string" }, client: { type: "string" }, seed: { type: "string" }, pin: { type: "string" }, "server-version": { type: "string" }, "record-digest": { type: "boolean", default: false }, "task-repo": { type: "string" } } });
  const flag = (file, text) => { try { writeFileSync(join(values.root, file), `${text}\n`); } catch { /* the exit code still says it */ } };
  // No pin, no client: the definitions a model reads are product text, so they are held to a digest taken from reviewed source
  // (--record-digest prints it for that review and serves nobody).
  if (!values.pin && !values["record-digest"]) { console.error("--pin (the reviewed tool-definition digest) is required"); process.exit(3); }
  if (!values["server-version"] && !values["record-digest"]) { console.error("--server-version (the package version under test) is required"); process.exit(3); }
  if (values.pin && !/^[0-9a-f]{64}$/u.test(values.pin)) { console.error("--pin is not a sha256"); process.exit(3); }
  const checked = await checkPaths(process.env, values.root);
  if (checked.error) { flag("GUARD_FAULT", `paths: ${checked.error}`); process.exit(3); }
  // The guard's seed is a read-only copy of the frozen set (HASHES.sha256, vault/, task/) under the lab root, its hashes re-checked at every
  // start; never the vault the App writes into. Seed and task repository must be under the root; the vault path the App was given is
  // already held to the root with the other isolation paths (checkPaths).
  const realRoot = await realpath(values.root).catch(() => null);
  const under = async (path) => { const real = path ? await realpath(path).catch(() => null) : null; return real !== null && realRoot !== null && real.startsWith(`${realRoot}/`); };
  if (!(await under(values.seed)) || (values["task-repo"] !== undefined && !(await under(values["task-repo"])))) { flag("GUARD_FAULT", "seed or task repository is not under the lab root"); process.exit(3); }
  try { verifyFrozen(values.seed); } catch (error) { flag("GUARD_FAULT", error.message); process.exit(3); }
  const seed = loadSeed(join(values.seed, "vault"));
  if (values["task-repo"]) seed.taskRepo = await realpath(values["task-repo"]);
  // The catalog the App listed for the seeds (context-run's ensureAllow writes it); empty = no decision record may pass.
  let allow = [];
  try { allow = JSON.parse(readFileSync(join(values.root, ALLOWLIST), "utf8")); if (!Array.isArray(allow)) throw new Error(); } catch { if (!values["record-digest"]) { flag("GUARD_FAULT", `${ALLOWLIST} missing or malformed`); process.exit(3); } }
  const bridge = spawn(values.bridge, ["mcp", values.client], { cwd: values.root, env: labProcessEnvironment(process.env), stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const ask = (message) => bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const leak = (reason, id) => {
    flag("LEAK", reason);
    if (id !== undefined) send({ id, result: { isError: true, content: [{ type: "text", text: NOTICE }] } });
    bridge.kill("SIGKILL");
    process.exit(3);
  };
  const fault = (reason) => { flag("GUARD_FAULT", reason); bridge.kill("SIGKILL"); process.exit(3); };

  createInterface({ input: bridge.stdout }).on("line", (line) => {
    if (line.length > LINE_LIMIT) return leak("bridge line over the limit");
    let message; try { message = JSON.parse(line); } catch { return fault("bridge sent a line that is not JSON"); }
    if (message === null || typeof message !== "object" || Array.isArray(message)) return fault("bridge sent a non-object");
    if (message.method !== undefined) return; // bridge-initiated requests and notifications are dropped
    const entry = pending.get(message.id);
    if (!entry) return leak("bridge answered an id nobody asked");
    pending.delete(message.id);
    if (message.error !== undefined) return send({ id: message.id, error: { code: Number.isInteger(message.error.code) ? message.error.code : -32603, message: NOTICE } });
    if (entry.kind === "initialize") {
      const why = values["record-digest"] ? null : checkInitialize(message.result, values["server-version"]);
      if (why) return leak(`initialize: ${why}`, message.id);
      const r = message.result;
      return send({ id: message.id, result: { protocolVersion: r.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "paraself", version: values["server-version"] ?? "0" } } });
    }
    if (entry.kind === "ping") return send({ id: message.id, result: {} });
    if (entry.kind === "list") {
      const tools = reviewTools(message.result?.tools ?? []);
      if (tools.length !== TOOLS.length) return leak("bridge does not list the four review tools");
      flag("TOOLS_DIGEST", toolsDigest(tools));
      writeFileSync(join(values.root, "TOOLS_DEFINITIONS.json"), JSON.stringify(tools, null, 1));
      if (values["record-digest"]) { bridge.kill("SIGKILL"); process.exit(0); }
      if (toolsDigest(tools) !== values.pin) return leak("tool definitions differ from the pinned digest");
      return send({ id: message.id, result: { tools } });
    }
    const result = message.result ?? {};
    const reason = checkToolMessage(entry.tool, entry.args, message, { seed, allow, text: true, raw: true });
    if (reason) return leak(`${entry.tool}: ${reason}`, message.id);
    // Rebuilt from what was checked: nothing else the bridge put beside it goes on.
    if (entry.tool === "consult_decision_principles") return send({ id: message.id, result: consultForward(result) });
    if (entry.tool === "search_decision_context") {
      if (result.isError === true) return send({ id: message.id, result: { isError: true, content: [{ type: "text", text: errorNotice(result.structuredContent) }] } });
      return send({ id: message.id, result: { content: result.content.map((part) => ({ type: "text", text: part.text })), structuredContent: rebuildContext(result.structuredContent) } });
    }
    send({ id: message.id, result: noteForward(entry.tool, result) ?? { isError: true, content: [{ type: "text", text: NOTICE }] } });
  });
  bridge.on("exit", () => process.exit(0));
  bridge.stderr.resume();

  createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.length > LINE_LIMIT) return leak("client line over the limit");
    let message; try { message = JSON.parse(line); } catch { return; }
    if (message === null || typeof message !== "object" || Array.isArray(message)) return send({ id: null, error: { code: -32600, message: "batch or non-object" } });
    const { id, method, params } = message;
    if (method === undefined) return; // a client's answer to a request we never made
    if (id === undefined) { if (method === "notifications/initialized" || method === "notifications/cancelled") ask({ method, params }); return; }
    if (pending.has(id)) return send({ id, error: { code: -32600, message: "id in use" } });
    if (method === "initialize") { pending.set(id, { kind: "initialize" }); return ask({ id, method, params }); }
    if (method === "ping") { pending.set(id, { kind: "ping" }); return ask({ id, method }); }
    if (method === "tools/list") { pending.set(id, { kind: "list" }); return ask({ id, method }); }
    if (method === "tools/call") {
      const tool = params?.name, args = params?.arguments ?? {};
      const allowed = checkArgs(tool, args, seed);
      // A refused call is the client's mistake or attempt, recorded apart from a leak (REFUSED); it does not end the run.
      if (!allowed.ok) { try { appendFileSync(join(values.root, "REFUSED"), `${new Date().toISOString()} ${String(tool).slice(0, 60)}: ${allowed.reason}\n`); } catch { /* the answer below still refuses */ } return send({ id, result: { isError: true, content: [{ type: "text", text: `${NOTICE}（参数被拒绝：${allowed.reason}）` }] } }); }
      pending.set(id, { kind: "call", tool, args });
      return ask({ id, method, params: { name: tool, arguments: args } });
    }
    send({ id, error: { code: -32601, message: "method not available" } });
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch((error) => { console.error(error.message); process.exit(3); });
}
void ISOLATION_KEYS;
