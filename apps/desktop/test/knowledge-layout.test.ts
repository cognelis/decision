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
  "../../../scripts/check-knowledge-layout.cjs",
  import.meta.url,
).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

type Theme = "light" | "dark";
type Mode = "default" | "compact" | "indexing" | "semantic-unavailable";

interface FocusEvidence {
  active: boolean;
  boxShadow: string;
  enabled: boolean;
  focusVisible: boolean;
  indicatorWithinResultBounds: boolean | null;
  outlineColor: string;
  outlineOffset: number;
  outlineStyle: string;
  outlineWidth: number;
}

interface KnowledgeLayoutMetrics {
  appClientHeight: number;
  appScrollHeight: number;
  appScrollWidth: number;
  contentClientHeight: number;
  contentWidth: number;
  contentOverflowY: string;
  contentScrollHeight: number;
  computedTheme: {
    panelBackground: string;
    panelColor: string;
    resultBackground: string | null;
    resultColor: string | null;
    statusBackground: string;
    statusColor: string;
  };
  coverageVisible: boolean;
  description: string;
  descriptionVisible: boolean;
  formFits: boolean;
  decisionToolbarFits: boolean | null;
  noteChromeFits: boolean;
  heading: string;
  headingVisible: boolean;
  indexingInstructionVisible: boolean;
  inputDisabled: boolean;
  inputFocus: FocusEvidence;
  inputHeight: number;
  mode: Mode;
  navigationLabels: string[];
  noHorizontalOverflow: boolean;
  outerScroll: {
    bodyClientHeight: number;
    bodyClientWidth: number;
    bodyScrollHeight: number;
    bodyScrollWidth: number;
    documentClientHeight: number;
    documentClientWidth: number;
    documentScrollHeight: number;
    documentScrollWidth: number;
  };
  privacy: string;
  privacyVisible: boolean;
  rebuildFocus: FocusEvidence;
  resultActionFocus: FocusEvidence | null;
  resultActionReachable: boolean;
  resultCount: number;
  resultFieldsFit: boolean;
  resultPathOverflowWrap: string[];
  resultPathTextOverflow: string[];
  resultsClientHeight: number | null;
  resultsOverflowY: string | null;
  resultsScrollHeight: number | null;
  resultsScrollTopAfter: number | null;
  searchControlsReachable: boolean;
  semanticResultCount: number;
  keywordResultCount: number;
  hybridResultCount: number;
  sidebarWidth: number;
  panelWidth: number;
  stageClientHeight: number;
  stageOverflowY: string;
  stageScrollHeight: number;
  stageWidth: number;
  status: string;
  statusStripWidth: number;
  statusVisible: boolean;
  submitHeight: number;
  theme: Theme;
  viewportHeight: number;
  viewportWidth: number;
  tokens: {
    surface: string;
    surfaceInset: string;
    text: string;
    window: string;
  };
}

