// quick-quit (R9-QC's method): start the isolated App with local models, ask it to quit 1-3 s after it is healthy,
// the shutdown request on a connection of its own (retried once), and record how it ended (SIGABRT, exit time).
// usage: node quick-quit.mjs --app X.app --bridge .../paraself-bridge --label main --out DIR [--n 20]
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, LAB, buildHash, ended, executableOf, loadInfo, now, parseCommon, save, sleep, startIsolatedApp, track } from './lib.mjs';

const { app, bridge, label, out, n } = parseCommon();
const QUIT_WAIT_MS = Number(process.env.QUIT_WAIT_MS ?? 75_000);
const dataDir = DATA_DIR;
const build = await buildHash(app, bridge);
const shutdown = (runtime) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: runtime.port, path: '/v1/smoke/shutdown', method: 'POST', agent: false, headers: { authorization: `Bearer ${runtime.token}` } }, (res) => { res.resume(); resolve(`http${res.statusCode}`); });
  req.on('error', (e) => resolve(`err:${e.code ?? e.message}`));
  req.end();
});

for (let i = 1; i <= n; i++) {
  const root = await mkdtemp(join(dataDir, `${label}-quit-`));
  try {
    const load = loadInfo();
    const t0 = now();
    const a = await startIsolatedApp({ root, executable: executableOf(app), useLocalModels: true });
    track(a.child);
    const readyMs = Math.round(now() - t0);
    const delayMs = 1000 + Math.floor(Math.random() * 2000);
    await sleep(delayMs);
    const q = now();
    const results = [await shutdown(a.runtime)];
    if (results[0].startsWith('err')) results.push(await shutdown(a.runtime));
    while (!ended(a.child) && now() - q < QUIT_WAIT_MS) await sleep(100);
    const killed = !ended(a.child);
    if (killed) a.child.kill('SIGKILL');
    while (!ended(a.child)) await sleep(50);
    await save(out, 'quick-quit', label, String(i), {
      app, build, load,
      summary: { i, readyMs, delayMs, quitMs: Math.round(now() - q), exitCode: a.child.exitCode, signal: a.child.signalCode, sigabrt: a.child.signalCode === 'SIGABRT', killedByProbe: killed, shutdownResults: results },
      stderrTail: a.stderr().slice(-300),
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
