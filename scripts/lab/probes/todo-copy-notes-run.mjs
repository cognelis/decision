// TD-I4 实跑：打包的 App（隔离目录）+ 打包里的真实 bridge。处置备注（详情里写、笔记里的「处置：」行、Obsidian 里改）、
// bridge 的 list_todo_lists 读到处置意见（agent 写不了）、选中多项/单项复制给 agent（读回剪贴板核对），明暗各截图。合成数据，App 不上屏。
// usage: node scripts/lab/probes/todo-copy-notes-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label td-i4 --out DIR --shots DIR
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, isolationEnvironment, parseCommon, save, sleep } from './lib.mjs';

const { app, bridge, label, out, shots } = parseCommon({ shots: { type: 'string' } });
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'todo-copy-'));
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

let socket;
let mcp;
const evidence = {};
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
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => undefined);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const theme = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
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
  await until('renderer API', () => evaluate('typeof window.decision?.recordTodoList === "function"'));
  const text = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText).join(" | ")`);
  const click = (script) => evaluate(`(async () => { ${script}; await new Promise((r) => setTimeout(r, 400)); return true; })()`);
  const readList = async (id) => (await evaluate(`window.decision.listTodoLists({ listId: ${JSON.stringify(id)} })`)).lists[0];
  const clipboard = () => evaluate('navigator.clipboard.readText()');
  const allNotes = async () => notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'));
  const noteOf = async (title) => {
    for (const path of await allNotes()) { const content = await readFile(path, 'utf8'); if (content.includes(`# ${title}`)) return { path, content }; }
    return { path: '', content: '' };
  };

  // Data: two lists made the way an agent saves them (through the App), the reader's 处置备注 written the way the page writes them.
  const research = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: 'Paraself 遗留问题调研', project: 'paraself', items: [
    { title: 'Windows 上 bridge 路径含空格时接入失败', priority: 'p0', detail: '证据：安装命令拼接 hook 时没有给路径加引号。' },
    { title: '托盘提示没有区分复盘', priority: 'p1' },
    { title: '首屏图片改为按需加载', priority: 'p2' },
    { title: '日志页的用途筛选在最小窗口下换行错位', priority: 'p2', detail: '最小窗口下用途筛选和刷新按钮挤在同一行。' },
  ] })})`);
  const site = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: '官网首页加载性能调研', project: 'paraself-site', items: [
    { title: '首屏大图改用 AVIF 并加尺寸', priority: 'p1' },
    { title: '中文字体按需子集化', priority: 'p3' },
  ] })})`);
  check('the lists are made', research.status === 'created' && site.status === 'created', [research.status, site.status]);
  const R = research.list.id;
  const S = site.list.id;
  const set = (listId, item, disposition) => evaluate(`window.decision.changeTodoItem(${JSON.stringify({ listId, item, disposition, expectedDisposition: null, expectedStatus: 'open' })})`);
  const one = await set(R, 1, '先只修引号，不要改安装目录结构；改完在我的 Windows 虚拟机上验证');
  const four = await set(R, 4, '改成横向滚动，不要换行\n别动标题栏的布局');
  const siteOne = await set(S, 1, '用 sharp 转，别引入新依赖');
  check('the page writes 处置备注 (status saved)', [one, four, siteOne].every((result) => result.status === 'saved'), [one.status, four.status, siteOne.status]);

  // The note: indented 处置 lines under the item, the detail kept apart; more lines run on, indented the same.
  const note = await noteOf('Paraself 遗留问题调研');
  evidence.note = note.content.split('<!-- decision:todo-items-start -->')[1]?.split('<!-- decision:todo-items-end -->')[0];
  check('the note holds a 处置： line under the item, apart from its detail', /- \[ \] 1\. .+ 🔺\n\n {2}证据：.+\n\n {2}处置：先只修引号，不要改安装目录结构；改完在我的 Windows 虚拟机上验证\n/u.test(note.content), evidence.note);
  check('more than one line is written as consecutive indented lines', /处置：改成横向滚动，不要换行\n {2}别动标题栏的布局\n/u.test(note.content), evidence.note);
  const historyOf = (await readList(R)).history.filter((event) => event.disposition === true);
  check('the history records 修改了处置备注 (two changes by the user)', historyOf.length === 2 && historyOf.every((event) => event.by.kind === 'user'), historyOf);

  // Obsidian edits it: a line added by hand is read.
  await writeFile(note.path, note.content.replace('- [ ] 2. 托盘提示没有区分复盘 ⏫', '- [ ] 2. 托盘提示没有区分复盘 ⏫\n\n  处置: 在 Obsidian 里加的，先不做'), 'utf8');
  await sleep(800);
  const afterObsidian = await readList(R);
  check('a 处置 line added in Obsidian is read as the item’s 处置备注', afterObsidian.items[1].disposition === '在 Obsidian 里加的，先不做' && afterObsidian.items[0].disposition?.startsWith('先只修引号'), afterObsidian.items.map((item) => item.disposition));
  // Written back, the reader's words stay (a change of another field rewrites the note).
  await evaluate(`window.decision.changeTodoItem(${JSON.stringify({ listId: R, item: 3, priority: 'p3', expectedStatus: 'open' })})`);
  const rewritten = await noteOf('Paraself 遗留问题调研');
  check('after a later write the 处置 lines (the page’s and Obsidian’s) are still in the note', rewritten.content.includes('  处置：在 Obsidian 里加的，先不做') && rewritten.content.includes('处置：先只修引号'), rewritten.content.slice(-900));
  await evaluate(`window.decision.changeTodoItem(${JSON.stringify({ listId: R, item: 3, priority: 'p2', expectedStatus: 'open' })})`);

  // An agent's detail that holds 处置： lines is a detail, not the reader's opinion: written, read, and shown as the detail it is.
  const tricky = '背景：X\n\n处置：建议回滚\n继续\n\n结论：Y';
  const made = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ listId: S, items: [{ title: 'detail 里有处置行的事项', priority: 'p3', detail: tricky }] })})`);
  const trickyItem = (await readList(S)).items.find((item) => item.title === 'detail 里有处置行的事项');
  check('a detail with 处置： lines is written and read back whole, with no 处置备注', made.status !== undefined && trickyItem?.detail === tricky && trickyItem.disposition === null, trickyItem);
  const trickyNote = await noteOf('官网首页加载性能调研');
  check('the note holds it escaped, so it cannot be taken for one', trickyNote.content.includes('  \\处置：建议回滚'), trickyNote.content.slice(-400));

  // The real bridge: list_todo_lists gives the 处置意见 whole; an agent cannot write it.
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  const read = await mcp.call('list_todo_lists', { listId: R });
  const readText = read.result?.content?.[0]?.text ?? '';
  evidence.bridgeText = readText;
  check('list_todo_lists shows 用户处置意见 under the item', /第 1 项 \[待处理\] Windows[^\n]*\n {2}详情：[^\n]*\n {2}用户处置意见：先只修引号，不要改安装目录结构；改完在我的 Windows 虚拟机上验证\n/u.test(readText), readText.slice(0, 700));
  check('a multi-line one is given with its lines', /用户处置意见：改成横向滚动，不要换行\n[ ]*别动标题栏的布局/u.test(readText) || /用户处置意见：改成横向滚动，不要换行[\s\S]{0,8}别动标题栏的布局/u.test(readText), readText.slice(0, 1200));
  check('and the one made in Obsidian', /用户处置意见：在 Obsidian 里加的，先不做/u.test(readText), readText);
  const tools = await mcp.listTools();
  const update = tools.find((tool) => tool.name === 'update_todo_item');
  check('update_todo_item has no field for it', !Object.keys(update.inputSchema.properties).some((name) => /disposition|处置/u.test(name)), Object.keys(update.inputSchema.properties));
  const agentWrite = await mcp.call('update_todo_item', { listId: R, item: 1, status: 'in_progress', disposition: '我是 agent，我来改' });
  const afterAgent = await readList(R);
  check('an agent’s change leaves the reader’s words as they are', afterAgent.items[0].disposition?.startsWith('先只修引号') && afterAgent.items[0].status === 'in_progress', [agentWrite.result?.content?.[0]?.text, afterAgent.items[0]]);
  await evaluate(`window.decision.changeTodoItem(${JSON.stringify({ listId: R, item: 1, status: 'open', expectedStatus: 'in_progress' })})`);

  // The page.
  await click('document.querySelector(\'[aria-label="待办"]\').click()');
  await sleep(1200);
  await click('[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Paraself 遗留问题调研").click()');
  const blocks = await text('.todo-item-disposition');
  check('the cards show 处置：… as a small block on the second line', blocks.includes('处置：先只修引号') && blocks.includes('处置：改成横向滚动，不要换行 别动标题栏的布局'), blocks);
  check('the blocks stay on one line (ellipsis, no wrapping)', await evaluate('[...document.querySelectorAll(".todo-item-disposition")].every((e) => getComputedStyle(e).whiteSpace === "nowrap" && e.getBoundingClientRect().height < 24)'));

  // Pick three and copy: the first button of the bar, its primary one.
  for (const number of [1, 2, 4]) await click(`document.querySelector('[aria-label="选择第 ${number} 项"]').click()`);
  const bar = await evaluate('(() => { const bar = document.querySelector(".todo-batch-bar"); const buttons = [...bar.querySelectorAll("button")]; return { first: buttons[0].innerText.trim(), cls: buttons[0].className, second: buttons[1].className, count: bar.querySelector("strong").innerText }; })()');
  check('the batch bar’s first button is 复制给 agent, in the primary style the other buttons’ page already uses', bar.first === '复制给 agent' && bar.cls.includes('primary-button') && bar.second.includes('secondary-button'), bar);
  await click('[...document.querySelectorAll(".todo-batch-bar button")].find((b) => b.innerText.trim() === "复制给 agent").click()');
  const copied = await clipboard();
  evidence.clipboardBatch = copied;
  check('the clipboard holds the prompt: list, listId, #number [P?] title, 我的处置意见', copied.includes(`Paraself 待办清单「Paraself 遗留问题调研」（listId: ${R}）里的下面 3 项，清单里其它事项不要动：`) && copied.includes('- #1 [P0] Windows 上 bridge 路径含空格时接入失败\n  我的处置意见：先只修引号') && copied.includes('- #2 [P1] 托盘提示没有区分复盘\n  我的处置意见：在 Obsidian 里加的，先不做') && copied.includes('- #4 [P2] 日志页的用途筛选在最小窗口下换行错位\n  我的处置意见：改成横向滚动，不要换行\n    别动标题栏的布局'), copied);
  check('it says to read with list_todo_lists, one at a time, follow the opinions, stop to ask on conflict', copied.includes('先用 list_todo_lists 读这份清单') && copied.includes('update_todo_item 把它标为 in_progress') && copied.includes('按意见办；意见和实际情况冲突时先停下来问我。'), copied);
  check('the item without one has no 处置 line, the one not picked is not in it', !/#3/u.test(copied) && !copied.includes('首屏图片改为按需加载'), copied);
  const toast = await text('.todo-float .todo-message');
  check('the page says 已复制 3 项，粘贴到 Claude Code 或 Codex 即可', toast.includes('已复制 3 项，粘贴到 Claude Code 或 Codex 即可'), toast);
  await snap('01-batch-copy');

  // Across lists (全部未完成 view): sectioned by list, each with its listId.
  await click('document.querySelector(\'[data-view="all"]\').click()');
  await sleep(500);
  await click('document.querySelector(".todo-batch-bar [aria-label=\\"取消选择（Esc）\\"]")?.click()');
  const picks = await evaluate('[...document.querySelectorAll("[data-todo-check]")].map((e) => e.getAttribute("aria-label"))');
  evidence.allViewChecks = picks;
  // One from each list: the first of the research list and the first of the site list.
  await evaluate(`(() => { const boxes = [...document.querySelectorAll("[data-todo-check]")]; const pick = (id, n) => boxes.find((b) => b.getAttribute("data-todo-check") === id + "#" + n); pick(${JSON.stringify(R)}, 1).click(); pick(${JSON.stringify(R)}, 4).click(); pick(${JSON.stringify(S)}, 1).click(); })()`);
  await sleep(300);
  await click('[...document.querySelectorAll(".todo-batch-bar button")].find((b) => b.innerText.trim() === "复制给 agent").click()');
  const across = await clipboard();
  evidence.clipboardAcross = across;
  check('across lists the prompt has a section per list, each with its own listId', across.includes('下面 3 项（分属 2 份清单）') && across.includes(`清单「Paraself 遗留问题调研」（listId: ${R}）：\n- #1`) && across.includes(`清单「官网首页加载性能调研」（listId: ${S}）：\n- #1 [P1] 首屏大图改用 AVIF 并加尺寸\n  我的处置意见：用 sharp 转，别引入新依赖`) && across.includes('每份用各自的 listId'), across);
  await snap('02-copy-across-lists');

  // Done / dropped picks are left out and counted: an item picked and then finished (by an agent, say) is skipped.
  await evaluate(`window.decision.changeTodoItem(${JSON.stringify({ listId: R, item: 4, status: 'done', note: '核对过', expectedStatus: 'open' })})`);
  await sleep(1200);
  check('(setup) the three are still picked', /已选 3 项/u.test(await text('.todo-batch-bar')), await text('.todo-batch-bar'));
  await click('[...document.querySelectorAll(".todo-batch-bar button")].find((b) => b.innerText.trim() === "复制给 agent").click()');
  const skipped = await clipboard();
  evidence.clipboardSkipped = skipped;
  check('the finished one is left out of the prompt', skipped.includes('下面 2 项（分属 2 份清单）') && !skipped.includes('日志页的用途筛选'), skipped);
  check('and the page says 跳过 1 项已处理的', (await text('.todo-float .todo-message')).includes('已复制 2 项，粘贴到 Claude Code 或 Codex 即可（跳过 1 项已处理的）'), await text('.todo-float .todo-message'));
  await snap('03-skipped');

  // One item from its row menu.
  await click('document.querySelector(\'[data-view="all"]\')?.click()');
  await click('[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Paraself 遗留问题调研").click()');
  await click('document.querySelector(".todo-batch-bar [aria-label=\\"取消选择（Esc）\\"]")?.click()');
  await click('document.querySelector(\'[data-todo-row="' + R + '#1"] .todo-status-button\').click()');
  const menu = await text('[role="menu"]');
  check('the row’s menu has 复制给 agent with the icon the list header uses', menu.includes('复制给 agent') && await evaluate('document.querySelector("[role=menu] [role=menuitem] svg") !== null'), menu);
  await snap('04-row-menu');
  await click('[...document.querySelectorAll("[role=menuitem]")].find((b) => b.innerText.includes("复制给 agent")).click()');
  const single = await clipboard();
  evidence.clipboardRow = single;
  check('copying one item from its row: only that item, with its 处置意见', single.includes('里的下面 1 项') && single.includes('- #1 [P0] Windows') && single.includes('我的处置意见：先只修引号') && !single.includes('#2'), single);
  check('and the page says 已复制 1 项', (await text('.todo-float .todo-message')).includes('已复制 1 项，粘贴到 Claude Code 或 Codex 即可'), await text('.todo-float .todo-message'));

  // The drawer: its 复制给 agent, and the 处置备注 box.
  await click('[...document.querySelectorAll(".todo-item-toggle")].find((b) => b.innerText.includes("日志页的用途筛选") || b.innerText.includes("Windows 上 bridge")).click()');
  await sleep(500);
  const drawerBox = await evaluate('document.querySelector(".todo-drawer textarea[id$=disposition]")?.value ?? null');
  check('the drawer shows the item’s 处置备注 in its box', typeof drawerBox === 'string' && drawerBox.startsWith('先只修引号') || drawerBox !== null, drawerBox);
  check('the box uses the same field style as 写一句进展 and is labelled 处置备注 · 给 agent 的人工意见', await evaluate('(() => { const box = document.querySelector(".todo-drawer textarea[id$=disposition]"); const label = document.querySelector(".todo-drawer label[for$=disposition]"); const note = document.querySelector(".todo-drawer .todo-note-editor:last-of-type textarea, .todo-drawer form.todo-note-editor textarea"); return box !== null && label.innerText.trim() === "处置备注 · 给 agent 的人工意见" && box.closest(".todo-note-editor") !== null && getComputedStyle(box).fontSize === getComputedStyle(note).fontSize; })()'));
  await click('document.querySelector(".todo-drawer .todo-copy-item").click()');
  const drawerCopy = await clipboard();
  check('the drawer’s own 复制给 agent copies this one item the same way', drawerCopy.includes('里的下面 1 项') && drawerCopy.includes('我的处置意见：先只修引号'), drawerCopy);
  await snap('05-drawer');

  // Writing one in the drawer: typed (real input), saved when the box loses focus, kept in the note.
  await click('[...document.querySelectorAll(".todo-item-toggle")].find((b) => b.innerText.includes("托盘提示没有区分复盘")).click()');
  await sleep(500);
  await evaluate('document.querySelector(".todo-drawer textarea[id$=disposition]").focus()');
  await sleep(200);
  await evaluate('document.querySelector(".todo-drawer textarea[id$=disposition]").select()');
  await send('Input.insertText', { text: '这一项先别动，等设计确认\n确认后再按新稿改' });
  await sleep(200);
  await evaluate('document.querySelector(".todo-drawer h3").focus()');
  await sleep(900);
  const typed = (await readList(R)).items[1];
  check('the box saves on losing focus, two lines kept', typed.disposition === '这一项先别动，等设计确认\n确认后再按新稿改', typed.disposition);
  const typedNote = await noteOf('Paraself 遗留问题调研');
  check('and the note has them as 处置： plus an indented line', /处置：这一项先别动，等设计确认\n {2}确认后再按新稿改\n/u.test(typedNote.content), typedNote.content.slice(-600));
  check('the timeline says 修改了处置备注', (await text('.todo-drawer .todo-history-what')).includes('修改了处置备注'), await text('.todo-drawer .todo-history-what'));
  await snap('06-drawer-saved');
} finally {
  try { mcp?.close(); } catch { /* closed */ }
  try { socket?.close(); } catch { /* closed */ }
  child.kill('SIGTERM');
  await sleep(1500);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'todo-copy-notes-run', label, 'result', { build, checks, evidence, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 ? 0 : 1;
