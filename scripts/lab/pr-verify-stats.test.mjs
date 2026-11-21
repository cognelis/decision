import { test } from 'vitest';
import assert from 'node:assert/strict';
import { traceSummary } from '../replay-pr-review.mjs';
import { runStats } from './pr-verify-stats.mjs';

// Synthetic: a verify call given one function and one package's search, confirming one of two candidates.
const a = { id: 1, priority: 'P1', path: 'src/a.ts', side: 'new', line: 5, title: 'A', body: '', decisionIndexes: [1, 2] };
const b = { id: 2, priority: 'P2', path: 'src/a.ts', side: 'new', line: 9, title: 'B', body: '' };
const userPrompt = JSON.stringify({ candidates: [a, b], decisions: [{ index: 1, id: 'D-1' }],
  functions: [{ path: 'src/a.ts', old: null, new: { startLine: 4, text: 'x\ny\nz' } }],
  callerSearch: [{ path: 'src', complete: true, symbols: [{ symbol: 'run', truncated: false, hits: [{ path: 'src/b.ts', side: 'new', startLine: 10, text: 'p\nq' }] }] }] });
const premises = [
  { claim: '', kind: 'diff', path: 'src/a.ts', side: 'new', line: 5, query: null },
  { claim: '', kind: 'source', path: 'src/a.ts', side: 'new', line: 6, query: null },
  { claim: '', kind: 'source', path: 'src/b.ts', side: 'new', line: 11, query: null },
  { claim: '', kind: 'search', path: 'src', side: 'new', line: null, query: 'run' },
  { claim: '', kind: 'source', path: 'src/a.ts', side: 'new', line: 7, query: null },
];
const verifyTrace = { profile: { promptVersion: 'pr-review-verify-v7' }, status: 'succeeded', usage: { source: 'provider_reported', inputTokens: 300, cachedInputTokens: 100 },
  input: { userPrompt }, output: { parsed: { verdicts: [{ id: 1, verdict: 'confirmed', reason: '', missing: null, premises }, { id: 2, verdict: 'needs_context', reason: '', missing: '', premises: null }] } } };
const needsContext = [
  { finding: b, reason: '', missing: '确认所依据的前提没能在本次评审的材料里核对到：…' },
  { finding: b, reason: '', missing: '核验结论：这条候选没有经过核验，需要重新评审或自行核对。' },
  { finding: b, reason: '', missing: '缺调用方' },
];

test('a replay keeps a verify call its verdicts and where the gathered material sat, without its text', () => {
  const kept = traceSummary(verifyTrace);
  assert.equal(kept.promptVersion, 'pr-review-verify-v7');
  assert.deepEqual(kept.verify.functions, [['src/a.ts', 'new', 4, 6]]);
  assert.deepEqual(kept.verify.callerSearch[0].symbols[0].hits, [['src/b.ts', 'new', 10, 11]]);
  assert.equal(kept.verify.verdicts[0].premises.length, 5);
  assert.equal(traceSummary({ profile: { promptVersion: 'pr-review-v11' }, input: { userPrompt } }).verify, undefined);
});

test('counts premises on the gathered material, splits waiting-for-context, and sums verify input', () => {
  const run = { caseId: 'c', model: 'm', candidates: [a, b], progress: [],
    report: { status: 'completed', findings: [a], filtered: [], needsContext },
    traces: [{ promptVersion: 'pr-review-v11', usage: { source: 'provider_reported', inputTokens: 999 } }, traceSummary(verifyTrace)] };
  const s = runStats(run);
  assert.deepEqual([s.downgraded, s.unverified, s.selfJudged], [1, 1, 1]);
  assert.deepEqual([s.verifyCalls, s.verifyInputTokens, s.verifyCachedTokens, s.tokenSource], [1, 300, 100, 'promptVersion']);
  assert.deepEqual(s.verifyDecisions, { citing: 1, missing: 1 });
  assert.deepEqual(s.premises, { confirmed: 1, unmatched: 0, premises: 5, citeFunctions: 1, citeCallerSearch: 2, citeAny: 3, findingsCiting: 1 });
});

test('an older replay without versions: verify calls are the trailing ones, or unknown when the counts differ', () => {
  const progress = [{ kind: 'model', status: 'done', message: '第 1 次调用模型完成' }, { kind: 'model', status: 'done', message: '核验候选问题 1/1' }];
  const run = { caseId: 'c', model: 'm', candidates: [], progress, report: { status: 'completed', findings: [] },
    traces: [{ usage: { source: 'provider_reported', inputTokens: 7 } }, { usage: { source: 'provider_reported', inputTokens: 40 } }] };
  assert.deepEqual([runStats(run).verifyInputTokens, runStats(run).tokenSource, runStats(run).premises], [40, 'aligned', null]);
  assert.equal(runStats({ ...run, traces: run.traces.slice(1) }).verifyInputTokens, null);
});
