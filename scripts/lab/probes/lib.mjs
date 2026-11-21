// Shared helpers for the lab probes in this directory. Candidate and main builds run the same code.
// Everything is synthetic: an empty isolated root plus generated Decision Journal notes. No user data is read.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Children inherit process.env (isolationEnvironment copies it): drop anything credential-like, once, here.
for (const name of Object.keys(process.env)) if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(name)) delete process.env[name];

// isolated-app.mjs next to this directory; PARASELF_LAB_ISOLATED_APP points at another copy if a candidate changed it.
const ISOLATED = process.env.PARASELF_LAB_ISOLATED_APP ?? new URL('../isolated-app.mjs', import.meta.url).href;
export const { startIsolatedApp, connectMcp, isolationEnvironment } = await import(ISOLATED);

export const LAB = process.env.PARASELF_LAB_ROOT ?? tmpdir();
// Scratch roots and cold copies of the probes go here; created once so a fresh lab directory works.
export const DATA_DIR = join(LAB, 'data', 'probes');
await mkdir(DATA_DIR, { recursive: true });
export const SEMANTIC_MARKERS = ['语义补充这次不可用', '本机嵌入未在时限内完成', '正在后台建立'];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.timeOrigin + performance.now();

/** Common flags. --app is the .app bundle, --bridge the paraself-bridge executable: both required, never defaulted. */
export const parseCommon = (extra = {}) => {
  const { values } = parseArgs({
    options: { app: { type: 'string' }, bridge: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' }, n: { type: 'string' }, ...extra },
  });
  for (const k of ['app', 'bridge', 'label', 'out']) if (!values[k]) throw new Error(`--${k} is required`);
  return { ...values, app: resolve(values.app), bridge: resolve(values.bridge), out: resolve(values.out), n: Number(values.n ?? 1) };
};
export const executableOf = (app) => join(app, 'Contents', 'MacOS', 'Paraself');

const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex').slice(0, 16);
/** Build identity for every result: app.asar and bridge hashes (the main-process code), plus the bundle's code directory hash. */
export const buildHash = async (app, bridge) => {
  let output;
  try { output = execFileSync('codesign', ['-dvvv', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { output = String(e.stderr ?? ''); }
  // codesign writes to stderr on success; execFileSync drops it, so ask again through the shell when empty.
  if (!/CDHash=/.test(output)) output = execFileSync('/bin/sh', ['-c', 'codesign -dvvv "$0" 2>&1', app], { encoding: 'utf8' });
  return { asar: await sha(join(app, 'Contents', 'Resources', 'app.asar')), bridge: await sha(bridge), cdhash: /CDHash=(\w+)/.exec(output)?.[1] ?? null };
};

export const loadInfo = () => ({ loadavg: loadavg().map((x) => +x.toFixed(2)), at: new Date().toISOString() });

/** A cold start copy: APFS clone with fresh bundle identifiers, re-signed ad hoc. The Metal shader cache lives in
 * $DARWIN_USER_CACHE_DIR/<CFBundleIdentifier>/ (a plain re-signature, even with changed content, hit it: measured), so a new
 * identifier suffix per copy is what makes the start cold. Caller deletes the copy with removeColdCopy (which drops the cache dirs too). */
export const makeColdCopy = async (app, dir, name) => {
  const copy = join(dir, `${name}.app`);
  await rm(copy, { recursive: true, force: true });
  execFileSync('cp', ['-c', '-R', app, copy]);
  const suffix = `.r10c${randomBytes(4).toString('hex')}`;
  await writeFile(join(copy, 'Contents', 'Resources', 'r10-nonce.txt'), suffix);
  const plists = [join(copy, 'Contents', 'Info.plist'), ...readdirSync(join(copy, 'Contents', 'Frameworks')).filter((f) => f.endsWith('.app')).map((f) => join(copy, 'Contents', 'Frameworks', f, 'Contents', 'Info.plist'))];
  for (const plist of plists) {
    const id = execFileSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist], { encoding: 'utf8' }).trim();
    execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', `${id}${suffix}`, plist]);
  }
  execFileSync('codesign', ['--force', '--deep', '-s', '-', copy], { stdio: 'ignore' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', copy], { stdio: 'ignore' });
  return copy;
};
export const removeColdCopy = async (copy) => {
  const suffix = await readFile(join(copy, 'Contents', 'Resources', 'r10-nonce.txt'), 'utf8').catch(() => null);
  await rm(copy, { recursive: true, force: true });
  if (suffix?.startsWith('.r10c')) {
    const cache = execFileSync('getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim();
    for (const id of ['com.cognelis.paraself', 'com.cognelis.paraself.helper']) await rm(join(cache, `${id}${suffix}`), { recursive: true, force: true });
  }
};

const TOPICS = [
  ['任务失败重试', '后台任务失败后采用指数退避，三次后进入死信队列'], ['接口字段命名', '对外接口字段统一使用 snake_case'],
  ['防止重复扣款', '付款请求必须携带幂等键，重复请求返回首次结果'], ['持久化方案', '本地存储采用 WAL 模式的 SQLite'],
  ['令牌轮换', '短期访问令牌每小时轮换一次'], ['发布文档格式', '产品发布说明采用 Markdown 编写'],
  ['事件投递一致性', '订单事件使用 transactional outbox 投递'], ['日志保留期', '应用日志在线保留三十天后归档'],
  ['缓存失效策略', '缓存采用写后失效，并设置五分钟兜底过期'], ['灰度发布', '新功能先对百分之五用户灰度，观察一天再放量'],
];
export const QUERIES = ['怎样避免同一笔支付被重复执行', '失败的后台任务要等待更久再重试', '对外字段怎么命名', '本地数据库用什么存储', 'how to rotate access tokens',
  '发布说明用什么格式写', 'retry failed jobs with backoff', '订单事件怎么保证不丢', '日志要保留多久', '新功能怎样逐步放量'];
/** 30 synthetic decision notes (10 topics x 3 variants), project "lab". Written straight into the vault directory. */
export const seedVault = async (vault, count = 30) => {
  for (let i = 0; i < count; i++) {
    const [title, body] = TOPICS[i % TOPICS.length];
    const id = `D${9000 + i}`;
    const file = join(vault, 'Decision Journal', 'summarize', `${id}.md`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `---\nid: ${id}\ncreated: "2026-10-01"\nstatus: "accepted"\nselected_option: "${body}"\nproject: "lab"\ntags: ["synthetic"]\nsupersedes: []\nsuperseded_by: null\n---\n# ${title} ${Math.floor(i / TOPICS.length) + 1}\n\n${body}。（合成数据 ${i}）\n`);
  }
};

/** One search through the bridge: { ms, status: available | busy | not_running | <other reason>, semantic: bool|null }. */
export const searchOnce = async (mcp, args = { query: '索引准备', limit: 5 }, timeoutMs = 30_000) => {
  const t = performance.now();
  let response;
  try { response = await Promise.race([mcp.call('search_decision_context', args), sleep(timeoutMs).then(() => { throw new Error('timeout'); })]); } catch (e) { return { ms: Math.round(performance.now() - t), status: `error:${e.message}`, semantic: null }; }
  const body = response.result?.structuredContent ?? response.result ?? response;
  const text = JSON.stringify(response);
  // search_decision_context's unavailable result carries no reason field, only runtimeFailureText's sentence (apps/bridge/src/runtime-client.ts).
  const reasonOf = (m) => m.includes('没有及时回应') ? 'busy' : m.includes('没有运行或连不上') ? 'not_running' : m.includes('版本比') ? 'outdated' : m.includes('没有收到能读懂') ? 'no_answer' : m.includes('没有完成这次请求') ? 'refused' : 'unavailable';
  const status = response.error ? 'rpc-error' : body.availability === 'unavailable' ? reasonOf(String(body.message)) : body.context || body.availability === 'available' ? 'available' : 'unknown';
  return { ms: Math.round(performance.now() - t), status, semantic: !SEMANTIC_MARKERS.some((m) => text.includes(m)) };
};

/** Ready = a search answers with none of the "semantic unavailable / late / pending" notices. Returns ms since `since`. */
export const waitSemanticReady = async (mcp, since, timeoutMs = 180_000) => {
  while (now() - since < timeoutMs) { if ((await searchOnce(mcp)).semantic) return Math.round(now() - since); await sleep(500); }
  throw new Error(`semantic not ready within ${timeoutMs} ms`);
};

/** Start (isolated root), seed, wait semantic ready, stop: leaves vectors on disk so the measured start is a restart over a seeded vault. */
export const primeRoot = async (root, executable, bridge) => {
  const app = await startIsolatedApp({ root, executable, useLocalModels: true });
  ownPids.add(app.child.pid);
  await seedVault(app.env.PARASELF_VAULT_PATH);
  const mcp = await connectMcp({ env: app.env, bridge });
  try { await waitSemanticReady(mcp, now()); } finally { mcp.close(); await app.stop(); }
};

export const percentile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null; };

/** Raw result file: <out>/<probe>-<label>-<tag>.json. */
export const save = async (out, probe, label, tag, data) => {
  await mkdir(out, { recursive: true });
  const file = join(out, `${probe}-${label}-${tag}.json`);
  await writeFile(file, JSON.stringify({ probe, label, ...data }, null, 1));
  console.log(JSON.stringify({ file, ...data.summary }));
  return file;
};

/** PIDs this process started; only these are ever signalled. */
export const ownPids = new Set();
process.on('exit', () => { for (const pid of ownPids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } });
export const track = (child) => { ownPids.add(child.pid); child.once('exit', () => ownPids.delete(child.pid)); return child; };
export const ended = (child) => child.exitCode !== null || child.signalCode !== null;
