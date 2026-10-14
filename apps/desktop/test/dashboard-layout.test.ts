import { runElectronCheck } from "./support/run-electron-check.js";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

import {
  DESKTOP_WINDOW_MIN_SIZE,
  DESKTOP_WINDOW_SIZE,
} from "../src/shared/decision-layout.js";

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
  summaryInteractiveCount: number;
  summaryItemHeights: number[];
  recentItemsAreButtons: boolean;
  sidebarActionGaps: number[];
  sidebarActionLabels: string[];
  sidebarActionsFit: boolean;
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

type DashboardMode = "default" | "compact" | "rationale-dialog" | "rationale-continuous" | "rationale-compact" | "tall";

const measureDashboard = async (
  mode: DashboardMode = "default",
): Promise<DashboardMetrics> => {
  const { stdout } = await runElectronCheck(
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
        brandIconBorderRadius: 2,
        heading: "首页",
        historyBadge: "历史",
        navigationLabels: [
          "首页",
          "问答",
          "知识",
          "评审",
          "方法论",
          "设置",
        ],
        overflowY: "auto",
        rationaleDescription: "选择已保存",
        sidebarWidth: 152,
        summaryColumns: 4,
        viewportHeight: DESKTOP_WINDOW_SIZE.height,
        viewportWidth: DESKTOP_WINDOW_SIZE.width,
      });
      expect(metrics.stageWidth).toBe(
        DESKTOP_WINDOW_SIZE.width - metrics.sidebarWidth - 2,
      );
      // The preview has candidates and a due review, so every overview tile
      // is a quick-navigation button; buttons and static tiles share one box.
      expect(metrics.summaryInteractiveCount).toBe(4);
      expect(new Set(metrics.summaryItemHeights).size).toBe(1);
      expect(metrics.recentItemsAreButtons).toBe(true);
      expect(metrics.sidebarActionsFit).toBe(true);
      // 两个全局命令在品牌下方紧挨着排成一块；「键盘快捷键」留在侧栏底部，
      // 中间隔着整段导航。所以第一道缝很窄，第二道很宽。
      const [commandGap, helpGap] = metrics.sidebarActionGaps;
      expect(commandGap).toBeLessThanOrEqual(8);
      expect(helpGap).toBeGreaterThan(100);
      expect(metrics.sidebarActionLabels).toEqual([
        "主动记录",
        "快速跳转",
        "收起菜单栏",
        "键盘快捷键",
      ]);
      expect(metrics.headerHeight).toBe(44);
      expect(metrics.headingVisible).toBe(true);
      expect(new Set(metrics.cardHeaderHeights)).toEqual(new Set([40]));
      expect(metrics.cardHeadersSingleRow).toBe(true);
      expect(metrics.rationaleDescriptionWhiteSpace).toBe("nowrap");
      expect(metrics.pagePaddingTop).toBe(16);
      expect(metrics.pagePaddingBottom).toBe(16);
      expect(metrics.pagePaddingLeft).toBe(22);
      expect(metrics.pagePaddingRight).toBe(22);
      expect(metrics.pageContentLeftInset).toBe(metrics.pageContentRightInset);
      expect(metrics.visualTopInset).toBe(
        metrics.headerHeight + metrics.pagePaddingTop,
      );
      expect(metrics.visualBottomInset).toBe(16);
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
      // Grid tracks may round a 150px target down by a fraction of a pixel.
      expect(Math.round(metrics.rationaleContextWidth)).toBeGreaterThanOrEqual(150);
      expect(metrics.rationaleListOverflowY).toBe("auto");
      expect(metrics.rationaleListClientHeight).toBeLessThanOrEqual(128);
      expect(metrics.rationaleListScrollHeight).toBeGreaterThan(
        metrics.rationaleListClientHeight,
      );
      expect(metrics.rationaleRowMaxHeight).toBeLessThanOrEqual(64);
      expect(metrics.recentListOverflowY).toBe("auto");
      expect(metrics.scrollHeight).toBe(metrics.clientHeight);
      expect(metrics.scrollTopAfter).toBe(0);
      // 四个计数从 88px 的大卡压成一条 52px 的读数条，省下来的高度全给了
      // 最近决策；这里只守住「它要把剩下的空间吃满」，不锁死具体像素。
      expect(metrics.recentListClientHeight).toBeGreaterThanOrEqual(360);
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
      expect(metrics.headerHeight).toBe(44);
      expect(metrics.scrollHeight).toBe(metrics.clientHeight);
      expect(metrics.scrollTopAfter).toBe(0);
      expect(metrics.recentListClientHeight).toBeGreaterThan(316);
      expect(metrics.recentCardContentBottomGap).toBe(0);
      expect(metrics.visualBottomInset).toBe(16);
    });

    it("keeps the continuous editor and actions visible at both desktop sizes", async () => {
      for (const mode of ["rationale-continuous", "rationale-compact"] as const) {
        const metrics = await measureDashboard(mode);
        expect(metrics).toMatchObject({
          rationaleActionsVisible: true,
          rationaleEditorVisible: true,
          rationaleComposerFits: true,
          rationaleProgressVisible: true,
          rationaleEditorFocused: true,
        });
      }
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
