import { runElectronCheck } from "./support/run-electron-check.js";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import { DESKTOP_WINDOW_SIZE } from "../src/shared/decision-layout.js";


/*
 * Each measurement drives a real Electron process with a 30s budget of its own.
 * The suite-wide 20s test timeout is shorter than that, so vitest always won
 * the race: under load these died with "Test timed out in 20000ms" — a message
 * about the harness, never about the layout — instead of letting the
 * subprocess report what actually went wrong. A test timeout has to outlast
 * the budget it is waiting on.
 */
vi.setConfig({ testTimeout: 90_000 });

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const scriptPath = new URL(
  "../../../scripts/check-rationale-layout.cjs",
  import.meta.url,
).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

type Theme = "light" | "dark";
type Interaction =
  | "default"
  | "expanded"
  | "hover"
  | "no-record"
  | "alternatives-expanded";

interface RationaleMetrics {
  actionsBottom: number;
  actionsHeight: number;
  answerFontSize: number;
  answerSummaryFitsWidth: boolean;
  answerSummaryVisible: boolean;
  alternativeOptionCount: number;
  alternativesVisible: boolean;
  appClientHeight: number;
  appScrollHeight: number;
  backdropFilter: string;
  cardBottom: number;
  contextDialogCentered: boolean;
  contextDialogOpen: boolean;
  contextInsideDialog: boolean;
  discardDisabled: boolean;
  discardLabel: string;
  inlineContextExpanded: boolean;
  interaction: Interaction;
  navigationLabels: string[];
  principleOptionCount: number;
  principleOptionsSingleRow: boolean;
  principleSectionInsideCard: boolean;
  sidebarWidth: number;
  stageWidth: number;
  textareaBottom: number | null;
  toggleBackground: string;
  tokens: { surface: string; window: string };
  viewportHeight: number;
  viewportWidth: number;
  workspaceClientHeight: number;
  workspaceOverflowY: string;
  workspaceScrollHeight: number;
  workspaceScrollTop: number;
}

const cache = new Map<string, Promise<RationaleMetrics>>();
const measureRationale = (
  theme: Theme,
  interaction: Interaction = "default",
): Promise<RationaleMetrics> => {
  const key = `${theme}:${interaction}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = runElectronCheck(electronPath, [scriptPath, theme, interaction], {
    cwd: repositoryRoot,
    timeout: 30_000,
  }).then(({ stdout }) => JSON.parse(stdout) as RationaleMetrics);
  cache.set(key, result);
  return result;
};

describe.skipIf(process.platform !== "darwin")(
  "desktop rationale layout",
  () => {
    it.each(["light", "dark"] as const)(
      "keeps the complete task in the stable %s desktop canvas",
      async (theme) => {
        const metrics = await measureRationale(theme);

        expect(metrics).toMatchObject({
          viewportWidth: DESKTOP_WINDOW_SIZE.width,
          viewportHeight: DESKTOP_WINDOW_SIZE.height,
          sidebarWidth: 152,
          navigationLabels: [
            "当前决策",
            "首页",
            "问答",
            "知识",
            "评审",
            "方法论",
            "设置",
          ],
          workspaceOverflowY: "auto",
        });
        expect(metrics.stageWidth).toBe(
          DESKTOP_WINDOW_SIZE.width - metrics.sidebarWidth - 2,
        );
        expect(metrics.answerSummaryVisible).toBe(true);
        expect(metrics.answerSummaryFitsWidth).toBe(true);
        expect(metrics.alternativesVisible).toBe(true);
        expect(metrics.alternativeOptionCount).toBe(3);
        expect(metrics.answerFontSize).toBeGreaterThanOrEqual(22);
        expect(metrics.workspaceScrollTop).toBe(0);
        expect(metrics.appScrollHeight).toBe(metrics.appClientHeight);
        expect(metrics.principleOptionCount).toBe(3);
        expect(metrics.principleOptionsSingleRow).toBe(true);
        expect(metrics.principleSectionInsideCard).toBe(true);
        expect(metrics.actionsHeight).toBeGreaterThan(0);
        expect(metrics.discardLabel).toBe("不保留");
        expect(metrics.discardDisabled).toBe(false);
        expect(metrics.textareaBottom).not.toBeNull();
        expect(metrics.textareaBottom ?? 0).toBeLessThan(metrics.actionsBottom);
        expect(metrics.actionsBottom).toBeLessThanOrEqual(metrics.cardBottom);
      },
    );

    it("keeps the form stable while a one-click discard is submitting", async () => {
      const metrics = await measureRationale("light", "no-record");

      expect(metrics.viewportWidth).toBe(DESKTOP_WINDOW_SIZE.width);
      expect(metrics.viewportHeight).toBe(DESKTOP_WINDOW_SIZE.height);
      expect(metrics.textareaBottom).not.toBeNull();
      expect(metrics.discardDisabled).toBe(true);
      expect(metrics.actionsBottom).toBeLessThanOrEqual(metrics.cardBottom);
    });

    it("opens long context in a centered dialog instead of expanding the workspace", async () => {
      const metrics = await measureRationale("light", "expanded");

      expect(metrics.contextDialogOpen).toBe(true);
      expect(metrics.contextDialogCentered).toBe(true);
      expect(metrics.contextInsideDialog).toBe(true);
      expect(metrics.inlineContextExpanded).toBe(false);
      expect(metrics.workspaceOverflowY).toBe("auto");
      expect(metrics.appScrollHeight).toBe(metrics.appClientHeight);
      expect(metrics.actionsBottom).toBeLessThanOrEqual(metrics.cardBottom);
    });

    it("keeps context hover visually quiet", async () => {
      const metrics = await measureRationale("light", "hover");

      expect(metrics.toggleBackground).toBe("rgba(0, 0, 0, 0)");
    });

    it("shows every alternative after expansion without horizontal overflow", async () => {
      const metrics = await measureRationale("light", "alternatives-expanded");

      expect(metrics.alternativeOptionCount).toBe(4);
      expect(metrics.answerSummaryFitsWidth).toBe(true);
      expect(metrics.workspaceScrollTop).toBe(0);
      expect(metrics.appScrollHeight).toBe(metrics.appClientHeight);
    });
  },
);
