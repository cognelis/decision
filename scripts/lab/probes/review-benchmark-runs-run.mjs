// 评测运行 (IMP-204) end to end: the packaged App in an isolated root, its packaged bridge as an agent calls it, the review
// page over the DevTools protocol, a synthetic Git repository made here and an OpenAI-compatible stub model on loopback.
// Two cases are recorded and confirmed through the bridge; the benchmark is run twice, each case replayed from the
// repository's fixed commits with the App's own review; the second run is compared with the first, and the review
// quality page's 评测集 shows the same. Synthetic data only: no user data is read or written; the model is a local fake,
// and its key a fake one kept in the isolated root (local credentials, no keychain).
// usage: node scripts/lab/probes/review-benchmark-runs-run.mjs --app out/Paraself-darwin-arm64/Paraself.app \
//          --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge --label main --out DIR
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'review-benchmark-runs-run-'));
const port = 9400 + Math.floor(Math.random() * 500);
const FAKE_KEY = 'lab-not-a-secret-review-benchmark-runs';
const checks = [];
let runError = null; const cleanupErrors = [];
const check = (name, ok, evidence) => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
};
const waitFor = async (probe, what, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${what} timed out`);
};

// The repository: a defect brought in at session.ts line 1 and fixed after; then, on top, a clean change to list.ts.
const repository = join(root, 'repo');
const gitEnv = {
  PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
await mkdir(repository);
git('init', '-q', '-b', 'main');
git('remote', 'add', 'origin', 'https://example.test/demo/benchmark-runs.git');
await writeFile(join(repository, 'session.ts'), 'export const window = config.window;\n');
await writeFile(join(repository, 'list.ts'), 'export const list = (rows) => rows;\n');
git('add', '.'); git('commit', '-qm', 'Initial');
const base = git('rev-parse', 'HEAD');
await writeFile(join(repository, 'session.ts'), 'export const window = 30;\n');
git('commit', '-qam', 'Hard-code the window');
const head = git('rev-parse', 'HEAD');
await writeFile(join(repository, 'session.ts'), 'export const window = config.window ?? 30;\n');
git('commit', '-qam', 'Read the window again');
const fix = git('rev-parse', 'HEAD');
await writeFile(join(repository, 'list.ts'), 'export const list = (rows) => rows;\nexport const count = (rows) => rows.length;\n');
git('commit', '-qam', 'Count the rows');
const clean = git('rev-parse', 'HEAD');

// The stub model: a reviewer that names line 1 of whichever file it was given, and a verifier that confirms them.
const calls = [];
const stub = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  const parsed = JSON.parse(body);
  const said = (role) => parsed.messages.filter((message) => message.role === role).map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text ?? '').join('')).join('\n');
  const system = said('system'), user = said('user');
  const kind = system.includes('只读 PR 评审核验员') ? 'verify' : system.includes('只读 PR 评审员') ? 'review' : 'other';
  calls.push(kind);
  let answer;
  if (kind === 'review') {
    const session = user.includes('session.ts');
    answer = { actions: [{ action: 'finish_review', summary: '合成结论。', checked: [], findings: [session
      ? { priority: 'P2', title: '合成：窗口写死', body: '合成：窗口时长写死，改配置不生效。', path: 'session.ts', side: 'new', line: 1, decisionIndexes: [] }
      : { priority: 'P3', title: '合成：列表要分页', body: '合成：列表一次返回全部。', path: 'list.ts', side: 'new', line: 2, decisionIndexes: [] }] }] };
  } else if (kind === 'verify') {
    const ids = [...new Set([...user.slice(Math.max(0, user.indexOf('"candidates"'))).matchAll(/"id":(\d+)/gu)].map((match) => Number(match[1])))];
    answer = { verdicts: ids.map((id) => ({ id, verdict: 'confirmed', reason: '合成：核验成立。', missing: null })), reads: null, sourceReads: null };
  } else { response.writeHead(400).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    id: `stub-${calls.length}`, model: 'stub-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }],
    usage: { prompt_tokens: Math.ceil(body.length / 2), completion_tokens: 80, total_tokens: Math.ceil(body.length / 2) + 80 },
  }));
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubPort = stub.address().port;

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
  await waitFor(() => evaluate('typeof window.decision?.saveModelProviderProfile === "function"'), 'renderer API');
  await evaluate('window.decision.setLocalCredentialsEnabled(true).then(() => true)');
  const priority = Math.max(-1, ...(await evaluate('window.decision.listModelProviderProfiles()')).map((item) => item.priority)) + 1;
  await evaluate(`window.decision.saveModelProviderProfile(${JSON.stringify({ profile: { version: 1, profileId: 'lab-stub', kind: 'openai-compatible', label: '实验桩', enabled: true, priority, model: 'stub-model', timeoutMs: 60_000,
    baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiProtocol: 'chat-completions', credentialConfigured: false, proxy: { mode: 'direct' }, fallbackOnFailure: false }, secret: FAKE_KEY })}).then(() => true)`);

  mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
  const call = async (name, args) => {
    const response = await mcp.call(name, args);
    return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', body: response.result?.structuredContent ?? null, error: response.error ?? null };
  };
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  check('the bridge has the three benchmark run tools', ['run_review_benchmark', 'list_review_benchmark_runs', 'get_review_benchmark_run'].every((name) => tools.includes(name)), tools);

  // Two cases, recorded and confirmed as the user said they checked them.
  const recorded = await call('record_review_benchmark_cases', { repositoryPath: repository, cases: [
    { set: 'defect', title: '合成：会话续期', headSha: head, targetSha: base, provenance: [{ kind: 'fix_commit', reference: fix }],
      issues: [{ title: '合成：窗口写死', priority: 'P2', evidence: '合成：改配置不生效，后来改回读配置。', fixShas: [fix], locations: [{ path: 'session.ts', side: 'new', startLine: 1, endLine: 1 }] }] },
    { set: 'clean', title: '合成：数行数', headSha: clean, targetSha: fix, mergedAt: '2026-01-02', cleanEvidence: '合成：合并后没有回滚。', provenance: [{ kind: 'sampling', reference: '合成抽样' }] },
  ] });
  const cases = recorded.body?.reviewBenchmark?.cases ?? [];
  for (const item of cases) await call('update_review_benchmark_case', { repositoryPath: repository, caseId: item.caseId, expectedStatus: 'candidate', status: 'confirmed', userConfirmation: '合成：核对过了。' });
  const defectSplit = cases[0]?.split, cleanTogether = cases[1]?.split === defectSplit;
  check('both cases are recorded and confirmed', cases.length === 2 && cases.every((item) => item.outcome === 'recorded'), recorded.text);

  const run = async (name) => {
    const begun = await call('run_review_benchmark', { repositoryPath: repository, label: name, split: defectSplit, model: 'lab-stub' });
    const id = /运行 id ([0-9a-f-]{36})/u.exec(begun.text)?.[1];
    const done = id ? await waitFor(async () => { const read = await call('get_review_benchmark_run', { id }); return /已跑完|失败|已中断/u.test(read.text.split('\n')[0]) ? read : null; }, `the run ${name}`, 120_000).catch(() => null) : null;
    return { begun, id, done };
  };
  const first = await run('合成：基线');
  check('run_review_benchmark starts the replay of the confirmed cases with the stub model', !first.begun.isError && first.begun.text.startsWith('已开始评测「合成：基线」') && first.begun.text.includes('模型 实验桩 · stub-model'), first.begun.text);
  check('the run ends with the defect found at its place, from the repository\'s fixed commits', first.done?.text.includes('已跑完') && first.done.text.includes('缺陷集 1 个：命中 1/1 个问题'), first.done?.text);
  check('a holdout run keeps its cases back; a dev run shows them', defectSplit === 'holdout' ? first.done?.text.includes('留出集的逐个样本不给看') : first.done?.text.includes('逐个样本：'), { defectSplit, text: first.done?.text });
  const second = await run('合成：改了提示');
  const compared = second.done?.text ?? '';
  check('the second run is compared with the first: recall level, the gate\'s word said',
    compared.includes(`和 ${first.id} 对比：`) && compared.includes('- 缺陷命中（1 个问题）：1 → 1') && (cleanTogether ? compared.includes('判完再决定') : compared.includes('召回没降')), { cleanTogether, compared });
  check('the review ran the stub for each case and verified each finding', calls.filter((kind) => kind === 'review').length >= (cleanTogether ? 4 : 2) && calls.includes('verify'), calls);
  const listed = await call('list_review_benchmark_runs', { repositoryPath: repository });
  check('list_review_benchmark_runs lists both, newest first', /^评测 2 次，新的在前：\n[0-9a-f-]{36} · 「合成：改了提示」/u.test(listed.text), listed.text);

  // The review page's 评测集 shows the repository run here, its sets and the comparison.
  await send('Page.reload');
  await waitFor(() => evaluate('typeof window.decision?.reviewBenchmarkPage === "function"'), 'renderer API after reload');
  await evaluate('window.decision.openSurface("pr-review").then(() => true)');
  await waitFor(() => evaluate('(() => { const tab = [...document.querySelectorAll(".review-list-tabs button")].find((button) => button.textContent.startsWith("评审质量")); tab?.click(); return Boolean(tab); })()'), 'the quality tab');
  await waitFor(() => evaluate('(() => { const item = [...document.querySelectorAll(".review-pr-item")].find((button) => button.textContent.startsWith("评测集")); item?.click(); return Boolean(item); })()'), 'the benchmark item');
  const page = await waitFor(() => evaluate('(() => { const view = document.querySelector("[aria-label=\\"评测集\\"]"); const text = view?.textContent ?? ""; return text.includes("改动前后对比") && text.includes("合成：改了提示") ? text : null; })()'), 'the benchmark view').catch(() => '');
  check('the 评测集 page shows the sets, the latest run and its comparison', page.includes('缺陷集 · 1 个') && page.includes('改动：合成：改了提示') && page.includes('缺陷命中（1 个问题）'), page.slice(0, 1_200));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `review-benchmark-runs-run-${label}-page.png`), Buffer.from(shot.data, 'base64'));
  const files = await readdir(join(started.env.PARASELF_USER_DATA, 'review-benchmark-runs')).catch(() => []);
  check('each run is kept in its own file in the App\'s data', files.filter((name) => name.endsWith('.json')).length === 2, files);
} catch (error) { runError = error instanceof Error ? error.stack : String(error); }
finally {
  try { socket?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { mcp?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  await started.stop().catch((error) => cleanupErrors.push(String(error)));
  await new Promise((resolve) => stub.close(resolve));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'review-benchmark-runs-run', label, 'result', { build, root, checks, calls, error: runError, cleanupErrors, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0 && runError === null && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 && runError === null && cleanupErrors.length === 0 ? 0 : 1;
