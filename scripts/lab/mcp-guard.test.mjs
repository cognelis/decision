import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consultDecisionPrinciples } from '../../apps/bridge/src/mcp-server.ts';
import { fileURLToPath } from 'node:url';
import { ISOLATION_KEYS, isolationEnvironment } from './isolated-app.mjs';
import { ALLOWLIST, CONSULT, GUARD_FAULT, LEAK, SEARCH, checkMeta, checkPaths, checkResult, consultForward, consultNotice, consultText, errorNotice, guardCommand, rebuild } from './mcp-guard.mjs';
import { consultSeeds, journalCase } from './mcp-guard.fixture.mjs';
import { canary, parseAgentRun } from './context-run.mjs';
import { assertLabProcessEnvironment, connectMcp, startIsolatedApp } from './isolated-app.mjs';
import { record, result, seeded, structured, textFor } from './mcp-guard.fixture.mjs';
import TRUSTED from './mcp-guard-7269a75d.json' with { type: 'json' };

const lab = async run => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'mcp-guard-')));
  const root = join(base, 'root');
  const env = isolationEnvironment(root, { PATH: process.env.PATH });
  await mkdir(env.PARASELF_USER_DATA, { recursive: true });
  await mkdir(env.PARASELF_VAULT_PATH, { recursive: true });
  await mkdir(join(base, 'outside'));
  try { await run({ base, root, env }); } finally { await rm(base, { recursive: true, force: true }); }
};

test('paths: every isolation variable must resolve under root, links and newlines included', () => lab(async ({ base, root, env }) => {
  assert.equal(ISOLATION_KEYS.length, 11);
  const good = await checkPaths(env, root);
  assert.equal(good.error, undefined);
  assert.ok(ISOLATION_KEYS.every(name => good.paths[name].startsWith(`${root}/`)));
  const refused = async (patch, why) => assert.ok((await checkPaths({ ...env, ...patch }, root)).error, why);
  for (const name of ISOLATION_KEYS) {
    await refused({ [name]: undefined }, `${name} missing`);
    await refused({ [name]: '' }, `${name} empty`);
    await refused({ [name]: join(base, 'outside', 'x') }, `${name} outside`);
    await refused({ [name]: `${env.PARASELF_USER_DATA}/../../outside/x` }, `${name} dot-dot`);
    await refused({ [name]: `${env[name]}\r` }, `${name} CR`);
    await refused({ [name]: `${env[name]}\0` }, `${name} NUL`);
  }
  // The last segment a link out (a runtime file, then a whole directory), and a dangling one.
  await writeFile(join(base, 'outside', 'runtime.json'), '{}');
  await symlink(join(base, 'outside', 'runtime.json'), join(root, 'runtime-link'));
  await refused({ PARASELF_RUNTIME_FILE: join(root, 'runtime-link') }, 'leaf symlink');
  await symlink(join(base, 'outside'), join(root, 'data-link'));
  await refused({ PARASELF_USER_DATA: join(root, 'data-link') }, 'directory symlink');
  await refused({ PARASELF_CAPTURE_SPOOL: join(root, 'data-link', 'capture-spool') }, 'under a directory symlink');
  await symlink(join(base, 'outside', 'gone'), join(root, 'dangling'));
  await refused({ PARASELF_RUNTIME_FILE: join(root, 'dangling') }, 'dangling symlink');
  // A sibling whose name is root plus a newline: `$(…)` once stripped it and took the path for one under root.
  await mkdir(`${root}\n`);
  await refused({ PARASELF_RUNTIME_FILE: `${root}\n/runtime.json` }, 'newline sibling');
  assert.ok((await checkPaths(env, `${root}\n`)).error, 'root with a newline');
}));

const failed = (body, structured) => ({ result: { isError: true, content: [{ type: 'text', text: body }], ...(structured ? { structuredContent: structured } : {}) } });
const MARK = 'SYNTHETIC_FOREIGN_TEXT';
const withRecord = patch => [{ ...record, ...patch }];

