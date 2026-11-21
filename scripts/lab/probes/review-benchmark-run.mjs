// 评审评测集 end to end (IMP-193): the packaged App in an isolated root, the packaged bridge's MCP tools as an agent calls
// them, against a synthetic Git repository made here. Every step is checked; the results go to --out and the exit code
// says whether all held. Synthetic data only: no user data is read or written.
// usage: node scripts/lab/probes/review-benchmark-run.mjs --app out/Paraself-darwin-arm64/Paraself.app \
//          --bridge out/Paraself-darwin-arm64/Paraself.app/Contents/Resources/bridge/paraself-bridge --label main --out DIR
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR, buildHash, connectMcp, executableOf, parseCommon, save, startIsolatedApp } from './lib.mjs';

const { app, bridge, label, out } = parseCommon();
const build = await buildHash(app, bridge);
const root = await mkdtemp(join(DATA_DIR, 'review-benchmark-run-'));
const checks = [];
let runError = null; const cleanupErrors = [];
const check = (name, ok, evidence) => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { evidence }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
};

// A fixed remote, names and dates: the same repository id and commit ids each run, so the same splits.
const repository = join(root, 'repo');
const gitEnv = {
  PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};
const git = (...args) => execFileSync('git', ['-C', repository, ...args], { env: gitEnv, encoding: 'utf8' }).trim();
await mkdir(repository);
git('init', '-q', '-b', 'main');
git('remote', 'add', 'origin', 'https://example.test/demo/benchmark.git');
const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
for (const file of files) await writeFile(join(repository, file), 'one\n');
await writeFile(join(repository, 'api.ts'), 'throw error;\n');
git('add', '.');
git('commit', '-qm', 'Initial');
const target = git('rev-parse', 'HEAD');
for (const file of files) await writeFile(join(repository, file), 'one\ntwo\n');
await writeFile(join(repository, 'api.ts'), 'return null;\n');
git('commit', '-qam', 'Change the API');
const head = git('rev-parse', 'HEAD');
await writeFile(join(repository, 'api.ts'), 'return value;\n');
git('commit', '-qam', 'Fix the API');
const fix = git('rev-parse', 'HEAD');

const started = await startIsolatedApp({ root, executable: executableOf(app) });
const mcp = await connectMcp({ env: started.env, bridge, client: 'codex' });
const call = async (name, args) => {
  const response = await mcp.call(name, args);
  return { isError: response.result?.isError === true, text: response.result?.content?.[0]?.text ?? '', body: response.result?.structuredContent?.reviewBenchmark ?? null, error: response.error ?? null };
};

