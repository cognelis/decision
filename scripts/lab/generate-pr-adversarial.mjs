#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputRoot = resolve(process.argv[2] ?? join(process.env.PARASELF_LAB_ROOT ?? join(tmpdir(), "decision-lab"), "pr-adversarial"));
const replayScript = resolve(projectRoot, "scripts/replay-pr-review.mjs");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const put = async (cwd, files) => {
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(cwd, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "w" });
  }
};

const cases = [
  {
    title: "整理名称格式化实现",
    base: {
      "src/slug.ts": `export function normalizeLabel(input: string): string {\n  const normalized = input.trim().toLowerCase();\n  return normalized.replace(/\\s+/g, "-");\n}\n`,
      "test/slug.test.ts": `import { strict as assert } from "node:assert";\nimport { normalizeLabel } from "../src/slug.js";\nassert.equal(normalizeLabel(" Hello World "), "hello-world");\n`,
    },
    head: {
      "src/slug.ts": `export function normalizeLabel(label: string): string {\n  const slug = label.trim().toLowerCase();\n  return slug.replace(/\\s+/g, "-");\n}\n`,
    },
    issues: [],
  },
  {
    title: "调整请求时限配置",
    base: {
      "src/request.ts": `export const DEFAULT_TIMEOUT_MS = 5_000;\nexport function timeoutFor(override?: number): number {\n  return override ?? DEFAULT_TIMEOUT_MS;\n}\n`,
      "test/request.test.ts": `import { strict as assert } from "node:assert";\nimport { DEFAULT_TIMEOUT_MS, timeoutFor } from "../src/request.js";\nassert.equal(DEFAULT_TIMEOUT_MS, 5_000);\nassert.equal(timeoutFor(2_000), 2_000);\n`,
    },
    head: {
      "src/request.ts": `// Intentional: the upstream service raised its documented request budget.\nexport const DEFAULT_TIMEOUT_MS = 8_000;\nexport function timeoutFor(override?: number): number {\n  return override ?? DEFAULT_TIMEOUT_MS;\n}\n`,
      "test/request.test.ts": `import { strict as assert } from "node:assert";\nimport { DEFAULT_TIMEOUT_MS, timeoutFor } from "../src/request.js";\nassert.equal(DEFAULT_TIMEOUT_MS, 8_000);\nassert.equal(timeoutFor(2_000), 2_000);\nassert.equal(timeoutFor(), 8_000);\n`,
    },
    issues: [],
  },
  {
    title: "为可选设置提供回退",
    base: {
      "src/settings.ts": `export const DEFAULTS = { color: "blue" };\nexport function loadSettings(read: () => { color: string }) {\n  return read();\n}\n`,
      "test/settings.test.ts": `import { strict as assert } from "node:assert";\nimport { loadSettings } from "../src/settings.js";\nassert.deepEqual(loadSettings(() => ({ color: "red" })), { color: "red" });\n`,
    },
    head: {
      "src/settings.ts": `export const DEFAULTS = { color: "blue" };\nexport function loadSettings(read: () => { color: string }, warn: (message: string) => void) {\n  try {\n    return read();\n  } catch {\n    // Optional user settings may be malformed; retain defaults and leave a diagnostic.\n    warn("Settings could not be loaded; using defaults.");\n    return DEFAULTS;\n  }\n}\n`,
      "test/settings.test.ts": `import { strict as assert } from "node:assert";\nimport { DEFAULTS, loadSettings } from "../src/settings.js";\nassert.deepEqual(loadSettings(() => ({ color: "red" }), () => {}), { color: "red" });\nlet warned = false;\nassert.deepEqual(loadSettings(() => { throw new Error("bad optional file"); }, () => { warned = true; }), DEFAULTS);\nassert.equal(warned, true);\n`,
    },
    issues: [],
  },
  {
    title: "统一记录加载接口",
    base: {
      "src/records.ts": `export type RecordItem = { id: string };\nexport async function getRecord(id: string): Promise<RecordItem> {\n  return { id };\n}\n`,
      "src/route.ts": `import { getRecord } from "./records.js";\nexport const routeRecord = (id: string) => getRecord(id);\n`,
      "src/worker.ts": `import { getRecord } from "./records.js";\nexport const workerRecord = (id: string) => getRecord(id);\n`,
      "test/records.test.ts": `import { strict as assert } from "node:assert";\nimport { routeRecord } from "../src/route.js";\nimport { workerRecord } from "../src/worker.js";\nassert.equal((await routeRecord("r1")).id, "r1");\nassert.equal((await workerRecord("r2")).id, "r2");\n`,
    },
    head: {
      "src/records.ts": `export type RecordItem = { id: string };\nexport type LoadOptions = { includeArchived?: boolean };\nexport async function loadRecord(id: string, _options: LoadOptions = {}): Promise<RecordItem> {\n  return { id };\n}\n`,
      "src/route.ts": `import { loadRecord } from "./records.js";\nexport const routeRecord = (id: string) => loadRecord(id, { includeArchived: true });\n`,
      "src/worker.ts": `import { loadRecord } from "./records.js";\nexport const workerRecord = (id: string) => loadRecord(id);\n`,
      "test/records.test.ts": `import { strict as assert } from "node:assert";\nimport { routeRecord } from "../src/route.js";\nimport { workerRecord } from "../src/worker.js";\nassert.equal((await routeRecord("r1")).id, "r1");\nassert.equal((await workerRecord("r2")).id, "r2");\n`,
    },
    issues: [],
  },
  {
    title: "缓存记录读取",
    base: {
      "src/store.ts": `export class Store {\n  private readonly values = new Map<string, string>();\n  get(key: string) { return this.values.get(key); }\n  put(key: string, value: string) { this.values.set(key, value); }\n  delete(key: string) { this.values.delete(key); }\n}\n`,
      "test/store.test.ts": `import { strict as assert } from "node:assert";\nimport { Store } from "../src/store.js";\nconst store = new Store();\nstore.put("k", "old");\nassert.equal(store.get("k"), "old");\n`,
    },
    head: {
      "src/store.ts": `export class Store {\n  private readonly values = new Map<string, string>();\n  private readonly cache = new Map<string, string | undefined>();\n  get(key: string) {\n    if (!this.cache.has(key)) this.cache.set(key, this.values.get(key));\n    return this.cache.get(key);\n  }\n  put(key: string, value: string) { this.values.set(key, value); this.cache.delete(key); }\n  delete(key: string) { this.values.delete(key); this.cache.delete(key); }\n}\n`,
      "test/store.test.ts": `import { strict as assert } from "node:assert";\nimport { Store } from "../src/store.js";\nconst store = new Store();\nstore.put("k", "old");\nassert.equal(store.get("k"), "old");\nstore.put("k", "new");\nassert.equal(store.get("k"), "new");\nstore.delete("k");\nassert.equal(store.get("k"), undefined);\n`,
    },
    issues: [],
  },
  {
    title: "加强用户展示名防护",
    base: {
      "src/user.ts": `export type User = { name: string };\nexport function displayName(user: User): string {\n  return user.name.toUpperCase();\n}\n`,
      "test/user.test.ts": `import { strict as assert } from "node:assert";\nimport { displayName } from "../src/user.js";\nassert.equal(displayName({ name: "lee" }), "LEE");\n`,
    },
    head: {
      "src/user.ts": `export type User = { name: string | null };\nexport function displayName(user: User | null): string {\n  if (user == null || user.name == null) return "";\n  return user.name.toUpperCase();\n}\n`,
      "test/user.test.ts": `import { strict as assert } from "node:assert";\nimport { displayName } from "../src/user.js";\nassert.equal(displayName({ name: "lee" }), "LEE");\nassert.equal(displayName({ name: null }), "");\nassert.equal(displayName(null), "");\n`,
    },
    issues: [],
  },
  {
    title: "整理分页返回区间",
    base: {
      "src/page.ts": `export function page<T>(items: T[], offset: number, limit: number): T[] {\n  return items.slice(offset, offset + limit);\n}\n`,
      "test/page.test.ts": `import { strict as assert } from "node:assert";\nimport { page } from "../src/page.js";\nassert.deepEqual(page(["a", "b", "c"], 0, 2), ["a", "b"]);\nassert.deepEqual(page(["a", "b", "c"], 2, 2), ["c"]);\n`,
    },
    head: {
      "src/page.ts": `export function page<T>(items: T[], offset: number, limit: number): T[] {\n  return items.slice(offset + 1, offset + limit + 1);\n}\n`,
      "test/page.test.ts": `import { strict as assert } from "node:assert";\nimport { page } from "../src/page.js";\nassert.deepEqual(page(["a", "b", "c"], 0, 2), ["b", "c"]);\nassert.deepEqual(page(["a", "b", "c"], 2, 2), []);\n`,
    },
    issues: [{ id: "pagination-skips-first-item", priority: "P2", evidence: "head 将 slice 起点从 offset 改为 offset + 1，第一页丢失首项，后续页边界也少返回记录。" }],
  },
  {
    title: "调整写入准备步骤",
    base: {
      "src/writer.ts": `export type Lease = { release(): Promise<void> };\nexport async function writeWithLease(lease: Lease, prepare: () => Promise<void>, write: () => Promise<void>) {\n  try {\n    await prepare();\n    await write();\n  } finally {\n    await lease.release();\n  }\n}\n`,
      "test/writer.test.ts": `import { strict as assert } from "node:assert";\nimport { writeWithLease } from "../src/writer.js";\nlet released = false;\nawait assert.rejects(writeWithLease({ release: async () => { released = true; } }, async () => { throw new Error("prepare failed"); }, async () => {}));\nassert.equal(released, true);\n`,
    },
    head: {
      "src/writer.ts": `export type Lease = { release(): Promise<void> };\nexport async function writeWithLease(lease: Lease, prepare: () => Promise<void>, write: () => Promise<void>) {\n  await prepare();\n  try {\n    await write();\n  } finally {\n    await lease.release();\n  }\n}\n`,
      "test/writer.test.ts": `import { strict as assert } from "node:assert";\nimport { writeWithLease } from "../src/writer.js";\nlet released = false;\nawait assert.rejects(writeWithLease({ release: async () => { released = true; } }, async () => { throw new Error("prepare failed"); }, async () => {}));\nassert.equal(released, true);\n`,
    },
    issues: [{ id: "prepare-failure-leaks-lease", priority: "P2", evidence: "head 将 prepare() 移到 try/finally 之前；prepare 拒绝时 lease.release() 永不执行，资源锁泄漏。" }],
  },
];

