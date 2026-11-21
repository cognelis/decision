// OM1（IMP-191）整理与记忆实跑：打包的 App（隔离目录）+ 驱动内的本机 OpenAI 兼容桩服务（固定输出、计数、可受控挂起）。
// 走的是页面的真实 IPC（CDP 调 window.decision）与 bridge MCP，**不是按钮 UI**：按钮、截图与点击由 UI 实现者另行覆盖，
// 报告里分开写。合成数据；凭据是写进隔离目录的假 key（本机凭据模式，不进钥匙串）；桩 profile 用 proxy direct，网络策略
// 只对本机回环放行。
// usage: node scripts/lab/probes/organize-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label om1 --out DIR
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { DATA_DIR, connectMcp, executableOf, isolationEnvironment, parseCommon, sleep } from './lib.mjs';
import { ISOLATION_KEYS } from '../isolated-app.mjs';

const { app, bridge, label, out } = parseCommon();
const root = await realpath(await mkdtemp(join(DATA_DIR, 'organize-')));
const appPath = await realpath(app);
const checks = [];
const check = (name, ok, evidence) => { checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence: String(evidence).slice(0, 2_000) }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const fatal = (message) => { console.error(`FATAL ${message}`); process.exit(2); };

// ---- ① 环境：凭据样的变量一律去掉（PARASELF_* 也不例外），断言没有残留；每个隔离路径都在本轮 root 下。
const env = { ...isolationEnvironment(root), PARASELF_SMOKE: '1', PARASELF_ORGANIZATION_LAB_IDLE: '1' };
delete env.PARASELF_PROVIDER_CHILD; delete env.DECISION_PROVIDER_CHILD;
const CREDENTIAL = /key|secret|token|password|credential/iu;
for (const name of Object.keys(env)) if (CREDENTIAL.test(name)) delete env[name];
const left = Object.keys(env).filter((name) => CREDENTIAL.test(name));
if (left.length > 0) fatal(`credential-like variables left: ${left.join(', ')}`);
// The app is given its own variables only: the isolated paths and the two switches. Any other PARASELF_/DECISION_ one
// (the driver's own PARASELF_LAB_ROOT, a leftover from the shell) is taken out, never passed on.
const SWITCHES = ['PARASELF_SMOKE', 'PARASELF_ORGANIZATION_LAB_IDLE'];
for (const name of Object.keys(env)) if (/^(PARASELF|DECISION)_/u.test(name) && !ISOLATION_KEYS.includes(name) && !SWITCHES.includes(name)) delete env[name];
for (const name of ISOLATION_KEYS) {
  if (env[name] === undefined) fatal(`${name} is not set`);
  const absolute = resolve(env[name]);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) fatal(`${name} points outside the lab root`);
}
const FAKE_KEY = 'lab-not-a-secret-organize';

// ---- 桩服务：三类整理提示词各有固定输出；每次调用计数并记下种类与提示词（合成数据）。hang 打开时请求挂起，直到放开或连接断开。
const calls = [];
const stubState = { hang: false, waiting: [] };
const release = () => { stubState.hang = false; for (const resume of stubState.waiting.splice(0)) resume(); };
const answerFor = (kind, user) => {
  if (kind === 'experience') return {
    hasObservation: true, title: '修复重复发送后在重试场景验证', scene: '弱网自动重试', action: '带上幂等键',
    observation: 'Agent 报告：重试 50 次未再出现重复消息。', inference: '对自动重试路径有效', exceptions: '手动重发、多设备未验证', outcome: 'effective',
  };
  if (kind === 'todo') {
    const refs = [...new Set(user.match(/^T\d+(?=（)/gmu) ?? [])];
    return {
      groups: refs.length >= 2 ? [{ title: '消息重复发送', members: refs.slice(0, 2).map((ref, at) => ({ ref, difference: at === 0 ? '方案调研' : '服务端排查' })) }] : [],
      acceptance: refs.map((ref) => ({ ref, missing: '可检查的完成标准', draftDetail: `完成标准（${ref}）：弱网下重试 50 次无重复。` })),
      links: [],
    };
  }
  return { pairs: [] };
};
const stub = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  const parsed = JSON.parse(body);
  const system = parsed.messages.find((message) => message.role === 'system')?.content ?? '';
  const user = parsed.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
  const kind = system.includes('执行经验') ? 'experience' : system.includes('整理同一个项目里的待办') ? 'todo' : system.includes('比较同一项目') ? 'conflict' : 'other';
  calls.push({ kind, user, at: Date.now() });
  if (stubState.hang) {
    await new Promise((resume) => { stubState.waiting.push(resume); request.socket.once('close', resume); });
    if (request.socket.destroyed) return;
  }
  if (kind === 'other') { response.writeHead(400).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: `stub-${calls.length}`, model: 'stub-model',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answerFor(kind, user)) } }],
    usage: { prompt_tokens: Math.ceil(body.length / 2), completion_tokens: 80, total_tokens: Math.ceil(body.length / 2) + 80 },
  }));
});
await new Promise((ready) => stub.listen(0, '127.0.0.1', ready));
const stubPort = stub.address().port;

