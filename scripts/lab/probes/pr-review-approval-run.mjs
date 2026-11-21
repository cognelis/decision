// 批准条件、阻塞项与评审的写工具（IMP-195、IMP-196）end to end: the packaged App in an isolated root, a synthetic Bitbucket Data
// Center on loopback, the renderer driven over the DevTools protocol, and the packaged bridge. The review page shows the
// PR's build, approvals and open tasks as the platform reports them; list_prs carries the same; record_pr_comments posts
// a P1 as a task (a BLOCKER comment) and records it; update_pr_review_finding turns one down; the page, open all along,
// shows both without being reloaded and does not save its older copy over them. A finding another reviewer's Paraself
// posted at its place is not posted again unless asked; an approval on an older commit is not counted; a repository
// that does not hold merges on open tasks is said so; the description's missing part is drafted and written back over
// the version read, from the page and by the tools. Synthetic data only: no user data is read or written, and the
// platform is a local fake.
// usage: node scripts/lab/probes/pr-review-approval-run.mjs --app out/Paraself-darwin-arm64/Paraself.app \
//          --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge --label main --out DIR
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'pr-review-approval-run-'));
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

// The synthetic platform: one open PR, approved by one person and a service account, one open task, a passing build.
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const endpoint = '/rest/api/1.0/projects/SYN/repos/app/pull-requests/7';
const ref = (displayId, latestCommit) => ({ id: `refs/heads/${displayId}`, displayId, latestCommit, repository: { slug: 'app', project: { key: 'SYN' } } });
const pr = {
  id: 7, version: 3, state: 'OPEN', title: '合成：会话续期改为滑动过期', description: '## 验证\n合成单测。\n\n## 风险\n认证。',
  updatedDate: Date.parse('2026-11-12T10:00:00.000Z'), author: { user: { name: 'synthetic-author', displayName: '合成作者' } },
  fromRef: ref('feature/renew', head), toRef: ref('main', base),
  reviewers: [{ user: { name: 'synthetic-reviewer', displayName: '合成审阅人', type: 'NORMAL' }, approved: true, status: 'APPROVED', lastReviewedCommit: 'a'.repeat(40) },
    { user: { name: 'synthetic-ci', displayName: '合成 CI', type: 'SERVICE' }, approved: true, status: 'APPROVED' },
    // Approved an earlier commit and has not looked since: not counted.
    { user: { name: 'synthetic-earlier', displayName: '合成早审人', type: 'NORMAL' }, approved: true, status: 'APPROVED', lastReviewedCommit: 'c'.repeat(40) }],
  participants: [], properties: { commentCount: 0, openTaskCount: 1 },
};
// 评审质量: one PR merged yesterday, opened the day before; a person approved it four hours in, a CI account too; one
// person's comment and one Paraself pre-review comment on it.
const mergedEndpoint = '/rest/api/1.0/projects/SYN/repos/app/pull-requests/6';
const mergedAt = Date.now() - 86_400_000, openedAt = mergedAt - 86_400_000;
const merged = { ...pr, id: 6, state: 'MERGED', title: '合成：导出时区', createdDate: openedAt, closedDate: mergedAt, updatedDate: mergedAt };
// 漏网 (IMP-203): a later PR, merged an hour after, that says it fixes #6.
const fixing = { ...pr, id: 8, state: 'MERGED', title: '合成：修复导出时区', description: '修复 #6：导出时间按服务器时区格式化。', createdDate: mergedAt + 1_800_000, closedDate: mergedAt + 3_600_000, updatedDate: mergedAt + 3_600_000 };
const fixingEndpoint = '/rest/api/1.0/projects/SYN/repos/app/pull-requests/8';
const mergedActivities = [
  { action: 'APPROVED', createdDate: openedAt + 4 * 3_600_000, user: { name: 'synthetic-reviewer', type: 'NORMAL' } },
  { action: 'APPROVED', createdDate: openedAt + 3_600_000, user: { name: 'synthetic-ci', type: 'SERVICE' } },
  { action: 'COMMENTED', comment: { id: 601, text: '时区要按用户的来。', createdDate: openedAt + 3_600_000, author: { name: 'synthetic-b' } } },
  { action: 'COMMENTED', comment: { id: 602, text: '**P2 · 时区写死**\n\n……\n\n— Paraself 预评审 · P2', createdDate: openedAt + 2 * 3_600_000, author: { name: 'synthetic-reviewer' } } },
];
const posted = [];
// What was posted, as the PR's activities then list it: the author's answer goes under the first (发布后跟踪结果).
const postedActivities = [];
const unknown = [];
const descriptions = [];
// Another reviewer's Paraself said the 窗口写死 finding already, a line away.
const elsewhere = { action: 'COMMENTED', comment: { id: 901, text: '**P2 · 续期窗口不能改**\n\n……\n\n— Paraself 预评审 · P2', createdDate: Date.parse('2026-11-12T11:00:00.000Z'), author: { displayName: '合成审阅人 B', name: 'synthetic-b' } },
  commentAnchor: { path: 'apps/auth/session.ts', line: 31, fileType: 'TO' } };
