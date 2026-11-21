import { test } from 'vitest';
import assert from 'node:assert/strict';
import { scoreDecisions } from './pr-decision-score.mjs';

test('a decision is reported when a final finding cites it, and silent when none does', () => {
  const finding = (decisionIndexes) => ({ path: 'a.ts', side: 'new', line: 1, title: 't', body: 'b', decisionIndexes });
  const run = { candidates: [finding([1]), finding([2])], report: { findings: [finding([2]), finding([3])], filtered: [{ finding: finding([1]), reason: 'r' }],
    evidence: [{ index: 1, record: { id: 'WANT' } }, { index: 2, record: { id: 'OLD' } }, { index: 3, record: { id: 'OTHER' } }] } };
  const labels = { decisions: [{ id: 'WANT', kind: 'violated', expect: 'report' }, { id: 'OLD', kind: 'superseded', expect: 'silent' }, { id: 'UNSEEN', kind: 'path_mismatch', expect: 'silent' }] };
  const s = scoreDecisions(run, labels);
  assert.deepEqual(s.rows.map((r) => [r.id, r.seen, r.candidates, r.final, r.rejected, r.pass]), [['WANT', true, 1, 0, 1, false], ['OLD', true, 1, 1, 0, false], ['UNSEEN', false, 0, 0, 0, true]]);
  assert.deepEqual(s.unlabelled, ['OTHER']);
  // Cited beside the decision that replaced it, an old one is not what the finding rests on.
  const beside = { ...run, report: { ...run.report, findings: [finding([1, 2])] } };
  const allowed = { decisions: [{ id: 'WANT', kind: 'violated', expect: 'report' }, { id: 'OLD', kind: 'superseded', expect: 'silent', allowWith: ['WANT'] }] };
  assert.deepEqual(scoreDecisions(beside, allowed).rows.map((r) => [r.id, r.final, r.pass]), [['WANT', 1, true], ['OLD', 0, true]]);
});
