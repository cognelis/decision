// Synthetic density/concurrency matrix and a bounded endurance run; no real Vault or model service.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { ISOLATION_KEYS, startIsolatedApp, connectMcp } from '../isolated-app.mjs';

const { values } = parseArgs({ options: { app: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' }, minutes: { type: 'string' } } });
assert(values.app && values.out && values.label, '--app --out --label are required');
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const minutes = Number(values.minutes ?? 0);
assert(Number.isFinite(minutes) && minutes >= 0 && minutes <= 60);
const appPath = await realpath(resolve(values.app)); const out = resolve(values.out);
await mkdir(out, { recursive: true });
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'paraself-density-')));
const compiled = join(scratch, 'fixture.cjs');
await build({ entryPoints: [fileURLToPath(new URL('../../../apps/desktop/test/organization-density-fixture.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile: compiled, logLevel: 'silent' });
const { densityState } = createRequire(import.meta.url)(compiled);
const execute = promisify(execFile); const sleep = ms => new Promise(done => setTimeout(done, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = []; let error = null; let app; let observedChild; let socket; let mcp; let id = 0; const pending = new Map();
const until = async (fn, name) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(100); }
  throw new Error(`timeout: ${name}`);
};
const port = () => new Promise((done, fail) => {
  const server = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => done(value)); });
});
const api = (method, input) => new Promise((done, fail) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); fail(new Error(`${method} timed out`)); }, 15000);
  pending.set(requestId, response => {
    clearTimeout(timer);
    if (response.error || response.result?.exceptionDetails) fail(new Error(`${method}: ${response.result?.exceptionDetails?.exception?.description ?? 'IPC failed'}`));
    else done(response.result.result.value);
  });
  socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression: `window.decision.${method}(${input === undefined ? '' : JSON.stringify(input)})`, returnByValue: true, awaitPromise: true } }));
});
const start = async root => {
  const debugPort = await port();
  app = await startIsolatedApp({ root, executable: join(appPath, 'Contents/MacOS/Paraself'), debugPort, onSpawn: child => { observedChild = child; }, base: { ...process.env, PARASELF_ORGANIZATION_LAB_IDLE: '1' } });
  assert.equal(app.child.pid, app.runtime.pid);
  for (const name of ISOLATION_KEYS) assert(resolve(app.env[name]).startsWith(`${root}${sep}`), `${name} escaped root`);
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(page => page.type === 'page' && page.webSocketDebuggerUrl && decodeURIComponent(page.url).startsWith(`file://${appPath}/`)), 'own renderer');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
  socket.onmessage = event => { const response = JSON.parse(event.data); const callback = pending.get(response.id); if (callback) { pending.delete(response.id); callback(response); } };
};
const stop = async row => {
  socket?.close(); socket = undefined;
  if (!app) return;
  const current = app; const began = performance.now();
  const timer = setTimeout(() => { row.guard ??= 'quit_over_15s'; current.child.kill('SIGKILL'); }, 15000);
  try { await current.stop(); } finally { clearTimeout(timer); }
  row.quits.push({ ms: performance.now() - began, code: current.child.exitCode, signal: current.child.signalCode });
  app = undefined;
  assert.equal(current.child.exitCode, 0, 'App must finish normal shutdown');
};
const snapshot = () => api('getOrganization', { scope: 'all', project: null });
const project = 'RSI14 synthetic';
const calls = [];
let unexpectedModel = false;
const stub = httpServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const chunk of request) { body += chunk; assert(body.length < 200000); }
    const input = JSON.parse(body);
    const system = input.messages.find(message => message.role === 'system')?.content ?? '';
    const kind = system.includes('自动维护知识') ? 'knowledge' : system.includes('执行经验') ? 'experience' : system.includes('整理同一个项目里的待办') ? 'todo' : system.includes('比较同一项目') ? 'conflict' : 'other';
    assert.notEqual(kind, 'other'); calls.push({ kind, at: Date.now() });
    const answer = kind === 'knowledge' ? { memory: null, triage: null, question: null } : kind === 'experience' ? { hasObservation: false } : kind === 'todo' ? { groups: [], acceptance: [], links: [] } : { pairs: [] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `stub-${calls.length}`, model: 'stub-model', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(answer) } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }));
  } catch { unexpectedModel = true; response.writeHead(400).end(); }
});
await new Promise(done => stub.listen(0, '127.0.0.1', done));
const call = async (name, input) => {
  let timer;
  const response = await Promise.race([mcp.call(name, input), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), 15000); })]).finally(() => clearTimeout(timer));
  assert(!response.error && !response.result?.isError, JSON.stringify(response));
  return response.result;
};
const configurations = minutes > 0 ? [{ density: 'unique', count: 2157, concurrency: 4 }] : ['repeated', 'unique', 'compact'].flatMap((density, index) => [1, 4].map(concurrency => ({ density, count: [2024, 2157, 5749][index], concurrency })));

