// Frozen synthetic pairs -> isolated packaged App -> real local classifier -> persisted capture/candidate.
// No conversation client is started. All business data and requests stay in the isolated root; only model files are linked.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { startIsolatedApp, ISOLATION_KEYS } from '../isolated-app.mjs';

const { values } = parseArgs({ options: { app: { type: 'string' }, cases: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' }, rules: { type: 'boolean', default: false } } });
assert(values.app && values.cases && values.out && values.label, '--app --cases --out --label are required');
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const samples = JSON.parse(await readFile(resolve(values.cases), 'utf8'));
const root = await realpath(await mkdtemp(join(tmpdir(), 'paraself-recognition-')));
const out = resolve(values.out); await mkdir(out, { recursive: true });
const readJson = async (directory) => {
  const names = await readdir(directory).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
};
const waitFor = async (fn, label) => {
  const end = Date.now() + 120000;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise((done) => setTimeout(done, 100)); }
  throw new Error(`timeout: ${label}`);
};
const rows = []; let app; let error = null;
try {
  if (values.rules) {
    await mkdir(join(root, 'user-data'));
    await writeFile(join(root, 'user-data/settings.json'), JSON.stringify({ version: 3, vaultPath: null, theme: 'auto', modelTraceContentEnabled: true, captureClassifier: 'rules' }));
    await writeFile(join(root, 'user-data/settings-migrations.json'), JSON.stringify({ captureClassifier: 'decided' }));
  }
  app = await startIsolatedApp({ root, executable: join(resolve(values.app), 'Contents/MacOS/Paraself'), useLocalModels: !values.rules });
  for (const name of ISOLATION_KEYS) assert(resolve(app.env[name]).startsWith(`${root}${sep}`), `${name} escaped the root`);
  assert.equal(app.runtime.pid, app.child.pid);
  const headers = { authorization: `Bearer ${app.runtime.token}`, 'content-type': 'application/json' };
  let receipts = await readJson(join(app.env.PARASELF_CAPTURE_AUDIT, 'items'));
  for (const [index, sample] of samples.entries()) {
    const before = new Set(receipts.map((receipt) => receipt.receiptId));
    const beforeTraces = new Set((await readJson(app.env.PARASELF_MODEL_TRACES)).map((trace) => trace.traceId));
    const sessionId = `${values.label}-${index}`; const now = Date.now();
    const pair = { version: 1, pairId: sessionId, sourceClient: 'claude-code', sessionId, assistantTurnId: `a-${index}`, userTurnId: `u-${index}`, cwd: root,
      assistantText: sample.assistantText, userText: sample.userText, capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString() };
    const accepted = await fetch(`http://127.0.0.1:${app.runtime.port}/v1/semantic-pairs`, { method: 'POST', headers, body: JSON.stringify(pair) });
    assert.equal(accepted.status, 202);
    const routed = await waitFor(async () => {
      receipts = await readJson(join(app.env.PARASELF_CAPTURE_AUDIT, 'items'));
      return receipts.find((receipt) => !before.has(receipt.receiptId) && receipt.stage === 'routed');
    }, sample.id);
    const captures = await readJson(join(app.env.PARASELF_CAPTURE_SPOOL, 'events'));
    const candidates = await readJson(join(app.env.PARASELF_CANDIDATE_SPOOL, 'items'));
    const event = captures.find((item) => item.sessionId === sessionId) ?? candidates.find((item) => item.event.sessionId === sessionId)?.event ?? null;
    if (routed.finalBand !== 'low') assert(event, 'routed event must be persisted');
    const answer = event?.questions[0]?.answer ?? null;
    const options = event?.questions[0]?.options ?? [];
    const selectedIds = answer && answer.kind !== 'custom' ? answer.values.flatMap((value) => options.filter((option) => option.label === value).map((option) => option.id ?? option.label)) : [];
    const traces = (await readJson(app.env.PARASELF_MODEL_TRACES)).filter((trace) => trace.purpose === 'semantic-classification' && !beforeTraces.has(trace.traceId));
    const modelSucceeded = values.rules ? routed.modelBand === 'unavailable' : routed.modelBand !== 'unavailable' && traces.some((trace) => trace.status === 'succeeded' && trace.profile.model.includes('4b') && trace.input?.userPrompt.includes(`<user_message>\n${sample.userText}\n</user_message>`));
    const selectedCorrect = JSON.stringify([...selectedIds].sort()) === JSON.stringify([...sample.expectedIds].sort());
    const retained = !sample.mustCapture || event !== null;
    const replyPreserved = event === null || answer?.reply === sample.userText || (answer?.kind === 'custom' && answer.values.length === 1 && answer.values[0] === sample.userText);
    // Rules fallback may retain a genuine natural-language choice verbatim instead of claiming a parsed option.
    // Its exact-mapping score stays separate; a wrong preset, lost reply, or dropped positive still fails.
    const verbatimChoice = values.rules && sample.mustCapture === true && sample.expectedIds.length > 0 && answer?.kind === 'custom' && replyPreserved;
    const row = { id: sample.id, category: sample.category, expectedIds: sample.expectedIds, mustCapture: sample.mustCapture ?? false,
      ruleBand: routed.ruleBand, modelBand: routed.modelBand, finalBand: routed.finalBand, selectedIds, answer, options, event,
      elapsedMs: Date.now() - now, modelSucceeded, selectedCorrect, verbatimChoice, retained, replyPreserved, passed: modelSucceeded && (selectedCorrect || verbatimChoice) && retained && replyPreserved, audit: receipts.filter((receipt) => !before.has(receipt.receiptId)), traces };
    rows.push(row); await writeFile(join(out, `${String(index).padStart(3, '0')}.json`), `${JSON.stringify(row, null, 2)}\n`);
    console.log(`${sample.id}: ${routed.modelBand}/${routed.finalBand} ${JSON.stringify(selectedIds)}`);
    assert(modelSucceeded, 'requested classifier path did not produce a valid result for this case');
  }
  // High captures are now complete: flush their rationale queue and verify that their chosen text reaches Markdown.
  for (const row of rows.filter((row) => row.finalBand === 'high')) {
    const response = await fetch(`http://127.0.0.1:${app.runtime.port}/v1/smoke/complete`, { method: 'POST', headers, body: JSON.stringify({ status: 'captured', rationale: 'Isolated recognition regression.' }) });
    assert.equal(response.status, 204, `rationale completion: ${row.id}`);
  }
  const files = await readdir(join(root, 'vault'), { recursive: true });
  const notes = await Promise.all(files.filter((path) => String(path).endsWith('.md')).map(async (path) => ({ path, text: await readFile(join(root, 'vault', path), 'utf8') })));
  for (const row of rows.filter((row) => row.finalBand === 'high')) {
    const note = notes.find(({ text }) => text.includes(row.event.batchId));
    row.persisted = note !== undefined;
    assert(row.persisted, `capture was not written: ${row.id}`);
    const encoded = /<!-- decision:selection-base64 ([A-Za-z0-9_-]+) -->/u.exec(note.text)?.[1];
    assert(encoded, 'missing persisted answer');
    row.persistedAnswer = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    assert.deepEqual(row.persistedAnswer, { kind: row.answer.kind, values: row.answer.values });
  }
} catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); console.error(error); }
finally {
  const cleanup = [];
  try { await app?.stop(); } catch (caught) { cleanup.push(String(caught)); }
  if (app && app.child.exitCode !== 0) cleanup.push(`app exit ${app.child.exitCode}/${app.child.signalCode}: ${app.stderr()}`);
  const summary = { label: values.label, root, mode: values.rules ? 'rules' : 'default-local', casesSha256: createHash('sha256').update(JSON.stringify(samples)).digest('hex'), passed: rows.filter((row) => row.passed).length, failed: rows.filter((row) => !row.passed).length, rows, error, cleanup };
  await writeFile(join(out, 'SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`);
  if (error || cleanup.length || rows.length !== samples.length) process.exitCode = 2;
  else if (summary.failed > 0) process.exitCode = 1;
}