const platform = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  // As a server reads it: a hook's key has its colon sent as %3A.
  Object.defineProperty(url, 'pathname', { value: decodeURIComponent(url.pathname) });
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'x-ausername': 'synthetic-reviewer' }); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && url.pathname === '/rest/api/1.0/dashboard/pull-requests') {
    const state = url.searchParams.get('state'), role = url.searchParams.get('role');
    return send(200, { values: role === 'REVIEWER' ? state === 'OPEN' ? [pr] : state === 'MERGED' ? [fixing, merged] : [] : [], isLastPage: true });
  }
  if (request.method === 'GET' && url.pathname === mergedEndpoint) return send(200, merged);
  if (request.method === 'GET' && url.pathname === `${mergedEndpoint}/activities`) return send(200, { values: mergedActivities, isLastPage: true });
  if (request.method === 'GET' && url.pathname === fixingEndpoint) return send(200, fixing);
  if (request.method === 'GET' && url.pathname === `${fixingEndpoint}/activities`) return send(200, { values: [], isLastPage: true });
  if (request.method === 'GET' && url.pathname === endpoint) return send(200, pr);
  if (request.method === 'GET' && url.pathname === `/rest/build-status/1.0/commits/stats/${head}`) return send(200, { successful: 2, inProgress: 0, failed: 0 });
  if (request.method === 'GET' && url.pathname === '/rest/api/1.0/users/synthetic-reviewer') return send(200, { slug: 'synthetic-reviewer', name: 'synthetic-reviewer' });
  if (request.method === 'GET' && url.pathname === `${endpoint}/changes`) return send(200, { isLastPage: true, values: [{ path: { toString: 'apps/auth/session.ts' }, type: 'MODIFY' }] });
  if (request.method === 'GET' && url.pathname === `${endpoint}/activities`) return send(200, { values: [...postedActivities].reverse().concat([elsewhere]), isLastPage: true });
  // The "no incomplete tasks" merge check is off in this repository.
  if (request.method === 'GET' && url.pathname === '/rest/api/1.0/projects/SYN/repos/app/settings/hooks/com.atlassian.bitbucket.server.bitbucket-bundled-hooks:incomplete-tasks-merge-check') return send(200, { enabled: false });
  if (request.method === 'PUT' && url.pathname === endpoint) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const update = JSON.parse(body);
      descriptions.push(update);
      if (update.version !== pr.version) return send(409, { errors: [{ message: 'version' }] });
      pr.description = update.description; pr.version += 1;
      return send(200, pr);
    });
    return undefined;
  }
  if (request.method === 'POST' && url.pathname === `${endpoint}/comments`) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const comment = JSON.parse(body);
      posted.push(comment);
      // A server on 7.2 or later keeps a BLOCKER comment as a task.
      const kept = { id: posted.length, text: comment.text, createdDate: Date.now(), author: { name: 'synthetic-reviewer', displayName: '合成审阅人' }, comments: [], ...(comment.severity ? { severity: comment.severity, state: 'OPEN' } : { severity: 'NORMAL' }) };
      if (comment.anchor) postedActivities.push({ action: 'COMMENTED', comment: kept, commentAnchor: { path: comment.anchor.path, line: comment.anchor.line, fileType: comment.anchor.fileType } });
      send(201, kept);
    });
    return undefined;
  }
  unknown.push(`${request.method} ${url.pathname}`);
  return send(404, { errors: [{ message: 'not on the synthetic platform' }] });
});
await new Promise((resolve) => platform.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${platform.address().port}`;

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const finding = (priority, title, body, line) => ({ priority, title, body, path: 'apps/auth/session.ts', side: 'new', line, decisionIndexes: [] });
const record = (connectionId) => ({
  id: uuid(1), kind: 'review', at: '2026-11-12T10:30:00.000Z', model: '合成模型', focus: '', draft: '', turns: [], connectionId, events: [], state: 'finished', error: '', listedComments: 0,
  snapshot: { snapshotId: uuid(101), reference: 'SYN/app#7', title: pr.title, description: pr.description, project: 'app', sourceCommit: head, destinationCommit: base,
    files: [{ path: 'apps/auth/session.ts', status: 'modified' }], warnings: [], guides: ['REVIEW.md'], destinationBranch: 'main',
    risk: { level: 'high', table: 'review_md', reasons: [{ level: 'high', reason: '认证与会话', paths: ['apps/auth/session.ts'], more: 0 }], changesRules: false, problems: [] } },
  report: { status: 'completed', summary: '合成结论。', evidence: [], readFiles: [], unreadFiles: [], reviewedFiles: [], unreviewedFiles: [], warnings: [], steps: 1, history: [], findings: [
    finding('P1', '合成：续期没查吊销', '违反 REVIEW.md 第 2 条：续期前要检查吊销。', 88),
    finding('P2', '合成：错误码不一致', '按 Ruleset 1 应返回 401。', 41),
    finding('P2', '合成：窗口写死', '窗口时长写死在代码里。', 30),
  ] },
  published: [], verdicts: [], rechecks: [],
});

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
  await waitFor(() => evaluate('typeof window.decision?.savePrConnection === "function"'), 'renderer API');

  // The link to the synthetic platform, its token kept in the App's own files (no keychain), and a finished review of its PR.
  await evaluate('window.decision.setLocalCredentialsEnabled(true).then(() => true)');
  const connections = await evaluate(`window.decision.savePrConnection(${JSON.stringify({ label: '合成 Bitbucket', platform: 'bitbucket-server', baseUrl, token: 'synthetic-token' })})`);
  const connectionId = connections[0].id;
  await evaluate(`window.decision.savePrReviewHistory(${JSON.stringify({ entries: [record(connectionId)], removed: [] })}).then(() => true)`);
  await send('Page.reload');
  await waitFor(() => evaluate('typeof window.decision?.listPrReviewHistory === "function"'), 'renderer API after reload');

  // The review page: the list row carries the build, the record the approval conditions, both from the platform.
  await waitFor(() => evaluate('(() => { const nav = document.querySelector(\'[aria-label="评审"]\'); nav?.click(); return Boolean(nav); })()'), 'the review page');
  const row = await waitFor(() => evaluate('(() => { const item = [...document.querySelectorAll(".review-pr-item")].find((button) => button.textContent.includes("合成：会话续期")); return item && item.textContent.includes("构建通过") ? item.textContent.replace(/\\s+/gu, " ") : ""; })()'), 'the PR row with its build').catch(() => '');
  check('the PR list row shows the build the platform reports', row.includes('构建通过'), row);
  await evaluate('[...document.querySelectorAll(".review-pr-item")].find((button) => button.textContent.includes("合成：会话续期")).click(); true');
  const read = (name) => `[...document.querySelectorAll('[aria-label="批准条件"] dt')].find((term) => term.textContent === ${JSON.stringify(name)})?.nextElementSibling?.textContent ?? ""`;
  const conditions = await waitFor(() => evaluate(`(() => { const values = { approvals: ${read('批准')}, build: ${read('构建')}, blockers: ${read('阻塞项')}, description: ${read('PR 描述')}, risk: ${read('风险等级')} }; return values.build && values.build !== "读取中…" ? values : null; })()`), 'the approval conditions').catch(() => ({}));
  check('the record shows the approval conditions as the platform has them: people only, on the head commit, against the high level\'s two',
    conditions.approvals === '1 / 2 · 1 人的批准在旧提交上 · 需含该区域负责人' && conditions.build === '通过' && conditions.blockers === '1 项未完成' && conditions.description === '缺撤回起草' && conditions.risk === '高风险认证与会话', conditions);
  const note = await evaluate('document.querySelector(\'[aria-label="批准条件"] > p\')?.textContent ?? ""');
  check('the conditions say the repository does not hold merges on open tasks', note.includes('仓库没有开启“没有未完成任务”的合并检查，阻塞项拦不住合并。') && note.includes('合成早审人 批准的是旧提交'), note);

  // The description's missing part, drafted from the conditions and written back over the version read.
  await evaluate('[...document.querySelectorAll(\'[aria-label="批准条件"] button\')].find((button) => button.textContent === "起草").click(); true');
  const drafted = await waitFor(() => evaluate('document.querySelector(\'textarea[aria-label="PR 描述"]\')?.value || null'), 'the description draft').catch(() => '');
  check('the draft keeps what the author wrote and adds the missing 撤回', drafted.startsWith('## 验证\n合成单测。\n\n## 风险\n认证。\n\n## 撤回\n\n（写明怎么撤回'), drafted);
  await evaluate(`(() => { const field = document.querySelector('textarea[aria-label="PR 描述"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify('## 验证\n合成单测。\n\n## 风险\n认证。\n\n## 撤回\n\n回退这个提交。')}); field.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await evaluate('[...document.querySelectorAll("button")].find((button) => button.textContent === "写回 PR 描述").click(); true');
  const rewritten = await waitFor(() => evaluate(`(() => { const value = ${read('PR 描述')}; return value === "验证、风险、撤回" ? value : null; })()`), 'the conditions after the write').catch(() => '');
  check('the page writes it back with the title and reviewers kept, and the conditions read it at once',
    rewritten === '验证、风险、撤回' && descriptions.length === 1 && descriptions[0].version === 3 && descriptions[0].title === pr.title && descriptions[0].reviewers.length === 3 && descriptions[0].description.endsWith('回退这个提交。'), { rewritten, descriptions });

  // How it looks, for a person to look at: the record with its conditions above it.
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `pr-review-approval-run-${label}-conditions.png`), Buffer.from(shot.data, 'base64'));

  mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
  const call = async (name, args) => {
    const response = await mcp.call(name, args);
    return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', error: response.error ?? null };
  };
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  check('the bridge has the two write tools beside the three reads', ['list_prs', 'list_pr_reviews', 'get_pr_review', 'update_pr_review_finding', 'record_pr_comments'].every((name) => tools.includes(name)), tools);
  const listed = await call('list_prs', {});
  check('list_prs carries the build, people\'s approvals against the level and the open tasks', !listed.isError && listed.text.includes('平台：构建通过 · 批准 1/2（另有 1 人的批准在旧提交上，要重新看） · 1 项未完成的任务（仓库没开对应的合并检查，拦不住合并）'), listed);
  const draft = await call('get_pr_description_draft', { reference: 'SYN/app#7' });
  const stale = await call('update_pr', { reference: 'SYN/app#7', description: '## 验证\nx', baseVersion: '0'.repeat(16) });
  check('get_pr_description_draft reads the description as now written; update_pr refuses a version moved since', !draft.isError && draft.text.includes('三段都已经有了，不用补') && stale.isError && stale.text.includes('没有写回：PR 描述在读取之后被改过') && descriptions.length === 1, { draft, stale });

  // Posting: the P1 a repository rule stands behind as a task, the other as an ordinary comment, each with its marker.
  const sent = await call('record_pr_comments', { id: uuid(1), findings: [{ finding: 1 }, { finding: 3 }] });
  check('record_pr_comments posts the P1 as a task, and not the P2 another reviewer\'s Paraself said a line away',
    !sent.isError && sent.text.includes('新发 1 条，其中 1 条阻塞') && sent.text.includes('没有发布，PR 上已有同位置的同类意见（合成审阅人 B）') && posted.length === 1 && posted[0].severity === 'BLOCKER'
      && posted[0].text.endsWith('— Paraself 预评审 · 依据 REVIEW.md · P1') && posted[0].anchor?.line === 88, { sent, posted });
  const insisted = await call('record_pr_comments', { id: uuid(1), findings: [{ finding: 3, evenIfDuplicate: true }] });
  check('asked again with evenIfDuplicate, it goes out as an ordinary comment', !insisted.isError && posted.length === 2 && posted[1].severity === undefined && posted[1].anchor?.line === 30, { insisted, posted });
  const personal = await call('record_pr_comments', { id: uuid(1), findings: [{ finding: 2, blocking: true }] });
  check('a finding on a personal basis is refused as blocking, nothing posted', personal.isError && personal.text.includes('不能设为阻塞') && posted.length === 2, personal);
  const dismissed = await call('update_pr_review_finding', { id: uuid(1), finding: 2, action: 'dismiss', reason: '合成：有意为之' });
  check('update_pr_review_finding turns the finding down with its reason', !dismissed.isError && dismissed.text.includes('已不采纳第 2 个问题'), dismissed);

  // The page, open all along, shows both without a reload.
  const shown = await waitFor(() => evaluate('(() => { const text = document.querySelector(".review-conversation")?.textContent ?? ""; return text.includes("已发布为 PR 评论（阻塞项）") && text.includes("合成：有意为之") ? true : null; })()'), 'the page showing the agent\'s changes').catch(() => false);
  check('the open review page shows the task and the dismissal without being reloaded', shown === true, shown);
  const after = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(out, `pr-review-approval-run-${label}-after-agent.png`), Buffer.from(after.data, 'base64'));
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const kept = JSON.parse(await readFile(join(started.env.PARASELF_USER_DATA, 'pr-review-history', `${uuid(1)}.json`), 'utf8'));
  check('the App\'s record keeps both, the page saving nothing older over them',
    kept.published.some((item) => item.finding === 0 && item.blocking === true) && kept.published.some((item) => item.finding === 2 && item.blocking === undefined)
      && kept.verdicts.some((item) => item.finding === 1 && item.by === 'reviewer' && item.reason === '合成：有意为之'), { published: kept.published, verdicts: kept.verdicts });
  const again = await call('record_pr_comments', { id: uuid(1), findings: [{ finding: 1 }] });
  check('a finding already posted is not posted again', !again.isError && again.text.includes('已经发布过，没有重发') && posted.length === 2, again);

  // 发布后跟踪结果: the PR's author answers the task with a standard reply; the other gets none. Read again, the record says so.
  postedActivities[0].comment.comments.push({ id: 950, text: '**误报**：网关已经查过吊销。\n\n— Paraself 作者回应', createdDate: Date.now(), author: { name: 'synthetic-author', displayName: '合成作者' } });
  const outcomes = await evaluate(`window.decision.readPrReviewOutcomes(${JSON.stringify({ id: uuid(1) })})`);
  const card = await waitFor(() => evaluate('(() => { const text = document.querySelector(".review-conversation")?.textContent ?? ""; return text.includes("作者：说错了 —— 网关已经查过吊销。") && text.includes("作者还没回应") ? true : null; })()'), 'the outcomes on the cards').catch(() => false);
  const saved = JSON.parse(await readFile(join(started.env.PARASELF_USER_DATA, 'pr-review-history', `${uuid(1)}.json`), 'utf8'));
  check('the record reads how each posted finding was answered, keeps it, and shows it on the cards', outcomes?.changed === true && card === true
    && saved.published.find((item) => item.finding === 0)?.outcome?.kind === 'wrong' && saved.published.find((item) => item.finding === 2)?.outcome?.kind === 'none' && saved.published.every((item) => item.comment), { outcomes, card, published: saved.published });
  const told = await call('get_pr_review', { id: uuid(1) });
  check('get_pr_review says how the author answered', told.text.includes('作者回应：说错了 —— 网关已经查过吊销。') && told.text.includes('作者还没回应'), told.text.slice(0, 1_200));

  // 评审质量 (IMP-202): the merged PR's figures read from the platform, people only; the two posted findings by outcome.
  const quality = await call('get_review_quality', {});
  check('get_review_quality reads the merged PR\'s figures from the platform, people only, and the posted findings\' outcomes',
    !quality.isError && quality.text.includes('团队：2 个已合并的 PR（之前 30 天 0 个），每个 PR 的人工批准 0.5（之前 —），人工评论 0.5 条（之前 —），等人批准的中位 4 小时（之前 —），回滚 0（之前 0），漏网 1（之前 0）')
      && quality.text.includes('已发布意见的结果 · 2 条') && /说错了 1，/u.test(quality.text) && /未回应 1/u.test(quality.text), quality.text.slice(0, 1_200));
  await evaluate('(() => { [...document.querySelectorAll(".review-list-tabs button")].find((button) => button.textContent.startsWith("评审质量"))?.click(); return true; })()');
  const tiles = await waitFor(() => evaluate('(() => { const view = document.querySelector(".review-quality .review-quality-tiles"); return view?.textContent.includes("4 小时") ? view.textContent : null; })()'), 'the quality page').catch(() => '');
  const table = await evaluate('document.querySelector(".review-quality-table")?.textContent ?? ""');
  check('the review page\'s 评审质量 shows the same figures and the outcomes table', tiles.includes('每个 PR 的人工批准0.5') && tiles.includes('等人批准（中位）4 小时') && tiles.includes('回滚 · 漏网0 · 1') && table.includes('说错了'), { tiles, table });

  // 漏网复盘 (IMP-203): #8 says it fixes #6, so #6 is one; its four lines written through the bridge, shown on the page.
  const escapes = await call('list_review_escapes', {});
  const escapeId = /([0-9a-f-]{36}) · SYN\/app#6「合成：导出时区」· 待写：合并后被 SYN\/app#8「合成：修复导出时区」修复/u.exec(escapes.text)?.[1];
  check('the merged PR a later one says it fixes is found as an escape', !escapes.isError && escapeId !== undefined, escapes.text.slice(0, 800));
  const written = await call('update_review_escape', { id: escapeId, action: 'write', writeup: { problem: '导出时间按服务器时区格式化', layer: 'pre_review', why: '没有规则说时间要按用户时区', change: 'rule', changeText: 'REVIEW.md 加一条' } });
  check('update_review_escape writes its four lines', !written.isError && written.text.includes('本该拦住的一层：Paraself 预评审'), written.text);
  await evaluate('(() => { document.querySelector(".review-quality .review-context button")?.click(); return true; })()');
  const escapeCard = await waitFor(() => evaluate('(() => { const card = document.querySelector(".review-quality-escape"); return card?.textContent.includes("没有规则说时间要按用户时区") ? card.textContent : null; })()'), 'the escape on the page').catch(() => '');
  check('the quality page shows the escape with its four lines', escapeCard.includes('SYN/app#6「合成：导出时区」合并后被 SYN/app#8「合成：修复导出时区」修复'), escapeCard);

  // 晋升提议 (IMP-205): the escape's write-up says the change goes into a rule, so it is proposed for REVIEW.md.
  const promotions = await call('list_rule_promotion_candidates', {});
  check('list_rule_promotion_candidates proposes the escape\'s rule for the repository\'s REVIEW.md',
    !promotions.isError && promotions.text.includes('漏网复盘「REVIEW.md 加一条」→ SYN/app 的 REVIEW.md') && promotions.text.includes('来自 SYN/app#6 的漏网复盘'), promotions.text.slice(0, 800));
  const promoted = await waitFor(() => evaluate('(() => { const section = document.querySelector("[aria-labelledby=\\"quality-promotions\\"]"); return section?.textContent.includes("来自 SYN/app#6 的漏网复盘") ? section.textContent : null; })()'), 'the proposal on the page').catch(() => '');
  check('the quality page lists the proposal with its line to send', promoted.includes('提议写进 REVIEW.md') && promoted.includes('改规则文件属于高风险'), promoted);

  // 个人规则的阻塞标记 (IMP-206): a P1 on a local rule the reviewer marked blocking goes out as a task, quoting the rule.
  const marked = { ...record(connectionId), id: uuid(2), at: '2026-11-12T11:00:00.000Z',
    snapshot: { ...record(connectionId).snapshot, snapshotId: uuid(102), rules: [{ id: 'money.md', source: 'decision', enforcement: 'blocking', text: '合成：金额一律用整数分，不用浮点数。' }] },
    report: { ...record(connectionId).report, findings: [finding('P1', '合成：金额用了浮点', '违反 Ruleset 1：金额用了浮点数。', 50)] } };
  await evaluate(`window.decision.savePrReviewHistory(${JSON.stringify({ entries: [marked], removed: [] })}).then(() => true)`);
  const before = posted.length;
  const pressed = await call('record_pr_comments', { id: uuid(2), findings: [{ finding: 1 }] });
  const task = posted[before];
  check('a P1 on a rule marked blocking is posted as a task that quotes the rule',
    !pressed.isError && posted.length === before + 1 && task?.severity === 'BLOCKER' && task.text.includes('> 审阅人的规则「money」（标记为阻塞）：\n> 合成：金额一律用整数分，不用浮点数。')
      && task.text.endsWith('— Paraself 预评审 · 依据 审阅人的规则（标记为阻塞） · P1'), { pressed: pressed.text, task });
  const page = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `pr-review-approval-run-${label}-quality.png`), Buffer.from(page.data, 'base64'));
} catch (error) { runError = error instanceof Error ? error.stack : String(error); }
finally {
  try { socket?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { mcp?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  await started.stop().catch((error) => cleanupErrors.push(String(error)));
  await new Promise((resolve) => platform.close(resolve));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'pr-review-approval-run', label, 'result', { build, root, checks, unknownRequests: unknown, error: runError, cleanupErrors, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0 && runError === null && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 && runError === null && cleanupErrors.length === 0 ? 0 : 1;
