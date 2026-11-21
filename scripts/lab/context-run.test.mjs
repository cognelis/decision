import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, seeded, structured, textFor } from './mcp-guard.fixture.mjs';
import { expand, vaultFile, score, metrics, abnormalExits, parseAgentRun, scoreAnswer, canary, testedEnvironment, runAgent, checkSeedCatalog, CLI_OPTIONS, parseAgents, createdRecordId, agentCommand, AGENT_PROMPTS, PROMPT_TOOLS, isJournalSeed, journalSnapshot, resultIds } from './context-run.mjs';
import { readFile } from 'node:fs/promises';
import { parseJournalEntry, serializeJournalEntry } from '@cognelis/decision-storage';
import { CONSULT, guardCommand } from './mcp-guard.mjs';
test('the neutral prompt asks for one value and drops the hints to tell old from new or to search again', () => {
  const guard = { command: 'node', args: ['guard.mjs'] };
  for (const client of ['claude', 'codex']) {
    const asked = agentCommand({ client, model: 'm', question: 'Q?', cwd: '/c', guard, mcpConfig: '/m.json', prompt: AGENT_PROMPTS.neutral }).args;
    assert.ok(asked.includes(AGENT_PROMPTS.neutral + 'Q?'));
    assert.ok(!asked.some(arg => /现在有效|换说法/u.test(arg)));
    assert.ok(agentCommand({ client, model: 'm', question: 'Q?', cwd: '/c', guard, mcpConfig: '/m.json' }).args.includes(AGENT_PROMPTS.default + 'Q?'));
  }
});
test('references preserve values and reject missing writes', () => {
  assert.deepEqual(expand({ id: { $ref: 'seed.id' }, revision: { $ref: 'seed.revision' } }, { seed: { id: 'x', revision: 0 } }), { id: 'x', revision: 0 });
  assert.throws(() => expand({ $ref: 'missing.id' }, {}), /Unresolved/);
});
test('seed paths cannot escape the synthetic journal', () => {
  assert.equal(vaultFile('/tmp/vault', 'Decision Journal/summarize/a.md'), '/tmp/vault/Decision Journal/summarize/a.md');
  for (const path of ['/etc/a', '../private', 'Decision Journal/../../private']) assert.throws(() => vaultFile('/tmp/vault', path));
});
test('recall uses rank cutoff, exclusion checks whole page, absent flags fail', () => {
  const result = score({ result: { structuredContent: { context: { results: [{ id: 'noise' }, { id: 'good' }] } } } }, { k: 1, mustInclude: ['good'], mustExclude: ['noise'], mustFlag: [{ id: 'absent', path: 'current', equals: false }], writeReadback: true });
  assert.equal(result.recall, 0); assert.equal(result.reciprocalRank, 0); assert.equal(result.leaks, 1); assert.equal(result.correctFlags, 0); assert.equal(result.pass, false);
  assert.equal(metrics([result]).writeReadbackRate, 0);
});
test('principles use matches, never promote separate signals into recall', () => {
  const result = score({ result: { structuredContent: { consultation: { matches: [{ principleId: 'p' }], signals: [{ recordId: 's' }] } } } }, { mustInclude: ['p'], mustExclude: ['s'] });
  assert.equal(result.recall, 1); assert.equal(result.reciprocalRank, 1); assert.equal(result.pass, true);
});
test('instances ended on a signal or a non-zero code are listed, a clean or unrecorded end is not', () => {
  assert.deepEqual(abnormalExits([
    { scenario: 'a', seedPid: 1, seedExitCode: null, seedSignalCode: 'SIGABRT', pid: 2, exitCode: 0, signalCode: null },
    { scenario: 'b', pid: 3, exitCode: 1, signalCode: null },
    { scenario: 'c', pid: 4 },
  ]), [
    { scenario: 'a', instance: 'seed', pid: 1, exitCode: null, signalCode: 'SIGABRT' },
    { scenario: 'b', instance: 'scenario', pid: 3, exitCode: 1, signalCode: null },
  ]);
});
// A as the seed catalog holds it; B, any record the scenario never seeded.
const A = seeded[0];
const B = { ...record, id: 'B' };
test('agent answers score on the last answer line, case aside; old values win over new', () => {
  const claude = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__paraself__search_decision_context', input: { query: 'q' } }, { type: 'tool_use', id: 't2', name: 'ToolSearch', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: JSON.stringify(structured([record, B])) }] }, { type: 'tool_result', tool_use_id: 't2', content: [] }] } },
    { type: 'result', result: '答案：Redis\n说明\n答案： valkey 集群' },
  ].map(line => JSON.stringify(line)).join('\n');
  const run = parseAgentRun('claude', claude);
  assert.deepEqual(run.calls[0].ids, ['SEED', 'B']);
  assert.equal(run.answer, 'valkey 集群');
  assert.equal(scoreAnswer(run.answer, { mustInclude: ['Valkey'], mustExclude: ['Redis'] }), 'current');
  assert.equal(scoreAnswer('Valkey（原 redis）', { mustInclude: ['Valkey'], mustExclude: ['Redis'] }), 'stale');
  assert.equal(scoreAnswer(null, { mustInclude: [] }), 'other');
  assert.equal(scoreAnswer('Memcached', { mustInclude: ['Valkey'], mustExclude: ['Redis'] }), 'other');
  // ToolSearch loads paraself; Claude Code is shown structuredContent alone, so no text is held to it.
  assert.deepEqual(canary(run.calls, [A, { ...A, id: 'B', record: B }]), { foreign: [], violations: [], ok: true });
  assert.deepEqual(canary(run.calls, [A]).foreign, ['B']);
  assert.equal(canary(run.calls, [A]).ok, false);
});
const codexCall = (result, status = 'completed') => ({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'paraself', tool: 'search_decision_context', arguments: {}, status, result } });
const codexRun = items => parseAgentRun('codex', [...items, { type: 'item.completed', item: { type: 'agent_message', text: '答案：X' } }].map(line => JSON.stringify(line)).join('\n'));
test('codex: what it was shown is checked, text and structured content alike, and errors without trust', () => {
  const shown = (records, text = textFor(records)) => ({ content: [{ type: 'text', text }], structured_content: structured(records) });
  const clean = codexRun([codexCall(shown([record]))]);
  assert.equal(clean.answer, 'X');
  assert.equal(canary(clean.calls, [A]).ok, true);
  const refused = items => canary(codexRun(items).calls, [A]);
  assert.equal(refused([codexCall({ content: [{ type: 'text', text: 'plain' }] })]).ok, false, 'no context');
  assert.equal(refused([codexCall(shown([record], textFor([record, B])))]).ok, false, 'structured clean, text foreign');
  assert.equal(refused([codexCall(shown([], textFor([B])))]).ok, false, 'structured empty, text foreign');
  assert.equal(refused([codexCall({ is_error: true, content: [{ type: 'text', text: `合成业务正文 ${'x'.repeat(700)}` }] }, 'failed')]).ok, false, 'long error');
  assert.equal(refused([codexCall({ is_error: true, content: [{ type: 'text', text: '无法解析指定的本机 Git 仓库。' }] }, 'failed')]).ok, true, 'the bridge\'s own notice');
  assert.equal(refused([codexCall({ is_error: true, content: [{ type: 'text', text: 'SYNTHETIC_FOREIGN_TEXT' }] }, 'failed')]).ok, false, 'a short error in other words');
  assert.equal(refused([{ type: 'item.started', item: { type: 'file_change', changes: [] } }]).ok, false, 'a file change as it starts');
  assert.equal(refused([{ type: 'item.completed', item: { type: 'command_execution', command: 'ls ~' } }]).ok, false, 'a command');
});
test('claude: an error result is trusted only as a short notice', () => {
  const run = body => parseAgentRun('claude', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'mcp__paraself__search_decision_context', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: body }] } },
  ].map(line => JSON.stringify(line)).join('\n'));
  assert.equal(canary(run(`合成业务正文 ${'x'.repeat(700)}`).calls, [A]).ok, false);
  assert.equal(canary(run(JSON.stringify({ message: '无法解析指定的本机 Git 仓库。', availability: 'scope_unresolved', context: null })).calls, [A]).ok, true);
  assert.equal(canary(run(JSON.stringify({ message: 'SYNTHETIC_FOREIGN_TEXT', context: null })).calls, [A]).ok, false);
  assert.equal(canary(run(JSON.stringify({ context: { results: [] } })).calls, [A]).ok, false);
  const other = (isError, text = 'No such tool available: Bash') => [{ name: 'Bash', args: {}, ids: null, visible: { result: { isError, content: [{ type: 'text', text }] } } }];
  assert.equal(canary(other(false, 'Library\nDesktop'), [A]).ok, false, 'another tool that ran');
  assert.equal(canary(other(true), [A]).ok, true, 'another tool refused');
  assert.equal(canary(other(true, 'x'.repeat(900)), [A]).ok, false, 'a refusal too long to be one');
});
test('required model network policy blocks unmanaged lab clients before spawn', async () => {
  await assert.rejects(runAgent({ command: process.execPath, args: ['-e', 'throw Error("must not run")'] }, { env: { MODEL_PROXY_URL: 'http://127.0.0.1:9' } }), /ModelNetworkPolicy required/);
});
test('the client under test gets only the names it needs: credentials under any name stay behind', () => {
  const env = testedEnvironment({ PATH: '/bin', HOME: '/h', Mixed_Key: 'k', ANTHROPIC_CUSTOM_HEADERS: 'h', MYSTERY_AUTH: 'a', PARASELF_PROVIDER_CHILD: '0', PARASELF_VAULT_PATH: '/r/vault' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/bin', PARASELF_VAULT_PATH: '/r/vault', PARASELF_PROVIDER_CHILD: '1', DECISION_PROVIDER_CHILD: '1' });
});
test('the catalog must be the seeds: seed files and the decisions seed calls made, nothing more', () => {
  const made = (status, recordId, recordKind = 'decision') => ({ result: { structuredContent: { record: { status, recordId, recordKind } } } });
  const created = [createdRecordId('record_decision_journal_entry', made('created', 'uuid-1')), createdRecordId('record_decision_journal_entry', made('duplicate', 'uuid-1')),
    createdRecordId('record_decision_journal_entry', made('updated', 'uuid-2'))].filter(Boolean);
  assert.deepEqual(created, ['uuid-1', 'uuid-1', 'uuid-2']);
  assert.equal(createdRecordId('record_decision_journal_entry', made('created', 'idea-1', 'idea')), null);
  assert.equal(createdRecordId('record_decision_relation', made('created', 'x')), null);
  // Only seed calls, no seed files: the run goes on.
  assert.doesNotThrow(() => checkSeedCatalog(['uuid-2', 'uuid-1'], [], created));
  assert.doesNotThrow(() => checkSeedCatalog(['A', 'uuid-1'], [{ content: '---\nid: A\n---\n' }], ['uuid-1']));
  // One record neither seeded nor made by a seed call, or one missing: the run ends (main exits 2).
  assert.throws(() => checkSeedCatalog(['uuid-1', 'uuid-2', 'STRAY'], [], created), /not the seeds/);
  assert.throws(() => checkSeedCatalog(['uuid-1'], [], created), /not the seeds/);
});

test('consult style: the prompt asks for consult and one option, and the client is opened for consult alone', () => {
  assert.equal(PROMPT_TOOLS.consult, CONSULT);
  assert.match(AGENT_PROMPTS.consult, /consult_decision_principles/u);
  assert.match(AGENT_PROMPTS.consult, /答案：<一个选项>/u);
  assert.doesNotMatch(AGENT_PROMPTS.consult, /search_decision_context/u);
  const guard = guardCommand('/root', '/bridge', 'claude-code', CONSULT);
  assert.deepEqual(guard.args.slice(-2), ['--tool', CONSULT]);
  const claude = agentCommand({ client: 'claude', model: 'm', question: 'Q?', cwd: '/c', guard, mcpConfig: '/m.json', prompt: AGENT_PROMPTS.consult, tool: CONSULT }).args;
  assert.equal(claude[claude.indexOf('--allowedTools') + 1], `mcp__paraself__${CONSULT}`);
  assert.equal(claude[claude.indexOf('--tools') + 1], 'ToolSearch');
  assert.ok(claude.includes(AGENT_PROMPTS.consult + 'Q?'));
  assert.ok(agentCommand({ client: 'claude', model: 'm', question: 'Q?', cwd: '/c', guard, mcpConfig: '/m.json' }).args.includes('mcp__paraself__search_decision_context'));
  // The ids a consultation shows, principles and signals alike, for the canary's check against the catalog.
  assert.deepEqual(resultIds({ consultation: { matches: [{ principleId: 'p' }], signals: [{ recordId: 's' }] } }), ['p', 's']);
});

test('signals are asserted on their own, and a flag may ask for a stretch of text in them', () => {
  const body = { consultation: { matches: [{ principleId: 'p', reason: '原则内容' }], signals: [{ recordId: 's', standing: '偏好：当前立场', qualifier: '例外：x' }, { recordId: 'old', qualifier: null }] } };
  const passed = score({ result: { structuredContent: body } }, { mustInclude: ['p'], mustSignal: ['s'], mustNotSignal: ['gone'],
    mustFlag: [{ id: 's', path: 'standing', includes: '当前立场' }, { id: 's', path: 'qualifier', includes: '放下', present: false }, { id: 'p', path: 'reason', includes: '原则' }] });
  assert.equal(passed.pass, true); assert.equal(passed.recall, 1); assert.deepEqual(passed.ids, ['p']);
  assert.equal(score({ result: { structuredContent: body } }, { mustNotSignal: ['old'] }).pass, false);
  assert.equal(score({ result: { structuredContent: body } }, { mustSignal: ['gone'] }).pass, false);
  assert.equal(score({ result: { structuredContent: body } }, { mustFlag: [{ id: 'old', path: 'qualifier', includes: '放下' }] }).pass, false);
  assert.equal(score({ result: { structuredContent: body } }, { mustFlag: [{ id: 'absent', path: 'qualifier', includes: 'x' }] }).pass, false);
  assert.equal(score({ result: { structuredContent: body } }, { equals: { 'consultation.signalsIncomplete': null } }).pass, true);
  assert.equal(score({ result: { structuredContent: body } }, { equals: { 'consultation.matches.0.reason': null } }).pass, false);
});

test('r18 preference and idea seeds are the storage serializer\'s own notes, read back whole, archived ones with their reason', async () => {
  const suite = JSON.parse(await readFile(new URL('./scenarios/r18-consult.json', import.meta.url), 'utf8'));
  const journal = suite.scenarios.flatMap(scenario => scenario.seed?.files ?? []).filter(file => isJournalSeed(file.path));
  assert.equal(journal.length, 4);
  for (const file of journal) {
    const entry = parseJournalEntry(file.content);
    // Read back as written: a revision's snapshot lists its keys in the reader's order, so the text is compared as what it says.
    assert.deepEqual(parseJournalEntry(serializeJournalEntry(entry)), entry, file.path);
    const held = journalSnapshot(file.content);
    assert.deepEqual(held, { kind: entry.kind, id: entry.id, title: entry.title, content: entry.content, knowledgeStatus: entry.knowledgeStatus,
      appliesWhen: entry.kind === 'preference' ? entry.appliesWhen : null, exceptions: entry.kind === 'preference' ? entry.exceptions : null,
      whyInteresting: entry.kind === 'idea' ? entry.whyInteresting : null, openQuestions: entry.kind === 'idea' ? entry.openQuestions : [],
      languages: entry.languages }, file.path);
    if (entry.knowledgeStatus === 'archived') {
      // As L1 settled it: created active, then archived by one revision whose change note is 归档记录[：原因].
      assert.equal(entry.revisionEvents.length, 1);
      assert.equal(entry.revisionEvents[0].previous.knowledgeStatus, 'active');
      assert.match(entry.revisionEvents[0].changeNote, /^归档记录(：.+)?$/u);
    }
  }
  assert.deepEqual(journal.map(file => parseJournalEntry(file.content).revisionEvents[0]?.changeNote).filter(Boolean).sort(), ['归档记录', '归档记录：迁移工具已经自动校验回退，不再手动核对清单']);
  // Never in search's catalog: the seed catalog is checked without them.
  assert.equal(isJournalSeed('Decision Journal/principles/P.md'), false);
  assert.equal(isJournalSeed('Decision Journal/summarize/x.md'), false);
});

// R18 C: a real Codex stream (cand-codex, r18-d08 ask, rep 2, item_1): a consult without its question, refused by the bridge,
// passed on by the guard as its fixed notice; Codex logs the failed call with structured_content: null.
const FAILED_CONSULT = [
  { type: 'item.started', item: { id: 'item_1', type: 'mcp_tool_call', server: 'paraself', tool: 'consult_decision_principles', arguments: { project: 'lab' }, result: null, error: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'mcp_tool_call', server: 'paraself', tool: 'consult_decision_principles', arguments: { project: 'lab' },
    result: { content: [{ type: 'text', text: '核对没有完成（实验守卫隐去了原因），可以换个参数再试。' }], structured_content: null }, error: null, status: 'failed' } },
];
test('codex: the guard\'s notice on a failed call, structured_content exactly null, passes; any other shape beside it does not', () => {
  const stream = events => events.map(event => JSON.stringify(event)).join('\n');
  const seen = structured => canary(parseAgentRun('codex', stream(structured === undefined ? FAILED_CONSULT
    : [FAILED_CONSULT[0], { ...FAILED_CONSULT[1], item: { ...FAILED_CONSULT[1].item, result: { ...FAILED_CONSULT[1].item.result, structured_content: structured } } }])).calls, seeded);
  assert.deepEqual(seen(undefined), { foreign: [], violations: [], ok: true });
  for (const other of ['', 'null', 0, false, true, [], [null], {}, { message: '核对没有完成（实验守卫隐去了原因），可以换个参数再试。' }, { extra: 1 }]) {
    assert.equal(seen(other).ok, false, `structured_content ${JSON.stringify(other)}`);
  }
  // Claude: the same notice, shown as its text with no structuredContent, passes; the text "null" in its place does not.
  const claude = text => canary(parseAgentRun('claude', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__paraself__consult_decision_principles', input: { project: 'lab' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text }] }] } },
  ].map(event => JSON.stringify(event)).join('\n')).calls, seeded);
  assert.equal(claude('核对没有完成（实验守卫隐去了原因），可以换个参数再试。').ok, true);
  assert.equal(claude('null').ok, false);
});

test('--agents defaults to none: without it no agent step calls a model, and --reps keeps its default', () => {
  const { values } = parseArgs({ options: CLI_OPTIONS, args: [] });
  assert.deepEqual(parseAgents(values.agents), []);
  assert.equal(values.reps, '2');
  assert.deepEqual(parseAgents(parseArgs({ options: CLI_OPTIONS, args: ['--agents', ''] }).values.agents), []);
  assert.deepEqual(parseAgents(parseArgs({ options: CLI_OPTIONS, args: ['--agents', 'claude:sonnet,codex:gpt-6.1-sol'] }).values.agents).map(agent => agent.label), ['claude:sonnet', 'codex:gpt-6.1-sol']);
  assert.throws(() => parseAgents('gemini:x'), /Bad agent/);
});
