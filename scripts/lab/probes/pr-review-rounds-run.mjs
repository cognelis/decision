// 按提交增量评审与 run_pr_review（IMP-197）end to end: the packaged App in an isolated root, a synthetic Bitbucket Data
// Center and an OpenAI-compatible stub model on loopback, the packaged bridge, and the review page driven over the
// DevTools protocol. An agent starts a review through the bridge; the page, open on the PR, lists it as under way and
// holds its own start until it ends; a second start meanwhile is refused; the record gets the stub's finding. After a
// new commit, the second round reviews only the file that commit changed, read from the platform's diff of the two
// commits. Then 自动预评审 (IMP-201), off until turned on through the bridge: on, it reviews the PR's third commit by itself,
// marked automatic, within the day's one review; turned off, the link stays as it was. Synthetic data only: no user data is read or written; the platform and the model are local fakes, and the key
// is a fake one kept in the isolated root (local credentials, no keychain).
// usage: node scripts/lab/probes/pr-review-rounds-run.mjs --app out/Paraself-darwin-arm64/Paraself.app \
//          --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge --label main --out DIR
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'pr-review-rounds-run-'));
const port = 9400 + Math.floor(Math.random() * 500);
const FAKE_KEY = 'lab-not-a-secret-pr-review-rounds';
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what} timed out`);
};

// The synthetic platform: one open PR. Its first commit changes session.ts; a second one, pushed between the rounds, adds token.ts.
const first = 'a'.repeat(40), second = 'd'.repeat(40), third = 'e'.repeat(40), base = 'b'.repeat(40);
const endpoint = '/rest/api/1.0/projects/SYN/repos/app/pull-requests/9';
const ref = (displayId, latestCommit) => ({ id: `refs/heads/${displayId}`, displayId, latestCommit, repository: { slug: 'app', project: { key: 'SYN' } } });
const pr = {
  id: 9, version: 1, state: 'OPEN', title: '合成：会话续期改为滑动过期', description: '合成描述。', updatedDate: Date.parse('2026-11-12T10:00:00.000Z'),
  author: { user: { name: 'synthetic-author', displayName: '合成作者' } }, fromRef: ref('feature/renew', first), toRef: ref('main', base),
  reviewers: [{ user: { name: 'synthetic-reviewer', displayName: '合成审阅人', type: 'NORMAL' }, approved: false, status: 'UNAPPROVED' }], participants: [], properties: { commentCount: 0, openTaskCount: 0 },
};
const SESSION_LINE = '合成：会话窗口写死', TOKEN_LINE = '合成：令牌吊销不过期';
const sessionDiff = ['diff --git a/apps/auth/session.ts b/apps/auth/session.ts', '--- a/apps/auth/session.ts', '+++ b/apps/auth/session.ts', '@@ -1,3 +1,4 @@',
  ' export const renew = (session) => {', `+  const window = 30; // ${SESSION_LINE}`, '   return { ...session, expires: Date.now() + window };', ' };', ''].join('\n');
const tokenDiff = ['diff --git a/apps/auth/token.ts b/apps/auth/token.ts', 'new file mode 100644', '--- /dev/null', '+++ b/apps/auth/token.ts', '@@ -0,0 +1,3 @@',
  '+export const revoked = new Set();', `+export const isRevoked = (id) => revoked.has(id); // ${TOKEN_LINE}`, '+export const revoke = (id) => revoked.add(id);', ''].join('\n');
