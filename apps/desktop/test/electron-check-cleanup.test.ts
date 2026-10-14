import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runElectronCheck } from "./support/run-electron-check.js";

const electron = createRequire(import.meta.url)("electron") as string;
const root = new URL("../../../", import.meta.url).pathname;
const lifecycle = join(root, "scripts/electron-check-lifecycle.cjs");
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const fixture = async (body: string) => {
  const directory = await mkdtemp(join(tmpdir(), "decision-electron-cleanup-")); directories.push(directory);
  const path = join(directory, "probe.cjs");
  await writeFile(path, `const { app, BrowserWindow } = require("electron");
    const { writeFileSync } = require("node:fs");
    let window;
    const close = require(${JSON.stringify(lifecycle)}).createElectronCheckLifecycle({ app, getWindow: () => window, getServer: () => ({ close: () => new Promise(() => {}) }) });
    app.whenReady().then(async () => {
      window = new BrowserWindow({ show: false });
      await window.loadURL('data:text/html,<p>cleanup regression</p>');
      writeFileSync(${JSON.stringify(join(directory, "pids.json"))}, JSON.stringify({ root: process.pid, renderer: window.webContents.getOSProcessId() }));
      ${body}
    });`);
  return { directory, path };
};
const assertGone = async (directory: string) => {
  const pids = JSON.parse(await readFile(join(directory, "pids.json"), "utf8")) as { root: number; renderer: number };
  expect(pids.renderer).toBeGreaterThan(0);
  for (const pid of Object.values(pids)) {
    let live = true;
    for (let attempt = 0; attempt < 20 && live; attempt++) {
      // A killed child may briefly await reaping as a zombie, which is no longer running.
      try { const state = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); live = state.length > 0 && !state.startsWith("Z"); }
      catch { live = false; }
      if (live) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(live, `test process ${pid} is still running`).toBe(false);
  }
};

describe.skipIf(process.platform !== "darwin")("real Electron process cleanup", () => {
  it("bounds a stuck server shutdown and exits Electron", async () => {
    const probe = await fixture("void close(0);");
    const started = Date.now();
    await expect(runElectronCheck(electron, [probe.path], { cwd: root, timeout: 8000 })).rejects.toMatchObject({ code: "process_failed", processExitCode: 1, diagnosticExcerpt: expect.stringContaining("cleanup timed out") });
    expect(Date.now() - started).toBeLessThan(7000);
    await assertGone(probe.directory);
  });

  it("kills Electron and its renderer when the main event loop cannot handle termination", async () => {
    const probe = await fixture("while (true) {}");
    await expect(runElectronCheck(electron, [probe.path], { cwd: root, timeout: 3000 })).rejects.toMatchObject({ code: "timeout" });
    await assertGone(probe.directory);
  });

  it("exits after its test parent disappears, even if server cleanup hangs", async () => {
    const probe = await fixture("setInterval(() => {}, 1000);");
    const parent = join(probe.directory, "parent.cjs");
    await writeFile(parent, `const { spawn } = require("node:child_process");
      const { existsSync } = require("node:fs");
      spawn(${JSON.stringify(electron)}, [${JSON.stringify(probe.path)}], { stdio: ['ignore', 1, 2] });
      const wait = setInterval(() => { if (existsSync(${JSON.stringify(join(probe.directory, "pids.json"))})) { clearInterval(wait); process.exit(0); } }, 20);`);
    const started = Date.now();
    const result = await runElectronCheck(process.execPath, [parent], { cwd: root, timeout: 8000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("cleanup timed out");
    expect(Date.now() - started).toBeLessThan(7000);
    await assertGone(probe.directory);
  });
});
