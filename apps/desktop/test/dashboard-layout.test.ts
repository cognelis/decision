import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_WINDOW_MIN_SIZE,
  DESKTOP_WINDOW_SIZE,
} from "../src/shared/decision-layout.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;
const scriptPath = new URL(
  "../../../scripts/check-dashboard-layout.cjs",
  import.meta.url,
).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

interface DashboardMetrics {
  appClientHeight: number;
  appScrollHeight: number;
  brandIconBorderRadius: number;
  cardHeaderHeights: number[];
  cardHeadersSingleRow: boolean;
  clientHeight: number;
  clientWidth: number;
  headerHeight: number;
  heading: string;
  headingVisible: boolean;
  historyBadge: string;
  navigationLabels: string[];
  overflowY: string;
  pageContentLeftInset: number;
  pageContentRightInset: number;
  pagePaddingBottom: number;
  pagePaddingLeft: number;
  pagePaddingRight: number;
  pagePaddingTop: number;
  rationaleButtonHeight: number;
  rationaleButtonWidth: number;
  rationaleContextWidth: number;
  rationaleDiscardButtonHeight: number;
  rationaleDiscardButtonWidth: number;
  rationaleDescription: string;
  rationaleDescriptionWhiteSpace: string;
  rationaleListClientHeight: number;
  rationaleListOverflowY: string;
  rationaleListScrollHeight: number;
  rationaleRowMaxHeight: number;
  recentListClientHeight: number;
  recentListOverflowY: string;
  recentListScrollbarWidth: string;
  recentListScrollHeight: number;
  recentListScrollTopAfter: number;
  recentLastItemBottom: number | null;
  recentLastItemFullyVisible: boolean;
  recentListBottom: number;
  recentListSafeGap: number | null;
  recentListWithinCard: boolean;
  recentListWebkitScrollbarDisplay: string;
  recentCardBottomAfterScroll: number;
  recentCardContentBottomGap: number;
  scrollHeight: number;
  scrollTopAfter: number;
  scrollWidth: number;
  sidebarWidth: number;
  stageWidth: number;
  startButtonHeight: number;
  startButtonWidth: number;
  summaryColumns: number;
  viewportHeight: number;
  viewportWidth: number;
  visualBottomInset: number;
  visualTopInset: number;
  rationaleCardHeightStable?: boolean;
  rationaleDialogCentered?: boolean;
  rationaleDialogOpen?: boolean;
  rationaleEditorFocused?: boolean;
  rationaleEditorInsideDialog?: boolean;
  rationalePageHeightStable?: boolean;
}

type DashboardMode = "default" | "compact" | "rationale-dialog" | "tall";

const measureDashboard = async (
  mode: DashboardMode = "default",
): Promise<DashboardMetrics> => {
  const { stdout } = await execFileAsync(
    electronPath,
    mode === "default" ? [scriptPath, "dark"] : [scriptPath, "dark", mode],
    {
      cwd: repositoryRoot,
      timeout: 30_000,
    },
  );
  return JSON.parse(stdout) as DashboardMetrics;
};

