// 作者回应（IMP-198）end to end: the packaged App in an isolated root, a synthetic Bitbucket Data Center on loopback where the
// token's account wrote the PR, the renderer driven over the DevTools protocol, and the packaged bridge. Opened from 我创建的,
// the PR shows the comments others left (a pre-review task, a colleague's question), the approval conditions say what
// the merge waits for and how many comments have an answer; 不修 from the page and 转后续 from the bridge each go out as a
// standard reply in the comment's thread, 转后续 filing a todo in the isolated vault first; a comment answered already is
// not answered again. Synthetic data only: no user data is read or written, and the platform is a local fake.
// usage: node scripts/lab/probes/pr-review-author-run.mjs --app out/Paraself-darwin-arm64/Paraself.app \
//          --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge --label main --out DIR
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'pr-review-author-run-'));
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

// The synthetic platform: the token's account (synthetic-author) wrote one open PR; a reviewer's Paraself left a P1 task on
// it, a colleague asked a question. Replies posted are kept under the comment they answer, as the platform would.
const head = 'a'.repeat(40), base = 'b'.repeat(40);
const endpoint = '/rest/api/1.0/projects/SYN/repos/app/pull-requests/12';
const ref = (displayId, latestCommit) => ({ id: `refs/heads/${displayId}`, displayId, latestCommit, repository: { slug: 'app', project: { key: 'SYN' } } });
const pr = {
  id: 12, version: 2, state: 'OPEN', title: '合成：导出改为异步任务', description: '## 验证\n合成单测。\n\n## 风险\n导出。\n\n## 撤回\n回滚。', updatedDate: Date.parse('2026-11-12T10:00:00.000Z'),
  author: { user: { name: 'synthetic-author', displayName: '合成作者' } }, fromRef: ref('feature/export-async', head), toRef: ref('main', base),
  reviewers: [{ user: { name: 'synthetic-reviewer', displayName: '合成审阅人', type: 'NORMAL' }, approved: false, status: 'UNAPPROVED' }], participants: [], properties: { commentCount: 2, openTaskCount: 1 },
};
const person = (name, displayName) => ({ name, displayName });
const task = { id: 701, text: '**P1 · 导出失败后临时文件没有清理**\n\n违反 REVIEW.md《资源清理》：失败分支要删掉临时文件。\n\n— Paraself 预评审 · 依据 REVIEW.md · P1', createdDate: Date.parse('2026-11-12T11:00:00.000Z'),
  author: person('synthetic-reviewer', '合成审阅人'), severity: 'BLOCKER', state: 'OPEN', comments: [] };