test('results: every field the seed\'s own or said in fixed words, the text saying nothing beyond them', () => {
  assert.equal(checkResult(result(), seeded), null);
  assert.equal(checkResult(result([]), seeded), null);
  // A query shows another window of the note, and its own fixed reasons.
  const window = withRecord({ sourceRef: { ...record.sourceRef, excerpt: '## 决策\n会话缓存放在 Valkey 集群。', excerptStartLine: 13, truncated: true }, matchReason: '标题、已作选择或原文与查询存在词面重合；相关不等于适用。' });
  assert.equal(checkResult(result(window), seeded), null);
  const refused = (message, why) => assert.ok(checkResult(message, seeded), why);
  // Nothing in the response vouches for itself (R2-N1).
  refused(result([], MARK, { guidance: MARK }), 'guidance in its own words');
  refused(result([], MARK, { extra: { longText: MARK } }), 'a context field beyond the schema');
  refused({ result: { content: [], structuredContent: { ...structured([]), message: MARK } } }, 'top message in its own words');
  refused({ result: { content: [], structuredContent: { ...structured([]), availability: MARK } } }, 'availability beyond its values');
  refused(result(withRecord({ summary: MARK }), textFor(withRecord({ summary: MARK }))), 'summary replaced under the seed\'s hash');
  refused(result(withRecord({ opaque: { data: MARK } })), 'a record field beyond the schema');
  refused(result(withRecord({ sourceRef: { ...record.sourceRef, excerpt: MARK } })), 'an excerpt not from the note');
  refused(result(withRecord({ warnings: [MARK] })), 'a warning in its own words');
  refused(result(withRecord({ applicability: { ...record.applicability, reasons: [MARK] } })), 'an applicability reason in its own words');
  refused(result(withRecord({ applicability: { ...record.applicability, scope: { ...record.applicability.scope, exceptions: [MARK] } } })), 'a scope not the seed\'s');
  refused(result(withRecord({ relations: [{ reason: MARK }] })), 'relations not the seed\'s');
  refused(result(withRecord({ id: 'FOREIGN' })), 'a record outside the catalog');
  refused(result(withRecord({ source: 'decisions' })), 'the same id from another source');
  refused(result(withRecord({ sourceRef: { ...record.sourceRef, contentHash: 'b'.repeat(64) } })), 'the same id, other content');
  // The text: only the checked fields and fixed words.
  refused(result([], `FOREIGN · ${MARK}`), 'empty results, text with a record');
  refused(result([record], `${textFor([record])}\n${MARK}`), 'clean record, text beyond it');
  refused(result([record], 'x'.repeat(64 * 1024 + 1)), 'text over 64 KiB');
  refused({ result: { content: [{ type: 'image', data: 'AA==' }], structuredContent: structured([]) } }, 'content other than text');
  refused({ result: { content: [{ type: 'text', text: 'plain' }] } }, 'no context');
  // An entry with no snapshot of its record (the old allow list's form) proves nothing of it.
  assert.ok(checkResult(result(), [{ source: 'summarize', id: 'SEED', contentHash: record.sourceRef.contentHash }]));
  // The scope the client asked for, echoed back in its own words.
  const repository = { id: `repo:${'c'.repeat(64)}`, project: 'lab-repo', relativeDirectory: '', identitySource: 'remote' };
  const asked = { repositoryPath: '/work/lab-repo', layer: 'backend', files: ['server/a.ts'] };
  const scoped = taskScope => result([], textFor([]), { taskScope });
  assert.equal(checkResult(scoped({ repository, layer: 'backend', files: ['server/a.ts'] }), seeded, { args: asked }), null);
  assert.ok(checkResult(scoped({ repository: { ...repository, project: MARK }, layer: 'backend', files: ['server/a.ts'] }), seeded, { args: asked }), 'a repository not asked for');
  assert.ok(checkResult(scoped({ layer: 'backend', files: [MARK] }), seeded, { args: asked }), 'files not asked for');
  // Errors only in the bridge's own words.
  assert.equal(checkResult(failed('无法解析指定的本机 Git 仓库。', { message: '无法解析指定的本机 Git 仓库。', availability: 'scope_unresolved', context: null }), seeded), null);
  assert.equal(checkResult(failed('Paraself 没有运行或连不上，这次没有发出。决策上下文检索本次没有完成核对，不能将不可用视为没有相关决策。'), seeded), null);
  assert.equal(checkResult(failed('没有检索：输入不符合要求（limit超出长度或数量上限）。按要求改正后再试。'), seeded), null);
  refused(failed(MARK), 'short error body');
  refused(failed('', { message: MARK, context: null }), 'short structured error');
  refused(failed(`Paraself 没有完成这次请求：${MARK}。`), 'a refusal carrying the App\'s words');
  refused(failed('短', { context: { results: [] } }), 'an error with a context');
  refused({ error: { code: -32603, message: MARK } }, 'a protocol error in its own words');
  // A record's date and the page's guidance on records with no judgment between them, in the App's fixed words (IMP-175).
  const pair = TRUSTED.appWording.find(words => words.startsWith('本页有未标记被替代'));
  const datedRecord = withRecord({ warnings: ['记录日期 2026-09-15。', ...record.warnings] });
  const paired = { guidance: `${structured([]).context.guidance}\n${pair}\n其他页的记录没有和本页比较。` };
  assert.equal(checkResult(result(datedRecord, textFor(datedRecord), paired), seeded), null);
  assert.equal(checkResult(result(withRecord({ warnings: ['决策日期 2026-09-15。'] }), textFor(withRecord({ warnings: ['决策日期 2026-09-15。'] }))), seeded), null);
  refused(result(withRecord({ warnings: [`记录日期 2026-09-15。${MARK}`] })), 'a date warning carrying words of its own');
  refused({ result: { structuredContent: structured([], { guidance: `${pair}${MARK}` }) } }, 'the pair guidance carrying words of its own');
  // Claude Code shows structuredContent alone: no text to hold to it.
  assert.equal(checkResult({ result: { structuredContent: structured([record]) } }, seeded, { text: false }), null);
});

test('forwarded structuredContent is rebuilt from the checked fields', () => {
  assert.deepEqual(rebuild(structured([record])), structured([record]));
});

test('initialize, tools/list and ping are the trusted bridge\'s, word for word', () => {
  const initialize = { protocolVersion: '2025-11-25', capabilities: TRUSTED.capabilities, serverInfo: TRUSTED.serverInfo, instructions: TRUSTED.instructions };
  assert.deepEqual(checkMeta('initialize', initialize).result, initialize);
  assert.ok(checkMeta('initialize', { ...initialize, instructions: MARK }).error);
  assert.ok(checkMeta('initialize', { ...initialize, serverInfo: { name: 'fake', version: '1' } }).error);
  assert.ok(checkMeta('initialize', { ...initialize, extra: MARK }).error);
  assert.deepEqual(checkMeta('tools/list', { tools: [TRUSTED.tool, { name: 'record_decision_journal_entry', description: MARK }] }).result, { tools: [TRUSTED.tool] });
  assert.ok(checkMeta('tools/list', { tools: [{ ...TRUSTED.tool, description: MARK }] }).error);
  assert.ok(checkMeta('tools/list', { tools: [{ ...TRUSTED.tool, inputSchema: { type: 'object', properties: {} } }] }).error);
  assert.deepEqual(checkMeta('ping', {}).result, {});
  assert.ok(checkMeta('ping', { note: MARK }).error);
});

test('error notices are rebuilt from fixed words: what an agent needs to correct its call, nothing else', () => {
  assert.match(errorNotice({ availability: 'scope_unresolved', message: 'SYNTHETIC' }), /^无法解析指定的本机 Git 仓库，未执行限定范围查询/);
  assert.equal(errorNotice({ availability: 'unavailable', message: 'Paraself 没有完成这次请求：SYNTHETIC。决策上下文…' }), 'Paraself 没有完成这次请求。决策上下文检索本次没有完成核对，不能将不可用视为没有相关决策。');
  assert.equal(errorNotice({ availability: 'invalid_input', message: '没有检索：输入不符合要求（limit超出长度或数量上限；SYNTHETIC）。按要求改正后再试。' }), '没有检索：输入不符合要求（limit超出长度或数量上限）。按要求改正后再试。');
  assert.doesNotMatch(errorNotice({ availability: 'other', message: 'SYNTHETIC' }), /SYNTHETIC/);
});

