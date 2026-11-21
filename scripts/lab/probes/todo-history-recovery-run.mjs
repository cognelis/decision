// Synthetic todo persistence faults, interrupted writes and old-App refusal; no real Vault or model calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { ISOLATION_KEYS, startIsolatedApp, connectMcp } from '../isolated-app.mjs';
const { values } = parseArgs({ options: { app: { type: 'string' }, 'legacy-app': { type: 'string' }, out: { type: 'string' }, label: { type: 'string' } } });
assert(values.app && values['legacy-app'] && values.out && values.label, '--app --legacy-app --out --label required');
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const target = await realpath(resolve(values.app)), legacy = await realpath(resolve(values['legacy-app'])), out = resolve(values.out);
const root = await realpath(await mkdtemp(join(tmpdir(), 'paraself-todo-history-'))); await mkdir(out, { recursive: true });
const hash = data => createHash('sha256').update(data).digest('hex');
const checks = [], launches = []; let app, mcp, historyRoot, error = null; const cleanup = [];
const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'ok' : 'FAIL'} ${name}`); };
const start = async bundle => {
  assert(!app);
  app = await startIsolatedApp({ root, executable: join(bundle, 'Contents/MacOS/Paraself') });
  assert.equal(app.child.pid, app.runtime.pid);
  for (const key of ISOLATION_KEYS) assert(resolve(app.env[key]).startsWith(root + sep));
  launches.push({ bundle, pid: app.child.pid });
  mcp = await connectMcp({ env: app.env, bridge: join(bundle, 'Contents/Resources/bridge/paraself-bridge') });
};
const stop = async () => {
  mcp?.close(); mcp = undefined;
  if (!app) return;
  const current = app; await current.stop(); app = undefined;
  assert.equal(current.child.exitCode, 0);
};
const call = async (name, input) => {
  let timer;
  const response = await Promise.race([mcp.call(name, input), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), 15000); })]).finally(() => clearTimeout(timer));
  return { error: response.error ?? response.result?.isError ?? false, body: response.result?.structuredContent };
};
const notes = async directory => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) found.push(...await notes(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
};
try {
  await start(target);
  historyRoot = join(app.env.PARASELF_USER_DATA, 'todo-history');
  const input = { title: 'RSI15 合成清单', project: 'rsi15', items: [{ title: '合成验证事项', priority: 'p2' }] };
  const created = await call('record_todo_list', input);
  assert(!created.error && created.body?.todoRecord.status === 'created');
  const id = created.body.todoRecord.list.id;
  const [notePath] = await notes(join(app.env.PARASELF_VAULT_PATH, 'Decision Journal/todos')); assert(notePath);
  const historyPath = join(historyRoot, `${hash(id)}.json`);
  const beforeNote = await readFile(notePath, 'utf8'), beforeHistory = await readFile(historyPath, 'utf8');
  const report = '合成执行说明：仅测试环境验证，用户尚未批准发布。';
  const update = { listId: id, item: 1, status: 'done', note: report };
  await chmod(historyRoot, 0o500);
  try {
    const refused = await call('update_todo_item', update);
    check('history write failure is not reported as a successful update', refused.error || refused.body?.itemUpdate?.status !== 'saved');
    check('a rejected update leaves the original note unchanged', await readFile(notePath, 'utf8') === beforeNote);
    check('a rejected update preserves its existing history bytes', await readFile(historyPath, 'utf8') === beforeHistory);
    const count = (await notes(join(app.env.PARASELF_VAULT_PATH, 'Decision Journal/todos'))).length;
    const refusedCreate = await call('record_todo_list', { ...input, title: '另一份合成清单' });
    check('history failure rejects creation before leaving a note without history', (refusedCreate.error || refusedCreate.body?.todoRecord?.status !== 'created') && (await notes(join(app.env.PARASELF_VAULT_PATH, 'Decision Journal/todos'))).length === count);
  } finally { await chmod(historyRoot, 0o700); }
  const retried = await call('update_todo_item', update);
  check('retry after the storage fault keeps the complete report', !retried.error && retried.body?.itemUpdate?.item?.note === report);
  const afterNote = await readFile(notePath, 'utf8'), afterHistory = await readFile(historyPath, 'utf8');
  const pending = JSON.stringify({ version: 2, listId: id, beforeHash: hash(beforeNote), afterHash: hash(afterNote), before: JSON.parse(beforeHistory), after: JSON.parse(afterHistory) });
  await stop(); await writeFile(historyPath, pending);

  await start(legacy);
  const oldWrite = await call('update_todo_item', { ...update, note: '旧包不得覆盖未结算的说明' });
  check('old App refuses to update an unfinished history', oldWrite.error || oldWrite.body?.itemUpdate?.status !== 'saved');
  check('old App keeps the unfinished history and note intact', await readFile(historyPath, 'utf8') === pending && await readFile(notePath, 'utf8') === afterNote);
  await stop(); await start(target);
  const recovered = (await call('list_todo_lists', { listId: id, includeClosed: true })).body?.lists?.[0];
  check('restart finishes the applied note with its complete report and attribution', recovered?.items[0]?.note === report && recovered.items[0].status === 'done' && recovered.items[0].changedInObsidian === false);
  check('settled history is version 1 and preserves the full event payload', isDeepStrictEqual(JSON.parse(await readFile(historyPath, 'utf8')), JSON.parse(afterHistory)));
  await stop(); await start(legacy);
  const compatible = (await call('list_todo_lists', { listId: id, includeClosed: true })).body?.lists?.[0];
  check('old App reads the settled history and report normally', compatible?.items[0]?.note === report);
  await stop(); await writeFile(notePath, beforeNote); await writeFile(historyPath, pending);

  await start(target);
  const rolledBack = (await call('list_todo_lists', { listId: id, includeClosed: true })).body?.lists?.[0];
  check('an unwritten note restores the previous history without claiming completion', rolledBack?.items[0]?.status === 'open' && rolledBack.items[0].note === null && isDeepStrictEqual(JSON.parse(await readFile(historyPath, 'utf8')), JSON.parse(beforeHistory)));
  await stop(); const external = `${afterNote}\n合成用户补充：不要覆盖。\n`; await writeFile(notePath, external); await writeFile(historyPath, pending);
  await start(target);
  const conflict = await call('update_todo_item', update);
  check('an external edit preserves both history snapshots and refuses overwrite', (conflict.error || conflict.body?.itemUpdate?.status !== 'saved') && await readFile(notePath, 'utf8') === external && await readFile(historyPath, 'utf8') === pending);
  await stop();
} catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); }
finally {
  if (historyRoot) await chmod(historyRoot, 0o700).catch(caught => cleanup.push(String(caught)));
  await stop().catch(caught => cleanup.push(String(caught)));
}
await writeFile(join(out, 'SUMMARY.json'), `${JSON.stringify({ label: values.label, root, appHash: hash(await readFile(join(target, 'Contents/Resources/app.asar'))), checks, launches, error, cleanup }, null, 2)}\n`);
console.log(`${checks.filter(check => check.ok).length}/${checks.length} checks passed`);
process.exitCode = error || cleanup.length || checks.some(check => !check.ok) ? 1 : 0;
