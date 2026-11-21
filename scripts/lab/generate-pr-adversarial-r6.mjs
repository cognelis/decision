#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile as write } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(process.env.PARASELF_LAB_ROOT ?? join(tmpdir(), "decision-lab"), "pr-adversarial-r6"));
const replay = resolve(root, "scripts/replay-pr-review.mjs");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cases = [
  { title: "调整 API 路由的访问控制", label: [], base: {
    "src/route.ts": `import { updateProfile } from "./profile.js";\nexport const patchProfile = (request: Request) => { if (!request.headers.get("authorization")) throw new Error("unauthorized"); return updateProfile(request); };\n`,
    "src/server.ts": `import { patchProfile } from "./route.js";\nimport { requireSession } from "./session.js";\nexport const handle = requireSession(patchProfile);\n`,
    "src/session.ts": `export function requireSession<T>(handler: (request: Request) => T) {\n return (request: Request) => { if (!request.headers.get("authorization")) throw new Error("unauthorized"); return handler(request); };\n}\n`,
    "src/profile.ts": `export const updateProfile = (request: Request) => ({ ok: true, request });\n`,
  }, head: { "src/route.ts": `import { updateProfile } from "./profile.js";\n// Session enforcement is composed by server.ts.\nexport const patchProfile = (request: Request) => updateProfile(request);\n` } },
  { title: "统一 CSV 导入字段校验", label: [], base: {
    "src/import.ts": `import { parseRow } from "./row.js";\nexport const importRow = (raw: string) => { if (raw.length > 10000) throw new Error("oversized"); return parseRow(raw); };\n`,
    "src/job.ts": `import { importRow } from "./import.js";\nimport { validateCsv } from "./validate.js";\nexport const runImport = (raw: string) => importRow(validateCsv(raw));\n`,
    "src/validate.ts": `export function validateCsv(raw: string) { if (raw.length > 10000 || raw.includes("\\0")) throw new Error("invalid CSV"); return raw; }\n`,
    "src/row.ts": `export const parseRow = (raw: string) => raw.split(",");\n`,
  }, head: { "src/import.ts": `import { parseRow } from "./row.js";\n// Input validation happens in the job entrypoint.\nexport const importRow = (raw: string) => parseRow(raw);\n` } },
  { title: "移除缓存读取中的重复租约", label: [], base: {
    "src/read.ts": `export const read = (key: string) => key;\n`,
    "src/cache.ts": `import { read } from "./read.js";\nexport async function withCache(key: string) { const lease = await acquire(key); try { return read(key); } finally { await lease.release(); } }\nasync function acquire(_key: string) { return { release: async () => {} }; }\n`,
    "src/worker.ts": `import { withLease } from "./lease.js";\nexport const refresh = (key: string) => withLease(key);\n`,
    "src/lease.ts": `import { withCache } from "./cache.js";\nexport async function withLease(key: string) { const lease = await acquire(key); try { return await withCache(key); } finally { await lease.release(); } }\nasync function acquire(_key: string) { return { release: async () => {} }; }\n`,
  }, head: { "src/cache.ts": `import { read } from "./read.js";\nexport async function withCache(key: string) { return read(key); }\n` } },
  { title: "简化 HTML 提示文本生成", label: [], base: {
    "src/template.ts": `import { escapeHtml } from "./escape.js";\nexport const interpolate = (name: string) => escapeHtml(name);\n`,
    "src/view.ts": `import { interpolate } from "./template.js";\nexport const renderName = (name: string) => "<b>" + interpolate(name) + "</b>";\n`,
    "src/page.ts": `import { renderName } from "./view.js";\nimport { escapeHtml } from "./escape.js";\nexport const page = (name: string) => escapeHtml(renderName(name));\n`,
    "src/escape.ts": `export const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");\n`,
  }, head: { "src/template.ts": `// The page entrypoint applies HTML escaping after rendering.\nexport const interpolate = (name: string) => name;\n` } },
  { title: "修复偏移量分页边界", label: [{ id: "r6-pagination-offset", priority: "P2", evidence: "src/page.ts 将起点加一，第一页遗漏 offset 指向的记录；分页调用方按 0 起始 offset 使用该结果。" }], base: {
    "src/page.ts": `export function page<T>(rows: T[], offset: number, limit: number) { return rows.slice(offset, offset + limit); }\n`,
    "src/list.ts": `import { page } from "./page.js";\nexport const firstPage = <T>(rows: T[], size: number) => page(rows, 0, size);\n`,
    "test/page.ts": `const rows = ["a", "b"]; if (page(rows, 0, 1)[0] !== "a") throw Error("first row lost");\n`,
  }, head: { "src/page.ts": `export function page<T>(rows: T[], offset: number, limit: number) { return rows.slice(offset + 1, offset + limit + 1); }\n` } },
  { title: "避免任务准备失败后遗留租约", label: [{ id: "r6-lease-release", priority: "P1", evidence: "src/job.ts 将 prepare 移出 try/finally。prepare 拒绝时 release 不会运行，持有租约的调用方将无法继续处理该 key。" }], base: {
    "src/job.ts": `export async function run(lease: { release(): Promise<void> }, prepare: () => Promise<void>, work: () => Promise<void>) { try { await prepare(); await work(); } finally { await lease.release(); } }\n`,
    "src/worker.ts": `import { run } from "./job.js";\nexport const dispatch = (lease: { release(): Promise<void> }, prepare: () => Promise<void>) => run(lease, prepare, async () => {});\n`,
  }, head: { "src/job.ts": `export async function run(lease: { release(): Promise<void> }, prepare: () => Promise<void>, work: () => Promise<void>) { await prepare(); try { await work(); } finally { await lease.release(); } }\n` } },
  { title: "规范化压缩包内的输出文件名", label: [{ id: "r6-path-traversal", priority: "P1", evidence: "src/extract.ts 直接将未经检查的 entry 写入 root + entry；../ 可跳出目标目录覆盖任意可写路径。src/importer.ts 把归档条目传入此函数。" }], base: {
    "src/extract.ts": `import { join } from "node:path";\nexport const outputPath = (root: string, entry: string) => join(root, entry.replaceAll("\\\\", "/"));\n`,
    "src/importer.ts": `import { outputPath } from "./extract.js";\nexport const importEntry = (root: string, entry: string) => outputPath(root, entry);\n`,
    "test/path.ts": `if (!outputPath("/safe", "a.txt").startsWith("/safe/")) throw Error("bad path");\n`,
  }, head: { "src/extract.ts": `import { join } from "node:path";\nexport const outputPath = (root: string, entry: string) => join(root, entry);\n` } },
  { title: "更新缓存时保留最新写入", label: [{ id: "r6-stale-cache", priority: "P2", evidence: "src/cache.ts 的 load 只在首次读取时填充 cache；set 更新 values 后未更新/清除 cache，后续 load 返回旧值。" }], base: {
    "src/cache.ts": `export class Cache { values = new Map<string, string>(); cache = new Map<string, string>(); load(k: string) { if (!this.cache.has(k)) this.cache.set(k, this.values.get(k)!); return this.cache.get(k); } set(k: string, v: string) { this.values.set(k, v); this.cache.delete(k); } }\n`,
    "src/store.ts": `import { Cache } from "./cache.js";\nexport const store = new Cache();\nexport const update = (k: string, v: string) => store.set(k, v);\n`,
  }, head: { "src/cache.ts": `export class Cache { values = new Map<string, string>(); cache = new Map<string, string>(); load(k: string) { if (!this.cache.has(k)) this.cache.set(k, this.values.get(k)!); return this.cache.get(k); } set(k: string, v: string) { this.values.set(k, v); } }\n` } },
];

