#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const testFile = process.argv[2] ?? 'apps/desktop/test/r12-sk-def-behavior.test.ts';

assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Use Volta Node 22');
const env = { ...process.env, CI: '1' };
for (const key of Object.keys(env)) {
  if (/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key) || key === 'PARASELF_PROVIDER_CHILD' || key === 'DECISION_PROVIDER_CHILD') delete env[key];
}
assert.equal(Object.keys(env).some((key) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key)), false, 'Credential variables must be filtered');

const directory = await mkdtemp(resolve(tmpdir(), 'r12-default-local-'));
const outputPath = resolve(directory, 'vitest.json');
try {
  const run = spawnSync(process.execPath, [
    'node_modules/vitest/vitest.mjs', 'run', testFile,
    '--reporter=json', `--outputFile=${outputPath}`,
  ], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  if (run.error) throw run.error;
  const report = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(run.status, 0, run.stderr || run.stdout || `Vitest exit ${run.status}`);
  assert.equal(report.numFailedTests, 0, 'The focused fallback suite must have no failures');
  assert.ok(report.numPassedTests >= 11, 'The independent behavior suite must exercise all 11 probes');
  process.stdout.write(`R12 default-local fallback probe passed: ${report.numPassedTests} behavior tests\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
