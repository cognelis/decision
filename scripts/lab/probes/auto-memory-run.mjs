// OM2整理与记忆实跑：打包的 App（隔离目录）+ 驱动内的本机 OpenAI 兼容桩服务（固定输出、计数、可受控挂起）。
// 配置和业务操作走真实 IPC（CDP 调 window.decision）与 bridge MCP；页签实际点击并截图，报告分开记录。
// 合成数据；凭据是写进隔离目录的假 key（本机凭据模式，不进钥匙串）；桩 profile 用 proxy direct，网络策略
// 只对本机回环放行。
// usage: node scripts/lab/probes/organize-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label om1 --out DIR
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { DATA_DIR, connectMcp, executableOf, isolationEnvironment, parseCommon, sleep } from './lib.mjs';
import { ISOLATION_KEYS, labProcessEnvironment } from '../isolated-app.mjs';

const { app, bridge, label, out, capacity } = parseCommon({ capacity: { type: 'boolean', default: false } });
const root = await realpath(await mkdtemp(join(DATA_DIR, 'organize-')));
const appPath = await realpath(app);
const checks = [];
const check = (name, ok, evidence) => { checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence: String(evidence).slice(0, 2_000) }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const fatal = (message) => { console.error(`FATAL ${message}`); process.exit(2); };

