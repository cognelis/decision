// A bounded persistence benchmark, not an App or long-duration performance claim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values } = parseArgs({ options: { rev: { type: 'string' }, out: { type: 'string' } } });
assert(values.out && values.rev && (values.rev === 'worktree' || /^[a-f0-9]{7,40}$/.test(values.rev)));
assert.equal(Number(process.versions.node.split('.')[0]), 22);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'paraself-store-growth-'));
const out = resolve(values.out); await mkdir(out, { recursive: true });
const source = 'apps/desktop/src/main/organization-store.ts';
const storeSource = values.rev === 'worktree' ? await readFile(join(repository, source), 'utf8') : execFileSync('git', ['show', `${values.rev}:${source}`], { cwd: repository, encoding: 'utf8' });
const compiled = join(root, 'store.cjs');
await build({ stdin: { contents: `export { OrganizationStore } from './${source}'; export { capacityState } from './apps/desktop/test/organization-capacity-fixture.ts';`, resolveDir: repository }, bundle: true, platform: 'node', format: 'cjs', outfile: compiled, logLevel: 'silent', plugins: [{ name: 'frozen-store', setup(build) { build.onLoad({ filter: /organization-store\.ts$/ }, () => ({ contents: storeSource, loader: 'ts', resolveDir: join(repository, 'apps/desktop/src/main') })); } }] });
const { OrganizationStore, capacityState } = createRequire(import.meta.url)(compiled);
const path = join(root, 'state.json'); const store = new OrganizationStore(path); const rows = [];
let error = null; let preserved = false; let queuedMs = null; let workPeakMiB = null;
const steady = [];
try {
  await store.update(() => ({ state: capacityState(0), value: null }));
  for (let count = 1000; count <= 10000; count += 1000) {
    const added = capacityState(1000, count - 1000).suggestions;
    const began = performance.now();
    await store.update(state => { Object.assign(state.suggestions, added); return { state, value: null }; });
    const growthMs = performance.now() - began; const updatesMs = [];
    for (let update = 0; update < 5; update += 1) {
      const time = performance.now();
      await store.update(state => { state.settings.backgroundProfileId = `synthetic-${count}-${update}`; return { state, value: null }; });
      updatesMs.push(performance.now() - time);
    }
    const peakMiB = process.resourceUsage().maxRSS / 1024;
    rows.push({ count, growthMs, updatesMs, peakMiB, storedBytes: (await stat(path)).size });
    console.log(JSON.stringify(rows.at(-1)));
    assert(peakMiB <= 1536, 'bounded persistence memory budget exceeded');
  }
  const time = performance.now();
  const queued = Array.from({ length: 8 }, (_, index) => store.update(state => { state.settings.backgroundProfileId = `queued-${index}`; return { state, value: null }; }));
  await store.idle(); await Promise.all(queued); queuedMs = performance.now() - time;
  workPeakMiB = process.resourceUsage().maxRSS / 1024;
  for (let index = 0; index < 32; index += 1) {
    const began = performance.now();
    await store.update(state => { state.settings.backgroundProfileId = `steady-${index}`; return { state, value: null }; });
    workPeakMiB = process.resourceUsage().maxRSS / 1024;
    steady.push({ index, ms: performance.now() - began, peakMiB: workPeakMiB });
    assert(workPeakMiB <= 1536, 'steady-size persistence memory budget exceeded');
  }
  const saved = await store.read();
  assert.equal(saved.revision, 101); assert.equal(Object.keys(saved.suggestions).length, 10000);
  assert.equal(saved.settings.backgroundProfileId, 'steady-31');
  assert(isDeepStrictEqual(saved.ledger.forgotten, capacityState(0).ledger.forgotten));
  assert(isDeepStrictEqual(saved.ledger.forgottenEvidence, capacityState(0).ledger.forgottenEvidence));
  for (let index = 0; index < 10000; index += 1) assert(isDeepStrictEqual(saved.suggestions[`history-${index}`], capacityState(1, index).suggestions[`history-${index}`]), `changed protected record ${index}`);
  preserved = true;
} catch (caught) { error = caught instanceof Error ? caught.stack : String(caught); console.error(error); }
await writeFile(join(out, 'SUMMARY.json'), `${JSON.stringify({ rev: values.rev, root, rows, queuedMs, steady, workPeakMiB, preserved, error }, null, 2)}\n`);
process.exitCode = error ? 1 : 0;
