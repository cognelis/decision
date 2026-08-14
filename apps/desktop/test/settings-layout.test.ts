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
  "../../../scripts/check-settings-layout.cjs",
  import.meta.url,
).pathname;
const repositoryRoot = new URL("../../../", import.meta.url).pathname;

type Theme = "light" | "dark";
type Surface =
  "decisions" | "methodology" | "settings" | "clients" | "models" | "activity";
type Interaction =
  | "default"
  | "add-backend"
  | "trace-detail"
  | "decision-outcome"
  | "decision-review"
  | "decision-schedule"
  | "decision-principles"
  | "decision-search"
  | "decision-filter-stability"
  | "methodology-materials"
  | "methodology-workbench"
  | "methodology-validation"
  | "methodology-create"
  | "methodology-manual-entry"
  | "methodology-manual-evidence"
  | "methodology-source"
  | "methodology-batch"
  | "methodology-import-preview"
  | "methodology-import-detail"
  | "methodology-evidence-match"
  | "methodology-evidence-link"
  | "methodology-detail"
  | "methodology-usage"
  | "methodology-evolution"
  | "methodology-evolution-recovery"
  | "methodology-evolution-rebase"
  | "methodology-relation-queue"
  | "methodology-relation-review"
  | "methodology-quality-confirm"
  | "methodology-graph"
  | "methodology-merge-draft"
  | "methodology-merge-recovery"
  | "methodology-merge-relation-review"
  | "methodology-merge-lifecycle"
  | "methodology-consultation"
  | "methodology-analysis"
  | "methodology-analysis-compact"
  | "practice-assets"
  | "practice-assets-compact"
  | "practice-source"
  | "practice-manual"
  | "practice-detail"
  | "practice-publication"
  | "practice-freshness"
  | "practice-history"
  | "compact";