describe.skipIf(process.platform !== "darwin")(
  "decision center desktop layout",
  () => {
    it("keeps the complete dashboard inside one stable workspace", async () => {
      const metrics = await measureDashboard();

      expect(metrics).toMatchObject({
        brandIconBorderRadius: 8,
        heading: "首页",
        historyBadge: "历史",
        navigationLabels: [
          "首页",
          "决策库",
          "方法论",
          "接入",
          "模型",
          "日志",
          "设置",
        ],
        overflowY: "auto",
        rationaleDescription: "已记录决策，理由尚未补充",
        sidebarWidth: 188,
        summaryColumns: 4,
        viewportHeight: DESKTOP_WINDOW_SIZE.height,
        viewportWidth: DESKTOP_WINDOW_SIZE.width,
      });
      expect(metrics.stageWidth).toBe(
        DESKTOP_WINDOW_SIZE.width - metrics.sidebarWidth - 2,
      );
      expect(metrics.headerHeight).toBe(48);
      expect(metrics.headingVisible).toBe(false);
      expect(new Set(metrics.cardHeaderHeights)).toEqual(new Set([48]));
      expect(metrics.cardHeadersSingleRow).toBe(true);
      expect(metrics.rationaleDescriptionWhiteSpace).toBe("nowrap");
      expect(metrics.pagePaddingTop).toBe(18);
      expect(metrics.pagePaddingBottom).toBe(18);
      expect(metrics.pagePaddingLeft).toBe(20);
      expect(metrics.pagePaddingRight).toBe(20);
      expect(metrics.pageContentLeftInset).toBe(metrics.pageContentRightInset);
      expect(metrics.visualTopInset).toBe(
        metrics.headerHeight + metrics.pagePaddingTop,
      );
      expect(metrics.visualBottomInset).toBe(18);
      expect(metrics.appScrollHeight).toBe(metrics.appClientHeight);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
      expect(metrics.startButtonWidth).toBeGreaterThanOrEqual(76);
      expect(metrics.startButtonHeight).toBeGreaterThanOrEqual(28);
      expect(metrics.rationaleButtonWidth).toBeGreaterThan(
        metrics.rationaleButtonHeight * 1.5,
      );
      expect(metrics.rationaleDiscardButtonWidth).toBeGreaterThan(
        metrics.rationaleDiscardButtonHeight * 1.5,
      );
      expect(metrics.rationaleContextWidth).toBeGreaterThanOrEqual(150);
      expect(metrics.rationaleListOverflowY).toBe("auto");
      expect(metrics.rationaleListClientHeight).toBeLessThanOrEqual(128);
      expect(metrics.rationaleListScrollHeight).toBeGreaterThan(
        metrics.rationaleListClientHeight,
      );
      expect(metrics.rationaleRowMaxHeight).toBeLessThanOrEqual(64);
      expect(metrics.recentListOverflowY).toBe("auto");
      expect(metrics.scrollHeight).toBe(metrics.clientHeight);
      expect(metrics.scrollTopAfter).toBe(0);
      expect(metrics.recentListClientHeight).toBe(316);
      expect(metrics.recentCardContentBottomGap).toBe(0);
      expect(metrics.recentListScrollHeight).toBeGreaterThan(
        metrics.recentListClientHeight,
      );
      expect(metrics.recentListScrollTopAfter).toBe(
        metrics.recentListScrollHeight - metrics.recentListClientHeight,
      );
      expect(metrics.recentListScrollbarWidth).toBe("none");
      expect(metrics.recentListWebkitScrollbarDisplay).toBe("none");
      expect(metrics.recentLastItemFullyVisible).toBe(true);
      expect(metrics.recentListSafeGap).toBeGreaterThanOrEqual(9);
      expect(metrics.recentListWithinCard).toBe(true);
      expect(metrics.recentCardBottomAfterScroll).toBeLessThanOrEqual(
        DESKTOP_WINDOW_SIZE.height,
      );
    });

    it("keeps the final recent decision clear of the card edge in a compact window", async () => {
      const metrics = await measureDashboard("compact");

      expect(metrics).toMatchObject({
        recentLastItemFullyVisible: true,
        recentListWithinCard: true,
        viewportHeight: DESKTOP_WINDOW_MIN_SIZE.height,
        viewportWidth: DESKTOP_WINDOW_MIN_SIZE.width,
      });
      expect(metrics.recentListSafeGap).toBeGreaterThanOrEqual(9);
      expect(metrics.recentCardBottomAfterScroll).toBeLessThanOrEqual(
        DESKTOP_WINDOW_MIN_SIZE.height,
      );
    });

    it("expands recent decisions to the bottom in a taller window", async () => {
      const metrics = await measureDashboard("tall");

      expect(metrics.viewportHeight).toBe(900);
      expect(metrics.headerHeight).toBe(48);
      expect(metrics.scrollHeight).toBe(metrics.clientHeight);
      expect(metrics.scrollTopAfter).toBe(0);
      expect(metrics.recentListClientHeight).toBeGreaterThan(316);
      expect(metrics.recentCardContentBottomGap).toBe(0);
      expect(metrics.visualBottomInset).toBe(18);
    });

    it("opens rationale editing in a centered dialog without resizing the dashboard", async () => {
      const metrics = await measureDashboard("rationale-dialog");

      expect(metrics).toMatchObject({
        rationaleCardHeightStable: true,
        rationaleDialogCentered: true,
        rationaleDialogOpen: true,
        rationaleEditorFocused: true,
        rationaleEditorInsideDialog: true,
        rationalePageHeightStable: true,
      });
    });
  },
);
