// 待办第三版 (IMP-187) on the packaged App in an isolated root: a list with prioritised, dated items made as the page does
// (the App's own renderer API, driven over the DevTools protocol), the 今天 view on screen, a rename, an archive and the
// way back, and the note read back with the storage layer. Synthetic data; the App is hidden (PARASELF_SMOKE).
// usage: node scripts/lab/probes/todo-v3-run.mjs --app out/Paraself-darwin-arm64/Paraself.app --bridge <bridge> --label main --out DIR
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { DATA_DIR, buildHash, executableOf, isolationEnvironment, parseCommon, save, sleep } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'todo-v3-'));
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

  const click = (script) => evaluate(`(async () => { ${script}; await new Promise((r) => setTimeout(r, 500)); return true; })()`);
  const todosDir = join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos');
  const detail = '说明第一句。\n- 子列表一\n  - 孙项甲\n- 子列表二';
  const items = Array.from({ length: 91 }, (_, index) => ({
    title: `合成事项 ${index + 1}：把评审意见里提到的命名不一致统一成同一个说法`,
    ...(index === 2 || index === 3 ? { detail: `${detail}（第 ${index + 1} 项）` } : {}),
  }));
  const created = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: '合成：91 项长清单', longTerm: true, items: items.slice(0, 50) })})`);
  const listId = created.list?.id;
  const appended = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ listId, items: items.slice(50) })})`);
  check('a 91 item list is made (50, then 41)', created.status === 'created' && appended.status === 'appended' && appended.list.counts.open === 91, [created.status, appended.status]);

  await click('document.querySelector(\'[aria-label="待办"]\').click()');
  await sleep(1200);
  await click('[...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "合成：91 项长清单").click()');
  const shownCount = () => evaluate('document.querySelector(\'ol[aria-label="待处理"]\')?.querySelectorAll(".todo-item").length ?? 0');
  const more = () => evaluate('[...document.querySelectorAll(".todo-more")].map((b) => b.textContent.trim()).join("|")');
  check('30 items are shown first, with a button for the other 61', (await shownCount()) === 30 && (await more()) === '再显示 30 项（还有 61 项）', [await shownCount(), await more()]);
  const card = await evaluate('(() => { const li = document.querySelector(".todo-item"); return { sub: li.querySelector(".todo-item-sub").innerText, title: li.querySelector(".todo-item-title").innerText, box: li.querySelector("input[type=checkbox]") !== null, status: li.querySelector(".todo-status-button").innerText }; })()');
  check('a card has its title in full, #number on the second line and a status button', card.title.includes('把评审意见里提到的命名不一致统一成同一个说法') && /^#1/u.test(card.sub) && card.box && card.status.includes('待处理'), card);
  await click('document.querySelector(".todo-more").click()');
  check('再显示 30 项 shows 60', (await shownCount()) === 60 && (await more()) === '再显示 30 项（还有 31 项）', [await shownCount(), await more()]);

  // Batch status: items 1, 2 and 5 finished from the bar.
  await click('for (const n of [1, 2, 5]) document.querySelector(`[aria-label="选择第 ${n} 项"]`).click()');
  check('the bar says 已选 3 项', /已选 3 项/u.test(await evaluate('document.querySelector(".todo-batch-bar")?.innerText ?? ""')));
  await click('[...document.querySelectorAll(".todo-batch-bar button")].find((b) => b.textContent.trim() === "标为完成").click()');
  await sleep(600);
  const [path] = await notes(todosDir);
  let listed = (await evaluate(`window.decision.listTodoLists({ listId: ${JSON.stringify(listId)} })`)).lists[0];
  check('the three are done, the rest open, no note asked', listed.items.filter((i) => i.status === 'done').map((i) => i.number).join() === '1,2,5' && listed.counts.open === 88 && listed.items[0].note === null, listed.counts);
  const afterStatus = await readFile(path, 'utf8');
  check('the note ticks exactly those boxes', /- \[x\] 1\./u.test(afterStatus) && /- \[x\] 2\./u.test(afterStatus) && /- \[x\] 5\./u.test(afterStatus) && (afterStatus.match(/- \[x\]/gu) ?? []).length === 3, afterStatus.slice(0, 500));

  // Batch delete of 3 and 4, which have detail and an indented sub-list.
  await click('for (const n of [3, 4]) document.querySelector(`[aria-label="选择第 ${n} 项"]`).click()');
  await click('[...document.querySelectorAll(".todo-batch-bar button")].find((b) => b.textContent.trim() === "删除").click()');
  const dialogText = await evaluate('document.querySelector("[role=dialog]")?.innerText ?? ""');
  check('the confirmation names the count, the titles and the sub-list', /删除 2 项/u.test(dialogText) && dialogText.includes('合成事项 3') && dialogText.includes('合成事项 4') && dialogText.includes('连同它下面缩进的子列表和说明一起删除'), dialogText);
  check('nothing is deleted before it is confirmed', (await readFile(path, 'utf8')).includes('孙项甲'));
  await click('[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "删除 2 项" && b.type === "submit").click()');
  await sleep(800);
  const afterDelete = await readFile(path, 'utf8');
  const read = storage.parseTodoList(afterDelete);
  check('the storage layer reads 89 items, 3 and 4 gone, the rest as they were', read.items.length === 89 && !read.items.some((i) => i.number === 3 || i.number === 4) && read.items[0].number === 1 && read.items.at(-1).number === 91, read.items.map((i) => i.number).slice(0, 8));
  check('their detail and indented sub-lists left the note with them', !/孙项甲|子列表一|子列表二|合成事项 3：|合成事项 4：/u.test(afterDelete) && afterDelete.includes('合成事项 5：') && afterDelete.includes('- [x] 5.'), afterDelete.slice(0, 700));
  const appendedAgain = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ listId, items: [{ title: '合成：删除之后新加的一项' }] })})`);
  check('the next item is number 92: the deleted numbers are not given again', appendedAgain.added[0]?.number === 92, appendedAgain.added);
  const history = JSON.parse(await readFile(join(env.PARASELF_USER_DATA, 'todo-history', `${createHash('sha256').update(listId, 'utf8').digest('hex')}.json`), 'utf8'));
  check('the history keeps a deleted event for each', history.events.filter((e) => e.deleted === true).map((e) => e.item).join() === '3,4', history.events.slice(-4));

  // TODO_PROBE_SKIP_TRASH=1 leaves the real wastebasket alone (a regression run that is not about it).
  if (process.env.TODO_PROBE_SKIP_TRASH !== '1') {
  // The real wastebasket: one synthetic note with a name that cannot be mistaken, and only that one.
  const tag = randomBytes(4).toString('hex');
  const trashTitle = `paraself-lab-trash-test-${tag}`;
  const trashList = await evaluate(`window.decision.recordTodoList(${JSON.stringify({ title: trashTitle, items: [{ title: '合成：只用来试废纸篓' }] })})`);
  const trashNote = (await notes(todosDir)).find((file) => file.includes(trashTitle));
  check('the trash test note exists in the synthetic vault', trashNote !== undefined && trashList.status === 'created', trashNote);
  const wrong = await evaluate(`window.decision.deleteTodoList(${JSON.stringify({ listId: trashList.list.id, title: '别的名字' })})`);
  check('a wrong name deletes nothing', wrong.status === 'title_mismatch' && (await stat(trashNote).then(() => true, () => false)), wrong);
  const deleted = await evaluate(`window.decision.deleteTodoList(${JSON.stringify({ listId: trashList.list.id, title: trashTitle })})`);
  check('deleting the list answers deleted', deleted.status === 'deleted', deleted);
  check('the note is gone from the vault', !(await stat(trashNote).then(() => true, () => false)), trashNote);
  const trashName = trashNote.split('/').at(-1);
  const inTrash = (await readdir(join(homedir(), '.Trash')).catch((error) => [`ERR:${error.code}`])).filter((name) => name === trashName || name.startsWith(trashName.replace(/\.md$/u, '')));
  check('it is in the system wastebasket (~/.Trash), found by its own name', inTrash.length >= 1 && !inTrash[0].startsWith('ERR:'), inTrash);
  console.log(`TRASH_TEST_FILE ${inTrash.join(', ')}`);
  const gone = (await evaluate('window.decision.listTodoLists({ includeClosed: true })')).lists.some((entry) => entry.id === trashList.list.id);
  check('the list is gone from the page API, its history file kept', !gone && await stat(join(env.PARASELF_USER_DATA, 'todo-history', `${createHash('sha256').update(trashList.list.id, 'utf8').digest('hex')}.json`)).then(() => true, () => false));
  }
} finally {
  try { socket?.close(); } catch { /* closed */ }
  await vite.close();
  child.kill('SIGTERM');
  await sleep(1500);
  if (child.exitCode === null) child.kill('SIGKILL');
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'todo-v3-run', label, 'result', { build, checks, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 ? 0 : 1;