interface DesktopPageMetrics {
  activityRecognitionVisible: boolean;
  appClientHeight: number;
  appScrollHeight: number;
  backdropFilter: string;
  cardCount: number;
  cardHeaderHeights: number[];
  cardHeadersSingleRow: boolean;
  cardsFitWidth: boolean;
  clientCardCount: number;
  clientHeight: number;
  clientWidth: number;
  controlsFitWidth: boolean;
  decisionColumnCount: number;
  decisionColumnsAligned: boolean;
  decisionListOverflowY: string | null;
  decisionListScrollbarWidth: string | null;
  decisionListWebkitScrollbarDisplay: string | null;
  decisionFilterMaximumShift?: number;
  decisionFilterObservedCounts?: string[];
  decisionFilterLoadingFlash?: boolean;
  decisionFilterToolbarStable?: boolean;
  decisionSearchClearVisible?: boolean;
  decisionSearchFocused?: boolean;
  decisionSearchModeDefaultOff?: boolean;
  decisionSearchModeEnabled?: boolean;
  decisionSearchModeOutsideField?: boolean;
  decisionSearchSingleRow?: boolean;
  headerHeight: number;
  heading: string;
  headingVisible: boolean;
  modelProfileVisible: boolean;
  methodologyColumnCount: number;
  methodologyColumnsAligned: boolean;
  methodologyActiveIndicatorHeight: string | null;
  methodologyBuildActionCount: number;
  methodologyBuildActionsFit: boolean;
  methodologyBuildGuideVisible: boolean;
  methodologyBuildMetricCount: number;
  methodologyBuildMetricsSingleRow: boolean;
  methodologyBuildPathCount: number;
  methodologyBuildPathSingleRow: boolean;
  methodologyRecordsToolbarHeight: number | null;
  methodologyStatusFilterBackground: string | null;
  methodologyStatusFilterBorderWidth: string | null;
  methodologyToolbarHeight: number | null;
  methodologyToolbarsSingleRow: boolean | null;
  methodologyViewTabsBackground: string | null;
  methodologyViewTabsBorderWidth: string | null;
  navigationLabels: string[];
  overflowY: string;
  pageContentLeftInset: number | null;
  pageContentRightInset: number | null;
  pagePaddingBottom: number;
  pagePaddingLeft: number;
  pagePaddingRight: number;
  pagePaddingTop: number;
  pathClientWidth: number | null;
  pathOverflowWrap: string | null;
  pathScrollWidth: number | null;
  pathTextOverflow: string | null;
  providerDragHandleCount: number;
  providerLegacyMoveActionsVisible: boolean;
  providerActionLefts: Array<number | null>;
  providerRowHeights: number[];
  providerStatusLefts: Array<number | null>;
  providerSwitchCount: number;
  providerSwitchLefts: Array<number | null>;
  providerTestActionLefts: Array<number | null>;
  scrollHeight: number;
  scrollTopAfter: number;
  scrollWidth: number;
  sidebarWidth: number;
  stageWidth: number;
  surface: Surface;
  tokens: {
    modalBackdrop: string;
    modalSurface: string;
    surface: string;
    toolbar: string;
    window: string;
    windowHighlight: string;
  };
  traceRowVisible: boolean;
  traceColumnCount: number;
  traceColumnsAligned: boolean;
  traceGridTemplateColumns: string | null;
  traceCardBottom: number | null;
  traceContentBottom: number;
  traceListClientHeight: number | null;
  traceListOverflowY: string | null;
  traceListScrollbarWidth: string | null;
  traceListScrollHeight: number | null;
  traceListScrollTopAfter: number | null;
  traceListWebkitScrollbarDisplay: string | null;
  viewportHeight: number;
  viewportWidth: number;
  addButtonExpanded?: boolean;
  addButtonLabel?: string;
  dialogCentered?: boolean;
  editorInsideDialog?: boolean;
  editorTop?: number;
  editorVisible?: boolean;
  firstEditorControlFocused?: boolean;
  listTopStable?: boolean;
  outcomeDialogCentered?: boolean;
  outcomeEditorFocused?: boolean;
  outcomeEditorInsideDialog?: boolean;
  outcomeEditorVisible?: boolean;
  outcomeListHeightStable?: boolean;
  reviewDialogCentered?: boolean;
  reviewEditorFocused?: boolean;
  reviewEditorInsideDialog?: boolean;
  reviewEditorVisible?: boolean;
  reviewListHeightStable?: boolean;
  reviewVerdictCount?: number;
  reviewVerdictSingleRow?: boolean;
  scheduleDateVisible?: boolean;
  scheduleDialogCentered?: boolean;
  scheduleEditorInsideDialog?: boolean;
  scheduleEditorVisible?: boolean;
  scheduleListHeightStable?: boolean;
  scheduleNoWakeCopyVisible?: boolean;
  schedulePresetCount?: number;
  schedulePresetsSingleRow?: boolean;
  decisionPrincipleDialogCentered?: boolean;
  decisionPrincipleEditorInsideDialog?: boolean;
  decisionPrincipleChoiceCount?: number;
  decisionPrincipleChoicesTwoColumns?: boolean;
  decisionPrincipleSafetyCopyVisible?: boolean;
  decisionPrincipleListHeightStable?: boolean;
  methodologyCreateCentered?: boolean;
  methodologyCreateInsideDialog?: boolean;
  methodologyCreateOptionCount?: number;
  methodologyCreateOptionsSingleRow?: boolean;
  methodologyCreateBoundaryCount?: number;
  methodologyCreateNoModelVisible?: boolean;
  methodologyCreateHorizontalOverflow?: boolean;
  methodologyMaterialsCentered?: boolean;
  methodologyMaterialsInsideDialog?: boolean;
  methodologyMaterialsModeCount?: number;
  methodologyMaterialsModesSingleRow?: boolean;
  methodologyMaterialsCardCount?: number;
  methodologyMaterialsSourceCount?: number;
  methodologyMaterialsActionCount?: number;
  methodologyMaterialsActionsSingleRow?: boolean;
  methodologyMaterialsBoundaryCount?: number;
  methodologyMaterialsBoundarySingleRow?: boolean;
  methodologyMaterialsNoAutomaticCopy?: boolean;
  methodologyMaterialsHorizontalOverflow?: boolean;
  methodologyMaterialsToolbarStable?: boolean;
  methodologyValidationCentered?: boolean;
  methodologyValidationInsideDialog?: boolean;
  methodologyValidationCardCount?: number;
  methodologyValidationMetricCount?: number;
  methodologyValidationDecisionCount?: number;
  methodologyValidationDecisionsSingleRow?: boolean;
  methodologyValidationActionCount?: number;
  methodologyValidationActionsSingleRow?: boolean;
  methodologyValidationHumanBoundaryVisible?: boolean;
  methodologyValidationHorizontalOverflow?: boolean;
  methodologyValidationToolbarStable?: boolean;
  methodologyWorkbenchCentered?: boolean;
  methodologyWorkbenchInsideDialog?: boolean;
  methodologyWorkbenchCardCount?: number;
  methodologyWorkbenchCardsSingleRow?: boolean;
  methodologyWorkbenchBoundaryVisible?: boolean;
  methodologyWorkbenchHorizontalOverflow?: boolean;
  methodologyWorkbenchToolbarStable?: boolean;
  methodologyManualCentered?: boolean;
  methodologyManualInsideDialog?: boolean;
  methodologyManualFieldCount?: number;
  methodologyManualBoundaryFieldsSingleRow?: boolean;
  methodologyManualSafetyVisible?: boolean;
  methodologyManualSaveVisible?: boolean;
  methodologyManualHorizontalOverflow?: boolean;
  methodologyManualNoModelCopy?: boolean;
  methodologyManualEvidenceCentered?: boolean;
  methodologyManualEvidenceInsideDialog?: boolean;
  methodologyManualEvidenceDialogCount?: number;
  methodologyManualEvidenceSourceCount?: number;
  methodologyManualEvidenceSourcesSingleRow?: boolean;
  methodologyManualEvidenceFieldCount?: number;
  methodologyManualEvidenceBoundaryCount?: number;
  methodologyManualEvidenceBoundarySingleRow?: boolean;
  methodologyManualEvidenceNoModelVisible?: boolean;
  methodologyManualEvidenceSaveVisible?: boolean;
  methodologyManualEvidenceHorizontalOverflow?: boolean;
  methodologyChooserCentered?: boolean;
  methodologySourceListInsideDialog?: boolean;
  methodologyGenerateActionVisible?: boolean;
  methodologyManualEvidenceActionVisible?: boolean;
  methodologySourceActionsSingleRow?: boolean;
  methodologySourceCount?: number;
  methodologySuggestionCount?: number;
  methodologySuggestionPickerInsideDialog?: boolean;
  methodologyDetailCentered?: boolean;
  methodologyDetailInsideDialog?: boolean;
  methodologyEvidenceCount?: number;
  methodologyQualityVisible?: boolean;
  methodologyRelationCount?: number;
  methodologyRelationDialogCentered?: boolean;
  methodologyRelationEditorInsideDialog?: boolean;
  methodologyRelationOptionCount?: number;
  methodologyRelationOptionsSingleColumn?: boolean;
  methodologyRelationNoteVisible?: boolean;
  methodologyRelationSafetyCopyVisible?: boolean;
  methodologyRelationSaveVisible?: boolean;
  methodologyRelationQueueCentered?: boolean;
  methodologyRelationQueueInsideDialog?: boolean;
  methodologyRelationQueueComparisonCount?: number;
  methodologyRelationQueueComparisonSingleRow?: boolean;
  methodologyRelationQueueOptionCount?: number;
  methodologyRelationQueueOptionsSingleRow?: boolean;
  methodologyRelationQueueProgressVisible?: boolean;
  methodologyRelationQueueNoteVisible?: boolean;
  methodologyRelationQueueSafetyVisible?: boolean;
  methodologyRelationQueueSaveVisible?: boolean;
  methodologyQualityConfirmationVisible?: boolean;
  methodologyQualityConfirmActionVisible?: boolean;
  methodologyAcceptVisible?: boolean;
  methodologyUsageCentered?: boolean;
  methodologyUsageInsideDialog?: boolean;
  methodologyUsageMetricCount?: number;
  methodologyUsageMetricsSingleRow?: boolean;
  methodologyUsageCausalityVisible?: boolean;
  methodologyUsageHorizontalOverflow?: boolean;
  methodologyUsageControlsInsideDialog?: boolean;
  methodologyUsageFilterCount?: number;
  methodologyUsageFiltersSingleRow?: boolean;
  methodologyUsageRecordActionCount?: number;
  methodologyUsageNextActionVisible?: boolean;
  methodologyEvolutionCentered?: boolean;
  methodologyEvolutionInsideDialog?: boolean;
  methodologyEvolutionHeaderSingleRow?: boolean;
  methodologyEvolutionFieldCount?: number;
  methodologyEvolutionBoundaryCount?: number;
  methodologyEvolutionEvidenceCount?: number;
  methodologyEvolutionNewEvidenceSelected?: boolean;
  methodologyEvolutionSaveVisible?: boolean;
  methodologyEvolutionHorizontalOverflow?: boolean;
  methodologyEvolutionRecoveryStatusVisible?: boolean;
  methodologyEvolutionRecoveryNoticeVisible?: boolean;
  methodologyEvolutionRecoveryTitleRestored?: boolean;
  methodologyEvolutionRecoveryActionsVisible?: boolean;
  methodologyEvolutionRebaseCentered?: boolean;
  methodologyEvolutionRebaseInsideDialog?: boolean;
  methodologyEvolutionRebaseFieldCount?: number;
  methodologyEvolutionRebaseColumnsAligned?: boolean;
  methodologyEvolutionRebaseUnresolvedVisible?: boolean;
  methodologyEvolutionRebaseActionDisabled?: boolean;
  methodologyEvolutionRebaseFooterVisible?: boolean;
  methodologyEvolutionRebaseHorizontalOverflow?: boolean;
  methodologyListHeightStable?: boolean;
  methodologyBatchCentered?: boolean;
  methodologyBatchInsideDialog?: boolean;
  methodologyBatchActionVisible?: boolean;
  methodologyBatchSafetyCopyVisible?: boolean;
  methodologyImportDetailCentered?: boolean;
  methodologyImportDetailInsideDialog?: boolean;
  methodologyImportPreviewCentered?: boolean;
  methodologyImportPreviewInsideDialog?: boolean;
  methodologyImportPreviewSummaryCount?: number;
  methodologyImportPreviewCandidateCount?: number;
  methodologyImportPreviewSelectedCount?: number;
  methodologyImportPreviewActionVisible?: boolean;
  methodologyImportPreviewSafetyVisible?: boolean;
  methodologyImportPreviewHorizontalOverflow?: boolean;
  methodologyImportProvenanceVisible?: boolean;
  methodologyImportSourceNoteVisible?: boolean;
  methodologyImportTagVisible?: boolean;
  methodologyImportAcceptVisible?: boolean;
  methodologyEvidenceLinkCentered?: boolean;
  methodologyEvidenceLinkInsideDialog?: boolean;
  methodologyEvidenceLinkCount?: number;
  methodologyEvidenceAdjustVisible?: boolean;
  methodologyEvidenceSuggestionsHidden?: boolean;
  methodologyEvidenceMatchCentered?: boolean;
  methodologyEvidenceMatchInsideDialog?: boolean;
  methodologyEvidenceMatchCount?: number;
  methodologyEvidenceMatchReasonVisible?: boolean;
  methodologyEvidenceSearchVisible?: boolean;
  methodologyEvidenceSourceListInsideDialog?: boolean;
  methodologyEvidenceMatchCompact?: boolean;
  methodologyGraphInsideCard?: boolean;
  methodologyGraphHorizontalOverflow?: boolean;
  methodologyGraphProjectCount?: number;
  methodologyGraphPrincipleCount?: number;
  methodologyGraphRelationCount?: number;
  methodologyGraphSearchVisible?: boolean;
  methodologyGraphSummaryCount?: number;
  methodologyGraphToolbarSingleRow?: boolean;
  methodologyGraphEvidenceColumnCount?: number;
  methodologyTabCount?: number;
  methodologyGraphTabSelected?: boolean;
  methodologyMergeCentered?: boolean;
  methodologyMergeInsideDialog?: boolean;
  methodologyMergeDialogCount?: number;
  methodologyMergeSourceCount?: number;
  methodologyMergeSourcesSingleRow?: boolean;
  methodologyMergeFieldCount?: number;
  methodologyMergeEvidenceCount?: number;
  methodologyMergeSafetyVisible?: boolean;
  methodologyMergeActionVisible?: boolean;
  methodologyMergeHorizontalOverflow?: boolean;
  methodologyMergeGraphHeightStable?: boolean;
  methodologyMergeRecoveryStatusVisible?: boolean;
  methodologyMergeRecoveryNoticeVisible?: boolean;
  methodologyMergeRecoveryTitleRestored?: boolean;
  methodologyMergeRecoveryActionsVisible?: boolean;
  methodologyMergeRecoveryHorizontalOverflow?: boolean;
  methodologyMergeLifecycleCentered?: boolean;
  methodologyMergeLifecycleInsideDialog?: boolean;
  methodologyMergeLifecycleStepCount?: number;
  methodologyMergeLifecycleSourceCount?: number;
  methodologyMergeLifecycleAssetCount?: number;
  methodologyMergeLifecycleActionVisible?: boolean;
  methodologyMergeLifecycleSafetyVisible?: boolean;
  methodologyMergeLifecycleHorizontalOverflow?: boolean;
  analyticsInsideCard?: boolean;
  analyticsHorizontalOverflow?: boolean;
  analyticsSummaryCount?: number;
  analyticsGroupColumnCount?: number;
  analyticsGroupColumnsAligned?: boolean;
  analyticsRefreshVisible?: boolean;
  consultationMetricsCount?: number;
  consultationMetricsSingleRow?: boolean;
  consultationInsideCard?: boolean;
  consultationPrivacyVisible?: boolean;
  consultationPreviewCentered?: boolean;
  consultationPreviewInsideDialog?: boolean;
  consultationPreviewFieldCount?: number;
  consultationPreviewOptionCount?: number;
  consultationPreviewOptionsSingleRow?: boolean;
  consultationPreviewActionsSingleRow?: boolean;
  consultationPreviewBoundaryVisible?: boolean;
  consultationPreviewFeedbackVisible?: boolean;
  consultationPreviewFeedbackButtons?: number;
  consultationPreviewFeedbackSingleRow?: boolean;
  consultationPreviewHorizontalOverflow?: boolean;
  practiceAssetsInsideCard?: boolean;
  practiceAssetsToolbarInsideMain?: boolean;
  practiceAssetsToolbarHeightMatches?: boolean;
  practiceAssetsFiltersSingleRow?: boolean;
  practiceAssetsViewTabCount?: number;
  practiceAssetColumnCount?: number;
  practiceAssetsHorizontalOverflow?: boolean;
  practiceAssetRowCount?: number;
  practiceChooserCentered?: boolean;
  practiceTypeCount?: number;
  practiceTypesSingleRow?: boolean;
  practicePrincipleCount?: number;
  practiceSubmitVisible?: boolean;
  practiceManualActionVisible?: boolean;
  practiceCreationBoundaryCount?: number;
  practiceManualCentered?: boolean;
  practiceManualInsideDialog?: boolean;
  practiceManualFieldCount?: number;
  practiceManualTwoColumnRows?: boolean;
  practiceManualSourceVisible?: boolean;
  practiceManualSafetyVisible?: boolean;
  practiceManualSaveVisible?: boolean;
  practiceManualHorizontalOverflow?: boolean;
  practiceManualNoModelCopy?: boolean;
  practiceDetailCentered?: boolean;
  practiceDetailInsideDialog?: boolean;
  practiceStepCount?: number;
  practiceAcceptVisible?: boolean;
  practiceInstallBoundaryVisible?: boolean;
  practicePublicationInsideDialog?: boolean;
  practicePublicationCardCount?: number;
  practicePublicationColumnCount?: number;
  practicePublicationActionsVisible?: boolean;
  practiceSourceCollapsed?: boolean;
  practiceFreshnessVisible?: boolean;
  practiceRegenerateVisible?: boolean;
  practicePublishPaused?: boolean;
  practiceRollbackVisible?: boolean;
  practiceSourceDiffVisible?: boolean;
  practiceSourceFieldChangeCount?: number;
  practiceHistoryVisible?: boolean;
  practiceHistoryVersionCount?: number;
  practiceHistoryComparisonVisible?: boolean;
  practiceHistoryRestoreConfirmationVisible?: boolean;
  pageScrollHeightStable?: boolean;
  traceDetailDialogCentered?: boolean;
  traceDetailBackdropBackground?: string | null;
  traceDetailBackdropFilter?: string | null;
  traceDetailBackgroundColor?: string;
  traceDetailBackgroundImage?: string;
  traceDetailInsideDialog?: boolean;
  traceDetailOpen?: boolean;
  traceDetailSurfaceFilter?: string;
  traceListHeightStable?: boolean;
  traceListScrollHeightStable?: boolean;
  traceRowHeightStable?: boolean;
}

