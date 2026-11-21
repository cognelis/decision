// 待办第四版 (IMP-188) on the packaged App in an isolated root: P0–P3 and tags on a long list, the keyboard (real key events
// over the DevTools protocol), moving items to another list, the tag view, the quick-add dialog and the wider drawer, each
// photographed in the light and the dark theme; an agent's tags and P0 through the real bridge. Synthetic data; the App is hidden.
// usage: node scripts/lab/probes/todo-v4-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label v4 --out DIR --shots DIR
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, isolationEnvironment, parseCommon, save, sleep } from './lib.mjs';

const { app, bridge, label, out, shots } = parseCommon({ shots: { type: 'string' } });
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'todo-v4-'));
const checks = [];
const check = (name, ok, evidence) => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const notes = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await notes(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
};

const env = { ...isolationEnvironment(root), PARASELF_SMOKE: '1' };
delete env.PARASELF_PROVIDER_CHILD;
delete env.DECISION_PROVIDER_CHILD;
const port = 9300 + Math.floor(Math.random() * 500);
const child = spawn(executableOf(app), [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
const until = async (what, probe, ms = 60_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}\n${stderr}`);
    await sleep(200);
  }
};
const soon = async (probe, ms = 6000) => { try { return await until('page', probe, ms); } catch { return false; } };

let socket;
let mcp;
try {
  await until('health', async () => {
    const parsed = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
    return (await fetch(`http://127.0.0.1:${parsed.port}/health`)).ok ? parsed : null;
  });
  const target = await until('renderer page', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined) { pending.get(data.id)?.(data); pending.delete(data.id); }
  };
  const send = async (method, params = {}) => {
    const id = ++nextId;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method, params }));
    return answer;
  };
  const evaluate = async (expression) => {
    const { result, error } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (error || result.exceptionDetails) throw new Error(JSON.stringify(error ?? result.exceptionDetails.exception?.description));
    return result.result.value;
  };
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const theme = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  // Each state photographed in both themes, back to the light one after.
  const snap = async (name) => {
    if (shots === undefined) return;
    await mkdir(shots, { recursive: true });
    for (const mode of ['light', 'dark']) {
      await theme(mode);
      await sleep(350);
      const { result } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(shots, `${name}-${mode}.png`), Buffer.from(result.data, 'base64'));
    }
    await theme('light');
    await sleep(200);
  };
  // A real key press: keyDown (with its text), keyUp.
  const KEYS = {
    ArrowDown: { code: 'ArrowDown', vk: 40 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13, text: '\r' },
    ' ': { code: 'Space', vk: 32, text: ' ' }, e: { code: 'KeyE', vk: 69, text: 'e' }, p: { code: 'KeyP', vk: 80, text: 'p' }, m: { code: 'KeyM', vk: 77, text: 'm' },
    Backspace: { code: 'Backspace', vk: 8 }, '?': { code: 'Slash', vk: 191, text: '?', modifiers: 8 },
  };
  const press = async (key, modifiers = 0) => {
    const spec = KEYS[key];
    const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk, modifiers: modifiers | (spec.modifiers ?? 0) };
    await send('Input.dispatchKeyEvent', { type: spec.text === undefined ? 'rawKeyDown' : 'keyDown', ...base, ...(spec.text === undefined ? {} : { text: spec.text }) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(250);
  };
  await until('renderer API', () => evaluate('typeof window.decision?.recordTodoList === "function"'));
  const text = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText).join(" | ")`);
  const click = (script) => evaluate(`(async () => { ${script}; await new Promise((r) => setTimeout(r, 400)); return true; })()`);
  const focusKey = () => evaluate('document.activeElement?.getAttribute("data-todo-focus") ?? ""');
  const listItems = async (id) => (await evaluate(`window.decision.listTodoLists({ listId: ${JSON.stringify(id)} })`)).lists[0].items;

  // Data: a long list with P0–P3 and tags, a small target list, an empty 日常.
  const topics = ['把评审意见里提到的命名不一致统一成同一个说法，并检查文档、界面文案和测试里的旧名字是否都已经改掉', '排查发版流程里 changelog 与 VERSION 不同步的原因，写清楚是哪一步漏了', '给设置页的模型选择补上读不到本机模型时的说明，别让用户面对一个空列表', '核对知识页搜索在中文标点和全半角混用时是否还能命中，补一条能复现的测试'];
  const items = Array.from({ length: 60 }, (_, index) => ({
    title: `${topics[index % topics.length]}（第 ${index + 1} 条）`,
    ...(index % 7 < 4 ? { priority: ['p0', 'p1', 'p2', 'p3'][index % 7] } : {}),
    ...(index % 5 === 0 ? { tags: index % 10 === 0 ? ['本周', '设置页'] : ['本周'] } : index % 11 === 0 ? { tags: ['等回复'] } : {}),
    ...(index === 2 ? { detail: '模型列表为空时，现在只显示一个**空的下拉框**。位置：`ModelPicker.tsx`\n\n- 没装 Ollama → 给安装说明\n- 服务没启动 → 给「启动」入口' } : {}),
  }));
  const long = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: '日常整理（长清单）', longTerm: true, items: items.slice(0, 50) })})`);
  await evaluate(`window.decision.recordTodoList(${JSON.stringify({ listId: long.list.id, items: items.slice(50) })})`);
  const target2 = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: 'Paraself 遗留问题调研', project: 'paraself', items: [{ title: '托盘提示没有区分复盘', priority: 'p2' }] })})`);
  const daily = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: '日常' })})`);
  check('the lists are made with P0–P3 and tags', long.status === 'created' && target2.status === 'created' && daily.status === 'created', [long.status, target2.status, daily.status]);
  const first = await listItems(long.list.id);
  check('the items kept their priorities and tags', first[0].priority === 'p0' && first[0].tags.join() === '本周,设置页' && first[1].priority === 'p1' && first[4].priority === null, first.slice(0, 5));
  const note = await readFile((await notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'))).find((path) => path.includes('-')) ?? '', 'utf8').catch(() => '');
  check('the notes hold #tags and the 🔺 mark at the end of the lines', (await Promise.all((await notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'))).map((path) => readFile(path, 'utf8')))).some((content) => /- \[ \] 1\. .+ 🔺 #本周 #设置页/u.test(content)), note.slice(0, 400));

  await click('document.querySelector(\'[aria-label="待办"]\').click()');
  await sleep(1200);
  await click('[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "日常整理（长清单）").click()');
  check('the cards show P0–P3 chips and #tags', /P0/u.test(await text('.todo-chip')) && /P3/u.test(await text('.todo-chip')) && /#本周/u.test(await text('.todo-item-sub')), await text('.todo-chip'));
  check('the left column lists the tags with counts above the lists', /#本周/u.test(await text('nav[aria-label="标签"]')), await text('nav[aria-label="标签"]'));
  await snap('01-long-list');

  // Keyboard, with real key events.
  await click('document.querySelector(".todo-item-toggle").focus()');
  const start = await focusKey();
  await press('ArrowDown');
  const second = await focusKey();
  check('ArrowDown moves the focus to the next item', start !== '' && second !== '' && second !== start, [start, second]);
  await press('ArrowDown', 8);
  check('Shift+ArrowDown extends the pick', /已选 2 项/u.test(await text('.todo-batch-bar')), await text('.todo-batch-bar'));
  await press(' ');
  check('Space on a picked item puts it down', /已选 1 项/u.test(await text('.todo-batch-bar')), await text('.todo-batch-bar'));
  await press(' ');
  check('and picks it again', /已选 2 项/u.test(await text('.todo-batch-bar')), await text('.todo-batch-bar'));
  await snap('05-keyboard-focus');
  const beforeMenu = await focusKey();
  await press('e');
  check('E opens the status menu of the item in focus', (await text('[role="menu"]')).includes('待处理'), await text('[role="menu"]'));
  await press('Escape');
  check('Escape closes the menu and gives focus back to the item', await soon(async () => (await focusKey()) === beforeMenu && (await evaluate('document.querySelector("[role=menu]") === null'))), [beforeMenu, await focusKey()]);
  await press('p');
  check('P opens the priority menu', (await text('[role="menu"]')).includes('P0'), await text('[role="menu"]'));
  await press('ArrowDown');
  await press('Enter');
  await sleep(500);
  const afterP = await listItems(long.list.id);
  check('arrows and Enter in the priority menu write the priority', afterP.some((item, index) => item.priority !== first[index].priority), afterP.slice(0, 4).map((i) => i.priority));
  await press('?');
  check('? opens the keyboard cheat sheet, with the todo keys in it', (await text('[role="dialog"]')).includes('待办事项列表') && (await text('[role="dialog"]')).includes('弹出优先级菜单'), await text('[role="dialog"]'));
  console.log('ACTIVE', await evaluate('document.activeElement?.outerHTML.slice(0, 160)'));
  await press('Escape');
  check('Escape closes the key list', await soon(() => evaluate('document.querySelector("[role=dialog]") === null')), await text('[role="dialog"]'));

  // Move two picked items to another list.
  await press(' ');
  await press('ArrowDown');
  await press(' ');
  await press('m');
  check('M opens the move picker for the picked items', /把 \d+ 项移到/u.test(await text('[role="dialog"]')), await text('[role="dialog"]'));
  await snap('02-move-dialog');
  await evaluate('(() => { const input = document.querySelector("[role=dialog] input[type=search]"); input.focus(); })()');
  for (const letter of 'Paraself') {
    await send('Input.dispatchKeyEvent', { type: 'char', text: letter });
  }
  await sleep(300);
  const moveBefore = (await listItems(target2.list.id)).length;
  await press('Enter');
  await sleep(900);
  const afterMove = await listItems(target2.list.id);
  check('Enter in the picker moves the items: new in the target, with their fields', afterMove.length > moveBefore && afterMove.at(-1).title.includes('第') && afterMove.at(-1).number > 1, afterMove.map((i) => [i.number, i.title.slice(0, 12)]));
  const sourceAfter = await listItems(long.list.id);
  check('and gone from the source', sourceAfter.length === 60 - (afterMove.length - moveBefore), sourceAfter.length);
  check('the move is said in one line', /已移到「Paraself 遗留问题调研」\d 项/u.test(await text('.todo-message')), await text('.todo-message'));
  const moved = (await Promise.all((await notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'))).map((path) => readFile(path, 'utf8')))).find((content) => content.includes('title: Paraself 遗留问题调研') || content.includes('# Paraself 遗留问题调研')) ?? '';
  check('the target note holds the moved lines', /- \[[ x/-]\] 2\. .+（第 \d+ 条）/u.test(moved), moved.slice(-400));
  const history = JSON.parse(await readFile(join(env.PARASELF_USER_DATA, 'todo-history', (await readdir(join(env.PARASELF_USER_DATA, 'todo-history'))).find((name) => true) ?? ''), 'utf8').catch(() => '{}'));
  check('(setup) the history folder is there', history !== null, history);

  // The tag view.
  await click('document.querySelector(\'[data-view="tag"][data-tag="本周"]\').click()');
  check('a tag opens as a view across the lists', /#本周/u.test(await text('.todo-detail h2')) && (await text('.todo-item-title')).length > 0, await text('.todo-detail h2'));
  await snap('03-tag-view');

  // Quick add.
  await click('[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "添加事项").click()');
  await evaluate('document.querySelector("[role=dialog] input")?.focus()');
  for (const character of '复盘本周的本地审阅 PR 明天 !p0 @日常 #本周') await send('Input.dispatchKeyEvent', { type: 'char', text: character });
  await sleep(600);
  const chips = await text('.todo-quick-add-chip');
  check('quick add reads 截止, 优先级, 清单 and 标签 into chips', /截止/u.test(chips) && /优先级/u.test(chips) && /P0/u.test(chips) && /清单/u.test(chips) && /标签/u.test(chips), chips);
  await snap('04-quick-add');
  await press('Enter', 4);
  await sleep(300);
  await click('[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "添加")?.click()');
  await sleep(800);
  const dailyItems = await listItems(daily.list.id);
  check('the item lands in 日常 with its P0, due date and tag', dailyItems.length === 1 && dailyItems[0].priority === 'p0' && dailyItems[0].tags.join() === '本周' && dailyItems[0].due !== null && dailyItems[0].title === '复盘本周的本地审阅 PR', dailyItems);

  // The drawer: 560px wide, Markdown, tags, history.
  await click('[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "日常整理（长清单）").click()');
  await click('[...document.querySelectorAll(".todo-item-toggle")].find((b) => b.innerText.includes("第 3 条")).click()');
  await sleep(500);
  const width = await evaluate('Math.round(document.querySelector(".todo-drawer").getBoundingClientRect().width)');
  check('the drawer is 560px wide by default', width === 560, width);
  check('the detail is shown as Markdown (bold, code, a list)', await evaluate('(() => { const m = document.querySelector(".todo-drawer .todo-markdown"); return m !== null && m.querySelector("strong") !== null && m.querySelector("code") !== null && m.querySelectorAll("li").length === 2; })()'), await text('.todo-drawer .todo-markdown'));
  await snap('06-drawer');

  // An agent through the real bridge: tags and P0.
  mcp = await connectMcp({ env, bridge });
  const made = await mcp.call('record_todo_list', { listId: daily.list.id, items: [{ title: 'agent 写的事项', priority: 'p0', tags: ['agent', '本周'] }] });
  check('the bridge takes p0 and tags', made.result?.isError !== true, made.result?.content?.[0]?.text);
  const viaBridge = (await listItems(daily.list.id)).find((item) => item.title === 'agent 写的事项');
  check('and the App keeps them', viaBridge?.priority === 'p0' && viaBridge.tags.join() === 'agent,本周', viaBridge);
  const old = await mcp.call('update_todo_item', { listId: daily.list.id, item: viaBridge.number, priority: 'high' });
  check('the old word high is still taken (as P1)', old.result?.isError !== true && (await listItems(daily.list.id)).find((item) => item.number === viaBridge.number).priority === 'p1', old.result?.content?.[0]?.text);
} finally {
  try { mcp?.close(); } catch { /* closed */ }
  try { socket?.close(); } catch { /* closed */ }
  child.kill('SIGTERM');
  await sleep(1500);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'todo-v4-run', label, 'result', { build, checks, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 ? 0 : 1;