if (cases.length !== 8) throw new Error("expected exactly eight synthetic PRs");
await mkdir(outputRoot, { recursive: true });
if ((await readdir(outputRoot)).length) throw new Error(`output directory is not empty: ${outputRoot}`);
for (let index = 0; index < cases.length; index += 1) {
  const sample = cases[index];
  const id = String(index + 1).padStart(2, "0");
  const caseRoot = resolve(outputRoot, `pr-${id}`);
  const repo = resolve(caseRoot, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Synthetic PR Fixture");
  git(repo, "config", "user.email", "synthetic@example.invalid");
  git(repo, "config", "core.hooksPath", "/dev/null");
  await put(repo, sample.base);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "synthetic base");
  const target = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", `pr/${id}`);
  await put(repo, sample.head);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "synthetic change");
  const head = git(repo, "rev-parse", "HEAD");
  const reference = `synthetic/r4-pr-adversarial#${index + 1}`;
  execFileSync(process.execPath, [replayScript, "prepare", "--repository", repo, "--reference", reference,
    "--head", head, "--target", target, "--title", sample.title, "--output", resolve(caseRoot, "case.json")], { stdio: "inherit" });
  await writeFile(resolve(caseRoot, "labels.json"), `${JSON.stringify({ issues: sample.issues }, null, 2)}\n`, { flag: "wx" });
  console.log(`完成 ${reference}: ${sample.issues.length} 个缺陷标签`);
}
console.log(`8 个合成 PR 已生成于 ${outputRoot}`);