// ---- ② 隔离 App：空闲端口；核对 runtime 的 pid 是这一个子进程、CDP 页面属于这一个 App；停就要真停。
const freePort = () => new Promise((ready, fail) => {
  const probe = createNetServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => ready(port)); });
});
let child; let socket; let mcp; let stderr = ''; let port; let driverError = null;
const childPids = [];
const until = async (what, probe, ms = 90_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}\n${stderr}`);
    await sleep(250);
  }
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let nextId = 0; const pending = new Map();
const send = (method, params = {}) => { const id = ++nextId; const answer = new Promise((done) => pending.set(id, done)); socket.send(JSON.stringify({ id, method, params })); return answer; };
const start = async () => {
  port = await freePort();
  stderr = '';
  child = spawn(executableOf(appPath), [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  childPids.push(child.pid);
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
  await until('health of this child', async () => {
    const runtime = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
    if (runtime.pid !== child.pid) return null;
    return (await fetch(`http://127.0.0.1:${runtime.port}/health`)).ok ? runtime : null;
  });
  const target = await until('renderer page of this app', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
    .find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl && decodeURIComponent(entry.url).startsWith(`file://${appPath}/`)));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((open, fail) => { socket.onopen = open; socket.onerror = fail; });
  socket.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id !== undefined) { pending.get(data.id)?.(data); pending.delete(data.id); } };
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // The page is this app's: its preload answers, and the runtime file names this child.
  const runtime = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
  if (runtime.pid !== child.pid) fatal('runtime pid is not the child started');
};
const stop = async (signal = 'SIGTERM') => {
  socket?.close();
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill(signal);
  await Promise.race([exited, sleep(signal === 'SIGKILL' ? 15_000 : 120_000)]);
  if (alive(pid)) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(15_000)]);
  }
  if (alive(pid)) fatal(`app ${pid} did not exit; not restarting`);
};
const api = async (method, input) => {
  const { result, error } = await send('Runtime.evaluate', { expression: `window.decision.${method}(${input === undefined ? '' : JSON.stringify(input)})`, awaitPromise: true, returnByValue: true });
  if (error || result.exceptionDetails) throw new Error(`${method}: ${JSON.stringify(error ?? result.exceptionDetails.exception?.description)}`);
  return result.result.value;
};
const PROJECT = '消息服务（实验）';
const snapshot = () => api('getOrganization', { project: PROJECT, scope: 'project' });
const settle = async (ms = 180_000) => until('organization run to end', async () => { const view = await snapshot(); return view.activeRun === null ? view : null; }, ms);
const waitCalls = (count) => until(`model call ${count}`, async () => calls.length >= count, 60_000);
const ofItem = (view, listId, item, type) => view.suggestions.filter((suggestion) => suggestion.type === type && suggestion.sources.some((source) => source.key === `todo_item:${listId}#${item}`));
const todoItem = async (listId, item) => (await api('listTodoLists', { listId })).lists[0].items.find((entry) => entry.number === item);

