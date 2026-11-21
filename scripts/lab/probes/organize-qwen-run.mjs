// OM1（IMP-191）整理与记忆：本机 Qwen 真实生成的小样本观测。打包的 App（隔离目录，只读链接本机模型权重），合成数据，
// 无任何凭据；走页面的真实 IPC（CDP 调 window.decision）与 bridge MCP。只记录模型实际产出，不套用桩的确定性断言，
// 报告与桩闭环分开写。
// usage: node scripts/lab/probes/organize-qwen-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label om1-qwen --out DIR
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { resolveUserData } from '../../../config/user-data-directory.mjs';
import { DATA_DIR, connectMcp, executableOf, isolationEnvironment, parseCommon, sleep } from './lib.mjs';
import { ISOLATION_KEYS, labProcessEnvironment } from '../isolated-app.mjs';

const { app, bridge, label, out, automatic = false } = parseCommon({ automatic: { type: 'boolean' } });
const root = await realpath(await mkdtemp(join(DATA_DIR, 'organize-qwen-')));
const appPath = await realpath(app);
const fatal = (message) => { console.error(`FATAL ${message}`); process.exit(2); };

// 环境：同 organize-run.mjs —— 凭据样的变量一律去掉，只传隔离路径与两个开关，每个隔离路径都在本轮 root 下。
const env = labProcessEnvironment({ ...isolationEnvironment(root), PARASELF_SMOKE: '1' });
delete env.PARASELF_PROVIDER_CHILD; delete env.DECISION_PROVIDER_CHILD;
const CREDENTIAL = /key|secret|token|password|credential/iu;
for (const name of Object.keys(env)) if (CREDENTIAL.test(name)) delete env[name];
for (const name of Object.keys(env)) if (/^(PARASELF|DECISION)_/u.test(name) && !ISOLATION_KEYS.includes(name) && name !== 'PARASELF_SMOKE') delete env[name];
for (const name of ISOLATION_KEYS) {
  if (env[name] === undefined) fatal(`${name} is not set`);
  const absolute = resolve(env[name]);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) fatal(`${name} points outside the lab root`);
}
// 只链接模型目录（权重，只读使用）；用户数据目录里别的东西一概不碰。
await mkdir(env.PARASELF_USER_DATA, { recursive: true });
await symlink(join(resolveUserData(process.env, { migrate: false }).path, 'models'), join(env.PARASELF_USER_DATA, 'models'));

const freePort = () => new Promise((ready, fail) => {
  const probe = createNetServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => ready(port)); });
});
let child; let socket; let mcp; let stderr = ''; let driverError = null;
const childPids = [];
const until = async (what, probe, ms = 180_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}\n${stderr}`);
    await sleep(500);
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let nextId = 0; const pending = new Map();
const send = (method, params = {}) => { const id = ++nextId; const answer = new Promise((done) => pending.set(id, done)); socket.send(JSON.stringify({ id, method, params })); return answer; };
const start = async () => {
  const port = await freePort();
  child = spawn(executableOf(appPath), [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  childPids.push(child.pid);
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
  await until('health of this child', async () => {
    const runtime = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
    return runtime.pid === child.pid && (await fetch(`http://127.0.0.1:${runtime.port}/health`)).ok;
  });
  const target = await until('renderer page of this app', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
    .find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && decodeURIComponent(entry.url).startsWith(`file://${appPath}/`)));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open, fail) => { socket.onopen = open; socket.onerror = fail; });
  socket.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id !== undefined) { pending.get(data.id)?.(data); pending.delete(data.id); } };
};
const stop = async () => {
  socket?.close();
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(120_000)]);
  if (alive(pid)) { child.kill('SIGKILL'); await Promise.race([exited, sleep(15_000)]); }
  if (alive(pid)) throw new Error(`app ${pid} did not exit`);
};
const api = async (method, input) => {
  const { result, error } = await send('Runtime.evaluate', { expression: `window.decision.${method}(${input === undefined ? '' : JSON.stringify(input)})`, awaitPromise: true, returnByValue: true });
  if (error || result.exceptionDetails) throw new Error(`${method}: ${JSON.stringify(error ?? result.exceptionDetails.exception?.description)}`);
  return result.result.value;
};

const PROJECT = '消息服务（实验）';
const PROFILE = 'builtin-qwen';
const snapshot = () => api('getOrganization', { project: PROJECT, scope: 'project' });
const settle = () => until('organization run to end', async () => { const view = await snapshot(); return view.activeRun === null ? view : null; }, 600_000);
const brief = (view) => view.suggestions.map((item) => ({
  id: item.id, type: item.type, state: item.state, title: item.title, reopenReason: item.reopenReason, verification: item.attribution.verification, reporter: item.attribution.reporter,
  sources: item.sources.map((source) => source.key), content: item.content, canAdopt: item.canAdopt, blockedReason: item.blockedReason,
}));
const observations = [];
const organize = async (name) => {
  const started = performance.now();
  const result = await api('runOrganization', { scope: 'project', project: PROJECT, profileId: PROFILE });
  const view = result.status === 'started' ? await settle() : await snapshot();
  const entry = { name, status: result.status, seconds: Math.round((performance.now() - started) / 100) / 10, run: view.run, coverage: view.coverage, counts: view.counts, suggestions: brief(view) };
  observations.push(entry);
  console.log(`${name}: ${result.status} ${view.run?.state ?? ''} in ${entry.seconds}s, calls ${view.run?.usage?.calls ?? 0} (failed ${view.run?.usage?.failedCalls ?? 0}), ${view.suggestions.length} suggestions${view.run?.failure ? `; failure ${view.run.failure.code}: ${view.run.failure.message}` : ''}`);
  return view;
};