// ---- ① 环境：凭据样的变量一律去掉（PARASELF_* 也不例外），断言没有残留；每个隔离路径都在本轮 root 下。
const env = labProcessEnvironment({ ...isolationEnvironment(root), PARASELF_SMOKE: '1', PARASELF_ORGANIZATION_LAB_IDLE: '1' });
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
let capacitySeed;
const capacityPath = join(env.PARASELF_USER_DATA, 'organization', 'state.json');
if (capacity) {
  const compiled = join(root, 'capacity-fixture.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../../apps/desktop/test/organization-capacity-fixture.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile: compiled, logLevel: 'silent' });
  capacitySeed = createRequire(import.meta.url)(compiled).capacityState(1600);
  await mkdir(join(env.PARASELF_USER_DATA, 'organization'), { recursive: true, mode: 0o700 });
  await writeFile(capacityPath, `${JSON.stringify({ version: 2, compression: 'gzip', data: gzipSync(JSON.stringify(capacitySeed)).toString('base64') })}\n`, { mode: 0o600, flag: 'wx' });
}

// ---- 桩服务：自动维护提示词各有固定输出；每次调用计数并记下种类与提示词（合成数据）。hang 打开时请求挂起，直到放开或连接断开。
const calls = [];
const stubState = { hang: false, waiting: [] };
const release = () => { stubState.hang = false; for (const resume of stubState.waiting.splice(0)) resume(); };
const answerFor = (kind, user) => {
  if (kind === 'knowledge') {
    const blocks = user.split(/\n\n(?=K\d+（)/u).flatMap((chunk) => { const match = /^(K\d+)（([^\n]+)）：\n([\s\S]*)/u.exec(chunk); return match ? [{ ref: match[1], heading: match[2], material: match[3] }] : []; });
    const preference = blocks.find((entry) => entry.heading.includes('preference') && entry.material.includes('先修复网络切换'));
    const task = blocks.find((entry) => entry.material.includes('状态：open'));
    return {
      memory: blocks[0]?.heading.includes('preference') ? { title: '本周发布的修复边界', scene: '本项目这次发布', observations: [{ ref: blocks[0].ref, quote: '先修复网络切换' }], inference: '先验证已有修复承诺；范围仅此项目', unknowns: '工作量和实际效果尚未核验' } : blocks[0]?.heading.includes('summary') ? { title: '历史缓存范围', scene: '单机部署', observations: [{ ref: blocks[0].ref, quote: '历史记录使用内存缓存' }], inference: '只适用于记录中的单机场景', unknowns: '多实例未验证' } : null,
      triage: null,
      question: preference && task && !user.includes('用户确认：') ? { category: 'commitment', task: task.ref, commitments: [{ ref: preference.ref, quote: '先修复网络切换' }], question: '本周发布：先完成修复，还是授权按期交付？', impact: '当前发布准备需要明确修复承诺的优先级。', unknowns: '修复时间尚未核验。', options: ['先完成修复再确定排期', '授权按期交付并延后修复'], recommendation: 'option_a', recommendationReason: '依据已有修复承诺。' } : null,
    };
  }
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
  const kind = system.includes('自动维护知识') ? 'knowledge' : system.includes('执行经验') ? 'experience' : system.includes('整理同一个项目里的待办') ? 'todo' : system.includes('比较同一项目') ? 'conflict' : 'other';
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

  const recorded = await call('record_todo_list', { title: '消息发布与重复发送', project: PROJECT, items: [
    { title: '消息重复发送的自动重试验证', priority: 'p1' },
    { title: '本周发布与消息重复发送修复', priority: 'p1' },
    { title: '消息重复发送排查与本周发布准备', priority: 'p2' },
  ] });
  const listId = recorded.structuredContent.todoRecord.list.id;
  await call('update_todo_item', { listId, item: 1, status: 'done', note: '测试环境重试 50 次未再出现重复消息；网络切换未验证。' });
  const record = (kind, title, content, extra = {}) => api('createProactiveRecord', { kind, sourceKind: 'app_manual', sourceForm: 'user_original', sensitivity: 'private', tags: [], ...(kind === 'decision' ? { options: [] } : {}), project: PROJECT, title, content, ...extra });
  await record('preference', '本周发布与消息重复发送', '本周发布前先修复网络切换的重复消息。', { appliesWhen: '本项目这次发布', exceptions: '其他项目不适用' });
  await record('decision', '网络切换修复待复盘', '网络切换重复消息需要验证。', { reviewDueDate: '2020-01-01' });
  const summaries = join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'summarize');
  await mkdir(summaries, { recursive: true });
  await writeFile(join(summaries, 'RSI-HIST-DATE.md'), `---\nid: RSI-HIST-DATE\ncreated: "2026-09-01"\nstatus: accepted\nselected_option: "历史记录使用内存缓存"\nproject: ${JSON.stringify(PROJECT)}\ntags: [synthetic]\nsupersedes: []\nsuperseded_by: null\n---\n# 历史缓存范围\n\n历史记录使用内存缓存，仅限单机场景。\n`);
  const runtime = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
  const capture = { eventVersion: 1, captureMode: 'structured_tool', sourceClient: 'test', sessionId: 'om2-isolated', batchId: 'om2-rationale', project: PROJECT, cwd: root, capturedAt: new Date().toISOString(), questions: [{ questionIndex: 0, question: '日志保留多少天？', options: [], answer: { kind: 'custom', values: ['14 天'] }, multiSelect: false }] };
  const post = (path, body) => fetch(`http://127.0.0.1:${runtime.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  check('synthetic capture accepted', (await post('/v1/captures', capture)).status === 202);
  const captured = await until('captured rationale', async () => (await api('getSnapshot')).current);
  await api('submitRationale', { candidateId: captured.candidateId, status: 'deferred' });
  const candidatePosted = await post('/v1/candidates', { candidateVersion: 1, candidateId: 'om2-pending', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), event: { ...capture, captureMode: 'transcript', batchId: 'om2-pending', questions: [{ questionIndex: 0, question: '消息重试日志要保留多少天？', options: [], answer: { kind: 'custom', values: ['7 天'] }, multiSelect: false }], detection: { band: 'medium', score: 60, detectorVersion: 'lab', signals: ['synthetic'] } } });
  if (candidatePosted.status !== 202) throw new Error('synthetic pending capture was not accepted');
  await until('synthetic pending capture is in the queue', async () => (await api('getSnapshot')).decisionCandidates.count > 0);
  await api('setOrganizationSettings', { automatic: true, background: false, backgroundProfileId: 'lab-stub', maxCalls: 8, inputTokens: 24000 });
  let view;
  for (let round = 0; round < 5; round++) {
    await api('runOrganization', { scope: 'all', project: null, profileId: 'lab-stub' }); view = await settle();
    if (view.run.state !== 'partial') break;
  }
  const experience = ofItem(view, listId, 1, 'experience')[0];
  check('routine experience applied without adoption', experience?.state === 'applied' && experience.automatic && experience.attribution.verification === 'agent_reported_unverified', JSON.stringify(view));
  const group = view.suggestions.find((entry) => entry.type === 'todo_group');
  check('reading group applied automatically', group?.state === 'applied', JSON.stringify(group));
  check('todo status unchanged by organization', (await todoItem(listId, 2)).status === 'open');
  const knowledge = view.suggestions.find((entry) => entry.content?.memoryKind === 'knowledge' && entry.sources.some((source) => source.kind === 'preference'));
  check('knowledge memory automatically searchable', knowledge?.state === 'applied', JSON.stringify(knowledge));
  const historical = view.suggestions.find((entry) => entry.type === 'experience' && entry.sources.some((source) => source.key === 'summary:RSI-HIST-DATE'));
  check('date-only historical knowledge becomes active memory', historical?.state === 'applied' && historical.sources.some((source) => source.at === '2026-09-01'), JSON.stringify(historical));
  const triage = view.suggestions.filter((entry) => entry.type === 'triage');
  check('all pending queue kinds enter automatic triage', ['pending_confirmation', 'pending_rationale', 'review'].every((kind) => triage.some((entry) => entry.sources.some((source) => source.kind === kind))), JSON.stringify(triage));
  check('unknown reasons stay quiet and no business execution occurs', triage.some((entry) => entry.content.disposition === 'unknown') && !view.suggestions.some((entry) => entry.type === 'todo_acceptance' || entry.type === 'todo_recheck'));
  const questions = view.suggestions.filter((entry) => entry.type === 'judgment' && entry.state === 'pending');
  check('only real judgments count toward attention', questions.length > 0 && view.counts.pending === questions.length, JSON.stringify(view.counts));
  const results = await call('search_decision_context', { source: 'experiences', project: PROJECT, query: '' });
  check('bridge returns automatic memories with provenance', results.structuredContent.context.results.some((entry) => entry.experience?.sources?.length > 0), JSON.stringify(results));
  check('machine memories do not claim user verification', results.structuredContent.context.results.filter((entry) => entry.warnings?.some((warning) => warning.includes('机器整理'))).every((entry) => entry.experience.verification === 'agent_reported_unverified'));

  // 真正点击本任务的隔离 Electron 页面，并在两个窗口尺寸检查布局与五个页签。
  await api('openSurface', 'dashboard');
  const evaluate = async (expression) => { const answer = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (answer.result?.exceptionDetails) throw new Error(JSON.stringify(answer.result.exceptionDetails)); return answer.result.result.value; };
  await until('home organization button', () => evaluate(`Boolean([...document.querySelectorAll('button')].find(b => b.textContent.includes('整理与记忆')))`));
  await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('整理与记忆')).click()`);
  await until('organization panel', () => evaluate(`document.querySelectorAll('.org-panel [role="tab"]').length === 5`));
  await mkdir(out, { recursive: true });
  for (const width of [1440, 960]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width === 960 ? 640 : 900, deviceScaleFactor: 1, mobile: false });
    for (const tab of ['总览', '待处理', '记忆', '需要你判断', '设置与状态']) {
      await evaluate(`[...document.querySelectorAll('.org-panel [role="tab"]')].find(b => b.textContent.startsWith(${JSON.stringify(tab)})).click()`);
      await sleep(200);
      const layout = await evaluate(`({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,tabs:[...document.querySelectorAll('.org-panel [role="tab"]')].map(b=>({name:b.textContent,selected:b.getAttribute('aria-selected')})),empty:document.querySelector('.org-panel')?.innerText.length<100})`);
      check(`UI ${width}: ${tab}`, layout.width === width && !layout.overflow && !layout.empty && layout.tabs.some((entry) => entry.name.startsWith(tab) && entry.selected === 'true'), JSON.stringify(layout));
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(join(out, `om2-${width}-${tab}.png`), Buffer.from(shot.result.data, 'base64'));
    }
  }
  const question = questions[0];
  if (question) {
    const saved = await api('decideSuggestion', { id: question.id, expectedRevision: question.revision, expectedEvidenceVersion: question.evidenceVersion, action: 'adopt', choice: 'option_a' });
    check('confirmed choice persists without executing a task', saved.status === 'saved' && (await todoItem(listId, 2)).status === 'open', JSON.stringify(saved));
  }
  if (!experience) throw new Error('missing automatic experience');
  const corrected = await api('decideSuggestion', { id: experience.id, expectedRevision: experience.revision, expectedEvidenceVersion: experience.evidenceVersion, action: 'adopt', draft: { type: 'experience', body: { inference: '仅自动重试路径有效，网络切换仍未知。' } } });
  check('correction creates a new version', corrected.status === 'saved' && corrected.id !== experience.id, JSON.stringify(corrected));
  if (corrected.suggestion) check('new version can be rolled back', (await api('undoSuggestion', { id: corrected.id, expectedRevision: corrected.suggestion.revision })).status === 'saved');
  const before = calls.length;
  await api('runOrganization', { scope: 'all', project: null, profileId: 'lab-stub' }); await settle();
  const afterAnswer = calls.length;
  await api('runOrganization', { scope: 'all', project: null, profileId: 'lab-stub' }); await settle();
  check('stable evidence and generated memories do not loop', calls.length === afterAnswer && afterAnswer >= before, `${before}/${afterAnswer}/${calls.length}`);
  await api('setOrganizationSettings', { automatic: true, background: true, backgroundProfileId: 'lab-stub', maxCalls: 8, inputTokens: 24000 });
  await call('record_todo_list', { title: '后台自动维护新增事项', project: PROJECT, items: [{ title: '后台消息重试排查', priority: 'p2' }] });
  const previous = calls.length;
  await until('automatic background discovers new input', async () => calls.length > previous, 30000); await settle();
  check('background processes new data without manual trigger', (await snapshot()).run?.trigger === 'background');
  await api('setOrganizationSettings', { automatic: true, background: false, backgroundProfileId: 'lab-stub' });
  const knowledgeCall = calls.find((entry) => entry.kind === 'knowledge' && /K1（[^\n]*preference[^\n]*）：/u.test(entry.user));
  const inputItem = knowledgeCall?.user.includes('标题：本周发布与消息重复发送修复') ? 2 : 3;
  const inputTitle = inputItem === 2 ? '本周发布与消息重复发送修复' : '消息重复发送排查与本周发布准备';
  const inputKey = `todo_item:${listId}#${inputItem}`;
  const memoryHit = results.structuredContent.context.results.find((entry) => entry.experience?.adoptedFrom?.startsWith(`${knowledge?.id}@r`));
  const memoryId = memoryHit?.id;
  check('uncited context was actually sent to the memory model', knowledgeCall?.user.includes(`标题：${inputTitle}`) && knowledge && !knowledge.sources.some((source) => source.key === inputKey), JSON.stringify({ inputKey, memoryId }));
  if (!memoryHit) throw new Error('missing synthetic parent memory');
  const vaultRoot = await realpath(env.PARASELF_VAULT_PATH);
  const parentPath = await realpath(resolve(vaultRoot, memoryHit.sourceRef.relativePath));
  if (!parentPath.startsWith(`${vaultRoot}${sep}`)) throw new Error('synthetic memory is outside the isolated vault');
  const parentText = await readFile(parentPath, 'utf8');
  const boundary = parentText.indexOf('\n---\n', 4);
  if (!parentText.startsWith('---\n') || boundary < 0) throw new Error('invalid synthetic memory');
  const properties = parseYaml(parentText.slice(4, boundary));
  if (properties.id !== memoryId || properties.project !== PROJECT) throw new Error('unexpected synthetic memory identity');
  const childId = 'RSI09-derived-child';
  const marker = 'RSI09-TRANSITIVE-CANARY';
  const endObservation = '<!-- decision:experience-observation-end -->';
  if (!parentText.includes(endObservation)) throw new Error('missing synthetic observation section');
  const childText = `---\n${stringifyYaml({ ...properties, id: childId, adopted_from: null, sources: [], input_keys: [`experience:${memoryId}`], direct_input_keys: [`experience:${memoryId}`] })}---\n${parentText.slice(boundary + 5).replace(endObservation, `${marker}\n${endObservation}`)}`;
  const experienceFolder = await realpath(join(vaultRoot, 'Decision Journal', 'experiences'));
  if (!experienceFolder.startsWith(`${vaultRoot}${sep}`)) throw new Error('synthetic folder is outside the isolated vault');
  const childPath = join(experienceFolder, 'RSI09-derived-child.md');
  await writeFile(childPath, childText, { flag: 'wx' });
  const searchMemory = () => call('search_decision_context', { source: 'experiences', project: PROJECT, query: '', limit: 20 });
  await until('synthetic derived memory is indexed', async () => (await searchMemory()).structuredContent.context.results.some((entry) => entry.id === childId));
  check('two-level synthetic memory is initially searchable', true);
  const enabled = ['decision', 'summary', 'preference', 'idea', 'experience', 'pending_confirmation', 'pending_rationale', 'review', 'principle'];
  await api('setOrganizationSettings', { automatic: true, background: false, backgroundProfileId: 'lab-stub', sources: enabled, maxCalls: 8, inputTokens: 24000 });
  const restricted = (await searchMemory()).structuredContent.context.results;
  check('disabling uncited ancestor hides both derived memory levels', !restricted.some((entry) => entry.id === memoryId || entry.id === childId), JSON.stringify(restricted.map((entry) => entry.id)));
  const historicalId = results.structuredContent.context.results.find((entry) => entry.experience?.adoptedFrom?.startsWith(`${historical?.id}@r`))?.id;
  check('unrelated historical memory stays available', historicalId && restricted.some((entry) => entry.id === historicalId));
  const callsBeforeRestrictedRun = calls.length;
  await api('runOrganization', { scope: 'all', project: null, profileId: 'lab-stub' }); await settle();
  check('disabled ancestry is not sent through a derived memory', !calls.slice(callsBeforeRestrictedRun).some((entry) => entry.user.includes(marker)));
  await api('setOrganizationSettings', { automatic: true, background: false, backgroundProfileId: 'lab-stub', maxCalls: 8, inputTokens: 24000 });
  const restored = (await searchMemory()).structuredContent.context.results;
  check('restoring source permission restores both memory levels', [memoryId, childId].every((id) => restored.some((entry) => entry.id === id)));
  check('permission changes preserve original memory bytes', await readFile(parentPath, 'utf8') === parentText && await readFile(childPath, 'utf8') === childText);
  // 原始来源的生命周期与已确认选择分开验证；所有文件仍限定在本轮隔离 Vault。
  const choiceHit = restored.find((entry) => entry.experience?.adoptedFrom?.startsWith(`${question?.id}@r`));
  const preferenceHit = (await call('search_decision_context', { source: 'preferences', project: PROJECT, query: '', limit: 20 })).structuredContent.context.results[0];
  if (!choiceHit || !preferenceHit) throw new Error('missing synthetic lifecycle fixtures');
  const preferencePath = await realpath(resolve(vaultRoot, preferenceHit.sourceRef.relativePath));
  if (!preferencePath.startsWith(`${vaultRoot}${sep}`)) throw new Error('synthetic preference is outside the isolated vault');
  const preferenceText = await readFile(preferencePath, 'utf8');
  const preferenceBoundary = preferenceText.indexOf('\n---\n', 4);
  if (!preferenceText.startsWith('---\n') || preferenceBoundary < 0) throw new Error('invalid synthetic preference');
  const preferenceProperties = parseYaml(preferenceText.slice(4, preferenceBoundary));
  if (preferenceProperties.id !== preferenceHit.id || preferenceProperties.project !== PROJECT) throw new Error('unexpected synthetic preference identity');
  const sourceInactive = async (phase) => {
    const found = (await searchMemory()).structuredContent.context.results;
    check(`${phase}: machine descendants pause and confirmed choice survives`, !found.some((entry) => entry.id === memoryId || entry.id === childId) && found.some((entry) => entry.id === choiceHit.id), JSON.stringify(found.map((entry) => entry.id)));
    await call('record_todo_list', { title: `生命周期合成 ${phase}`, project: PROJECT, items: [{ title: '本周发布与消息重复发送后续修复', priority: 'p2' }] });
    const beforeCalls = calls.length;
    await api('runOrganization', { scope: 'project', project: PROJECT, profileId: 'lab-stub' }); await settle();
    check(`${phase}: old machine context is not sent to the model`, !calls.slice(beforeCalls).some((entry) => entry.user.includes(marker) || entry.user.includes('先验证已有修复承诺')));
  };
  const withdrawn = await call('update_decision_journal_entry', { action: 'withdraw', source: 'preferences', recordId: preferenceHit.id, expectedRevision: 0, basis: 'user_confirmed', reason: '合成生命周期撤回' });
  check('source withdrawal is actually saved', withdrawn.structuredContent.amendment.status === 'saved');
  if (withdrawn.structuredContent.amendment.status !== 'saved') throw new Error('synthetic withdrawal was not applied');
  await sourceInactive('withdrawn');
  const restoredSource = await call('update_decision_journal_entry', { action: 'restore', source: 'preferences', recordId: preferenceHit.id, expectedRevision: withdrawn.structuredContent.amendment.revision, basis: 'user_confirmed', reason: '合成生命周期恢复' });
  if (restoredSource.structuredContent.amendment.status !== 'saved') throw new Error('synthetic withdrawal was not restored');
  const afterSourceRestore = (await searchMemory()).structuredContent.context.results;
  check('restoring withdrawn source restores surviving memories', restoredSource.structuredContent.amendment.status === 'saved' && [memoryId, childId, choiceHit.id].every((id) => afterSourceRestore.some((entry) => entry.id === id)));
  await writeFile(preferencePath, `---\n${stringifyYaml({ ...preferenceProperties, knowledge_status: 'archived' })}---\n${preferenceText.slice(preferenceBoundary + 5)}`);
  await until('original synthetic preference is archived', async () => (await call('search_decision_context', { source: 'preferences', project: PROJECT, recordId: preferenceHit.id, includeWithdrawn: true })).structuredContent.context.results[0]?.signal?.knowledgeStatus === 'archived');
  await sourceInactive('archived');
  await writeFile(preferencePath, preferenceText);
  await until('original synthetic preference is restored', async () => (await call('search_decision_context', { source: 'preferences', project: PROJECT, recordId: preferenceHit.id, includeWithdrawn: true })).structuredContent.context.results[0]?.signal?.knowledgeStatus === 'active');
  const afterArchiveRestore = (await searchMemory()).structuredContent.context.results;
  check('unarchiving source restores surviving memories', [memoryId, childId, choiceHit.id].every((id) => afterArchiveRestore.some((entry) => entry.id === id)));
  check('source lifecycle preserves memory note bytes', await readFile(parentPath, 'utf8') === parentText && await readFile(childPath, 'utf8') === childText);
  const forgetPreview = await api('previewOrganizationForget', { key: inputKey });
  check('forget preview includes memory derived from uncited input', memoryId && forgetPreview.experiences.some((entry) => entry.id === memoryId), JSON.stringify(forgetPreview));
  const forgotten = await api('forgetOrganizationSource', { key: inputKey, confirm: true, expectedPreviewHash: forgetPreview.previewHash });
  const afterForget = await call('search_decision_context', { source: 'experiences', project: PROJECT, query: '' });
  check('forget removes affected memory and preserves the original task', forgotten.status === 'done' && memoryId && !afterForget.structuredContent.context.results.some((entry) => entry.id === memoryId || entry.id === childId) && (await todoItem(listId, inputItem)).status === 'open', JSON.stringify({ forgotten, memoryId, results: afterForget.structuredContent.context.results.map((entry) => entry.id) }));

  const lifeProject = '消息服务（独立选择生命周期实验）';
  await call('record_todo_list', { title: '本周发布与消息重复发送', project: lifeProject, items: [{ title: '本周发布与消息重复发送修复', priority: 'p1' }] });
  const lifePreference = await record('preference', '生命周期独立选择：消息重复发送', '生命周期独立选择专用样本：本周发布前先修复网络切换的重复消息，仅用于第二个合成项目。', { project: lifeProject, appliesWhen: '本项目', exceptions: '其他项目不适用' });
  if (lifePreference.status !== 'created') throw new Error('synthetic lifecycle preference was deduplicated instead of created');
  await record('decision', '本周发布与消息重复发送', '本周发布与消息重复发送：网络切换修复未验证。', { project: lifeProject });
  let lifeView;
  for (let round = 0; round < 5; round++) {
    await api('runOrganization', { scope: 'project', project: lifeProject, profileId: 'lab-stub' });
    lifeView = await until('lifecycle organization settles', async () => { const value = await api('getOrganization', { scope: 'project', project: lifeProject }); return value.activeRun === null ? value : null; });
    if (lifeView.run.state !== 'partial') break;
  }
  const lifeQuestion = lifeView.suggestions.find((entry) => entry.type === 'judgment' && entry.state === 'pending');
  if (!lifeQuestion) throw new Error('missing independent choice question');
  await api('decideSuggestion', { id: lifeQuestion.id, expectedRevision: lifeQuestion.revision, expectedEvidenceVersion: lifeQuestion.evidenceVersion, action: 'adopt', choice: 'option_a' });
  const lifeSearch = () => call('search_decision_context', { source: 'experiences', project: lifeProject, query: '', limit: 20 });
  const lifeNotes = (await lifeSearch()).structuredContent.context.results;
  const lifeChoice = lifeNotes.find((entry) => entry.experience?.adoptedFrom?.startsWith(`${lifeQuestion.id}@r`));
  const lifeMachine = lifeNotes.find((entry) => entry.id !== lifeChoice?.id);
  const lifeDecision = (await call('search_decision_context', { source: 'decisions', project: lifeProject, query: '', limit: 20 })).structuredContent.context.results[0];
  if (!lifeChoice || !lifeMachine || !lifeDecision) throw new Error('missing lifecycle deletion fixtures');
  const fullBeforeDelete = await api('previewOrganizationForget', { key: `decision:${lifeDecision.id}` });
  check('confirmed choice retains its explicit-forgetting lineage', fullBeforeDelete.experiences.some((entry) => entry.id === lifeChoice.id));
  if (!fullBeforeDelete.experiences.some((entry) => entry.id === lifeChoice.id)) throw new Error('synthetic deletion source was not part of the choice input');
  const deletionPreview = await api('previewDecisionDeletion', { id: lifeDecision.id, storage: 'vault' });
  check('ordinary source deletion preview preserves independent choice', deletionPreview.organization && !deletionPreview.organization.experiences.some((entry) => entry.id === lifeChoice.id));
  const deletion = await api('deleteDecision', { id: lifeDecision.id, storage: 'vault', expectedContentHash: deletionPreview.contentHash, expectedOrganizationPreviewHash: deletionPreview.organization?.previewHash });
  const afterDeletion = (await lifeSearch()).structuredContent.context.results;
  check('ordinary source deletion removes machine memory and retains confirmed choice', deletion.deleted && afterDeletion.some((entry) => entry.id === lifeChoice.id) && !afterDeletion.some((entry) => entry.id === lifeMachine.id), JSON.stringify(afterDeletion.map((entry) => entry.id)));
  const fullAfterDelete = await api('previewOrganizationForget', { key: `decision:${lifeDecision.id}` });
  const explicitForget = await api('forgetOrganizationSource', { key: `decision:${lifeDecision.id}`, confirm: true, expectedPreviewHash: fullAfterDelete.previewHash });
  check('explicit forgetting still removes the preserved choice after source deletion', fullAfterDelete.experiences.some((entry) => entry.id === lifeChoice.id) && explicitForget.status === 'done' && !(await lifeSearch()).structuredContent.context.results.some((entry) => entry.id === lifeChoice.id));
  if (capacity) {
    const stored = JSON.parse(await readFile(capacityPath, 'utf8'));
    const decoded = stored.version === 2 ? JSON.parse(gunzipSync(Buffer.from(stored.data, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) : stored;
    check('full maintenance flow stays on compressed large state', stored.version === 2 && Buffer.byteLength(JSON.stringify(decoded)) > 8 * 1024 * 1024);
    check('capacity history choices and rejection receipts remain exact', Object.entries(capacitySeed.suggestions).every(([id, suggestion]) => isDeepStrictEqual(decoded.suggestions[id], suggestion)));
    check('capacity forgetting receipts remain exact', decoded.ledger.forgotten['preference:forgotten'] === capacitySeed.ledger.forgotten['preference:forgotten'] && decoded.ledger.forgottenEvidence['preference:forgotten'] === capacitySeed.ledger.forgottenEvidence['preference:forgotten']);
    const forgottenChoice = decoded.suggestions[lifeQuestion.id];
    check('explicit forgetting clears decoded choice payload and recovery values', forgottenChoice?.redacted === true && forgottenChoice.content === null && forgottenChoice.draft === null && forgottenChoice.apply?.steps.every(step => step.before === null && step.after === null));
  }
} catch (error) {
  driverError = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  check('driver ran to the end', false, driverError);
  console.error(driverError);
} finally {
  // The report first, then each cleanup on its own: none of them may hide the result or another's failure.
  const cleanup = [];
  const step = async (name, work) => { try { await work(); } catch (error) { cleanup.push({ name, error: error instanceof Error ? error.stack ?? error.message : String(error) }); } };
  const failed = checks.filter((item) => !item.ok);
  const report = () => writeFile(join(out, `auto-memory-${label}.json`), `${JSON.stringify({ label, path: 'IPC (window.decision) and bridge MCP, plus actual renderer tab clicks', root, childPids, checks, driverError, cleanup, calls: calls.map(({ kind, at }) => ({ kind, at })), failed: failed.length }, null, 2)}\n`);
  await step('report', async () => { await mkdir(out, { recursive: true }); await report(); });
  await step('release stub', () => release());
  await step('close mcp', async () => { await mcp?.close?.(); });
  await step('stop app', () => stop());
  await step('close stub', () => new Promise((done) => stub.close(() => done())));
  // Written again with what cleanup met, if anything.
  if (cleanup.length > 0) await step('report again', report);
  console.log(`${checks.length - failed.length}/${checks.length} ok (IPC/MCP path, plus actual renderer tab clicks); evidence in ${out}${cleanup.length > 0 ? `; cleanup errors: ${cleanup.map((item) => item.name).join(', ')}` : ''}`);
  process.exit(failed.length === 0 && cleanup.length === 0 ? 0 : 1);
}
