#!/usr/bin/env node
// LR-I10 driver: the task conversation, end to end, on a synthetic repository, a loopback "SSH" remote and a loopback fake
// code platform. Two entry points share one scenario script (see runtime-plan.md):
//
//   --fixture                      source-level Service + scripted Pi gateway. No model of any kind. Fast feedback for this
//                                  driver and the service; never a substitute for the App run.
//   --app <Paraself executable>    THE real path: an isolated candidate App (isolated-app.mjs), driven through its own preload
//                                  API and DOM (buttons, composer, quote button, plan card). Pi worker + claude-code-cli
//                                  (sonnet) for the whole chain, then Codex native (gpt-6-luna) for ONE read-only discussion.
//                                  Screenshots are taken during this same run (light and dark). Refuses to start unless
//                                  LR_I10_REAL_RUN_APPROVED=1 (set only after the parent's review) and MODEL_PROXY_URL is set.
//   --app <...> --dry              launches the App and checks everything up to (not including) the first model call.
//
// Subscription logins only: no API key (refused if present), no usage credits. MODEL_PROXY_URL is read by the driver and
// handed to the synthetic App through its normal API; it is never put in the App's environment. HOME exists only so the
// CLIs can authenticate; every business path (repo, remote, user-data, vault, spool, tmp) lives under --root.
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { dirname, join, resolve, delimiter } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { isolationEnvironment, startIsolatedApp } from "./isolated-app.mjs";

delete process.env.PARASELF_PROVIDER_CHILD; delete process.env.DECISION_PROVIDER_CHILD;
const exec = promisify(execFile), repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const emit = value => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n");
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const systemEnvironment = (home = process.env.HOME) => Object.fromEntries(["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TZ", "SHELL"].flatMap(name => (name === "HOME" ? home : process.env[name]) === undefined ? [] : [[name, name === "HOME" ? home : process.env[name]]]));

// ------------------------------------------------------------------------------------------------------------- scenario
// The comment is genuinely under-specified: README and the passing tests say nothing about how amounts should be shown, so a
// competent reviewer cannot act without asking. Nothing here is edited to force a verdict; the real first verdict is recorded.
const sourceFiles = {
  "package.json": JSON.stringify({ name: "synthetic-price", private: true, type: "module", scripts: { test: "node --test test/*.test.js" } }, null, 2) + "\n",
  "README.md": "# Synthetic price module\n\nformatPrice(cents) turns an integer amount of cents into display text.\n",
  "src/price.js": "export function formatPrice(cents) {\n  return '¥' + (cents / 100).toFixed(2);\n}\n",
  "test/price.test.js": "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatPrice } from '../src/price.js';\ntest('basic', () => assert.equal(formatPrice(1250), '¥12.50'));\ntest('zero', () => assert.equal(formatPrice(0), '¥0.00'));\n",
};
const vagueOpinion = { path: "src/price.js", anchor: "return '¥'", body: "金额显示不符合业务习惯，请改一下。" };
// A clearly wrong claim for the Codex discussion: evaluation should reject it, the discussion then explains why (read-only).
const falseClaim = { path: "src/price.js", anchor: "return '¥'", body: "cents / 100 在 cents 为 0 时会抛出除零错误，请加保护。" };
// Hidden verification, never shown to any model: copied into a fresh checkout of each pushed tip.
const verifyAfterFirst = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatPrice } from '../src/price.js';\ntest('thousands separators', () => { assert.equal(formatPrice(1234567), '¥12,345.67'); assert.equal(formatPrice(5), '¥0.05'); assert.equal(formatPrice(100000000), '¥1,000,000.00'); });\n";
const verifyAfterAppend = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatPrice, formatPriceList } from '../src/price.js';\ntest('price list helper', () => { assert.deepEqual(formatPriceList([1250, 1234567, 5]), ['¥12.50', '¥12,345.67', '¥0.05']); assert.deepEqual(formatPriceList([]), []); assert.equal(formatPrice(1234567), '¥12,345.67'); });\n";
const messages = {
  why: "为什么需要补充信息？你想让我补充什么？",
  supply: "补充：金额要按千分位分隔，保留两位小数，货币符号 ¥ 放最前面，例如 1234567 分显示为 ¥12,345.67。请按这个改，给我一个方案。",
  // A genuinely new requirement the first fix cannot have anticipated (a first fix once added negatives unprompted; that scenario was too guessable).
  append: "在这个组追加导出 formatPriceList(list)：返回 list.map(formatPrice) 对应的字符串数组（顺序不变），空数组返回空数组。给我方案，不要直接改。",
  more: "再加一个导出 formatPriceTotal(list)：把列表金额求和后用 formatPrice 格式化。先给方案，不要改，也不要执行。",
  explain: "为什么这样判断？请只读代码回答，不要改任何文件。",
};

