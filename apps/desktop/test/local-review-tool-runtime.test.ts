import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewCommandSandbox } from "../src/main/local-review-command-sandbox.js";
import { ReviewToolLibraries } from "../src/main/local-review-tool-libraries.js";
import { ReviewLaunchdLabels } from "../src/main/local-review-launchd.js";
import { resolveReviewTools, reviewToolReadPaths } from "../src/main/local-review-tools.js";
import { ManagedChildProcessRunner } from "../src/main/model/cli/managed-child-process.js";
vi.mock("../src/main/login-shell-path.js", () => ({ loginShellPath: async (environment: NodeJS.ProcessEnv) => environment.PATH ?? "" }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lr-tool-runtime-"))); roots.push(root);
  const copy = { directory: join(root, "run/copy"), tree: join(root, "run/copy/tree"), git: join(root, "run/copy/git") }, home = join(root, "home");
  for (const path of [copy.tree, copy.git, home]) await mkdir(path, { recursive: true });
  await writeFile(join(home, "canary"), "PRIVATE_HOME");
  vi.spyOn(ReviewLaunchdLabels.prototype, "snapshot").mockResolvedValue([]);
  return { root, copy, home };
}
it.skipIf(process.platform !== "darwin" || !existsSync("/opt/homebrew/bin/node"))("runs Homebrew Node tests and npm ci with a narrow library closure", async () => {
  const f = await fixture(), env = { HOME: f.home, PATH: "/opt/homebrew/bin:/usr/bin:/bin" }, runner = new ManagedChildProcessRunner();
  const tools = await resolveReviewTools(f.copy.directory, env, runner, env);
  const node = tools.find(tool => tool.name === "node")!; expect(node.executable).toMatch(/^\/opt\/homebrew\/Cellar\/node\//u);
  expect(node.libraries!.directories.length).toBeGreaterThan(0);
  expect(node.libraries!.links).toContain("/opt/homebrew/opt/llhttp");
  const reads = reviewToolReadPaths(tools);
  for (const root of ["/opt/homebrew", "/opt/homebrew/opt", "/opt/homebrew/Cellar", f.home]) expect(reads).not.toContain(root);
  let other: string | undefined;
  for (const pkg of await readdir("/opt/homebrew/Cellar")) {
    const path = join("/opt/homebrew/Cellar", pkg);
    if (reads.some(read => read === path || read.startsWith(path + "/"))) continue;
    for (const version of await readdir(path)) { const file = join(path, version, "INSTALL_RECEIPT.json"); if (existsSync(file)) { other = file; break; } }
    if (other) break;
  }
  expect(other).toBeTruthy();
  const sandbox = new ReviewCommandSandbox(env, { root: join(f.root, "run") }); await sandbox.probe(f.copy); expect(sandbox.available, sandbox.reason ?? "").toBe(true);
  expect((await sandbox.run(["node", "--version"])).stdout).toMatch(/^v\d+/u);
  await writeFile(join(f.copy.tree, "test.cjs"), "require('node:test').test('works',()=>require('node:assert/strict').equal(2+2,4));");
  expect((await sandbox.run(["node", "--test", "--test-reporter=tap", "test.cjs"])).stdout).toContain("# pass 1");
  await mkdir(join(f.copy.tree, "vendor/demo"), { recursive: true });
  await writeFile(join(f.copy.tree, "vendor/demo/package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  await writeFile(join(f.copy.tree, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", dependencies: { demo: "file:vendor/demo" }, scripts: { test: "node --test test.cjs" } }));
  await writeFile(join(f.copy.tree, ".npmrc"), "install-links=true\naudit=false\nfund=false\n");
  await writeFile(join(f.copy.tree, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: { demo: "file:vendor/demo" } }, "node_modules/demo": { version: "1.0.0", resolved: "file:vendor/demo" } } }));
  const installed = await sandbox.run(["npm", "ci"]); expect(installed.exitCode, installed.stdout + installed.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(f.copy.tree, "node_modules/demo/package.json"), "utf8")).name).toBe("demo");
  const negative = await sandbox.run(["node", "-e", `const fs=require('node:fs');for(const action of [()=>fs.readFileSync(${JSON.stringify(join(f.home, "canary"))}),()=>fs.readFileSync(${JSON.stringify(other)}),()=>fs.readdirSync('/opt/homebrew')]){try{action();process.exit(9)}catch(error){if(!['EPERM','EACCES'].includes(error.code))throw error}}console.log('ALL_DENIED');`]);
  expect(negative.exitCode, negative.stderr).toBe(0); expect(negative.stdout).toContain("ALL_DENIED");

}, 40000);
it.skipIf(process.platform !== "darwin")("keeps the selected Volta Node version without a Homebrew fallback", async () => {
  const f = await fixture(), env = { ...process.env, PATH: dirname(process.execPath) + ":/usr/bin:/bin" };
  const sandbox = new ReviewCommandSandbox(env); await sandbox.probe(f.copy); expect(sandbox.available, sandbox.reason ?? "").toBe(true);
  const result = await sandbox.run(["node", "-p", "JSON.stringify([process.execPath,process.versions.node])"]);
  expect(result.exitCode, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual([process.execPath, process.versions.node]);
});
it.skipIf(process.platform !== "darwin")("disables a tool on library resolution failure and retains the reason", async () => {
  const f = await fixture(), env = { ...process.env, PATH: dirname(process.execPath) + ":/usr/bin:/bin" };
  vi.spyOn(ReviewToolLibraries.prototype, "resolve").mockRejectedValue(new Error("动态库闭包超过 200 个镜像。"));
  const sandbox = new ReviewCommandSandbox(env); await sandbox.probe(f.copy);
  expect(sandbox.available).toBe(false); expect(sandbox.reason).toContain("200"); await expect(sandbox.run(["node", "--version"])).rejects.toThrow("200");
});