const sources = {
  'apps/auth/session.ts': `export const renew = (session) => {\n  const window = 30; // ${SESSION_LINE}\n  return { ...session, expires: Date.now() + window };\n};\n`,
  'apps/auth/token.ts': `export const revoked = new Set();\nexport const isRevoked = (id) => revoked.has(id); // ${TOKEN_LINE}\nexport const revoke = (id) => revoked.add(id);\n`,
};
const ranges = [];
const unknown = [];
const platform = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);
  const head = pr.fromRef.latestCommit;
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'x-ausername': 'synthetic-reviewer' }); response.end(JSON.stringify(body)); };
  const text = (body) => { response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); response.end(body); };
  if (request.method !== 'GET') { unknown.push(`${request.method} ${path}`); return json(405, { errors: [{ message: 'read only' }] }); }
  if (path === '/rest/api/1.0/dashboard/pull-requests') return json(200, { values: url.searchParams.get('state') === 'OPEN' && url.searchParams.get('role') === 'REVIEWER' ? [pr] : [], isLastPage: true });
  if (path === endpoint) return json(200, pr);
  if (path === `${endpoint}/changes`) return json(200, { isLastPage: true, values: [{ path: { toString: 'apps/auth/session.ts' }, type: 'MODIFY' }, ...(head !== first ? [{ path: { toString: 'apps/auth/token.ts' }, type: 'ADD' }] : [])] });
  if (path === `${endpoint}/diff`) return text(head !== first ? `${sessionDiff}${tokenDiff}` : sessionDiff);
  if (path === `${endpoint}/merge-base`) return json(200, { id: base });
  if (path === `${endpoint}/activities`) return json(200, { values: [], isLastPage: true });
  // What changed between two commits: only the second commit's file.
  if (path === '/rest/api/1.0/projects/SYN/repos/app/diff') {
    ranges.push({ since: url.searchParams.get('since'), until: url.searchParams.get('until') });
    // The third commit (自动预评审's round) is said to touch token.ts again.
    const since = url.searchParams.get('since'), until = url.searchParams.get('until');
    return text((since === first && until === second) || (since === second && until === third) ? tokenDiff : '');
  }
  if (path.startsWith('/rest/build-status/1.0/commits/stats/')) return json(200, { successful: 1, inProgress: 0, failed: 0 });
  if (path === '/rest/api/1.0/users/synthetic-reviewer') return json(200, { slug: 'synthetic-reviewer', name: 'synthetic-reviewer' });
  const raw = /^\/rest\/api\/1\.0\/projects\/SYN\/repos\/app\/raw\/(.+)$/u.exec(path);
  if (raw && sources[raw[1]] !== undefined && url.searchParams.get('at') !== base) return text(sources[raw[1]]);
  unknown.push(`${request.method} ${path}${url.search}`);
  return json(404, { errors: [{ message: 'not on the synthetic platform' }] });
});
await new Promise((resolve) => platform.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${platform.address().port}`;

// The stub model: a reviewer that concludes at once with one finding on the changed line it was given, and a verifier
// that confirms every candidate. A gate holds the reviewer while the page is looked at.
const calls = [];
let gate = null, release = () => undefined;
const stub = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  const parsed = JSON.parse(body);
  const said = (role) => parsed.messages.filter((message) => message.role === role).map((message) => typeof message.content === 'string' ? message.content : message.content.map((part) => part.text ?? '').join('')).join('\n');
  const system = said('system'), user = said('user');
  const kind = system.includes('只读 PR 评审核验员') ? 'verify' : system.includes('只读 PR 评审员') ? 'review' : 'other';
  calls.push({ kind, user, at: Date.now() });
  if (kind === 'review' && gate) await gate;
  let answer;
  if (kind === 'review') {
    const token = user.includes(TOKEN_LINE);
    answer = { actions: [{ action: 'finish_review', summary: '合成结论。', checked: [], findings: [token
      ? { priority: 'P2', title: '合成：吊销集合只增不减', body: '合成：revoked 只加不删，长期运行会一直变大。', path: 'apps/auth/token.ts', side: 'new', line: 2, decisionIndexes: [] }
      : { priority: 'P2', title: '合成：会话窗口写死', body: '合成：窗口时长写死在代码里，改配置不生效。', path: 'apps/auth/session.ts', side: 'new', line: 2, decisionIndexes: [] }] }] };
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
  const shoot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, `pr-review-rounds-run-${label}-${name}.png`), Buffer.from(shot.data, 'base64'));
  };
  await waitFor(() => evaluate('typeof window.decision?.savePrConnection === "function"'), 'renderer API');

  // The link to the synthetic platform and the stub model, both kept in the App's own files.
  await evaluate('window.decision.setLocalCredentialsEnabled(true).then(() => true)');
  await evaluate(`window.decision.savePrConnection(${JSON.stringify({ label: '合成 Bitbucket', platform: 'bitbucket-server', baseUrl, token: 'synthetic-token' })})`);
  const priority = Math.max(-1, ...(await evaluate('window.decision.listModelProviderProfiles()')).map((item) => item.priority)) + 1;
  await evaluate(`window.decision.saveModelProviderProfile(${JSON.stringify({ profile: { version: 1, profileId: 'lab-stub', kind: 'openai-compatible', label: '实验桩', enabled: true, priority, model: 'stub-model', timeoutMs: 60_000,
    baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiProtocol: 'chat-completions', credentialConfigured: false, proxy: { mode: 'direct' }, fallbackOnFailure: false }, secret: FAKE_KEY })}).then(() => true)`);
  await send('Page.reload');
  await waitFor(() => evaluate('typeof window.decision?.listPrReviewHistory === "function"'), 'renderer API after reload');

  // The review page, open on the PR, before any review of it.
  await waitFor(() => evaluate('(() => { const nav = document.querySelector(\'[aria-label="评审"]\'); nav?.click(); return Boolean(nav); })()'), 'the review page');
  await waitFor(() => evaluate('(() => { const item = [...document.querySelectorAll(".review-pr-item")].find((button) => button.textContent.includes("合成：会话续期")); item?.click(); return Boolean(item); })()'), 'the PR row');
  await waitFor(() => evaluate('[...document.querySelectorAll("button")].some((button) => button.textContent === "开始评审")'), 'the review composer');

  mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
  const call = async (name, args) => {
    const response = await mcp.call(name, args);
    return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', data: response.result?.structuredContent?.prReview ?? null, error: response.error ?? null };
  };
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  check('the bridge has run_pr_review', tools.includes('run_pr_review'), tools);

  // Round 1, started by the agent: the reviewer held at the stub while the page is looked at.
  gate = new Promise((resolve) => { release = resolve; });
  const one = await call('run_pr_review', { reference: 'SYN/app#9', model: 'lab-stub' });
  const firstId = one.data?.run?.id;
  check('run_pr_review starts the first round with the stub model and answers at once with the record',
    !one.isError && typeof firstId === 'string' && one.text.startsWith('已开始评审 SYN/app#9「合成：会话续期改为滑动过期」：第 1 轮') && one.text.includes('模型 实验桩 · stub-model') && !one.text.includes('只看提交'), one);
  const busy = await call('run_pr_review', { reference: 'SYN/app#9', model: 'lab-stub' });
  check('a second start while it runs is refused, one review at a time', busy.isError && busy.text.includes('已有评审正在运行'), busy);
  const held = await waitFor(() => evaluate('(() => { const note = [...document.querySelectorAll(\'[role="note"]\')].find((item) => item.textContent.startsWith("agent 发起的评审")); const start = [...document.querySelectorAll("button")].find((button) => button.textContent === "开始评审"); return note && start?.disabled ? note.textContent : null; })()'), 'the page holding its start').catch(() => '');
  check('the open page holds its own start while the agent\'s review runs, and says why', held === 'agent 发起的评审（SYN/app#9）正在 App 后台进行，结束后才能开始新的。', held);
  await evaluate('[...document.querySelectorAll("button")].find((button) => /^历史评审/u.test(button.textContent)).click(); true');
  const listed = await waitFor(() => evaluate('(() => { const first = document.querySelector(\'[aria-label="历史评审"] button\'); return first?.textContent.includes("评审中") ? first.textContent : null; })()'), 'the record under way in the list').catch(() => '');
  check('the page lists the agent\'s review as under way, not as interrupted', listed.includes('评审中'), listed);
  const running = await call('get_pr_review', { id: firstId });
  check('get_pr_review says it is running', running.text.includes('第 1 轮评审进行中'), running.text.slice(0, 400));
  await shoot('running');
  release(); gate = null;

  const done = await waitFor(async () => { const read = await call('get_pr_review', { id: firstId }); return read.text.includes('合成：会话窗口写死') ? read : null; }, 'the first round to end', 90_000).catch(() => null);
  check('the record gets the stub\'s finding once the review ends', done !== null && done.text.includes('第 1 轮评审完成'), done?.text.slice(0, 600));
  const shown = await waitFor(() => evaluate('(() => { const first = document.querySelector(\'[aria-label="历史评审"] button\'); return first?.textContent.includes("评审完成") ? first.textContent : null; })()'), 'the page showing it finished').catch(() => '');
  const freed = await evaluate('[...document.querySelectorAll(\'[role="note"]\')].some((item) => item.textContent.startsWith("agent 发起的评审"))');
  check('the page shows it finished without a reload, and lets go of its start', shown.includes('1 个问题') && freed === false, { shown, freed });
  const kept = JSON.parse(await readFile(join(started.env.PARASELF_USER_DATA, 'pr-review-history', `${firstId}.json`), 'utf8'));
  check('the App keeps the record: finished, with its report and steps', kept.state === 'finished' && kept.report?.findings?.[0]?.title === '合成：会话窗口写死' && kept.report.history.length === 0 && kept.events.length > 0,
    { state: kept.state, findings: kept.report?.findings, events: kept.events?.length });

  // A second commit on the PR, adding token.ts: the next round reviews only that.
  pr.fromRef = ref('feature/renew', second); pr.version += 1; pr.updatedDate += 60_000;
  const before = calls.length;
  const two = await call('run_pr_review', { reference: 'SYN/app#9', model: 'lab-stub' });
  const secondId = two.data?.run?.id;
  check('the second round reviews what came after the first one', !two.isError && two.text.includes('第 2 轮') && two.text.includes('只看提交 aaaaaaaaaaaa 之后的改动'), two);
  const again = await waitFor(async () => { const read = await call('get_pr_review', { id: secondId }); return read.text.includes('第 2 轮评审完成') ? read : null; }, 'the second round to end', 90_000).catch(() => null);
  check('it finds the new commit\'s problem and says it was incremental', again !== null && again.text.includes('合成：吊销集合只增不减') && !again.text.includes('合成：会话窗口写死')
    && again.text.includes('增量评审：只看提交 aaaaaaaaaaaa 之后改动的 1 个文件'), again?.text.slice(0, 900));
  const reviewed = calls.slice(before).filter((item) => item.kind === 'review');
  check('the reviewer was given only the new commit\'s file, read from the platform\'s diff of the two commits',
    reviewed.length > 0 && reviewed.every((item) => item.user.includes(TOKEN_LINE) && !item.user.includes(SESSION_LINE)) && ranges.some((item) => item.since === first && item.until === second),
    { reviewed: reviewed.map((item) => item.user.slice(0, 300)), ranges });
  const round = await waitFor(() => evaluate('(() => { const first = document.querySelector(\'[aria-label="历史评审"] button\'); return first?.textContent.includes("第 2 轮") ? first.textContent : null; })()'), 'the page showing round 2').catch(() => '');
  check('the page lists it as round 2', round.includes('第 2 轮'), round);
  await shoot('round-2');

  // 自动预评审: off until turned on; on, the PR's next commit is reviewed by itself, within the day's one review.
  check('the bridge has the 自动预评审 settings tools', ['get_pr_review_settings', 'update_pr_review_settings'].every((name) => tools.includes(name)), tools);
  const offAtFirst = await call('get_pr_review_settings', {});
  check('自动预评审 is off until turned on', !offAtFirst.isError && offAtFirst.text.includes('自动预评审没开'), offAtFirst.text);
  pr.fromRef = ref('feature/renew', third); pr.version += 1; pr.updatedDate = Date.now();
  const turnedOn = await call('update_pr_review_settings', { autoReview: true, model: 'lab-stub', dailyReviews: 1 });
  check('turned on with the stub model and one review a day', !turnedOn.isError && turnedOn.text.includes('已打开自动预评审') && turnedOn.text.includes('每天最多 1 次'), turnedOn.text);
  const auto = await waitFor(async () => { const read = await call('list_pr_reviews', { reference: 'SYN/app#9' }); return read.text.includes('第 3 轮自动预评审') ? read : null; }, 'the automatic review to start').catch(() => null);
  check('it starts round 3 by itself on the new commit, marked 自动预评审', auto !== null, auto?.text?.slice(0, 600));
  const spent = await call('get_pr_review_settings', {});
  check('the day\'s one review is spent', spent.text.includes('今天用了 1 次，今天的额度用完了'), spent.text);
  const marked = await waitFor(() => evaluate('(() => { const first = document.querySelector(\'[aria-label="历史评审"] button\'); return first?.textContent.includes("自动 · ") ? first.textContent : null; })()'), 'the page marking it automatic').catch(() => '');
  check('the page lists it as automatic', marked.includes('自动 · '), marked);
  const ended = await waitFor(async () => { const read = await call('list_pr_reviews', { reference: 'SYN/app#9' }); return read.text.includes('第 3 轮自动预评审完成') ? read : null; }, 'the automatic review to end', 90_000).catch(() => null);
  check('the automatic round ends with its report', ended !== null, ended?.text?.slice(0, 600));
  await shoot('auto-review');
  const turnedOff = await call('update_pr_review_settings', { autoReview: false });
  check('turned off again', !turnedOff.isError && turnedOff.text.includes('已关闭自动预评审') && turnedOff.text.includes('自动预评审没开'), turnedOff.text);
} catch (error) { runError = error instanceof Error ? error.stack : String(error); }
finally {
  release();
  try { socket?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { mcp?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  await started.stop().catch((error) => cleanupErrors.push(String(error)));
  await new Promise((resolve) => platform.close(resolve));
  await new Promise((resolve) => stub.close(resolve));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'pr-review-rounds-run', label, 'result', { build, root, checks, calls: calls.map((item) => item.kind), unknownRequests: unknown, error: runError, cleanupErrors, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0 && runError === null && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 && runError === null && cleanupErrors.length === 0 ? 0 : 1;
