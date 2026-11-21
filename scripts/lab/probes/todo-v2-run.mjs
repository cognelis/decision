// 待办第二版 (IMP-186) on the packaged App in an isolated root: a list with prioritised, dated items made as the page does
// (the App's own renderer API, driven over the DevTools protocol), the 今天 view on screen, a rename, an archive and the
// way back, and the note read back with the storage layer. Synthetic data; the App is hidden (PARASELF_SMOKE).
// usage: node scripts/lab/probes/todo-v2-run.mjs --app out/Paraself-darwin-arm64/Paraself.app --bridge <bridge> --label main --out DIR
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DATA_DIR, buildHash, executableOf, isolationEnvironment, parseCommon, save, sleep } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'todo-v2-'));
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

// The storage layer, loaded from source the way the checks load it.
const { createServer } = await import(pathToFileURL(join(repository, 'node_modules', 'vite', 'dist', 'node', 'index.js')).href);
const vite = await createServer({ root: repository, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
const storage = await vite.ssrLoadModule('/packages/storage/src/index.ts');

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
try {
  const runtime = await until('health', async () => {
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
  const evaluate = async (expression) => {
    const id = ++nextId;
    const answer = new Promise((resolve) => pending.set(id, resolve));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const { result, error } = await answer;
    if (error || result.exceptionDetails) throw new Error(JSON.stringify(error ?? result.exceptionDetails.exception?.description));
    return result.result.value;
  };
  await until('renderer API', () => evaluate('typeof window.decision?.recordTodoList === "function"'));

  const day = (offset) => evaluate(`(() => { const d = new Date(); d.setDate(d.getDate() + ${offset}); const p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); })()`);
  const today = await day(0);
  const tomorrow = await day(1);
  const created = await evaluate(`window.decision.recordTodoList(${JSON.stringify({
    title: '合成：发版清单',
    items: [
      { title: '写发版总结', priority: 'high', due: today },
      { title: '核对哈希', priority: 'low', due: tomorrow },
      { title: '整理笔记' },
    ],
  })})`);
  const listId = created.list?.id;
  check('the page API creates a list with three items', created.status === 'created' && created.added.length === 3 && typeof listId === 'string', created);

  const listed = (await evaluate(`window.decision.listTodoLists({ listId: ${JSON.stringify(listId)} })`)).lists[0];
  check('items come back with their priority and due date', listed.items[0].priority === 'high' && listed.items[0].due === today && listed.items[1].priority === 'low' && listed.items[2].priority === null, listed.items);

  // 今天 view on screen.
  await evaluate(`(async () => { document.querySelector('[aria-label="待办"]').click(); await new Promise((r) => setTimeout(r, 1500)); return true; })()`);
  const text = await evaluate('document.querySelector(".todo-panel")?.innerText ?? ""');
  check('今天 view lists the item due today, not the one due tomorrow', /今天到期/u.test(text) && text.includes('写发版总结') && !/今天到期[\s\S]*核对哈希/u.test(text.split('即将到期')[0] ?? ''), text.slice(0, 600));
  const counts = await evaluate('[...document.querySelectorAll(".todo-view-row")].map((row) => row.innerText.replace(/\\s+/g, " ")).join("|")');
  check('the view counts show 今天 1 and 即将到期 1', /今天 1\|即将到期 1/u.test(counts), counts);

  const [path] = await notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'));
  const note = await readFile(path, 'utf8');
  check('the note writes the marks the Tasks plugin reads', note.includes(`- [ ] 1. 写发版总结 ⏫ 📅 ${today}`) && note.includes(`- [ ] 2. 核对哈希 🔽 📅 ${tomorrow}`) && note.includes('- [ ] 3. 整理笔记\n'), note);
  const parsed = storage.parseTodoList(note);
  check('the storage layer reads it back as written', parsed.items[0].priority === 'high' && parsed.items[0].due === today && parsed.items[2].due === null && parsed.title === '合成：发版清单', parsed);

  const renamed = await evaluate(`window.decision.updateTodoList({ listId: ${JSON.stringify(listId)}, title: '合成：发版检查' })`);
  const afterRename = await readFile(path, 'utf8');
  check('rename changes the title, not the file', renamed.status === 'saved' && /^# 合成：发版检查$/mu.test(afterRename) && (await notes(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos')))[0] === path, afterRename.slice(0, 400));
  check('the storage layer reads the renamed note', storage.parseTodoList(afterRename).title === '合成：发版检查', afterRename.slice(0, 300));

  const archived = await evaluate(`window.decision.updateTodoList({ listId: ${JSON.stringify(listId)}, archived: true })`);
  const afterArchive = await readFile(path, 'utf8');
  check('archive writes archived: true', archived.status === 'saved' && /^archived: true$/mu.test(afterArchive) && storage.parseTodoList(afterArchive).archived === true, afterArchive.slice(0, 400));
  const open = (await evaluate('window.decision.listTodoLists({})')).lists.map((entry) => entry.id);
  const everything = (await evaluate('window.decision.listTodoLists({ includeClosed: true })')).lists.find((entry) => entry.id === listId);
  check('an archived list is not among the unfinished ones, and is under 全部', !open.includes(listId) && everything?.archived === true, { open, everything });
  await sleep(600);
  const afterText = await evaluate('document.querySelector(".todo-panel")?.innerText ?? ""');
  const views = await evaluate('[...document.querySelectorAll(".todo-view-row")].map((row) => row.innerText.replace(/\\s+/g, " ")).join("|")');
  check('the views no longer count it', /今天 0\|即将到期 0/u.test(views) && !afterText.includes('写发版总结'), views);

  const restored = await evaluate(`window.decision.updateTodoList({ listId: ${JSON.stringify(listId)}, archived: false })`);
  const afterRestore = await readFile(path, 'utf8');
  check('unarchive takes the property out and the list is back', restored.status === 'saved' && !/^archived:/mu.test(afterRestore) && storage.parseTodoList(afterRestore).archived === false
    && (await evaluate('window.decision.listTodoLists({})')).lists.some((entry) => entry.id === listId), afterRestore.slice(0, 400));
  check('the items keep their marks through it all', afterRestore.includes(`- [ ] 1. 写发版总结 ⏫ 📅 ${today}`), afterRestore);
} finally {
  try { socket?.close(); } catch { /* closed */ }
  await vite.close();
  child.kill('SIGTERM');
  await sleep(1500);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'todo-v2-run', label, 'result', { build, checks, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 ? 0 : 1;
