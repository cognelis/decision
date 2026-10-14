import { runElectronCheck } from "./support/run-electron-check.js";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_WINDOW_MIN_SIZE,
  DESKTOP_WINDOW_SIZE,
} from "../src/shared/decision-layout.js";
import { DESKTOP_PRIMARY_SURFACES } from "../src/shared/renderer-api.js";

/*
 * This sweep visits eight pages per size, where the per-page checks visit one,
 * and every Electron-driven suite starts a Vite server of its own. A cold
 * transform with all of them running at once starved this one for minutes —
 * the run itself takes about four seconds warm, so the budget below is only
 * ever reached when something is genuinely wrong.
 */
vi.setConfig({ testTimeout: 360_000 });

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const scriptPath = new URL(
  "../../../scripts/check-surface-overflow.cjs",
  import.meta.url,
).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

interface ClippedElement {
  tag: string;
  cls: string;
  overflowBy: number;
  text: string;
}

interface SurfaceMetrics {
  documentOverflowX: number;
  stageOverflowX: number | null;
  clipped: ClippedElement[];
  clippedCount: number;
  cutOff: ClippedElement[];
  cutOffCount: number;
}

interface OverflowReport {
  theme: string;
  sizes: Record<string, Record<string, SurfaceMetrics>>;
}

const sizeKey = (size: { width: number; height: number }): string =>
  `${size.width}x${size.height}`;

/**
 * One process per size, measured once and shared by both tests. A single
 * process cannot do both: resizing an offscreen window leaves the next load
 * hanging, and a second window cannot reach the dev server again.
 */
const report = (() => {
  let pending: Promise<OverflowReport> | null = null;
  const once = (size: { width: number; height: number }) =>
    runElectronCheck(
      electronPath,
      [scriptPath, "light", sizeKey(size)],
      { cwd: repositoryRoot, timeout: 300_000, maxBuffer: 20 * 1024 * 1024 },
    ).then(({ stdout }) => JSON.parse(stdout.trim()) as OverflowReport);
  return (): Promise<OverflowReport> => {
    pending ??= once(DESKTOP_WINDOW_SIZE)
      .then(async (first) => ({
        theme: first.theme,
        sizes: { ...first.sizes, ...(await once(DESKTOP_WINDOW_MIN_SIZE)).sizes },
      }));
    return pending;
  };
})();

/** Named so a failure reads as the page and the text, not as a count. */
const findings = (surfaces: Record<string, SurfaceMetrics>): string[] =>
  Object.entries(surfaces).flatMap(([surface, metrics]) => [
    ...metrics.clipped.map(
      (element) =>
        `${surface}: ${element.cls || element.tag} cuts ${element.overflowBy}px of width from “${element.text}”`,
    ),
    ...metrics.cutOff.map(
      (element) =>
        `${surface}: ${element.cls || element.tag} cuts ${element.overflowBy}px of height from “${element.text}”`,
    ),
  ]);

describe.skipIf(process.platform !== "darwin")("surface overflow", () => {
  it("keeps material selection, source comparison and composer usable at the minimum window size", async () => {
    const { stdout } = await runElectronCheck(electronPath, [scriptPath, "light", sizeKey(DESKTOP_WINDOW_MIN_SIZE)], {
      cwd: repositoryRoot,
      env: { ...process.env, DECISION_ASSISTANT_WORKFLOW: "1" },
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const measured = JSON.parse(stdout) as OverflowReport;
    const surfaces = measured.sizes[sizeKey(DESKTOP_WINDOW_MIN_SIZE)]!;
    expect(findings(surfaces)).toEqual([]);
    expect(surfaces.assistant?.documentOverflowX).toBe(0);
    expect(surfaces.assistant?.stageOverflowX).toBe(0);
  });

  it("finishes measuring even when animation frames stop after navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-overflow-frames-"));
    const preload = join(root, "no-frames.cjs");
    // Intercept after Electron initializes its built-in module, then stop the
    // last page's callbacks. The DOM and native layout remain available.
    await writeFile(preload, `
      if (process.versions.electron) {
        const Module = require("node:module");
        const original = Module._load;
        Module._load = function(name, ...args) {
          const value = original.call(this, name, ...args);
          if (name === "electron" && value.BrowserWindow) {
            Module._load = original;
            const load = value.BrowserWindow.prototype.loadURL;
            value.BrowserWindow.prototype.loadURL = async function(url, ...options) {
              const result = await load.call(this, url, ...options);
              if (url.includes("preview=settings")) {
                await this.webContents.executeJavaScript("window.requestAnimationFrame = () => 0; true");
                process.stderr.write("animation frames blocked for regression\\n");
              }
              return result;
            };
          }
          return value;
        };
      }
    `);
    try {
      const { stdout, stderr } = await runElectronCheck(
        electronPath,
        [scriptPath, "light", sizeKey(DESKTOP_WINDOW_SIZE)],
        {
          cwd: repositoryRoot,
          env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}` },
          timeout: 30_000,
        },
      );
      expect(stderr).toContain("animation frames blocked for regression");
      const measured = JSON.parse(stdout) as OverflowReport;
      expect(measured.sizes[sizeKey(DESKTOP_WINDOW_SIZE)]?.settings?.stageOverflowX).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("covers every primary surface at both window sizes", async () => {
    const measured = await report();

    // A surface this sweep does not visit is a surface it cannot vouch for.
    expect(Object.keys(measured.sizes).sort()).toEqual(
      [sizeKey(DESKTOP_WINDOW_SIZE), sizeKey(DESKTOP_WINDOW_MIN_SIZE)].sort(),
    );
    for (const surfaces of Object.values(measured.sizes)) {
      expect(Object.keys(surfaces).sort()).toEqual(
        [...DESKTOP_PRIMARY_SURFACES].sort(),
      );
    }
  });

  it("reaches every control at both window sizes", async () => {
    const measured = await report();

    // Text cut mid-character, or a box clipping content the page can never
    // scroll to: both hide from the per-page checks, which measure the stage
    // while the clipping happens inside a card.
    for (const [size, surfaces] of Object.entries(measured.sizes)) {
      expect({ size, findings: findings(surfaces) }).toEqual({
        size,
        findings: [],
      });
      for (const [surface, metrics] of Object.entries(surfaces)) {
        expect({ size, surface, overflow: metrics.documentOverflowX }).toEqual({
          size,
          surface,
          overflow: 0,
        });
        expect({ size, surface, overflow: metrics.stageOverflowX }).toEqual({
          size,
          surface,
          overflow: 0,
        });
      }
    }
  });
});
