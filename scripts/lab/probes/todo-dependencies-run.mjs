// Packaged App + bridge dependency checks, entirely inside isolated-app.mjs's temporary vault.
// node scripts/lab/probes/todo-dependencies-run.mjs --app <app> --bridge <bridge> --label dependencies --out <evidence directory>
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIsolatedApp, connectMcp } from '../isolated-app.mjs';
import { parseCommon, executableOf } from './lib.mjs';

const { app, bridge, out } = parseCommon();
const root = await mkdtemp(join(tmpdir(), 'paraself-dependencies-'));
const port = 9400 + Math.floor(Math.random() * 500);
const checks = [];
const waitFor = async (probe, label, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} timed out`);
};
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`ok ${name}`); };
let running, mcp, socket;
let failure;
try {
  running = await startIsolatedApp({ root, executable: executableOf(app), debugPort: port });
  mcp = await connectMcp({ env: running.env, bridge });
  const call = async (name, args, allowError = false) => {
    const response = await mcp.call(name, args);
    assert.equal(response.error, undefined);
    if (!allowError) assert.notEqual(response.result?.isError, true, JSON.stringify(response.result));
    return response.result.structuredContent;
  };
  const tools = await mcp.listTools();
  check('MCP exposes incremental dependency changes and expectedStatus', tools.find(t => t.name === 'update_todo_item')?.inputSchema.properties.addDependencies !== undefined && tools.find(t => t.name === 'update_todo_item')?.inputSchema.properties.expectedStatus !== undefined);
  const created = await call('record_todo_list', { title: '依赖验证 · 发布', items: [{ title: '发布版本', priority: 'p1' }, { title: '通知验收', priority: 'p2' }] });
  const before = await call('record_todo_list', { title: '依赖验证 · 准备', items: [{ title: '完成签名', priority: 'p1' }, { title: '确认配置', priority: 'p2' }, { title: '独立事项', priority: 'p3' }, { title: '已完成准备', priority: 'p3' }, { title: '舍弃的方案', priority: 'p3' }] });
  const a = created.todoRecord.list.id, b = before.todoRecord.list.id;
  const update = (listId, item, changes, allowError = false) => call('update_todo_item', { listId, item, ...changes }, allowError);
  await update(b, 4, { status: 'done', note: '隔离验证：预置已完成事项，检查进度完成段配色' });
  await update(b, 5, { status: 'dropped', note: '隔离验证：预置放弃事项，检查进度分段区分' });
  let changed = await update(a, 1, { addDependencies: [{ listId: b, item: 1 }], expectedStatus: 'open' });
  check('cross-list prerequisite is persisted and unresolved', changed.itemUpdate.item.unmetPrerequisites.length === 1);
  check('self dependency is refused', (await update(a, 1, { addDependencies: [{ listId: a, item: 1 }] }, true)).itemUpdate.status === 'dependency_cycle');
  check('reverse edge is refused', (await update(b, 1, { addDependencies: [{ listId: a, item: 1 }] }, true)).itemUpdate.status === 'dependency_cycle');
  await update(b, 1, { status: 'dropped', note: '隔离验证：放弃前置并不满足依赖' });
  const read = async id => (await call('list_todo_lists', { listId: id })).lists[0];
  check('dropped prerequisite remains unmet', (await read(a)).items[0].unmetPrerequisites[0].status === 'dropped');
  await update(b, 1, { status: 'done', note: '隔离验证：测试前置已完成', expectedStatus: 'dropped' });
  check('completion satisfies prerequisite without starting dependent', (await read(a)).items[0].unmetPrerequisites.length === 0 && (await read(a)).items[0].status === 'open');
  check('stale expectedStatus is refused', (await update(a, 1, { status: 'in_progress', expectedStatus: 'done' }, true)).itemUpdate.status === 'status_changed');

  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'), 'renderer', 20_000);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = message => { const response = JSON.parse(message.data); pending.get(response.id)?.(response); pending.delete(response.id); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
    pending.set(id, response => { clearTimeout(timeout); response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const ipc = (method, input) => evaluate(`window.decision.${method}(${JSON.stringify(input)})`);
  await waitFor(() => evaluate('typeof window.decision?.listTodoLists === "function"'), 'renderer API');
  await evaluate('document.querySelector(\'[aria-label="待办"]\').click()');
  const click = async text => waitFor(() => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => !b.closest('[hidden]') && (b.textContent.trim().startsWith(${JSON.stringify(text)}) || b.getAttribute('aria-label')?.includes(${JSON.stringify(text)}))); if (!b) return false; b.click(); return true; })()`), `click ${text}`, 10_000);
  await click('依赖验证 · 发布');
  await click('第 1 项：发布版本');
  await waitFor(() => evaluate('document.querySelector(".todo-dependency-list")?.textContent.includes("完成签名")'), 'prerequisite drawer');
  check('renderer displays the completed cross-list prerequisite', await evaluate('document.querySelector(".todo-dependencies").textContent.includes("前置已完成")'));
  await click('添加前置');
  await waitFor(() => evaluate('document.querySelector("[role=listbox]")?.textContent.includes("确认配置")'), 'picker');
  check('picker includes already completed prerequisite and disabled reasons', await evaluate('document.querySelector("[role=listbox]").textContent.includes("已有关联") && document.querySelector("[role=listbox]").textContent.includes("不能依赖自己")'));
  check('picker status glyphs fit their rows', await evaluate('[...document.querySelectorAll("[role=option] .todo-status-glyph")].every(e => e.getBoundingClientRect().width <= 18 && e.getBoundingClientRect().height <= 18)'));
  await mkdir(out, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(out, 'todo-dependencies-picker.png'), Buffer.from(shot.data, 'base64'));
  await evaluate('[...document.querySelectorAll("[role=option]")].find(e=>e.textContent.includes("确认配置")).click()');
  await waitFor(async () => (await read(a)).items[0].prerequisites.length === 2, 'UI add persisted');
  await click('确认配置');
  await waitFor(() => evaluate('document.querySelector(".todo-drawer h3")?.textContent === "确认配置"'), 'cross-list jump');
  check('title link opens the item in another list', true);

  await update(b, 1, { status: 'open', expectedStatus: 'done' });
  await update(a, 2, { addDependencies: [{ listId: b, item: 1 }, { listId: b, item: 2 }], expectedStatus: 'open' });
  const waitingCount = () => evaluate(`document.querySelector('[data-list-id="${b}"]')?.getAttribute('data-waiting') ?? null`);
  await waitFor(async () => await waitingCount() === '2', 'deduplicated list marker');
  check('list marker deduplicates two prerequisites shared by two dependents', await evaluate(`document.querySelector('[data-list-id="${b}"]').title.includes('后续 2 项等待')`));
  check('maximum list progress fits without a trailing badge slot', await evaluate(`(() => {
    const row = document.querySelector('[data-list-id="${b}"]');
    const count = row.querySelector('.todo-progress-count');
    const saved = count.innerHTML;
    count.textContent = '200/200';
    const fits = count.scrollWidth <= count.clientWidth && !row.querySelector('.todo-list-wait-slot,.todo-list-wait-mark');
    count.innerHTML = saved;
    return fits;
  })()`));
  const geometry = () => evaluate(`(() => {
    const row = document.querySelector('[data-list-id="${b}"]');
    const r = row.getBoundingClientRect();
    const p = row.querySelector('.todo-list-progress').getBoundingClientRect();
    const bar = row.querySelector('.todo-progress-bar').getBoundingClientRect();
    const title = row.querySelector('.todo-list-title strong').getBoundingClientRect();
    return { rowHeight: r.height, progressHeight: p.height, barHeight: bar.height, barTop: bar.y-r.y, barLeft: bar.x-r.x, barWidth: bar.width, titleLeft: title.x-r.x, overflow: row.scrollWidth > row.clientWidth };
  })()`);
  for (const theme of ['light', 'dark']) for (const width of [180, 248, 393]) {
    await evaluate(`document.documentElement.dataset.previewTheme = '${theme}'; document.documentElement.style.setProperty('--accent', '${theme === 'light' ? '#8b2fc9' : '#cf9cff'}'); document.querySelector('.todo-workspace').style.setProperty('--list-width', '${width}px')`);
    const withMarker = await geometry();
    check(`${theme} ${width}px titles start at the original inset and the progress row has no overflow`, withMarker.progressHeight <= 18 && withMarker.barHeight === 4 && withMarker.titleLeft === withMarker.barLeft && withMarker.titleLeft === 11 && !withMarker.overflow);
    if (width === 180) {
      const palette = await evaluate(`(() => {
        const row = document.querySelector('[data-list-id="${b}"]');
        const edge = getComputedStyle(row, '::before');
        const context = document.createElement('canvas').getContext('2d');
        const rgb = color => { context.clearRect(0,0,1,1); context.fillStyle = color; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data].slice(0,3); };
        return { edge: rgb(edge.backgroundColor), done: rgb(getComputedStyle(row.querySelector('[data-part=done]')).backgroundColor), position: edge.position, left: edge.left, width: edge.width, selected: row.getAttribute('aria-current'), border: getComputedStyle(row).borderLeftWidth };
      })()`);
      const expected = theme === 'light' ? { edge: [139, 47, 201], done: [101, 105, 113] } : { edge: [207, 156, 255], done: [156, 160, 168] };
      check(`${theme} uses theme-colored edge and neutral progress while preserving selected border`, palette.edge.every((v, i) => v === expected.edge[i]) && palette.done.every((v, i) => Math.abs(v - expected.done[i]) <= 1) && palette.position === 'absolute' && palette.left === '1px' && palette.width === '3px' && palette.selected === 'true' && palette.border === '1px');
    }
    if ((theme === 'light' && width === 393) || (theme === 'dark' && width === 180)) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(out, `todo-list-edge-${theme}-${width}.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await update(b, 1, { status: 'done', expectedStatus: 'open', note: '隔离验证：前置完成，检查标记消失与进度布局' });
    await update(b, 2, { status: 'done', expectedStatus: 'open', note: '隔离验证：前置完成，检查标记消失与进度布局' });
    await waitFor(async () => await waitingCount() === null, 'marker removed');
    assert.deepEqual(await geometry(), withMarker);
    check(`${theme} ${width}px completion removes the marker without moving text or progress`, await evaluate(`getComputedStyle(document.querySelector('[data-list-id="${b}"]'), '::before').content === 'none'`));
    await update(b, 1, { status: 'open', expectedStatus: 'done' });
    await update(b, 2, { status: 'open', expectedStatus: 'done' });
    await waitFor(async () => await waitingCount() === '2', 'marker restored');
  }
  await evaluate(`document.documentElement.style.setProperty('--accent', '#4cc5bd')`);
  check('dependency edge follows a changed theme accent', await evaluate(`getComputedStyle(document.querySelector('[data-list-id="${b}"]'), '::before').backgroundColor === 'rgb(76, 197, 189)'`));
  await update(b, 1, { status: 'done', expectedStatus: 'open', note: '隔离验证：恢复已完成状态，继续验证移动保留依赖' });
  await ipc('updateTodoList', { listId: b, archived: true });
  await ipc('moveTodoItemsToList', { fromListId: b, toListId: a, items: [{ item: 1, expectedStatus: 'done' }] });
  const moved = (await read(a)).items[0].prerequisites.find(p => p.title === '完成签名');
  check('stable identity survives cross-list move', moved.listId === a && moved.item === 3 && moved.status === 'done');
  await ipc('deleteTodoItems', { listId: a, items: [{ item: 3, expectedStatus: 'done' }] });
  const missing = (await read(a)).items[0].prerequisites.find(p => p.title === '完成签名');
  check('deleting a prerequisite preserves its title and reports missing', missing.issue === 'missing');
  await update(a, 1, { removeDependencies: [missing.id] });
  check('only the selected relationship is removed', (await read(a)).items[0].prerequisites.length === 1);
} catch (error) {
  failure = error.stack ?? String(error);
  console.error(failure);
  process.exitCode = 1;
} finally {
  socket?.close(); mcp?.close();
  await running?.stop();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'todo-dependencies-result.json'), JSON.stringify({ root, passed: checks.length, checks, failure: failure ?? null }, null, 2));
}
