// CS-2 实跑：打包的 App（隔离目录）里，agent 通过真实 bridge 增补、改写、撤回之后，知识页怎么显示；
// 再在页面上恢复、回退。明暗各一张截图。数据全是合成的。
// usage: node scripts/lab/probes/amend-ui-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label cs2 --out DIR --shots DIR
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, connectMcp, executableOf, isolationEnvironment, parseCommon, sleep } from './lib.mjs';

const { app, bridge, label, out, shots } = parseCommon({ shots: { type: 'string' } });
const root = await mkdtemp(join(DATA_DIR, 'amend-ui-'));
const checks = [];
const check = (name, ok, evidence) => { checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence }) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const files = async (directory) => {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path)); else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
};

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
const soon = async (probe, ms = 8000) => { try { return await until('page', probe, ms); } catch { return false; } };

let socket; let mcp;
try {
  await until('health', async () => {
    const parsed = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
    return (await fetch(`http://127.0.0.1:${parsed.port}/health`)).ok ? parsed : null;
  });
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  const call = async (tool, args) => (await mcp.call(tool, args)).result;
  const record = async (args) => (await call('record_decision_journal_entry', { project: 'lab', ...args })).structuredContent.record.recordId;
  const find = async (source, recordId, extra = {}) => (await call('search_decision_context', { source, recordId, ...extra })).structuredContent.context.results[0];

  // 数据：被改写并有增补的偏好；改写未生效的想法；被撤回的偏好；有增补和改写的决策
  const rolled = await record({ kind: 'preference', title: '先留回滚入口，再扩大发布', content: '不可逆的发布步骤要先有明确的回滚路径和负责人。', appliesWhen: '改动一旦上线就难以撤回时。', exceptions: '只影响本机、随时可以重装的改动。', knowledgeStatus: 'active' });
  const a1 = await find('preferences', rolled);
  await call('update_decision_journal_entry', { action: 'append', source: 'preferences', recordId: rolled, text: '灰度阶段可以只留回滚入口，不必指定负责人。', basis: 'user_confirmed' });
  await call('update_decision_journal_entry', { action: 'append', source: 'preferences', recordId: rolled, text: '数据库迁移要先在影子库演练一次，回滚脚本也要跑过。', basis: 'user_said' });
  await call('update_decision_journal_entry', { action: 'revise', source: 'preferences', recordId: rolled, expectedContentHash: a1.sourceRef.contentHash, expectedRevision: 2, fields: { summary: '不可逆的发布步骤要先有明确的回滚路径和负责人；数据库迁移要先在影子库演练一次。' }, reason: '用户补充了迁移演练' });
  const cache = await record({ kind: 'idea', title: '缓存失效可以改成事件驱动', content: '与其定时清理，不如让写入端在提交后发一个失效事件。', whyInteresting: '少一个定时任务', knowledgeStatus: 'active' });
  const c1 = await find('ideas', cache);
  await call('update_decision_journal_entry', { action: 'revise', source: 'ideas', recordId: cache, expectedContentHash: c1.sourceRef.contentHash, expectedRevision: 0, fields: { summary: '写入端提交后发失效事件，读端订阅并清掉自己的缓存。' }, reason: '用户补充了读端的做法' });
  const english = await record({ kind: 'preference', title: '提交信息写英文', content: '提交信息统一写英文。', appliesWhen: '提交代码时', exceptions: '内部草稿除外', knowledgeStatus: 'active' });
  await call('update_decision_journal_entry', { action: 'withdraw', source: 'preferences', recordId: english, expectedRevision: 0, reason: '你说以后提交信息统一写中文（用户原话）' });
  const plain = await record({ kind: 'preference', title: '命名用完整单词', content: '变量名不缩写，宁可长一点。', appliesWhen: '所有代码', exceptions: '循环变量除外', knowledgeStatus: 'active' });
  const limit = await record({ kind: 'decision', title: '本地模型输出达到上限时如何处理？', content: '保留输出上限诊断并回退规则。', rationale: '诊断能让问题可见，回退保证流程不中断。', project: 'local-tools' });
  const d1 = await find('decisions', limit);
  await call('update_decision_journal_entry', { action: 'revise', source: 'decisions', recordId: limit, expectedContentHash: d1.sourceRef.contentHash, expectedRevision: 0, fields: { appliesWhen: '本地模型输出被截断、或流式中断超过 30 秒时。' }, reason: '你说中断也要按截断处理（用户原话）' });
  await call('update_decision_journal_entry', { action: 'append', source: 'decisions', recordId: limit, text: '回退时要在日志里写明原模型和回退原因，便于事后核对。', basis: 'user_said' });
  const quiet = await record({ kind: 'decision', title: '会话缓存放哪里？', content: '会话缓存放进程内存。', rationale: '单机部署', project: 'local-tools' });
  // 想法的原文之后被用户在 Obsidian 里改过：那次改写没有应用
  const note = (await files(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'ideas'))).find(async () => true);
  for (const path of await files(join(env.PARASELF_VAULT_PATH, 'Decision Journal', 'ideas'))) {
    const text = await readFile(path, 'utf8');
    if (text.includes(`id: ${cache}`) || text.includes(`id: "${cache}"`)) await writeFile(path, text.replace('与其定时清理，不如让写入端在提交后发一个失效事件。', '与其定时清理，不如让写入端在提交后发一个失效事件（你在 Obsidian 里加的这句）。'));
  }
  void note;

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
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const theme = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  const snap = async (name) => {
    if (shots === undefined) return;
    await mkdir(shots, { recursive: true });
    for (const mode of ['light', 'dark']) {
      await theme(mode); await sleep(400);
      const { result } = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(shots, `${name}-${mode}.png`), Buffer.from(result.data, 'base64'));
    }
    await theme('light'); await sleep(200);
  };
  const click = (script) => evaluate(`(async () => { ${script}; await new Promise((r) => setTimeout(r, 600)); return true; })()`);
  const text = (selector) => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.innerText).join(" | ")`);
  const byText = (selector, wanted, within = 'document') => `[...${within}.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.innerText.trim() === ${JSON.stringify(wanted)} || e.innerText.includes(${JSON.stringify(wanted)}))`;
  await until('renderer API', () => evaluate('typeof window.decision?.listDecisionAmendments === "function"'));
  await evaluate('window.decision.openSurface("decisions")').catch(() => undefined);
  await until('knowledge tabs', () => evaluate('document.getElementById("knowledge-tab-journal") !== null'));

  // 图 1：偏好与想法
  await click('document.getElementById("knowledge-tab-journal").click()');
  await until('entries', () => evaluate('document.querySelectorAll(".journal-entry-card").length >= 4'));
  const cards = await text('.journal-entry-card');
  check('rewritten entry carries 「已被 Claude Code 改写」 and 「增补 2」', /已被 Claude Code 改写 · \d+ 月 \d+ 日/.test(cards) && cards.includes('增补 2'), cards.slice(0, 400));
  check('the changed part is marked and the original words are one click away', await evaluate('document.querySelector(".journal-entry-card mark.amendment-changed") !== null && document.querySelector(".journal-entry-card .amendment-original") !== null'));
  check('who is a client name, never the id', !/claude-code/.test(await text('.journal-entry-card')) && (await text('.amendment-list .amendment-who')).includes('Claude Code'), await text('.amendment-list .amendment-who'));
  check('additions listed with who and ground', (await text('.amendment-list')).includes('用户认可') && (await text('.amendment-list')).includes('用户原话'));
  check('a rewrite that did not take says so, with three actions', cards.includes('改写未生效') && (await text('.amendment-stale')).includes('按新原文重新改写') && (await text('.amendment-stale')).includes('忽略'), await text('.amendment-stale'));
  check('the withdrawn entry is a dashed card with its reason, and 恢复', await evaluate('(() => { const c = document.querySelector(".journal-entry-card.withdrawn"); return c !== null && c.innerText.includes("提交信息写英文") && c.innerText.includes("原因：") && c.innerText.includes("恢复"); })()'));
  await snap('journal-list');

  // 修订记录（偏好）
  await click(`(() => { const card = ${byText('.journal-entry-card', '先留回滚入口')}; ${byText('button', '修订记录', 'card')}?.click(); })()`);
  await until('history dialog', () => evaluate('document.querySelector(".amendment-history") !== null'));
  check('history is grouped by day with before and after of the rewrite', (await text('.amendment-history h3')).includes('今天') && await evaluate('document.querySelector(".amendment-diff del") !== null && document.querySelector(".amendment-diff ins") !== null'));
  await snap('journal-history');
  await click('[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "关闭")?.click()');

  // 页面上恢复被撤回的偏好
  await click(`${byText('.journal-entry-card.withdrawn button', '恢复')}?.click()`);
  const back = await soon(async () => (await find('preferences', english)).amendment?.withdrawn === null);
  check('restoring on the page restores it through the same service (the agent sees it again)', back, JSON.stringify((await find('preferences', english)).amendment));
  const restored = (await find('preferences', english)).amendment;
  check('the restore is recorded under 「我」', restored?.history?.at(-1)?.action === 'restore' && restored.history.at(-1).client === '我', JSON.stringify(restored?.history?.at(-1)));

  // 页面上撤回
  await click(`(() => { const card = ${byText('.journal-entry-card', '命名用完整单词')}; ${byText('button', '撤回', 'card')}?.click(); })()`);
  await until('withdraw dialog', () => evaluate('document.querySelector("[role=dialog] textarea") !== null'));
  await evaluate(`(() => { const t = document.querySelector("[role=dialog] textarea"); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set; set.call(t, "页面上撤回的测试"); t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await click('document.querySelector("[role=dialog] button[type=submit]")?.click()');
  const gone = await soon(async () => (await find('preferences', plain, { includeWithdrawn: true })).amendment?.withdrawn?.client === '我');
  check('withdrawing on the page records the reader and the reason', gone, JSON.stringify((await find('preferences', plain, { includeWithdrawn: true })).amendment?.withdrawn));
  check('the agent no longer gets it by default', (await call('search_decision_context', { source: 'preferences', recordId: plain })).structuredContent.context.results.length === 0);
  await click('document.getElementById("knowledge-tab-journal").click()');

  // 图 2：决策详情
  await click('document.getElementById("knowledge-tab-decisions").click()');
  await until('decision rows', () => evaluate('document.querySelectorAll(".decision-library-row").length >= 2'));
  const rows = await text('.decision-library-row');
  check('the decision row is marked 「已改写」 and 「+1」, the quiet one is not', /本地模型输出达到上限.*已改写/s.test(rows) && rows.includes('+1') && !/会话缓存放哪里[^|]*已改写/.test(rows), rows);
  await snap('decisions-list');
  await click(`${byText('.decision-library-row', '本地模型输出达到上限')}?.click()`);
  await until('detail', () => evaluate('document.querySelector(".decision-amend-block") !== null'));
  await evaluate('document.querySelector(".decision-amend-block").scrollIntoView({ block: "start" })');
  await sleep(300);
  const block = await text('.decision-amend-block');
  check('the detail shows the rewritten field with its tag, the additions, the history and the note', block.includes('已被 Claude Code 改写') && block.includes('补充（来自之后的会话）') && block.includes('修订记录') && block.includes('决策的原笔记不会被改写'), block);
  await snap('decision-detail');
  // 回退：恢复为这一版之前（先问）
  await click(`${byText('.decision-amend-block button', '恢复为这一版之前')}?.click()`);
  await until('confirm', () => evaluate('document.querySelectorAll("[role=dialog]").length >= 1 && [...document.querySelectorAll("[role=dialog] button")].some((b) => b.innerText.trim() === "恢复")'));
  const untouched = (await find('decisions', limit)).appliesWhen;
  check('nothing is written before the reader confirms', untouched === '本地模型输出被截断、或流式中断超过 30 秒时。', untouched);
  await snap('decision-restore-confirm');
  await click('[...document.querySelectorAll("[role=dialog] button")].find((b) => b.innerText.trim() === "恢复")?.click()');
  const reverted = await soon(async () => (await find('decisions', limit)).appliesWhen !== '本地模型输出被截断、或流式中断超过 30 秒时。');
  const after = await find('decisions', limit);
  check('going back writes a rewrite of its own as the reader and puts the earlier text back', reverted && after.amendment.history.at(-1).client === '我', JSON.stringify([after.appliesWhen, after.amendment.history.at(-1)]));
  check('the original note was never written (hash unchanged)', after.sourceRef.contentHash === d1.sourceRef.contentHash);
  void quiet; void rolled;
} finally {
  const failed = checks.filter((entry) => !entry.ok);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `amend-ui-run-${label}-result.json`), `${JSON.stringify({ label, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length }));
  try { mcp?.close(); } catch { /* closing */ }
  try { socket?.close(); } catch { /* closing */ }
  child.kill('SIGTERM');
  await sleep(1500);
  await rm(root, { recursive: true, force: true });
  if (failed.length > 0) process.exitCode = 1;
}
