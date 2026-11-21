// sigterm-probe: wait until the semantic supplement is ready (model loaded), send SIGTERM to the App's own PID,
// record exit code, signal, whether runtime.json was removed, and how long the exit took.
// usage: node sigterm-probe.mjs --app X.app --bridge .../paraself-bridge --label main --out DIR [--n 3]
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, LAB, buildHash, connectMcp, ended, executableOf, loadInfo, now, parseCommon, save, seedVault, sleep, startIsolatedApp, track, waitSemanticReady } from './lib.mjs';

const { app, bridge, label, out, n } = parseCommon();
const dataDir = DATA_DIR;
const build = await buildHash(app, bridge);
const exists = (f) => access(f).then(() => true, () => false);

for (let i = 1; i <= n; i++) {
  const root = await mkdtemp(join(dataDir, `${label}-sigterm-`));
  try {
    const load = loadInfo();
    const started = now();
    const a = await startIsolatedApp({ root, executable: executableOf(app), useLocalModels: true });
    track(a.child);
    await seedVault(a.env.PARASELF_VAULT_PATH);
    const mcp = await connectMcp({ env: a.env, bridge });
    const readyMs = await waitSemanticReady(mcp, started);
    const runtimeBefore = await exists(a.env.PARASELF_RUNTIME_FILE);
    mcp.close();
    const t = now();
    a.child.kill('SIGTERM');
    while (!ended(a.child) && now() - t < 90_000) await sleep(100);
    const killed = !ended(a.child);
    if (killed) a.child.kill('SIGKILL');
    while (!ended(a.child)) await sleep(50);
    const runtimeRemoved = !(await exists(a.env.PARASELF_RUNTIME_FILE));
    await save(out, 'sigterm', label, String(i), {
      app, build, load,
      summary: { i, readyMs, runtimeBefore, exitMs: Math.round(now() - t), exitCode: a.child.exitCode, signal: a.child.signalCode, runtimeRemoved, killedByProbeAfter90s: killed },
      stderrTail: a.stderr().slice(-500),
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
