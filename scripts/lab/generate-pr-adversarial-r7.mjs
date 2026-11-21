#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(process.env.PARASELF_LAB_ROOT ?? join(tmpdir(), "decision-lab"), "pr-adversarial-r7"));
const replay = resolve(root, "scripts/replay-pr-review.mjs");
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const cases = [
  { title: "精简权限检查入口", changed: "src/route.ts", symbol: "handleUpdate", type: "counterexample", protect: "src/server.ts", search: "handleUpdate", issue: null,
    base: { "src/route.ts": `export function handleUpdate(user: string, body: string, role: string) { if (role !== "admin") throw Error("forbidden"); return save(user, body); }\nfunction save(user: string, body: string) { return { user, body }; }\n`, "src/server.ts": `import { handleUpdate } from "./route.js";\nexport const request = (user: string, body: string, role: string) => { if (role !== "admin") throw Error("forbidden"); return handleUpdate(user, body, role); };\n` },
    head: `export function handleUpdate(user: string, body: string) { return save(user, body); }\nfunction save(user: string, body: string) { return { user, body }; }\n` },
  { title: "移除重复上传体积校验", changed: "src/store.ts", symbol: "storeUpload", type: "counterexample", protect: "src/upload.ts", search: "storeUpload", issue: null,
    base: { "src/store.ts": `export function storeUpload(data: Uint8Array) { if (data.length > 1_000_000) throw Error("too large"); return data.length; }\n`, "src/upload.ts": `import { storeUpload } from "./store.js";\nexport function upload(data: Uint8Array) { if (data.length > 1_000_000) throw Error("too large"); return storeUpload(data); }\n` },
    head: `export function storeUpload(data: Uint8Array) { return data.length; }\n` },
  { title: "简化事务写入函数", changed: "src/write.ts", symbol: "writeRecord", type: "counterexample", protect: "src/transaction.ts", search: "writeRecord", issue: null,
    base: { "src/write.ts": `export async function writeRecord(db: DB, value: string) { await db.begin(); try { await db.write(value); await db.commit(); } catch (error) { await db.rollback(); throw error; } }\nexport type DB = { begin(): Promise<void>; write(value: string): Promise<void>; commit(): Promise<void>; rollback(): Promise<void> };\n`, "src/transaction.ts": `import { writeRecord, type DB } from "./write.js";\nexport async function update(db: DB, value: string) { await db.begin(); try { await writeRecord(db, value); await db.commit(); } catch (error) { await db.rollback(); throw error; } }\n` },
    head: `export async function writeRecord(db: DB, value: string) { await db.write(value); }\nexport type DB = { write(value: string): Promise<void> };\n` },
  { title: "移除渲染器中的重复转义", changed: "src/render.ts", symbol: "renderLabel", type: "counterexample", protect: "src/page.ts", search: "renderLabel", issue: null,
    base: { "src/render.ts": `export const renderLabel = (label: string) => label.replaceAll("&", "&amp;").replaceAll("<", "&lt;");\n`, "src/page.ts": `import { renderLabel } from "./render.js";\nexport const page = (label: string) => renderLabel(label).replaceAll("&", "&amp;");\n` },
    head: `export const renderLabel = (label: string) => label;\n` },
  { title: "避免缺失标题导致崩溃", changed: "src/title.ts", symbol: "formatTitle", type: "defect", protect: "src/caller.ts", search: "formatTitle", issue: { id: "nullable-title-crash", priority: "P1", evidence: "src/caller.ts 的 renderCard 将可缺失的 record.title 原样传入 formatTitle；formatTitle 对 null 调用 trim() 会抛错。" },
    base: { "src/title.ts": `export const formatTitle = (title: string | null) => title?.trim() ?? "";\n`, "src/caller.ts": `import { formatTitle } from "./title.js";\nexport const renderCard = (record: { title: string | null }) => formatTitle(record.title);\n` },
    head: `export const formatTitle = (title: string | null) => title!.trim();\n` },
  { title: "保证并发扣减不超额", changed: "src/balance.ts", symbol: "debit", type: "defect", protect: "src/checkout.ts", search: "debit", issue: { id: "concurrent-balance-overdraw", priority: "P1", evidence: "src/checkout.ts 可并发调用 debit；检查余额与写回之间没有锁或原子条件更新，两次扣减都可能通过同一余额检查。" },
    base: { "src/balance.ts": `let balance = 10;\nexport async function debit(amount: number, pause: () => Promise<void>) { if (balance < amount) throw Error("insufficient"); balance -= amount; await pause(); return balance; }\n`, "src/checkout.ts": `import { debit } from "./balance.js";\nexport const checkout = (amount: number, pause: () => Promise<void>) => debit(amount, pause);\n` },
    head: `let balance = 10;\nexport async function debit(amount: number, pause: () => Promise<void>) { if (balance < amount) throw Error("insufficient"); await pause(); balance -= amount; return balance; }\n` },
  { title: "修正分页游标起点", changed: "src/page.ts", symbol: "pageAfter", type: "defect", protect: "src/feed.ts", search: "pageAfter", issue: { id: "cursor-first-item-skipped", priority: "P2", evidence: "src/feed.ts 以 lastSeenIndex 作为 exclusive cursor 调用 pageAfter，但实现又加一，导致游标后的第一项被跳过。" },
    base: { "src/page.ts": `export function pageAfter<T>(items: T[], cursor: number, size: number) { return items.slice(cursor + 1, cursor + size + 1); }\n`, "src/feed.ts": `import { pageAfter } from "./page.js";\nexport const nextFeed = <T>(items: T[], lastSeenIndex: number) => pageAfter(items, lastSeenIndex, 20);\n` },
    head: `export function pageAfter<T>(items: T[], cursor: number, size: number) { return items.slice(cursor + 2, cursor + size + 2); }\n` },
  { title: "释放准备失败时占用的锁", changed: "src/job.ts", symbol: "runJob", type: "defect", protect: "src/worker.ts", search: "runJob", issue: { id: "prepare-rejection-lock-leak", priority: "P1", evidence: "src/worker.ts 将可能 reject 的 prepare 传给 runJob；head 在 try/finally 外 await prepare()，失败时 release 不执行。" },
    base: { "src/job.ts": `export async function runJob(lock: { release(): Promise<void> }, prepare: () => Promise<void>) { try { await prepare(); } finally { await lock.release(); } }\n`, "src/worker.ts": `import { runJob } from "./job.js";\nexport const dispatch = (lock: { release(): Promise<void> }, prepare: () => Promise<void>) => runJob(lock, prepare);\n` },
    head: `export async function runJob(lock: { release(): Promise<void> }, prepare: () => Promise<void>) { await prepare(); try {} finally { await lock.release(); } }\n` },
];
if (cases.length !== 8 || cases.filter((c) => c.type === "counterexample").length < 4) throw new Error("R7 requires eight PRs and at least four counterexamples");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error(`output directory is not empty: ${output}`);
const manifest = [];
for (const [index, item] of cases.entries()) {
  const id = `pr-${String(index + 1).padStart(2, "0")}`, repo = resolve(output, id, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main"); git(repo, "config", "user.name", "Synthetic PR Fixture"); git(repo, "config", "user.email", "synthetic@example.invalid"); git(repo, "config", "core.hooksPath", "/dev/null");
  for (const [path, content] of Object.entries(item.base)) { const target = resolve(repo, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); }
  git(repo, "add", "-A"); git(repo, "commit", "-m", "synthetic base"); const base = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-b", `pr/${id}`); await writeFile(resolve(repo, item.changed), item.head);
  git(repo, "add", "-A"); git(repo, "commit", "-m", "synthetic change"); const head = git(repo, "rev-parse", "HEAD");
  const casePath = resolve(output, id, "case.json");
  execFileSync(process.execPath, [replay, "prepare", "--repository", repo, "--reference", `synthetic/r7-pr-adversarial#${index + 1}`, "--head", head, "--target", base, "--title", item.title, "--output", casePath], { stdio: "inherit" });
  await writeFile(resolve(output, id, "labels.json"), `${JSON.stringify({ issues: item.issue ? [item.issue] : [], classification: item.type, evidenceFile: item.protect, searchSymbol: item.symbol }, null, 2)}\n`, { flag: "wx" });
  manifest.push({ id, title: item.title, case: `${id}/case.json`, labels: `${id}/labels.json`, class: item.type, evidenceFile: item.protect, searchSymbol: item.symbol });
}
await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`已生成 ${cases.length} 个 R7 合成 PR：${output}`);
