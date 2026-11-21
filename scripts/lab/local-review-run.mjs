#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { dirname, join, resolve, delimiter } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { isolationEnvironment, startIsolatedApp } from "./isolated-app.mjs";

const exec = promisify(execFile), repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const emit = value => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
const sourceFiles = {
  "package.json": JSON.stringify({ name: "synthetic-local-review", private: true, type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2) + "\n",
  "README.md": "# Synthetic metrics module\n\nNo dependencies. Run node --test test/*.test.js.\n\nContract: total and average accept finite numbers and nonblank numeric strings. average([]) is null. Inputs must not be mutated. slug collapses each whitespace run to one hyphen and lowercases. Cache entries expire when now >= expiresAt, including ttl=0. badge currently uses a technical default of 80; a future business threshold has not been specified in this repository.\n",
  "src/numbers.js": `export function toFiniteNumber(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) throw new TypeError('Invalid number');
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError('Invalid number');
  return value;
}
export function total(values) {
  return values.map(toFiniteNumber).reduce((sum, value) => sum + value, 0);
}
export function average(values) {
  return values.length ? total(values) / values.length : null;
}
`,
  "src/text.js": `export function slug(text) {
  return text.trim().toLowerCase().replace(' ', '-');
}
`,
  "src/cache.js": `export class ExpiringCache {
  constructor(now = () => Date.now()) { this.now = now; this.entries = new Map(); }
  set(key, value, ttl) { this.entries.set(key, { value, expiresAt: this.now() + ttl }); }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
}
`,
  "src/policy.js": `export function badge(score) {
  return score >= 80 ? 'high' : 'standard';
}
`,
  "test/numbers.test.js": `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total, average, toFiniteNumber } from '../src/numbers.js';
test('numeric total', () => assert.equal(total([2, 3]), 5));
test('numeric string total', () => assert.equal(total(['2', '3']), 5));
test('numeric string average', () => assert.equal(average(['2', '3']), 2.5));
test('empty average', () => assert.equal(average([]), null));
test('no input mutation', () => { const values = Object.freeze([2, 1]); assert.equal(total(values), 3); assert.deepEqual(values, [2, 1]); });
test('invalid numbers', () => { for (const value of ['', Infinity, {}]) assert.throws(() => toFiniteNumber(value), TypeError); });
`,
  "test/text.test.js": `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slug } from '../src/text.js';
test('simple slug', () => assert.equal(slug('Warm New'), 'warm-new'));
test('whitespace runs', () => assert.equal(slug('  Warm  New\\tYork\\nCity  '), 'warm-new-york-city'));
`,
  "test/cache.test.js": `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExpiringCache } from '../src/cache.js';
test('before expiry', () => { let now = 0; const c = new ExpiringCache(() => now); c.set('a', 1, 10); now = 9; assert.equal(c.get('a'), 1); });
test('at expiry', () => { let now = 0; const c = new ExpiringCache(() => now); c.set('a', 1, 10); now = 10; assert.equal(c.get('a'), undefined); });
test('zero TTL', () => { const c = new ExpiringCache(() => 0); c.set('a', 1, 0); assert.equal(c.get('a'), undefined); });
`,
  "test/policy.test.js": `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badge } from '../src/policy.js';
test('current technical default', () => assert.equal(badge(80), 'high'));
`,
};
const opinions = [
  { key: "number-total", path: "src/numbers.js", anchor: "return values.map", body: "total(['2','3']) 应按合同返回数字 5，但当前实现产生了字符串拼接。请核实归一化链路并修复。", verdict: "accept", theme: "numbers", tests: ["test/numbers.test.js"] },
  { key: "number-average", path: "src/numbers.js", anchor: "return values.length", body: "average(['2','3']) 应返回 2.5，目前结果错误。请调查它与 total 的共同数值转换路径，避免只针对样本打补丁。", verdict: "accept", theme: "numbers", tests: ["test/numbers.test.js"] },
  { key: "slug-whitespace", path: "src/text.js", anchor: "return text.trim", body: "合同要求连续空白（含 tab、换行）统一成一个连字符，这里只替换第一个空格。请修复规范化。", verdict: "accept", theme: "text", tests: ["test/text.test.js"] },
  { key: "cache-expiry", path: "src/cache.js", anchor: "if (this.now() >", body: "缓存合同规定 now >= expiresAt 即失效，当前在恰好到期时和 ttl=0 时仍返回旧值。请修复边界。", verdict: "accept", theme: "cache", tests: ["test/cache.test.js"] },
  { key: "false-mutation", path: "src/numbers.js", anchor: "return values.map", body: "total 在原数组上调用了 sort，导致传入数组被原地改动；请先复制数组再排序。", verdict: "reject", theme: null, tests: [] },
  { key: "missing-policy", path: "src/policy.js", anchor: "return score >=", body: "请把这一行改成最新业务审批的风控分级阈值。需求没有附具体阈值和边界，仓库里也没有这份外部策略内容。", verdict: "needs_input", theme: null, tests: [] },
];

function systemEnvironment(home = process.env.HOME) {
  return Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "SHELL"].flatMap(name => (name === "HOME" ? home : process.env[name]) === undefined ? [] : [[name, name === "HOME" ? home : process.env[name]]]));
}
async function treeSnapshot(root) {
  const entries = {};
  async function walk(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), key = prefix + entry.name, info = await lstat(path);
      if (entry.isDirectory()) await walk(path, key + "/");
      else entries[key] = { mode: info.mode & 0o777, sha256: hash(entry.isSymbolicLink() ? await readlink(path) : await readFile(path)) };
    }
  }
  await walk(root); return entries;
}
async function loadImplementation(root) {
  const server = await createServer({ root: repositoryRoot, cacheDir: join(root, "vite-cache"), configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: Object.fromEntries(["protocol", "core", "storage", "integrations"].map(name => [`@cognelis/decision-${name}`, join(repositoryRoot, `packages/${name}/src/index.ts`)])) } });
  const load = file => server.ssrLoadModule(join(repositoryRoot, `apps/desktop/src/main/${file}.ts`));
  return { server, ...(await load("local-review-git")), ...(await load("local-review-service")), ...(await load("pr-connections")), ...(await load("model/cli/managed-child-process")), ...(await load("model/profiled-model-gateway")), ...(await load("model/adapters/claude-code-cli-adapter")), ...(await load("model/adapters/codex-cli-adapter")) };
}
async function verifyNode(directory, tests, executable) {
  const nodeExecutable = await realpath(process.execPath), cliExecutable = await realpath(executable), verifierHome = join(dirname(directory), ".verifier-cli-home");
  await mkdir(verifierHome, { recursive: true });

    const entries = {":minimal":"read",":workspace_roots":"write",[nodeExecutable]:"read",[cliExecutable]:"read"};
    const settings = ['default_permissions="verify"', `permissions.verify.filesystem={${Object.entries(entries).map(([key,value])=>`${JSON.stringify(key)}=${JSON.stringify(value)}`).join(",")}}`, "permissions.verify.network.enabled=false", "features.plugins=false", "features.apps=false", "features.hooks=false", "mcp_servers={}"];
    return exec(cliExecutable, ["sandbox", "--permission-profile", "verify", "--cd", directory, ...settings.flatMap(setting=>["-c",setting]), "--", "/usr/bin/env", "-i", `HOME=${directory}`, "PATH=/usr/bin:/bin", "OPENSSL_CONF=/dev/null", nodeExecutable, "--test", "--test-reporter=tap", ...tests], {cwd:directory,env:{...systemEnvironment(),CODEX_HOME:verifierHome},encoding:"utf8",timeout:30000,maxBuffer:1024*1024});
}
async function run(root, executable, frozenLabelsPath, profileKind = "codex-cli", modelName, worker = "codex", verifierExecutable = executable) {
  if (!process.env.MODEL_PROXY_URL) throw new Error("MODEL_PROXY_URL is required; no direct fallback");
  const repo = join(root, "source"), bare = join(root, "remote.git"), gitHome = join(root, "git-home"), userData = join(root, "user-data");
  for (const directory of [repo, gitHome, userData]) await mkdir(directory, { recursive: true });
  const gitEnv = { ...systemEnvironment(gitHome), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "/usr/bin/true" };
  const git = async (cwd, args) => (await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  const frozenBytes = frozenLabelsPath ? await readFile(frozenLabelsPath) : null, frozen = frozenBytes ? JSON.parse(frozenBytes) : null;
  if (frozen) {
    for (const [file, content] of Object.entries(sourceFiles)) if (hash(content) !== frozen.sourceHashes[file]) throw new Error("Frozen fixture changed");
    await git(root, ["clone", "--no-hardlinks", "--no-checkout", "--template=", join(dirname(frozenLabelsPath), "source"), repo]);
    await git(repo, ["checkout", "-B", "main", frozen.headSha]); await git(repo, ["remote", "remove", "origin"]);
    for (const [file, expected] of Object.entries(frozen.sourceHashes)) if (hash(await readFile(join(repo, file))) !== expected) throw new Error("Frozen source differs");
  } else {
    for (const [file, content] of Object.entries(sourceFiles)) { await mkdir(dirname(join(repo, file)), { recursive: true }); await writeFile(join(repo, file), content); }
    await git(repo, ["init", "-b", "main", "--template="]); await git(repo, ["add", "."]);
    await git(repo, ["-c", "user.name=Synthetic Review", "-c", "user.email=review@example.invalid", "commit", "-m", "冻结合成样本"]);
  }
  await git(repo, ["config", "user.name", "Synthetic Review"]); await git(repo, ["config", "user.email", "review@example.invalid"]);
  await git(root, ["init", "--bare", "--template=", bare]);
  await git(repo, ["push", bare, "HEAD:refs/heads/main"]);
  const requests = [], pulls = [];
  const platform = httpServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && /\/pulls$/u.test(request.url ?? "")) {
      const pr = { number: pulls.length + 1, head: { ref: body.head, repo: { full_name: "fixture/lab" } }, base: { ref: body.base, repo: { full_name: "fixture/lab" } } };
      pulls.push(pr); response.end(JSON.stringify(pr));
    } else if (request.method === "GET" && /\/pulls\?/u.test(request.url ?? "")) response.end(JSON.stringify(pulls));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise((resolve, reject) => { platform.once("error", reject); platform.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${platform.address().port}`, displayRemote = "ssh://git@127.0.0.1/fixture/lab.git";
  await git(repo, ["remote", "add", "origin", displayRemote]);
  const implementation = await loadImplementation(root), { LocalReviewGit, LocalReviewService, PrConnections, ManagedChildProcessRunner } = implementation;
  class LocalTransport extends LocalReviewGit {
    branchOid(snapshot, branch, signal) { if (snapshot.url !== displayRemote) throw new Error("Unexpected lab target"); return super.branchOid({ ...snapshot, url: bare }, branch, signal); }
    push(copy, snapshot, oid, branch, signal) { if (snapshot.url !== displayRemote) throw new Error("Unexpected lab target"); return super.push(copy, { ...snapshot, url: bare }, oid, branch, signal); }
  }
  let service;
  const gatewayTraces = [], calls = [], originalRun = ManagedChildProcessRunner.prototype.run;
  ManagedChildProcessRunner.prototype.run = async function (request) {
    const model = ["codex-cli", "claude-code-cli"].includes(request.provider) && (request.args.includes("exec") || request.args.includes("-p")), command = request.provider === "local-review-command", probe = request.args.includes("sandbox") || command;
    if (!model && !probe) return originalRun.call(this, request);
    const nativeProbe = model && request.stdin.includes("LR_CLAUDE_SELFCHECK");
    const kind = model ? nativeProbe ? "claude-selfcheck" : request.stdin.includes("LR_EXEC_SELFCHECK") ? "exec-selfcheck" : request.stdin.includes("逐条读代码") ? "evaluation" : "fix" : command ? request.args.some(arg => arg.includes("LR_PI_COMMAND_PROBE")) ? "command-probe" : "run-command" : "quick-probe";
    const call = { index: calls.length, kind, startedAt: new Date().toISOString(), args: request.args, cwd: request.cwd, promptSha256: hash(request.stdin), auth: model ? "existing-user-login; no credential file read by driver" : "production empty-config sandbox probe" };
    const active = service?.state().jobs.find(job => ["evaluating", "running_groups"].includes(job.state)); call.groupId = active?.groups.find(group => group.state === "fixing")?.id;
    calls.push(call); emit({ event: "call-start", index: call.index, kind });
    const start = performance.now();
    try {
      const result = await originalRun.call(this, request); call.durationMs = performance.now() - start;
      const events = model ? request.provider === "claude-code-cli" && !request.args.includes("stream-json") ? [JSON.parse(result.stdout)] : result.stdout.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)) : [];
      call.usage = events.filter(event => event.type === "turn.completed" || event.type === "result").map(event => event.usage ?? null);
      call.reportedModels = events.flatMap(event => typeof event.model === "string" ? [event.model] : Object.keys(event.modelUsage ?? {}));
      call.exitCode = result.exitCode;
      if (nativeProbe) {
        const payload = JSON.parse(request.stdin.slice(request.stdin.lastIndexOf("\n") + 1));
        const settings = JSON.parse(request.args[request.args.indexOf("--settings") + 1]);
        const receiptPath = join(dirname(request.cwd), "scratch/node.json");
        if (!resolve(receiptPath).startsWith(resolve(root) + "/")) throw new Error("Native selfcheck result outside experiment");
        const file = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try { const info = await file.stat(); if (!info.isFile() || info.size > 16000) throw new Error("Invalid native selfcheck receipt"); call.selfcheck = { kind: "claude-native", phase: settings.permissions.deny.includes("Edit") ? "read" : "write", expectedNonce: payload.nonce, node: JSON.parse(await file.readFile("utf8")), toolCalls: events.flatMap(event => Array.isArray(event.message?.content) ? event.message.content.filter(block => block.type === "tool_use") : []).length }; } finally { await file.close(); }
      }
      if (kind === "exec-selfcheck") {
        const payload = JSON.parse(request.stdin.slice(request.stdin.lastIndexOf("\n") + 1));
        if (!resolve(payload.outputPath).startsWith(resolve(root) + "/")) throw new Error("Selfcheck result outside experiment");
        try {
          const file = await open(payload.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { const info = await file.stat(); if (!info.isFile() || info.size > 16000) throw new Error("Invalid selfcheck file"); call.selfcheck = JSON.parse(await file.readFile("utf8")); } finally { await file.close(); }
        } catch (error) { call.selfcheckError = error.message; }
      }
      await save(join(root, `call-${call.index}.json`), { ...call, stdout: result.stdout, stderr: result.stderr });
      emit({ event: "call-finish", index: call.index, kind, durationMs: call.durationMs, usage: call.usage }); return result;
    } catch (error) { call.durationMs = performance.now() - start; call.exitCode = error.processExitCode; call.error = { code: error.code, message: error.message, diagnostic: error.diagnosticExcerpt }; await save(join(root, `call-${call.index}.json`), call); emit({ event: "call-failed", index: call.index, kind, error: call.error }); throw error; }
  };
  const credentials = new Map(), connections = new PrConnections(join(userData, "pr-connections.json"), { get: async key => credentials.get(key) ?? null, set: async (key, value) => { credentials.set(key, value); }, delete: async key => credentials.delete(key) });
  await connections.save({ label: "Local synthetic GitHub", platform: "github", baseUrl, token: "synthetic-local-platform-token" });
  const profile = { version: 1, profileId: `live-${profileKind}`, kind: profileKind, label: `${profileKind} live run`, enabled: true, priority: 0, timeoutMs: 120000, executablePath: await realpath(executable), ...(modelName ? { model: modelName } : {}) };
  // The driver never opens credential files. Only model children use the existing login.
  const environment = isolationEnvironment(root, { ...systemEnvironment(), CODEX_HOME: join(homedir(), ".codex"), ...(process.env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR } : {}), MODEL_PROXY_URL: process.env.MODEL_PROXY_URL });
  const gateway = new implementation.ProfiledModelGateway({ profiles: { load: async () => [profile] }, providerFactory: selected => selected.kind === "claude-code-cli" ? new implementation.ClaudeCodeCliAdapter({ profile: selected, environment }) : new implementation.CodexCliAdapter({ profile: selected, environment }), traces: { record: async trace => { gatewayTraces.push(trace); return trace; } }, audit: { fingerprint: async text => hash(text), record: async () => undefined, summary: async () => ({}) } });
  service = new LocalReviewService(join(userData, "local-review"), new LocalTransport("/usr/bin/git", gitEnv, true), connections, async () => [profile], environment, undefined, gateway);
  let timer, jobId, result;
  try {
    await service.start(); const sessionId = await service.register(repo), repositoryId = service.state().repositories[0].id;
    const labels = { version: 1, synthetic: true, frozenAt: new Date().toISOString(), headSha: (await git(repo, ["rev-parse", "HEAD"])).trim(), sourceHashes: Object.fromEntries(Object.entries(sourceFiles).map(([file, content]) => [file, hash(content)])), opinions: [] };
    for (const opinion of opinions) {
      const line = sourceFiles[opinion.path].split("\n").findIndex(text => text.includes(opinion.anchor)) + 1;
      if (line < 1) throw new Error(`Missing annotation anchor ${opinion.key}`);
      const id = await service.annotate({ repositoryId, sessionId, path: opinion.path, side: "new", startLine: line, endLine: line, body: opinion.body });
      labels.opinions.push({ id, key: opinion.key, expectedVerdict: opinion.verdict, independentTheme: opinion.theme, tests: opinion.tests });
    }
    if (frozen) {
      if (frozen.opinions.length !== labels.opinions.length || labels.opinions.some(label => { const old = frozen.opinions.find(old => old.key === label.key); return !old || old.expectedVerdict !== label.expectedVerdict || old.independentTheme !== label.independentTheme || JSON.stringify(old.tests) !== JSON.stringify(label.tests); })) throw new Error("Frozen opinions differ");
      await save(join(root, "annotation-map.json"), labels.opinions.map(label => ({ key: label.key, frozenId: frozen.opinions.find(old => old.key === label.key).id, id: label.id })));
      await writeFile(join(root, "expected-labels.json"), frozenBytes);
    } else await save(join(root, "expected-labels.json"), labels);
    await chmod(join(root, "expected-labels.json"), 0o444);
    const labelsSha256 = hash(await readFile(join(root, "expected-labels.json"))); await writeFile(join(root, "expected-labels.sha256"), labelsSha256 + "\n");
    let baseline; try { baseline={passed:true,...await verifyNode(repo,Object.keys(sourceFiles).filter(file=>file.startsWith("test/")),verifierExecutable)}; } catch(error) { baseline={passed:false,exitCode:error.code,stdout:error.stdout,stderr:error.stderr}; }
    await save(join(root,"baseline-tests.json"),baseline);
    const before = await treeSnapshot(repo); await save(join(root, "source-before.json"), before);
    await save(join(root, "initial-session.json"), service.state());
    emit({ event: "frozen", labelsSha256, opinions: labels.opinions.length });
    const started = performance.now();
    timer = setInterval(() => emit({ event: "progress", jobs: service.state().jobs.map(job => ({ state: job.state, groups: job.groups.map(group => ({ ordinal: group.ordinal, state: group.state })) })) }), 15000);
    jobId = await service.submit(repositoryId, sessionId, profile.profileId, worker); await service.idle();
    const job = service.state().jobs.find(job => job.id === jobId), modelDurationMs = performance.now() - started;
    await save(join(root, "job.json"), job); await save(join(root, "platform-requests.json"), requests);
    for (const group of job.groups) if (group.artifact) await writeFile(join(root, `group-${group.ordinal}.diff`), group.artifact.diff);
    const verdicts = labels.opinions.map(label => ({ ...label, actual: job.verdicts.find(v => v.id === label.id) ?? null, matches: job.verdicts.find(v => v.id === label.id)?.verdict === label.expectedVerdict }));
    const groupThemes = job.groups.map(group => ({ groupId: group.id, themes: [...new Set(labels.opinions.filter(label => group.annotationIds.includes(label.id)).map(label => label.independentTheme))], annotationIds: group.annotationIds }));
    const sameRootIds = labels.opinions.filter(label => label.independentTheme === "numbers").map(label => label.id);
    const sameRootTogether = job.groups.some(group => sameRootIds.every(id => group.annotationIds.includes(id))), unrelatedSeparated = groupThemes.every(group => group.themes.length === 1);
    const verification = [];
    for (const group of job.groups.filter(group => group.artifact)) {
      const directory = join(root, `verify-${group.ordinal}`);
      await git(root, ["clone", "--no-checkout", "--template=", bare, directory]);
      const source = group.pushObservedSha ? bare : join(userData, "local-review/jobs", job.id, group.id, "git");
      await git(directory, ["fetch", source, group.artifact.commitOid]); await git(directory, ["checkout", "--detach", group.artifact.commitOid]);
      for (const [file, content] of Object.entries(sourceFiles).filter(([file]) => file.startsWith("test/"))) { await mkdir(dirname(join(directory, file)), { recursive: true }); await writeFile(join(directory, file), content); }
      const tests = [...new Set(labels.opinions.filter(label => group.annotationIds.includes(label.id)).flatMap(label => label.tests))];
      let checked; try { const output = await verifyNode(directory, tests, verifierExecutable); checked = { passed: true, ...output }; } catch (error) { checked = { passed: false, exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
      await save(join(root, `group-${group.ordinal}-tests.json`), { tests, ...checked }); verification.push({ groupId: group.id, tests, passed: checked.passed });
    }
    const after = await treeSnapshot(repo); await save(join(root, "source-after.json"), after);
    result = { labelsSha256, jobId, state: job.state, worker, profileKind, model: modelName ?? "codex-default (no --model override)", reportedModels: [...new Set(calls.flatMap(call => call.reportedModels ?? []))], modelDurationMs, verdicts, groupThemes, sameRootTogether, unrelatedSeparated, verification, sourceUnchanged: JSON.stringify(before) === JSON.stringify(after), selfchecks: calls.filter(call => ["exec-selfcheck", "claude-selfcheck"].includes(call.kind)).map(call => call.selfcheck ?? { error: call.selfcheckError ?? call.error }), usage: calls.filter(call => ["exec-selfcheck", "claude-selfcheck", "evaluation", "fix"].includes(call.kind)).map(call => ({ kind: call.kind, durationMs: call.durationMs, usage: call.usage })), prRequests: requests.filter(request => request.method === "POST").length };
    result.passed = verdicts.every(v => v.matches) && sameRootTogether && unrelatedSeparated && verification.length > 0 && verification.every(v => v.passed) && result.sourceUnchanged && job.groups.every(group => ["pr_opened", "no_changes"].includes(group.state));
    await save(join(root, "result.json"), result); emit({ event: "complete", passed: result.passed, state: job.state, sourceUnchanged: result.sourceUnchanged, prRequests: result.prRequests });
  } catch (error) {
    await save(join(root, "failure.json"), { message: error.message, code: error.code, jobId, state: service.state(), calls }); throw error;
  } finally {
    clearInterval(timer); await service.close(); await gateway.close?.(); ManagedChildProcessRunner.prototype.run = originalRun;
    await save(join(root, "calls.json"), calls); await save(join(root, "gateway-traces.json"), gatewayTraces); await save(join(root, "platform-requests.json"), requests);
    platform.closeAllConnections(); await new Promise(resolve => platform.close(resolve)); await implementation.server.close();
  }
  return result;
}

async function verifySaved(root, executable) {
  const labelsBytes = await readFile(join(root, "expected-labels.json")), labels = JSON.parse(labelsBytes);
  const mapping = await readFile(join(root, "annotation-map.json"), "utf8").then(JSON.parse, () => null);
  if (mapping) labels.opinions = labels.opinions.map(label => ({ ...label, id: mapping.find(entry => entry.frozenId === label.id && entry.key === label.key)?.id ?? label.id }));
  if (hash(labelsBytes) !== (await readFile(join(root, "expected-labels.sha256"), "utf8")).trim()) throw new Error("Frozen labels changed");
  for (const [file, content] of Object.entries(sourceFiles)) if (hash(content) !== labels.sourceHashes[file]) throw new Error("Frozen fixture changed");
  const result = JSON.parse(await readFile(join(root, "result.json"), "utf8")), job = JSON.parse(await readFile(join(root, "job.json"), "utf8"));
  if (!await access(join(root, "initial-verification.json")).then(() => true, () => false)) await save(join(root, "initial-verification.json"), result);
  const env = { ...systemEnvironment(join(root, "git-home")), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "/usr/bin/true" };
  const git = async (cwd, args) => (await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd, env, encoding: "utf8", timeout: 30000 })).stdout;
  const check = async (directory, tests) => { try { return { passed: true, ...await verifyNode(directory, tests, executable) }; } catch (error) { return { passed: false, exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; } };
  const baseline = await check(join(root, "source"), Object.keys(sourceFiles).filter(file => file.startsWith("test/")));
  await save(join(root, "baseline-tests-corrected.json"), baseline);
  const verification = [];
  for (const group of job.groups.filter(group => group.artifact)) {
    const directory = join(root, `verify-${group.ordinal}`);
    if ((await git(directory, ["rev-parse", "HEAD"])).trim() !== group.artifact.commitOid) throw new Error("Verification revision changed");
    for (const [file, content] of Object.entries(sourceFiles).filter(([file]) => file.startsWith("test/"))) { await mkdir(dirname(join(directory, file)), { recursive: true }); await writeFile(join(directory, file), content); }
    const tests = [...new Set(labels.opinions.filter(label => group.annotationIds.includes(label.id)).flatMap(label => label.tests))], checked = await check(directory, tests);
    await save(join(root, `group-${group.ordinal}-tests-corrected.json`), { tests, ...checked }); verification.push({ groupId: group.id, tests, passed: checked.passed });
  }
  const combined = await mkdtemp(join(root, "verify-combined-"));
  let combinedTests;
  try {
    await git(root, ["clone", "--template=", join(root, "remote.git"), combined]);
    await git(combined, ["checkout", "--detach", labels.headSha]);
    await git(combined, ["config", "user.name", "Synthetic Verification"]); await git(combined, ["config", "user.email", "verification@example.invalid"]);
    for (const group of job.groups.filter(group => group.artifact)) await git(combined, ["cherry-pick", group.artifact.commitOid]);
    for (const [file, content] of Object.entries(sourceFiles).filter(([file]) => file.startsWith("test/"))) await writeFile(join(combined, file), content);
    combinedTests = await check(combined, Object.keys(sourceFiles).filter(file => file.startsWith("test/")));
  } catch(error) { combinedTests = {passed:false,stage:"merge",directory:combined,stdout:error.stdout,stderr:error.stderr,message:error.message}; }
  await save(join(root, "combined-tests.json"), combinedTests);
  const unchanged = JSON.stringify(await treeSnapshot(join(root, "source"))) === JSON.stringify(JSON.parse(await readFile(join(root, "source-before.json"), "utf8")));
  const artifacts = job.groups.filter(group => group.artifact), pairwiseMerges = [], committedFiles = [], agentVerification = [];
  const savedCalls = JSON.parse(await readFile(join(root, "calls.json"), "utf8"));
  for (const group of artifacts) {
    const paths = (await git(join(root, "remote.git"), ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", group.artifact.commitOid])).split("\0").filter(Boolean);
    committedFiles.push({ groupId: group.id, paths, cachePaths: paths.filter(path => /(?:^|\/)(?:Library\/Caches|node_modules|\.cache|\.npm|scratch)(?:\/|$)|\.py[co]$/u.test(path)) });
    let commands = [];
    if (job.worker === "pi") {
      for (const raw of savedCalls.filter(call => call.kind === "run-command" && (call.groupId === group.id || call.cwd.endsWith(`/${group.id}/tree`)))) {
        const call = JSON.parse(await readFile(join(root, `call-${raw.index}.json`), "utf8"));
        commands.push({ command: call.args.slice(2).join(" ").replace(/npm-cli\.js(?=\s)/u, "npm"), exit_code: call.exitCode, aggregated_output: call.stdout ?? call.error?.diagnostic ?? "" });
      }
    } else if (job.worker === "claude-code") {
      for (const fixCall of savedCalls.filter(call => call.kind === "fix" && (call.groupId === group.id || call.cwd.endsWith(`/${group.id}/tree`)))) {
        const call = JSON.parse(await readFile(join(root, `call-${fixCall.index}.json`), "utf8"));
        const nativeCalls = new Map();
        for (const line of call.stdout.split(/\r?\n/u).filter(Boolean)) {
          const event = JSON.parse(line);
          for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
            if (block.type === "tool_use" && block.name === "Bash") nativeCalls.set(block.id, block.input.command);
            if (block.type === "tool_result" && nativeCalls.has(block.tool_use_id)) {
              const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
              commands.push({ command: nativeCalls.get(block.tool_use_id), exit_code: block.is_error ? Number(/Exit code (\d+)/u.exec(output)?.[1] ?? -1) : 0, aggregated_output: output });
            }
          }
        }
      }
    } else {
      const fixCall = savedCalls.find(call => call.kind === "fix" && (call.groupId === group.id || call.cwd.endsWith(`/${group.id}/tree`)));
      if (fixCall) { const call = JSON.parse(await readFile(join(root, `call-${fixCall.index}.json`), "utf8")); commands = call.stdout.split(/\r?\n/u).filter(Boolean).map(JSON.parse).filter(event => event.type === "item.completed" && event.item?.type === "command_execution").map(event => event.item); }
    }
    const tests = commands.filter(item => /(?:node\s+--test|npm\s+(?:run\s+)?test)/u.test(item.command ?? "") && typeof item.exit_code === "number" && /(?:TAP version \d+|# tests \d+|ℹ tests \d+)/u.test(item.aggregated_output ?? ""));
    agentVerification.push({ groupId: group.id, ranTests: tests.length > 0, testCommands: tests, verification: group.fix?.verification });
    for (const other of artifacts.filter(other => other.id !== group.id)) {
      const directory = await mkdtemp(join(root, `verify-pair-${group.ordinal}-${other.ordinal}-`));
      try {
        await git(root, ["clone", "--template=", join(root, "remote.git"), directory]); await git(directory, ["checkout", "--detach", labels.headSha]);
        await git(directory, ["-c", "user.name=Synthetic Verification", "-c", "user.email=verification@example.invalid", "cherry-pick", group.artifact.commitOid, other.artifact.commitOid]);
        pairwiseMerges.push({ groups: [group.id, other.id], passed: true, directory });
      } catch (error) { pairwiseMerges.push({ groups: [group.id, other.id], passed: false, directory, stdout: error.stdout, stderr: error.stderr }); }
    }
  }
  await save(join(root, "pairwise-merges.json"), pairwiseMerges); await save(join(root, "committed-files.json"), committedFiles); await save(join(root, "agent-verification.json"), agentVerification);
  Object.assign(result, { verification, combinedTestsPassed: combinedTests.passed, pairwiseMerges, committedFiles, agentVerification, sourceUnchanged: unchanged });
  result.passed = result.verdicts.every(v => v.matches) && result.sameRootTogether && result.unrelatedSeparated && artifacts.length === 3 && verification.every(v => v.passed) && combinedTests.passed && unchanged && pairwiseMerges.every(pair => pair.passed) && committedFiles.every(group => !group.cachePaths.length) && agentVerification.every(group => group.ranTests) && job.groups.every(group => group.state === "pr_opened");
  await save(join(root, "result.json"), result); emit({ event: "verification-complete", passed: result.passed, combinedTestsPassed: combinedTests.passed, sourceUnchanged: unchanged });
  if (!result.passed) process.exitCode = 1;
}

async function smoke(root, executable) {
  const sourceRoot = resolve(root), smokeRoot = join(root, "app-smoke"), home = join(smokeRoot, "home");
  await mkdir(home, { recursive: true });
  const initial = JSON.parse(await readFile(join(sourceRoot, "initial-session.json"), "utf8"));
  const ledger = { version: 1, repositories: initial.repositories, sessions: initial.sessions, jobs: [], owners: [] };
  await mkdir(join(smokeRoot, "user-data/local-review"), { recursive: true }); await save(join(smokeRoot, "user-data/local-review/ledger.json"), ledger);
  const reserve = httpServer(); await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const wrapper = join(smokeRoot, "start-app");
  await writeFile(wrapper, `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} "$@"\n`, { mode: 0o700 });
  const frontSamples = [], front = async () => { try { const value = (await exec("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" })).stdout.trim(); const info = (await exec("/usr/bin/lsappinfo", ["info", "-only", "pid,name", value], { encoding: "utf8" })).stdout; frontSamples.push({ at: new Date().toISOString(), value, info }); } catch {} };
  await front(); const monitor = setInterval(() => { void front(); }, 500);
  const app = await startIsolatedApp({ root: smokeRoot, executable: wrapper, useLocalModels: false, showWindow: false, base: { ...systemEnvironment(home), PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } });
  let socket;
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) { const values = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []); target = values.find(value => { try { return value.type === "page" && value.webSocketDebuggerUrl && value.url.startsWith("file:") && fileURLToPath(value.url).startsWith(resolve(dirname(executable), "../Resources") + "/"); } catch { return false; } }); if (!target) await new Promise(resolve => setTimeout(resolve, 100)); }
    if (!target) throw new Error("Packaged App CDP page unavailable");
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let next = 0; const pending = new Map(); socket.addEventListener("message", event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); } });
    const command = (method, params) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async expression => { const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; };
    let ready = false; for (let i = 0; i < 100 && !ready; i++) { ready = await evaluate("typeof window.decision?.getLocalReviewState === 'function'"); if (!ready) await new Promise(resolve => setTimeout(resolve, 100)); }
    const ipc = await evaluate(`(async()=>{const state=await window.decision.getLocalReviewState(); const session=state.sessions[0]; const files=await window.decision.loadLocalReviewFiles({repositoryId:session.repositoryId,sessionId:session.id}); const content=await window.decision.readLocalReviewFile({repositoryId:session.repositoryId,sessionId:session.id,path:'src/numbers.js',side:'new'}); await window.decision.openSurface('local-review'); return {repositories:state.repositories.length,sessions:state.sessions.length,files:files.files.length,contentPresent:content.includes('toFiniteNumber')};})()`);
    let heading = ""; for (let i = 0; i < 100 && !heading; i++) { heading = await evaluate("document.querySelector('.local-review-panel:not([hidden]) h1')?.textContent ?? ''"); if (!heading) await new Promise(resolve => setTimeout(resolve, 100)); }
    await front(); const result = { pid: app.child.pid, smoke: app.env.PARASELF_SMOKE, heading, ipc, frontSamples, passed: heading === "本地审阅" && ipc.contentPresent && ipc.files > 0 && !frontSamples.some(sample => new RegExp(`pid[^0-9]+${app.child.pid}(?:[^0-9]|$)`).test(sample.info)) };
    await save(join(root, "app-smoke.json"), result); emit({ event: "app-smoke", passed: result.passed, heading, ipc }); return result;
  } finally { socket?.close(); clearInterval(monitor); await app.stop(); await writeFile(join(root, "app-smoke.stderr"), app.stderr()); }
}

const args = parseArgs({ options: { root: { type: "string" }, executable: { type: "string" }, verify: { type: "boolean" }, smoke: { type: "boolean" }, app: { type: "string" }, labels: { type: "string" }, "profile-kind": { type: "string" }, model: { type: "string" }, worker: { type: "string" }, "verifier-executable": { type: "string" } } }).values;
const root = args.root ? resolve(args.root) : await mkdtemp(join(process.env.PARASELF_LAB_ROOT ?? tmpdir(), "paraself-local-review-"));
try {
  if (args.verify) {
    if (!args.executable) throw new Error("--executable is required for verification");
    await verifySaved(root, args.executable);
  } else if (args.smoke) {
    if (!args.app) throw new Error("--app must explicitly name the built App executable");
    const result = await smoke(root, resolve(args.app)); if (!result.passed) process.exitCode = 1;
  } else {
    await mkdir(root, { recursive: true });
    if (await access(join(root, "expected-labels.json")).then(() => true, () => false)) throw new Error("Experiment already frozen; choose a new root");
    const profileKind = args["profile-kind"] ?? "codex-cli";
    if (!["codex-cli", "claude-code-cli"].includes(profileKind)) throw new Error("Lab profiles support codex-cli and claude-code-cli; HTTP credentials are not read from user settings");
    const find = async name => { for (const directory of (process.env.PATH ?? "").split(delimiter).filter(path => path.startsWith("/"))) { const candidate = join(directory, name); if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate; } return null; };
    const executable = args.executable ?? await find(profileKind === "claude-code-cli" ? "claude" : "codex");
    const verifier = args["verifier-executable"] ?? await find("codex");
    if (!executable || !verifier) throw new Error("Model executable and independent Codex sandbox verifier must be available");
    const worker = args.worker ?? (profileKind === "codex-cli" ? "codex" : "pi");
    if (!["codex", "pi", "claude-code"].includes(worker)) throw new Error("Unknown local-review worker");
    await mkdir(join(root, "driver-tmp"), { recursive: true }); process.env.TMPDIR = join(root, "driver-tmp");
    await run(root, executable, args.labels ? resolve(args.labels) : undefined, profileKind, args.model, worker, verifier); await verifySaved(root, verifier);
  }
} catch (error) { emit({ event: "failed", error: error.message, root }); process.exitCode = 2; }