try {
  const tools = await mcp.listTools();
  const named = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  check('tools/list has the four review benchmark tools',
    ['record_review_benchmark_cases', 'list_review_benchmark_cases', 'get_review_benchmark_case', 'update_review_benchmark_case'].every((name) => named[name] !== undefined), tools.map((tool) => tool.name));
  check('the renamed tools are there and the old names gone',
    ['list_todo_lists', 'get_obsidian_note', 'list_decision_context_feedback'].every((name) => named[name] !== undefined)
      && ['get_todo_lists', 'read_obsidian_note', 'get_decision_context_feedback'].every((name) => named[name] === undefined), tools.map((tool) => tool.name));
  check('the reads are read-only', named.list_review_benchmark_cases?.annotations?.readOnlyHint === true && named.get_review_benchmark_case?.annotations?.readOnlyHint === true,
    [named.list_review_benchmark_cases?.annotations, named.get_review_benchmark_case?.annotations]);

  const issue = { title: '合成：返回 null 让调用方崩溃', priority: 'P1', evidence: '合成：修复提交改回返回值。', fixShas: [fix], locations: [{ path: 'api.ts', startLine: 1, endLine: 1 }] };
  const cases = [
    { set: 'defect', title: 'Change the API', headSha: head, targetSha: target, provenance: [{ kind: 'fix_commit', reference: fix }], issues: [issue] },
    ...files.map((file) => ({ set: 'clean', title: 'Change the API', headSha: head, targetSha: target, scope: [file], provenance: [{ kind: 'sampling', reference: `合成-${file}` }], mergedAt: '2026-02-01', cleanEvidence: '合成：合并后没有回滚。' })),
  ];
  const recorded = await call('record_review_benchmark_cases', { repositoryPath: repository, cases });
  const results = recorded.body?.cases ?? [];
  check('seven synthetic cases are recorded as candidates', !recorded.isError && results.length === 7 && results.every((item) => item.outcome === 'recorded' && item.status === 'candidate'), recorded);
  check('the App put them in both splits', new Set(results.map((item) => item.split)).size === 2, results.map((item) => item.split));
  const again = await call('record_review_benchmark_cases', { repositoryPath: repository, cases: [cases[0]] });
  check('the same case sent again is the one kept', again.body?.cases?.[0]?.outcome === 'duplicate' && again.body.cases[0].caseId === results[0]?.caseId, again);
  const fixed = await call('record_review_benchmark_cases', { repositoryPath: repository, cases: [{ ...cases[0], headSha: fix }] });
  check('a version that already holds its fix is refused, saying why', fixed.isError && /已经包含在 headSha 里/u.test(fixed.text), fixed);

  const listed = await call('list_review_benchmark_cases', { repositoryPath: repository });
  check('the listing counts both sets and shows no labels', listed.body?.counts?.defect?.candidate === 1 && listed.body?.counts?.clean?.candidate === 6 && !listed.text.includes('合成：合并后没有回滚'), listed);
  const holdout = results.find((item) => item.split === 'holdout');
  const dev = results.find((item, index) => index > 0 && item.split === 'dev');
  const hidden = await call('get_review_benchmark_case', { repositoryPath: repository, caseId: holdout?.caseId });
  check('a holdout case comes back without its labels', hidden.body?.case?.labelsWithheld === true && hidden.body.case.cleanEvidence === null && hidden.body.case.issues === null && !JSON.stringify(hidden).includes('合成：合并后没有回滚'), hidden);
  const shown = await call('get_review_benchmark_case', { repositoryPath: repository, caseId: dev?.caseId });
  check('a dev case comes back with its labels', shown.body?.case?.labelsWithheld === false && shown.body.case.cleanEvidence === '合成：合并后没有回滚。', shown);

  const unconfirmed = await call('update_review_benchmark_case', { repositoryPath: repository, caseId: dev?.caseId, expectedStatus: 'candidate', status: 'confirmed' });
  check('confirming without the user\'s words is refused', unconfirmed.isError && /userConfirmation/u.test(unconfirmed.text), unconfirmed);
  const confirmed = await call('update_review_benchmark_case', { repositoryPath: repository, caseId: dev?.caseId, expectedStatus: 'candidate', status: 'confirmed', userConfirmation: '合成：核对过了。' });
  check('confirming with the user\'s words is saved', confirmed.body?.status === 'saved' && confirmed.body.case?.status === 'confirmed', confirmed);
  const stale = await call('update_review_benchmark_case', { repositoryPath: repository, caseId: dev?.caseId, expectedStatus: 'candidate', note: '合成：备注。' });
  check('a change against a status no longer there is refused', stale.isError && stale.body?.status === 'status_changed', stale);

  // Kept in the App's own data, one file per repository, not in the vault.
  const stored = await readdir(join(started.env.PARASELF_USER_DATA, 'review-benchmark')).catch(() => []);
  const file = stored.length === 1 ? join(started.env.PARASELF_USER_DATA, 'review-benchmark', stored[0]) : null;
  check('the cases are in one owner-only file in the App\'s data', file !== null && /^[0-9a-f]{64}\.json$/u.test(stored[0]) && ((await stat(file)).mode & 0o777) === 0o600, stored);
  const vaultText = async (directory) => {
    let text = '';
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      text += entry.isDirectory() ? await vaultText(path) : entry.name.endsWith('.md') ? await readFile(path, 'utf8') : '';
    }
    return text;
  };
  check('nothing of the cases is in the vault', !(await vaultText(started.env.PARASELF_VAULT_PATH)).includes('合成'), null);
} catch (error) { runError = error instanceof Error ? error.stack : String(error); }
finally {
  try { mcp.close(); } catch (error) { cleanupErrors.push(String(error)); }
  await started.stop().catch((error) => cleanupErrors.push(String(error)));
}

const failed = checks.filter((item) => !item.ok);
await save(out, 'review-benchmark-run', label, 'result', { build, root, checks, error: runError, cleanupErrors, summary: { passed: checks.length - failed.length, failed: failed.length } });
if (failed.length === 0 && runError === null && cleanupErrors.length === 0) await rm(root, { recursive: true, force: true });
process.exitCode = failed.length === 0 && runError === null && cleanupErrors.length === 0 ? 0 : 1;
