// TD-B1: an agent (through the real bridge's MCP tools) or Obsidian changes todos while the 待办 page is open: does the
// page follow? Packaged App in an isolated root, hidden; synthetic data only.
// usage: node scripts/lab/probes/todo-refresh-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label main --out DIR [--shots DIR]
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, isolationEnvironment, parseCommon, save, sleep } from './lib.mjs';

const { app, bridge, label, out } = parseCommon({ shots: { type: 'string' } });
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'todo-refresh-'));
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
  const send = async (method, params) => {
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
  const shot = async (name) => {
    if (shotsDir === null) return;
    await mkdir(shotsDir, { recursive: true });
    const { result } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(shotsDir, name), Buffer.from(result.data, 'base64'));
  };
  await until('renderer API', () => evaluate('typeof window.decision?.recordTodoList === "function"'));

  const text = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText).join(" | ")`);
  const click = (script) => evaluate(`(async () => { ${script}; await new Promise((r) => setTimeout(r, 400)); return true; })()`);
  const toolText = (answer) => answer.result?.content?.[0]?.text ?? JSON.stringify(answer);

  // The page: a list made from the page itself, opened.
  const base = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: '合成：页面里的清单', items: [{ title: '页面里的第一项' }, { title: '页面里的第二项' }] })})`);
  await click('document.querySelector(\'[aria-label="待办"]\').click()');
  await sleep(1200);
  await click('[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "合成：页面里的清单").click()');
  check('the page shows the list it opened', (await text('.todo-item-title')).includes('页面里的第一项'), await text('.todo-item-title'));
  await click('document.querySelector(".todo-item-toggle").click()');
  await sleep(500);
  check('the drawer of item 1 is open', (await text('.todo-drawer h3')).includes('页面里的第一项'));
  await shot('01-before.png');

  mcp = await connectMcp({ env, bridge });

  // 1. The agent makes a new list.
  const made = await mcp.call('record_todo_list', { title: '合成：agent 新建的清单', project: 'lab', items: [{ title: 'agent 写的事项甲' }, { title: 'agent 写的事项乙' }] });
  const madeText = toolText(made);
  const listId = /清单编号 ([^，）\s]+)/u.exec(madeText)?.[1];
  check('the bridge saved a list', made.result?.isError !== true && listId !== undefined, madeText);
  const leftLists = () => text('.todo-lists .todo-list-row');
  check('a list an agent made appears in the left column', await soon(async () => (await leftLists()).includes('agent 新建的清单')), await leftLists());

  // 2. The agent adds items to the list the page has open.
  const open = base.list.id;
  const appended = await mcp.call('record_todo_list', { listId: open, items: [{ title: 'agent 追加到页面清单的一项' }] });
  check('the bridge appended an item', appended.result?.isError !== true, toolText(appended));
  check('an item an agent added to the open list appears in it', await soon(async () => (await text('.todo-item-title')).includes('agent 追加到页面清单的一项')), await text('.todo-item-title'));

  // 3. Status change of the item whose drawer is open.
  const started = await mcp.call('update_todo_item', { listId: open, item: 1, status: 'in_progress' });
  check('the bridge moved item 1 to in_progress', started.result?.isError !== true, toolText(started));
  check('the open row shows 处理中', await soon(async () => /处理中/u.test(await text('.todo-item[data-status="in_progress"] .todo-status-button'))), await text('.todo-item .todo-status-button'));
  check('the left column count follows (处理中 1)', await soon(async () => /处理中 1/u.test(await leftLists())), await leftLists());
  await shot('02-in-progress.png');

  // 4. A note of progress, with the drawer open.
  const noted = await mcp.call('update_todo_item', { listId: open, item: 1, note: 'agent 写的进展：已定位到原因' });
  check('the bridge wrote a progress note', noted.result?.isError !== true, toolText(noted));
  check('the open drawer shows the note', await soon(async () => (await text('.todo-drawer')).includes('agent 写的进展：已定位到原因')), await text('.todo-drawer'));

  // 5. Done, then the 今天 view counts.
  const done = await mcp.call('update_todo_item', { listId: open, item: 2, status: 'done', note: '已核实' });
  check('the bridge finished item 2', done.result?.isError !== true, toolText(done));
  check('the list shows it handled (已处理 1/3)', await soon(async () => /已处理 1\/3/u.test(await text('.todo-detail-counts'))), await text('.todo-detail-counts'));

  // 5b. The 今天 view (the page's first view): an item an agent starts joins it, a due date puts one in 已逾期/今天到期.
  await click('document.querySelector(\'[data-view="today"]\').click()');
  const todayCount = () => text('[data-view="today"] .todo-view-count');
  const before = await todayCount();
  const third = await mcp.call('update_todo_item', { listId: open, item: 3, status: 'in_progress' });
  check('the bridge started item 3', third.result?.isError !== true, toolText(third));
  check('今天 shows it under 处理中 and the view count moves', await soon(async () => (await text('.todo-item-title')).includes('agent 追加到页面清单的一项') && (await todayCount()) !== before), [before, await todayCount(), await text('.todo-item-title')]);
  const dated = await mcp.call('update_todo_item', { listId: open, item: 3, due: '2020-01-01', priority: 'high' });
  check('the bridge gave item 3 an old due date and high priority', dated.result?.isError !== true, toolText(dated));
  check('今天 shows it as 已逾期 with 高', await soon(async () => /已逾期/u.test(await text('.todo-group-title')) && /高/u.test(await text('.todo-item .todo-chip'))), [await text('.todo-group-title'), await text('.todo-item .todo-chip')]);
  await shot('02b-today.png');
  await click('[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "合成：页面里的清单").click()');

  // 6. Obsidian: the note edited on disk.
  const file = (await notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'))).find((path) => path.includes('页面里的清单') || path.includes('-'));
  const all = await notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'));
  let edited = false;
  for (const path of all) {
    const content = await readFile(path, 'utf8');
    if (content.includes('页面里的第一项')) {
      await writeFile(path, content.replace('页面里的第一项', '页面里的第一项（在 Obsidian 里改过）'), 'utf8');
      edited = true;
    }
  }
  check('(setup) the note was edited on disk', edited && file !== undefined, all);
  check('a title edited in Obsidian appears on the page', await soon(async () => (await text('.todo-item-title')).includes('在 Obsidian 里改过'), 8000), await text('.todo-item-title'));
  await shot('03-obsidian.png');
} finally {
  try { mcp?.close(); } catch { /* closed */ }
  try { socket?.close(); } catch { /* closed */ }
  child.kill('SIGTERM');
  await sleep(1500);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'todo-refresh-run', label, 'result', { build, checks, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 ? 0 : 1;
