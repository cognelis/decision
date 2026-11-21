// latency: on a synthetic vault, warm (semantic ready), 50 consecutive search_decision_context calls through the bridge;
// raw per-call times, p50 / p95, and how many calls carried a "semantic unavailable / late / pending" notice.
// usage: node latency.mjs --app X.app --bridge .../paraself-bridge --label main --out DIR [--n 1] [--calls 50]
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, LAB, QUERIES, buildHash, connectMcp, executableOf, loadInfo, now, parseCommon, percentile, save, searchOnce, seedVault, startIsolatedApp, track, waitSemanticReady } from './lib.mjs';

const { app, bridge, label, out, n, calls } = parseCommon({ calls: { type: 'string' } });
const CALLS = Number(calls ?? 50);
const dataDir = DATA_DIR;
const build = await buildHash(app, bridge);

for (let i = 1; i <= n; i++) {
  const root = await mkdtemp(join(dataDir, `${label}-latency-`));
  try {
    const a = await startIsolatedApp({ root, executable: executableOf(app), useLocalModels: true });
    track(a.child);
    await seedVault(a.env.PARASELF_VAULT_PATH);
    const mcp = await connectMcp({ env: a.env, bridge });
    try {
      await waitSemanticReady(mcp, now());
      for (const q of QUERIES.slice(0, 3)) await searchOnce(mcp, { query: q, limit: 5 }); // discarded warm-up
      const load = loadInfo();
      const series = [];
      for (let k = 0; k < CALLS; k++) series.push({ k, query: QUERIES[k % QUERIES.length], ...(await searchOnce(mcp, { query: QUERIES[k % QUERIES.length], limit: 5 })) });
      const ms = series.map((s) => s.ms);
      await save(out, 'latency', label, String(i), {
        app, build, load,
        summary: { i, calls: CALLS, p50: percentile(ms, 50), p95: percentile(ms, 95), max: Math.max(...ms), min: Math.min(...ms), notAvailable: series.filter((s) => s.status !== 'available').length, withoutSemantic: series.filter((s) => s.semantic !== true).length },
        series,
      });
    } finally { mcp.close(); await a.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