try {
  await mkdir(join(root, 'vault', 'Decision Journal'), { recursive: true });
  await start();
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  const call = async (tool, args) => (await mcp.call(tool, args)).result;

  // ③ 模型：本机凭据模式下的 OpenAI 兼容桩；proxy direct，策略只对本机回环放行。
  await api('setLocalCredentialsEnabled', true);
  // A priority of its own: the isolated app starts with its built-in profiles, and two may not share one.
  const priority = Math.max(-1, ...(await api('listModelProviderProfiles')).map((item) => item.priority)) + 1;
  const profile = await api('saveModelProviderProfile', { profile: { version: 1, profileId: 'lab-stub', kind: 'openai-compatible', label: '实验桩', enabled: true, priority, model: 'stub-model', timeoutMs: 60_000, baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiProtocol: 'chat-completions', credentialConfigured: false, proxy: { mode: 'direct' }, fallbackOnFailure: false }, secret: FAKE_KEY });
  check('the stub profile is saved in the isolated root', profile.profileId === 'lab-stub', JSON.stringify(profile));

  // ④ 种子：一项完成（agent 结果说明）；两项未完成、说同一件事（必归为一组、各有验收缺口）；一项带含「已验证」字样的处置备注。
  const recorded = await call('record_todo_list', { title: '消息服务缺陷', project: PROJECT, items: [
    { title: '修复客户端弱网重试时消息重复发送', priority: 'p1' },
    { title: '调研消息重复发送的幂等方案', priority: 'p2' },
    { title: '排查消息重复发送的服务端去重', priority: 'p2' },
    { title: '优化推送体验', priority: 'p3' },
  ] });
  const listId = recorded.structuredContent.todoRecord.list.id;
  await call('update_todo_item', { listId, item: 1, status: 'done', note: '在测试环境断网 3 秒后恢复重试 50 次，未再出现重复消息。' });
  await api('changeTodoItem', { listId, item: 4, expectedStatus: 'open', disposition: '已验证过别的方案效果很好，按这个思路做' });

  // A. 整理一次
  const started = await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  check('a run starts', started.status === 'started', JSON.stringify(started));
  let view = await settle();
  const firstCalls = calls.length;
  check('the run made model calls and ended done', firstCalls > 0 && view.run?.state === 'done', JSON.stringify(view.run));
  check('counts add up to the badge', view.counts.pending === view.counts.todo + view.counts.memory + view.counts.conflict, JSON.stringify(view.counts));
  check('a 处置备注 never reaches the model', calls.every((entry) => !entry.user.includes('别的方案效果很好')), 'disposition text seen in a prompt');
  check('usage keeps reported and estimated apart', view.run.usage.reportedInputTokens > 0, JSON.stringify(view.run.usage));
  const experience = ofItem(view, listId, 1, 'experience')[0];
  check('an experience candidate for the finished item, an unverified agent report', experience?.attribution.verification === 'agent_reported_unverified', JSON.stringify(view.suggestions.map((item) => item.type)));
  const group = view.suggestions.find((item) => item.type === 'todo_group');
  check('the two items about one thing are one group', group !== undefined && ofItem(view, listId, 2, 'todo_group').length === 1 && ofItem(view, listId, 3, 'todo_group').length === 1, JSON.stringify(view.suggestions.map((item) => [item.type, item.sources.map((source) => source.key)])));
  const acceptance2 = ofItem(view, listId, 2, 'todo_acceptance')[0];
  const acceptance3 = ofItem(view, listId, 3, 'todo_acceptance')[0];
  check('each vague item has an acceptance draft', acceptance2 !== undefined && acceptance3 !== undefined, JSON.stringify(view.suggestions.map((item) => item.type)));

  // B. 相同输入再整理：零调用
  await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  view = await settle();
  check('the same input again: no model call, no new suggestion', calls.length === firstCalls && view.run?.state === 'no_change', JSON.stringify({ calls: calls.length, firstCalls, run: view.run?.state }));

  // C. 采纳分组：阅读层注记出现，事项本身不变
  const before2 = await todoItem(listId, 2);
  const groupAdopted = await api('decideSuggestion', { id: group.id, expectedRevision: group.revision, expectedEvidenceVersion: group.evidenceVersion, action: 'adopt' });
  const annotations = await api('getTodoAnnotations', { listIds: [listId] });
  check('an adopted group is an annotation over items left as they were', groupAdopted.status === 'saved' && annotations.groups.length === 1 && annotations.groups[0].members.length === 2,
    JSON.stringify({ groupAdopted: groupAdopted.status, annotations }));
  const after2 = await todoItem(listId, 2);
  check('grouping changed no item', JSON.stringify([before2.status, before2.detail, before2.priority]) === JSON.stringify([after2.status, after2.detail, after2.priority]), JSON.stringify({ before2, after2 }));

  // D. 采纳验收草稿：补充说明写成草稿
  const accepted = await api('decideSuggestion', { id: acceptance2.id, expectedRevision: acceptance2.revision, expectedEvidenceVersion: acceptance2.evidenceVersion, action: 'adopt' });
  check('an adopted draft is written to the item, and nothing else of it', accepted.status === 'saved' && (await todoItem(listId, 2)).detail === acceptance2.content.draftDetail && (await todoItem(listId, 2)).priority === 'p2',
    JSON.stringify({ accepted: accepted.status, detail: (await todoItem(listId, 2)).detail }));

  // E. 来源在 Obsidian 被改：草稿过期，采纳被拒，事项不变
  const todoDir = join(root, 'vault', 'Decision Journal', 'todos');
  const todoPath = join(todoDir, (await readdir(todoDir, { recursive: true })).find((name) => name.endsWith('.md')));
  await writeFile(todoPath, (await readFile(todoPath, 'utf8')).replace('排查消息重复发送的服务端去重', '排查消息重复发送的服务端去重（含队列重投）'));
  const stale3 = (await snapshot()).suggestions.find((item) => item.id === acceptance3.id);
  const refused = await api('decideSuggestion', { id: acceptance3.id, expectedRevision: acceptance3.revision, expectedEvidenceVersion: acceptance3.evidenceVersion, action: 'adopt' });
  check('a draft whose item changed in Obsidian is stale and refused, the item untouched', stale3?.canAdopt === false && refused.status === 'stale' && (await todoItem(listId, 3)).detail === null,
    JSON.stringify({ stale: stale3?.stale, refused: refused.status }));

  // F. 不采纳、重开、候选不进检索、采纳后显式检索命中、默认不命中
  const rejected = await api('decideSuggestion', { id: experience.id, expectedRevision: experience.revision, expectedEvidenceVersion: experience.evidenceVersion, action: 'reject' });
  await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  view = await settle();
  check('a declined experience stays declined on the same evidence', rejected.status === 'saved' && !view.suggestions.some((item) => item.id === experience.id), JSON.stringify(view.suggestions.map((item) => [item.id, item.state])));
  const declined = view.handled.find((item) => item.id === experience.id);
  const reopened = await api('decideSuggestion', { id: experience.id, expectedRevision: declined.revision, expectedEvidenceVersion: declined.evidenceVersion, action: 'reopen' });
  check('the reader can reopen it', reopened.status === 'saved' && reopened.suggestion.state === 'pending', JSON.stringify(reopened));
  const before = await call('search_decision_context', { source: 'experiences', query: '' });
  check('a candidate is never found by search', (before.structuredContent?.context?.results ?? []).length === 0, JSON.stringify(before.structuredContent).slice(0, 500));
  const adopted = await api('decideSuggestion', { id: experience.id, expectedRevision: reopened.suggestion.revision, expectedEvidenceVersion: reopened.suggestion.evidenceVersion, action: 'adopt' });
  check('adopting the experience writes it', adopted.status === 'saved', JSON.stringify(adopted));
  const found = await call('search_decision_context', { source: 'experiences', query: '' });
  const results = found.structuredContent?.context?.results ?? [];
  check('found when named, as an experience, marked unverified', results.length === 1 && results[0].kind === 'experience' && results[0].warnings.includes('Agent 报告，未独立核验。'), JSON.stringify(results).slice(0, 800));
  const plain = await call('search_decision_context', { query: '' });
  check('not among the default sources', (plain.structuredContent?.context?.results ?? []).every((item) => item.kind !== 'experience'), 'experience in a default search');
  const notes = (await readdir(join(root, 'vault', 'Decision Journal', 'experiences'), { recursive: true })).filter((name) => name.endsWith('.md'));
  check('one experience note in the vault, active', notes.length === 1 && (await readFile(join(root, 'vault', 'Decision Journal', 'experiences', notes[0]), 'utf8')).includes('status: active'), notes.join(','));

  // G. 撤销经验（未改动 → 直接恢复）
  const applied = (await snapshot()).suggestions.find((item) => item.id === experience.id);
  const undone = await api('undoSuggestion', { id: experience.id, expectedRevision: applied.revision });
  check('an unchanged adopted experience is undone directly', undone.status === 'saved', JSON.stringify(undone));
  const afterUndo = await call('search_decision_context', { source: 'experiences', query: '' });
  check('an undone experience is not found any more', (afterUndo.structuredContent?.context?.results ?? []).length === 0, JSON.stringify(afterUndo.structuredContent).slice(0, 300));

  // H. 删除事项 → 引用它的建议与注记被清除
  await api('deleteTodoItems', { listId, items: [{ item: 3, expectedStatus: 'open' }] });
  await snapshot();
  const statePath = join(env.PARASELF_USER_DATA, 'organization', 'state.json');
  check('nothing of a deleted item is kept in the suggestions', !(await readFile(statePath, 'utf8')).includes('排查消息重复发送的服务端去重'), 'deleted item text still in state.json');

  // ⑤ I. 暂停与继续：模型调用挂起时暂停，迟到的回答不写；继续后补上
  const finish = async (item, title) => {
    const added = await call('record_todo_list', { listId, items: [{ title, priority: 'p2' }] });
    const number = added.structuredContent.todoRecord.added[0].number;
    await call('update_todo_item', { listId, item: number, status: 'done', note: `${title}：在预发环境验证两次，结果符合预期。` });
    return number;
  };
  const item5 = await finish(5, '回滚 SDK 后重试');
  stubState.hang = true;
  let count = calls.length;
  const paused = await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  await waitCalls(count + 1);
  const pauseView = await api('controlOrganizationRun', { runId: paused.run.runId, action: 'pause' });
  release();
  await sleep(1_000);
  view = await snapshot();
  check('a paused run writes nothing its model answers late', pauseView.state === 'paused' && ofItem(view, listId, item5, 'experience').length === 0, JSON.stringify({ pauseView: pauseView.state, found: ofItem(view, listId, item5, 'experience').length }));
  const resumed = await api('controlOrganizationRun', { runId: paused.run.runId, action: 'resume' });
  view = await settle();
  check('continuing takes it up from the queue', resumed.state === 'running' && ofItem(view, listId, item5, 'experience').length === 1, JSON.stringify({ resumed: resumed.state, found: ofItem(view, listId, item5, 'experience').length }));

  // J. 停止：同上，停止后不写；之后整理一次补上
  const item6 = await finish(6, '切换推送通道后重试');
  stubState.hang = true;
  count = calls.length;
  const stopped = await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  await waitCalls(count + 1);
  const stopView = await api('controlOrganizationRun', { runId: stopped.run.runId, action: 'stop' });
  release();
  await sleep(1_000);
  check('a stopped run writes nothing late', stopView.state === 'stopped' && ofItem(await snapshot(), listId, item6, 'experience').length === 0, JSON.stringify(stopView));
  await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  view = await settle();
  check('the next run takes up what a stop left', ofItem(view, listId, item6, 'experience').length === 1, JSON.stringify(view.run));

  // K. 模型调用挂起时杀进程：重启后这一轮记为中断，队列还在，补整理恰好一张卡
  const item7 = await finish(7, '服务端加去重表后重试');
  stubState.hang = true;
  count = calls.length;
  await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  await waitCalls(count + 1);
  try { await mcp.close?.(); } catch { /* closed */ }
  await stop('SIGKILL');
  release();
  await start();
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  view = await snapshot();
  check('a run cut short by a kill reads back as interrupted', view.run?.state === 'interrupted' && view.activeRun === null && view.damaged === null, JSON.stringify({ run: view.run?.state, active: view.activeRun }));
  await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  view = await settle();
  check('its queue was kept: one card, not two', ofItem(view, listId, item7, 'experience').length === 1, JSON.stringify(ofItem(view, listId, item7, 'experience').map((item) => item.id)));

  // L. 后台：开启后首次自己发现新记录并整理；前台一动就让行
  const item8 = await finish(8, '加大重试间隔后重试');
  await api('setOrganizationSettings', { background: true, backgroundProfileId: 'lab-stub' });
  view = await until('background run', async () => { const now = await snapshot(); return now.activeRun === null && now.run?.trigger === 'background' && ofItem(now, listId, item8, 'experience').length === 1 ? now : null; }, 120_000);
  check('the background finds new records itself the first time it is on', view.run.trigger === 'background' && view.run.state === 'done', JSON.stringify(view.run));
  const item9 = await finish(9, '打开幂等开关后重试');
  stubState.hang = true;
  count = calls.length;
  await waitCalls(count + 1);
  // An agent at work (a search through the bridge): the run under way stops at once, its call still held by the stub.
  // The reader's own keyboard and mouse stop it through the system's idle time, which this lab run holds idle: covered by
  // the unit tests, not here.
  const yieldedAt = Date.now();
  await call('search_decision_context', { query: '重复发送' });
  view = await until('background yielded', async () => { const now = await snapshot(); return now.activeRun === null && now.run?.state === 'paused' ? now : null; }, 30_000);
  const yieldMs = Date.now() - yieldedAt;
  // Off before the held call is let go: the scheduler's next look would start another run.
  await api('setOrganizationSettings', { background: false, backgroundProfileId: null });
  release();
  await sleep(1_000);
  view = await snapshot();
  check(`a background run gives way to the reader at once (${yieldMs} ms with the stub)`, view.run?.trigger === 'background' && view.run.state === 'paused' && ofItem(view, listId, item9, 'experience').length === 0, JSON.stringify(view.run));

  // M. 坏状态文件不覆盖
  try { await mcp.close?.(); } catch { /* closed */ }
  await stop();
  await writeFile(statePath, '{ broken');
  await start();
  view = await snapshot();
  const blocked = await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' });
  check('a damaged state file is said, refused and left as it was', view.damaged !== null && blocked.status === 'damaged' && (await readFile(statePath, 'utf8')) === '{ broken', JSON.stringify({ damaged: view.damaged, blocked }));
} catch (error) {
  driverError = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  check('driver ran to the end', false, driverError);
  console.error(driverError);
} finally {
  // The report first, then each cleanup on its own: none of them may hide the result or another's failure.
  const cleanup = [];
  const step = async (name, work) => { try { await work(); } catch (error) { cleanup.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); } };
  const failed = checks.filter((item) => !item.ok);
  const report = () => writeFile(join(out, `organize-${label}.json`), `${JSON.stringify({ label, path: 'IPC (window.decision) and bridge MCP, not the buttons', root, childPids, checks, driverError, cleanup, calls: calls.map(({ kind, at }) => ({ kind, at })), failed: failed.length }, null, 2)}\n`);
  await step('report', async () => { await mkdir(out, { recursive: true }); await report(); });
  await step('release stub', () => release());
  await step('close mcp', async () => { await mcp?.close?.(); });
  await step('stop app', () => stop());
  await step('close stub', () => new Promise((done) => stub.close(() => done())));
  // Written again with what cleanup met, if anything.
  if (cleanup.length > 0) await step('report again', report);
  console.log(`${checks.length - failed.length}/${checks.length} ok (IPC/MCP path, not the buttons); evidence in ${out}${cleanup.length > 0 ? `; cleanup errors: ${cleanup.map((item) => item.name).join(', ')}` : ''}`);
  process.exit(failed.length === 0 && cleanup.length === 0 ? 0 : 1);
}
