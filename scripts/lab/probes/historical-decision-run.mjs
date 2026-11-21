// IMP-207 实跑：打包的 App（隔离目录）+ 打包里的真实 bridge。agent 记两条历史决定（后一条替代前一条）、读、改、转正式决策、撤回；
// 笔记只落在 Decision Journal/history/ 下，不进 search_decision_context；知识页的「历史决定」分栏和详情显示同一份记录。
// usage: node scripts/lab/probes/historical-decision-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label imp-207 --out DIR
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, connectMcp, executableOf, isolationEnvironment, parseCommon, sleep } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const root = await mkdtemp(join(DATA_DIR, 'historical-decision-'));
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
/** Every file under a directory, as paths relative to it. */
const files = async (directory, prefix = '') => (await Promise.all((await readdir(directory, { withFileTypes: true }).catch(() => [])).map((entry) =>
  entry.isDirectory() ? files(join(directory, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]))).flat();
let socket; let mcp; const log = [];
try {
  await until('health', async () => {
    const parsed = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
    return (await fetch(`http://127.0.0.1:${parsed.port}/health`)).ok ? parsed : null;
  });
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  const call = async (name, args) => {
    const response = await mcp.call(name, args);
    log.push({ step: name, args, text: response.result?.content?.[0]?.text?.slice(0, 600), isError: response.result?.isError === true, error: response.error });
    return response.result ?? { isError: true, content: [{ text: JSON.stringify(response.error) }] };
  };
  const names = (await mcp.listTools()).map((tool) => tool.name);
  const wanted = ['record_historical_decision', 'list_historical_decisions', 'get_historical_decision', 'update_historical_decision', 'open_historical_decision'];
  check('the bridge lists the five tools', wanted.every((name) => names.includes(name)), names.join(' '));

  const first = await call('record_historical_decision', { title: '首页待办入口放在哪一层？', decision: '放在首页卡片区第二屏', decidedOn: '2026-09-30' });
  const firstId = first.structuredContent?.record?.id;
  check('a matter and a decision are enough to record one', first.isError !== true && first.structuredContent?.status === 'created' && typeof firstId === 'string', JSON.stringify(first).slice(0, 400));
  const again = await call('record_historical_decision', { title: '首页待办入口放在哪一层？', decision: '放在首页卡片区第二屏', decidedOn: '2026-09-30' });
  check('sent again, it is the one already kept', again.structuredContent?.status === 'duplicate' && again.structuredContent?.record?.id === firstId, JSON.stringify(again.structuredContent).slice(0, 300));

  const journal = join(env.PARASELF_VAULT_PATH, 'Decision Journal');
  const written = await files(journal);
  log.push({ step: 'vault files', written });
  check('its note is the only thing written, under history/<year>/', written.length === 1 && /^history\/2026\/2026-09-30-.+\.md$/u.test(written[0]), written.join(' | '));
  const note = await readFile(join(journal, written[0]), 'utf8');
  check('the note says what it is and carries no rationale section', /type: historical-decision/u.test(note) && note.includes('放在首页卡片区第二屏') && !/理由|rationale/iu.test(note), note.slice(0, 500));

  const second = await call('record_historical_decision', { title: '首页待办入口放在哪一层？', decision: '放进主导航第六项，首页只留计数', decidedOn: '2026-11-12', supersedesId: firstId, tags: ['导航'], options: ['只做全局快捷键，不放入口'], reversibility: 'easy' });
  const secondId = second.structuredContent?.record?.id;
  check('a new one names the one it replaces, which is marked 已替代', second.structuredContent?.supersededId === firstId, JSON.stringify(second.structuredContent).slice(0, 300));
  const read = await call('get_historical_decision', { id: firstId });
  check('read back, the old one shows its status and the one after it', read.structuredContent?.record?.status === 'superseded' && read.structuredContent?.successors?.[0]?.id === secondId, JSON.stringify(read.structuredContent).slice(0, 400));
  const loop = await call('update_historical_decision', { id: firstId, expectedRevision: read.structuredContent.record.revision, supersedesId: secondId });
  check('a replacement that would come back round is refused', loop.isError === true, JSON.stringify(loop).slice(0, 300));
  const stale = await call('update_historical_decision', { id: secondId, expectedRevision: 99, notes: '补一句' });
  check('a change on a revision that is not the latest is refused', stale.isError === true && /改过|重新/u.test(stale.content?.[0]?.text ?? ''), JSON.stringify(stale).slice(0, 300));

  const searched = await call('search_decision_context', { query: '首页待办入口放在哪一层', mode: 'keyword' });
  const searchedText = JSON.stringify(searched);
  check('search_decision_context does not return it', !searchedText.includes('放进主导航第六项') && !searchedText.includes(secondId), searchedText.slice(0, 400));
  const notes = await call('search_obsidian_notes', { query: '首页待办入口' });
  check('search_obsidian_notes does not return it either', !JSON.stringify(notes).includes('放进主导航第六项'), JSON.stringify(notes).slice(0, 400));

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
  await send('Emulation.setDeviceMetricsOverride', { width: 1160, height: 760, deviceScaleFactor: 1, mobile: false });
  await until('renderer API', () => evaluate('typeof window.decision?.listHistoricalDecisions === "function"'));
  await evaluate('(async () => { document.querySelector(\'[aria-label="知识"]\').click(); await new Promise((r) => setTimeout(r, 800)); document.getElementById("knowledge-tab-history").click(); await new Promise((r) => setTimeout(r, 800)); return true; })()');
  const rows = await until('rows', () => evaluate('(() => { const rows = [...document.querySelectorAll(".historical-row")].map((e) => e.innerText.replace(/\\n+/g, " / ")); return rows.length === 2 ? rows.join("\\n") : null; })()'));
  log.push({ step: 'page rows', rows });
  check('the 历史决定 tab lists both, newest decision first, each with its status', /^.*放进主导航第六项.*有效.*\n.*放在首页卡片区第二屏.*已替代/u.test(rows), rows);
  const header = await evaluate('document.querySelector(".desktop-view-meta")?.innerText.replace(/\\s+/g, " ")');
  check('the page header counts them', /2\s*历史决定/u.test(header ?? ''), header);
  await evaluate('(async () => { document.querySelector(".historical-row").click(); await new Promise((r) => setTimeout(r, 800)); return true; })()');
  const detail = await until('detail', () => evaluate('document.querySelector(".historical-detail")?.innerText.replace(/\\n+/g, " / ") ?? null'));
  log.push({ step: 'page detail', detail });
  check('the detail shows the decision, what was not chosen, and the one it replaced in the chain', detail.includes('放进主导航第六项') && detail.includes('只做全局快捷键，不放入口') && /前任 \/ 放在首页卡片区第二屏/u.test(detail), detail);
  check('the detail ends with its change history, folded, counting the one change so far', /变更历史 \/ 1 条/u.test(detail), detail.slice(-300));
  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(out, { recursive: true });
  if (shot.result?.data) await writeFile(join(out, `historical-decision-run-${label}-detail.png`), Buffer.from(shot.result.data, 'base64'));

  const current = (await call('get_historical_decision', { id: secondId })).structuredContent.record;
  const promoted = await call('update_historical_decision', { id: secondId, expectedRevision: current.revision, promote: true });
  const decisionId = promoted.structuredContent?.promotedDecisionId;
  check('转为正式决策 makes a decision record and links it', promoted.isError !== true && typeof decisionId === 'string' && promoted.structuredContent?.record?.promotedDecisionId === decisionId, JSON.stringify(promoted).slice(0, 400));
  const afterPromote = await files(journal);
  log.push({ step: 'vault files after promote', afterPromote });
  check('the decision record is a note of its own, outside history/', afterPromote.some((file) => !file.startsWith('history/')) && afterPromote.filter((file) => file.startsWith('history/')).length === 2, afterPromote.join(' | '));
  const found = await until('promoted decision in search', async () => {
    const result = await call('search_decision_context', { query: '首页待办入口放在哪一层', mode: 'keyword' });
    return JSON.stringify(result).includes('放进主导航第六项') ? result : null;
  }, 30_000).catch(() => null);
  check('and that decision record, unlike the 历史决定, is found by search_decision_context', found !== null);
  const twice = await call('update_historical_decision', { id: secondId, expectedRevision: promoted.structuredContent.record.revision, promote: true });
  check('it can be made into one only once', twice.isError === true, JSON.stringify(twice).slice(0, 300));

  const old = (await call('get_historical_decision', { id: firstId })).structuredContent.record;
  const withdrawn = await call('update_historical_decision', { id: firstId, expectedRevision: old.revision, expectedStatus: 'superseded', status: 'withdrawn', statusNote: '记错了' });
  check('withdrawing keeps the note and marks it 已撤回', withdrawn.structuredContent?.record?.status === 'withdrawn' && (await files(journal)).filter((file) => file.startsWith('history/')).length === 2, JSON.stringify(withdrawn).slice(0, 300));
  const listed = await call('list_historical_decisions', {});
  const all = await call('list_historical_decisions', { includeWithdrawn: true });
  check('the default list leaves it out, includeWithdrawn brings it back', listed.structuredContent?.total === 1 && all.structuredContent?.total === 2, JSON.stringify([listed.structuredContent?.total, all.structuredContent?.total]));
  const locked = await call('update_historical_decision', { id: firstId, expectedRevision: withdrawn.structuredContent.record.revision, notes: '再补一句' });
  check('a withdrawn record is read-only until it is active again', locked.isError === true, JSON.stringify(locked).slice(0, 300));
  const history = await call('get_historical_decision', { id: firstId });
  check('its change history is kept and returned', (history.structuredContent?.history?.length ?? 0) >= 3, JSON.stringify(history.structuredContent?.history).slice(0, 400));
  const withdrawal = history.structuredContent?.history?.find((event) => event.kind === 'status');
  check('the withdrawal is kept with the note it was given, before and after', withdrawal?.summary === '状态：已替代 → 已撤回' && withdrawal?.changes?.some((change) => change.field === '状态说明' && change.after === '记错了'), JSON.stringify(withdrawal));
  check('get_historical_decision says it in words too', /状态说明：（空） → 记错了/u.test(history.content?.[0]?.text ?? ''), history.content?.[0]?.text?.slice(-400));
  // Never opened for real here: a link the record does not name is refused before anything opens.
  const elsewhere = await call('open_historical_decision', { id: secondId, link: 'https://example.com/not-in-the-record' });
  check('open_historical_decision refuses what the record does not name', elsewhere.isError === true, JSON.stringify(elsewhere).slice(0, 300));
  // Written by an agent, the page follows without being asked: the withdrawn row is still listed under 全部, marked so.
  const after = await until('rows after withdraw', () => evaluate('(() => { const text = [...document.querySelectorAll(".historical-row")].map((e) => e.innerText.replace(/\\n+/g, " / ")).join("\\n"); return /已撤回/.test(text) ? text : null; })()'), 20_000).catch(() => null);
  check('the page follows an agent\'s change without a reload', after !== null && /已转正式决策/u.test(after), after);
} finally {
  const failed = checks.filter((entry) => !entry.ok);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `historical-decision-run-${label}-result.json`), `${JSON.stringify({ label, passed: checks.length - failed.length, failed: failed.length, checks, log }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length }));
  try { mcp?.close(); } catch { /* closing */ }
  try { socket?.close(); } catch { /* closing */ }
  child.kill('SIGTERM');
  await sleep(1500);
  await rm(root, { recursive: true, force: true });
  if (failed.length > 0) process.exitCode = 1;
}
