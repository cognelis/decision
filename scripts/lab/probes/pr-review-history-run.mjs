// 评审历史进主进程（IMP-194）end to end: the packaged App in an isolated root, its renderer driven over the DevTools
// protocol, and the packaged bridge's read-only PR review tools. A history the review page kept in the window's storage
// before is moved into the App's own files at the start and cleared there; the review page reads it back from the App;
// list_pr_reviews and get_pr_review read the same records. Synthetic data only: no user data is read or written.
// usage: node scripts/lab/probes/pr-review-history-run.mjs --app out/Paraself-darwin-arm64/Paraself.app \
//          --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge --label main --out DIR
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'pr-review-history-run-'));
const port = 9400 + Math.floor(Math.random() * 500);
const checks = [];
let runError = null; const cleanupErrors = [];
const check = (name, ok, evidence) => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const waitFor = async (probe, what, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${what} timed out`);
};

const KEY = 'decision.pr-review.history.v1';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const finding = (priority, title, body, line) => ({ priority, title, body, path: 'apps/auth/session.ts', side: 'new', line, decisionIndexes: [] });
// As a version before IMP-194 saved a review: the snapshot without a risk level, the guides read at the source commit.
const legacy = (n, at, findings) => ({
  id: uuid(n), kind: 'review', at, model: '合成模型', focus: '', draft: '', turns: [], connectionId: uuid(500), events: [], state: 'finished', error: '',
  snapshot: { snapshotId: uuid(100 + n), reference: 'SYN/app#7', title: '合成：会话续期', description: '', project: 'app',
    sourceCommit: 'a'.repeat(40), destinationCommit: 'b'.repeat(40), files: [{ path: 'apps/auth/session.ts', status: 'modified' }], warnings: [], guides: ['REVIEW.md'] },
  report: { status: 'completed', summary: '合成结论。', findings, evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 1, history: [] },
  published: [], verdicts: [], rechecks: [],
});
const history = [
  legacy(2, '2026-11-12T10:00:00.000Z', [finding('P1', '合成：续期没查吊销', '违反 REVIEW.md 第 2 条：续期前要检查吊销。', 88), finding('P2', '合成：错误码', '按 Ruleset 1 应返回 401。', 41)]),
  legacy(1, '2026-11-10T10:00:00.000Z', [finding('P3', '合成：日志', '建议补日志。', 20)]),
];

const started = await startIsolatedApp({ root, executable: executableOf(app), debugPort: port });
let socket;
let mcp;
try {
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((item) => item.type === 'page'), 'renderer');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = (message) => { const response = JSON.parse(message.data); pending.get(response.id)?.(response); pending.delete(response.id); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20_000);
    pending.set(id, (response) => { clearTimeout(timer); response.error ? reject(new Error(JSON.stringify(response.error))) : resolve(response.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await waitFor(() => evaluate('typeof window.decision?.listPrReviewHistory === "function"'), 'renderer API');

  // The window's storage as a version before kept the history, then the App starting again: the start moves it.
  await evaluate(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(history))}); true`);
  await send('Page.reload');
  await waitFor(() => evaluate(`typeof window.decision?.listPrReviewHistory === "function" && localStorage.getItem(${JSON.stringify(KEY)}) === null`), 'the old history moved and cleared');
  const files = (await readdir(join(started.env.PARASELF_USER_DATA, 'pr-review-history'))).sort();
  check('the start moved the old history into the App, a file per record, and cleared the window\'s copy', files.join() === [`${uuid(1)}.json`, `${uuid(2)}.json`].join(), files);
  const listed = await evaluate('window.decision.listPrReviewHistory()');
  check('the App lists them newest first', listed.unreadable === 0 && listed.entries.map((entry) => entry.id).join() === [uuid(2), uuid(1)].join(), listed);

  // The review page reads its history from the App now.
  await evaluate('document.querySelector(\'[aria-label="评审"]\').click(); true');
  const tab = await waitFor(() => evaluate('[...document.querySelectorAll("button")].map((button) => button.textContent.replace(/\\s+/gu, "")).find((text) => text.startsWith("历史评审")) ?? ""'), 'the review page');
  const counted = await waitFor(() => evaluate('[...document.querySelectorAll("button")].map((button) => button.textContent.replace(/\\s+/gu, "")).find((text) => text === "历史评审2") ?? ""'), 'the review history count').catch(() => '');
  check('the review page shows the moved records', counted === '历史评审2', tab);

  mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
  const call = async (name, args) => {
    const response = await mcp.call(name, args);
    return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', error: response.error ?? null };
  };
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  check('the bridge has the three read-only PR review tools', ['list_prs', 'list_pr_reviews', 'get_pr_review'].every((name) => tools.includes(name)), tools);
  const records = await call('list_pr_reviews', { reference: 'SYN/app#7' });
  check('list_pr_reviews reads the moved records, with their rounds', !records.isError && records.text.includes('共 2 条评审记录') && records.text.includes('第 2 轮评审完成') && records.text.includes('第 1 轮评审完成'), records);
  const read = await call('get_pr_review', { id: uuid(2) });
  check('get_pr_review says what each finding stands on', !read.isError && read.text.includes('依据 REVIEW.md（仓库规则）') && read.text.includes('依据 本机评审规则（个人依据 · 只作建议）'), read);
  const prs = await call('list_prs', {});
  check('list_prs says no code platform is connected yet', !prs.isError && prs.text.includes('还没有连接代码平台'), prs);
} catch (error) { runError = error instanceof Error ? error.stack : String(error); }
finally {
  try { socket?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { mcp?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  await started.stop().catch((error) => cleanupErrors.push(String(error)));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'pr-review-history-run', label, 'result', { build, root, checks, error: runError, cleanupErrors, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0 && runError === null && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 && runError === null && cleanupErrors.length === 0 ? 0 : 1;