for (const { count, density, concurrency } of configurations) {
  const root = await realpath(await mkdtemp(join(scratch, `${density}-${concurrency}-`)));
  const statePath = join(root, 'user-data/organization/state.json');
  const seed = densityState(count, density); const raw = `${JSON.stringify(seed)}\n`;
  const encoded = Buffer.byteLength(raw) <= 8 * 1024 * 1024 ? raw : `${JSON.stringify({ version: 2, compression: 'gzip', data: gzipSync(raw).toString('base64') })}\n`;
  await mkdir(join(root, 'user-data/organization'), { recursive: true, mode: 0o700 });
  await writeFile(statePath, encoded, { mode: 0o600, flag: 'wx' });
  assert(Buffer.byteLength(encoded) <= 8 * 1024 * 1024);
  assert(Buffer.byteLength(raw) > 11 * 1024 * 1024 && Buffer.byteLength(raw) < 13 * 1024 * 1024, 'density cells must have comparable logical byte sizes');
  const row = { density, concurrency, count, physicalBytes: Buffer.byteLength(encoded), root, seedHash: sha(raw), logicalBytes: Buffer.byteLength(raw), updatesMs: [], batchesMs: [], checks: [], quits: [], samples: [], guard: null, preserved: false };
  rows.push(row); let phase = 'startup'; let sampling = false; let sampleTask = Promise.resolve(); let samplingFailures = 0; let lastSampleWall;
  const started = performance.now();
  const sample = async () => {
    if (sampling || !observedChild || observedChild.exitCode !== null || observedChild.signalCode !== null) return;
    sampling = true; const current = observedChild;
    try {
      const { stdout } = await execute('/bin/ps', ['-o', 'rss=', '-p', String(current.pid)], { env: {}, timeout: 2000 });
      const rssKiB = Number(stdout.trim());
      if (Number.isFinite(rssKiB) && rssKiB > 0) {
        const wall = Date.now();
        if (lastSampleWall !== undefined && wall - lastSampleWall > 60000) { row.guard = 'sampling_gap_over_60s'; current.kill('SIGKILL'); }
        row.maxSampleGapMs = Math.max(row.maxSampleGapMs ?? 0, lastSampleWall === undefined ? 0 : wall - lastSampleWall); lastSampleWall = wall;
        samplingFailures = 0;
        row.samples.push({ atMs: performance.now() - started, phase, rssKiB });
        if (rssKiB > 1536 * 1024) { row.guard = 'rss_over_1536_MiB'; current.kill('SIGKILL'); }
      } else throw new Error('invalid RSS sample');
    } catch (caught) {
      if (current.exitCode === null && current.signalCode === null && ++samplingFailures >= 2) {
        row.guard = 'rss_monitor_unavailable'; row.monitorError = String(caught); current.kill('SIGKILL');
      }
    } finally { sampling = false; }
  };
  const monitor = setInterval(() => { if (!sampling) sampleTask = sample(); }, 200);
  try {
    await start(root); assert.equal((await snapshot()).damaged, null);
    mcp = await connectMcp({ env: app.env, bridge: join(appPath, 'Contents/Resources/bridge/paraself-bridge'), client: 'claude-code' });
    const callStart = calls.length; row.callStart = callStart;
    await api('setLocalCredentialsEnabled', true);
    const settings = { automatic: true, background: false, backgroundProfileId: 'lab-stub', maxCalls: 8, inputTokens: 24000 };
    const priority = Math.max(-1, ...(await api('listModelProviderProfiles')).map(profile => profile.priority)) + 1;
    await api('saveModelProviderProfile', { profile: { version: 1, profileId: 'lab-stub', kind: 'openai-compatible', label: '隔离合成桩', enabled: true, priority, model: 'stub-model', timeoutMs: 10000, baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, apiProtocol: 'chat-completions', credentialConfigured: false, proxy: { mode: 'direct' }, fallbackOnFailure: false }, secret: 'synthetic-not-a-real-key' });
    await api('setOrganizationSettings', settings);
    const expectedSources = { preferences: 0, ideas: 0, decisions: 0 };
    const sourceOf = { preference: 'preferences', idea: 'ideas', decision: 'decisions' };
    const record = async (kind, index) => { await api('createProactiveRecord', { kind, sourceKind: 'app_manual', sourceForm: 'user_original', sensitivity: 'private', tags: ['synthetic'], ...(kind === 'decision' ? { options: [] } : kind === 'idea' ? { openQuestions: [] } : {}), project, title: `合成${kind} ${index}`, content: `隔离合成记录 ${index}：先验证，发布另行决定。` }); expectedSources[sourceOf[kind]] += 1; };
    for (const kind of ['preference', 'idea', 'decision']) await record(kind, 0);
    const recorded = await call('record_todo_list', { title: '隔离合成清单', project, items: [{ title: '合成任务检查', priority: 'p2' }] });
    const listId = recorded.structuredContent.todoRecord.list.id;
    const search = async () => {
      const result = await call('search_decision_context', { source: ['preferences', 'ideas', 'decisions', 'experiences'], project, query: '', limit: 20 });
      const context = result.structuredContent.context;
      row.searchSources = [...new Set(context.results.map(entry => entry.source))];
      row.sourceCoverage = context.sources;
      // A page is capped at 20 and decisions rank first; completeness belongs to source counts, not page diversity.
      assert(context.results.length > 0 && Object.entries(expectedSources).every(([source, count]) => context.sources.some(entry => entry.source === source && entry.status === 'ready' && entry.skipped === 0 && entry.records === count)), 'every seeded source must remain readable even beyond the first page');
    };
    await until(async () => { try { await search(); return true; } catch { return false; } }, 'mixed sources indexed');
    const began = performance.now(); row.startedAt = new Date().toISOString(); let round = 0;
    do {
      phase = 'mixed-batch';
      const operations = [
        async () => assert.equal((await snapshot()).damaged, null),
        async () => api('getTodoAnnotations', { listIds: [listId] }),
        search,
        async () => { const at = performance.now(); await api('setOrganizationSettings', { ...settings, maxCalls: round % 2 ? 7 : 8 }); row.updatesMs.push(performance.now() - at); },
      ];
      const at = performance.now();
      if (concurrency === 4) await Promise.all(operations.map(operation => operation()));
      else for (const operation of operations) await operation();
      row.batchesMs.push(performance.now() - at);
      // Add one distinct source per checkpoint, then let the actual idle scheduler consume it.
      phase = 'background';
      const beforeBackground = calls.length;
      const previousRun = (await snapshot()).run?.runId;
      await record(['preference', 'idea', 'decision'][round % 3], round + 1);
      await api('setOrganizationSettings', { ...settings, background: true });
      await sleep(8000);
      const state = await until(async () => { const view = await snapshot(); return view.activeRun === null && view.run?.runId !== previousRun && view.run?.trigger === 'background' ? view : null; }, 'new background run completed');
      assert(!unexpectedModel, 'unexpected model route');
      assert(state.run?.trigger === 'background' && state.run.runId !== previousRun && calls.length > beforeBackground, 'new sources must be processed by an actual new background run');
      assert(['done', 'partial', 'no_change'].includes(state.run.state) && state.run.usage.failedCalls === 0, 'background must finish or retain a bounded continuation without failures');
      row.checks.push({ round, elapsedMs: performance.now() - began, runs: state.usage7d.runs, calls: calls.length, active: state.activeRun?.state ?? null });
      await api('setOrganizationSettings', settings);
      await until(async () => (await snapshot()).activeRun === null, 'background settled');
      round += 1;
      await writeFile(join(out, 'PROGRESS.json'), `${JSON.stringify({ label: values.label, density, concurrency, elapsedMs: performance.now() - began, round, peakRssMiB: Math.max(...row.samples.map(sample => sample.rssKiB)) / 1024, guard: row.guard, error: null })}\n`);
      if (minutes > 0) await sleep(Math.min(20000, Math.max(0, minutes * 60000 - (performance.now() - began))));
      assert(!row.guard, row.guard ?? 'guard');
    } while (minutes > 0 ? performance.now() - began < minutes * 60000 : round < 3);
    row.modelCalls = calls.length - callStart;
    row.elapsedMs = performance.now() - began; row.endedAt = new Date().toISOString();
    assert(calls.length > callStart, 'the actual background path must reach the isolated model stub');
    phase = 'quit-under-run';
    const lastRun = await api('runOrganization', { scope: 'all', project: null, profileId: 'lab-stub' });
    assert.equal(lastRun.status, 'started');
    mcp.close(); mcp = undefined;
    await stop(row);
    phase = 'restart'; await start(root);
    const recovered = await until(async () => { const view = await snapshot(); return view.activeRun === null ? view : null; }, 'restart recovery');
    assert(recovered.run.runId === lastRun.run.runId);
    phase = 'idle-quit'; await stop(row);
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    const final = stored.version === 2 ? JSON.parse(gunzipSync(Buffer.from(stored.data, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) : stored;
    row.preserved = Object.entries(seed.suggestions).every(([key, value]) => isDeepStrictEqual(final.suggestions[key], value)) && isDeepStrictEqual(final.ledger.forgotten, seed.ledger.forgotten) && isDeepStrictEqual(final.ledger.forgottenEvidence, seed.ledger.forgottenEvidence);
    assert(row.preserved, 'choices receipts and plans must remain exact');
    assert(row.samples.length > 0, 'memory measurement must not silently return zero samples');
  } catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); row.error = error; }
  finally {
    clearInterval(monitor); await sampleTask;
    mcp?.close(); mcp = undefined;
    if (app) try { await stop(row); } catch (caught) { row.cleanupError = String(caught); }
    try {
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      const final = stored.version === 2 ? JSON.parse(gunzipSync(Buffer.from(stored.data, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) : stored;
      row.preserved = Object.entries(seed.suggestions).every(([key, value]) => isDeepStrictEqual(final.suggestions[key], value)) && isDeepStrictEqual(final.ledger.forgotten, seed.ledger.forgotten) && isDeepStrictEqual(final.ledger.forgottenEvidence, seed.ledger.forgottenEvidence);
    } catch (caught) { row.integrityError = String(caught); row.preserved = false; }
    row.completed = !row.error && !row.guard && !row.cleanupError && row.preserved && row.samples.length > 0;
    row.peakRssMiB = Math.max(0, ...row.samples.map(sample => sample.rssKiB)) / 1024;
    row.updateMeanMs = row.updatesMs.reduce((sum, ms) => sum + ms, 0) / Math.max(1, row.updatesMs.length);
    await writeFile(join(out, `${density}-${concurrency}.json`), `${JSON.stringify(row, null, 2)}\n`);
    console.log(JSON.stringify({ density, concurrency, count, elapsedMs: row.elapsedMs, peakRssMiB: row.peakRssMiB, updateMeanMs: row.updateMeanMs, maintenanceMs: row.maintenanceMs, quits: row.quits, guard: row.guard, preserved: row.preserved }));
  }
  if (error || row.guard) break;
}
await new Promise(done => stub.close(done));
await writeFile(join(out, 'SUMMARY.json'), `${JSON.stringify({ label: values.label, appHash: sha(await readFile(join(appPath, 'Contents/Resources/app.asar'))), rows, calls, error }, null, 2)}\n`);
process.exitCode = error || rows.some(row => !row.completed || !row.preserved) ? 1 : 0;