const cache = new Map<string, Promise<KnowledgeLayoutMetrics>>();
const measure = (
  theme: Theme,
  mode: Mode = "default",
): Promise<KnowledgeLayoutMetrics> => {
  const key = `${theme}:${mode}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = runElectronCheck(electronPath, [scriptPath, theme, mode], {
    cwd: repositoryRoot,
    timeout: 30_000,
  }).then(({ stdout }) => JSON.parse(stdout) as KnowledgeLayoutMetrics);
  cache.set(key, result);
  return result;
};

const expectStableShell = (metrics: KnowledgeLayoutMetrics) => {
  expect(metrics.navigationLabels).toEqual([
    "首页",
    "问答",
    "知识",
    "评审",
    "方法论",
    "设置",
  ]);
  expect(metrics.heading).toBe("知识");
  expect(metrics.description).toBe(
    "一次搜索同时查决策、个人偏好想法和 Vault 里的全部笔记。",
  );
  expect(metrics.privacy).toBe("检索仅在本机处理");
  // 44px 的标题条把类目、标题和一句说明排成一行读完；旧版把整块标题藏起来，
  // 顶部只剩一个飘在右上角的计数气泡，页面自己不说自己是谁。
  expect(metrics.headingVisible).toBe(true);
  expect(metrics.descriptionVisible).toBe(true);
  expect(metrics.privacyVisible).toBe(true);
  expect(metrics.statusVisible).toBe(true);
  expect(metrics.coverageVisible).toBe(true);
  expect(metrics.contentOverflowY).toBe("hidden");
  expect(metrics.stageOverflowY).not.toBe("auto");
  expect(metrics.appScrollHeight).toBe(metrics.appClientHeight);
  expect(metrics.stageScrollHeight).toBe(metrics.stageClientHeight);
  expect(metrics.appScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.outerScroll.documentScrollHeight).toBe(
    metrics.outerScroll.documentClientHeight,
  );
  expect(metrics.outerScroll.documentScrollWidth).toBe(
    metrics.outerScroll.documentClientWidth,
  );
  expect(metrics.outerScroll.bodyScrollHeight).toBe(
    metrics.outerScroll.bodyClientHeight,
  );
  expect(metrics.outerScroll.bodyScrollWidth).toBe(
    metrics.outerScroll.bodyClientWidth,
  );
  expect(metrics.noHorizontalOverflow).toBe(true);
  expect(metrics.formFits).toBe(true);
  expect(metrics.decisionToolbarFits).toBe(true);
  expect(metrics.noteChromeFits).toBe(true);
  // The knowledge page uses the app's standard control height, not the larger
  // one the standalone Obsidian page had.
  expect(metrics.inputHeight).toBeGreaterThanOrEqual(30);
  expect(metrics.submitHeight).toBeGreaterThanOrEqual(30);
  expect(metrics.searchControlsReachable).toBe(true);
  expect(metrics.stageWidth).toBe(
    metrics.viewportWidth - metrics.sidebarWidth - 2,
  );
};

const expectVisibleFocus = (evidence: FocusEvidence) => {
  expect(evidence).toMatchObject({
    active: true,
    enabled: true,
    focusVisible: true,
  });
  // A ring is painted either as an outline or as a spread box-shadow; the
  // shared search field uses the latter on its wrapper.
  if (evidence.outlineStyle === "none") {
    expect(evidence.boxShadow).toMatch(/0px 0px 0px [1-9]/u);
    return;
  }
  expect(evidence.outlineStyle).not.toBe("none");
  expect(evidence.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(evidence.outlineColor).not.toBe("");
  expect(evidence.outlineColor).not.toBe("transparent");
  expect(evidence.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
};

const expectInwardResultFocus = (evidence: FocusEvidence) => {
  expectVisibleFocus(evidence);
  expect(
    evidence.outlineOffset < 0 || evidence.boxShadow.includes("inset"),
  ).toBe(true);
  expect(evidence.indicatorWithinResultBounds).toBe(true);
};

const expectUsableColor = (value: string) => {
  expect(value.trim()).not.toBe("");
  expect(value).not.toBe("transparent");
  expect(value).not.toBe("rgba(0, 0, 0, 0)");
};

describe.skipIf(process.platform !== "darwin")(
  "knowledge page desktop layout",
  () => {
    it.each(["light", "dark"] as const)(
      "keeps results as the only scroll owner in the %s theme",
      async (theme) => {
        const metrics = await measure(theme);

        expectStableShell(metrics);
        expect(metrics).toMatchObject({
          hybridResultCount: 1,
          inputDisabled: false,
          resultActionReachable: true,
          resultCount: 12,
          resultFieldsFit: true,
          resultsOverflowY: "auto",
          semanticResultCount: 10,
          keywordResultCount: 1,
          viewportHeight: DESKTOP_WINDOW_SIZE.height,
          viewportWidth: DESKTOP_WINDOW_SIZE.width,
        });
        expect(metrics.sidebarWidth).toBe(152);
        expect(metrics.stageWidth).toBe(
          DESKTOP_WINDOW_SIZE.width - metrics.sidebarWidth - 2,
        );
        expectVisibleFocus(metrics.inputFocus);
        expectVisibleFocus(metrics.rebuildFocus);
        expect(metrics.resultActionFocus).not.toBeNull();
        expectInwardResultFocus(metrics.resultActionFocus!);
        expect(metrics.resultsClientHeight).not.toBeNull();
        expect(metrics.resultsScrollHeight).toBeGreaterThan(
          metrics.resultsClientHeight ?? Number.POSITIVE_INFINITY,
        );
        expect(metrics.resultsScrollTopAfter).toBe(
          (metrics.resultsScrollHeight ?? 0) - (metrics.resultsClientHeight ?? 0),
        );
        expect(new Set(metrics.resultPathOverflowWrap)).toEqual(
          new Set(["anywhere"]),
        );
        expect(metrics.resultPathTextOverflow).not.toContain("ellipsis");
      },
    );

    it("wraps controls without horizontal overflow at the minimum window", async () => {
      const metrics = await measure("dark", "compact");

      expectStableShell(metrics);
      expect(metrics).toMatchObject({
        resultCount: 12,
        resultFieldsFit: true,
        resultsOverflowY: "auto",
        viewportHeight: DESKTOP_WINDOW_MIN_SIZE.height,
        viewportWidth: DESKTOP_WINDOW_MIN_SIZE.width,
      });
      expect(metrics.resultsScrollHeight).toBeGreaterThan(
        metrics.resultsClientHeight ?? Number.POSITIVE_INFINITY,
      );
      expectVisibleFocus(metrics.inputFocus);
      expectVisibleFocus(metrics.rebuildFocus);
      expect(metrics.resultActionFocus).not.toBeNull();
      expectInwardResultFocus(metrics.resultActionFocus!);
    });

    it("keeps first-time indexing readable without stranding the search box", async () => {
      const metrics = await measure("light", "indexing");

      expectStableShell(metrics);
      expect(metrics.status).toContain("正在建立全库索引");
      expect(metrics.indexingInstructionVisible).toBe(true);
      // The note index is still building, but decisions are searchable, so the
      // shared box stays usable instead of going dead.
      expect(metrics.inputDisabled).toBe(false);
      expectVisibleFocus(metrics.inputFocus!);
      expectVisibleFocus(metrics.rebuildFocus);
      expect(metrics.resultActionFocus).toBeNull();
      expect(metrics.resultCount).toBe(0);
      expect(metrics.resultsOverflowY).toBeNull();
    });

    it("honestly labels semantic unavailability while returning keywords", async () => {
      const metrics = await measure("dark", "semantic-unavailable");

      expectStableShell(metrics);
      expect(metrics.status).toContain("仅使用关键词匹配");
      expect(metrics.resultCount).toBe(12);
      expect(metrics.keywordResultCount).toBe(12);
      expect(metrics.semanticResultCount).toBe(0);
      expect(metrics.hybridResultCount).toBe(0);
      expectVisibleFocus(metrics.inputFocus);
      expectVisibleFocus(metrics.rebuildFocus);
      expect(metrics.resultActionFocus).not.toBeNull();
      expectInwardResultFocus(metrics.resultActionFocus!);
    });

    it("uses distinct valid light and dark theme tokens on the rendered workspace", async () => {
      const [light, dark] = await Promise.all([
        measure("light"),
        measure("dark"),
      ]);

      for (const key of [
        "window",
        "surface",
        "surfaceInset",
        "text",
      ] as const) {
        expectUsableColor(light.tokens[key]);
        expectUsableColor(dark.tokens[key]);
        expect(light.tokens[key]).not.toBe(dark.tokens[key]);
      }
      for (const key of [
        "panelBackground",
        "panelColor",
        "statusBackground",
        "statusColor",
        "resultBackground",
        "resultColor",
      ] as const) {
        expect(light.computedTheme[key]).not.toBeNull();
        expect(dark.computedTheme[key]).not.toBeNull();
        expectUsableColor(light.computedTheme[key]!);
        expectUsableColor(dark.computedTheme[key]!);
        expect(light.computedTheme[key]).not.toBe(dark.computedTheme[key]);
      }
    });

    it("keeps the desktop workspace widths stable across status modes", async () => {
      const metricsByMode = await Promise.all([
        measure("dark", "default"),
        measure("dark", "indexing"),
        measure("dark", "semantic-unavailable"),
      ]);
      const baseline = metricsByMode[0]!;

      for (const metrics of metricsByMode) {
        expect(metrics.viewportWidth).toBe(DESKTOP_WINDOW_SIZE.width);
        expect(metrics.stageWidth).toBe(
          metrics.viewportWidth - metrics.sidebarWidth - 2,
        );
        expect(
          Math.abs(metrics.stageWidth - baseline.stageWidth),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(metrics.panelWidth - baseline.panelWidth),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(metrics.contentWidth - baseline.contentWidth),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(metrics.statusStripWidth - baseline.statusStripWidth),
        ).toBeLessThanOrEqual(1);
      }
    });
  },
);
