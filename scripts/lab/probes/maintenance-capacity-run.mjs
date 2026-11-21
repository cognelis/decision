// Synthetic state only. Actual packaged App IPC, restart, old-App refusal, and upgrade round trip.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { ISOLATION_KEYS, startIsolatedApp } from '../isolated-app.mjs';

const { values } = parseArgs({ options: { app: { type: 'string' }, 'legacy-app': { type: 'string' }, 'checkpoint-legacy-app': { type: 'string' }, out: { type: 'string' }, label: { type: 'string' } } });
assert(values.app && values['legacy-app'] && values.out && values.label, '--app --legacy-app --out --label are required');
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const root = await realpath(await mkdtemp(join(tmpdir(), 'paraself-maintenance-capacity-')));
const out = resolve(values.out); await mkdir(out, { recursive: true });
const path = join(root, 'user-data/organization/state.json');
const maxBytes = 8 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = state => `${JSON.stringify({ version: 2, compression: 'gzip', data: gzipSync(`${JSON.stringify(state)}\n`).toString('base64') })}\n`;
const readState = async () => {
  const data = JSON.parse(await readFile(path, 'utf8'));
  return data.version === 2 ? JSON.parse(gunzipSync(Buffer.from(data.data, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) : data;
};
const protectedPart = state => ({ ledger: state.ledger, suggestions: state.suggestions, annotations: state.annotations });
const checks = []; const launches = []; let error = null; let app; let socket; let nextId = 0;
const pending = new Map();
const check = (name, ok) => { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? 'ok' : 'FAIL'} ${name}`); };
const until = async (fn, name) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await new Promise(done => setTimeout(done, 100)); }
  throw new Error(`timeout: ${name}`);
};
const freePort = () => new Promise((done, fail) => {
  const server = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)); });
});
const evaluate = expression => new Promise((done, fail) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); fail(new Error('isolated IPC timed out')); }, 30000);
  pending.set(id, response => {
    clearTimeout(timer);
    if (response.error || response.result?.exceptionDetails) fail(new Error(response.result?.exceptionDetails?.exception?.description ?? 'isolated IPC failed'));
    else done(response.result.result.value);
  });
  socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});
const api = (method, value) => evaluate(`window.decision.${method}(${JSON.stringify(value)})`);
const snapshot = () => api('getOrganization', { project: 'capacity-lab', scope: 'project' });
const start = async bundle => {
  assert(!app, 'previous app must be stopped');
  const appPath = await realpath(resolve(bundle)); const debugPort = await freePort();
  app = await startIsolatedApp({ root, executable: join(appPath, 'Contents/MacOS/Paraself'), debugPort });
  assert.equal(app.runtime.pid, app.child.pid);
  for (const name of ISOLATION_KEYS) assert(resolve(app.env[name]).startsWith(`${root}${sep}`), `${name} escaped root`);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl && decodeURIComponent(entry.url).startsWith(`file://${appPath}/`)), 'own renderer');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.onmessage = message => { const response = JSON.parse(message.data); const callback = pending.get(response.id); if (callback) { pending.delete(response.id); callback(response); } };
  await until(async () => evaluate('typeof window.decision?.getOrganization === "function"'), 'own preload');
};
const stop = async () => {
  socket?.close(); socket = undefined;
  if (!app) return;
  const stopped = app;
  await stopped.stop();
  launches.push({ pid: stopped.child.pid, exitCode: stopped.child.exitCode, signal: stopped.child.signalCode, stderr: stopped.stderr() });
  app = undefined;
  assert.equal(stopped.child.exitCode, 0, 'isolated app must exit normally');
};
const replaceSeed = async state => { assert(!app, 'seed changes only while the app is stopped'); await writeFile(path, encoded(state), { mode: 0o600 }); };

try {
  const compiled = join(root, 'fixture.cjs');
  await build({ stdin: { contents: "export { capacityState, CAPACITY_AT } from './apps/desktop/test/organization-capacity-fixture.ts'; export { ModelTraceStore } from './packages/storage/src/index.ts';", resolveDir: repository }, bundle: true, platform: 'node', format: 'cjs', outfile: compiled, logLevel: 'silent' });
  const { capacityState, CAPACITY_AT, ModelTraceStore } = createRequire(import.meta.url)(compiled);
  const initial = capacityState(1300);
  const before = initial.suggestions['history-0'].apply.steps[0].before;
  before.capacityPadding = '';
  before.capacityPadding = 'x'.repeat(maxBytes - 100 - Buffer.byteLength(`${JSON.stringify(initial)}\n`));
  const initialText = `${JSON.stringify(initial)}\n`;
  assert.equal(Buffer.byteLength(initialText), maxBytes - 100);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, initialText, { mode: 0o600, flag: 'wx' });
  await start(values.app);
  check('near-limit v1 state remains readable', (await snapshot()).damaged === null);
  const settings = { background: false, backgroundProfileId: 'p'.repeat(200) };
  let growthError = null;
  try { await api('setOrganizationSettings', settings); } catch (caught) { growthError = caught.message; }
  check('real settings update crosses old capacity limit successfully', growthError === null);
  if (growthError !== null) {
    check('failed growth preserves original bytes', hash(await readFile(path)) === hash(initialText));
    await writeFile(join(out, 'growth-error.txt'), growthError);
  } else {
    const grown = await readState();
    check('new envelope stays within physical bound', (await readFile(path)).byteLength <= maxBytes && JSON.parse(await readFile(path, 'utf8')).version === 2);
    check('all choices receipts plans and queue survive growth', isDeepStrictEqual(grown, { ...initial, settings, revision: 1 }));
    await stop();
    const committedHash = hash(await readFile(path));
    await start(values['legacy-app']);
    check('old App remains healthy and reports unsupported state', typeof (await snapshot()).damaged === 'string');
    let refused = false;
    try { await api('setOrganizationSettings', { background: false, backgroundProfileId: null }); } catch { refused = true; }
    check('old App refuses to overwrite the new state', refused);
    await stop();
    check('downgrade preserves exact committed bytes', hash(await readFile(path)) === committedHash);
    await start(values.app);
    check('upgrade restores all durable fields', (await snapshot()).damaged === null && isDeepStrictEqual(await readState(), grown));
    await stop();

    const interrupted = { ...grown, activeRun: { runId: 'capacity-interrupted', trigger: 'manual', scope: 'all', project: null, startedAt: CAPACITY_AT, endedAt: null, state: 'running', stage: 'saved checkpoint', progress: { checked: 2, total: 5, groupsDone: 1, groupsTotal: 2 }, created: 0, updated: 1, partialReason: null, failure: null, usage: { calls: 1, failedCalls: 0, retries: 0, reportedInputTokens: 100, reportedOutputTokens: 20, estimatedInputTokens: 0, estimatedOutputTokens: 0 }, model: 'synthetic' } };
    await replaceSeed(interrupted);
    await writeFile(`${path}.interrupted.tmp`, '{"version":2,"data":"incomplete', { mode: 0o600 });
    await start(values.app);
    await until(async () => (await readState()).activeRun === null, 'interrupted run recovery');
    const recovered = await readState();
    check('restart closes the interrupted run and retains usage', recovered.runs.at(-1)?.state === 'interrupted' && isDeepStrictEqual(recovered.runs.at(-1)?.usage, interrupted.activeRun.usage));
    check('restart preserves choices rejections forgetting and plans', isDeepStrictEqual(protectedPart(recovered), protectedPart(grown)));
    await stop();
    await start(values.app);
    check('another restart does not repeat recovery', (await readState()).runs.filter(run => run.runId === 'capacity-interrupted').length === 1);
    await stop();

    const reduced = { ...await readState(), suggestions: { 'history-0': grown.suggestions['history-0'] } };
    await replaceSeed(reduced);
    await start(values.app);
    await api('setOrganizationSettings', settings);
    await stop();
    check('state that fits again is written in legacy v1 format', JSON.parse(await readFile(path, 'utf8')).version === 1);
    await start(values['legacy-app']);
    check('old App reads the reduced state with choices and receipts intact', (await snapshot()).damaged === null && isDeepStrictEqual(protectedPart(await readState()), protectedPart(reduced)));
    await stop();
    const damaged = '{"version":2,"compression":"gzip","data":"AAAA"}';
    await writeFile(path, damaged, { mode: 0o600 });
    await start(values.app);
    check('damaged compressed state is visible without stopping the App', typeof (await snapshot()).damaged === 'string');
    await stop();
    check('damaged state remains untouched', hash(await readFile(path)) === hash(damaged));
    check('startup handles the failed recovery without an unhandled rejection', !launches.at(-1).stderr.includes('UnhandledPromiseRejection'));
    const requestId = 'synthetic-late-trace';
    const traceRoot = join(root, 'user-data/model-traces');
    const traceStore = new ModelTraceStore(traceRoot, { idFactory: () => 'synthetic-late-trace-id' });
    const trace = await traceStore.record({ requestId, attemptId: 'late', attemptIndex: 0, purpose: 'memory-organization',
      profile: { profileId: 'synthetic', backend: 'qwen', provider: 'qwen', model: 'synthetic', promptVersion: 'lab', schemaVersion: 'lab' },
      input: { systemPrompt: 'Synthetic only', userPrompt: 'Content awaiting explicit forgetting', outputSchema: { type: 'object' }, clientSystemPromptVisibility: 'visible' },
      output: { visibleText: 'Synthetic late result', parsed: { synthetic: true } },
      usage: { source: 'runtime_measured', inputTokens: 1, outputTokens: 1, totalTokens: 2 }, timing: { queuedMs: 0, providerMs: 1, totalMs: 1 }, status: 'succeeded' });
    const tracePath = join(traceRoot, `${hash(trace.traceId)}.json`);
    const checkpointLegacy = values['checkpoint-legacy-app'] ?? values['legacy-app'];
    assert(!app);
    const checkpoint = JSON.stringify({ ...reduced, ledger: { ...reduced.ledger, pendingTraceDeletes: [requestId] } });
    assert(Buffer.byteLength(checkpoint) < maxBytes, 'checkpoint compatibility must be tested with plain v1, not the gzip guard');
    await writeFile(path, checkpoint, { mode: 0o600 });
    const pendingHash = hash(await readFile(path));
    await start(checkpointLegacy);
    const unreadable = typeof (await snapshot()).damaged === 'string';
    let checkpointRefused = false;
    try { await api('setOrganizationSettings', settings); } catch { checkpointRefused = true; }
    check('old App refuses unfinished trace-cleanup checkpoints', unreadable && checkpointRefused);
    await stop();
    check('old App preserves the unfinished cleanup checkpoint', hash(await readFile(path)) === pendingHash);
    await start(values.app);
    await until(async () => (await readState()).ledger.pendingTraceDeletes === undefined, 'late trace cleanup recovery');
    const cleaned = await readState();
    check('restart removes the late trace and retains user receipts', await readFile(tracePath).then(() => false, error => error.code === 'ENOENT') && isDeepStrictEqual(protectedPart(cleaned), protectedPart(reduced)));
    await stop(); await start(checkpointLegacy);
    check('legacy reading resumes after trace cleanup is complete', (await snapshot()).damaged === null);
  }
} catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); console.error(error); }
finally {
  const cleanup = [];
  try { await stop(); } catch (caught) { cleanup.push(String(caught)); }
  const summary = { label: values.label, root, checks, launches, passed: checks.filter(check => check.ok).length, failed: checks.filter(check => !check.ok).length, error, cleanup };
  await writeFile(join(out, 'SUMMARY.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = error || cleanup.length ? 2 : summary.failed ? 1 : 0;
}
