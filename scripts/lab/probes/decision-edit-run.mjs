// CS-3 实跑：打包的 App（隔离目录），页面编辑决策、回退、agent 修改后页面显示、复盘对照切换，明暗截图。合成数据。
// usage: node scripts/lab/probes/decision-edit-run.mjs --app <Paraself.app> --bridge <paraself-bridge> --label cs3 --out DIR --shots DIR
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, connectMcp, executableOf, isolationEnvironment, parseCommon, sleep } from './lib.mjs';

const { app, bridge, label, out, shots } = parseCommon({ shots: { type: 'string' } });
const root = await mkdtemp(join(DATA_DIR, 'decision-edit-'));
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
const soon = async (probe, ms = 8000) => { try { return await until('page', probe, ms); } catch { return false; } };

let socket; let mcp;
try {
  await until('health', async () => {
    const parsed = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8'));
    return (await fetch(`http://127.0.0.1:${parsed.port}/health`)).ok ? parsed : null;
  });
  mcp = await connectMcp({ env, bridge, client: 'claude-code' });
  const call = async (tool, args) => (await mcp.call(tool, args)).result;
  const find = async (recordId, extra = {}) => (await call('search_decision_context', { source: 'decisions', recordId, ...extra })).structuredContent.context.results[0];

  const created = await call('record_decision_journal_entry', { kind: 'decision', title: '决策工作流应该从设置中拆出吗？', content: '建立独立决策中心', rationale: '这个方案更容易维护，也能保留清晰的回退路径。', context: '当时正在收敛桌面应用的信息架构和交互密度。', expectedOutcome: '一个月内找历史决策的平均时间降到 10 秒以内。', project: 'lab' });
  const id = created.structuredContent.record.recordId;
  const first = await find(id);
  await call('record_decision_outcome', { source: 'decisions', recordId: id, expectedContentHash: first.sourceRef.contentHash, outcome: '上线后平均 8 秒。', review: { verdict: 'as_expected', lesson: '紧凑信息架构更适合高频回看。' } });
  const base = await find(id);
  // agent 改写上下文（用户同意）
  const hash0 = base.sourceRef.contentHash;
  const agent = await call('update_decision_journal_entry', { action: 'revise', source: 'decisions', recordId: id, expectedContentHash: hash0, expectedRevision: 0, basis: 'user_said', fields: { context: '当时正在收敛桌面应用的信息架构和交互密度，设置页已有 9 个分区。' }, reason: '你补充了当时的规模（用户原话）' });
  check('the agent rewrites the context of a decision with the user\'s basis', agent.structuredContent.amendment.status === 'saved', JSON.stringify(agent.structuredContent));
  const noBasis = await call('update_decision_journal_entry', { action: 'revise', source: 'decisions', recordId: id, expectedContentHash: hash0, expectedRevision: 1, fields: { rationale: '不带依据' }, reason: 'r' });
  check('a rewrite of the decision\'s own words without a basis is refused', noBasis.isError === true && noBasis.structuredContent.amendment.status === 'basis_required', JSON.stringify(noBasis.structuredContent));
  const summ = await call('update_decision_journal_entry', { action: 'revise', source: 'summarize', recordId: 'none', expectedContentHash: hash0, expectedRevision: 0, basis: 'user_said', fields: { question: 'x' }, reason: 'r' });
  check('summarize does not take them', summ.isError === true, JSON.stringify(summ.structuredContent));

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
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
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
  const dialogButton = (name) => `[...document.querySelectorAll("[role=dialog] button")].find((b) => (b.getAttribute("aria-label") ?? b.innerText).trim() === ${JSON.stringify(name)})`;
  const type = async (selector, value) => evaluate(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); const proto = t.tagName === "TEXTAREA" ? HTMLTextAreaElement : HTMLInputElement; Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(t, ${JSON.stringify(value)}); t.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until('renderer API', () => evaluate('typeof window.decision?.listDecisionAmendments === "function"'));
  await evaluate('window.decision.openSurface("decisions")').catch(() => undefined);
  await until('rows', () => evaluate('document.querySelectorAll(".decision-library-row").length >= 1'));
  await click('document.querySelector(".decision-library-row").click()');
  await until('detail', () => evaluate('document.querySelector(".decision-library-detail") !== null'));
  await sleep(800);

  // 图：agent 改过的上下文显示
  const detail = await text('.decision-library-detail');
  check('the context the agent rewrote shows with 「已被 claude-code 修改」', /已被 Claude Code 修改 · 今天/.test(detail) && detail.includes('设置页已有 9 个分区'), detail.slice(0, 300));
  check('its first words are one click away', await evaluate('document.querySelector(".decision-detail-context .amendment-original") !== null'));
  check('the progress says 修订 1 次', /修订[\s\S]*1 次/.test(await text('.decision-lifecycle')), await text('.decision-lifecycle'));
  check('the buttons are the page\'s own (pencil + words)', await evaluate('[...document.querySelectorAll(".decision-library-detail .decision-detail-edit")].every((b) => b.classList.contains("text-button") && b.querySelector("svg") !== null) && document.querySelector("[aria-label=编辑问题]") !== null'));

  // 页面编辑决策理由（编辑中的底部提示截图）
  await click(`${dialogButton('修改理由')}?.click()`);
  await until('rationale editor', () => evaluate('document.querySelector(".decision-detail-rationale textarea") !== null'));
  await type('.decision-detail-rationale textarea', '这个方案更容易维护，也能保留清晰的回退路径；设置页已经太长，决策混在里面找不到。');
  await type('.decision-detail-rationale input[type=text]', '补上设置页太长这个原因');
  check('while editing, the footer says what is being edited and the buttons are the sections\' own', (await text('.decision-detail-lock')).includes('正在编辑「决策理由」') && await evaluate('document.querySelector(".decision-detail-rationale .secondary-button") !== null && document.querySelector(".decision-detail-rationale .primary-button") !== null'));
  await snap('decision-editing-rationale');
  await click(`${dialogButton('保存理由')}?.click()`);
  const savedRationale = await soon(async () => (await find(id)).amendment?.revised?.values?.rationale?.includes('设置页已经太长'));
  check('saving writes a rewrite as the reader, original words kept', savedRationale && (await find(id)).amendment.originals.rationale === '这个方案更容易维护，也能保留清晰的回退路径。' && (await find(id)).amendment.history.at(-1).client === '我', JSON.stringify((await find(id)).amendment));
  check('the note itself was never written (hash unchanged)', (await find(id)).sourceRef.contentHash === hash0);

  // 页面编辑问题、选择、预期
  await click('document.querySelector("[aria-label=编辑问题]").click()');
  await until('question editor', () => evaluate('document.querySelector(".decision-detail-question textarea") !== null'));
  await type('.decision-detail-question textarea', '决策工作流要不要从设置里拆出来？');
  await click(`${dialogButton('保存问题')}?.click()`);
  const q = await soon(async () => (await find(id)).title === '决策工作流要不要从设置里拆出来？');
  check('the question edited on the page is what the agent reads now, with the original words', q && (await find(id)).amendment.originals.question === '决策工作流应该从设置中拆出吗？');
  await click(`${dialogButton('修改选择')}?.click()`);
  await type('.decision-detail-choice textarea', '建立独立决策中心，先只放决策和复盘');
  await type('.decision-detail-choice input[type=text]', '范围写清楚');
  await click(`${dialogButton('保存选择')}?.click()`);
  check('the choice edited on the page reads back', await soon(async () => (await find(id)).summary === '建立独立决策中心，先只放决策和复盘'));
  await click(`${dialogButton('修改预期')}?.click()`);
  await type('.decision-detail-expected textarea', '一个月内找历史决策的平均时间降到 10 秒以内，且不用翻设置。');
  await click(`${dialogButton('保存预期')}?.click()`);
  check('the expected result edited on the page reads back, the first one kept', await soon(async () => (await find(id)).outcomeState?.expectedOutcome?.includes('不用翻设置')) && (await find(id)).amendment.originals.expectedOutcome.startsWith('一个月内找历史决策'));

  // 复盘对照
  await until('compare', () => evaluate('document.querySelector(".decision-expected-compare") !== null'));
  const pressed = () => evaluate('[...document.querySelectorAll(".decision-expected-compare .decision-filter-segment button")].map((b) => b.getAttribute("aria-pressed") + ":" + b.innerText).join(" | ")');
  check('the review compares with the first expectation by default', (await pressed()).startsWith('true:最初的预期') && (await text('.decision-expected-compare p')).includes('降到 10 秒以内。') && !(await text('.decision-expected-compare p')).includes('不用翻设置'), await pressed());
  await snap('decision-review-original');
  await click(`${dialogButton('修改后的预期')}?.click()`);
  check('switching shows the changed expectation', (await text('.decision-expected-compare p')).includes('不用翻设置') && (await pressed()).includes('true:修改后的预期'), await pressed());
  await snap('decision-review-revised');

  // 补充与修订块与回退
  await click('[...document.querySelectorAll(".decision-lifecycle li")].find((li) => li.innerText.startsWith("修订")).querySelector("button").click()');
  await sleep(600);
  const block = await text('.decision-amend-block');
  check('the revisions are in the 补充与修订 block with before and after', block.includes('修订记录') && block.includes('改写「') && await evaluate('document.querySelector(".decision-amend-block .amendment-diff del") !== null'), block.slice(0, 400));
  await evaluate('document.querySelector(".decision-amend-block").scrollIntoView({ block: "start" })');
  await sleep(300);
  await snap('decision-revisions');
  // 回退：恢复选择为改前
  const before = (await find(id)).summary;
  await click(`(() => { const rows = [...document.querySelectorAll(".decision-amend-block .amendment-history-row")]; const row = rows.find((r) => r.innerText.includes("最终选择")); [...row.querySelectorAll("button")].find((b) => b.innerText.includes("恢复为这一版之前")).click(); })()`);
  await until('confirm', () => evaluate('[...document.querySelectorAll("[role=dialog] button")].some((b) => b.innerText.trim() === "恢复")'));
  check('nothing is written before the reader confirms', (await find(id)).summary === before);
  await snap('decision-restore-confirm');
  await click(`${dialogButton('恢复')}?.click()`);
  const back = await soon(async () => (await find(id)).summary === '建立独立决策中心');
  check('going back puts the first choice back as a rewrite of its own, as the reader', back && (await find(id)).amendment.history.at(-1).client === '我', JSON.stringify((await find(id)).amendment.history.at(-1)));
  check('the first version is still found in the history', (await find(id)).amendment.originals.choice === '建立独立决策中心');
  check('the note was still never written', (await find(id)).sourceRef.contentHash === hash0);
  // agent 的最终视图
  const agentView = await find(id);
  check('an agent sees the changed values, the marks and the first words', agentView.title.includes('拆出来') && agentView.warnings.join().includes('已被') && Object.keys(agentView.amendment.originals).length >= 4, JSON.stringify(agentView.warnings));
} finally {
  const failed = checks.filter((entry) => !entry.ok);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `decision-edit-run-${label}-result.json`), `${JSON.stringify({ label, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: checks.length - failed.length, failed: failed.length }));
  try { mcp?.close(); } catch { /* closing */ }
  try { socket?.close(); } catch { /* closing */ }
  child.kill('SIGTERM');
  await sleep(1500);
  await rm(root, { recursive: true, force: true });
  if (failed.length > 0) process.exitCode = 1;
}