const question = { id: 702, text: '能不能顺便把导出上限改成可配置？', createdDate: Date.parse('2026-11-12T11:30:00.000Z'), author: person('synthetic-colleague', '合成同事'), comments: [] };
// A colleague's line comment: one to fix, which the local review is asked to.
const timezone = { id: 703, text: '导出文件名能不能带上时区？', createdDate: Date.parse('2026-11-12T11:40:00.000Z'), author: person('synthetic-colleague', '合成同事'), comments: [] };
const posted = [];
const unknown = [];
const platform = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);
  const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json', 'x-ausername': 'synthetic-author' }); response.end(JSON.stringify(body)); };
  if (request.method === 'GET' && path === '/rest/api/1.0/dashboard/pull-requests') return send(200, { values: url.searchParams.get('state') === 'OPEN' && url.searchParams.get('role') === 'AUTHOR' ? [pr] : [], isLastPage: true });
  if (request.method === 'GET' && path === '/rest/api/1.0/application-properties') return send(200, { version: '9.4.0' });
  if (request.method === 'GET' && path === endpoint) return send(200, pr);
  if (request.method === 'GET' && path === `${endpoint}/changes`) return send(200, { isLastPage: true, values: [{ path: { toString: 'apps/export/job.ts' }, type: 'MODIFY' }] });
  if (request.method === 'GET' && path === `${endpoint}/diff`) {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-ausername': 'synthetic-author' });
    return response.end(['diff --git a/apps/export/job.ts b/apps/export/job.ts', '--- a/apps/export/job.ts', '+++ b/apps/export/job.ts', '@@ -55,3 +55,4 @@',
      ' export const run = async (job) => {', '+  const file = await createTempFile(job);', '   return upload(file);', ' };', ''].join('\n'));
  }
  if (request.method === 'GET' && path === `${endpoint}/merge-base`) return send(200, { id: base });
  if (request.method === 'GET' && path === `${endpoint}/activities`) return send(200, { isLastPage: true, values: [
    { action: 'COMMENTED', comment: timezone, commentAnchor: { path: 'apps/export/job.ts', line: 56, fileType: 'TO' } },
    { action: 'COMMENTED', comment: question }, { action: 'COMMENTED', comment: task, commentAnchor: { path: 'apps/export/job.ts', line: 57, fileType: 'TO' } }] });
  if (request.method === 'GET' && path.startsWith('/rest/build-status/1.0/commits/stats/')) return send(200, { successful: 1, inProgress: 0, failed: 0 });
  if (request.method === 'POST' && path === `${endpoint}/comments`) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const comment = JSON.parse(body);
      posted.push(comment);
      const reply = { id: 800 + posted.length, text: comment.text, createdDate: Date.now(), author: person('synthetic-author', '合成作者'), comments: [] };
      [task, question, timezone].find((item) => item.id === comment.parent?.id)?.comments.push(reply);
      send(201, reply);
    });
    return undefined;
  }
  unknown.push(`${request.method} ${path}${url.search}`);
  return send(404, { errors: [{ message: 'not on the synthetic platform' }] });
});
await new Promise((resolve) => platform.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${platform.address().port}`;

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
  await evaluate('window.decision.setLocalCredentialsEnabled(true).then(() => true)');
  await evaluate(`window.decision.savePrConnection(${JSON.stringify({ label: '合成 Bitbucket', platform: 'bitbucket-server', baseUrl, token: 'synthetic-token' })})`);
  await send('Page.reload');
  await waitFor(() => evaluate('typeof window.decision?.listPrReceivedComments === "function"'), 'renderer API after reload');

  // 我创建的: the PR the token's account wrote, and what it received.
  await waitFor(() => evaluate('(() => { const nav = document.querySelector(\'[aria-label="评审"]\'); nav?.click(); return Boolean(nav); })()'), 'the review page');
  await waitFor(() => evaluate('(() => { const scope = [...document.querySelectorAll(\'[aria-label="PR 范围"] button\')].find((button) => button.textContent === "我创建的"); scope?.click(); return Boolean(scope); })()'), 'the 我创建的 scope');
  await waitFor(() => evaluate('(() => { const item = [...document.querySelectorAll(".review-pr-item")].find((button) => button.textContent.includes("合成：导出改为异步任务")); item?.click(); return Boolean(item); })()'), 'the PR row');
  const region = '[...document.querySelectorAll("section.pr-received")][0]';
  const listed = await waitFor(() => evaluate(`(() => { const section = ${region}; return section && section.querySelectorAll("li").length === 3 ? { head: section.querySelector(".pr-received-head").textContent, items: [...section.querySelectorAll("li")].map((item) => item.textContent.replace(/\\s+/gu, " ")) } : null; })()`), 'the received comments').catch(() => ({}));
  check('the PR opened from 我创建的 lists the three comments others left, none answered yet',
    listed.head === '收到的意见 · 3 条1 条来自 Paraself 预评审 · 0 / 3 条有去向' && listed.items?.some((item) => item.includes('阻塞P1导出失败后临时文件没有清理') && item.includes('apps/export/job.ts:57') && item.includes('待你决定'))
      && listed.items?.some((item) => item.includes('人工能不能顺便把导出上限改成可配置？')), listed);
  const read = (name) => `[...document.querySelectorAll('[aria-label="批准条件"] dt')].find((term) => term.textContent === ${JSON.stringify(name)})?.nextElementSibling?.textContent ?? ""`;
  const conditions = await waitFor(() => evaluate(`(() => { const values = { responses: ${read('回应')}, note: document.querySelector('[aria-label="批准条件"] > p')?.textContent ?? "" }; return values.responses && values.note.startsWith("合并要等") ? values : null; })()`), 'the author conditions').catch(() => ({}));
  check('the conditions over it say what the merge waits for and how many comments have an answer', conditions.responses === '0 / 3 条有去向' && conditions.note?.startsWith('合并要等：1 人批准、阻塞项完成。'), conditions);

  // 不修 from the page: 有意为之, with the reason, under the task.
  await evaluate(`(() => { const item = [...${region}.querySelectorAll("li")].find((li) => li.textContent.includes("导出失败后临时文件没有清理")); [...item.querySelectorAll("button")].find((button) => button.textContent === "不修").click(); return true; })()`);
  await waitFor(() => evaluate('Boolean(document.querySelector(\'form[aria-label="不修"]\'))'), 'the 不修 dialog');
  await evaluate(`(() => { const form = document.querySelector('form[aria-label="不修"]'); [...form.querySelectorAll("label")].find((label) => label.textContent.includes("有意为之")).querySelector("input").click();
    const field = [...form.querySelectorAll("label")].find((label) => label.textContent.startsWith("理由")).querySelector("textarea");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, "临时文件由定时任务统一清理。"); field.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await evaluate('[...document.querySelectorAll("button")].find((button) => button.textContent === "发出回复").click(); true');
  await waitFor(async () => posted.length >= 1, 'the reply posted').catch(() => undefined);
  check('the page answers the task in its thread with the standard reply', posted.length === 1 && posted[0].parent?.id === 701 && posted[0].text === '**有意为之**：临时文件由定时任务统一清理。\n\n— Paraself 作者回应', posted);
  const answered = await waitFor(() => evaluate(`(() => { const section = ${region}; const text = section?.textContent ?? ""; return text.includes("1 / 3 条有去向") && text.includes("已回复：有意为之 —— 临时文件由定时任务统一清理。") ? true : null; })()`), 'the page reading it again').catch(() => false);
  check('the page reads the thread again and shows the answer', answered === true, answered);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `pr-review-author-run-${label}-received.png`), Buffer.from(shot.data, 'base64'));

  // 转后续 from the bridge: a todo in the isolated vault, then the reply naming it.
  mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
  const call = async (name, args) => {
    const response = await mcp.call(name, args);
    return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', error: response.error ?? null };
  };
  const tools = (await mcp.listTools()).map((tool) => tool.name);
  check('the bridge has the comment tools and the local review\'s four', ['list_pr_comments', 'update_pr_comment', 'record_local_review_job', 'list_local_review_jobs', 'get_local_review_job', 'update_local_review_job'].every((name) => tools.includes(name)), tools);
  const before = await call('list_pr_comments', { reference: 'SYN/app#12' });
  check('list_pr_comments says what each comment got', !before.isError && before.text.startsWith('SYN/app#12 收到 3 条意见，1 条有去向（1 条来自 Paraself 预评审）。')
    && before.text.includes('去向：已回复 有意为之 —— 临时文件由定时任务统一清理。') && before.text.includes('人工 能不能顺便把导出上限改成可配置？ — 合成同事（意见 id 702）'), before);
  const later = await call('update_pr_comment', { reference: 'SYN/app#12', comment: '702', response: 'later', todo: '导出上限可配置' });
  check('update_pr_comment files 转后续 as a todo and answers the comment naming it',
    !later.isError && later.text.startsWith('已回复「能不能顺便把导出上限改成可配置？」：转后续，并建了待办「导出上限可配置」。') && posted.length === 2 && posted[1].parent?.id === 702
      && posted[1].text === '**转后续**：已建待办「导出上限可配置」。\n\n— Paraself 作者回应', { later, posted });
  const todos = await call('list_todo_lists', { project: 'SYN/app' });
  check('the todo is in the isolated vault\'s 「PR 后续」 list for the repository', !todos.isError && todos.text.includes('PR 后续') && todos.text.includes('导出上限可配置'), todos.text.slice(0, 600));
  const again = await call('update_pr_comment', { reference: 'SYN/app#12', comment: '701', response: 'wontfix', reason: '再回一次。' });
  check('a comment answered already is not answered again', again.isError && again.text === '没有回复：这条意见已经回应过：有意为之。' && posted.length === 2, again);
  const after = await call('list_pr_comments', { reference: 'SYN/app#12' });
  check('two of the three comments have an answer now', after.text.startsWith('SYN/app#12 收到 3 条意见，2 条有去向'), after.text.slice(0, 200));

  // 修 on the colleague's line comment: no local repository here pushes to SYN/app, so the local review says so, from the page and the bridge alike.
  await evaluate(`(() => { const item = [...${region}.querySelectorAll("li")].find((li) => li.textContent.includes("导出文件名能不能带上时区")); [...item.querySelectorAll("button")].find((button) => button.textContent === "修").click(); return true; })()`);
  const hand = await waitFor(() => evaluate('(() => { const bar = document.querySelector(\'[aria-label="交给本地审阅"]\'); const send = bar && [...bar.querySelectorAll("button")].find((button) => button.textContent.startsWith("交给本地审阅修改")); return send && !send.disabled ? send.textContent : null; })()'), 'the hand-over bar').catch(() => '');
  await evaluate('[...document.querySelectorAll(\'[aria-label="交给本地审阅"] button\')].find((button) => button.textContent.startsWith("交给本地审阅修改"))?.click(); true');
  const refusedOnPage = await waitFor(() => evaluate('[...document.querySelectorAll(\'section.pr-received [role="alert"]\')].map((item) => item.textContent).find((text) => text.includes("本地审阅里没有推送到")) ?? null'), 'the refusal on the page').catch(() => '');
  check('the page hands the line comment over, and says the local review has no repository pushing to the PR', hand === '交给本地审阅修改 1 条' && refusedOnPage.startsWith('本地审阅里没有推送到 SYN/app 的工程'), { hand, refusedOnPage });
  const recorded = await call('record_local_review_job', { reference: 'SYN/app#12', comments: ['703'] });
  const jobs = await call('list_local_review_jobs', {});
  check('record_local_review_job says the same, and no task is made', recorded.isError && recorded.text.startsWith('没有交给本地审阅：本地审阅里没有推送到 SYN/app 的工程') && jobs.text === '还没有本地审阅任务。只读。', { recorded, jobs });
} catch (error) { runError = error instanceof Error ? error.stack : String(error); }
finally {
  try { socket?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  try { mcp?.close(); } catch (error) { cleanupErrors.push(String(error)); }
  await started.stop().catch((error) => cleanupErrors.push(String(error)));
  await new Promise((resolve) => platform.close(resolve));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'pr-review-author-run', label, 'result', { build, root, checks, posted, unknownRequests: unknown, error: runError, cleanupErrors, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0 && runError === null && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 && runError === null && cleanupErrors.length === 0 ? 0 : 1;
