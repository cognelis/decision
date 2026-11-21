// IMP-185 migration, end to end: a build from before IMP-185 (--old-app, --old-bridge) writes a todo list into a throwaway
// vault, its history in the note, and a box is ticked in the note as Obsidian would; then the build under test (--app,
// --bridge) starts on the same isolated root. Checked: the history moved to the App's own data folder and out of the note,
// what an agent reads of the list unchanged by the move, and the next change recorded after the Obsidian tick. Synthetic
// data only: no user data is read or written.
// usage: node scripts/lab/probes/todo-migration-run.mjs --old-app /Applications/Paraself.app \
//          --old-bridge /Applications/Paraself.app/Contents/Resources/bridge/paraself-bridge \
//          --app out/Paraself-darwin-arm64/Paraself.app --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge \
//          --label main --out DIR
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, sleep, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out, 'old-app': oldAppArgument, 'old-bridge': oldBridgeArgument } = parseCommon({ 'old-app': { type: 'string' }, 'old-bridge': { type: 'string' } });
if (!oldAppArgument || !oldBridgeArgument) throw new Error('--old-app and --old-bridge are required');
const oldApp = resolve(oldAppArgument);
const oldBridge = resolve(oldBridgeArgument);
const builds = { old: await buildHash(oldApp, oldBridge), candidate: await buildHash(app, bridge) };
const root = await mkdtemp(join(DATA_DIR, 'todo-migration-'));
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
const caller = (mcp) => async (name, args) => {
  const response = await mcp.call(name, args);
  return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', body: response.result?.structuredContent ?? null };
};
// What an agent reads of each item: what the move must leave as it was.
const shownItems = (listed) => (listed.body?.lists?.[0]?.items ?? []).map((item) => ({ number: item.number, status: item.status, note: item.note, changedInObsidian: item.changedInObsidian }));

let listId;
let before;
let beforeRevision;
let path;
try {
  // Before IMP-185: the list written by the old build, its history in the note.
  const old = await startIsolatedApp({ root, executable: executableOf(oldApp) });
  const oldMcp = await connectMcp({ env: old.env, bridge: oldBridge, client: 'codex' });
  try {
    const call = caller(oldMcp);
    const created = await call('record_todo_list', {
      title: '合成：迁移前的调研',
      project: 'lab',
      items: [{ title: '合成：第一项', detail: '合成：证据与位置。' }, { title: '合成：第二项' }, { title: '合成：第三项' }],
    });
    listId = created.body?.todoRecord?.list?.id;
    check('the old build saves the list', typeof listId === 'string', created);
    await call('update_todo_item', { listId, item: 1, status: 'in_progress' });
    await call('update_todo_item', { listId, item: 1, status: 'done', note: '合成：迁移前完成，测试通过。' });
    [path] = await notes(join(old.env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'));
    const written = await readFile(path, 'utf8');
    check('the old build keeps the history in the note', written.includes('## 处理记录') && written.includes('decision-todo-history') && written.includes('合成：迁移前完成'), written.slice(-800));
    // Ticked in Obsidian, as the reader would, and a line of the reader's own below the list.
    await writeFile(path, `${written.replace('- [ ] 2. 合成：第二项', '- [x] 2. 合成：第二项')}\n## 合成：读者自己的笔记\n\n留着。\n`);
    const listed = await call('list_todo_lists', { listId });
    before = shownItems(listed);
    beforeRevision = listed.body?.lists?.[0]?.revision;
    check('the old build reads the tick as made in Obsidian', before.find((item) => item.number === 2)?.changedInObsidian === true, before);
  } finally {
    oldMcp.close();
    await old.stop();
  }

  // The build under test, on the same vault and data folder.
  const started = await startIsolatedApp({ root, executable: executableOf(app) });
  const mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
  try {
    const call = caller(mcp);
    let note = '';
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(250)) {
      note = await readFile(path, 'utf8');
      if (!note.includes('decision-todo-history')) break;
    }
    check('the history is taken out of the note', !/处理记录|decision-todo-(log|history)|合成：迁移前完成/u.test(note), note.slice(-800));
    check('the note keeps its boxes and what the reader wrote', note.includes('- [x] 1. 合成：第一项') && note.includes('- [x] 2. 合成：第二项') && note.includes('## 合成：读者自己的笔记\n\n留着。'), note);
    const historyFile = join(started.env.PARASELF_USER_DATA, 'todo-history', `${createHash('sha256').update(listId, 'utf8').digest('hex')}.json`);
    const kept = JSON.parse(await readFile(historyFile, 'utf8').catch(() => '{"events":[]}'));
    check('the history is kept in the App\'s own data folder', kept.events?.length === 2 && kept.events[1]?.note === '合成：迁移前完成，测试通过。', kept);

    const listed = await call('list_todo_lists', { listId });
    const after = shownItems(listed);
    check('an agent reads the list as before the move', JSON.stringify(after) === JSON.stringify(before), { before, after });
    check('the move leaves the revision as it was', listed.body?.lists?.[0]?.revision === beforeRevision, { before: beforeRevision, after: listed.body?.lists?.[0]?.revision });

    const finished = await call('update_todo_item', { listId, item: 3, status: 'done', note: '合成：迁移后完成。' });
    check('the new build changes the list after the move', finished.body?.itemUpdate?.status === 'saved', finished);
    const latest = JSON.parse(await readFile(historyFile, 'utf8'));
    const order = latest.events.map((event) => `${event.item}:${event.by.kind}:${event.previous}>${event.status}`);
    check('the Obsidian tick is recorded before the change made next', order.join(' ') === '1:agent:open>in_progress 1:agent:in_progress>done 2:obsidian:open>done 3:agent:open>done', order);
    check('the note still holds no history', !/处理记录|decision-todo-history|合成：迁移后完成/u.test(await readFile(path, 'utf8')));

    // A session started before the update: its bridge, still the old one, asks the new App, a long-term list among the
    // lists. Answered in full, its strict schemas took every answer for none.
    await call('record_todo_list', { title: '合成：日常' });
    const oldSession = await connectMcp({ env: started.env, bridge: oldBridge, client: 'codex' });
    try {
      const oldCall = caller(oldSession);
      // The research list is closed by now (its last item done above): asked for with the finished ones.
      const read = await oldCall('list_todo_lists', { includeClosed: true });
      const titles = (read.body?.lists ?? []).map((list) => list.title);
      check('a session started before the update still reads the lists', !read.isError && read.body?.total === 2 && titles.includes('合成：日常') && titles.includes('合成：迁移前的调研'), read);
      const noted = await oldCall('update_todo_item', { listId, item: 3, note: '合成：旧会话补的说明。' });
      check('a session started before the update still records progress', !noted.isError && noted.body?.itemUpdate?.status === 'saved', noted);
      const added = await oldCall('record_todo_list', { listId, items: [{ title: '合成：旧会话加的一项' }] });
      check('a session started before the update still adds items', !added.isError && added.body?.todoRecord?.status === 'appended', added);
    } finally {
      oldSession.close();
    }
  } finally {
    mcp.close();
    await started.stop();
  }
} catch (error) {
  check('the run completed', false, error instanceof Error ? error.message : String(error));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'todo-migration-run', label, 'result', { builds, checks, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 ? 0 : 1;
