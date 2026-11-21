// R10-FW latency, fresh-write variant of latency.mjs (which it leaves as it is): same synthetic vault and warm start, but
// before each search 1-4 new in-scope decisions (cycling 1,2,3,4; project lab) are written through the bridge's
// record_decision_journal_entry, and the search is asked at once. The new notes are Chinese and the query English, so no
// keyword finds them and only meaning can: the case a search embeds them itself (IMP-137). Only the search is timed.
// Per call: ms, status, written ids, how many came back (found), and whether the "已请求后台补建" notice was given.
// usage: node latency-fresh.mjs --app X.app --bridge .../paraself-bridge --label main --out DIR [--n 1] [--calls 50] [--settle-ms 0]
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, LAB, buildHash, connectMcp, executableOf, loadInfo, now, parseCommon, percentile, save, searchOnce, seedVault, sleep, startIsolatedApp, track, waitSemanticReady } from './lib.mjs';

const { app, bridge, label, out, n, calls, 'settle-ms': settleMs } = parseCommon({ calls: { type: 'string' }, 'settle-ms': { type: 'string' } });
const CALLS = Number(calls ?? 50);
// Waited before each round's writes, so the background sync takes the round before: without it, rounds written back to
// back are a write storm, over the four a search embeds itself.
const SETTLE_MS = Number(settleMs ?? 0);
const dataDir = DATA_DIR;
const build = await buildHash(app, bridge);

// Synthetic (合成): [Chinese note, English query meaning the same, sharing no word with it].
const FRESH = [
  ['网络瞬时故障采用指数退避重试，等待时间翻倍并添加随机抖动，最多重试三次', 'retry transient network failures at most three times with doubled waits and random jitter'],
  ['用户上传的头像存进对象存储，经内容分发网络下发，不落在应用服务器磁盘', 'where are profile pictures that users upload kept'],
  ['发票文件改为放进后台任务队列异步生成，完成后通知客户下载', 'invoices are rendered in the background and the customer is told when ready'],
  ['接口限流按租户计数，超过配额返回四二九并附带重试等待秒数', 'rate limiting counted per tenant, over quota answers 429 with a retry-after'],
  ['数据库迁移先加新列双写，回填完成后再切读，最后删除旧列', 'schema change by adding a column, writing both, backfilling, then switching reads'],
  ['会话令牌有效期缩短到十五分钟，配合刷新令牌静默续期', 'short-lived session tokens renewed silently with a refresh token'],
];

const searchFresh = async (mcp, args, ids, timeoutMs = 30_000) => {
  const t = performance.now();
  let response;
  try { response = await Promise.race([mcp.call('search_decision_context', args), sleep(timeoutMs).then(() => { throw new Error('timeout'); })]); } catch (e) { return { ms: Math.round(performance.now() - t), status: `error:${e.message}` }; }
  const ms = Math.round(performance.now() - t);
  const body = response.result?.structuredContent ?? response.result ?? response;
  const results = (body.context?.results ?? []).map((r) => r.id);
  const text = JSON.stringify(response);
  return { ms, status: response.error ? 'rpc-error' : body.context ? 'available' : String(body.availability ?? 'unknown'),
    found: ids.filter((id) => results.includes(id)).length, pendingNotice: text.includes('已请求后台补建'),
    semanticUnavailable: text.includes('语义补充这次不可用') || text.includes('本机嵌入未在时限内完成') };
};

for (let i = 1; i <= n; i++) {
  const root = await mkdtemp(join(dataDir, `${label}-latency-fresh-`));
  try {
    const a = await startIsolatedApp({ root, executable: executableOf(app), useLocalModels: true });
    track(a.child);
    await seedVault(a.env.PARASELF_VAULT_PATH);
    const mcp = await connectMcp({ env: a.env, bridge });
    try {
      await waitSemanticReady(mcp, now());
      for (let w = 0; w < 3; w++) await searchOnce(mcp, { query: FRESH[w][1], limit: 5 }); // discarded warm-up
      const load = loadInfo();
      const series = [];
      let written = 0;
      for (let k = 0; k < CALLS; k++) {
        if (SETTLE_MS > 0) await sleep(SETTLE_MS);
        const count = (k % 4) + 1;
        const topic = FRESH[k % FRESH.length];
        const ids = [];
        for (let j = 0; j < count; j++) {
          const r = await mcp.call('record_decision_journal_entry', { kind: 'decision', title: `合成新写入 ${k}-${j}`,
            content: `${topic[0]}。（合成数据 R10-FW ${k}-${j}）`, project: 'lab', rationale: '合成：延迟测量。' });
          const id = (r.result?.structuredContent ?? r.result)?.record?.recordId;
          if (id) ids.push(id);
          written += 1;
        }
        series.push({ k, written: count, ids, query: topic[1], ...(await searchFresh(mcp, { query: topic[1], project: 'lab', limit: 8 }, ids)) });
      }
      const ms = series.map((s) => s.ms);
      await save(out, 'latency-fresh', label, String(i), {
        app, build, load,
        summary: { i, calls: CALLS, settleMs: SETTLE_MS, written, p50: percentile(ms, 50), p95: percentile(ms, 95), max: Math.max(...ms), min: Math.min(...ms),
          notAvailable: series.filter((s) => s.status !== 'available').length,
          allFound: series.filter((s) => s.found === s.ids?.length).length, foundRecords: series.reduce((sum, s) => sum + (s.found ?? 0), 0),
          pendingNotice: series.filter((s) => s.pendingNotice).length, semanticUnavailable: series.filter((s) => s.semanticUnavailable).length },
        series,
      });
    } finally { mcp.close(); await a.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}
