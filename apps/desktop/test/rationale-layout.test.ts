import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { DESKTOP_WINDOW_SIZE } from "../src/shared/decision-layout.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const scriptPath = new URL(
  "../../../scripts/check-rationale-layout.cjs",
  import.meta.url,
).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

type Theme = "light" | "dark";
type Interaction =
  "default" | "expanded" | "expanded-no-record" | "hover" | "no-record";

interface RationaleMetrics {
  actionsBottom: number;
  actionsHeight: number;
  appClientHeight: number;
  appScrollHeight: number;
  backdropFilter: string;
  cardBottom: number;
  contextDialogCentered: boolean;
  contextDialogOpen: boolean;
  contextInsideDialog: boolean;
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
}

const cache = new Map<string, Promise<RationaleMetrics>>();
const measureRationale = (
  theme: Theme,
  interaction: Interaction = "default",
): Promise<RationaleMetrics> => {
  const key = `${theme}:${interaction}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = execFileAsync(electronPath, [scriptPath, theme, interaction], {
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
          sidebarWidth: 188,
          navigationLabels: [
            "当前决策",
            "首页",
            "决策库",
            "方法论",
            "接入",
            "模型",
            "日志",
            "设置",
          ],
          workspaceOverflowY: "auto",
        });
        expect(metrics.stageWidth).toBe(
          DESKTOP_WINDOW_SIZE.width - metrics.sidebarWidth - 2,
        );
        expect(metrics.appScrollHeight).toBe(metrics.appClientHeight);
        expect(metrics.principleOptionCount).toBe(3);
        expect(metrics.principleOptionsSingleRow).toBe(true);
        expect(metrics.principleSectionInsideCard).toBe(true);
        expect(metrics.actionsHeight).toBeGreaterThan(0);
        expect(metrics.textareaBottom).not.toBeNull();
        expect(metrics.textareaBottom ?? 0).toBeLessThan(metrics.actionsBottom);
        expect(metrics.actionsBottom).toBeLessThanOrEqual(metrics.cardBottom);
      },
    );

    it("keeps the same window size when no-record is selected", async () => {
      const metrics = await measureRationale("light", "no-record");

      expect(metrics.viewportWidth).toBe(DESKTOP_WINDOW_SIZE.width);
      expect(metrics.viewportHeight).toBe(DESKTOP_WINDOW_SIZE.height);
      expect(metrics.textareaBottom).toBeNull();
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
  },
);