// A bridge that answers initialize and tools/list as the trusted bridge does (meta), each tools/call with the result it
// is handed, records what reached it (seen) and the names of the environment it was started with (envOut). Told so in
// <its path>.json: the guard starts it with the lab's environment allowlist alone, which no FAKE_ variable is on.
const FAKE_BRIDGE = `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const fake = JSON.parse(readFileSync(__filename + '.json', 'utf8'));
const meta = JSON.parse(readFileSync(fake.meta, 'utf8'));
if (fake.envOut) writeFileSync(fake.envOut, JSON.stringify(Object.keys(process.env)));
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(fake.seen, message.method + ' ' + (message.params?.name ?? '') + '\\n');
  if (message.id === undefined) return;
  const mode = fake.mode ?? '';
  if (mode === 'request-on-id') return out({ jsonrpc: '2.0', id: message.id, method: 'sampling/createMessage', params: { text: 'SYNTHETIC_FOREIGN_TEXT' } });
  if (mode === 'null' && message.method === 'tools/call') return process.stdout.write('null\\n');
  if (mode === 'slow' && message.method === 'ping') return;
  const result = message.method === 'tools/list' ? { tools: [meta.tool, meta.consultTool, { name: 'record_decision_journal_entry' }] }
    : message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: meta.capabilities, serverInfo: meta.serverInfo, instructions: meta.instructions }
    : message.method === 'tools/call' ? fake.result : {};
  if (mode === 'rpc-error' && message.method === 'tools/call') return out({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'SYNTHETIC_FOREIGN_TEXT' } });
  const reply = () => out({ jsonrpc: '2.0', id: message.id, result });
  if (mode === 'slow' && message.method === 'tools/call') return void setTimeout(reply, 300);
  reply();
});
`;
const META = fileURLToPath(new URL('./mcp-guard-7269a75d.json', import.meta.url));
const session = async ({ root, env, base }, result, calls, mode = '', tool = SEARCH) => {
  const bridge = join(base, 'fake-bridge.cjs');
  await writeFile(bridge, FAKE_BRIDGE, { mode: 0o755 });
  const seen = join(base, `seen-${Math.random()}`);
  const { command, args } = guardCommand(root, bridge, 'codex', tool);
  await writeFile(`${bridge}.json`, JSON.stringify({ result, seen, mode, meta: META }));
  const child = spawn(command, args, { env: { ...env, PARASELF_PROVIDER_CHILD: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  const closed = new Promise(done => child.on('close', done));
  const lines = [{ id: 1, method: 'initialize' }, { id: 2, method: 'tools/list' }, ...calls.map((call, index) => (typeof call === 'string' ? { id: 10 + index, method: 'tools/call', params: { name: call } } : call))];
  for (const line of lines) child.stdin.write(`${line.raw ?? JSON.stringify({ jsonrpc: '2.0', ...line })}\n`);
  await new Promise(done => setTimeout(done, 1_500));
  child.stdin.end();
  const code = await closed;
  return { code, replies: stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)), seen: existsSync(seen) ? await readFile(seen, 'utf8') : '' };
};

test('the guard passes a clean result, refuses other tools unforwarded, and stops at the first foreign record', () => lab(async context => {
  const { root } = context;
  await writeFile(join(root, ALLOWLIST), JSON.stringify(seeded));
  const clean = await session(context, result().result, ['search_decision_context', 'record_decision_journal_entry']);
  assert.deepEqual(clean.replies.find(reply => reply.id === 1).result.serverInfo, TRUSTED.serverInfo);
  assert.deepEqual(clean.replies.find(reply => reply.id === 2).result, { tools: [TRUSTED.tool] });
  assert.deepEqual(clean.replies.find(reply => reply.id === 10).result.structuredContent.context.results.map(item => item.id), ['SEED']);
  assert.equal(clean.replies.find(reply => reply.id === 11).result.isError, true);
  assert.doesNotMatch(clean.seen, /record_decision_journal_entry/);
  assert.match(clean.seen, /initialize/);
  assert.equal(existsSync(join(root, LEAK)), false);

  const foreign = { ...record, id: 'FOREIGN' };
  const leaked = await session(context, result([record], textFor([record, foreign])).result, ['search_decision_context', 'search_decision_context']);
  assert.equal(leaked.code, 3);
  const blocked = leaked.replies.find(reply => reply.id === 10);
  assert.equal(blocked.result.isError, true);
  assert.doesNotMatch(JSON.stringify(leaked.replies), /FOREIGN/);
  assert.equal(leaked.replies.some(reply => reply.id === 11), false);
  assert.match(await readFile(join(root, LEAK), 'utf8'), /text not accounted for by its records/);
}));

test('the guard holds the envelope: live ids, bridge requests, batches, errors and its own faults', () => lab(async context => {
  const { root } = context;
  await writeFile(join(root, ALLOWLIST), JSON.stringify(seeded));
  const foreign = result([{ ...record, id: 'FOREIGN' }]).result;
  const cleared = async () => { await rm(join(root, LEAK), { force: true }); await rm(join(root, GUARD_FAULT), { force: true }); };
  // A ping on the id of a tools/call still out: refused, so the call's answer is still checked as one.
  const reused = await session(context, foreign, [{ id: 10, method: 'tools/call', params: { name: 'search_decision_context' } }, { id: 10, method: 'ping' }], 'slow');
  assert.equal(reused.code, 3);
  assert.doesNotMatch(JSON.stringify(reused.replies), /FOREIGN/);
  assert.match(reused.replies.find(reply => reply.error)?.error.message ?? '', /already in use/);
  assert.equal((reused.seen.match(/ping/g) ?? []).length, 0);
  await cleared();
  // A request of the bridge's own on a pending id is no answer.
  const collided = await session(context, foreign, [], 'request-on-id');
  assert.equal(collided.code, 3);
  assert.doesNotMatch(JSON.stringify(collided.replies), /SYNTHETIC_FOREIGN_TEXT/);
  assert.match(await readFile(join(root, LEAK), 'utf8'), /bridge request on a pending id/);
  await cleared();
  // JSON that is not an object stops the guard as a fault of its own.
  const nulled = await session(context, foreign, ['search_decision_context'], 'null');
  assert.equal(nulled.code, 3);
  assert.match(await readFile(join(root, GUARD_FAULT), 'utf8'), /not an object/);
  await cleared();
  // A batch is answered, not dropped; an error reaches the client in fixed words only.
  const batch = await session(context, failed('SYNTHETIC_FOREIGN_TEXT').result, [{ raw: JSON.stringify([{ jsonrpc: '2.0', id: 20, method: 'ping' }]) }], '');
  assert.match(batch.replies.find(reply => reply.id === null)?.error.message ?? '', /Batch/);
  const refused = await session(context, failed('无法解析指定的本机 Git 仓库。', { message: '无法解析指定的本机 Git 仓库。', availability: 'scope_unresolved', context: null }).result, ['search_decision_context']);
  assert.equal(refused.replies.find(reply => reply.id === 10).result.structuredContent.availability, 'scope_unresolved');
  assert.match(refused.replies.find(reply => reply.id === 10).result.content[0].text, /^无法解析指定的本机 Git 仓库，未执行限定范围查询/);
  const protocol = await session(context, foreign, ['search_decision_context'], 'rpc-error');
  assert.deepEqual(protocol.replies.find(reply => reply.id === 10).error, { code: -32603, message: '请求没有完成（实验守卫隐去了原因）。' });
  assert.equal(existsSync(join(root, LEAK)), false);
}));

test('the guard never starts the bridge without a safe path or a catalog', () => lab(async context => {
  const { root, env, base } = context;
  const bridge = join(base, 'fake-bridge.cjs');
  await writeFile(bridge, FAKE_BRIDGE, { mode: 0o755 });
  const start = async extra => {
    const { command, args } = guardCommand(root, bridge, 'codex');
    const child = spawn(command, args, { env: extra, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end();
    return { code: await new Promise(done => child.on('close', done)), stderr };
  };
  const empty = await start({});
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /PARASELF_USER_DATA is not set/);
  assert.match((await start(env)).stderr, /agent-allowlist\.json is missing/);
}));

// consult_decision_principles: the r18 scenario's own seeds, recalled by the App's code and rendered by the bridge's.
const consulted = async (question = '数据库迁移之前要不要先演练一次回退？', patch = response => response) => {
  const { allow, consult } = await consultSeeds();
  const result = await consultDecisionPrinciples({ question, options: [{ label: '先在预发环境演练回退' }, { label: '直接迁移' }], project: 'lab' },
    { sourceClient: 'codex', cwd: tmpdir(), runtime: { consult: async request => patch(consult(request)) } });
  return { allow, message: { result } };
};
/** A consultation as a bridge would send it, text and message rendered from it: only the field rules are left to refuse it. */
const asSent = consultation => ({ result: { content: [{ type: 'text', text: consultText(consultation) }],
  structuredContent: { message: consultNotice(consultation), availability: 'available', consultation } } });

test('consult: the App\'s recall of the seeds, as the bridge renders it, passes and is forwarded as it was', async () => {
  const { allow, message } = await consulted();
  const c = message.result.structuredContent.consultation;
  assert.deepEqual(c.matches.map(match => match.principleId), ['PRINCIPLE-ROLLBACK']);
  assert.deepEqual(c.signals.map(signal => signal.recordId).sort(), ['IDEA-R18-INBOX', 'PREF-R18-ACTIVE']);
  assert.equal(checkResult(message, allow, { tool: CONSULT }), null);
  assert.equal(checkResult({ result: { structuredContent: message.result.structuredContent } }, allow, { tool: CONSULT, text: false }), null);
  assert.deepEqual(consultForward(message.result), message.result);
  const none = await consulted('登录页的按钮用蓝色还是绿色？');
  assert.equal(none.message.result.structuredContent.consultation.status, 'no_match');
  assert.equal(checkResult(none.message, none.allow, { tool: CONSULT }), null);
  // The same result is not a search's, nor a search's a consultation's.
  assert.ok(checkResult(message, allow));
  assert.ok(checkResult(result(), seeded, { tool: CONSULT }));
});

test('consult: every field the seed\'s own, said in fixed words or in the format it has; the text the bridge\'s rendering', async () => {
  const { allow, message } = await consulted();
  const base = message.result.structuredContent.consultation;
  const refused = (change, why, rule) => {
    const c = structuredClone(base);
    change(c);
    const reason = checkResult(asSent(c), allow, { tool: CONSULT });
    assert.ok(reason, why);
    if (rule) assert.match(reason, rule, why);
  };
  const signal = c => c.signals.find(item => item.recordId === 'PREF-R18-ACTIVE');
  assert.equal(checkResult(asSent(base), allow, { tool: CONSULT }), null);
  // Unknown keys, at every level.
  refused(c => { c.extra = MARK; }, 'a consultation key beyond the schema', /consultation beyond/);
  refused(c => { c.matches[0].note = MARK; }, 'a match key beyond the schema', /unknown key in a match/);
  refused(c => { signal(c).note = MARK; }, 'a signal key beyond the schema', /unknown key in a signal/);
  refused(c => { c.feedback.extra = MARK; }, 'a receipt key beyond the schema', /feedback/);
  refused(c => { c.boundary.extra = true; }, 'a boundary key beyond the fixed one', /boundary/);
  // Forged matches and signals: content not the seed's, records not seeded, a principle not adopted.
  refused(c => { c.matches[0].principleId = 'FOREIGN'; }, 'a principle not seeded', /outside the seeded principles/);
  refused(c => { c.matches[0].principle = MARK; }, 'a principle\'s text replaced', /principle differs/);
  refused(c => { c.matches[0].caution = `${c.matches[0].caution}${MARK}`; }, 'a caution with words added', /caution differs/);
  refused(c => { c.matches.push({ ...c.matches[0], principleId: 'PREF-R18-ACTIVE' }); }, 'a preference passed off as a principle', /outside the seeded principles/);
  refused(c => { signal(c).recordId = 'FOREIGN'; }, 'a signal not seeded', /outside the seeded preferences/);
  refused(c => { signal(c).summary = MARK; }, 'a signal\'s content replaced', /not the seed's/);
  refused(c => { signal(c).kind = 'idea'; }, 'a preference called an idea', /not the seed's/);
  refused(c => { c.signals[c.signals.length - 1] = { ...signal(c), recordId: 'PRINCIPLE-ROLLBACK' }; }, 'a principle passed off as a signal', /outside the seeded preferences/);
  // Standing, qualifier, reason and terms: fixed words, the record's own strings and numbers, nothing else.
  refused(c => { signal(c).standing = `偏好：${MARK}`; }, 'a standing in its own words', /standing/);
  refused(c => { signal(c).qualifier = `适用：${MARK}`; }, 'a qualifier in its own words', /qualifier/);
  refused(c => { signal(c).qualifier = '例外：快照恢复不需要回退脚本。'; }, 'a qualifier in another seed\'s words', /qualifier/);
  refused(c => { signal(c).reason = `偏好与当前决策存在文本重合，共同出现“${MARK}”。`; }, 'a reason naming a term not the seed\'s', /reason/);
  refused(c => { c.matches[0].reason = '原则内容与当前决策存在文本重合，共同出现“快照”。'; }, 'a principle\'s reason in another seed\'s words', /reason/);
  refused(c => { signal(c).matchedTerms = ['快照']; }, 'a term from another seed', /matchedTerms/);
  refused(c => { c.matches[0].matchedTerms = ['迁移', '回退', '验证', '数据']; }, 'four terms', /matchedTerms/);
  // Formats: ids and receipts, enums, scores, the boundary.
  refused(c => { c.requestId = 'request-1'; }, 'a requestId not a UUID', /consultation beyond/);
  refused(c => { c.feedback.token = MARK; }, 'a token not a UUID', /feedback/);
  refused(c => { c.feedback.expiresAt = '下周'; }, 'an expiry not a datetime', /feedback/);
  refused(c => { c.boundary.noPreferencePromoted = false; }, 'a boundary not the fixed one', /boundary/);
  refused(c => { delete c.boundary.noPreferencePromoted; }, 'a boundary short of the fixed one', /boundary/);
  refused(c => { signal(c).relevance = 'strong'; }, 'a strong signal', /signal beyond/);
  refused(c => { c.matches[0].relevanceScore = 101; }, 'a score past 100', /match beyond/);
  refused(c => { c.matches[0].confidence = MARK; }, 'a confidence beyond its values', /match beyond/);
  refused(c => { c.status = 'no_match'; }, 'no_match beside a match', /matches/);
  refused(c => { c.noMatchReason = 'no_accepted_principles'; }, 'a reason for no match beside a match', /noMatchReason/);
  refused(c => { c.signalsIncomplete = false; }, 'a flag beyond its one value', /flag/);
  // The text and the message: exactly what the bridge renders from the fields, not a word more.
  const sent = message.result;
  const extra = (text, notice = sent.structuredContent.message) => ({ result: { content: [{ type: 'text', text }], structuredContent: { ...sent.structuredContent, message: notice } } });
  assert.match(checkResult(extra(`${sent.content[0].text}\n${MARK}`), allow, { tool: CONSULT }), /text not/);
  assert.match(checkResult(extra(sent.content[0].text.replace('原则：', `原则：${MARK}`)), allow, { tool: CONSULT }), /text not/);
  assert.match(checkResult(extra(sent.content[0].text, `${sent.structuredContent.message}${MARK}`), allow, { tool: CONSULT }), /message not/);
  assert.ok(checkResult({ result: { ...sent, structuredContent: { ...sent.structuredContent, extra: MARK } } }, allow, { tool: CONSULT }), 'a structuredContent key beyond the schema');
  assert.ok(checkResult({ result: { ...sent, structuredContent: { ...sent.structuredContent, reason: 'busy' } } }, allow, { tool: CONSULT }), 'a reason beside a consultation');
  assert.ok(checkResult({ result: { content: [{ type: 'image', data: 'AA==' }], structuredContent: sent.structuredContent } }, allow, { tool: CONSULT }), 'content other than text');
  // Claude Code shows structuredContent alone: the message is still held to the rendering.
  assert.ok(checkResult({ result: { structuredContent: { ...sent.structuredContent, message: MARK } } }, allow, { tool: CONSULT, text: false }));
});

test('consult: an unavailable App and a refused argument pass in the bridge\'s words alone, forwarded as fixed notices', async () => {
  const notice = 'Paraself 没有运行或连不上，这次没有发出。因此没有读取到本地已采纳原则。不要因此阻断原生决策流程，也不要假装已完成原则核对；请继续独立分析当前选项。';
  const unavailable = (message, reason = 'not_running') => ({ result: { content: [{ type: 'text', text: message }], structuredContent: { message, availability: 'unavailable', reason, consultation: null } } });
  assert.equal(checkResult(unavailable(notice), [], { tool: CONSULT }), null);
  assert.deepEqual(consultForward(unavailable(notice).result), unavailable(notice).result);
  const refusedByApp = `Paraself 没有完成这次请求：${MARK}。因此没有读取到本地已采纳原则。不要因此阻断原生决策流程，也不要假装已完成原则核对；请继续独立分析当前选项。`;
  assert.ok(checkResult(unavailable(refusedByApp, 'refused'), [], { tool: CONSULT }), 'the App\'s own words in a refusal');
  assert.doesNotMatch(JSON.stringify(consultForward(unavailable(refusedByApp, 'refused').result)), new RegExp(MARK));
  assert.ok(checkResult(unavailable(notice, MARK), [], { tool: CONSULT }), 'a reason beyond its values');
  assert.ok(checkResult({ result: { ...unavailable(notice).result, structuredContent: { ...unavailable(notice).result.structuredContent, consultation: {} } } }, [], { tool: CONSULT }), 'unavailable with a consultation');
  const invalid = text => ({ result: { isError: true, content: [{ type: 'text', text }] } });
  assert.equal(checkResult(invalid('Input validation error: Invalid arguments for tool consult_decision_principles: question: Invalid input'), [], { tool: CONSULT }), null);
  assert.ok(checkResult(invalid(`Input validation error: ${MARK}`), [], { tool: CONSULT }));
  assert.ok(checkResult({ result: { ...invalid('Invalid input').result, structuredContent: { message: 'x' } } }, [], { tool: CONSULT }), 'an error with structuredContent');
  assert.doesNotMatch(consultForward(invalid('Invalid input').result).content[0].text, /Invalid/);
  assert.ok(checkResult({ error: { code: -32603, message: MARK } }, [], { tool: CONSULT }), 'a protocol error in its own words');
});

test('consult: tools/list answered with the trusted consult definition alone', () => {
  assert.deepEqual(checkMeta('tools/list', { tools: [TRUSTED.tool, TRUSTED.consultTool] }, CONSULT).result, { tools: [TRUSTED.consultTool] });
  assert.ok(checkMeta('tools/list', { tools: [{ ...TRUSTED.consultTool, description: MARK }] }, CONSULT).error);
  assert.ok(checkMeta('tools/list', { tools: [TRUSTED.tool] }, CONSULT).error);
  assert.ok(checkMeta('tools/list', { tools: [TRUSTED.consultTool] }, 'record_decision_journal_entry').error);
});

test('the guard opened for consult passes a clean consultation and refuses search unforwarded', () => lab(async context => {
  const { root } = context;
  const { allow, message } = await consulted();
  await writeFile(join(root, ALLOWLIST), JSON.stringify(allow));
  const run = await session(context, message.result, [CONSULT, SEARCH], '', CONSULT);
  assert.deepEqual(run.replies.find(reply => reply.id === 2).result, { tools: [TRUSTED.consultTool] });
  assert.deepEqual(run.replies.find(reply => reply.id === 10).result, message.result);
  assert.equal(run.replies.find(reply => reply.id === 11).result.isError, true);
  assert.doesNotMatch(run.seen, /search_decision_context/);
  assert.equal(existsSync(join(root, LEAK)), false);
  const forged = structuredClone(message.result);
  forged.structuredContent.consultation.signals[0].summary = MARK;
  forged.content[0].text = consultText(forged.structuredContent.consultation);
  const leaked = await session(context, forged, [CONSULT], '', CONSULT);
  assert.equal(leaked.code, 3);
  assert.doesNotMatch(JSON.stringify(leaked.replies), new RegExp(MARK));
  assert.match(await readFile(join(root, LEAK), 'utf8'), /signal summary not the seed's/);
}));

// R18 rework (R18-REVIEW.md, second part).

// G1: the App, a bridge asked directly, one behind a guard for a deterministic step, and one behind the guard a client
// under test starts, each given whatever the outer environment held: none keeps a name off the lab's allowlist.
const SENTINELS = { CLAUDE_CODE_MESSAGING_TOKEN: 'synthetic-sentinel', MiXeD_Api_KeY: 'synthetic-sentinel', NONSTANDARD_AUTH_BLOB: 'synthetic-sentinel',
  NODE_OPTIONS: '--no-warnings', LAB_PLAIN_SENTINEL: 'synthetic-sentinel' };
const FAKE_APP = `#!/usr/bin/env node
require('node:fs').writeFileSync(require('node:path').join(process.env.PARASELF_USER_DATA, 'env-names.json'), JSON.stringify(Object.keys(process.env)));
`;
const keptNone = (names, path) => {
  for (const name of Object.keys(SENTINELS)) assert.ok(!names.includes(name), `${path} kept ${name}`);
  for (const name of ISOLATION_KEYS) assert.ok(names.includes(name), `${path} lost ${name}`);
  assert.ok(!names.some(name => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH/i.test(name)), `${path} kept a credential-like name`);
};
test('G1: App, direct bridge, guarded bridge and an agent\'s guard start with the lab allowlist alone', () => lab(async context => {
  const { root, base } = context;
  const outer = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...SENTINELS };
  const env = isolationEnvironment(root, outer);
  // The App: a stand-in executable that writes down its environment's names and exits.
  const app = join(base, 'fake-app.cjs');
  await writeFile(app, FAKE_APP, { mode: 0o755 });
  await assert.rejects(startIsolatedApp({ root, executable: app, base: outer, timeoutMs: 5_000 }), /exited/);
  keptNone(JSON.parse(await readFile(join(env.PARASELF_USER_DATA, 'env-names.json'), 'utf8')), 'App');
  // The bridges: the fake one, told to write its environment's names.
  const bridge = join(base, 'fake-bridge.cjs');
  await writeFile(bridge, FAKE_BRIDGE, { mode: 0o755 });
  const told = async name => { const envOut = join(base, `${name}.json`); await writeFile(`${bridge}.json`, JSON.stringify({ seen: join(base, 'seen'), meta: META, envOut })); return envOut; };
  let envOut = await told('direct');
  (await connectMcp({ env, bridge })).close();
  keptNone(JSON.parse(await readFile(envOut, 'utf8')), 'direct bridge');
  await writeFile(join(root, ALLOWLIST), JSON.stringify(seeded));
  envOut = await told('guarded');
  (await connectMcp({ env, ...guardCommand(root, bridge, 'claude-code', CONSULT) })).close();
  keptNone(JSON.parse(await readFile(envOut, 'utf8')), 'guarded bridge');
  // A client under test starts the guard with what it has: here every sentinel besides.
  envOut = await told('agent');
  const { command, args } = guardCommand(root, bridge, 'claude-code', CONSULT);
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const answered = new Promise(done => child.stdout.once('data', done));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
  await answered;
  child.stdin.end();
  await new Promise(done => child.on('close', done));
  keptNone(JSON.parse(await readFile(envOut, 'utf8')), 'agent\'s guard bridge');
  // Refused by name, never by value.
  assert.throws(() => assertLabProcessEnvironment({ PATH: '/bin', MiXeD_Api_KeY: 'synthetic-sentinel' }), error => /MiXeD_Api_KeY/.test(error.message) && !/synthetic-sentinel/.test(error.message));
  assert.throws(() => assertLabProcessEnvironment({ NODE_OPTIONS: '--no-warnings' }), /NODE_OPTIONS/);
}));

// G2: what passed the guard, as each client is shown it, passes the driver's canary; a word added there does not.
const claudeStream = (name, result) => [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: `mcp__paraself__${name}`, input: { question: 'q' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: result.isError === true,
    content: [{ type: 'text', text: result.structuredContent ? JSON.stringify(result.structuredContent) : result.content.map(part => part.text).join('\n') }] }] } },
].map(event => JSON.stringify(event)).join('\n');
const codexStream = (name, result) => JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'paraself', tool: name, arguments: { question: 'q' },
  status: 'completed', result: { content: result.content, structured_content: result.structuredContent, is_error: result.isError === true } } });
