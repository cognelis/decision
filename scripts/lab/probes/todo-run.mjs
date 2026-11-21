// 待办清单 end to end (IMP-183): the packaged App in an isolated root, the packaged bridge's MCP tools as an agent calls
// them, and the list's note in the throwaway vault ticked and added to as Obsidian would. Every step is checked; the
// results go to --out and the exit code says whether all held. Synthetic data only: no user data is read or written.
// usage: node scripts/lab/probes/todo-run.mjs --app out/Paraself-darwin-arm64/Paraself.app \
//          --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge --label main --out DIR
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'todo-run-'));
const checks = [];
let runError = null; const cleanupErrors = [];
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

const started = await startIsolatedApp({ root, executable: executableOf(app) });
const mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
const call = async (name, args) => {
  const response = await mcp.call(name, args);
  return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', body: response.result?.structuredContent ?? null, error: response.error ?? null };
};

try {
  const tools = await mcp.listTools();
  const named = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  check('tools/list has the three todo tools', ['record_todo_list', 'list_todo_lists', 'update_todo_item'].every((name) => named[name] !== undefined), tools.map((tool) => tool.name));
  check('list_todo_lists is read-only, update_todo_item idempotent', named.list_todo_lists?.annotations?.readOnlyHint === true && named.update_todo_item?.annotations?.idempotentHint === true, [named.list_todo_lists?.annotations, named.update_todo_item?.annotations]);

  const research = {
    title: '合成调研：设置页可访问性',
    summary: '合成数据：三项发现，按影响排序。',
    project: 'lab',
    items: [
      { title: '开关控件缺少可读名称', priority: 'none', detail: '合成：SettingsPanel 的开关没有 aria-label。\n建议：补上名称。' },
      { title: '焦点顺序跳过保存按钮', priority: 'none' },
      { title: '错误提示没有 role=alert', priority: 'none' },
    ],
  };
  const created = await call('record_todo_list', research);
  const listId = created.body?.todoRecord?.list?.id;
  check('record_todo_list creates the list with three items', !created.isError && created.body?.todoRecord?.status === 'created' && created.body.todoRecord.added.length === 3 && typeof listId === 'string', created);
  if (typeof listId !== 'string') throw new Error(`synthetic list was not created: ${JSON.stringify(created)}`);
  const again = await call('record_todo_list', research);
  check('the same list sent again is the one saved', again.body?.todoRecord?.status === 'duplicate' && again.body.todoRecord.list?.id === listId, again);

  const [path] = await notes(join(started.env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'));
  const first = path === undefined ? '' : await readFile(path, 'utf8');
  check('one note under Decision Journal/todos/<year>/<month>/', path !== undefined && /todos\/\d{4}\/\d{2}\/[^/]+\.md$/u.test(path), path);
  check('items are checkboxes with the detail under its item', first.includes('- [ ] 1. 开关控件缺少可读名称\n\n  合成：SettingsPanel 的开关没有 aria-label。'), first.slice(0, 1_200));

  const listed = await call('list_todo_lists', { project: 'lab' });
  check('list_todo_lists finds the open list', listed.body?.total === 1 && listed.body.lists?.[0]?.items?.length === 3, listed);

  const refused = await call('update_todo_item', { listId, item: 1, status: 'done' });
  check('done without a note is refused before anything is written', refused.isError && /需要 note/u.test(refused.text), refused);
  const startedItem = await call('update_todo_item', { listId, item: 1, status: 'in_progress' });
  check('item 1 in progress', startedItem.body?.itemUpdate?.status === 'saved' && startedItem.body.itemUpdate.item?.status === 'in_progress', startedItem);
  const finished = await call('update_todo_item', { listId, item: 1, status: 'done', note: '合成：已补上 aria-label，单测通过。' });
  check('item 1 done with its note', finished.body?.itemUpdate?.status === 'saved' && finished.body.itemUpdate.item?.note === '合成：已补上 aria-label，单测通过。', finished);
  const repeated = await call('update_todo_item', { listId, item: 1, status: 'done', note: '合成：已补上 aria-label，单测通过。' });
  check('the same change again writes nothing', !repeated.isError && repeated.body?.itemUpdate?.status === 'unchanged', repeated);

  // As the reader would in Obsidian: item 2 ticked, and an item of their own added without a number.
  const current = await readFile(path, 'utf8');
  await writeFile(path, current
    .replace('- [ ] 2. 焦点顺序跳过保存按钮', '- [x] 2. 焦点顺序跳过保存按钮')
    .replace('\n<!-- decision:todo-items-end -->', '\n\n- [ ] 在 Obsidian 里加的一项\n<!-- decision:todo-items-end -->'));
  const reread = await call('list_todo_lists', { listId });
  const items = reread.body?.lists?.[0]?.items ?? [];
  check('a box ticked in Obsidian reads as done, changed in Obsidian', items.find((item) => item.number === 2)?.status === 'done' && items.find((item) => item.number === 2)?.changedInObsidian === true, items);
  check('an item added in Obsidian takes the next number', items.find((item) => item.number === 4)?.title === '在 Obsidian 里加的一项', items);

  const dropped = await call('update_todo_item', { listId, item: 3, status: 'dropped', note: '合成：组件库下个版本自带，不单独改。' });
  check('item 3 dropped with its reason', dropped.body?.itemUpdate?.status === 'saved', dropped);
  const written = await readFile(path, 'utf8');
  // IMP-185: the history is the App's, kept in its own data folder, never in the note.
  const historyFile = join(started.env.PARASELF_USER_DATA, 'todo-history', `${createHash('sha256').update(listId, 'utf8').digest('hex')}.json`);
  const kept = JSON.parse(await readFile(historyFile, 'utf8').catch(() => '{"events":[]}'));
  const order = kept.events.map((event) => `${event.item}:${event.by.kind}:${event.previous}>${event.status}`);
  check('the Obsidian tick is recorded before the change made next, in the App\'s own history', order.join(' ') === '1:agent:open>in_progress 1:agent:in_progress>done 2:obsidian:open>done 3:agent:open>dropped', order);
  check('the note holds no history', !/处理记录|decision-todo-history|已补上 aria-label/u.test(written), written.slice(-600));
  check('the note keeps the boxes and numbers the new item', written.includes('- [x] 1.') && written.includes('- [x] 2.') && written.includes('- [-] 3.') && written.includes('- [ ] 4. 在 Obsidian 里加的一项'), written.slice(0, 2_000));

  await call('update_todo_item', { listId, item: 4, status: 'done', note: '合成：已处理。' });
  const closed = await call('list_todo_lists', { project: 'lab' });
  const all = await call('list_todo_lists', { project: 'lab', includeClosed: true });
  check('a list with nothing left is listed only with includeClosed', closed.body?.total === 0 && all.body?.total === 1, { closed: closed.body?.total, all: all.body?.total });

  // IMP-184: a list made empty to collect todos in, kept with the unfinished lists however much of it is done.
  const learning = await call('record_todo_list', { title: '合成：学习' });
  const learningId = learning.body?.todoRecord?.list?.id;
  check('an empty list is made long-term, under no project', learning.body?.todoRecord?.status === 'created' && learning.body.todoRecord.list?.longTerm === true && learning.body.todoRecord.list?.project === null, learning);
  const madeAgain = await call('record_todo_list', { title: '合成：学习' });
  check('an empty list made again is the one there', madeAgain.body?.todoRecord?.status === 'duplicate' && madeAgain.body.todoRecord.list?.id === learningId, madeAgain);
  const emptyAdd = await call('record_todo_list', { listId: learningId, items: [] });
  check('adding nothing to a list is refused', emptyAdd.isError && /至少要有 1 项/u.test(emptyAdd.text), emptyAdd);
  await call('record_todo_list', { listId: learningId, items: [{ title: '合成：读完第 5 章', priority: 'none' }] });
  await call('update_todo_item', { listId: learningId, item: 1, status: 'done', note: '合成：读完了。' });
  const unfinished = await call('list_todo_lists', {});
  check('a long-term list with every item done stays with the unfinished ones', unfinished.body?.lists?.some((list) => list.id === learningId && list.longTerm === true) === true && /另有已处理的 1 项没有列出/u.test(unfinished.text), unfinished);
  const learningNote = (await notes(join(started.env.PARASELF_VAULT_PATH, 'Decision Journal', 'todos'))).find((path) => path !== undefined && path.includes('学习'));
  check('the note says it is long-term', learningNote !== undefined && /^long_term: true$/mu.test(await readFile(learningNote, 'utf8')), learningNote);
} catch (error) { runError = error instanceof Error ? error.stack : String(error); }
finally {
  try { mcp.close(); } catch (error) { cleanupErrors.push(String(error)); }
  await started.stop().catch(error => cleanupErrors.push(String(error)));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'todo-run', label, 'result', { build, root, checks, error: runError, cleanupErrors, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0 && runError === null && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 && runError === null && cleanupErrors.length === 0 ? 0 : 1;