async function find(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(path => path.startsWith("/"))) { const candidate = join(directory, name); if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate; }
  return null;
}
// Content and modes of every file including .git (HEAD, refs, index, config), never atimes.
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
async function sandboxedNodeTest(directory, tests, verifier) {
  const nodeExecutable = await realpath(process.execPath);
  if (!verifier) return exec(nodeExecutable, ["--test", "--test-reporter=tap", ...tests], { cwd: directory, env: systemEnvironment(directory), encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
  const cli = await realpath(verifier), home = join(dirname(directory), ".verifier-cli-home"); await mkdir(home, { recursive: true });
  const entries = { ":minimal": "read", ":workspace_roots": "write", [nodeExecutable]: "read", [cli]: "read" };
  const settings = ['default_permissions="verify"', `permissions.verify.filesystem={${Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(",")}}`, "permissions.verify.network.enabled=false", "features.plugins=false", "features.apps=false", "features.hooks=false", "mcp_servers={}"];
  return exec(cli, ["sandbox", "--permission-profile", "verify", "--cd", directory, ...settings.flatMap(s => ["-c", s]), "--", "/usr/bin/env", "-i", `HOME=${directory}`, "PATH=/usr/bin:/bin", "OPENSSL_CONF=/dev/null", nodeExecutable, "--test", "--test-reporter=tap", ...tests], { cwd: directory, env: { ...systemEnvironment(), CODEX_HOME: home }, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 });
}

// ------------------------------------------------------------------------------------------------------ shared environment
async function prepare(root) {
  const repo = join(root, "source"), bare = join(root, "remote.git"), gitHome = join(root, "git-home"), userData = join(root, "user-data"), home = join(root, "home"), tmp = join(root, "driver-tmp");
  for (const directory of [repo, gitHome, userData, home, tmp, join(userData, "local-review")]) await mkdir(directory, { recursive: true });
  const gitEnv = { ...systemEnvironment(gitHome), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "/usr/bin/true" };
  const git = async (cwd, args) => (await exec("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], { cwd, env: gitEnv, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  for (const [file, content] of Object.entries(sourceFiles)) { await mkdir(dirname(join(repo, file)), { recursive: true }); await writeFile(join(repo, file), content); }
  await git(repo, ["init", "-b", "main", "--template="]); await git(repo, ["add", "."]);
  await git(repo, ["-c", "user.name=Synthetic Review", "-c", "user.email=review@example.invalid", "commit", "-m", "synthetic fixture"]);
  await git(repo, ["config", "user.name", "Synthetic Review"]); await git(repo, ["config", "user.email", "review@example.invalid"]);
  await git(root, ["init", "--bare", "--template=", bare]); await git(repo, ["push", bare, "HEAD:refs/heads/main"]);
  // The only network "SSH" there is: a script that serves the local bare repository and refuses anything else.
  const sshLog = join(root, "ssh-calls.log"), ssh = join(root, "local-ssh");
  await writeFile(ssh, `#!/bin/sh\necho "$*" >> ${quote(sshLog)}\ncase "$*" in\n *git-upload-pack*) exec /usr/bin/git upload-pack ${quote(bare)} ;;\n *git-receive-pack*) exec /usr/bin/git receive-pack ${quote(bare)} ;;\n *) exit 2 ;;\nesac\n`, { mode: 0o700 });
  await git(repo, ["remote", "add", "origin", "ssh://fixture@127.0.0.1/fixture/lab.git"]); await git(repo, ["config", "core.sshCommand", ssh]);
  const requests = [], pulls = [], comments = [];
  const platform = httpServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null, url = (request.url ?? "").replace(/^\/api\/v3/u, ""), path = url.split("?")[0];
    requests.push({ method: request.method, url: request.url }); response.setHeader("content-type", "application/json");
    const sha = async ref => (await exec("/usr/bin/git", ["--git-dir", bare, "rev-parse", ref], { encoding: "utf8" })).stdout.trim();
    const detail = /^\/repos\/fixture\/lab\/pulls\/(\d+)$/u.exec(path ?? "");
    if (request.method === "POST" && path === "/repos/fixture/lab/pulls") { const pr = { number: pulls.length + 1, head: { ref: body.head, repo: { full_name: "fixture/lab" } }, base: { ref: body.base, repo: { full_name: "fixture/lab" } }, body: body.body }; pulls.push(pr); response.end(JSON.stringify(pr)); }
    else if (request.method === "GET" && detail) { const pr = pulls[Number(detail[1]) - 1]; if (!pr) { response.statusCode = 404; response.end("{}"); return; } response.end(JSON.stringify({ title: "pr", state: "open", merged: false, head: { sha: await sha(`refs/heads/${pr.head.ref}`), ref: pr.head.ref, repo: { full_name: "fixture/lab" } }, base: { sha: await sha(`refs/heads/${pr.base.ref}`), ref: pr.base.ref, repo: { full_name: "fixture/lab" } } })); }
    else if (request.method === "GET" && /^\/repos\/fixture\/lab\/issues\/\d+\/comments$/u.test(path ?? "")) response.end(JSON.stringify(comments));
    else if (request.method === "GET" && /^\/repos\/fixture\/lab\/pulls\/\d+\/comments$/u.test(path ?? "")) response.end("[]");
    else if (request.method === "POST" && /^\/repos\/fixture\/lab\/issues\/\d+\/comments$/u.test(path ?? "")) { const comment = { id: comments.length + 1, body: body.body, created_at: new Date().toISOString(), user: { login: "paraself-lab" } }; comments.push(comment); response.end(JSON.stringify({ id: comment.id })); }
    else if (request.method === "GET" && path === "/repos/fixture/lab/pulls") response.end(JSON.stringify(pulls));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise((resolvePromise, reject) => { platform.once("error", reject); platform.listen(0, "127.0.0.1", resolvePromise); });
  const baseUrl = `http://127.0.0.1:${platform.address().port}`;
  // Snapshot only after every piece of setup (remote, sshCommand, bare push) is done.
  const before = await treeSnapshot(repo), head = await git(repo, ["rev-parse", "HEAD"]);
  return { root, repo, bare, sshLog, userData, home, tmp, git, gitEnv, platform, baseUrl, requests, pulls, comments, before, head, close: () => { platform.closeAllConnections(); return new Promise(resolvePromise => platform.close(resolvePromise)); } };
}

// -------------------------------------------------------------------------------------------------------- the scenario
// `c` is a controller: { ctx, state(), annotate(opinion), submit(profileId, worker), ask(jobId, body, refs), execute(jobId, messageId), shoot(name) }.
async function scenario(c, checks, options) {
  // A failed check stops the run at once: no further model quota is spent on a broken precondition, and the evidence is kept as is.
  const check = (name, passed, detail) => { checks.push({ name, passed: !!passed, ...(detail === undefined ? {} : { detail }) }); emit({ event: "check", name, passed: !!passed }); if (!passed) throw new Error(`Check failed: ${name}`); };
  const { ctx } = c;
  const verify = async (label, branch, extra) => {
    const directory = join(ctx.root, `verify-${label}`); await ctx.git(ctx.root, ["clone", "--no-checkout", "--template=", ctx.bare, directory]);
    await ctx.git(directory, ["fetch", ctx.bare, `refs/heads/${branch}`]); await ctx.git(directory, ["checkout", "--detach", "FETCH_HEAD"]);
    for (const [name, content] of Object.entries(extra)) await writeFile(join(directory, "test", name), content);
    let passed = true, output = ""; try { output = (await sandboxedNodeTest(directory, ["test/price.test.js", ...Object.keys(extra).map(n => `test/${n}`)], options.verifier)).stdout; } catch (error) { passed = false; output = `${error.stdout ?? ""}${error.stderr ?? ""}`; }
    await save(join(ctx.root, `verify-${label}.json`), { branch, passed, output: output.slice(0, 20000) }); return passed;
  };
  const annotationId = await c.annotate(vagueOpinion);
  const jobId = await c.submit(options.profileId, "pi");
  const job = async () => (await c.state()).jobs.find(j => j.id === jobId);
  const lastWorker = async () => (await job()).conversation.messages.filter(m => m.role === "worker").at(-1);
  // 1. the real first verdict is recorded, not asserted: a model that accepts and fixes is a legitimate outcome and the flow adapts.
  const first = await job(), initialVerdict = first.verdicts[0]?.verdict;
  check("1 the first evaluation finished with the real verdict needs_input and no group (nothing is adapted or forced)", first.state === "no_changes" && initialVerdict === "needs_input" && first.groups.length === 0, { state: first.state, verdict: initialVerdict, reason: first.verdicts[0]?.reason?.slice(0, 300), groups: first.groups.length });
  // 2. ask why, quoting the comment through the quote button
  const why = await c.ask(jobId, messages.why, [{ kind: "annotation", id: annotationId }]);
  check("2 the question is answered by the worker (answered turn, a reply, the quote reached the message references)", why.turn?.state === "answered" && !!(await lastWorker())?.body && why.userMessage?.references?.some(r => r.kind === "annotation" && r.id === annotationId), { reply: (await lastWorker())?.body.slice(0, 300) });
  check("2b discussion changed nothing: no execution and no new PR", (await job()).executions.length === 0 && ctx.pulls.length === first.groups.filter(g => g.state === "pr_opened").length);
  // 3. supply the missing information; a plan card must come back and nothing may run before the click
  await c.ask(jobId, messages.supply, [{ kind: "annotation", id: annotationId }]);
  const plan = (await lastWorker())?.plan, executionsBeforeClick = (await job()).executions.length;
  check("3 the worker proposes an executable plan card for a new group and no execution exists before the click", !!plan?.executable && plan.target.kind === "new" && executionsBeforeClick === 0, { target: plan?.target, expectedChanges: plan?.expectedChanges?.slice(0, 300) });
  await c.shoot("plan-card-before-click", jobId, (await lastWorker()).seq);
  // 4. click execute (App: the real button)
  await c.execute(jobId, (await lastWorker()).id);
  const afterFirst = await job(), firstExecution = afterFirst.executions.at(-1), group = afterFirst.groups.at(-1);
  check("4 the click produced a done execution, a pushed branch and an opened PR", firstExecution?.state === "done" && group?.state === "pr_opened" && ctx.pulls.length >= 1, { execution: firstExecution?.state, group: group?.state, pulls: ctx.pulls.length });
  check("4b the pushed branch passes the scenario tests plus the hidden thousands-separator test in an independent sandbox", await verify("first", group.branch, { "verify-first.test.js": verifyAfterFirst }));
  const firstTip = await ctx.git(ctx.bare, ["rev-parse", `refs/heads/${group.branch}`]);
  // 5. append to the same group
  await c.ask(jobId, messages.append, [{ kind: "group", id: group.id }]);
  const appendPlan = (await lastWorker())?.plan;
  check("5 the append plan targets the existing group and is executable", appendPlan?.target?.kind === "existing" && appendPlan.target.groupId === group.id && appendPlan.executable, { target: appendPlan?.target });
  const commentsBefore = ctx.comments.length;
  await c.execute(jobId, (await lastWorker()).id);
  const secondTip = await ctx.git(ctx.bare, ["rev-parse", `refs/heads/${group.branch}`]), parents = (await ctx.git(ctx.bare, ["rev-list", "--parents", "-n", "1", secondTip])).split(" ");
  const afterAppend = await job(), appended = afterAppend.executions.at(-1), updated = afterAppend.groups.find(g => g.id === group.id);
  check("5b the same branch advanced by exactly one fast-forward commit on the old tip", secondTip !== firstTip && parents.length === 2 && parents[1] === firstTip && updated.artifact.commitOid === secondTip, { firstTip, secondTip });
  check("5c the platform got the verbatim comment: execution id line, commit line and the whole verification text", appended?.state === "done" && ctx.comments.length === commentsBefore + 1 && ctx.comments.at(-1).body.split("\n").includes(`Paraself 执行 ID：${appended.id}`) && ctx.comments.at(-1).body.split("\n").includes(`提交：${secondTip}`) && ctx.comments.at(-1).body.includes(appended.fix.verification), { comments: ctx.comments.length });
  check("5d the appended branch passes the scenario tests plus both hidden tests", await verify("second", group.branch, { "verify-first.test.js": verifyAfterFirst, "verify-second.test.js": verifyAfterAppend }));
  check("5e the execution result is in the conversation as a system message", afterAppend.conversation.messages.some(m => m.role === "system" && m.executionId === appended.id && m.event === "execution_done"));
  // 6. a further plan stays a card
  await c.ask(jobId, messages.more, [{ kind: "group", id: group.id }]);
  const cardOnly = await job();
  check("6 a further plan is only a card: no execution without a click", !!(await lastWorker())?.plan && cardOnly.executions.length === afterAppend.executions.length);
  { const last = await job(), pending = last.conversation.messages.filter(m => m.role === "worker" && m.plan && !last.executions.some(e => e.messageId === m.id)).at(-1); await c.shoot("conversation-final", jobId, (pending ?? last.conversation.messages.at(-1)).seq); }
  await save(join(ctx.root, "conversation-job.json"), await job());
  // 7. Codex native (gpt-6-luna): one read-only discussion on its own evaluated job
  let codex = { skipped: options.fixture ? "fixture mode has no models" : undefined };
  if (!options.fixture && options.codexProfileId) {
    await c.annotate(falseClaim);
    const job2 = await c.submit(options.codexProfileId, "codex"), tipBefore = await ctx.git(ctx.bare, ["rev-parse", `refs/heads/${group.branch}`]), repoBefore = JSON.stringify(await treeSnapshot(ctx.repo));
    const j2 = async () => (await c.state()).jobs.find(j => j.id === job2), annotation2 = (await j2()).annotations[0].id;
    const pulls2 = ctx.pulls.length, comments2 = ctx.comments.length, groups2 = (await j2()).groups.length, asked = await c.ask(job2, messages.explain, [{ kind: "annotation", id: annotation2 }]);
    const done = await j2(), reply = done.conversation.messages.filter(m => m.role === "worker").at(-1);
    codex = { worker: done.worker, backendProfile: options.codexProfileId, actualModel: done.actualModel, initialVerdict: done.verdicts[0]?.verdict, turn: asked.turn?.state, reply: reply?.body.slice(0, 400), tipUnchanged: tipBefore === await ctx.git(ctx.bare, ["rev-parse", `refs/heads/${group.branch}`]), userRepoUnchanged: repoBefore === JSON.stringify(await treeSnapshot(ctx.repo)), noNewPlatformWrites: ctx.pulls.length === pulls2 && ctx.comments.length === comments2, noExecutionsOrGroups: done.executions.length === 0 && done.groups.length === groups2 };
    check("7 Codex native answers one discussion turn read-only (no write, no push, no PR/comment, no execution)", done.worker === "codex" && codex.turn === "answered" && !!reply && codex.tipUnchanged && codex.userRepoUnchanged && codex.noNewPlatformWrites && codex.noExecutionsOrGroups, codex);
    await save(join(ctx.root, "conversation-codex-job.json"), done);
  }
  const after = await treeSnapshot(ctx.repo);
  check("8 the user's source repository is unchanged including .git (HEAD, refs, index, config)", JSON.stringify(ctx.before) === JSON.stringify(after));
  check("9 only the loopback platform and the local SSH stub were used", ctx.requests.every(r => /^\/api\/v3\/repos\/fixture\/lab\//u.test(r.url ?? "")) && (await readFile(ctx.sshLog, "utf8").catch(() => "")).split("\n").filter(Boolean).every(line => /git-(upload|receive)-pack/u.test(line)), { platformRequests: ctx.requests.length });
  return { annotationId, jobId, initialVerdict, codex, finalState: (await job())?.state };
}

// ------------------------------------------------------------------------------------------------- controller: fixture
function scriptedGateway(log) {
  // Only the annotation list the host put in the prompt counts: tool history echoes ids from earlier actions.
  const ids = text => { const match = /\n(\[\{"path".*?\}\])(?:\n|$)/su.exec(text); try { return match ? JSON.parse(match[1]).map(a => a.id) : []; } catch { return []; } };
  const reply = (request, parse, actions) => ({ requestId: request.requestId, attemptId: randomUUID(), profileId: "scripted", backend: "claude-code-cli", model: "scripted-fixture", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, parsedOutput: parse({ actions }) });
  const grouped = "return '¥' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });";
  return {
    listGenerationProfiles: async () => [],
    async generate(request, parse) {
      const prompt = request.userPrompt, history = prompt.split("最近工具历史")[1] ?? "", read = history.includes("totalLines"), edited = history.includes("edited");
      const stage = prompt.includes("逐条读代码") ? "evaluation" : prompt.includes("用户最新消息") ? "discussion" : "fix";
      log.push({ stage, read, edited });
      if (!read) return reply(request, parse, [{ action: "read_file", path: `${stage === "discussion" ? "base/" : ""}src/price.js` }]);
      if (stage === "evaluation") return reply(request, parse, [{ action: "submit_result", result: { verdicts: ids(prompt).slice(0, 1).map(id => ({ id, verdict: "needs_input", reason: "意见没有说明期望的显示格式，需要补充信息。" })), groups: [] } }]);
      if (stage === "discussion") {
        const latest = prompt.split("## 用户最新消息（完整）\n")[1] ?? "", group = /组 \d+「[^」]*」id ([0-9a-f-]{36})/u.exec(prompt)?.[1], annotation = /意见 ([0-9a-f-]{36}) /u.exec(prompt)?.[1];
        let text = "**判断依据**：原意见没有说明期望的显示格式。\n\n- 千分位？\n- 小数位？\n\n```js\nformatPrice(1234567)\n```", plan = null;
        if (latest.includes("补充：")) { text = "明白了。方案如下。"; plan = { targetKind: "new", groupId: null, title: "金额千分位", annotationIds: annotation ? [annotation] : [], requirements: "千分位、两位小数、¥ 在最前", expectedChanges: "src/price.js 用 toLocaleString", reason: "对话补充了期望格式" }; }
        if (latest.includes("在这个组追加") || latest.includes("再加一个")) { text = "可以在同一分支追加提交。"; plan = { targetKind: "existing", groupId: group, title: null, annotationIds: annotation ? [annotation] : [], requirements: latest.includes("再加一个") ? "导出 formatPriceTotal" : "导出 formatPriceList，返回字符串数组", expectedChanges: "src/price.js 追加处理", reason: "用户在对话中追加要求" }; }
        return reply(request, parse, [{ action: "submit_result", result: { reply: text, plan } }]);
      }
      const append = prompt.includes("追加修改");
      if (!edited) return reply(request, parse, [{ action: "edit_file", path: "src/price.js", oldText: append ? "export function formatPrice(cents) {" : "return '¥' + (cents / 100).toFixed(2);", newText: append ? "export function formatPriceList(list) {\n  return list.map(formatPrice);\n}\nexport function formatPrice(cents) {" : grouped }]);
      return reply(request, parse, [{ action: "submit_result", result: { outcomes: ids(prompt).map(id => ({ id, outcome: "fixed", summary: "已修复" })), commitTitle: append ? "导出 formatPriceList" : "金额千分位", verification: "未运行命令测试（脚本化夹具）。" } }]);
    },
  };
}
async function fixtureController(ctx) {
  const server = await createServer({ root: repositoryRoot, cacheDir: join(ctx.root, "vite-cache"), configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true }, resolve: { alias: Object.fromEntries(["protocol", "core", "storage", "integrations"].map(name => [`@cognelis/decision-${name}`, join(repositoryRoot, `packages/${name}/src/index.ts`)])) } });
  const load = file => server.ssrLoadModule(join(repositoryRoot, `apps/desktop/src/main/${file}.ts`));
  const { LocalReviewGit } = await load("local-review-git"), { LocalReviewService } = await load("local-review-service"), { PrConnections } = await load("pr-connections");
  const credentials = new Map(), connections = new PrConnections(join(ctx.userData, "pr-connections.json"), { get: async key => credentials.get(key) ?? null, set: async (key, value) => { credentials.set(key, value); }, delete: async key => credentials.delete(key) });
  await connections.save({ label: "Local synthetic GitHub", platform: "github", baseUrl: ctx.baseUrl, token: "synthetic-local-platform-token" });
  const profile = { version: 1, profileId: "scripted", kind: "claude-code-cli", label: "scripted fixture", enabled: true, priority: 0, timeoutMs: 60000, executablePath: "/usr/bin/true", model: "scripted" };
  const scriptLog = [], gateway = scriptedGateway(scriptLog);
  const service = new LocalReviewService(join(ctx.userData, "local-review"), new LocalReviewGit("/usr/bin/git", ctx.gitEnv), connections, async () => [profile], isolationEnvironment(ctx.root, systemEnvironment()), undefined, gateway);
  await service.start(); const sessionId = await service.register(ctx.repo), repositoryId = service.state().repositories[0].id;
  return {
    ctx, state: async () => service.state(),
    annotate: async o => { const line = sourceFiles[o.path].split("\n").findIndex(text => text.includes(o.anchor)) + 1; return service.annotate({ repositoryId, sessionId, path: o.path, side: "new", startLine: line, endLine: line, body: o.body }); },
    submit: async (profileId, worker) => { const id = await service.submit(repositoryId, sessionId, profileId, worker); await service.idle(); return id; },
    ask: async (jobId, body, references) => { const turnId = await service.sendMessage({ repositoryId, jobId, body, references }); await service.idle(); const job = service.state().jobs.find(j => j.id === jobId), turn = job.turns.find(t => t.id === turnId); return { turn, userMessage: job.conversation.messages.find(m => m.id === turn.userMessageId) }; },
    execute: async (jobId, messageId) => { await service.execute({ repositoryId, jobId, messageId }); await service.idle(); },
    shoot: async () => undefined, close: async () => { await service.close(); await server.close(); }, extra: () => ({ scriptedModelCalls: scriptLog.length }),
  };
}

// ------------------------------------------------------------------------------------------------------- controller: App
async function appController(ctx, options) {
  const { executable, outDir, dry, cleanups, ledger } = options, bundle = resolve(executable, "../../.."), stop = join(ctx.root, "STOP");
  const claude = await find("claude"), codex = await find("codex");
  if (!claude || !codex) throw new Error("claude and codex executables are required");
  const repositoryId = randomUUID(), sessionId = randomUUID(), snapshot = { path: ctx.repo, headSha: ctx.head, baseSha: ctx.head, branch: "main", dirty: false, author: { name: "Synthetic Review", email: "review@example.invalid" } };
  const settings = { worker: "pi", pushRemote: "origin", baseBranch: "main", reviewers: [], dependencies: { mode: "off", argv: [], files: [], allowScripts: false } };
  if (ledger) await writeFile(join(ctx.userData, "local-review/ledger.json"), await readFile(ledger));
  else await save(join(ctx.userData, "local-review/ledger.json"), { version: 2, repositories: [{ id: repositoryId, name: "synthetic-price", snapshot, settings }], sessions: [{ id: sessionId, repositoryId, snapshot, annotations: [] }], jobs: [], owners: [] });
  const profiles = [
    { version: 1, profileId: "live-claude", kind: "claude-code-cli", label: "Claude Code sonnet", enabled: true, priority: 0, timeoutMs: 120000, model: "sonnet", executablePath: await realpath(claude) },
    { version: 1, profileId: "live-codex", kind: "codex-cli", label: "Codex gpt-6-luna", enabled: true, priority: 1, timeoutMs: 120000, model: "gpt-6-luna", executablePath: await realpath(codex) }];
  await save(join(ctx.userData, "model-provider-profiles.json"), { version: 1, profiles });
  const reserve = httpServer(); await new Promise(r => reserve.listen(0, "127.0.0.1", r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const wrapper = join(ctx.root, "start-app"); await writeFile(wrapper, `#!/bin/sh\nexec ${quote(executable)} --remote-debugging-address=127.0.0.1 --remote-debugging-port=${port} "$@"\n`, { mode: 0o700 });
  const frontSamples = [], front = async () => { try { const value = (await exec("/usr/bin/lsappinfo", ["front"], { encoding: "utf8" })).stdout.trim(); frontSamples.push({ at: new Date().toISOString(), info: (await exec("/usr/bin/lsappinfo", ["info", "-only", "pid,name", value], { encoding: "utf8" })).stdout }); } catch {} };
  await front(); const monitor = setInterval(() => { void front(); }, 500);
  cleanups.push(async () => { clearInterval(monitor); }); // survives a failed start; the full close is registered once the App is up
  // The App's own environment: the lab allowlist only. CLI logins come from the real HOME (default auth locations); the lab allowlist drops any other variable, so no CODEX_HOME/CLAUDE_CONFIG_DIR, no proxy variable, no API key.
  let socket, closed = false; const app = await startIsolatedApp({ root: ctx.root, executable: wrapper, useLocalModels: false, showWindow: false, base: { ...systemEnvironment(homedir()), PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${dirname(claude)}:${dirname(codex)}` } });
  // Registered immediately: if CDP or configuration fails below, the caller still stops this App by its recorded PID.
  const pid = app.child.pid, close = async () => { if (closed) return; closed = true; await front(); try { socket?.close(); } catch {} clearInterval(monitor); await app.stop().catch(() => undefined); await writeFile(join(ctx.root, "app.stderr"), app.stderr()).catch(() => undefined); };
  cleanups.push(close);
  let target; for (let i = 0; i < 200 && !target; i++) { const values = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []); target = values.find(v => { try { return v.type === "page" && v.webSocketDebuggerUrl && v.url.startsWith("file:") && fileURLToPath(v.url).startsWith(join(bundle, "Contents/Resources") + "/"); } catch { return false; } }); if (!target) await sleep(100); }
  if (!target) throw new Error("App CDP page unavailable");
  socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((res, rej) => { socket.addEventListener("open", res, { once: true }); socket.addEventListener("error", rej, { once: true }); });
  let next = 0; const pending = new Map(); socket.addEventListener("message", event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
  socket.addEventListener("close", () => { for (const p of pending.values()) p.reject(new Error("CDP socket closed")); pending.clear(); });
  const command = (method, params, timeout = 120_000) => new Promise((res, rej) => { const id = ++next, timer = setTimeout(() => { pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, timeout); pending.set(id, { resolve: value => { clearTimeout(timer); res(value); }, reject: error => { clearTimeout(timer); rej(error); } }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; };
  const stopped = () => access(stop).then(() => true, () => false);
  const waitFor = async (expression, label, timeout = 60_000) => { for (const deadline = Date.now() + timeout; Date.now() < deadline;) { if (await stopped()) throw new Error("STOP file present: aborting"); const value = await evaluate(expression); if (value) return value; await sleep(150); } throw new Error(`Timed out waiting for ${label}`); };
  await waitFor("typeof window.decision?.getLocalReviewState === 'function'", "preload API");
  // Configure only this synthetic App through its normal API: proxy, local credential file (not the keychain), the loopback platform.
  await evaluate(`window.decision.setModelProxyUrl(${JSON.stringify(process.env.MODEL_PROXY_URL ?? "http://127.0.0.1:9")})`);
  await evaluate("window.decision.setLocalCredentialsEnabled(true)");
  await evaluate(`window.decision.savePrConnection(${JSON.stringify({ label: "Local synthetic GitHub", platform: "github", baseUrl: ctx.baseUrl, token: "synthetic-local-platform-token" })})`);
  await evaluate("window.decision.openSurface('local-review')");
  await waitFor("document.querySelector('.local-review-panel:not([hidden]) h1')?.textContent === '本地审阅'", "local review page");
  const state = () => evaluate("window.decision.getLocalReviewState()");
  const setVisibleValue = async (selector, value) => { if (!await setValue(selector, value)) throw new Error(`Visible control not found: ${selector}`); };
  const setValue = (selector, value) => evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.getClientRects().length===0)return false;const area=el instanceof HTMLTextAreaElement;Object.getOwnPropertyDescriptor(area?HTMLTextAreaElement.prototype:HTMLSelectElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(area?'input':'change',{bubbles:true}));return true;})()`);
  const clickText = (text, { last = false, exact = false, within = "body" } = {}) => evaluate(`(()=>{const scope=document.querySelector(${JSON.stringify(within)});if(!scope)return false;const list=[...scope.querySelectorAll('button')].filter(b=>!b.disabled&&b.getClientRects().length>0&&(${exact}?b.textContent.trim()===${JSON.stringify(text)}:b.textContent.includes(${JSON.stringify(text)})));const b=${last}?list.at(-1):list[0];b?.click();return !!b;})()`);
  const shoot = async name => { await sleep(400); const { data } = await command("Page.captureScreenshot", { format: "png" }); await mkdir(outDir, { recursive: true }); await writeFile(join(outDir, `${name}.png`), Buffer.from(data, "base64")); emit({ event: "screenshot", name }); };
  const busy = job => job.turns.some(t => ["queued", "running"].includes(t.state)) || job.executions.some(e => ["pending", "fixing", "committed", "pushing", "commenting"].includes(e.state)) || !["finished", "failed", "cancelled", "no_changes", "interrupted"].includes(job.state);
  const waitIdle = async (jobId, timeout = 25 * 60_000) => { for (const deadline = Date.now() + timeout; Date.now() < deadline;) { if (await stopped()) throw new Error("STOP file present: aborting"); const job = (await state()).jobs.find(j => j.id === jobId); if (job && !busy(job)) return job; await sleep(500); } throw new Error("Timed out waiting for the task to settle"); };
  const openTask = async jobId => {
    await evaluate("window.decision.openSurface('local-review')");
    // The task list lives on the "后台任务" tab, which a user opens with the tab button; programmatic clicks on its hidden DOM are not the user path.
    await waitFor("!!document.querySelector('#local-review-tasks-tab')", "tasks tab button");
    await evaluate("(()=>{const tab=document.querySelector('#local-review-tasks-tab');if(tab.getAttribute('aria-selected')!=='true')tab.click();return true;})()");
    await waitFor("(()=>{const section=document.querySelector('.local-review-task-tab');return !!section&&!section.hidden&&section.getClientRects().length>0&&!!document.querySelector('.local-review-task-list button')&&document.querySelector('.local-review-task-list button').getClientRects().length>0;})()", "the visible task list");
    // The visible title is localized; the stable DOM id also works regardless of list order and time-zone changes.
    const listButton = `[...document.querySelectorAll('.local-review-task-list button')].find(b=>b.dataset.jobId===${JSON.stringify(jobId)}&&b.getClientRects().length>0)`;
    await waitFor(`!!(${listButton})`, "the requested task's visible list button", 30_000);
    await evaluate(`(${listButton}).click()`);
    await waitFor(`document.querySelector('.local-review-task-title code')?.textContent === ${JSON.stringify(jobId)} && !!document.querySelector('.local-review-chat textarea')`, "the requested task's detail");
  };
  const openReviewForm = async () => {
    await evaluate("window.decision.openSurface('local-review')");
    // The form lives on the "审阅" tab; after a conversation the panel is still on "后台任务".
    await waitFor("!!document.querySelector('#local-review-review-tab')", "review tab button");
    await evaluate("(()=>{const tab=document.querySelector('#local-review-review-tab');if(tab.getAttribute('aria-selected')!=='true')tab.click();return true;})()");
    // At narrow windows (<=1350) the opinions column, which holds the submit form, starts collapsed: expand it with its own button.
    await evaluate(`(()=>{const b=document.querySelector('button[aria-label="展开意见栏"]');if(b&&b.getClientRects().length>0)b.click();return !!b;})()`);
    await sleep(300);
    try {
    await waitFor(`(()=>{const form=document.querySelector('.local-review-submit');const select=document.querySelector('select[aria-label="执行方式"]');return !!form&&form.getClientRects().length>0&&!!select&&select.getClientRects().length>0;})()`, "the visible submit form");
    } catch (error) {
      const why = await evaluate(`(()=>{const e0=document.querySelector('select[aria-label="执行方式"]');if(!e0)return 'no select';const chain=[];for(let e=e0;e&&chain.length<12;e=e.parentElement){const c=getComputedStyle(e);chain.push([e.tagName.toLowerCase(),String(e.className).slice(0,36),c.display,e.hidden?'hidden-attr':'',e.getClientRects().length].join(' '));}return chain;})()`);
      throw new Error(`${error.message}: ${JSON.stringify(why)}`);
    }
  };
  const quoteLatencies = [];
  const quoteAll = async (jobId, references) => {
    for (const ref of references) {
        // Strict: the quote button must exist in the reachable (expanded) summary, be clicked, and put its block into the composer.
        const before = await evaluate("document.querySelector('.local-review-chat textarea').value");
        if (ref.kind === "group") {
          // The panel refreshes on its own poll: quote a group only once its card shows the PR link, so the block carries the real state.
          const group = (await state()).jobs.find(j => j.id === jobId)?.groups.find(g => g.id === ref.id);
          if (group?.pr) await waitFor(`document.body.textContent.includes(${JSON.stringify(group.pr.url)})`, "the group's PR link in the panel", 30_000);
        }
        // The exact button for this very annotation/group, found from the ledger's metadata (never "the first/last quote button").
        const current = (await state()).jobs.find(j => j.id === jobId), target = ref.kind === "annotation" ? current?.annotations.find(x => x.id === ref.id) : current?.groups.find(x => x.id === ref.id);
        if (!target) throw new Error(`${ref.kind} ${ref.id} is not part of task ${jobId}`);
        const label = ref.kind === "annotation" ? `在对话中引用意见 ${target.path}:${target.startLine}` : `在对话中引用组 ${target.ordinal}`;
        const pick = `[...document.querySelectorAll('button[aria-label]')].filter(x=>x.getAttribute('aria-label')===${JSON.stringify(label)}&&!x.disabled)[0]`;
        // A user can only click what is visible: expand the collapsed summary through its own <summary> first, then require real layout boxes.
        // The panel refreshes from the ledger on its own poll, so a just-finished task can show up in the UI a moment after the
        // IPC state says so: wait (as a user would) for the button to be there, expand its summary, then click only a visible one.
        let clicked = false;
        for (const deadline = Date.now() + 20_000; !clicked && Date.now() < deadline;) {
          await evaluate(`(()=>{const b=${pick};const d=b?.closest('details');if(d&&!d.open)d.querySelector('summary')?.click();return !!b;})()`);
          await sleep(200);
          clicked = await evaluate(`(()=>{const b=${pick};if(!b||b.getClientRects().length===0||getComputedStyle(b).visibility==='hidden')return false;b.click();return true;})()`);
          if (!clicked) await sleep(300);
        }
        if (!clicked) {
          const why = await evaluate(`(()=>{const b=${pick};if(!b)return 'no such button';const chain=[];for(let e=b;e&&chain.length<14;e=e.parentElement){const c=getComputedStyle(e);chain.push([e.tagName.toLowerCase(),e.className&&String(e.className).slice(0,40),c.display,c.visibility,e.hidden?'hidden-attr':'',e.tagName==='DETAILS'?(e.open?'open':'closed'):'',e.getClientRects().length].join(' '));}return chain;})()`);
          throw new Error(`The quote button for ${ref.kind} ${ref.id} is not visible and clickable in the UI: ${JSON.stringify(why)}`);
        }
        const started = Date.now();
        await waitFor(`document.querySelector('.local-review-chat textarea').value !== ${JSON.stringify(before)} && document.querySelector('.local-review-chat textarea').value.includes('> ')`, "the quote block in the composer", 10_000);
        quoteLatencies.push(Date.now() - started);
      }
  };
  // Persisted-ledger and live screenshots: wait for the very message (by seq) to be rendered, scroll the conversation log to it, shoot light and dark.
  const capture = async (jobId, name, seq, { quoteRef } = {}) => {
      await openTask(jobId);
      const article = `.local-review-chat article[data-seq="${seq}"]`;
      await waitFor(`(()=>{const a=document.querySelector(${JSON.stringify(article)});return !!a&&a.getClientRects().length>0;})()`, `message seq ${seq} rendered`, 30_000);
      if (quoteRef) await quoteAll(jobId, [quoteRef]);
      for (const scheme of ["light", "dark"]) {
        await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
        await evaluate(`(()=>{const a=document.querySelector(${JSON.stringify(article)});a.scrollIntoView({block:${quoteRef ? "'end'" : "'center'"}});const log=document.querySelector('.local-review-chat-log');if(log&&${!quoteRef})log.scrollTop=Math.max(0,a.offsetTop-40);return true;})()`);
        await shoot(`${name}-${scheme}`);
      }
      await command("Emulation.setEmulatedMedia", { features: [] });

  };
  // The execute button of a plan card, scrolled into the visible part of the conversation (normal scrolling only), light and dark.
  const captureActions = async (jobId, name, seq) => {
    await openTask(jobId);
    const actions = `.local-review-chat article[data-seq="${seq}"] .local-review-plan-actions`;
    await waitFor(`(()=>{const a=document.querySelector(${JSON.stringify(actions)});return !!a&&a.getClientRects().length>0;})()`, `plan actions of message seq ${seq}`, 30_000);
    const visible = [];
    for (const scheme of ["light", "dark"]) {
      await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await evaluate(`document.querySelector(${JSON.stringify(actions)}).scrollIntoView({block:'center'})`); await sleep(300);
      visible.push(await evaluate(`(()=>{const b=[...document.querySelector(${JSON.stringify(actions)}).querySelectorAll('button')].find(x=>x.textContent.trim()==='执行');if(!b)return false;const r=b.getBoundingClientRect(),log=document.querySelector('.local-review-chat-log')?.getBoundingClientRect();return r.width>0&&r.top>=0&&r.bottom<=innerHeight&&(!log||(r.top>=log.top-1&&r.bottom<=log.bottom+1))&&!b.disabled;})()`));
      await shoot(`${name}-${scheme}`);
    }
    await command("Emulation.setEmulatedMedia", { features: [] });
    return visible;
  };
  const baseProbe = async () => ({ heading: await evaluate("document.querySelector('.local-review-panel:not([hidden]) h1')?.textContent"), models: await evaluate("window.decision.listModelProviderProfiles().then(p=>p.map(x=>({id:x.profileId,kind:x.kind,model:x.model})))"), workers: await evaluate(`[...(document.querySelector('select[aria-label="执行方式"]')?.options??[])].map(o=>o.value)`), repositories: (await state()).repositories.length, dry });
  return {
    ctx, state,
    annotate: async o => { const line = sourceFiles[o.path].split("\n").findIndex(text => text.includes(o.anchor)) + 1; const session = (await state()).sessions.at(-1); return evaluate(`window.decision.saveLocalReviewAnnotation(${JSON.stringify({ repositoryId, sessionId: session.id, path: o.path, side: "new", startLine: line, endLine: line, body: o.body })})`); },
    // The real submit button: choose the execution mode and the model profile in the form, then click "提交 N 条意见".
    submit: async (profileId, workerName) => {
      await openReviewForm();
      await setVisibleValue('select[aria-label="执行方式"]', workerName); await sleep(300);
      await evaluate(`(()=>{const select=[...document.querySelectorAll('.local-review-submit select')].find(s=>!s.getAttribute('aria-label'));if(!select)return false;Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(profileId)});select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
      const known = new Set((await state()).jobs.map(j => j.id));
      await waitFor("[...document.querySelectorAll('.local-review-submit button')].some(b=>/^提交 \\d+ 条意见$/.test(b.textContent)&&!b.disabled)", "enabled submit button");
      await clickText("提交 ", { within: ".local-review-submit" });
      const created = await (async () => { for (const deadline = Date.now() + 60_000; Date.now() < deadline;) { const found = (await state()).jobs.find(j => !known.has(j.id)); if (found) return found; await sleep(300); } throw new Error("Submit created no task"); })();
      await waitIdle(created.id); return created.id;
    },
    // Quote through the real buttons, type in the real composer, send with the real button.
    ask: async (jobId, body, references) => {
      await openTask(jobId);
      const before = (await state()).jobs.find(j => j.id === jobId).conversation.messages.length;
      await quoteAll(jobId, references);
      const prefix = await evaluate("document.querySelector('.local-review-chat textarea').value");
      await setVisibleValue(".local-review-chat textarea", `${prefix}${prefix && !prefix.endsWith("\n") ? "\n" : ""}${body}`); await sleep(200);
      await waitFor("[...document.querySelectorAll('.local-review-composer button')].some(b=>b.textContent.trim()==='发送'&&!b.disabled)", "enabled send button");
      await clickText("发送", { exact: true, within: ".local-review-composer" });
      let userMessage;
      for (const deadline = Date.now() + 60_000; !userMessage && Date.now() < deadline;) { userMessage = (await state()).jobs.find(j => j.id === jobId).conversation.messages.slice(before).find(m => m.role === "user" && m.turnId); if (!userMessage) await sleep(250); }
      if (!userMessage) throw new Error("The sent message never reached the ledger");
      for (const deadline = Date.now() + 25 * 60_000; Date.now() < deadline;) { const job = (await state()).jobs.find(j => j.id === jobId), turn = job.turns.find(t => t.id === userMessage.turnId); if (turn && !["queued", "running"].includes(turn.state) && !busy(job)) return { turn, userMessage }; if (await stopped()) throw new Error("STOP file present: aborting"); await sleep(500); }
      throw new Error("Timed out waiting for the turn");
    },
    execute: async (jobId, messageId) => {
      await openTask(jobId);
      const seq = (await state()).jobs.find(j => j.id === jobId).conversation.messages.find(m => m.id === messageId)?.seq;
      if (!seq) throw new Error("The plan message is not in the ledger");
      const card = `.local-review-chat article[data-seq="${seq}"] .local-review-plan`;
      await waitFor(`[...document.querySelectorAll(${JSON.stringify(card + " button")})].some(b=>b.textContent.trim()==="执行"&&!b.disabled)`, "the enabled execute button of this very plan card");
      if (!await clickText("执行", { exact: true, within: card })) throw new Error("No enabled 执行 button on the plan card");
      let claimed = false;
      for (const deadline = Date.now() + 60_000; !claimed && Date.now() < deadline;) { claimed = (await state()).jobs.find(j => j.id === jobId).executions.some(e => e.messageId === messageId); if (!claimed) await sleep(250); }
      if (!claimed) throw new Error("The click never produced an execution record; not waiting on a stale idle state");
      await waitIdle(jobId);
    },
    shoot: async (name, jobId, seq) => capture(jobId, name, seq),
    close,
    // Persisted-ledger reopen screenshots: wait for the very message (by seq) to be rendered, scroll the conversation log to it, shoot light and dark.
    capture, captureActions, openTask,
    formProbe: async () => { await openReviewForm(); return evaluate(`({ worker: document.querySelector('select[aria-label="执行方式"]').value, profiles: [...document.querySelectorAll('.local-review-submit select')].find(x=>!x.getAttribute('aria-label'))?.options.length ?? 0 })`); },
    quoteProbe: async (jobId, references) => {
      await openTask(jobId); await quoteAll(jobId, references); await sleep(600);
      // The composer text and the draft the panel keeps (localStorage, per task): the stored references must match the quoted blocks.
      return evaluate(`(()=>{const text=document.querySelector('.local-review-chat textarea').value;const drafts=Object.keys(localStorage).filter(k=>k.includes(${JSON.stringify(jobId)})).map(k=>({key:k,value:JSON.parse(localStorage.getItem(k)||'null')}));return {text,drafts};})()`).then(r => ({ ...r, latenciesMs: quoteLatencies }));
    },
    extra: () => ({ pid: app.child.pid, frontSamples: frontSamples.length, focusStolen: frontSamples.some(s => new RegExp(`pid[^0-9]+${app.child.pid}(?:[^0-9]|$)`).test(s.info)) }),
    dryProbe: async () => {
      const colors = {};
      for (const scheme of ["light", "dark"]) { await command("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] }); await sleep(300); colors[scheme] = await evaluate(`({ media: matchMedia('(prefers-color-scheme: dark)').matches, background: getComputedStyle(document.body).backgroundColor, panel: getComputedStyle(document.querySelector('.local-review-panel:not([hidden])')).backgroundColor, text: getComputedStyle(document.body).color })`); }
      await command("Emulation.setEmulatedMedia", { features: [] });
      return { colors, themeApplies: colors.light.media === false && colors.dark.media === true && (colors.light.background !== colors.dark.background || colors.light.text !== colors.dark.text), ...(await baseProbe()) };
    },
    orphanFree: async () => { await close(); try { process.kill(pid, 0); return false; } catch { return true; } },
    pid,
  };
}

// ------------------------------------------------------------------------------------------------------------- main
const args = parseArgs({ options: { root: { type: "string" }, fixture: { type: "boolean" }, app: { type: "string" }, dry: { type: "boolean" }, out: { type: "string" }, "ui-check": { type: "boolean" }, ledger: { type: "string" }, shots: { type: "boolean" } } }).values;
const root = resolve(args.root ?? await mkdtemp(join(process.env.PARASELF_LAB_ROOT ?? tmpdir(), "paraself-lr-i10-")));
let ctx, controller; const checks = [], cleanups = [];
try {
  if (!args.fixture && !args.app) throw new Error("Choose --fixture or --app <Paraself executable>");
  await mkdir(root, { recursive: true });
  if (await access(join(root, "result.json")).then(() => true, () => false)) throw new Error("Root already holds a result; choose a new root");
  if (!args.fixture && !args.dry && !args["ui-check"] && !args.shots) {
    if (process.env.LR_I10_REAL_RUN_APPROVED !== "1") throw new Error("Real-model run is not approved (LR_I10_REAL_RUN_APPROVED=1 is set only after the parent's review)");
    if (!process.env.MODEL_PROXY_URL) throw new Error("MODEL_PROXY_URL is required; no direct fallback");
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) throw new Error("API keys must not be present: subscription logins only");
  process.env.TMPDIR = join(root, "driver-tmp"); await mkdir(process.env.TMPDIR, { recursive: true });
  ctx = await prepare(root);
  let outcome;
  if (args.fixture) {
    controller = await fixtureController(ctx);
    outcome = await scenario(controller, checks, { fixture: true, profileId: "scripted", verifier: null });
  } else {
    controller = await appController(ctx, { executable: resolve(args.app), outDir: resolve(args.out ?? join(root, "screenshots")), dry: !!args.dry, cleanups, ledger: args["ui-check"] || args.shots ? resolve(args.ledger ?? "") : undefined });
    if (args.shots) {
      // No model, nothing written: the finished real ledger is reopened in a fresh isolated App and the persisted conversation is photographed.
      const job = (await controller.state()).jobs.find(j => j.worker === "pi" && j.conversation.messages.some(m => m.plan));
      if (!job) throw new Error("No Pi task with plan messages in the ledger");
      const workers = job.conversation.messages.filter(m => m.role === "worker"), planned = workers.filter(m => m.plan), unexecuted = planned.filter(m => !job.executions.some(e => e.messageId === m.id)).at(-1), executed = planned.find(m => job.executions.some(e => e.messageId === m.id));
      const markdown = workers.find(m => /\*\*|```|^- /mu.test(m.body)), shots = [];
      if (markdown) { await controller.capture(job.id, "reopen-markdown-reply", markdown.seq); shots.push("reopen-markdown-reply"); }
      if (executed) { await controller.capture(job.id, "reopen-executed-plan-card", executed.seq); shots.push("reopen-executed-plan-card"); }
      if (unexecuted) { await controller.capture(job.id, "reopen-unexecuted-plan-card", unexecuted.seq); shots.push("reopen-unexecuted-plan-card"); }
      let executeVisible = null;
      if (unexecuted) { executeVisible = await controller.captureActions(job.id, "reopen-unexecuted-execute-button", unexecuted.seq); shots.push("reopen-unexecuted-execute-button"); }
      await controller.capture(job.id, "reopen-quote-in-composer", workers.at(-1).seq, { quoteRef: { kind: "annotation", id: job.annotations[0].id } }); shots.push("reopen-quote-in-composer");
      checks.push({ name: "shots: persisted conversation reopened without a model; markdown reply, executed and unexecuted plan cards and the quote were each rendered (by seq) and photographed in light and dark", passed: !!unexecuted && shots.length >= 3 && Array.isArray(executeVisible) && executeVisible.every(Boolean), detail: { executeVisible, shots, markdownSeq: markdown?.seq, executedSeq: executed?.seq, unexecutedSeq: unexecuted?.seq, jobId: job.id } });
      outcome = { shots };
    } else if (args["ui-check"]) {
      // No model: a finished ledger (from a fixture run) in the candidate App; the quote path is exercised with the real buttons and nothing is sent.
      const job = (await controller.state()).jobs[0], refs = [{ kind: "annotation", id: job.annotations[0].id }, ...(job.groups[0] ? [{ kind: "group", id: job.groups[0].id }] : [])];
      const probe = await controller.quoteProbe(job.id, refs), text = probe.text, stored = probe.drafts.map(d => d.value).find(v => v && Array.isArray(v.references));
      const storedOk = !!stored && refs.every(r => stored.references.some(x => x.kind === r.kind && x.id === r.id && typeof x.token === "string" && x.token.length > 0 && stored.body.includes(x.token))) && stored.body === text;
      checks.push({ name: "ui-check: annotation and group quote buttons are reachable, their blocks land in the composer, and the stored draft carries matching kind/id references whose tokens are in the text (nothing sent)", passed: text.includes(`> ${job.annotations[0].path}:`) && (!job.groups[0] || text.includes(`> 组 ${job.groups[0].ordinal}`)) && storedOk, detail: { text: text.slice(0, 500), stored, latenciesMs: probe.latenciesMs } });
      // Several tasks: every one must be reachable through its own unique title, in both orders (the panel lists newest first).
      const all = (await controller.state()).jobs, order = [...all, ...all.slice().reverse()], opened = [];
      for (const j of order) { await controller.openTask(j.id); opened.push(j.id); }
      checks.push({ name: `ui-check: ${all.length} task(s) each open through their own unique-title button, in both orders`, passed: opened.length === order.length, detail: { tasks: all.length } });
      const form = await controller.formProbe();
      checks.push({ name: "ui-check: after the conversation the 审阅 tab can be reopened and the visible submit form offers the execution modes and model profiles (nothing submitted)", passed: form.profiles >= 2, detail: form });
      outcome = { composer: text, stored, form };
    } else if (args.dry) {
      const probe = await controller.dryProbe();
      checks.push({ name: "dry: light and dark themes really change computed colors in the candidate App", passed: probe.themeApplies, detail: probe.colors });
      checks.push({ name: "dry: App launched, local-review page open, worker choices and both live profiles present, repository seeded, no model called", passed: probe.heading === "本地审阅" && probe.models.some(m => m.id === "live-claude") && probe.models.some(m => m.id === "live-codex") && ["codex", "claude-code", "pi"].every(w => probe.workers.includes(w)) && probe.repositories === 1 });
      outcome = { probe };
    } else outcome = await scenario(controller, checks, { fixture: false, profileId: "live-claude", codexProfileId: "live-codex", verifier: await find("codex") });
  }
  const extra = controller.extra?.() ?? {};
  if (controller.orphanFree) extra.orphanFree = await controller.orphanFree();
  const result = { passed: checks.every(c => c.passed) && extra.orphanFree !== false && extra.focusStolen !== true, mode: args.fixture ? "fixture" : args.shots ? "shots" : args["ui-check"] ? "ui-check" : args.dry ? "app-dry" : "app-real", root, checks, outcome, ...extra };
  await save(join(root, "result.json"), result); emit({ event: "complete", passed: result.passed }); if (!result.passed) process.exitCode = 1;
} catch (error) {
  emit({ event: "failed", error: error.message, root }); await save(join(root, "failure.json"), { message: error.message, checks }).catch(() => undefined); process.exitCode = 2;
} finally {
  await controller?.close?.().catch(() => undefined); for (const fn of cleanups) await fn().catch(() => undefined); await ctx?.close?.().catch(() => undefined);
}
