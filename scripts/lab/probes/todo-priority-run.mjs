// TD-B2 实跑：打包的 App（隔离目录）+ 打包里的真实 bridge。agent 记一个三项的清单（不写优先级被拒，写了 p0/p2/none 才收），页面显示 P0–P3。
// usage: node scripts/lab/probes/todo-priority-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label td-b2 --out DIR
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, connectMcp, executableOf, isolationEnvironment, parseCommon, sleep } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const root = await mkdtemp(join(DATA_DIR, 'todo-priority-'));
const checks = [];
const check = (name, ok, evidence) => { checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const env = { ...isolationEnvironment(root), PARASELF_SMOKE: '1' };
delete env.PARASELF_PROVIDER_CHILD; delete env.DECISION_PROVIDER_CHILD;
const port = 9300 + Math.floor(Math.random() * 500);
const child = spawn(executableOf(app), [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-3000); });
const until = async (what, probe, ms = 60_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`timed out: ${what}\n${stderr}`);
    await sleep(250);
  }
};
let socket; let mcp; const log = [];
try {
  await until('health', async () => {
    const parsed = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
    return (await fetch(`http://127.0.0.1:${parsed.port}/health`)).ok ? parsed : null;
  });
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  const tools = await mcp.listTools();
  const record = tools.find((tool) => tool.name === 'record_todo_list');
  log.push({ step: 'tools/list record_todo_list items schema', schema: record.inputSchema.properties.items });
  check('the advertised schema requires priority on each item', record.inputSchema.properties.items.items.required.includes('priority'), JSON.stringify(record.inputSchema.properties.items.items.required));
  check('the description gives the p0–p3 rule', /p0 is causing data loss/.test(JSON.stringify(record.inputSchema.properties.items)) && /每个事项都要写 priority|Required/.test(JSON.stringify(record.inputSchema.properties.items)));

  const missing = await mcp.call('record_todo_list', { title: '不写优先级', items: [{ title: '第一项' }] });
  log.push({ step: 'missing priority', response: missing });
  const missingText = JSON.stringify(missing);
  check('an item without a priority is refused, and the refusal says what to write', (missing.result?.isError === true || missing.error !== undefined) && /priority/.test(missingText) && /none/.test(missingText), missingText.slice(0, 400));

  const saved = await mcp.call('record_todo_list', { title: '遗留问题调研', summary: '三项，按影响排序。', items: [
    { title: '取消后残留临时目录', detail: 'local-review-service.ts:120', priority: 'p0' },
    { title: '托盘提示没有区分复盘', priority: 'p2' },
    { title: '交水费', priority: 'none' },
  ] });
  log.push({ step: 'saved', response: saved });
  check('a three-item list with p0, p2 and none is saved', saved.result?.isError !== true && saved.result?.structuredContent?.todoRecord?.status === 'created', JSON.stringify(saved).slice(0, 300));

  const target = await until('renderer page', async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0; const pending = new Map();
  socket.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id !== undefined) { pending.get(data.id)?.(data); pending.delete(data.id); } };
  const send = (method, params = {}) => { const id = ++nextId; const answer = new Promise((resolve) => pending.set(id, resolve)); socket.send(JSON.stringify({ id, method, params })); return answer; };
  const evaluate = async (expression) => {
    const { result, error } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (error || result.exceptionDetails) throw new Error(JSON.stringify(error ?? result.exceptionDetails.exception?.description));
    return result.result.value;
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await until('renderer API', () => evaluate('typeof window.decision?.listTodoLists === "function"'));
  await evaluate('(async () => { document.querySelector(\'[aria-label="待办"]\').click(); await new Promise((r) => setTimeout(r, 600)); [...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent).includes("遗留问题调研"))?.click(); await new Promise((r) => setTimeout(r, 600)); return true; })()');
  const chips = await until('chips', () => evaluate('[...document.querySelectorAll(".todo-chip")].map((e) => e.innerText).join(" | ")'));
  log.push({ step: 'page chips', chips });
  const cards = await evaluate('[...document.querySelectorAll(".todo-item")].map((e) => e.innerText.replace(/\\n+/g, " / ")).join("\\n")');
  log.push({ step: 'page cards', cards });
  check('the page shows P0 on the first item and P2 on the second', /P0/.test(chips) && /P2/.test(chips), chips);
  check('the item with none shows no priority chip', !/P[13]/.test(chips) && (chips.match(/P\d/g) ?? []).length === 2, chips);
  const listed = await mcp.call('list_todo_lists', {});
  const text = listed.result.content[0].text;
  log.push({ step: 'list_todo_lists', text });
  check('list_todo_lists reports 优先级 P0 and P2', /优先级 P0/.test(text) && /优先级 P2/.test(text), text);
} finally {
  const failed = checks.filter((entry) => !entry.ok);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `todo-priority-run-${label}-result.json`), `${JSON.stringify({ label, passed: checks.length - failed.length, failed: failed.length, checks, log }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length }));
  try { mcp?.close(); } catch { /* closing */ }
  try { socket?.close(); } catch { /* closing */ }
  child.kill('SIGTERM');
  await sleep(1500);
  await rm(root, { recursive: true, force: true });
  if (failed.length > 0) process.exitCode = 1;
}
