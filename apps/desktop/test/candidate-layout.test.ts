import { runElectronCheck } from "./support/run-electron-check.js";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// Each measurement drives a real Electron process with a 30s budget of its own; the test has to outlast it.
vi.setConfig({ testTimeout: 90_000 });

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const scriptPath = new URL("../../../scripts/check-candidate-layout.cjs", import.meta.url).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

interface CandidateMetrics {
  viewportHeight: number;
  headingText: string;
  headingLineHeight: number;
  headingHeight: number;
  headingBottom: number;
  fullQuestionItems: number;
  actionTops: number[];
  laterInHeader: boolean;
  laterBottom: number;
  recordTop: number;
  recordBottom: number;
  dismissBottom: number;
}

const measure = async (theme: "light" | "dark"): Promise<CandidateMetrics> =>
  runElectronCheck(electronPath, [scriptPath, theme], { cwd: repositoryRoot, timeout: 30_000 })
    .then(({ stdout }) => JSON.parse(stdout) as CandidateMetrics);

describe.skipIf(process.platform !== "darwin")("candidate review layout (IMP-141, IMP-143, IMP-144)", () => {
  /*
   * As the page's title, a question of a thousand characters pushed 记录并补充理由 and 忽略 out of the minimum window;
   * capped, an assistant's whole message stood there as lines of large bold text. The header is the page's name now,
   * the question the card's, and 稍后 left the header for the bar the other two are in.
   */
  it.each(["light", "dark"] as const)(
    "titles the page by its name, gives a long question whole in the card, and keeps all three actions in one bar in the minimum window (%s)",
    async (theme) => {
      const metrics = await measure(theme);

      expect(metrics.headingText).toBe("待处理");
      expect(metrics.headingHeight).toBeLessThanOrEqual(Math.ceil(metrics.headingLineHeight) + 1);
      expect(metrics.fullQuestionItems).toBe(3);
      expect(metrics.laterInHeader).toBe(false);
      expect(new Set(metrics.actionTops).size).toBe(1);
      expect(metrics.laterBottom).toBeLessThanOrEqual(metrics.viewportHeight);
      expect(metrics.recordTop).toBeGreaterThan(metrics.headingBottom);
      expect(metrics.recordBottom).toBeLessThanOrEqual(metrics.viewportHeight);
      expect(metrics.dismissBottom).toBeLessThanOrEqual(metrics.viewportHeight);
    },
  );
});
