import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { expect, it } from "vitest";
import { reviewPermissionSettings, REVIEW_AGENT_SETTINGS } from "../src/main/local-review-agent.js";
import { resolveReviewTools, reviewToolEnvironment } from "../src/main/local-review-tools.js";
import { ManagedChildProcessRunner } from "../src/main/model/cli/managed-child-process.js";

const candidate = (process.env.PATH ?? "").split(delimiter).map(directory => join(directory, "codex")).find(existsSync);
it.skipIf(process.platform !== "darwin" || !candidate)("runs npm lifecycle children under the native Codex profile without granting HOME or network", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lr-native-npm-")));
  const copy = { directory: root, tree: join(root, "tree"), git: join(root, "git") }, scratch = join(root, "scratch");
  const runner = new ManagedChildProcessRunner(), environment = Object.fromEntries(["HOME", "PATH", "VOLTA_HOME", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  let hits = 0; const server = createServer(socket => { hits++; socket.end(); });
  try {
    for (const path of [copy.tree, copy.git, scratch, join(root, "tool-bin"), join(root, "codex-home")]) await mkdir(path);
    await writeFile(join(root, "private-canary"), "private"); await writeFile(join(copy.git, "config"), "unchanged");
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test port");
    await writeFile(join(copy.tree, "package.json"), JSON.stringify({ name: "native-npm-regression", scripts: { test: "node --test test.cjs" } }));
    await writeFile(join(copy.tree, "test.cjs"), `const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),net=require('node:net');test('npm lifecycle keeps the boundary',async()=>{assert.equal(process.env.HOME,${JSON.stringify(scratch)});assert.throws(()=>fs.readFileSync(${JSON.stringify(join(root, "private-canary"))}));assert.throws(()=>fs.appendFileSync(${JSON.stringify(join(copy.git, "config"))},'bad'));await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:${address.port}});socket.once('connect',()=>{socket.destroy();reject(new Error('network escaped'))});socket.once('error',()=>resolve());});});`);
    const codex = await realpath(candidate!), tools = await resolveReviewTools(root, environment, runner, environment);
    for (const tool of tools) await symlink(tool.executable, join(root, "tool-bin", tool.name));
    expect(tools.some(tool => tool.name === "npm")).toBe(true);
    const settings = [...REVIEW_AGENT_SETTINGS, ...reviewPermissionSettings(copy, codex, true, [codex, ...tools.map(tool => tool.executable)], tools.map(tool => tool.prefix))];
    const result = await runner.run({ executable: codex, args: ["sandbox", "--permission-profile", "lr", "--cd", copy.tree, ...settings.flatMap(value => ["-c", value]), "--", "/usr/bin/env", "-i", ...Object.entries(reviewToolEnvironment(copy, tools.map(tool => dirname(tool.executable)))).map(([key, value]) => `${key}=${value}`), "/bin/zsh", "-lc", "npm test"], environment: { ...environment, CODEX_HOME: join(root, "codex-home") }, cwd: copy.tree, stdin: "", timeoutMs: 30000, maximumStdoutBytes: 100000, maximumStderrBytes: 100000, acceptNonzeroExit: true });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0); expect(result.stdout).toContain("# pass 1"); expect(hits).toBe(0); expect(await readFile(join(copy.git, "config"), "utf8")).toBe("unchanged");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
}, 40000);
