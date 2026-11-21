// startup-probe: in the 30 s after an isolated App is spawned, GET /health every 100 ms (longest gap between answers)
// and call search_decision_context through the bridge once a second (available / busy / not_running, with timing).
// usage: node startup-probe.mjs --app X.app --bridge .../paraself-bridge --label main --mode cold|warm --out DIR [--n 3]
// cold: the App is a re-signed APFS clone (Metal cache misses); warm: the build itself, primed by an earlier start. Vectors are on disk either way.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR,
  LAB, buildHash, connectMcp, ended, executableOf, isolationEnvironment, loadInfo, makeColdCopy, now, parseCommon, primeRoot,
  removeColdCopy, save, searchOnce, sleep, track,
} from './lib.mjs';

const { app, bridge, label, out, n, mode } = parseCommon({ mode: { type: 'string' } });
if (!['cold', 'warm'].includes(mode)) throw new Error('--mode cold|warm');
const WINDOW_MS = 30_000;
const dataDir = DATA_DIR;
await mkdir(dataDir, { recursive: true });
const build = await buildHash(app, bridge);

const health = (port) => new Promise((resolve) => {
  const sent = now();
  const req = http.request({ host: '127.0.0.1', port, path: '/health', agent: false, timeout: 15_000 }, (res) => { res.resume(); res.on('end', () => resolve({ ms: Math.round(now() - sent), ok: res.statusCode === 200 })); });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve({ ms: Math.round(now() - sent), ok: false }));
  req.end();
});
const shutdown = (runtime) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: runtime.port, path: '/v1/smoke/shutdown', method: 'POST', agent: false, headers: { authorization: `Bearer ${runtime.token}` } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', (e) => resolve(e.code));
  req.end();
});

for (let i = 1; i <= n; i++) {
  const root = await mkdtemp(join(dataDir, `${label}-${mode}-`));
  const copy = mode === 'cold' ? await makeColdCopy(app, dataDir, `${label}-cold-${i}`) : null;
  try {
    await primeRoot(root, executableOf(app), bridge); // vectors exist before the measured start; always primed by the original build
    const env = isolationEnvironment(root);
    await rm(env.PARASELF_RUNTIME_FILE, { force: true });
    const load = loadInfo();
    const mcp = await connectMcp({ env, bridge });
    const child = track(spawn(executableOf(copy ?? app), [], { env, stdio: ['ignore', 'ignore', 'pipe'] }));
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = `${stderr}${c}`.slice(-2000); });
    const t0 = now();
    let runtime;
    const probes = [], searches = [], pending = [];
    for (let tick = 0; now() - t0 < WINDOW_MS; tick++) {
      const at = Math.round(now() - t0);
      if (!runtime) { try { runtime = JSON.parse(await readFile(env.PARASELF_RUNTIME_FILE, 'utf8')); } catch { /* not written yet */ } }
      if (runtime) pending.push(health(runtime.port).then((r) => probes.push({ at, ...r })));
      if (tick % 10 === 0) pending.push(searchOnce(mcp).then((r) => searches.push({ at, ...r })));
      await sleep(Math.max(0, t0 + (tick + 1) * 100 - now()));
    }
    await Promise.all(pending);
    probes.sort((a, b) => a.at - b.at);
    const answered = probes.filter((p) => p.ok).map((p) => p.at + p.ms).sort((a, b) => a - b);
    const gaps = answered.slice(1).map((c, k) => c - answered[k]);
    const counts = {};
    for (const s of searches) counts[s.status] = (counts[s.status] ?? 0) + 1;
    mcp.close();
    let quit = null;
    if (runtime && !ended(child)) quit = await shutdown(runtime);
    const q = now();
    while (!ended(child) && now() - q < 120_000) await sleep(100);
    const killed = !ended(child);
    if (killed) child.kill('SIGKILL');
    await save(out, 'startup', label, `${mode}-${i}`, {
      mode, app, executable: executableOf(copy ?? app), build, measuredBuild: copy ? await buildHash(copy, bridge) : build, load, windowMs: WINDOW_MS,
      summary: {
        mode, i, firstHealthMs: answered[0] ?? null, maxGapMs: gaps.length ? Math.max(...gaps) : null,
        slowestProbeMs: Math.max(0, ...probes.map((p) => p.ms)), failedProbes: probes.filter((p) => !p.ok).length, searchStatus: counts,
        exitCode: child.exitCode, signal: child.signalCode, killedByProbe: killed,
      },
      series: { health: probes, search: searches }, quit, stderrTail: stderr.slice(-500),
    });
  } finally {
    if (copy) await removeColdCopy(copy);
    await rm(root, { recursive: true, force: true });
  }
}
