// Bounded synthetic growth checkpoints: real App updates, foreground requests, idle scheduler and quit/restart.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { ISOLATION_KEYS, startIsolatedApp } from '../isolated-app.mjs';

const { values } = parseArgs({ options: { app: { type: 'string' }, out: { type: 'string' }, label: { type: 'string' } } });
assert(values.app && values.out && values.label, '--app --out --label are required');
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const appPath = await realpath(resolve(values.app)); const out = resolve(values.out);
await mkdir(out, { recursive: true });
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'paraself-growth-')));
const compiled = join(scratch, 'fixture.cjs');
await build({ entryPoints: [fileURLToPath(new URL('../../../apps/desktop/test/organization-capacity-fixture.ts', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', outfile: compiled, logLevel: 'silent' });
const { capacityState } = createRequire(import.meta.url)(compiled);
const execute = promisify(execFile); const sleep = ms => new Promise(done => setTimeout(done, ms));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = []; let error = null; let app; let observedChild; let socket; let id = 0; const pending = new Map();
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
    if (response.error || response.result?.exceptionDetails) fail(new Error(response.result?.exceptionDetails?.exception?.description ?? 'IPC failed'));
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

for (const count of [1000, 5000, 10000]) {
  const root = await realpath(await mkdtemp(join(scratch, `${count}-`)));
  const statePath = join(root, 'user-data/organization/state.json');
  const seed = capacityState(count); const raw = `${JSON.stringify(seed)}\n`;
  const encoded = Buffer.byteLength(raw) <= 8 * 1024 * 1024 ? raw : `${JSON.stringify({ version: 2, compression: 'gzip', data: gzipSync(raw).toString('base64') })}\n`;
  await mkdir(join(root, 'user-data/organization'), { recursive: true, mode: 0o700 });
  await writeFile(statePath, encoded, { mode: 0o600, flag: 'wx' });
  const row = { count, root, seedHash: sha(raw), logicalBytes: Buffer.byteLength(raw), updatesMs: [], quits: [], samples: [], guard: null, preserved: false };
  rows.push(row); let phase = 'startup'; let sampling = false; let sampleTask = Promise.resolve(); let samplingFailures = 0;
  const started = performance.now();
  const sample = async () => {
    if (sampling || !observedChild || observedChild.exitCode !== null || observedChild.signalCode !== null) return;
    sampling = true; const current = observedChild;
    try {
      const { stdout } = await execute('/bin/ps', ['-o', 'rss=', '-p', String(current.pid)], { env: {}, timeout: 2000 });
      const rssKiB = Number(stdout.trim());
      if (Number.isFinite(rssKiB) && rssKiB > 0) {
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
    const profile = (await api('listModelProviderProfiles')).find(profile => profile.kind === 'qwen' && profile.enabled);
    assert(profile, 'isolated local profile must exist');
    phase = 'updates';
    for (let index = 0; index < 8; index += 1) {
      const began = performance.now();
      await api('setOrganizationSettings', { background: false, backgroundProfileId: `synthetic-${index}` });
      row.updatesMs.push(performance.now() - began);
    }
    phase = 'foreground-burst';
    const burstAt = performance.now();
    await Promise.all(Array.from({ length: 12 }, async () => {
      const response = await fetch(`http://127.0.0.1:${app.runtime.port}/v1/identity`, { headers: { 'x-decision-challenge': 'rsi13-synthetic-challenge' }, signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200); await response.arrayBuffer();
    }));
    row.foregroundResponsesMs = performance.now() - burstAt;
    const health = [];
    for (let index = 0; index < 8; index += 1) {
      await sleep(250); const began = performance.now();
      assert((await fetch(`http://127.0.0.1:${app.runtime.port}/health`, { signal: AbortSignal.timeout(15000) })).ok);
      health.push(performance.now() - began);
    }
    row.foregroundHealthMaxMs = Math.max(...health);
    phase = 'maintenance'; const runAt = performance.now();
    assert.equal((await api('runOrganization', { scope: 'all', project: null, profileId: profile.profileId })).status, 'started');
    const settled = await until(async () => { const view = await snapshot(); return view.activeRun === null ? view : null; }, 'maintenance bookkeeping');
    row.maintenanceMs = performance.now() - runAt;
    assert.equal(settled.run.usage.calls, 0, 'empty synthetic sources must not invoke a model');
    phase = 'background-idle';
    await api('setOrganizationSettings', { background: true, backgroundProfileId: profile.profileId });
    await sleep(6500);
    phase = 'quit-under-run';
    const lastRun = await api('runOrganization', { scope: 'all', project: null, profileId: profile.profileId });
    assert.equal(lastRun.status, 'started');
    await stop(row);
    phase = 'restart'; await start(root);
    const recovered = await until(async () => { const view = await snapshot(); return view.activeRun === null ? view : null; }, 'restart recovery');
    assert(recovered.run.runId === lastRun.run.runId);
    phase = 'idle-quit'; await stop(row);
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    const final = stored.version === 2 ? JSON.parse(gunzipSync(Buffer.from(stored.data, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) : stored;
    row.preserved = isDeepStrictEqual(final.suggestions, seed.suggestions) && isDeepStrictEqual(final.ledger.forgotten, seed.ledger.forgotten) && isDeepStrictEqual(final.ledger.forgottenEvidence, seed.ledger.forgottenEvidence);
    assert(row.preserved, 'choices receipts and plans must remain exact');
    assert(row.samples.length > 0, 'memory measurement must not silently return zero samples');
  } catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); row.error = error; }
  finally {
    clearInterval(monitor); await sampleTask;
    if (app) try { await stop(row); } catch (caught) { row.cleanupError = String(caught); }
    try {
      const stored = JSON.parse(await readFile(statePath, 'utf8'));
      const final = stored.version === 2 ? JSON.parse(gunzipSync(Buffer.from(stored.data, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) : stored;
      row.preserved = isDeepStrictEqual(final.suggestions, seed.suggestions) && isDeepStrictEqual(final.ledger.forgotten, seed.ledger.forgotten) && isDeepStrictEqual(final.ledger.forgottenEvidence, seed.ledger.forgottenEvidence);
    } catch (caught) { row.integrityError = String(caught); row.preserved = false; }
    row.completed = !row.error && !row.guard && !row.cleanupError && row.samples.length > 0;
    row.peakRssMiB = Math.max(0, ...row.samples.map(sample => sample.rssKiB)) / 1024;
    row.updateMeanMs = row.updatesMs.reduce((sum, ms) => sum + ms, 0) / Math.max(1, row.updatesMs.length);
    await writeFile(join(out, `${count}.json`), `${JSON.stringify(row, null, 2)}\n`);
    console.log(JSON.stringify({ count, peakRssMiB: row.peakRssMiB, updateMeanMs: row.updateMeanMs, maintenanceMs: row.maintenanceMs, quits: row.quits, guard: row.guard, preserved: row.preserved }));
  }
  if (error || row.guard) break;
}
await writeFile(join(out, 'SUMMARY.json'), `${JSON.stringify({ label: values.label, appHash: sha(await readFile(join(appPath, 'Contents/Resources/app.asar'))), rows, error }, null, 2)}\n`);
process.exitCode = error || rows.some(row => !row.completed || !row.preserved) ? 1 : 0;