const seenBy = (client, name, result, allow) => canary(parseAgentRun(client, client === 'claude' ? claudeStream(name, result) : codexStream(name, result)).calls, allow);
test('G2: check, forward, then each client\'s canary: the guard\'s own notices pass, nothing beside them', async () => {
  const { allow, message } = await consulted();
  const sdk = { isError: true, content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool consult_decision_principles: question: Invalid input' }] };
  const unavailableText = 'Paraself 没有运行或连不上，这次没有发出。因此没有读取到本地已采纳原则。不要因此阻断原生决策流程，也不要假装已完成原则核对；请继续独立分析当前选项。';
  const unavailable = { content: [{ type: 'text', text: unavailableText }], structuredContent: { message: unavailableText, availability: 'unavailable', reason: 'not_running', consultation: null } };
  for (const bridgeResult of [sdk, unavailable, message.result]) {
    assert.equal(checkResult({ result: bridgeResult }, allow, { tool: CONSULT }), null);
    const shown = consultForward(bridgeResult);
    for (const client of ['claude', 'codex']) assert.deepEqual(seenBy(client, CONSULT, shown, allow), { foreign: [], violations: [], ok: true }, `${client}: ${shown.content[0].text.slice(0, 20)}`);
  }
  // Search's notices the same way.
  for (const structured of [{ message: 'x', availability: 'invalid_input', context: null }, { message: 'x', availability: 'scope_unresolved', context: null }, { availability: 'other' }]) {
    const notice = errorNotice(structured);
    const shown = { isError: true, content: [{ type: 'text', text: notice }], structuredContent: { message: notice, availability: structured.availability === 'other' ? 'error' : structured.availability, context: null } };
    for (const client of ['claude', 'codex']) assert.equal(seenBy(client, SEARCH, shown, seeded).ok, true, `${client}: ${notice}`);
  }
  // Only the guard's exact notice in its exact shape.
  const notice = consultForward(sdk);
  for (const client of ['claude', 'codex']) {
    assert.equal(seenBy(client, CONSULT, { ...notice, content: [{ type: 'text', text: `${notice.content[0].text}${MARK}` }] }, allow).ok, false, `${client}: words added`);
    assert.equal(seenBy(client, CONSULT, { ...notice, content: [{ type: 'text', text: '核对没有完成，原因是 App 说的话。' }] }, allow).ok, false, `${client}: a notice of its own`);
  }
  assert.ok(checkResult({ result: { ...notice, structuredContent: { message: notice.content[0].text } } }, allow, { tool: CONSULT }), 'the notice with structuredContent');
  assert.ok(checkResult({ result: { ...notice, content: [...notice.content, { type: 'text', text: '' }] } }, allow, { tool: CONSULT }), 'the notice in two parts');
});

// G3: a summary and a qualifier as the App cuts them, worked out from the seed; nothing else in their place.
const longText = (lead, length) => { let text = lead; while (text.length < length) text += '数据库迁移回退演练记录。'; return text.slice(0, length); };
const preference = (id, content, appliesWhen = '结构迁移时。', exceptions = '空表迁移除外。', extra = {}) =>
  ({ id, draft: { kind: 'preference', title: '迁移回退演练', content, knowledgeStatus: 'active', appliesWhen, exceptions, ...extra } });
const signalOf = (c, id) => c.signals.find(signal => signal.recordId === id);
const guarded = (c, allow) => checkResult(asSent(c), allow, { tool: CONSULT });
test('G3: summaries and qualifiers of 4000 and past it pass as the App excerpts them; another cut, or a word past the mark, does not', async () => {
  const { allow, consult } = await journalCase([
    preference('P4000', longText('数据库迁移回退演练：', 4_000)), preference('P4001', longText('数据库迁移回退演练：', 4_001)),
    preference('PLONG', '数据库迁移回退要演练。', longText('结构迁移时：', 3_990), longText('例外：', 2_000)),
  ]);
  const c = consult('数据库迁移回退要不要演练？');
  assert.deepEqual(c.signals.map(signal => signal.recordId).sort(), ['P4000', 'P4001', 'PLONG']);
  assert.equal(signalOf(c, 'P4000').summary.length, 4_000);
  assert.ok(signalOf(c, 'P4001').summary.endsWith('…（节选）'));
  assert.ok(signalOf(c, 'PLONG').qualifier.endsWith('…（节选）'));
  assert.equal(guarded(c, allow), null);
  const refused = (id, change, why) => { const next = structuredClone(c); change(signalOf(next, id)); assert.ok(guarded(next, allow), why); };
  refused('P4001', signal => { signal.summary = `${signal.summary}X`; }, 'a word past the excerpt mark');
  refused('P4001', signal => { signal.summary = `${signal.summary.slice(0, 3_990)}…（节选）`; }, 'another cut of the same text');
  refused('P4000', signal => { signal.summary = `${signal.summary.slice(0, 3_995)}…（节选）`; }, 'a summary of 4000 cut all the same');
  refused('PLONG', signal => { signal.qualifier = `${signal.qualifier}${MARK}`; }, 'a word past the qualifier\'s mark');
  refused('PLONG', signal => { signal.qualifier = signal.qualifier.replace('…（节选）', `${MARK}…（节选）`); }, 'a word before the qualifier\'s mark');
  refused('PLONG', signal => { signal.qualifier = signal.qualifier.slice(0, 3_000); }, 'a qualifier cut without its mark');
});
// G4: a language's label as the App says it, from the seed's own languages.
test('G4: languages from the seed, said by the pinned labels; another label, or one of its own, is refused', async () => {
  const { allow, consult } = await journalCase([
    preference('PGO', '迁移回退先演练。', '结构迁移时。', '空表除外。', { languages: ['golang'] }),
    preference('PJS', '迁移回退脚本先演练。', '结构迁移时。', '空表除外。', { languages: ['js'] }),
    preference('PZIG', '迁移回退演练用脚本。', '结构迁移时。', '空表除外。', { languages: ['Zig'] }),
    preference('PNONE', '迁移回退演练要记录。', '结构迁移时。', '空表除外。'),
  ]);
  const all = consult('迁移回退要不要先演练？');
  assert.equal(all.signals.length, 3);
  assert.equal(guarded(all, allow), null);
  const go = consult('迁移回退要不要先演练？', { languages: ['go'] });
  assert.match(signalOf(go, 'PGO').reason, /适用语言：Go。/u);
  assert.equal(guarded(go, allow), null);
  const ts = consult('迁移回退脚本要不要先演练？', { languages: ['typescript'] });
  assert.match(signalOf(ts, 'PJS').reason, /适用语言：JavaScript。/u);
  assert.equal(guarded(ts, allow), null);
  const zig = consult('迁移回退演练用脚本吗？', { languages: ['zig'] });
  assert.match(signalOf(zig, 'PZIG').reason, /适用语言：zig。/u);
  assert.equal(guarded(zig, allow), null);
  const refused = (c, id, change, why) => { const next = structuredClone(c); change(signalOf(next, id)); assert.ok(guarded(next, allow), why); };
  refused(go, 'PGO', signal => { signal.reason = signal.reason.replace('Go', 'Rust'); }, 'a pinned label not the seed\'s');
  refused(go, 'PGO', signal => { signal.reason = signal.reason.replace('Go', 'Golang'); }, 'the seed\'s language in other words');
  refused(zig, 'PZIG', signal => { signal.reason = signal.reason.replace('zig', 'Zig'); }, 'an unknown language other than as kept');
  refused(zig, 'PZIG', signal => { signal.reason = signal.reason.replace('适用语言：zig。', ''); }, 'a seed\'s languages left unsaid');
  const none = consult('迁移回退演练要记录吗？', { languages: ['go'] });
  refused(none, 'PNONE', signal => { signal.reason = signal.reason.replace('。它', '。适用语言：Go。它'); }, 'a language for a seed kept for none');
});

// main's App never recalls an archived record (journal-recall.ts), so a signal for one is refused, even in the seed's own words.
test('consult: a signal for an archived record is refused', async () => {
  const { allow, message } = await consulted();
  const base = message.result.structuredContent.consultation;
  const archived = allow.find(item => item.id === 'IDEA-R18-ARCHIVED');
  assert.equal(archived.entry.knowledgeStatus, 'archived');
  const signal = { ...structuredClone(base.signals[0]), recordId: archived.id, kind: archived.entry.kind, title: archived.entry.title, summary: archived.entry.content };
  const sent = asSent({ ...structuredClone(base), signals: [signal] });
  assert.match(checkResult(sent, allow, { tool: CONSULT }) ?? '', /signal for an archived record/);
});

// G5 (the part not about L1): terms from what the recall matched on alone, never from a revision's change note.
test('G5: an active record\'s terms come from its fields, never from a change note', async () => {
  const draft = { kind: 'preference', title: '迁移回退演练', content: '数据库迁移回退前手动核对清单。', knowledgeStatus: 'active', appliesWhen: '每次迁移回退时。', exceptions: '紧急回滚除外。' };
  const { allow, consult } = await journalCase([{ id: 'PLIVE', draft, revisions: [{ knowledgeStatus: 'active', changeNote: '校验开销甲' }] }]);
  const live = term => ({ recordId: 'PLIVE', kind: 'preference', title: draft.title, summary: draft.content, standing: '偏好：当前立场，允许例外；未经方法论流程确认前不是已采纳原则',
    qualifier: '适用：每次迁移回退时。｜例外：紧急回滚除外。', relevanceScore: 30, relevance: 'possible', matchedTerms: [term],
    reason: `偏好与当前决策存在文本重合，共同出现“${term}”。它不是已采纳原则，只作为用户自己的偏好提醒。` });
  const base = consult('迁移回退要不要演练？');
  const passes = signal => checkResult(asSent({ ...structuredClone(base), signals: [signal] }), allow, { tool: CONSULT });
  assert.equal(passes(live('每次')), null);
  assert.match(passes(live('校验')) ?? '', /matchedTerms/);
});

test('the guard\'s own error notice is taken in its exact shape: its one text block with a key of its own is refused', async () => {
  const { allow } = await consulted();
  const text = '核对没有完成（实验守卫隐去了原因），可以换个参数再试。';
  assert.equal(checkResult({ result: { isError: true, content: [{ type: 'text', text }] } }, allow, { tool: CONSULT }), null);
  assert.ok(checkResult({ result: { isError: true, content: [{ type: 'text', text, annotations: { audience: ['user'] } }] } }, allow, { tool: CONSULT }), 'an unknown key in the block');
  assert.ok(checkResult({ result: { isError: true, content: [{ type: 'text', text, _meta: { foreign: MARK } }] } }, allow, { tool: CONSULT }), 'a _meta key in the block');
});