const cache = new Map<string, Promise<DesktopPageMetrics>>();
const measurePage = (
  theme: Theme,
  surface: Surface,
  interaction: Interaction = "default",
): Promise<DesktopPageMetrics> => {
  const key = `${theme}:${surface}:${interaction}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const result = execFileAsync(
    electronPath,
    [
      scriptPath,
      theme,
      surface,
      ...(interaction === "default" ? [] : [interaction]),
    ],
    {
      cwd: repositoryRoot,
      timeout: 30_000,
    },
  ).then(({ stdout }) => JSON.parse(stdout) as DesktopPageMetrics);
  cache.set(key, result);
  return result;
};

const alphaOf = (color: string): number => {
  const match = color.match(/\/\s*([\d.]+)%\)$/u);
  if (match?.[1] === undefined) {
    throw new Error(`CSS color does not contain alpha: ${color}`);
  }
  return Number(match[1]) / 100;
};
const compositeAlpha = (back: number, front: number): number =>
  1 - (1 - back) * (1 - front);

describe.skipIf(process.platform !== "darwin")(
  "desktop management page layouts",
  () => {
    it.each([
      ["decisions", "决策库"],
      ["methodology", "方法论"],
      ["settings", "通用设置"],
      ["clients", "接入"],
      ["models", "模型"],
      ["activity", "日志"],
    ] as const)(
      "keeps %s complete inside the stable workspace",
      async (surface, heading) => {
        const metrics = await measurePage("dark", surface);

        expect(metrics).toMatchObject({
          surface,
          heading,
          navigationLabels: [
            "首页",
            "决策库",
            "方法论",
            "接入",
            "模型",
            "日志",
            "设置",
          ],
          overflowY:
            surface === "decisions" || surface === "methodology"
              ? "hidden"
              : "auto",
          sidebarWidth: 188,
          viewportHeight: DESKTOP_WINDOW_SIZE.height,
          viewportWidth: DESKTOP_WINDOW_SIZE.width,
          cardsFitWidth: true,
          controlsFitWidth: true,
        });
        expect(metrics.stageWidth).toBe(
          DESKTOP_WINDOW_SIZE.width - metrics.sidebarWidth - 2,
        );
        expect(metrics.headerHeight).toBe(48);
        expect(metrics.headingVisible).toBe(false);
        expect(metrics.pagePaddingTop).toBe(18);
        expect(metrics.pagePaddingBottom).toBe(18);
        expect(metrics.pagePaddingLeft).toBe(20);
        expect(metrics.pagePaddingRight).toBe(20);
        expect(metrics.pageContentLeftInset).toBe(
          metrics.pageContentRightInset,
        );
        expect(metrics.cardCount).toBeGreaterThan(0);
        if (metrics.cardHeaderHeights.length > 0) {
          expect(new Set(metrics.cardHeaderHeights)).toEqual(new Set([48]));
          expect(metrics.cardHeadersSingleRow).toBe(true);
        }
        expect(metrics.appScrollHeight).toBe(metrics.appClientHeight);
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
        expect(metrics.scrollTopAfter).toBe(
          Math.max(0, metrics.scrollHeight - metrics.clientHeight),
        );
      },
    );

    it("wraps and exposes the complete Obsidian path", async () => {
      const metrics = await measurePage("dark", "settings");

      expect(metrics.pathTextOverflow).not.toBe("ellipsis");
      expect(metrics.pathOverflowWrap).toBe("anywhere");
      expect(metrics.pathScrollWidth).toBeLessThanOrEqual(
        metrics.pathClientWidth ?? 0,
      );
    });

    it("keeps decision history columns aligned in an internally scrolling list", async () => {
      const metrics = await measurePage("dark", "decisions");

      expect(metrics.decisionColumnCount).toBe(6);
      expect(metrics.decisionColumnsAligned).toBe(true);
      expect(metrics.decisionListOverflowY).toBe("auto");
      expect(metrics.decisionListScrollbarWidth).toBe("none");
      expect(metrics.decisionListWebkitScrollbarDisplay).toBe("none");
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    });

    it("keeps semantic mode outside the focused decision search field", async () => {
      const metrics = await measurePage(
        "dark",
        "decisions",
        "decision-search",
      );

      expect(metrics).toMatchObject({
        controlsFitWidth: true,
        decisionSearchClearVisible: true,
        decisionSearchFocused: true,
        decisionSearchModeDefaultOff: true,
        decisionSearchModeEnabled: true,
        decisionSearchModeOutsideField: true,
        decisionSearchSingleRow: true,
      });
    });

    it("keeps the decision toolbar still while switching quick filters", async () => {
      const metrics = await measurePage(
        "dark",
        "decisions",
        "decision-filter-stability",
      );

      expect(metrics.decisionFilterObservedCounts?.length).toBeGreaterThan(1);
      expect(metrics.decisionFilterLoadingFlash).toBe(false);
      expect(metrics.decisionFilterMaximumShift).toBeLessThan(1);
      expect(metrics.decisionFilterToolbarStable).toBe(true);
    });

    it("edits a decision outcome in a centered dialog without moving the history list", async () => {
      const metrics = await measurePage(
        "dark",
        "decisions",
        "decision-outcome",
      );

      expect(metrics).toMatchObject({
        outcomeDialogCentered: true,
        outcomeEditorFocused: true,
        outcomeEditorInsideDialog: true,
        outcomeEditorVisible: true,
        outcomeListHeightStable: true,
      });
    });

    it("reviews expected and actual results in one compact verdict row", async () => {
      const metrics = await measurePage("dark", "decisions", "decision-review");

      expect(metrics).toMatchObject({
        reviewDialogCentered: true,
        reviewEditorFocused: true,
        reviewEditorInsideDialog: true,
        reviewEditorVisible: true,
        reviewListHeightStable: true,
        reviewVerdictCount: 5,
        reviewVerdictSingleRow: true,
      });
    });

    it("schedules a review in a compact dialog without moving the history list", async () => {
      const metrics = await measurePage(
        "dark",
        "decisions",
        "decision-schedule",
      );

      expect(metrics).toMatchObject({
        scheduleDateVisible: true,
        scheduleDialogCentered: true,
        scheduleEditorInsideDialog: true,
        scheduleEditorVisible: true,
        scheduleListHeightStable: true,
        scheduleNoWakeCopyVisible: true,
        schedulePresetCount: 3,
        schedulePresetsSingleRow: true,
      });
    });

    it("links actually used principles in a compact two-column editor", async () => {
      const metrics = await measurePage(
        "dark",
        "decisions",
        "decision-principles",
      );

      expect(metrics).toMatchObject({
        decisionPrincipleDialogCentered: true,
        decisionPrincipleEditorInsideDialog: true,
        decisionPrincipleChoicesTwoColumns: true,
        decisionPrincipleSafetyCopyVisible: true,
        decisionPrincipleListHeightStable: true,
      });
      expect(metrics.decisionPrincipleChoiceCount).toBeGreaterThan(0);
    });

    it("keeps methodology columns aligned and scrolls inside the record card", async () => {
      const metrics = await measurePage("dark", "methodology");

      expect(metrics.methodologyColumnCount).toBe(6);
      expect(metrics.methodologyColumnsAligned).toBe(true);
      expect(metrics).toMatchObject({
        methodologyActiveIndicatorHeight: "2px",
        methodologyStatusFilterBackground: "rgba(0, 0, 0, 0)",
        methodologyStatusFilterBorderWidth: "0px",
        methodologyViewTabsBackground: "rgba(0, 0, 0, 0)",
        methodologyViewTabsBorderWidth: "0px",
      });
      expect(metrics.methodologyToolbarHeight).toBeLessThanOrEqual(46);
      expect(metrics.methodologyRecordsToolbarHeight).toBeLessThanOrEqual(42);
      expect(metrics.methodologyToolbarsSingleRow).toBe(true);
      expect(metrics.methodologyBuildGuideVisible).toBe(true);
      expect(metrics.methodologyBuildMetricCount).toBe(5);
      expect(metrics.methodologyBuildMetricsSingleRow).toBe(true);
      expect(metrics.methodologyBuildPathCount).toBe(3);
      expect(metrics.methodologyBuildPathSingleRow).toBe(true);
      expect(metrics.methodologyBuildActionCount).toBeGreaterThanOrEqual(2);
      expect(metrics.methodologyBuildActionsFit).toBe(true);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    });

    it("keeps the combined methodology toolbar on one line at minimum width", async () => {
      const metrics = await measurePage("dark", "methodology", "compact");

      expect(metrics.viewportWidth).toBe(DESKTOP_WINDOW_MIN_SIZE.width);
      expect(metrics).toMatchObject({
        controlsFitWidth: true,
        methodologyBuildActionsFit: true,
        methodologyBuildMetricsSingleRow: true,
        methodologyBuildPathSingleRow: true,
        methodologyToolbarsSingleRow: true,
      });
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    });

    it("shows all principle creation paths in one compact chooser", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-create",
      );

      expect(metrics).toMatchObject({
        methodologyCreateCentered: true,
        methodologyCreateInsideDialog: true,
        methodologyCreateOptionCount: 3,
        methodologyCreateOptionsSingleRow: true,
        methodologyCreateBoundaryCount: 3,
        methodologyCreateNoModelVisible: true,
        methodologyCreateHorizontalOverflow: false,
      });
    });

    it("consolidates secondary methodology queues in one compact workbench", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-workbench",
      );

      expect(metrics).toMatchObject({
        methodologyWorkbenchCentered: true,
        methodologyWorkbenchInsideDialog: true,
        methodologyWorkbenchCardCount: 3,
        methodologyWorkbenchCardsSingleRow: true,
        methodologyWorkbenchBoundaryVisible: true,
        methodologyWorkbenchHorizontalOverflow: false,
        methodologyWorkbenchToolbarStable: true,
      });
    });

    it("keeps review material in a compact persistent inbox", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-materials",
      );

      expect(metrics).toMatchObject({
        methodologyMaterialsCentered: true,
        methodologyMaterialsInsideDialog: true,
        methodologyMaterialsModeCount: 2,
        methodologyMaterialsModesSingleRow: true,
        methodologyMaterialsCardCount: 1,
        methodologyMaterialsSourceCount: 1,
        methodologyMaterialsActionCount: 2,
        methodologyMaterialsActionsSingleRow: true,
        methodologyMaterialsBoundaryCount: 3,
        methodologyMaterialsBoundarySingleRow: true,
        methodologyMaterialsNoAutomaticCopy: true,
        methodologyMaterialsHorizontalOverflow: false,
        methodologyMaterialsToolbarStable: true,
      });
    });

    it("keeps principle validation compact and explicitly human-controlled", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-validation",
      );

      expect(metrics).toMatchObject({
        methodologyValidationCentered: true,
        methodologyValidationInsideDialog: true,
        methodologyValidationCardCount: 1,
        methodologyValidationMetricCount: 3,
        methodologyValidationDecisionCount: 3,
        methodologyValidationDecisionsSingleRow: true,
        methodologyValidationActionCount: 2,
        methodologyValidationActionsSingleRow: true,
        methodologyValidationHumanBoundaryVisible: true,
        methodologyValidationHorizontalOverflow: false,
        methodologyValidationToolbarStable: true,
      });
    });

    it("keeps model-free manual principle entry compact and explicit", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-manual-entry",
      );

      expect(metrics).toMatchObject({
        methodologyManualCentered: true,
        methodologyManualInsideDialog: true,
        methodologyManualFieldCount: 4,
        methodologyManualBoundaryFieldsSingleRow: true,
        methodologyManualSafetyVisible: true,
        methodologyManualSaveVisible: true,
        methodologyManualHorizontalOverflow: false,
        methodologyManualNoModelCopy: true,
      });
    });

    it("keeps evidence-backed manual principle entry in one model-free dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-manual-evidence",
      );

      expect(metrics).toMatchObject({
        methodologyManualEvidenceCentered: true,
        methodologyManualEvidenceInsideDialog: true,
        methodologyManualEvidenceDialogCount: 1,
        methodologyManualEvidenceSourceCount: 2,
        methodologyManualEvidenceSourcesSingleRow: true,
        methodologyManualEvidenceFieldCount: 5,
        methodologyManualEvidenceBoundaryCount: 3,
        methodologyManualEvidenceBoundarySingleRow: true,
        methodologyManualEvidenceNoModelVisible: true,
        methodologyManualEvidenceSaveVisible: true,
        methodologyManualEvidenceHorizontalOverflow: false,
      });
    });

    it("opens the methodology evidence chooser without moving the list", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-source",
      );

      expect(metrics).toMatchObject({
        methodologyChooserCentered: true,
        methodologySourceListInsideDialog: true,
        methodologySuggestionPickerInsideDialog: true,
        methodologyGenerateActionVisible: true,
        methodologyManualEvidenceActionVisible: true,
        methodologySourceActionsSingleRow: true,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologySourceCount).toBeGreaterThan(0);
      expect(metrics.methodologySuggestionCount).toBeGreaterThan(0);
    });

    it("keeps batch extraction explicit, compact, and non-destructive", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-batch",
      );

      expect(metrics).toMatchObject({
        methodologyBatchCentered: true,
        methodologyBatchInsideDialog: true,
        methodologyBatchActionVisible: true,
        methodologyBatchSafetyCopyVisible: true,
        methodologyListHeightStable: true,
      });
    });

    it("labels imported Markdown as unverified inside a contained detail dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-import-detail",
      );

      expect(metrics).toMatchObject({
        methodologyImportDetailCentered: true,
        methodologyImportDetailInsideDialog: true,
        methodologyImportSourceNoteVisible: true,
        methodologyImportProvenanceVisible: true,
        methodologyImportTagVisible: true,
        methodologyImportAcceptVisible: true,
        methodologyListHeightStable: true,
      });
    });

    it("previews Markdown candidates before any methodology is written", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-import-preview",
      );

      expect(metrics).toMatchObject({
        methodologyImportPreviewCentered: true,
        methodologyImportPreviewInsideDialog: true,
        methodologyImportPreviewSummaryCount: 4,
        methodologyImportPreviewCandidateCount: 1,
        methodologyImportPreviewSelectedCount: 1,
        methodologyImportPreviewActionVisible: true,
        methodologyImportPreviewSafetyVisible: true,
        methodologyImportPreviewHorizontalOverflow: false,
      });
    });

    it("returns linked evidence to the same compact methodology detail", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-evidence-link",
      );

      expect(metrics).toMatchObject({
        methodologyEvidenceLinkCentered: true,
        methodologyEvidenceLinkInsideDialog: true,
        methodologyEvidenceAdjustVisible: true,
        methodologyEvidenceSuggestionsHidden: true,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyEvidenceLinkCount).toBe(2);
    });

    it("shows explainable evidence matches in a compact searchable chooser", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-evidence-match",
      );

      expect(metrics).toMatchObject({
        methodologyEvidenceMatchCentered: true,
        methodologyEvidenceMatchInsideDialog: true,
        methodologyEvidenceMatchReasonVisible: true,
        methodologyEvidenceSearchVisible: true,
        methodologyEvidenceSourceListInsideDialog: true,
        methodologyEvidenceMatchCompact: true,
        methodologyEvidenceSuggestionsHidden: true,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyEvidenceMatchCount).toBeGreaterThan(0);
    });

    it("shows source decisions and confirmation in the methodology detail dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-detail",
      );

      expect(metrics).toMatchObject({
        methodologyDetailCentered: true,
        methodologyDetailInsideDialog: true,
        methodologyAcceptVisible: true,
        methodologyQualityVisible: true,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyEvidenceCount).toBeGreaterThan(0);
      expect(metrics.methodologyRelationCount).toBeGreaterThan(0);
    });

    it("shows accepted principle usage as a compact non-causal distribution", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-usage",
      );

      expect(metrics).toMatchObject({
        methodologyUsageCentered: true,
        methodologyUsageInsideDialog: true,
        methodologyUsageMetricCount: 4,
        methodologyUsageMetricsSingleRow: true,
        methodologyUsageCausalityVisible: true,
        methodologyUsageHorizontalOverflow: false,
        methodologyUsageControlsInsideDialog: true,
        methodologyUsageFilterCount: 5,
        methodologyUsageFiltersSingleRow: true,
        methodologyUsageNextActionVisible: true,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyUsageRecordActionCount).toBeGreaterThan(0);
    });

    it("builds a compact revision candidate from reviewed usage without stacking dialogs", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-evolution",
      );

      expect(metrics).toMatchObject({
        methodologyEvolutionCentered: true,
        methodologyEvolutionInsideDialog: true,
        methodologyEvolutionHeaderSingleRow: true,
        methodologyEvolutionFieldCount: 5,
        methodologyEvolutionBoundaryCount: 3,
        methodologyEvolutionNewEvidenceSelected: true,
        methodologyEvolutionSaveVisible: true,
        methodologyEvolutionHorizontalOverflow: false,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyEvolutionEvidenceCount).toBeGreaterThan(1);
    });

    it("restores a revision draft against the current source version", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-evolution-recovery",
      );

      expect(metrics).toMatchObject({
        methodologyEvolutionCentered: true,
        methodologyEvolutionInsideDialog: true,
        methodologyEvolutionRecoveryStatusVisible: true,
        methodologyEvolutionRecoveryNoticeVisible: true,
        methodologyEvolutionRecoveryTitleRestored: true,
        methodologyEvolutionRecoveryActionsVisible: true,
        methodologyEvolutionHorizontalOverflow: false,
        methodologyListHeightStable: true,
      });
    });

    it("compares a stale revision draft in a compact three-way migration dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-evolution-rebase",
      );

      expect(metrics).toMatchObject({
        methodologyEvolutionRebaseCentered: true,
        methodologyEvolutionRebaseInsideDialog: true,
        methodologyEvolutionRebaseColumnsAligned: true,
        methodologyEvolutionRebaseUnresolvedVisible: true,
        methodologyEvolutionRebaseActionDisabled: true,
        methodologyEvolutionRebaseFooterVisible: true,
        methodologyEvolutionRebaseHorizontalOverflow: false,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyEvolutionRebaseFieldCount).toBeGreaterThan(1);
    });

    it("reviews a detected principle relationship without stacking dialogs", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-relation-review",
      );

      expect(metrics).toMatchObject({
        methodologyRelationDialogCentered: true,
        methodologyRelationEditorInsideDialog: true,
        methodologyRelationOptionsSingleColumn: true,
        methodologyRelationNoteVisible: true,
        methodologyRelationSafetyCopyVisible: true,
        methodologyRelationSaveVisible: true,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyRelationOptionCount).toBe(3);
    });

    it("reviews all unresolved relationships in one compact comparison queue", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-relation-queue",
      );

      expect(metrics).toMatchObject({
        methodologyRelationQueueCentered: true,
        methodologyRelationQueueInsideDialog: true,
        methodologyRelationQueueComparisonSingleRow: true,
        methodologyRelationQueueOptionsSingleRow: true,
        methodologyRelationQueueProgressVisible: true,
        methodologyRelationQueueNoteVisible: true,
        methodologyRelationQueueSafetyVisible: true,
        methodologyRelationQueueSaveVisible: true,
        methodologyListHeightStable: true,
      });
      expect(metrics.methodologyRelationQueueComparisonCount).toBe(2);
      expect(metrics.methodologyRelationQueueOptionCount).toBe(3);
    });

    it("keeps the explicit quality-risk confirmation and action visible", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-quality-confirm",
      );

      expect(metrics).toMatchObject({
        methodologyDetailCentered: true,
        methodologyListHeightStable: true,
        methodologyQualityConfirmationVisible: true,
        methodologyQualityConfirmActionVisible: true,
      });
    });

    it("keeps the accepted methodology graph readable inside the record card", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-graph",
      );

      expect(metrics).toMatchObject({
        methodologyGraphInsideCard: true,
        methodologyGraphHorizontalOverflow: false,
        methodologyTabCount: 4,
        methodologyGraphTabSelected: true,
        methodologyGraphSearchVisible: true,
        methodologyGraphToolbarSingleRow: true,
        methodologyGraphSummaryCount: 5,
        methodologyGraphEvidenceColumnCount: 3,
      });
      expect(metrics.methodologyGraphProjectCount).toBeGreaterThan(0);
      expect(metrics.methodologyGraphPrincipleCount).toBeGreaterThan(0);
      expect(metrics.methodologyGraphRelationCount).toBeGreaterThan(0);
    });

    it("completes missing pairwise facts inside a bounded multi-source merge dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-merge-draft",
      );

      expect(metrics).toMatchObject({
        methodologyMergeCentered: true,
        methodologyMergeInsideDialog: true,
        methodologyMergeDialogCount: 1,
        methodologyMergeSourceCount: 4,
        methodologyMergeSourcesSingleRow: true,
        methodologyMergeFieldCount: 5,
        methodologyMergeSafetyVisible: true,
        methodologyMergeGroupRuleVisible: true,
        methodologyMergeSourceLimitVisible: true,
        methodologyMergeRelationReviewCount: 2,
        methodologyMergeRelationOutcomeVisible: true,
        methodologyMergeActionVisible: true,
        methodologyMergeHorizontalOverflow: false,
        methodologyMergeGraphHeightStable: true,
      });
      expect(metrics.methodologyMergeEvidenceCount).toBeGreaterThan(0);
    });

    it("focuses one missing relationship without stacking another dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-merge-relation-review",
      );

      expect(metrics).toMatchObject({
        methodologyMergeRelationCentered: true,
        methodologyMergeRelationInsideDialog: true,
        methodologyMergeRelationDialogCount: 1,
        methodologyMergeRelationSourceCount: 3,
        methodologyMergeRelationPairCount: 2,
        methodologyMergeRelationActionCount: 3,
        methodologyMergeRelationProgressVisible: true,
        methodologyMergeRelationComposeHidden: true,
        methodologyMergeRelationHorizontalOverflow: false,
      });
    });

    it("restores a saved multi-source merge without losing its compact editor", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-merge-recovery",
      );

      expect(metrics).toMatchObject({
        methodologyMergeRecoveryStatusVisible: true,
        methodologyMergeRecoveryNoticeVisible: true,
        methodologyMergeRecoveryTitleRestored: true,
        methodologyMergeRecoveryActionsVisible: true,
        methodologyMergeRecoveryHorizontalOverflow: false,
        methodologyMergeSourceCount: 4,
        methodologyMergeDialogCount: 1,
      });
    });

    it("keeps merge source cleanup explicit and contained in one dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-merge-lifecycle",
      );

      expect(metrics).toMatchObject({
        methodologyMergeLifecycleCentered: true,
        methodologyMergeLifecycleInsideDialog: true,
        methodologyMergeLifecycleStepCount: 3,
        methodologyMergeLifecycleSourceCount: 3,
        methodologyMergeLifecycleAssetCount: 1,
        methodologyMergeLifecycleActionVisible: true,
        methodologyMergeLifecycleSafetyVisible: true,
        methodologyMergeLifecycleHorizontalOverflow: false,
      });
    });

    it("keeps local batch analytics aligned inside the methodology card", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-analysis",
      );

      expect(metrics).toMatchObject({
        analyticsInsideCard: true,
        analyticsHorizontalOverflow: false,
        analyticsSummaryCount: 4,
        analyticsGroupColumnCount: 6,
        analyticsGroupColumnsAligned: true,
        analyticsRefreshVisible: true,
        consultationMetricsCount: 4,
        consultationMetricsSingleRow: true,
        consultationInsideCard: true,
        consultationPrivacyVisible: true,
      });
    });

    it("keeps the one-time consultation preview explicit and contained", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-consultation",
      );

      expect(metrics).toMatchObject({
        consultationPreviewCentered: true,
        consultationPreviewInsideDialog: true,
        consultationPreviewFieldCount: 3,
        consultationPreviewOptionCount: 2,
        consultationPreviewOptionsSingleRow: true,
        consultationPreviewActionsSingleRow: true,
        consultationPreviewBoundaryVisible: true,
        consultationPreviewFeedbackVisible: true,
        consultationPreviewFeedbackButtons: 3,
        consultationPreviewFeedbackSingleRow: true,
        consultationPreviewHorizontalOverflow: false,
      });
    });

    it("keeps local analytics controls and columns inside the minimum width", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "methodology-analysis-compact",
      );

      expect(metrics.viewportWidth).toBe(DESKTOP_WINDOW_MIN_SIZE.width);
      expect(metrics).toMatchObject({
        controlsFitWidth: true,
        analyticsInsideCard: true,
        analyticsHorizontalOverflow: false,
        analyticsGroupColumnsAligned: true,
        consultationMetricsCount: 4,
        consultationMetricsSingleRow: false,
        consultationInsideCard: true,
        consultationPrivacyVisible: true,
      });
    });

    it("keeps skill and workflow drafts aligned inside the methodology card", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-assets",
      );

      expect(metrics).toMatchObject({
        practiceAssetsInsideCard: true,
        practiceAssetsToolbarInsideMain: true,
        practiceAssetsToolbarHeightMatches: true,
        practiceAssetsFiltersSingleRow: true,
        practiceAssetsViewTabCount: 4,
        practiceAssetsHorizontalOverflow: false,
        practiceAssetColumnCount: 6,
      });
      expect(metrics.practiceAssetRowCount).toBeGreaterThan(0);
    });

    it("keeps skill and workflow drafts inside the minimum desktop width", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-assets-compact",
      );

      expect(metrics.viewportWidth).toBe(DESKTOP_WINDOW_MIN_SIZE.width);
      expect(metrics).toMatchObject({
        controlsFitWidth: true,
        practiceAssetsInsideCard: true,
        practiceAssetsToolbarInsideMain: true,
        practiceAssetsToolbarHeightMatches: true,
        practiceAssetsFiltersSingleRow: true,
        practiceAssetsViewTabCount: 4,
        practiceAssetsHorizontalOverflow: false,
      });
    });

    it("shows the practice type and accepted-principle chooser in one dialog", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-source",
      );

      expect(metrics).toMatchObject({
        practiceChooserCentered: true,
        practiceTypeCount: 2,
        practiceTypesSingleRow: true,
        practiceSubmitVisible: true,
        practiceManualActionVisible: true,
        practiceCreationBoundaryCount: 3,
      });
      expect(metrics.practicePrincipleCount).toBeGreaterThan(0);
    });

    it("keeps manual practice drafting compact, traceable, and model-free", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-manual",
      );

      expect(metrics).toMatchObject({
        practiceManualCentered: true,
        practiceManualInsideDialog: true,
        practiceManualFieldCount: 6,
        practiceManualTwoColumnRows: true,
        practiceManualSourceVisible: true,
        practiceManualSafetyVisible: true,
        practiceManualSaveVisible: true,
        practiceManualHorizontalOverflow: false,
        practiceManualNoModelCopy: true,
      });
    });

    it("shows source principles and the explicit-publication boundary in practice detail", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-detail",
      );

      expect(metrics).toMatchObject({
        practiceDetailCentered: true,
        practiceDetailInsideDialog: true,
        practiceAcceptVisible: true,
        practiceInstallBoundaryVisible: true,
      });
      expect(metrics.practiceStepCount).toBeGreaterThanOrEqual(3);
    });

    it("keeps explicit client publication compact and inside practice detail", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-publication",
      );

      expect(metrics).toMatchObject({
        practicePublicationInsideDialog: true,
        practicePublicationCardCount: 2,
        practicePublicationColumnCount: 2,
        practicePublicationActionsVisible: true,
        practiceSourceCollapsed: true,
      });
    });

    it("shows updated-source state without allowing an implicit client overwrite", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-freshness",
      );

      expect(metrics).toMatchObject({
        practiceDetailCentered: true,
        practiceFreshnessVisible: true,
        practiceRegenerateVisible: true,
        practicePublishPaused: true,
        practiceRollbackVisible: true,
        practiceSourceDiffVisible: true,
        practiceSourceFieldChangeCount: 1,
      });
    });

    it("compares and confirms a restorable practice asset version inside the detail", async () => {
      const metrics = await measurePage(
        "dark",
        "methodology",
        "practice-history",
      );

      expect(metrics).toMatchObject({
        practiceDetailCentered: true,
        practiceHistoryVisible: true,
        practiceHistoryVersionCount: 2,
        practiceHistoryComparisonVisible: true,
        practiceHistoryRestoreConfirmationVisible: true,
      });
    });

    it("shows both clients, loaded model profiles, and trace rows", async () => {
      const [clients, models, activity] = await Promise.all([
        measurePage("dark", "clients"),
        measurePage("dark", "models"),
        measurePage("dark", "activity"),
      ]);

      expect(clients.clientCardCount).toBe(2);
      expect(models.modelProfileVisible).toBe(true);
      expect(models.providerSwitchCount).toBe(4);
      expect(models.providerDragHandleCount).toBe(4);
      expect(models.providerLegacyMoveActionsVisible).toBe(false);
      expect(Math.max(...models.providerRowHeights)).toBeLessThanOrEqual(66);
      for (const positions of [
        models.providerStatusLefts,
        models.providerSwitchLefts,
        models.providerActionLefts,
        models.providerTestActionLefts,
      ]) {
        const visiblePositions = positions.filter(
          (position): position is number => position !== null,
        );
        expect(
          Math.max(...visiblePositions) - Math.min(...visiblePositions),
        ).toBeLessThanOrEqual(1);
      }
      expect(activity.traceRowVisible).toBe(true);
      expect(activity.activityRecognitionVisible).toBe(true);
    });

    it("keeps model traces contained without showing a scrollbar", async () => {
      const metrics = await measurePage("dark", "activity");

      expect(metrics.traceColumnCount).toBe(6);
      expect(metrics.traceColumnsAligned).toBe(true);
      expect(metrics.traceCardBottom).toBeCloseTo(
        metrics.traceContentBottom,
        0,
      );
      expect(metrics.traceListOverflowY).toBe("auto");
      expect(metrics.traceListScrollHeight).toBeGreaterThanOrEqual(
        metrics.traceListClientHeight ?? 0,
      );
      expect(metrics.traceListScrollTopAfter).toBe(
        (metrics.traceListScrollHeight ?? 0) -
          (metrics.traceListClientHeight ?? 0),
      );
      expect(metrics.traceListScrollbarWidth).toBe("none");
      expect(metrics.traceListWebkitScrollbarDisplay).toBe("none");
    });

    it("keeps the visible model trace columns aligned in a compact window", async () => {
      const metrics = await measurePage("dark", "activity", "compact");

      expect(metrics.viewportHeight).toBe(DESKTOP_WINDOW_MIN_SIZE.height);
      expect(metrics.viewportWidth).toBe(DESKTOP_WINDOW_MIN_SIZE.width);
      expect(metrics.traceColumnCount).toBe(4);
      expect(metrics.traceColumnsAligned).toBe(true);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    });

    it("opens the add-backend editor in a centered dialog without moving the page", async () => {
      const metrics = await measurePage("dark", "models", "add-backend");

      expect(metrics).toMatchObject({
        addButtonExpanded: true,
        addButtonLabel: "添加模型后端",
        dialogCentered: true,
        editorInsideDialog: true,
        editorVisible: true,
        firstEditorControlFocused: true,
        listTopStable: true,
        pageScrollHeightStable: true,
      });
      expect(metrics.editorTop).toBeGreaterThan(0);
    });

    it("opens model trace details in a centered dialog without expanding a row", async () => {
      const metrics = await measurePage("dark", "activity", "trace-detail");

      expect(metrics).toMatchObject({
        traceDetailDialogCentered: true,
        traceDetailInsideDialog: true,
        traceDetailOpen: true,
        traceListHeightStable: true,
        traceListScrollHeightStable: true,
        traceRowHeightStable: true,
      });
      expect(metrics.traceDetailBackgroundImage).toContain("radial-gradient");
      expect(metrics.traceDetailBackgroundImage).toContain("linear-gradient");
      expect(metrics.traceDetailSurfaceFilter).toContain("blur(24px)");
      expect(metrics.traceDetailBackdropFilter).toContain("blur(24px)");
      expect(alphaOf(metrics.tokens.modalSurface)).toBeGreaterThanOrEqual(0.92);
      expect(alphaOf(metrics.tokens.modalBackdrop)).toBeGreaterThanOrEqual(
        0.52,
      );
    });

    it.each([
      {
        theme: "light" as const,
        maximumComposite: 0.42,
        maximumHighlight: 0.4,
        maximumToolbar: 0.14,
      },
      {
        theme: "dark" as const,
        maximumComposite: 0.58,
        maximumHighlight: 0.16,
        maximumToolbar: 0.2,
      },
    ])(
      "keeps $theme desktop glass translucent",
      async ({ theme, maximumComposite, maximumHighlight, maximumToolbar }) => {
        const metrics = await measurePage(theme, "settings");
        expect(metrics.backdropFilter).toContain("blur(24px)");
        expect(alphaOf(metrics.tokens.windowHighlight)).toBeLessThanOrEqual(
          maximumHighlight,
        );
        expect(alphaOf(metrics.tokens.toolbar)).toBeLessThanOrEqual(
          maximumToolbar,
        );
        expect(
          compositeAlpha(
            alphaOf(metrics.tokens.window),
            alphaOf(metrics.tokens.surface),
          ),
        ).toBeLessThanOrEqual(maximumComposite);
      },
    );
  },
);