try {
  await mkdir(join(root, 'vault', 'Decision Journal'), { recursive: true });
  await start();
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  const call = async (tool, args) => (await mcp.call(tool, args)).result;
  const profiles = await api('listModelProviderProfiles');
  const qwen = profiles.find((item) => item.profileId === PROFILE);
  if (qwen === undefined) throw new Error('no built-in Qwen profile in the isolated root');
  observations.push({ name: 'profile', profile: { kind: qwen.kind, model: qwen.model, timeoutMs: qwen.timeoutMs, enabled: qwen.enabled } });

  // 合成数据：具体的 agent 结果、一句空泛的完成、两项说同一件事的未完成、一项无关的未完成。
  const recorded = await call('record_todo_list', { title: '消息服务缺陷', project: PROJECT, items: [
    { title: '修复客户端弱网重试时消息重复发送', priority: 'p1' },
    { title: '调研消息重复发送的幂等方案', priority: 'p2' },
    { title: '排查消息重复发送的服务端去重', priority: 'p2' },
    { title: '升级推送 SDK 到 5.x', priority: 'p3' },
    { title: '整理告警阈值', priority: 'p3' },
  ] });
  const listId = recorded.structuredContent.todoRecord.list.id;
  await call('update_todo_item', { listId, item: 1, status: 'done', note: '给发送请求加了客户端生成的幂等键；在测试环境断网 3 秒后恢复，自动重试 50 次，未再出现重复消息。手动重发没测。' });
  await call('update_todo_item', { listId, item: 4, status: 'done', note: '已处理' });

  if (automatic) {
    await api('setOrganizationSettings', { automatic: true, background: false, backgroundProfileId: PROFILE, inputTokens: 24000 });
    await api('createProactiveRecord', { kind: 'preference', title: '消息重试的验证边界', content: '自动重试通过测试后，仍需单独验证网络切换；其他项目不能直接套用。', project: PROJECT, sourceKind: 'app_manual', sourceForm: 'user_original', sensitivity: 'private', tags: [], appliesWhen: '本项目消息重试验证', exceptions: '其他项目未验证' });
  }
  // ① 用户实际拿到的配置（内置 Qwen 的超时原样）
  let view = await organize('first run, built-in Qwen profile as shipped');
  // ② 若是超时失败：把超时放宽后再整理一次（设置页可改的同一字段）；失败的调用不算处理过，会再排上。
  if ((view.run?.usage?.failedCalls ?? 0) > 0 && view.suggestions.length === 0) {
    await api('saveModelProviderProfile', { profile: { ...qwen, timeoutMs: 120_000 } });
    observations.push({ name: 'profile changed', timeoutMs: 120_000 });
    view = await organize('second run, Qwen timeout 120 s');
  }
  // ③ 采纳经验后补一条真实更正，再整理：看修订卡由真实模型给出什么。
  const experience = view.suggestions.find((item) => item.type === 'experience' && (automatic ? item.state === 'applied' : item.state === 'pending' && item.canAdopt));
  if (experience !== undefined) {
    const adopted = automatic ? { status: 'automatically_applied' } : await api('decideSuggestion', { id: experience.id, expectedRevision: experience.revision, expectedEvidenceVersion: experience.evidenceVersion, action: 'adopt' });
    observations.push({ name: 'adopt experience', status: adopted.status });
    await call('update_todo_item', { listId, item: 1, note: '更正：Wi-Fi 与蜂窝网络切换时又复现过一次重复，幂等键在切换后被重新生成了。' });
    await organize('after a correction to the adopted experience');
  }
  // ④ 真实调用途中停止：从点停止到运行结束的时间。
  await call('update_todo_item', { listId, item: 5, status: 'done', note: '把 CPU 告警阈值从 70% 调到 85%，观察一周误报从每天 12 次降到 1 次。' });
  const run = await api('runOrganization', { scope: 'project', project: PROJECT, profileId: PROFILE });
  if (run.status === 'started') {
    // Soon after the start: the call warm-model Qwen answers in about two seconds is still out.
    await sleep(400);
    const asked = performance.now();
    const stopped = await api('controlOrganizationRun', { runId: run.run.runId, action: 'stop' });
    const answered = performance.now();
    const ended = await settle();
    observations.push({ name: 'stop during a real call', controlMs: Math.round(answered - asked), endedMs: Math.round(performance.now() - asked), state: stopped.state, after: ended.run?.state });
    console.log(`stop: control answered in ${Math.round(answered - asked)} ms, run ${ended.run?.state} after ${Math.round(performance.now() - asked)} ms`);
  }
} catch (error) {
  driverError = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  console.error(driverError);
} finally {
  const cleanup = [];
  const step = async (name, work) => { try { await work(); } catch (error) { cleanup.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); } };
  const report = () => writeFile(join(out, `organize-qwen-${label}.json`), `${JSON.stringify({ label, path: 'IPC (window.decision) and bridge MCP, real on-device Qwen', root, childPids, observations, driverError, cleanup, stderr: stderr.slice(-1_500) }, null, 2)}\n`);
  await step('report', async () => { await mkdir(out, { recursive: true }); await report(); });
  await step('close mcp', async () => { await mcp?.close?.(); });
  await step('stop app', () => stop());
  if (cleanup.length > 0) await step('report again', report);
  console.log(`observations in ${out}${cleanup.length > 0 ? `; cleanup errors: ${cleanup.map((item) => item.name).join(', ')}` : ''}`);
  process.exit(driverError === null && cleanup.length === 0 ? 0 : 1);
}