if (cases.length !== 8 || cases.filter((item) => !item.label.length).length < 4) throw new Error("R6 requires eight PRs and at least four counterexamples");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error(`output directory is not empty: ${output}`);
const manifest = [];
for (let index = 0; index < cases.length; index += 1) {
  const item = cases[index], id = `pr-${String(index + 1).padStart(2, "0")}`, repo = resolve(output, id, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main"); git(repo, "config", "user.name", "Synthetic PR Fixture");
  git(repo, "config", "user.email", "synthetic@example.invalid"); git(repo, "config", "core.hooksPath", "/dev/null");
  for (const [path, content] of Object.entries(item.base)) { const target = resolve(repo, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
  git(repo, "add", "-A"); git(repo, "commit", "-m", "synthetic base"); const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", `pr/${id}`);
  for (const [path, content] of Object.entries(item.head)) { const target = resolve(repo, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
  git(repo, "add", "-A"); git(repo, "commit", "-m", "synthetic change"); const head = git(repo, "rev-parse", "HEAD");
  const casePath = resolve(output, id, "case.json");
  execFileSync(process.execPath, [replay, "prepare", "--repository", repo, "--reference", `synthetic/r6-pr-adversarial#${index + 1}`, "--head", head, "--target", base, "--title", item.title, "--output", casePath], { stdio: "inherit" });
  await writeFile(resolve(output, id, "labels.json"), `${JSON.stringify({ issues: item.label }, null, 2)}\n`, { flag: "wx" });
  manifest.push({ id, title: item.title, case: `${id}/case.json`, labels: `${id}/labels.json`, class: item.label.length ? "defect" : "counterexample" });
}
await write(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`已生成 ${cases.length} 个 R6 合成 PR：${output}`);
