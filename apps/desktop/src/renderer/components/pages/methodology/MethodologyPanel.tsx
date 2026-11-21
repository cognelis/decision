import { plainHeadline } from "../../question-title.js";
import { zonedFormatter } from "../../../calendar-date.js";
import { IconButton, ActionIcon } from "../../IconButton.js";
import type { DecisionBrowseFilter } from "../decisions/DecisionLibraryPanel.js";
import type {
  KnowledgeGraphSnapshot,
  MethodologyEvidenceMatch,
  MethodologyQualityRelation,
  MethodologyRelationDisposition,
  MethodologyStatus,
  MethodologySuggestion,
} from "@cognelis/decision-core";
import { Fragment, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";

import type {
  DecisionLibraryItem,
  MethodologyBuildProgress,
  MethodologyEvidenceManualInput,
  MethodologyEvolutionInput,
  MethodologyItem,
  MethodologyImportPreview,
  ManualFormDraft,
  MethodologyManualInput,
  MethodologyMergeLifecyclePlan,
  MethodologyMergeInput,
  MethodologyRevisionInput,
  MethodologyUsageSnapshot,
  MethodologyValidationItem,
  MethodologyVersionItem,
  MethodologyWorkspaceApi,
} from "../../../../shared/renderer-api.js";
import { methodologyRevisionBasis } from "../../../../shared/methodology-basis.js";
import { ModalDialog, usePageShownAgain } from "../../ModalDialog.js";
import { DecisionAnalyticsView } from "./DecisionAnalyticsView.js";
import { KnowledgeGraphView } from "./KnowledgeGraphView.js";
import { PracticeAssetsView } from "./PracticeAssetsView.js";
import {
  mergeEvidence,
  mergeEvidenceSummary,
  sameIdSet,
  updateMergeSources,
  type MethodologyMergeDraftState,
} from "./methodology-merge-model.js";
import {
  allPairsConfirmedDuplicate,
  assessMergeCandidate,
  buildRelationReviewQueue,
  confirmedDuplicate,
  qualityBadgeFor,
  type MethodologyMergeCandidateAssessment,
  type MethodologyRelationReviewItem,
} from "./methodology-relation-model.js";
import type {
  MethodologyNotice,
  MethodologyView,
  MethodologyWorkspaceHost,
  StatusFilter,
} from "./methodology-view-types.js";
import { useEvidenceLinking } from "./use-evidence-linking.js";
import { useManualDrafting } from "./use-manual-drafting.js";
import { useSuggestionInbox } from "./use-suggestion-inbox.js";
import { useMarkdownImport } from "./use-markdown-import.js";
import { useValidationInbox } from "./use-validation-inbox.js";
import {
  methodologyRevisionFields,
  revisionFrom,
  usePrincipleEvolution,
  type MethodologyRevisionField,
  type MethodologyRevisionFormDraft,
} from "./use-principle-evolution.js";
import { useRelationReview } from "./use-relation-review.js";
import {
  useMergeWorkbench,
  type MethodologyMergeFormDraft,
} from "./use-merge-workbench.js";

interface MethodologyPanelProps {
  api: MethodologyWorkspaceApi;
  /** Principle notes that could not be read, and so are in no list: said, until they read again. */
  unreadableNotice?: string | null;
  /** A principle to open on arrival, from quick jump. */
  initialPrincipleId?: string | null;
  initialSourceDecisionId?: string | null;
  /**
   * A tab asked for, such as the retrospective under 分析: shown on arrival, and when asked for
   * while the page is already open. Null when nothing is asked for.
   */
  initialView?: MethodologyView | null;
  onInitialSourceConsumed?(): void;
  onOpenDecision(id: string): void;
  /** Opens the knowledge page already narrowed by these filters. */
  onBrowseDecisions(filter: DecisionBrowseFilter): void;
  onInitialNavigationConsumed?(): void;
}

type MethodologyCreationMode = "chooser" | "manual" | null;

type MethodologyUsageFilter =
  "all" | "pending_outcome" | "pending_review" | "reviewed" | "attention";

const methodologyUsageFilterLabels: Record<MethodologyUsageFilter, string> = {
  all: "全部",
  pending_outcome: "待结果",
  pending_review: "待复盘",
  reviewed: "已复盘",
  attention: "需关注",
};

const methodologyUsageFilterOrder = Object.keys(
  methodologyUsageFilterLabels,
) as MethodologyUsageFilter[];

const matchesMethodologyUsageFilter = (
  decision: MethodologyUsageSnapshot["decisions"][number],
  filter: MethodologyUsageFilter,
): boolean => {
  if (filter === "all") return true;
  if (filter === "pending_outcome") return decision.outcome === null;
  if (filter === "pending_review") {
    return decision.outcome !== null && decision.outcomeReview === null;
  }
  if (filter === "reviewed") return decision.outcomeReview !== null;
  return (
    decision.outcomeReview?.verdict === "mixed" ||
    decision.outcomeReview?.verdict === "worse"
  );
};

const methodologyUsageDecisionLabel = (
  decision: MethodologyUsageSnapshot["decisions"][number],
): string => {
  if (decision.outcome === null) return "待记录结果";
  if (decision.outcomeReview === null) return "待复盘";
  return verdictLabels[decision.outcomeReview.verdict];
};

const methodologyViews: Array<{
  value: MethodologyView;
  label: string;
  icon: ComponentProps<typeof ActionIcon>["name"];
}> = [
  { value: "records", label: "原则", icon: "principles" },
  { value: "analysis", label: "分析", icon: "analysis" },
  { value: "graph", label: "图谱", icon: "graph" },
  { value: "assets", label: "技能与流程", icon: "flow" },
];

const statusLabels: Record<MethodologyStatus, string> = {
  candidate: "待确认",
  accepted: "已采纳",
  retired: "已归档",
  dismissed: "已忽略",
};

const suggestionReadinessLabels: Record<
  MethodologySuggestion["readiness"],
  string
> = {
  strong: "较强证据",
  ready: "可提炼",
  exploratory: "探索性",
};

const suggestionDirectionLabels: Record<
  MethodologySuggestion["direction"],
  string
> = {
  favorable: "已验证做法",
  attention: "待修正模式",
  unclear: "仍需观察",
};

const evidenceMatchLabels: Record<
  MethodologyEvidenceMatch["strength"],
  string
> = {
  strong: "较匹配",
  possible: "可核对",
};

const relationDispositionLabels: Record<
  MethodologyRelationDisposition,
  string
> = {
  duplicate: "确认重复",
  conflict: "确认冲突",
  unrelated: "确认无关",
};

const methodologyHistoryReasonLabels: Record<
  MethodologyVersionItem["reason"],
  string
> = {
  revision_applied: "应用修订前",
  restore_checkpoint: "恢复旧版前",
  evidence_changed: "调整证据前",
};

const verdictLabels: Record<
  NonNullable<DecisionLibraryItem["outcomeReview"]>["verdict"],
  string
> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

/** Groups one 批量生成 turns into candidates, each a call to the generation model; the rest wait for the next. */
const SUGGESTION_BATCH_SIZE = 6;

const dateFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const methodologyVersionDiffs = (
  current: MethodologyItem,
  version: MethodologyVersionItem,
): Array<{ label: string; before: string; after: string }> =>
  [
    { label: "标题", before: version.snapshot.title, after: current.title },
    {
      label: "原则",
      before: version.snapshot.principle,
      after: current.principle,
    },
    {
      label: "适用条件",
      before: version.snapshot.appliesWhen,
      after: current.appliesWhen,
    },
    {
      label: "注意事项",
      before: version.snapshot.caution,
      after: current.caution,
    },
    {
      label: "证据摘要",
      before: version.snapshot.evidenceSummary,
      after: current.evidenceSummary,
    },
  ].filter((field) => field.before !== field.after);

// By the decisions behind it as well, as the graph and consult_decision_principles word it: adopted at low
// confidence, a principle backed by three decisions read 单点证据. Counted here by its reviewed evidence, where the
// graph and the tool count its source decisions: one principle can carry two counts.
// Its colour comes from the same count as its words: taken from the model's confidence, 单点证据 read green.
const confidenceFor = ({
  quality: { evidenceCount, recommendedConfidence },
}: MethodologyItem): { label: string; tone: "ok" | "warn" | "neutral" } =>
  evidenceCount === 0 ? { label: "待验证", tone: "neutral" }
    : evidenceCount === 1 ? { label: "单点证据", tone: "neutral" }
      : recommendedConfidence === "high" ? { label: "稳定模式", tone: "ok" }
        : recommendedConfidence === "medium" ? { label: "多条印证", tone: "ok" }
          : { label: "低可信", tone: "warn" };

export const MethodologyPanel = ({
  api,
  unreadableNotice = null,
  initialPrincipleId = null,
  initialSourceDecisionId = null,
  initialView = null,
  onInitialSourceConsumed,
  onOpenDecision,
  onBrowseDecisions,
  onInitialNavigationConsumed,
}: MethodologyPanelProps) => {
  const [status, setStatus] = useState<StatusFilter>("candidate");
  const [items, setItems] = useState<MethodologyItem[]>([]);
  // Which filter the rows shown were read for: switched to another, the rows of the one before stayed with its count.
  const [itemsFor, setItemsFor] = useState<StatusFilter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MethodologyItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState<MethodologyRevisionInput | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  // Said of the record it was about: one opened from anywhere else, say once created, showed it as its own.
  useEffect(() => setDetailError(null), [selected?.id]);
  const [confirmingAcceptance, setConfirmingAcceptance] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [revisionKey, setRevisionKey] = useState(0);
  usePageShownAgain(() => setRevisionKey((value) => value + 1));
  // An ignored record leaves the list it was opened from, with focus on its row: the row that takes
  // its place takes focus, not the page (where Tab starts over), or the status filter once none is left.
  const refocusAfterIgnore = useRef<{ id: string; index: number } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const statusFilterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pending = refocusAfterIgnore.current;
    if (pending === null || items.some((item) => item.id === pending.id)) return;
    refocusAfterIgnore.current = null;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>(".methodology-row") ?? [];
    (
      rows[Math.min(pending.index, rows.length - 1)] ??
      statusFilterRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')
    )?.focus();
  }, [items]);
  const [view, setView] = useState<MethodologyView>(initialView ?? "records");
  useEffect(() => {
    if (initialView !== null) setView(initialView);
  }, [initialView]);
  const [practiceToolbarHost, setPracticeToolbarHost] =
    useState<HTMLElement | null>(null);
  // 技能与流程 puts its 新建草案 in the page header, where each tab's own action sits.
  const [practiceActionHost, setPracticeActionHost] =
    useState<HTMLElement | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraphSnapshot | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  // 重试 after a failed read asks for the graph alone.
  const [graphAttempt, setGraphAttempt] = useState(0);
  const [buildProgress, setBuildProgress] =
    useState<MethodologyBuildProgress | null>(null);
  const [buildProgressUnavailable, setBuildProgressUnavailable] =
    useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [notice, setNotice] = useState<MethodologyNotice | null>(null);
  // Which open the page is on: moved on by every record the reader opens or closes and by every read begun to open
  // one. Landing once the reader had opened another, a slow read put its record over theirs.
  const selectionTurn = useRef(0);
  const chooseRecord = (record: MethodologyItem | null): void => {
    selectionTurn.current += 1;
    setSelected(record);
  };
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  /**
   * Every hook lifted out of this panel asks for the same four or five things.
   * Built once, from setters only, so its identity never changes and no hook
   * re-runs an effect because the page re-rendered.
   */
  const host = useMemo<MethodologyWorkspaceHost>(
    () => ({
      openRecord: (record, options) => {
        selectionTurn.current += 1;
        setSelected(record);
        setEditing(false);
        setConfirmingAcceptance(false);
        if (options?.status !== undefined) setStatus(options.status);
        setView(options?.view ?? "records");
      },
      opening: () => {
        const turn = ++selectionTurn.current;
        return () => selectionTurn.current === turn;
      },
      showRecord: (record) => setSelected(record),
      replaceRecord: (record) =>
        setItems((current) =>
          current.map((entry) => (entry.id === record.id ? record : entry)),
        ),
      refreshRecords: () => setRevisionKey((value) => value + 1),
      notify: (notice) => setNotice(notice),
      dismissAcceptancePrompt: () => setConfirmingAcceptance(false),
      showView: (view) => setView(view),
      filterBy: (next) => setStatus(next),
      leaveEditor: () => setEditing(false),
    }),
    [],
  );

  // Called as the caller last passed it, without being a reason to read again: passed anew on every render of
  // the app (each snapshot it pushes), it dropped the jump's read under way and began another, and under a burst
  // of pushes the record never opened.
  const initialNavigationConsumed = useRef(onInitialNavigationConsumed);
  useEffect(() => {
    initialNavigationConsumed.current = onInitialNavigationConsumed;
  });

  // Quick jump knows the id but not which status tab holds it, so the record
  // itself decides which filter has to be showing for it to be in the list.
  useEffect(() => {
    const onInitialNavigationConsumed = initialNavigationConsumed.current;
    if (initialPrincipleId === null) {
      onInitialNavigationConsumed?.();
      return;
    }
    let active = true;
    const current = host.opening();
    void api
      .listMethodologies()
      .then((records) => {
        const record = records.find((item) => item.id === initialPrincipleId);
        if (!active || !current() || record === undefined) return;
        host.openRecord(record, { status: record.status, view: "records" });
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (active) initialNavigationConsumed.current?.();
      });
    return () => {
      active = false;
    };
  }, [api, host, initialPrincipleId]);

  const {
    beginRelationReview,
    clearRelationReview,
    closeRelationQueue,
    openRelationQueue,
    postponeRelationQueueItem,
    relationDisposition,
    relationError,
    relationNote,
    relationQueue,
    relationQueueDisposition,
    relationQueueError,
    relationQueueLoading,
    relationQueueNote,
    relationQueueSaving,
    relationQueueTotal,
    relationSaving,
    reviewingRelation,
    saveRelationQueueItem,
    saveRelationReview,
    setRelationDisposition,
    setRelationError,
    setRelationNote,
    setRelationQueue,
    setRelationQueueDisposition,
    setRelationQueueError,
    setRelationQueueLoading,
    setRelationQueueNote,
    setRelationQueueSaving,
    setRelationQueueTotal,
    setRelationSaving,
    setReviewingRelation,
  } = useRelationReview({ api, selected, host });
  const [usage, setUsage] = useState<MethodologyUsageSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageFilter, setUsageFilter] = useState<MethodologyUsageFilter>("all");
  const [usageProject, setUsageProject] = useState("__all__");
  const [versions, setVersions] = useState<MethodologyVersionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyReads, setHistoryReads] = useState(0);
  // A restore that did not go through is not a history that could not be read: the versions stay in view to try again.
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [pendingRestoreVersion, setPendingRestoreVersion] = useState<
    number | null
  >(null);
  const [restoringVersion, setRestoringVersion] = useState(false);
  const acceptanceConfirmationRef = useRef<HTMLElement>(null);
  // Which principle the usage filter and the history view were set for: kept when it is read again.
  const usageShownFor = useRef<string | null>(null);
  const historyShownFor = useRef<string | null>(null);


  // Taking the place of the button pressed, the confirmation takes focus (its 确认, or 返回检查 while that cannot be
  // had): left on the dialog itself, Tab went back to its top and its words went unread. Closed by 返回检查, focus
  // goes back to the button that opened it. Both sit in the dialog's footer, under the words they answer.
  const acceptanceShown = useRef(false);
  useEffect(() => {
    const wasShown = acceptanceShown.current;
    acceptanceShown.current = confirmingAcceptance;
    const footer = document
      .querySelector(".methodology-detail")
      ?.closest('[role="dialog"]')
      ?.querySelector<HTMLElement>(".modal-dialog-footer");
    if (confirmingAcceptance) {
      acceptanceConfirmationRef.current?.scrollIntoView?.({ block: "nearest" });
      (footer?.querySelector<HTMLElement>(".primary-button:not(:disabled)") ??
        footer?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
      return;
    }
    const focused = document.activeElement;
    if (!wasShown || (focused !== null && focused !== document.body && focused.getAttribute("role") !== "dialog")) return;
    footer?.querySelector<HTMLElement>(".primary-button")?.focus();
  }, [confirmingAcceptance]);




  useEffect(() => {
    if (selected === null) {
      setUsage(null);
      setUsageError(null);
      return;
    }
    if (hydratedUsageForPrinciple.current === selected.id) {
      hydratedUsageForPrinciple.current = null;
      setUsageLoading(false);
      setUsageError(null);
      setUsageFilter("all");
      setUsageProject("__all__");
      return;
    }
    let active = true;
    setUsage(null);
    setUsageLoading(true);
    setUsageError(null);
    // Read again for the same principle (the page shown again), the filter the reader set stays.
    if (usageShownFor.current !== selected.id) {
      setUsageFilter("all");
      setUsageProject("__all__");
    }
    usageShownFor.current = selected.id;
    void api
      .getMethodologyUsage(selected.id)
      .then((snapshot) => {
        if (active) setUsage(snapshot);
      })
      .catch((caught: unknown) => {
        if (active) {
          setUsageError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (active) setUsageLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey, selected?.id]);

  useEffect(() => {
    // The version looked at and a restore asked for stay while the page reads it again; another principle,
    // or this one no longer accepted, starts from its current version.
    const shown = `${selected?.id ?? ""}:${selected?.status ?? ""}`;
    if (historyShownFor.current !== shown) {
      setActiveVersion(null);
      setPendingRestoreVersion(null);
      setRestoreError(null);
    }
    historyShownFor.current = shown;
    if (selected?.status !== "accepted") {
      setVersions([]);
      setVersionsLoading(false);
      setHistoryError(null);
      return;
    }
    let active = true;
    setVersionsLoading(true);
    setHistoryError(null);
    void api
      .listMethodologyVersions(selected.id)
      .then((records) => {
        if (active) setVersions(records);
      })
      .catch((caught: unknown) => {
        if (active) {
          setVersions([]);
          setHistoryError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (active) setVersionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey, selected?.id, selected?.status, historyReads]);

  const usageProjects = useMemo(
    () =>
      usage === null
        ? []
        : [
            ...new Set(usage.decisions.map((decision) => decision.project)),
          ].sort((left, right) => left.localeCompare(right, "zh-CN")),
    [usage],
  );

  const usageFilterCounts = useMemo(() => {
    const decisions =
      usage?.decisions.filter(
        (decision) =>
          usageProject === "__all__" || decision.project === usageProject,
      ) ?? [];
    return Object.fromEntries(
      methodologyUsageFilterOrder.map((filter) => [
        filter,
        decisions.filter((decision) =>
          matchesMethodologyUsageFilter(decision, filter),
        ).length,
      ]),
    ) as Record<MethodologyUsageFilter, number>;
  }, [usage, usageProject]);

  const visibleUsageDecisions = useMemo(
    () =>
      usage?.decisions.filter(
        (decision) =>
          (usageProject === "__all__" || decision.project === usageProject) &&
          matchesMethodologyUsageFilter(decision, usageFilter),
      ) ?? [],
    [usage, usageFilter, usageProject],
  );

  const firstPendingUsageDecision = usage?.nextPendingDecision ?? null;

  const newEvolutionEvidence = useMemo(() => {
    if (selected === null || usage === null) return [];
    const existing = new Set(selected.sourceDecisionIds);
    return usage.decisions.filter(
      (decision) =>
        decision.outcomeReview !== null && !existing.has(decision.id),
    );
  }, [selected, usage]);

  const evolutionEvidenceOptions = useMemo(() => {
    if (selected === null) return [];
    const options = new Map<
      string,
      {
        id: string;
        project: string;
        question: string;
        outcome: string;
        lesson: string | null;
        isNew: boolean;
      }
    >();
    for (const decision of newEvolutionEvidence.slice(0, 5)) {
      options.set(decision.id, {
        id: decision.id,
        project: decision.project,
        question: decision.question,
        outcome: decision.outcome ?? "尚未记录实际结果",
        lesson: decision.outcomeReview?.lesson ?? null,
        isNew: true,
      });
    }
    for (const decision of selected.sourceDecisions) {
      options.set(decision.id, {
        id: decision.id,
        project: decision.project,
        question: decision.question,
        outcome: decision.outcome ?? "尚未记录实际结果",
        lesson: decision.outcomeReview?.lesson ?? null,
        isNew: false,
      });
    }
    return [...options.values()].slice(0, 8);
  }, [newEvolutionEvidence, selected]);

  const selectedHistoryVersion =
    activeVersion === null
      ? null
      : (versions.find((version) => version.version === activeVersion) ?? null);
  const selectedHistoryDiffs =
    selected === null || selectedHistoryVersion === null
      ? []
      : methodologyVersionDiffs(selected, selectedHistoryVersion);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .listMethodologies(status === "all" ? undefined : status)
      .then((records) => {
        if (active) {
          setItems(records);
          setItemsFor(status);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setItems([]);
          setItemsFor(status);
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey, status]);

  // The relation queue is built from every record, whatever status the list shows; so is its count,
  // or the workbox says 0 while the queue it opens holds a pair of adopted principles.
  // Until it is read, or when it cannot be, the records shown stand in rather than a number from before.
  const [allRecords, setAllRecords] = useState<MethodologyItem[] | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .listMethodologies()
      .then((records) => {
        if (active) setAllRecords(records);
      })
      .catch(() => {
        if (active) setAllRecords(null);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey]);
  const relationCount = buildRelationReviewQueue(allRecords ?? items).length;

  useEffect(() => {
    let active = true;
    setBuildProgressUnavailable(false);
    void api
      .getMethodologyBuildProgress()
      .then((progress) => {
        if (active) setBuildProgress(progress);
      })
      .catch(() => {
        if (active) {
          setBuildProgress(null);
          setBuildProgressUnavailable(true);
        }
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey]);

  useEffect(() => {
    if (view !== "graph") return;
    let active = true;
    setGraphLoading(true);
    setGraphError(null);
    void api
      .getKnowledgeGraph()
      .then((snapshot) => {
        if (active) setGraph(snapshot);
      })
      .catch((caught: unknown) => {
        if (active) {
          setGraph(null);
          setGraphError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (active) setGraphLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey, view, graphAttempt]);

  const {
    cancelPendingLoad,
    choosingSources,
    chooser,
    closeSourceChooser,
    evidenceMatchError,
    evidenceMatchLoading,
    evidenceMatches,
    linkingEvidence,
    openSourceChooser,
    reviewedDecisions,
    searchSources,
    selectedSources,
    sourceLoading,
    sourceQuery,
    toggleSource,
    visibleReviewedDecisions,
  } = useEvidenceLinking({ api, selected, reportError: setGenerationError });

  useEffect(() => {
    if (initialSourceDecisionId === null) return;
    openSourceChooser([initialSourceDecisionId]);
    onInitialSourceConsumed?.();
  }, [initialSourceDecisionId, openSourceChooser, onInitialSourceConsumed]);

  const {
    closeSuggestionInbox,
    deferSuggestion,
    deferredSuggestions,
    openSuggestionInbox,
    restoreSuggestion,
    retrySuggestions,
    showSuggestions,
    suggestionActionError,
    suggestionActionId,
    suggestionError,
    suggestionInboxMode,
    suggestionInboxOpen,
    suggestionLoading,
    suggestions,
    visibleSuggestionInboxItems,
  } = useSuggestionInbox({ api, host, revisionKey });
  // The dialog promised every group and the work stopped at six, saying nothing of the rest.
  const suggestionBatch = suggestions.slice(0, SUGGESTION_BATCH_SIZE);
  const suggestionsAfterBatch = suggestions.length - suggestionBatch.length;

  const {
    chooseImportCandidates,
    closeImportPreview,
    commitMarkdownImport,
    importError,
    importMarkdown,
    importPreview,
    importSaving,
    importing,
    selectedImportCandidates,
    toggleImportCandidate,
  } = useMarkdownImport({ api, host });

  const {
    acknowledgeValidation,
    closeValidationInbox,
    openValidationInbox,
    openValidationItem,
    retryValidation,
    validationActionError,
    validationActionId,
    validationError,
    validationInboxOpen,
    validationItems,
    validationLoading,
  } = useValidationInbox({
    api,
    host,
    revisionKey,
    openPrinciple: (id) => void openRelatedPrinciple(id),
  });

  const {
    backToChooser,
    beginManualEvidenceMethodology,
    closeCreation,
    closeManualEvidenceMethodology,
    creationMode,
    discardManualEvidenceMethodologyDraft,
    discardManualMethodologyDraft,
    manualDraft,
    manualDraftRestoredAt,
    manualDraftSaveEpoch,
    manualDraftSaveState,
    manualDraftStorageError,
    manualError,
    manualEvidenceDraft,
    manualEvidenceDraftSaveEpoch,
    manualEvidenceDraftSaveState,
    manualEvidenceError,
    manualEvidencePendingSources,
    manualEvidenceRestoredAt,
    manualEvidenceSaving,
    manualFormDrafts,
    draftStore,
    manualSaving,
    openCreation,
    openEvidenceCreation,
    openManualCreation,
    saveManualEvidenceMethodology,
    saveManualMethodology,
    setCreationMode,
    setManualDraft,
    setManualDraftRestoredAt,
    setManualDraftSaveState,
    setManualError,
    setManualEvidenceDraft,
    setManualEvidenceDraftSaveState,
    setManualEvidenceError,
    setManualEvidencePendingSources,
    setManualEvidenceRestoredAt,
    setManualEvidenceSaving,
    setManualSaving,
    updateManualEvidenceDraft,
  } = useManualDrafting({
    api,
    host,
    selected,
    status,
    chooser,
  });

  const storedMergeDraft = manualFormDrafts.find(
    (draft): draft is MethodologyMergeFormDraft =>
      draft.key === "methodology_merge",
  );

  const storedRevisionDraft = manualFormDrafts.find(
    (draft): draft is MethodologyRevisionFormDraft =>
      draft.key === "methodology_revision",
  );

  const {
    applyEvolutionRebase,
    beginEvolution,
    clearEvolutionEditor,
    discardEvolutionFormDraft,
    evolutionDraft,
    evolutionDraftClosing,
    evolutionDraftRecoveryMessage,
    evolutionDraftRestoredAt,
    evolutionDraftSaveEpoch,
    evolutionDraftSaveState,
    evolutionError,
    evolutionRebase,
    evolutionRebaseError,
    evolutionRebaseSaving,
    evolutionSaving,
    evolving,
    hydratedUsageForPrinciple,
    preserveEvolutionFormDraft,
    restoreEvolutionFormDraft,
    saveEvolution,
    setEvolutionDraft,
    setEvolutionDraftClosing,
    setEvolutionDraftRecoveryMessage,
    setEvolutionDraftRestoredAt,
    setEvolutionDraftSaveState,
    setEvolutionError,
    setEvolutionRebase,
    setEvolutionRebaseChoice,
    setEvolutionRebaseError,
    setEvolutionRebaseSaving,
    setEvolutionSaving,
    setEvolving,
    toggleEvolutionEvidence,
  } = usePrincipleEvolution({
    api,
    host,
    draftStore,
    selected,
    status,
    storedRevisionDraft,
    setDetailError,
    setUsage,
    setUsageLoading,
    setUsageError,
    newEvolutionEvidence,
  });

  // The open principle as the list now has it, once read again (the page shown again, after a save): changed
  // elsewhere meanwhile (in Obsidian, a review of its evidence), the detail said what it said before, and 编辑
  // began from that. Left as it is while an edit or a revision draft is open, as what they save is checked against
  // what they began from; but after an edit refused for that, it rests on the principle as read again.
  const holdSelected = useRef(false);
  holdSelected.current = editing || evolving;
  const rebasing = useRef(false);
  useEffect(() => {
    if (selected === null || (holdSelected.current && !rebasing.current)) return;
    rebasing.current = false;
    const listed = items.find((item) => item.id === selected.id);
    if (listed !== undefined) {
      if (listed !== selected) setSelected(listed);
      return;
    }
    // Out of the list as filtered (opened from a decision, a citation): read again on its own.
    const { id } = selected;
    void api
      .listMethodologies()
      .then((records) => {
        const reread = records.find((record) => record.id === id);
        if (reread !== undefined) setSelected((current) => (current?.id === id ? reread : current));
      })
      .catch(() => undefined);
  }, [items]);

  const evolutionHasNewEvidence =
    evolutionDraft?.sourceDecisionIds.some((id) =>
      newEvolutionEvidence.some((decision) => decision.id === id),
    ) ?? false;
  const evolutionDraftValid =
    evolutionDraft !== null &&
    evolutionDraft.sourceDecisionIds.length > 0 &&
    evolutionHasNewEvidence &&
    [
      evolutionDraft.title,
      evolutionDraft.principle,
      evolutionDraft.appliesWhen,
      evolutionDraft.caution,
      evolutionDraft.evidenceSummary,
    ].every((value) => value.trim().length > 0);
  const evolutionDraftSaveLabel =
    evolutionDraftSaveState === "saving"
      ? "正在保存到本机…"
      : evolutionDraftSaveState === "error"
        ? "本机保存失败"
        : evolutionDraftSaveState === "saved"
          ? "已保存到本机"
          : evolutionDraftRestoredAt === null
            ? "更改仅保存在本机"
            : "等待保存到本机…";
  const evolutionRebaseRows =
    evolutionRebase === null
      ? []
      : methodologyRevisionFields.map(({ field, label }) => ({
          field,
          label,
          baseline: evolutionRebase.baseline[field],
          current: revisionFrom(evolutionRebase.source)[field],
          draft: evolutionRebase.saved.input[field],
          choice: evolutionRebase.choices[field],
        })).filter(
          ({ baseline, current, draft }) =>
            baseline !== current || baseline !== draft,
        );
  const evolutionRebaseUnresolvedCount = evolutionRebaseRows.filter(
    ({ choice }) => choice === null,
  ).length;


  const {
    beginMergePrinciples,
    beginMergeRelationReview,
    clearMergeEditor,
    createMergeDraft,
    discardMergeFormDraft,
    loadMergeLifecycle,
    mergeDraft,
    mergeDraftClosing,
    mergeDraftRecoveryMessage,
    mergeDraftRestoredAt,
    mergeDraftSaveEpoch,
    mergeDraftSaveState,
    mergeError,
    mergeLifecycleBusyAssetId,
    mergeLifecycleError,
    mergeLifecycleLoading,
    mergeLifecycleOpen,
    mergeLifecyclePlan,
    mergeLifecycleSaving,
    mergeLoading,
    mergeRelationError,
    mergeRelationOutcome,
    mergeRelationReview,
    mergeRelationSaving,
    mergeSaving,
    openMergeLifecycle,
    prepareMergeAsset,
    preserveAndCloseMergeDraft,
    restoreMergeFormDraft,
    restoreMergeSources,
    retireMergeSources,
    saveMergeRelationReview,
    setMergeDraft,
    setMergeDraftClosing,
    setMergeDraftRecoveryMessage,
    setMergeDraftRestoredAt,
    setMergeDraftSaveState,
    setMergeError,
    setMergeLifecycleBusyAssetId,
    setMergeLifecycleError,
    setMergeLifecycleLoading,
    setMergeLifecycleOpen,
    setMergeLifecyclePlan,
    setMergeLifecycleSaving,
    setMergeLoading,
    setMergeRelationError,
    setMergeRelationOutcome,
    setMergeRelationReview,
    setMergeRelationSaving,
    setMergeSaving,
    toggleMergeEvidence,
    toggleMergeSource,
    updateMergeField,
  } = useMergeWorkbench({
    api,
    host,
    draftStore,
    selected,
    status,
    storedMergeDraft,
  });

  const generate = async (): Promise<void> => {
    if (selectedSources.length === 0) return;
    setGenerating(true);
    setGenerationError(null);
    try {
      const item = await api.generateMethodology(selectedSources);
      cancelPendingLoad();
      closeSourceChooser();
      chooser.choose([]);
      setSelected(item);
      setConfirmingAcceptance(false);
      setStatus("candidate");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setGenerationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setGenerating(false);
    }
  };

  const saveEvidenceLinks = async (): Promise<void> => {
    if (selected === null || selectedSources.length === 0) return;
    setGenerating(true);
    setGenerationError(null);
    try {
      const updated = await api.setMethodologyEvidence(
        selected.id,
        selectedSources,
      );
      cancelPendingLoad();
      setSelected(updated);
      closeSourceChooser();
      chooser.choose([]);
      setNotice({
        tone: "success",
        text: `已关联 ${updated.sourceDecisionIds.length} 条复盘证据，并重新计算可信度。`,
      });
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setGenerationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setGenerating(false);
    }
  };

  const generateSuggestionBatch = async (): Promise<void> => {
    const queue = suggestionBatch;
    if (queue.length === 0) return;
    setBatchGenerating(true);
    setBatchProgress({ current: 0, total: queue.length });
    setNotice(null);
    let completed = 0;
    const failures: string[] = [];
    for (const [index, suggestion] of queue.entries()) {
      setBatchProgress({ current: index + 1, total: queue.length });
      try {
        await api.generateMethodology(suggestion.sourceDecisionIds);
        completed += 1;
      } catch (caught) {
        failures.push(
          caught instanceof Error ? caught.message : String(caught),
        );
      }
    }
    setBatchGenerating(false);
    setConfirmingBatch(false);
    closeSuggestionInbox();
    closeSourceChooser();
    setStatus("candidate");
    if (completed > 0) setRevisionKey((value) => value + 1);
    const laterBatch = suggestionsAfterBatch > 0 ? `还有 ${suggestionsAfterBatch} 组可以再批量生成。` : "";
    setNotice({
      tone: failures.length > 0 ? "warning" : "success",
      text:
        failures.length === 0
          ? `已生成 ${completed} 条候选，等待逐条审核。${laterBatch}`
          : laterBatch === ""
            ? `已生成 ${completed} 条，${failures.length} 条未完成：${failures[0]}`
            : `已生成 ${completed} 条，${failures.length} 条未完成：${failures[0]?.replace(/[。.]$/u, "")}。${laterBatch}`,
    });
  };

  const beginEditing = (): void => {
    if (selected === null) return;
    setRevision(revisionFrom(selected));
    setDetailError(null);
    setConfirmingAcceptance(false);
    setEditing(true);
  };

  const saveRevision = async (): Promise<void> => {
    if (selected === null || revision === null) return;
    setSaving(true);
    setDetailError(null);
    try {
      const updated = await api.reviseMethodology(selected.id, revision, methodologyRevisionBasis(selected));
      setSelected(updated);
      setEditing(false);
      setConfirmingAcceptance(false);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : String(caught));
      // Refused because it changed since, or failed for another reason: read again, the edit kept open on it.
      rebasing.current = true;
      setRevisionKey((value) => value + 1);
    } finally {
      setSaving(false);
    }
  };


  const restoreMethodologyVersion = async (version: number): Promise<void> => {
    if (selected === null) return;
    setRestoringVersion(true);
    setRestoreError(null);
    try {
      const restored = await api.restoreMethodologyVersion(
        selected.id,
        version,
      );
      setSelected(restored);
      setActiveVersion(null);
      setPendingRestoreVersion(null);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setRestoreError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRestoringVersion(false);
    }
  };

  const setRecordStatus = async (
    nextStatus: "accepted" | "dismissed",
    acknowledgeQualityRisks = false,
  ): Promise<void> => {
    if (selected === null) return;
    setSaving(true);
    setDetailError(null);
    try {
      const updated = acknowledgeQualityRisks
        ? await api.setMethodologyStatus(selected.id, nextStatus, true)
        : await api.setMethodologyStatus(selected.id, nextStatus);
      if (nextStatus === "dismissed") {
        refocusAfterIgnore.current = {
          id: selected.id,
          index: items.findIndex((item) => item.id === selected.id),
        };
      }
      setSelected(nextStatus === "dismissed" ? null : updated);
      setEditing(false);
      setConfirmingAcceptance(false);
      setStatus(nextStatus === "dismissed" ? "candidate" : "accepted");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const openRelatedPrinciple = async (id: string): Promise<void> => {
    const current = host.opening();
    setSaving(true);
    setDetailError(null);
    try {
      const related = (await api.listMethodologies()).find(
        (item) => item.id === id,
      );
      if (!current()) return;
      if (related === undefined) {
        throw new Error("关联原则已不存在，请刷新后重试。");
      }
      setSelected(related);
      setEditing(false);
      setConfirmingAcceptance(false);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // Opened from the graph, no detail is open to say it in.
      if (selected === null) setNotice({ tone: "error", text: message });
      else setDetailError(message);
    } finally {
      setSaving(false);
    }
  };



  const selectedIsUnverifiedExternal =
    (selected?.origin === "markdown_import" ||
      selected?.origin === "manual_entry") &&
    selected.sourceDecisionIds.length === 0;
  // Evidence is linked on what is still under review or adopted: offered on a dismissed or retired one, the chooser
  // took the reader through picking decisions to a refusal at the end.
  const selectedTakesEvidence = selected?.status === "candidate" || selected?.status === "accepted";
  const selectedHasImportPlaceholders =
    selected?.origin === "markdown_import" &&
    [selected.appliesWhen, selected.caution].some((value) =>
      value.startsWith("待补充："),
    );
  const selectedRiskRelations =
    selected?.quality.relations.filter(
      (relation) => relation.resolution !== "unrelated",
    ) ?? [];
  const selectedNeedsAcceptanceConfirmation =
    selectedIsUnverifiedExternal ||
    selected?.origin === "principle_merge" ||
    selected?.origin === "principle_revision" ||
    selectedRiskRelations.length > 0;
  const manualDraftValid = Object.values(manualDraft).every(
    (value) => value.trim().length > 0,
  );
  const manualEvidenceDraftValid =
    manualEvidenceDraft !== null &&
    manualEvidenceDraft.sourceDecisionIds.length > 0 &&
    [
      manualEvidenceDraft.title,
      manualEvidenceDraft.principle,
      manualEvidenceDraft.appliesWhen,
      manualEvidenceDraft.caution,
      manualEvidenceDraft.evidenceSummary,
    ].every((value) => value.trim().length > 0);
  const manualEvidenceDecisions =
    manualEvidenceDraft === null
      ? []
      : manualEvidenceDraft.sourceDecisionIds.flatMap((id) => {
          const decision = reviewedDecisions.find((item) => item.id === id);
          return decision === undefined ? [] : [decision];
        });
  const mergeDraftReady =
    mergeDraft !== null &&
    mergeRelationReview === null &&
    mergeDraft.sources.length >= 2 &&
    mergeDraft.sources.length <= 5 &&
    mergeDraft.input.sourceDecisionIds.length > 0 &&
    (
      [
        mergeDraft.input.title,
        mergeDraft.input.principle,
        mergeDraft.input.appliesWhen,
        mergeDraft.input.caution,
        mergeDraft.input.evidenceSummary,
      ] as const
    ).every((value) => value.trim().length > 0);
  const mergeDraftSaveLabel =
    mergeDraftSaveState === "saving"
      ? "正在保存到本机…"
      : mergeDraftSaveState === "error"
        ? "本机保存失败"
        : mergeDraftSaveState === "saved"
          ? "已保存到本机"
          : mergeDraftRestoredAt === null
            ? "更改仅保存在本机"
            : "等待保存到本机…";
  const mergeCandidateAssessments =
    mergeDraft === null
      ? []
      : mergeDraft.availablePrinciples.flatMap((candidate) => {
          if (mergeDraft.sources.some((source) => source.id === candidate.id)) {
            return [];
          }
          const assessment = assessMergeCandidate(
            mergeDraft.sources,
            candidate,
          );
          return assessment === null ? [] : [assessment];
        });
  const mergeCompatiblePrinciples = mergeCandidateAssessments
    .filter((assessment) => assessment.missingSources.length === 0)
    .map((assessment) => assessment.item);
  const mergeReviewCandidates = mergeCandidateAssessments.filter(
    (assessment) => assessment.missingSources.length > 0,
  );
  const mergeRelationCandidate =
    mergeDraft?.availablePrinciples.find(
      (item) => item.id === mergeRelationReview?.candidateId,
    ) ?? null;
  const mergeRelationSource =
    mergeDraft?.sources.find(
      (item) => item.id === mergeRelationReview?.pendingSourceIds[0],
    ) ?? null;
  const mergeRelationCompleted =
    mergeRelationReview === null
      ? 0
      : mergeRelationReview.totalPairCount -
        mergeRelationReview.pendingSourceIds.length;
  const currentRelationQueueItem = relationQueue?.[0] ?? null;
  const relationQueueCompleted =
    relationQueue === null ? 0 : relationQueueTotal - relationQueue.length;

  // Kept while the list is the same: every snapshot the app pushes (each agent turn, each capture) re-rendered
  // this page with it, and a thousand rows were reconciled each time though none of them had changed.
  const rows = useMemo(
    () =>
      items.map((item) => {
        const qualityBadge = qualityBadgeFor(item);
        const confidence = confidenceFor(item);
        return (
          <li key={item.id}>
            <button
              type="button"
              className="methodology-row"
              onClick={() => {
                chooseRecord(item);
                setEditing(false);
                setEvolving(false);
                setEvolutionDraft(null);
                setDetailError(null);
                setConfirmingAcceptance(false);
              }}
            >
              <span className="methodology-row-copy">
                <span className="methodology-row-title">
                  <strong>{item.title}</strong>
                  {item.origin === "markdown_import" ? (
                    <em className="imported">Markdown 导入</em>
                  ) : null}
                  {item.origin === "manual_entry" ? (
                    <em className="manual">人工录入</em>
                  ) : null}
                  {item.origin === "principle_merge" ? (
                    <em className="merged">合并草案</em>
                  ) : null}
                  {item.origin === "principle_revision" ? (
                    <em className="revision">修订草案</em>
                  ) : null}
                  {qualityBadge === null ? null : (
                    <em className={qualityBadge.tone}>
                      {qualityBadge.label}
                    </em>
                  )}
                </span>
                <span className="methodology-row-principle">
                  {item.principle}
                </span>
              </span>
              <span className={`methodology-confidence ${confidence.tone}`}>
                {confidence.label}
              </span>
              <span>
                {item.quality.evidenceCount === 0 &&
                item.sourceDecisionIds.length === 0
                  ? "待关联证据"
                  : item.quality.missingEvidenceCount > 0
                    ? `${item.quality.evidenceCount}/${item.sourceDecisionIds.length} 条证据`
                    : `${item.quality.evidenceCount} 条证据`}
              </span>
              <time dateTime={item.updatedAt}>
                {dateFormatter.format(new Date(item.updatedAt))}
              </time>
              <span className={`methodology-status ${item.status}`}>
                {statusLabels[item.status]}
              </span>
              <span aria-hidden="true">›</span>
            </button>
          </li>
        );
      }),
    [items],
  );

  const workbenchPending =
    suggestions.length + validationItems.length + relationCount;
  // A few candidates bring the build guide beside the list, and with it 审核第一条 as the one solid button;
  // no candidates at all bring a first-step section with a solid button of its own.
  const guided =
    error === null &&
    status === "candidate" &&
    items.length > 0 &&
    items.length <= 4;
  const firstSteps =
    error === null && !loading && items.length === 0 && status === "candidate";
  // Read for another filter, the rows shown are the last one's: dimmed and counted as reading, not as theirs.
  const switchingFilter = loading && itemsFor !== status;

  // Said at the foot of the card it came from (IMP-142): a full-width banner over the tab pushed the list down.
  // Every view's, not only the list's: a merge begun from the graph failed with nothing said there.
  const noticeBar =
    notice === null ? null : (
      <div
        className={`settings-status methodology-notice${notice.tone === "success" ? "" : ` ${notice.tone}`}`}
        role={notice.tone === "error" ? "alert" : "status"}
      >
        <span>{notice.text}</span>
        {notice.action === "discard_merge_draft" ? (
          <button
            type="button"
            className="text-button danger-button"
            disabled={mergeDraftClosing}
            onClick={() => void discardMergeFormDraft()}
          >
            {mergeDraftClosing ? "正在丢弃…" : "丢弃草稿"}
          </button>
        ) : null}
        {notice.action === "discard_revision_draft" ? (
          <button
            type="button"
            className="text-button danger-button"
            disabled={evolutionDraftClosing}
            onClick={() => void discardEvolutionFormDraft()}
          >
            {evolutionDraftClosing ? "正在丢弃…" : "丢弃草稿"}
          </button>
        ) : null}
        <button
          type="button"
          className="text-button"
          onClick={() => setNotice(null)}
        >
          关闭
        </button>
      </div>
    );

  return (
    <section
      className="desktop-view methodology-panel"
      role="region"
      aria-label="方法论"
    >
      {/* Each tab's own action sits on the right of the header: the principles' here, the drafts' portalled in. */}
      <header className="desktop-view-header drag-region">
        <div>
          <span>沉淀</span>
          <h1>方法论</h1>
          <p>从真实结果与复盘中提炼可复用原则。</p>
        </div>
        {view === "records" ? (
          <div className="methodology-header-actions">
            {storedRevisionDraft === undefined ? null : (
              <button
                type="button"
                className="secondary-button methodology-draft-resume-button"
                disabled={evolutionDraftClosing}
                onClick={() =>
                  void restoreEvolutionFormDraft(storedRevisionDraft)
                }
              >
                {evolutionDraftClosing ? "正在校验…" : "继续修订"}
              </button>
            )}
            {storedMergeDraft === undefined ? null : (
              <button
                type="button"
                className="secondary-button methodology-merge-resume-button"
                disabled={mergeLoading || mergeDraftClosing}
                onClick={() => void restoreMergeFormDraft(storedMergeDraft)}
              >
                {mergeLoading ? "正在校验…" : "继续合并"}
              </button>
            )}
            <button
              type="button"
              className="secondary-button methodology-workbench-button"
              aria-label={`方法论工作箱 ${workbenchPending}`}
              onClick={() => setWorkbenchOpen(true)}
            >
              <ActionIcon name="inbox" />
              工作箱
              {workbenchPending > 0 ? (
                <span className="methodology-workbench-count">
                  {workbenchPending}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className={`${
                guided || firstSteps ? "secondary-button" : "primary-button"
              } methodology-create-button`}
              disabled={importing || batchGenerating}
              onClick={openCreation}
            >
              <ActionIcon name="plus" />
              新建原则
            </button>
          </div>
        ) : view === "assets" ? (
          <div
            ref={setPracticeActionHost}
            className="methodology-header-actions"
          />
        ) : view === "graph" ? (
          <div className="desktop-view-meta">
            {/* Unread is not none: 「0 已采纳原则」 over a failed read. */}
            <strong>{graphError !== null ? "—" : (graph?.principles.length ?? 0)}</strong>
            <span>已采纳原则</span>
          </div>
        ) : null}
      </header>

      <div
        className="methodology-view-tabs"
        role="tablist"
        aria-label="方法论视图"
      >
        {methodologyViews.map(({ value, label, icon }) => (
          <button
            key={value}
            id={`methodology-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={view === value}
            aria-controls="methodology-tab-panel"
            tabIndex={view === value ? 0 : -1}
            onClick={() => setView(value)}
            onKeyDown={(event) => {
              const currentIndex = methodologyViews.findIndex(
                (candidate) => candidate.value === value,
              );
              const nextIndex =
                event.key === "ArrowRight"
                  ? (currentIndex + 1) % methodologyViews.length
                  : event.key === "ArrowLeft"
                    ? (currentIndex - 1 + methodologyViews.length) %
                      methodologyViews.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? methodologyViews.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const nextView = methodologyViews[nextIndex];
              if (nextView === undefined) return;
              setView(nextView.value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                .item(nextIndex)
                .focus();
            }}
          >
            <ActionIcon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="desktop-page-scroll methodology-content">
        <div
          id="methodology-tab-panel"
          className={`methodology-tab-panel ${view}`}
          role="tabpanel"
          aria-labelledby={`methodology-tab-${view}`}
          tabIndex={-1}
        >
          {view === "records" ? (
            <div
              className={`methodology-records-layout${guided ? " guided" : ""}`}
            >
              <section
                className="methodology-card methodology-records-card"
                aria-label="原则列表"
              >
                <div className="methodology-toolbar">
                  <div className="methodology-records-toolbar">
                    <div
                      ref={statusFilterRef}
                      className="methodology-status-filter"
                      role="group"
                      aria-label="方法论状态"
                    >
                      {(
                        [
                          ["candidate", "待确认"],
                          ["accepted", "已采纳"],
                          ["retired", "已归档"],
                          ["dismissed", "已忽略"],
                          ["all", "全部"],
                        ] as Array<[StatusFilter, string]>
                      ).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={status === value}
                          onClick={() => setStatus(value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <span className="methodology-result-count" role="status">
                      {/* Read again after each relation is settled: the count stays put rather than flicker to "reading". */}
                      {error !== null
                        ? "—"
                        : (loading && items.length === 0) || switchingFilter
                          ? "正在读取…"
                          : `${items.length} 条`}
                    </span>
                  </div>
                </div>
                {unreadableNotice === null ? null : (
                  <p className="load-failure">{unreadableNotice}</p>
                )}
                {error !== null ? (
                  <div className="load-failure" role="alert">
                    <span>方法论记录暂时无法读取：{error}</span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setRevisionKey((value) => value + 1)}
                    >
                      重试
                    </button>
                  </div>
                ) : !loading && items.length === 0 ? (
                  status === "candidate" && suggestions.length > 0 ? (
                    <section
                      className="methodology-suggestion-inbox"
                      aria-label="方法论提炼建议"
                    >
                      <header>
                        <div>
                          <strong>已有复盘可以开始提炼</strong>
                          <span>
                            系统只整理证据组合；点击后才会调用模型生成候选。
                          </span>
                        </div>
                        <div className="methodology-suggestion-actions">
                          <em>{suggestions.length} 组建议</em>
                          <button
                            type="button"
                            className="text-button"
                            onClick={openSuggestionInbox}
                          >
                            管理素材
                          </button>
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => setConfirmingBatch(true)}
                          >
                            批量生成
                          </button>
                        </div>
                      </header>
                      <ol>
                        {suggestions.map((suggestion) => (
                          <li key={suggestion.id}>
                            <button
                              type="button"
                              onClick={() =>
                                openSourceChooser(suggestion.sourceDecisionIds)
                              }
                            >
                              <span className="methodology-suggestion-card-heading">
                                <strong>{suggestion.title}</strong>
                                <em className={suggestion.readiness}>
                                  {suggestionReadinessLabels[suggestion.readiness]}
                                </em>
                              </span>
                              <span>{suggestion.summary}</span>
                              <small>
                                {suggestionDirectionLabels[suggestion.direction]} ·{" "}
                                {suggestion.evidenceCount} 条证据 ·{" "}
                                {suggestion.projectCount} 个项目
                              </small>
                            </button>
                          </li>
                        ))}
                      </ol>
                      <footer>
                        <span>不满意建议组合时，仍可手动选择任意已复盘决策。</span>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => openSourceChooser()}
                        >
                          手动选择
                        </button>
                      </footer>
                    </section>
                  ) : status === "candidate" ? (
                    <section
                      className="methodology-acquisition"
                      aria-label="方法论获取路径"
                    >
                      <header>
                        <div>
                          <strong>原则可以人工建立，也可以从复盘证据提炼</strong>
                          <span>
                            人工内容会标为待验证；只有真实复盘证据会影响可信度。
                          </span>
                        </div>
                        <em>
                          {buildProgress === null
                            ? buildProgressUnavailable
                              ? "进度暂不可用"
                              : "正在统计决策…"
                            : `${buildProgress.decisions.total} 条已记录 · ${buildProgress.decisions.reviewed} 条已复盘`}
                        </em>
                      </header>
                      <ol>
                        <li>
                          <b>1</b>
                          <div>
                            <strong>记录实际结果并完成复盘</strong>
                            <span>
                              {buildProgress === null
                                ? "方法论只使用经过结果验证的决策。"
                                : buildProgress.decisions.reviewed > 0
                                  ? `${buildProgress.decisions.reviewed} 条证据已经可用。`
                                  : `${buildProgress.decisions.pendingOutcome} 条待回填结果，${buildProgress.decisions.pendingReview} 条待复盘。`}
                            </span>
                          </div>
                        </li>
                        <li>
                          <b>2</b>
                          <div>
                            <strong>从复盘证据生成原则候选</strong>
                            <span>
                              选择 1–5 条证据，由当前启用的模型提炼适用条件和边界。
                            </span>
                          </div>
                        </li>
                        <li>
                          <b>3</b>
                          <div>
                            <strong>审核并采纳可信原则</strong>
                            <span>
                              采纳后才会进入图谱，并可继续生成技能或工作流草案。
                            </span>
                          </div>
                        </li>
                      </ol>
                      <footer>
                        <button
                          type="button"
                          className="primary-button"
                          onClick={openCreation}
                        >
                          新建第一条原则
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => void api.openSurface("decisions")}
                        >
                          去积累复盘证据
                        </button>
                      </footer>
                    </section>
                  ) : (
                    <div className="methodology-empty">
                      <strong>
                        暂无{status === "all" ? "全部" : statusLabels[status]}原则
                      </strong>
                      <span>切换状态查看其它记录，或从新的复盘证据生成候选。</span>
                    </div>
                  )
                ) : (
                  <>
                    <div className="methodology-list-head" aria-hidden="true">
                      <span>原则</span>
                      <span>可信度</span>
                      <span>证据</span>
                      <span>更新时间</span>
                      <span>状态</span>
                      <span />
                    </div>
                    <ol
                      ref={listRef}
                      className="methodology-list"
                      aria-label="方法论列表"
                      aria-busy={switchingFilter}
                    >
                      {rows}
                    </ol>
                  </>
                )}
                {noticeBar}
              </section>

              {guided ? (
                <section
                  className="methodology-build-guide"
                  aria-label="方法论建设进度"
                >
                  <header>
                    <h2>建设进度</h2>
                    <p>
                      把真实决策逐步变成可复用方法；只统计本地事实，不会自动生成或采纳。
                    </p>
                  </header>

                  {buildProgress === null ? (
                    <p className="methodology-build-loading" role="status">
                      {buildProgressUnavailable
                        ? "建设进度暂时无法读取，现有原则仍可正常处理。"
                        : "正在汇总完整建设进度…"}
                    </p>
                  ) : (
                    <ol
                      className="methodology-build-path"
                      aria-label="方法论建设路径"
                    >
                      <li>
                        <b aria-hidden="true">1</b>
                        <span>复盘证据</span>
                        <span className="methodology-build-value">
                          <strong>{buildProgress.decisions.reviewed}</strong>{" "}
                          条完整复盘
                        </span>
                        <small>
                          已记录 {buildProgress.decisions.total} 条决策 ·{" "}
                          {buildProgress.decisions.pendingOutcome} 条待结果 ·{" "}
                          {buildProgress.decisions.pendingReview} 条待复盘
                        </small>
                      </li>
                      <li>
                        <b aria-hidden="true">2</b>
                        <span>原则沉淀</span>
                        <span className="methodology-build-value">
                          <strong>{buildProgress.principles.accepted}</strong>{" "}
                          条已采纳
                        </span>
                        <small>
                          {buildProgress.principles.candidate} 条待确认，等人工审核
                        </small>
                      </li>
                      <li>
                        <b aria-hidden="true">3</b>
                        <span>实践落地</span>
                        <span className="methodology-build-value">
                          <strong>{buildProgress.practiceAssets.accepted}</strong>{" "}
                          条已采纳
                        </span>
                        <small>
                          {buildProgress.practiceAssets.candidate}{" "}
                          条技能或流程草案等待确认
                        </small>
                      </li>
                    </ol>
                  )}

                  <div className="methodology-build-next">
                    <h3>
                      建议下一步：先审核{" "}
                      {buildProgress?.principles.candidate ?? items.length}{" "}
                      条待确认原则
                    </h3>
                    <p>
                      {suggestions.length > 0
                        ? `处理完现有候选后，还有 ${suggestions.length} 组复盘证据可以继续提炼。`
                        : "核对原则、适用条件和边界；明确采纳后才会进入图谱和「技能与流程」。"}
                    </p>
                    <div className="methodology-build-actions">
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          const first = items[0];
                          if (first === undefined) return;
                          chooseRecord(first);
                          setEditing(false);
                          setDetailError(null);
                          setConfirmingAcceptance(false);
                        }}
                      >
                        审核第一条
                      </button>
                      {suggestions[0] === undefined ? (
                        (buildProgress?.decisions.reviewed ?? 0) > 0 ? (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => openSourceChooser()}
                          >
                            继续提炼
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => void api.openSurface("decisions")}
                          >
                            去补结果与复盘
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            openSourceChooser(suggestions[0]?.sourceDecisionIds)
                          }
                        >
                          查看 {suggestions.length} 组建议
                        </button>
                      )}
                    </div>
                  </div>
                </section>
              ) : null}
            </div>
          ) : (
            <section
              className={`methodology-card${view === "assets" ? "" : " graph-view"}`}
              aria-label="方法论工作区"
            >
              {view === "assets" ? (
                <div className="methodology-toolbar">
                  <div className="methodology-records-toolbar practice-assets-toolbar-host">
                    <div
                      ref={setPracticeToolbarHost}
                      className="practice-assets-toolbar-portal"
                    />
                  </div>
                </div>
              ) : null}
              {view === "analysis" ? (
                <DecisionAnalyticsView
                  api={api}
                  onOpenDecisions={() => void api.openSurface("decisions")}
                  onOpenDecision={onOpenDecision}
                  onBrowseDecisions={onBrowseDecisions}
                  onOpenPrinciple={(id) => {
                    const current = host.opening();
                    void api
                      .listMethodologies()
                      .then((records) => {
                        if (!current()) return;
                        const record = records.find((item) => item.id === id);
                        if (record !== undefined) {
                          host.openRecord(record, { status: record.status, view: "records" });
                        } else {
                          setNotice({ tone: "error", text: "这条原则已不存在，可能已被删除。" });
                        }
                      })
                      .catch((caught: unknown) =>
                        setNotice({
                          tone: "error",
                          text: `原则暂时无法读取：${caught instanceof Error ? caught.message : String(caught)}`,
                        }),
                      );
                  }}
                  onOpenReviews={() => void api.openSurface("dashboard")}
                />
              ) : view === "graph" ? (
                <KnowledgeGraphView
                  graph={graph}
                  loading={graphLoading}
                  error={graphError}
                  mergeLoading={mergeLoading}
                  onRetry={() => setGraphAttempt((value) => value + 1)}
                  onOpenPrinciples={() => {
                    setStatus("candidate");
                    setView("records");
                  }}
                  onOpenPrinciple={(id) => {
                    setStatus("accepted");
                    setView("records");
                    void openRelatedPrinciple(id);
                  }}
                  onMergePrinciples={(firstId, secondId) =>
                    void beginMergePrinciples(firstId, secondId)
                  }
                />
              ) : (
                <PracticeAssetsView
                  api={api}
                  toolbarHost={practiceToolbarHost}
                  actionHost={practiceActionHost}
                  onOpenPrinciples={() => {
                    setStatus("candidate");
                    setView("records");
                  }}
                />
              )}
              {noticeBar}
            </section>
          )}
        </div>
      </div>

      {creationMode === null ? null : (
        <ModalDialog
          title={creationMode === "chooser" ? "新建原则" : "人工编写原则候选"}
          description={
            creationMode === "chooser"
              ? "选择内容来源；所有方式都只会建立待确认候选。"
              : "完全由你填写，不调用模型；之后可以再关联真实复盘证据。"
          }
          size="wide"
          dismissible={!manualSaving}
          onClose={closeCreation}
          footer={
            creationMode === "chooser" ? (
              <button
                type="button"
                className="secondary-button"
                onClick={closeCreation}
              >
                取消
              </button>
            ) : (
              <>
                <div className="modal-dialog-footer-start">
                  {manualDraftRestoredAt === null ? null : (
                    <button
                      type="button"
                      className="text-button danger-button"
                      disabled={manualSaving}
                      onClick={() => void discardManualMethodologyDraft()}
                    >
                      丢弃并新建
                    </button>
                  )}
                  <span
                    className={`methodology-footer-status${manualDraftSaveState === "error" ? " error" : ""}`}
                    role="status"
                  >
                    {manualDraftSaveState === "saving"
                      ? "正在保存…"
                      : manualDraftSaveState === "saved"
                        ? "已自动保存"
                        : manualDraftSaveState === "error"
                          ? "自动保存失败"
                          : "本机草稿"}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={manualSaving}
                  onClick={() => void backToChooser()}
                >
                  返回选择
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={manualSaving || !manualDraftValid}
                  onClick={() => void saveManualMethodology()}
                >
                  {manualSaving ? "正在保存…" : "保存为待确认候选"}
                </button>
              </>
            )
          }
        >
          {creationMode === "chooser" ? (
            <section className="methodology-create-chooser">
              <div className="methodology-create-options">
                <button
                  type="button"
                  className="methodology-create-option manual"
                  onClick={openManualCreation}
                >
                  <span>
                    <strong>人工编写</strong>
                    <em>0 次模型调用</em>
                  </span>
                  <p>直接填写原则、适用条件与注意事项。</p>
                  <small>
                    {manualFormDrafts.some(
                      (draft) => draft.key === "methodology_manual",
                    )
                      ? "有未完成草稿 · 点击继续"
                      : "保存后标为“待验证”，可稍后关联复盘证据。"}
                  </small>
                </button>
                <button
                  type="button"
                  className="methodology-create-option evidence methodology-generate-button"
                  onClick={openEvidenceCreation}
                >
                  <span>
                    <strong>从复盘提炼</strong>
                    <em>0 或 1 次调用</em>
                  </span>
                  <p>选择 1–5 条完整复盘，再决定人工整理或模型提炼。</p>
                  <small>
                    {manualFormDrafts.some(
                      (draft) => draft.key === "methodology_evidence_manual",
                    )
                      ? "有未完成的人工整理草稿 · 点击继续"
                      : suggestions.length > 0
                        ? `已有 ${suggestions.length} 组证据建议可选`
                        : "需要至少一条完整复盘"}
                  </small>
                </button>
                <button
                  type="button"
                  className="methodology-create-option markdown methodology-import-button"
                  disabled={importing}
                  onClick={() => {
                    setCreationMode(null);
                    void importMarkdown();
                  }}
                >
                  <span>
                    <strong>导入 Markdown</strong>
                    <em>本地预检</em>
                  </span>
                  <p>从已有文档拆分并预览原则候选。</p>
                  <small>写入前可逐条选择，重复内容会自动跳过。</small>
                </button>
              </div>
              <p className="methodology-dialog-note methodology-create-boundary">
                <span>不会自动采纳</span>
                <span>不会自动建立证据关系</span>
                <span>采纳后才进入图谱和「技能与流程」</span>
              </p>
            </section>
          ) : (
            <section className="methodology-manual-entry">
              {manualDraftRestoredAt === null ? null : (
                <p className="methodology-dialog-note">
                  <strong>已恢复未完成草稿</strong> ·{" "}
                  {dateFormatter.format(new Date(manualDraftRestoredAt))}{" "}
                  保存，只在本机可见。
                </p>
              )}
              <div className="form-fields methodology-manual-entry-form">
                <div className="form-field">
                  <label htmlFor="methodology-manual-title">标题</label>
                  <input
                    id="methodology-manual-title"
                    autoFocus
                    maxLength={120}
                    value={manualDraft.title}
                    onChange={(event) =>
                      setManualDraft({
                        ...manualDraft,
                        title: event.currentTarget.value,
                      })
                    }
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="methodology-manual-principle">原则</label>
                  <textarea
                    id="methodology-manual-principle"
                    rows={3}
                    maxLength={2_000}
                    value={manualDraft.principle}
                    onChange={(event) =>
                      setManualDraft({
                        ...manualDraft,
                        principle: event.currentTarget.value,
                      })
                    }
                  />
                </div>
                <div className="form-fields-row">
                  <div className="form-field">
                    <label htmlFor="methodology-manual-applies">适用条件</label>
                    <textarea
                      id="methodology-manual-applies"
                      rows={3}
                      maxLength={2_000}
                      value={manualDraft.appliesWhen}
                      onChange={(event) =>
                        setManualDraft({
                          ...manualDraft,
                          appliesWhen: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="methodology-manual-caution">注意事项</label>
                    <textarea
                      id="methodology-manual-caution"
                      rows={3}
                      maxLength={2_000}
                      value={manualDraft.caution}
                      onChange={(event) =>
                        setManualDraft({
                          ...manualDraft,
                          caution: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                </div>
              </div>
              <p className="methodology-dialog-note methodology-manual-entry-safety">
                系统不会补写事实或调用模型，也不会把人工输入视为已有证据支持；保存后仍需单独审核。未完成的内容只自动保存在这台 Mac 上。
              </p>
              {manualError === null ? null : (
                <p className="form-error" role="alert">
                  暂时无法保存：{manualError}
                </p>
              )}
              {manualDraftStorageError === null ? null : (
                <p className="form-error" role="alert">
                  草稿箱暂不可用：{manualDraftStorageError}
                </p>
              )}
            </section>
          )}
        </ModalDialog>
      )}

      {importPreview === null ? null : (
        <ModalDialog
          title="预检 Markdown 导入"
          description="先核对拆分结果，只会写入本次明确勾选的候选。"
          size="wide"
          dismissible={!importSaving}
          onClose={closeImportPreview}
          footer={
            <>
              <button
                type="button"
                className="secondary-button"
                disabled={importSaving}
                onClick={closeImportPreview}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={importSaving || selectedImportCandidates.length === 0}
                onClick={() => void commitMarkdownImport()}
              >
                {importSaving
                  ? "正在导入…"
                  : `导入 ${selectedImportCandidates.length} 条候选`}
              </button>
            </>
          }
        >
          <section className="methodology-import-preview">
            <div
              className="methodology-import-summary"
              role="group"
              aria-label="导入预检结果"
            >
              <div>
                <strong>{importPreview.candidates.length}</strong>
                <span>可选候选</span>
              </div>
              <div>
                <strong>{importPreview.duplicates.length}</strong>
                <span>完全重复</span>
              </div>
              <div>
                <strong>
                  {
                    importPreview.candidates.filter(
                      (candidate) => candidate.similarTo !== null,
                    ).length
                  }
                </strong>
                <span>可能重复</span>
              </div>
              <div>
                <strong>
                  {
                    importPreview.candidates.filter(
                      (candidate) => candidate.missingFields.length > 0,
                    ).length
                  }
                </strong>
                <span>边界待补</span>
              </div>
            </div>

            <div className="methodology-import-selection-heading">
              <div>
                <strong>选择要导入的原则</strong>
                <span>
                  已选 {selectedImportCandidates.length} /{" "}
                  {importPreview.candidates.length}
                </span>
              </div>
              <div>
                <button
                  type="button"
                  className="text-button"
                  disabled={importSaving}
                  onClick={() =>
                    chooseImportCandidates(
                      importPreview.candidates.map((candidate) => candidate.id),
                    )
                  }
                >
                  全选
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={
                    importSaving || selectedImportCandidates.length === 0
                  }
                  onClick={() => chooseImportCandidates([])}
                >
                  清空
                </button>
              </div>
            </div>

            <ol className="methodology-import-candidates">
              {importPreview.candidates.map((candidate) => {
                const checked = selectedImportCandidates.includes(candidate.id);
                return (
                  <li key={candidate.id}>
                    <label className={checked ? "selected" : undefined}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={importSaving}
                        onChange={() => toggleImportCandidate(candidate.id)}
                      />
                      <span className="methodology-import-candidate-copy">
                        <span className="methodology-import-candidate-heading">
                          <strong>{candidate.title}</strong>
                          <small>{candidate.fileName}</small>
                        </span>
                        <span>{candidate.principle}</span>
                        <span className="methodology-import-candidate-meta">
                          {candidate.missingFields.length > 0 ? (
                            <em className="warning">
                              {candidate.missingFields.length === 2
                                ? "适用条件与边界待补"
                                : candidate.missingFields[0] === "appliesWhen"
                                  ? "适用条件待补"
                                  : "注意事项待补"}
                            </em>
                          ) : (
                            <em>结构完整</em>
                          )}
                          {candidate.sourceDecisionCount > 0 ? (
                            <em>{candidate.sourceDecisionCount} 条来源编号</em>
                          ) : (
                            <em>尚无复盘证据</em>
                          )}
                          {candidate.similarTo === null ? null : (
                            <em className="similar">
                              可能重复：{candidate.similarTo.title}
                            </em>
                          )}
                        </span>
                      </span>
                    </label>
                    <details className="disclosure methodology-import-candidate-details">
                      <summary>核对适用条件与边界</summary>
                      <dl>
                        <div>
                          <dt>适用条件</dt>
                          <dd>{candidate.appliesWhen}</dd>
                        </div>
                        <div>
                          <dt>注意事项</dt>
                          <dd>{candidate.caution}</dd>
                        </div>
                      </dl>
                    </details>
                  </li>
                );
              })}
            </ol>

            {importPreview.duplicates.length === 0 &&
            importPreview.failures.length === 0 ? null : (
              <details className="disclosure methodology-import-issues">
                <summary>
                  查看已跳过与未识别内容（
                  {importPreview.duplicates.length +
                    importPreview.failures.length}
                  ）
                </summary>
                <ul>
                  {importPreview.duplicates.map((duplicate, index) => (
                    <li
                      key={`duplicate:${duplicate.fileName}:${duplicate.title}:${index}`}
                    >
                      <strong>完全重复</strong>
                      <span>
                        {duplicate.fileName} · {duplicate.title}（已有“
                        {duplicate.existingTitle}”）
                      </span>
                    </li>
                  ))}
                  {importPreview.failures.map((failure, index) => (
                    <li key={`failure:${failure.fileName}:${index}`}>
                      <strong>未识别</strong>
                      <span>
                        {failure.fileName}
                        {failure.title === undefined
                          ? ""
                          : ` · ${failure.title}`}
                        ：{failure.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <p className="methodology-dialog-note methodology-import-safety">
              导入后仍是待确认候选，不会自动采纳、调用模型或生成技能与流程。
            </p>
            {importError === null ? null : (
              <p className="form-error" role="alert">
                导入失败：{importError}
              </p>
            )}
          </section>
        </ModalDialog>
      )}

      {workbenchOpen ? (
        <ModalDialog
          title="方法论工作箱"
          description="把新增复盘、原则复验和关系核对集中在一个入口，逐项处理才会改变知识事实。"
          size="wide"
          onClose={() => setWorkbenchOpen(false)}
          footer={
            <button
              type="button"
              className="secondary-button"
              onClick={() => setWorkbenchOpen(false)}
            >
              关闭
            </button>
          }
        >
          <section className="methodology-workbench">
            <ol>
              {(
                [
                  {
                    className: "methodology-materials-button",
                    label: "复盘素材",
                    detail: "把尚未使用的完整复盘整理成可解释证据组合。",
                    count: suggestions.length,
                    loading: suggestionLoading,
                    disabled: suggestionLoading,
                    open: openSuggestionInbox,
                  },
                  {
                    className: "methodology-validation-button",
                    label: "原则复验",
                    detail: "核对已采纳原则在新增真实结果中是否仍然适用。",
                    count: validationItems.length,
                    loading: validationLoading,
                    disabled: validationLoading,
                    open: openValidationInbox,
                  },
                  {
                    className: "methodology-relations-button",
                    label: "关系核对",
                    detail: "集中判断相近或冲突原则，结论仍需逐组确认。",
                    count: relationCount,
                    loading: relationQueueLoading,
                    disabled: importing || batchGenerating || relationQueueLoading,
                    open: () => void openRelationQueue(),
                  },
                ] as const
              ).map((queue) => (
                <li key={queue.label}>
                  <button
                    type="button"
                    className={queue.className}
                    aria-label={`${queue.label} ${queue.count}`}
                    disabled={queue.disabled}
                    onClick={() => {
                      setWorkbenchOpen(false);
                      queue.open();
                    }}
                  >
                    <span>
                      <strong>{queue.label}</strong>
                      <small>{queue.detail}</small>
                    </span>
                    {/* Waiting for the reader, as the header's count says; none waiting is not a call to act. */}
                    <em
                      className={
                        !queue.loading && queue.count > 0
                          ? "methodology-workbench-count"
                          : undefined
                      }
                    >
                      {queue.loading ? "…" : queue.count}
                    </em>
                    <b aria-hidden="true">›</b>
                  </button>
                </li>
              ))}
            </ol>
            <p className="methodology-dialog-note">
              这里只汇总本地状态，不会自动生成、采纳或修改原则。三个队列相互独立；关闭工作箱不会确认或忽略任何事项。
            </p>
          </section>
        </ModalDialog>
      ) : null}

      {validationInboxOpen ? (
        <ModalDialog
          title="原则复验"
          description="集中核对已采纳原则在后续真实使用中的新复盘；结论必须由你确认。"
          size="wide"
          dismissible={validationActionId === null}
          onClose={closeValidationInbox}
          footer={
            <button
              type="button"
              className="secondary-button"
              disabled={validationActionId !== null}
              onClick={closeValidationInbox}
            >
              关闭
            </button>
          }
        >
          <section
            className="methodology-validation-inbox"
            aria-busy={validationLoading}
          >
            <header className="methodology-inbox-heading">
              <p className="methodology-dialog-note">
                <strong>只处理采用后的新增复盘</strong>
                ：不会把相关性当作因果，也不会自动提高可信度或改写原则。
              </p>
              {/* A failed read counts nothing: "0 条" there read as nothing left to check. */}
              <span>
                {validationError !== null
                  ? "—"
                  : validationLoading
                    ? "正在读取…"
                    : `${validationItems.length} 条原则待核对`}
              </span>
            </header>

            {validationError !== null ? (
              <div className="load-failure" role="alert">
                <span>原则复验暂时无法读取：{validationError}</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={retryValidation}
                >
                  重试
                </button>
              </div>
            ) : validationLoading ? (
              <p className="methodology-inbox-state" role="status">
                正在核对采用后的复盘…
              </p>
            ) : validationItems.length === 0 ? (
              <div className="methodology-inbox-state">
                <strong>没有待复验原则</strong>
                <span>
                  后续决策明确关联已采纳原则，并完成结果复盘后，会自动出现在这里。
                </span>
              </div>
            ) : (
              <ol className="methodology-validation-list">
                {validationItems.map((item) => (
                  <li key={item.principleId}>
                    <article>
                      <header>
                        <div>
                          <span>已采纳原则</span>
                          <strong>{item.title}</strong>
                          <p>{item.principle}</p>
                        </div>
                        <em>
                          {item.revisionDraftId === null
                            ? `${item.newReviewedCount} 条新复盘`
                            : "已有修订草案"}
                        </em>
                      </header>
                      <div className="methodology-validation-metrics">
                        <span className="favorable">
                          <strong>{item.favorableCount}</strong> 符合或优于预期
                        </span>
                        <span className="attention">
                          <strong>{item.attentionCount}</strong> 有偏差
                        </span>
                        <span>
                          <strong>{item.unclearCount}</strong> 暂不明确
                        </span>
                      </div>
                      <ol className="methodology-validation-decisions">
                        {item.decisions.map((decision) => (
                          <li key={decision.id}>
                            <button
                              type="button"
                              disabled={validationActionId !== null}
                              onClick={() => {
                                closeValidationInbox();
                                onOpenDecision(decision.id);
                              }}
                            >
                              <span>
                                {decision.project} ·{" "}
                                {verdictLabels[decision.verdict]}
                              </span>
                              <strong className="question-clamp">{plainHeadline(decision.question)}</strong>
                              <small>
                                {decision.lesson ?? decision.selectedAnswer}
                              </small>
                              <b aria-hidden="true">›</b>
                            </button>
                          </li>
                        ))}
                      </ol>
                      <footer>
                        <small>
                          {item.revisionDraftId === null
                            ? "确认仍适用只记录本次人工核对，不改变原则内容。"
                            : "先处理已有修订草案，再决定是否确认其余结果。"}
                        </small>
                        <div>
                          <button
                            type="button"
                            className="text-button"
                            disabled={validationActionId !== null}
                            onClick={() => openValidationItem(item)}
                          >
                            {item.revisionDraftId === null
                              ? "查看并修订"
                              : "查看修订草案"}
                          </button>
                          {/* One per principle, so not solid: the list held as many filled buttons as principles. */}
                          {item.revisionDraftId === null ? (
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={validationActionId !== null}
                              onClick={() => void acknowledgeValidation(item)}
                            >
                              {validationActionId === item.principleId
                                ? "正在确认…"
                                : "确认仍适用"}
                            </button>
                          ) : null}
                        </div>
                      </footer>
                    </article>
                  </li>
                ))}
              </ol>
            )}
            {validationActionError === null ? null : (
              <p className="form-error" role="alert">
                操作未完成：{validationActionError}
              </p>
            )}
          </section>
        </ModalDialog>
      ) : null}

      {suggestionInboxOpen ? (
        <ModalDialog
          title="复盘素材"
          description="把已完成的结果复盘整理成可审核的证据组合；浏览和搁置都不会调用模型。"
          size="wide"
          dismissible={suggestionActionId === null && !batchGenerating}
          onClose={closeSuggestionInbox}
          footer={
            <button
              type="button"
              className="secondary-button"
              disabled={suggestionActionId !== null || batchGenerating}
              onClick={closeSuggestionInbox}
            >
              关闭
            </button>
          }
        >
          <section
            className="methodology-material-inbox"
            aria-busy={suggestionLoading}
          >
            <header>
              <div
                className="methodology-status-filter methodology-material-modes"
                role="group"
                aria-label="复盘素材状态"
              >
                {/* An empty side next to one with groups cannot be shown (the inbox moves straight back): not offered. */}
                <button
                  type="button"
                  aria-pressed={suggestionInboxMode === "active"}
                  disabled={
                    suggestions.length === 0 && deferredSuggestions.length > 0
                  }
                  onClick={() => showSuggestions("active")}
                >
                  可提炼{" "}
                  <strong>
                    {suggestionError === null ? suggestions.length : "—"}
                  </strong>
                </button>
                <button
                  type="button"
                  aria-pressed={suggestionInboxMode === "deferred"}
                  disabled={
                    deferredSuggestions.length === 0 && suggestions.length > 0
                  }
                  onClick={() => showSuggestions("deferred")}
                >
                  已搁置{" "}
                  <strong>
                    {suggestionError === null
                      ? deferredSuggestions.length
                      : "—"}
                  </strong>
                </button>
              </div>
              {suggestionInboxMode === "active" && suggestions.length > 1 ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={batchGenerating || suggestionActionId !== null}
                  onClick={() => {
                    closeSuggestionInbox();
                    setConfirmingBatch(true);
                  }}
                >
                  批量提炼 {suggestionBatch.length} 组
                </button>
              ) : null}
            </header>

            {suggestionError !== null ? (
              <div className="load-failure" role="alert">
                <span>复盘素材暂时无法读取：{suggestionError}</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={retrySuggestions}
                >
                  重试
                </button>
              </div>
            ) : suggestionLoading ? (
              <p className="methodology-inbox-state" role="status">
                正在整理完整复盘…
              </p>
            ) : visibleSuggestionInboxItems.length === 0 ? (
              <div className="methodology-inbox-state">
                <strong>
                  {suggestionInboxMode === "active"
                    ? "暂时没有新的可提炼素材"
                    : "没有已搁置素材"}
                </strong>
                <span>
                  {suggestionInboxMode === "active"
                    ? "为决策记录实际结果并完成复盘后，相关素材会自动出现在这里。"
                    : "选择“稍后再看”的证据组合会保留在这里，可以随时恢复。"}
                </span>
              </div>
            ) : (
              <ol className="methodology-material-list">
                {visibleSuggestionInboxItems.map((suggestion) => (
                  <li key={suggestion.id}>
                    <article>
                      <header>
                        <div>
                          <strong>{suggestion.title}</strong>
                          <span>{suggestion.summary}</span>
                        </div>
                        <em className={suggestion.readiness}>
                          {suggestionReadinessLabels[suggestion.readiness]}
                        </em>
                      </header>
                      <div className="methodology-material-metrics">
                        <span>
                          {suggestionDirectionLabels[suggestion.direction]}
                        </span>
                        <span>{suggestion.evidenceCount} 条复盘</span>
                        <span>{suggestion.projectCount} 个项目</span>
                      </div>
                      <ol className="methodology-material-sources">
                        {suggestion.sources.slice(0, 2).map((source) => (
                          <li key={source.id}>
                            <span>{source.project}</span>
                            <strong className="question-clamp">{plainHeadline(source.question)}</strong>
                            <small>
                              {source.outcomeLesson ?? "已完成结果复盘"}
                            </small>
                          </li>
                        ))}
                      </ol>
                      <footer>
                        {suggestionInboxMode === "active" ? (
                          <>
                            <button
                              type="button"
                              className="text-button"
                              disabled={suggestionActionId !== null}
                              onClick={() => void deferSuggestion(suggestion)}
                            >
                              {suggestionActionId === suggestion.id
                                ? "正在搁置…"
                                : "稍后再看"}
                            </button>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={suggestionActionId !== null}
                              onClick={() => {
                                closeSuggestionInbox();
                                openSourceChooser(suggestion.sourceDecisionIds);
                              }}
                            >
                              核对证据并提炼
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="secondary-button"
                            disabled={suggestionActionId !== null}
                            onClick={() => void restoreSuggestion(suggestion)}
                          >
                            {suggestionActionId === suggestion.id
                              ? "正在恢复…"
                              : "恢复到可提炼"}
                          </button>
                        )}
                      </footer>
                    </article>
                  </li>
                ))}
              </ol>
            )}
            {suggestionActionError === null ? null : (
              <p className="form-error" role="alert">
                操作未完成：{suggestionActionError}
              </p>
            )}

            <p className="methodology-dialog-note methodology-material-boundary">
              <span>本地整理</span>
              <span>不会自动生成原则</span>
              <span>不会自动采纳或发布</span>
            </p>
          </section>
        </ModalDialog>
      ) : null}

      {choosingSources ? (
        <ModalDialog
          title={linkingEvidence ? "关联复盘证据" : "选择复盘证据"}
          description={
            linkingEvidence
              ? "选择 1 至 5 条真正支持这项原则的已复盘决策。"
              : "选择 1 至 5 条决策；多条一致证据能提高候选可信度。"
          }
          size="wide"
          dismissible={!generating}
          onClose={() => {
            cancelPendingLoad();
            closeSourceChooser();
          }}
          footer={
            <>
              <span className="modal-dialog-footer-start methodology-footer-status">
                已选 {selectedSources.length} / 5
                {suggestionLoading ? " · 正在整理建议" : ""}
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={generating}
                onClick={closeSourceChooser}
              >
                取消
              </button>
              {linkingEvidence ? (
                <button
                  type="button"
                  className="primary-button"
                  disabled={generating || selectedSources.length === 0}
                  onClick={() => void saveEvidenceLinks()}
                >
                  {generating ? "正在保存…" : "保存证据关联"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="secondary-button methodology-manual-evidence-button"
                    disabled={
                      generating ||
                      sourceLoading ||
                      selectedSources.length === 0
                    }
                    onClick={beginManualEvidenceMethodology}
                  >
                    人工整理 · 0 次
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={generating || selectedSources.length === 0}
                    onClick={() => void generate()}
                  >
                    {generating ? "正在提炼…" : "模型提炼 · 1 次"}
                  </button>
                </>
              )}
            </>
          }
        >
          <section className="methodology-source-chooser">
            {linkingEvidence || suggestions.length === 0 ? null : (
              <section
                className="methodology-suggestion-picker"
                aria-label="建议证据组合"
              >
                <header>
                  <div>
                    <strong>建议组合</strong>
                    <span>按相近内容、结果方向与项目覆盖度整理</span>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => {
                      closeSourceChooser();
                      setConfirmingBatch(true);
                    }}
                  >
                    批量生成 {suggestionBatch.length} 条
                  </button>
                </header>
                <div>
                  {suggestions.slice(0, 4).map((suggestion) => {
                    const selected =
                      suggestion.sourceDecisionIds.length ===
                        selectedSources.length &&
                      suggestion.sourceDecisionIds.every((id) =>
                        selectedSources.includes(id),
                      );
                    return (
                      <button
                        key={suggestion.id}
                        type="button"
                        aria-pressed={selected}
                        onClick={() =>
                          chooser.choose(suggestion.sourceDecisionIds)
                        }
                      >
                        <span>
                          <strong>{suggestion.title}</strong>
                          <em className={suggestion.readiness}>
                            {suggestionReadinessLabels[suggestion.readiness]}
                          </em>
                        </span>
                        <small>{suggestion.summary}</small>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            {linkingEvidence || suggestionError === null ? null : (
              <p className="methodology-suggestion-error">
                建议暂时无法读取，仍可手动选择：{suggestionError}
              </p>
            )}
            {linkingEvidence && !sourceLoading ? (
              <section
                className="methodology-evidence-match-picker"
                aria-label="证据匹配建议"
              >
                <header>
                  <div>
                    <strong>匹配建议</strong>
                    <span>先看文本重合，再补语义相近项供人工核对</span>
                  </div>
                  <span>{evidenceMatches.length} 条</span>
                </header>
                {evidenceMatchLoading ? (
                  <p>正在匹配原则与复盘证据…</p>
                ) : evidenceMatchError !== null ? (
                  <p>匹配建议暂不可用，仍可手动选择：{evidenceMatchError}</p>
                ) : evidenceMatches.length === 0 ? (
                  <p>
                    没有发现足够明确的匹配。请搜索或手动选择，避免强行关联。
                  </p>
                ) : (
                  <ol>
                    {evidenceMatches.map((match) => {
                      const decision = reviewedDecisions.find(
                        (item) => item.id === match.sourceDecisionId,
                      );
                      if (decision === undefined) return null;
                      const checked = selectedSources.includes(decision.id);
                      return (
                        <li key={decision.id}>
                          <button
                            type="button"
                            aria-pressed={checked}
                            disabled={!checked && selectedSources.length >= 5}
                            onClick={() => toggleSource(decision.id)}
                          >
                            <span>
                              <strong className="question-clamp">{plainHeadline(decision.question)}</strong>
                              <em
                                className={
                                  match.matchKind === "semantic"
                                    ? "semantic"
                                    : match.strength
                                }
                              >
                                {match.alreadyLinked
                                  ? "已关联"
                                  : match.matchKind === "semantic"
                                    ? "语义相近"
                                    : evidenceMatchLabels[match.strength]}
                              </em>
                            </span>
                            <small>{match.reason}</small>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
            ) : null}
            <div className="methodology-source-list-heading">
              <strong>全部已复盘证据</strong>
              <span>
                {sourceLoading
                  ? "正在读取…"
                  : sourceQuery.length > 0
                    ? `${visibleReviewedDecisions.length} / ${reviewedDecisions.length} 条`
                    : `${reviewedDecisions.length} 条`}
              </span>
            </div>
            {sourceLoading || reviewedDecisions.length === 0 ? null : (
              <label className="methodology-source-search">
                <span className="sr-only">搜索复盘证据</span>
                <input
                  type="search"
                  value={sourceQuery}
                  placeholder="搜索问题、选择、项目或复盘经验"
                  onChange={(event) => searchSources(event.target.value)}
                />
              </label>
            )}
            {sourceLoading ? (
              <p className="methodology-inbox-state" role="status">
                正在读取已复盘决策…
              </p>
            ) : reviewedDecisions.length === 0 ? (
              <div className="methodology-inbox-state">
                <strong>还没有可用证据</strong>
                <span>先在知识页记录实际结果并完成复盘。</span>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    cancelPendingLoad();
                    closeSourceChooser();
                    void api.openSurface("decisions");
                  }}
                >
                  去复盘决策
                </button>
              </div>
            ) : visibleReviewedDecisions.length === 0 ? (
              <div className="methodology-inbox-state">
                <strong>没有匹配的复盘</strong>
                <span>换个关键词，或清空搜索查看全部证据。</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => searchSources("")}
                >
                  清空搜索
                </button>
              </div>
            ) : (
              <ol className="methodology-source-list">
                {visibleReviewedDecisions.map((decision) => {
                  const checked = selectedSources.includes(decision.id);
                  return (
                    <li key={decision.id}>
                      <label className={checked ? "selected" : ""}>
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!checked && selectedSources.length >= 5}
                          onChange={() => toggleSource(decision.id)}
                        />
                        <span>
                          <strong className="question-clamp">{plainHeadline(decision.question)}</strong>
                          <small>
                            {decision.selectedAnswer} · {decision.project}
                          </small>
                        </span>
                        {decision.outcomeReview === null ? null : (
                          <em>
                            {verdictLabels[decision.outcomeReview.verdict]}
                          </em>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ol>
            )}
            {generationError === null ? null : (
              <p className="form-error" role="alert">
                {linkingEvidence ? "暂时无法保存关联" : "暂时无法提炼"}：
                {generationError}
              </p>
            )}
          </section>
        </ModalDialog>
      ) : null}

      {manualEvidenceDraft === null ? null : (
        <ModalDialog
          title="人工整理原则候选"
          description={`基于已选择的 ${manualEvidenceDraft.sourceDecisionIds.length} 条完整复盘，由你归纳原则内容。`}
          size="wide"
          dismissible={!manualEvidenceSaving}
          onClose={closeManualEvidenceMethodology}
          footer={
            <>
              <div className="modal-dialog-footer-start">
                {manualEvidenceRestoredAt === null ? null : (
                  <button
                    type="button"
                    className="text-button danger-button"
                    disabled={manualEvidenceSaving}
                    onClick={() => void discardManualEvidenceMethodologyDraft()}
                  >
                    {manualEvidencePendingSources === null
                      ? "丢弃并重写"
                      : `丢弃并使用刚选的 ${manualEvidencePendingSources.length} 条证据`}
                  </button>
                )}
                <span
                  className={`methodology-footer-status${manualEvidenceDraftSaveState === "error" ? " error" : ""}`}
                  role="status"
                >
                  {manualEvidenceDraftSaveState === "saving"
                    ? "正在保存…"
                    : manualEvidenceDraftSaveState === "saved"
                      ? "已自动保存"
                      : manualEvidenceDraftSaveState === "error"
                        ? "自动保存失败"
                        : "本机草稿"}
                </span>
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={manualEvidenceSaving}
                onClick={closeManualEvidenceMethodology}
              >
                返回选择证据
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={manualEvidenceSaving || !manualEvidenceDraftValid}
                onClick={() => void saveManualEvidenceMethodology()}
              >
                {manualEvidenceSaving ? "正在保存…" : "保存人工候选"}
              </button>
            </>
          }
        >
          <section className="methodology-manual-evidence-entry">
            <header className="methodology-inbox-heading">
              <p className="methodology-dialog-note">
                <strong>证据已经确定，内容完全由你填写</strong>
                ：不调用模型，也不会根据复盘正文自动补写原则或因果结论。
              </p>
              <em className="methodology-tag">0 次模型调用</em>
            </header>

            {manualEvidenceRestoredAt === null ? null : (
              <p className="methodology-dialog-note">
                <strong>已恢复未完成的人工整理</strong> ·{" "}
                {dateFormatter.format(new Date(manualEvidenceRestoredAt))}{" "}
                保存，尚未建立方法论候选。
              </p>
            )}

            <ol className="methodology-manual-evidence-sources">
              {sourceLoading ? (
                <li className="loading">
                  <span>正在恢复</span>
                  <strong>正在读取草稿关联的复盘证据…</strong>
                </li>
              ) : null}
              {manualEvidenceDecisions.slice(0, 5).map((decision, index) => (
                <li key={decision.id}>
                  <span>证据 {index + 1}</span>
                  <strong className="question-clamp">{plainHeadline(decision.question)}</strong>
                  <small>
                    {decision.project} · {decision.selectedAnswer}
                  </small>
                  <p>
                    {decision.outcomeReview?.lesson ??
                      decision.outcome ??
                      "已完成结果复盘"}
                  </p>
                </li>
              ))}
            </ol>

            <div className="form-fields methodology-manual-evidence-form">
              <div className="form-field">
                <label htmlFor="methodology-evidence-title">候选标题</label>
                <input
                  id="methodology-evidence-title"
                  autoFocus
                  value={manualEvidenceDraft.title}
                  placeholder="例如：先验证，再扩大不可逆投入"
                  maxLength={120}
                  onChange={(event) =>
                    updateManualEvidenceDraft({ title: event.target.value })
                  }
                />
              </div>
              <div className="form-field">
                <label htmlFor="methodology-evidence-principle">原则</label>
                <textarea
                  id="methodology-evidence-principle"
                  rows={3}
                  value={manualEvidenceDraft.principle}
                  placeholder="以后遇到类似决策时，应该如何判断或行动？"
                  maxLength={2_000}
                  onChange={(event) =>
                    updateManualEvidenceDraft({
                      principle: event.target.value,
                    })
                  }
                />
              </div>
              <div className="form-fields-row">
                <div className="form-field">
                  <label htmlFor="methodology-evidence-applies">适用条件</label>
                  <textarea
                    id="methodology-evidence-applies"
                    rows={3}
                    value={manualEvidenceDraft.appliesWhen}
                    placeholder="什么场景和前提下适用？"
                    maxLength={2_000}
                    onChange={(event) =>
                      updateManualEvidenceDraft({
                        appliesWhen: event.target.value,
                      })
                    }
                  />
                </div>
                <div className="form-field">
                  <label htmlFor="methodology-evidence-caution">注意事项</label>
                  <textarea
                    id="methodology-evidence-caution"
                    rows={3}
                    value={manualEvidenceDraft.caution}
                    placeholder="什么情况下不应套用，或需要重新验证？"
                    maxLength={2_000}
                    onChange={(event) =>
                      updateManualEvidenceDraft({ caution: event.target.value })
                    }
                  />
                </div>
              </div>
              <div className="form-field">
                <label htmlFor="methodology-evidence-summary">证据摘要</label>
                <textarea
                  id="methodology-evidence-summary"
                  rows={3}
                  value={manualEvidenceDraft.evidenceSummary}
                  placeholder="区分已观察到的结果与有限归纳，并用“证据 1”等编号对应上方复盘。"
                  maxLength={3_000}
                  onChange={(event) =>
                    updateManualEvidenceDraft({
                      evidenceSummary: event.target.value,
                    })
                  }
                />
              </div>
            </div>

            <p className="methodology-dialog-note methodology-manual-evidence-boundary">
              <span>证据关系由你确认</span>
              <span>可信度仍由复盘数量与一致性计算</span>
              <span>保存后只进入待确认列表</span>
            </p>

            {manualEvidenceError === null ? null : (
              <p className="form-error" role="alert">
                暂时无法保存：{manualEvidenceError}
              </p>
            )}
            {manualDraftStorageError === null ? null : (
              <p className="form-error" role="alert">
                草稿箱暂不可用：{manualDraftStorageError}
              </p>
            )}
          </section>
        </ModalDialog>
      )}

      {confirmingBatch ? (
        <ModalDialog
          title="批量提炼方法论"
          description={`${suggestionBatch.length} 组复盘建议将依次生成候选${suggestionsAfterBatch > 0 ? `，其余 ${suggestionsAfterBatch} 组留到下一批` : ""}。`}
          size="compact"
          dismissible={!batchGenerating}
          onClose={() => setConfirmingBatch(false)}
          footer={
            <>
              <button
                type="button"
                className="secondary-button"
                autoFocus
                disabled={batchGenerating}
                onClick={() => setConfirmingBatch(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={batchGenerating || suggestionBatch.length === 0}
                onClick={() => void generateSuggestionBatch()}
              >
                {batchGenerating
                  ? "正在生成…"
                  : `生成 ${suggestionBatch.length} 条候选`}
              </button>
            </>
          }
        >
          <section className="methodology-batch-confirmation">
            <p className="methodology-batch-route">
              <span>
                <strong>{suggestionBatch.length}</strong> 组证据组合
              </span>
              <b aria-hidden="true">→</b>
              <span>
                <strong>{suggestionBatch.length}</strong> 条待确认候选
              </span>
            </p>
            <p>
              每组会调用一次当前生成模型。生成结果只进入待确认列表，不会自动采纳，也不会生成技能或流程。
            </p>
            {batchGenerating ? (
              <div className="methodology-batch-progress" role="status">
                <span>
                  正在提炼 {batchProgress.current} / {batchProgress.total}
                </span>
                <progress
                  max={Math.max(batchProgress.total, 1)}
                  value={batchProgress.current}
                />
              </div>
            ) : (
              <ol className="methodology-batch-preview">
                {suggestionBatch.slice(0, 3).map((suggestion) => (
                  <li key={suggestion.id}>{suggestion.title}</li>
                ))}
                {suggestionBatch.length > 3 ? (
                  <li>以及另外 {suggestionBatch.length - 3} 组</li>
                ) : null}
              </ol>
            )}
          </section>
        </ModalDialog>
      ) : null}

      {currentRelationQueueItem === null ? null : (
        <ModalDialog
          title="批量核对原则关系"
          description={`第 ${relationQueueCompleted + 1} 组，共 ${relationQueueTotal} 组`}
          size="wide"
          // A note typed for this group is not let go by Escape: skipped or saved, it goes with its group.
          dismissible={!relationQueueSaving}
          unsaved={relationQueueNote.trim().length > 0}
          onClose={closeRelationQueue}
          footer={
            <>
              <span className="modal-dialog-footer-start methodology-footer-status">
                还剩 {relationQueue?.length ?? 0} 组
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={relationQueueSaving}
                onClick={postponeRelationQueueItem}
              >
                {relationQueue?.length === 1 ? "稍后处理" : "跳过这一组"}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  relationQueueSaving || relationQueueDisposition === null
                }
                onClick={() => void saveRelationQueueItem()}
              >
                {relationQueueSaving ? "保存中…" : "保存并继续"}
              </button>
            </>
          }
        >
          <section className="methodology-relation-queue">
            <header>
              <div>
                <strong>
                  {currentRelationQueueItem.relation.kind ===
                  "potential_conflict"
                    ? "可能存在行动冲突"
                    : "表达可能重复"}
                </strong>
                <span>
                  {currentRelationQueueItem.relation.score > 0
                    ? `文本相似度 ${currentRelationQueueItem.relation.score}%`
                    : "需要人工判断适用边界"}
                </span>
              </div>
              <progress
                aria-label="关系核对进度"
                max={Math.max(relationQueueTotal, 1)}
                value={relationQueueCompleted}
              />
            </header>

            <div className="methodology-relation-comparison">
              {(
                [
                  ["原则 A", currentRelationQueueItem.left],
                  ["原则 B", currentRelationQueueItem.right],
                ] as const
              ).map(([label, item]) => (
                <article key={item.id}>
                  <span>
                    {label} · {statusLabels[item.status]}
                  </span>
                  <strong>{item.title}</strong>
                  <p>{item.principle}</p>
                  <small>适用：{item.appliesWhen}</small>
                </article>
              ))}
            </div>

            <p className="methodology-relation-queue-reason">
              {currentRelationQueueItem.relation.reason}
            </p>

            <div
              className="methodology-relation-queue-options"
              role="radiogroup"
              aria-label="批量关系结论"
            >
              {(
                [
                  ["duplicate", "重复", "同一条规则"],
                  ["conflict", "冲突", "方向不一致"],
                  ["unrelated", "无关", "边界不同"],
                ] as const
              ).map(([value, label, description]) => (
                <label
                  key={value}
                  className={
                    relationQueueDisposition === value ? "selected" : undefined
                  }
                >
                  <input
                    type="radio"
                    name="methodology-relation-queue-disposition"
                    value={value}
                    checked={relationQueueDisposition === value}
                    disabled={relationQueueSaving}
                    onChange={() => setRelationQueueDisposition(value)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>

            <div className="form-field methodology-relation-queue-note">
              <label htmlFor="methodology-relation-queue-note">
                判断依据（可选）
              </label>
              <textarea
                id="methodology-relation-queue-note"
                aria-label="批量核对说明（可选）"
                rows={2}
                maxLength={500}
                value={relationQueueNote}
                disabled={relationQueueSaving}
                placeholder="简要记录边界差异，之后仍可在原则详情中修改"
                onChange={(event) =>
                  setRelationQueueNote(event.currentTarget.value)
                }
              />
              <p className="methodology-field-count">
                {relationQueueNote.length} / 500
              </p>
            </div>

            <p className="methodology-dialog-note methodology-relation-queue-safety">
              <strong>只记录关系结论</strong>
              ：不会自动合并、删除或改写任何原则。
            </p>

            {relationQueueError === null ? null : (
              <p className="form-error" role="alert">
                保存失败：{relationQueueError}
              </p>
            )}
          </section>
        </ModalDialog>
      )}

      {selected !== null && reviewingRelation !== null ? (
        <ModalDialog
          title="核对原则关系"
          description="两条原则之间是什么关系，由你判断；之后仍可修改或撤销。"
          size="compact"
          dismissible={!relationSaving}
          unsaved={relationNote !== (reviewingRelation.resolutionNote ?? "")}
          onClose={() => {
            setReviewingRelation(null);
            setRelationDisposition(null);
            setRelationNote("");
            setRelationError(null);
          }}
          footer={
            <>
              {reviewingRelation.resolution === null ||
              reviewingRelation.resolution === undefined ? null : (
                <div className="modal-dialog-footer-start">
                  <button
                    type="button"
                    className="text-button danger-button"
                    disabled={relationSaving}
                    onClick={() => void clearRelationReview()}
                  >
                    撤销结论
                  </button>
                </div>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={relationSaving}
                onClick={() => {
                  setReviewingRelation(null);
                  setRelationDisposition(null);
                  setRelationNote("");
                  setRelationError(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={relationSaving || relationDisposition === null}
                onClick={() => void saveRelationReview()}
              >
                {relationSaving ? "保存中…" : "保存关系结论"}
              </button>
            </>
          }
        >
          <section className="methodology-relation-editor">
            {/* Both titles in full, side by side: in the subtitle a long first title pushed the second out of sight. */}
            <div className="methodology-relation-comparison">
              {(
                [
                  ["原则 A", selected.title],
                  ["原则 B", reviewingRelation.title],
                ] as const
              ).map(([label, title]) => (
                <article key={label}>
                  <span>{label}</span>
                  <strong>{title}</strong>
                </article>
              ))}
            </div>
            <div
              className="methodology-relation-options"
              role="radiogroup"
              aria-label="关系结论"
            >
              {(
                [
                  [
                    "duplicate",
                    "重复",
                    "两条原则表达同一规则，后续应考虑只保留一个入口。",
                  ],
                  [
                    "conflict",
                    "冲突",
                    "适用范围存在交集，但两条原则给出的行动方向不一致。",
                  ],
                  [
                    "unrelated",
                    "无关",
                    "文字看起来相近，但实际问题或适用边界不同。",
                  ],
                ] as const
              ).map(([value, label, description]) => (
                <label
                  key={value}
                  className={relationDisposition === value ? "selected" : undefined}
                >
                  <input
                    type="radio"
                    name="methodology-relation-disposition"
                    value={value}
                    checked={relationDisposition === value}
                    disabled={relationSaving}
                    onChange={() => setRelationDisposition(value)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </span>
                </label>
              ))}
            </div>
            <div className="form-field methodology-relation-note">
              <label htmlFor="methodology-relation-note">核对说明（可选）</label>
              <textarea
                id="methodology-relation-note"
                rows={3}
                maxLength={500}
                value={relationNote}
                disabled={relationSaving}
                placeholder="记录为什么作出这个判断，便于以后重新核对"
                onChange={(event) => setRelationNote(event.currentTarget.value)}
              />
              <p className="methodology-field-count">{relationNote.length} / 500</p>
            </div>
            <p className="methodology-dialog-note methodology-relation-safety-copy">
              这里只记录人工结论，不会合并、删除或改写任何原则。
            </p>
            {relationError === null ? null : (
              <p className="form-error" role="alert">
                保存失败：{relationError}
              </p>
            )}
          </section>
        </ModalDialog>
      ) : null}

      {mergeDraft === null ? null : (
        <ModalDialog
          title="建立合并草案"
          description="人工整理 2–5 条已确认重复的原则；来源继续保留"
          size="wide"
          dismissible={
            !mergeSaving && !mergeRelationSaving && !mergeDraftClosing
          }
          onClose={() => void preserveAndCloseMergeDraft()}
          footer={
            // While a missing pair is checked, that check is the step at hand; its answers sit with its question.
            mergeRelationReview !== null ? undefined : (
              <>
                <div className="modal-dialog-footer-start">
                  <button
                    type="button"
                    className="text-button danger-button"
                    disabled={
                      mergeSaving || mergeRelationSaving || mergeDraftClosing
                    }
                    onClick={() => void discardMergeFormDraft()}
                  >
                    丢弃草稿
                  </button>
                  <span
                    className={`methodology-footer-status${mergeDraftSaveState === "error" ? " error" : ""}`}
                    role="status"
                  >
                    {mergeDraftRestoredAt === null ? null : "已恢复 · "}
                    {mergeDraftSaveLabel}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={
                    mergeSaving || mergeRelationSaving || mergeDraftClosing
                  }
                  onClick={() => void preserveAndCloseMergeDraft()}
                >
                  {mergeDraftClosing ? "正在保存…" : "稍后继续"}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    mergeSaving ||
                    mergeRelationSaving ||
                    mergeDraftClosing ||
                    !mergeDraftReady
                  }
                  onClick={() => void createMergeDraft()}
                >
                  {mergeSaving ? "正在创建…" : "创建待确认草案"}
                </button>
              </>
            )
          }
        >
          <section className="methodology-merge-editor">
            <header className="methodology-merge-source-heading">
              <div>
                <strong>合并来源</strong>
                <span>每一对都必须已经人工确认重复</span>
              </div>
              <em>{mergeDraft.sources.length} / 5</em>
            </header>
            <div
              className="methodology-merge-sources"
              aria-label="合并来源原则"
            >
              {mergeDraft.sources.map((item, index) => (
                <article key={item.id}>
                  <span>来源 {index + 1}</span>
                  <strong>{item.title}</strong>
                  <p>{item.principle}</p>
                  <small>适用：{item.appliesWhen}</small>
                  {mergeDraft.sources.length > 2 ? (
                    <IconButton
                      type="button"
                      aria-label={`移除来源 ${item.title}`}
                      disabled={mergeSaving || mergeRelationReview !== null}
                      onClick={() => toggleMergeSource(item.id)}
                    >
                      <ActionIcon name="close" />
                    </IconButton>
                  ) : null}
                </article>
              ))}
            </div>

            <fieldset className="methodology-merge-source-picker">
              <legend>扩展合并组</legend>
              {mergeDraft.sources.length >= 5 ? (
                <p>已达到单次整理上限；创建后仍可继续建立下一组草案。</p>
              ) : (
                <>
                  {mergeCompatiblePrinciples.length === 0 ? null : (
                    <div className="methodology-merge-direct-candidates">
                      {mergeCompatiblePrinciples.map((item) => (
                        <label key={item.id}>
                          <input
                            type="checkbox"
                            checked={false}
                            disabled={
                              mergeSaving || mergeRelationReview !== null
                            }
                            onChange={() => toggleMergeSource(item.id)}
                          />
                          <span>
                            <strong>{item.title}</strong>
                            <small>整组关系已齐全 · 可直接加入</small>
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                  {mergeReviewCandidates.length === 0 ? null : (
                    <section className="methodology-merge-review-candidates">
                      <header>
                        <strong>需要补齐成对结论</strong>
                        <span>
                          只显示已与组内至少一条原则确认重复、且没有冲突或无关结论的候选
                        </span>
                      </header>
                      <ul>
                        {mergeReviewCandidates.map((assessment) => (
                          <li key={assessment.item.id}>
                            <div>
                              <strong>{assessment.item.title}</strong>
                              <small>
                                已确认 {assessment.confirmedPairCount} 对 ·
                                待核对 {assessment.missingSources.length} 对
                              </small>
                            </div>
                            <button
                              type="button"
                              className="text-button"
                              aria-label={`核对后加入 ${assessment.item.title}`}
                              disabled={
                                mergeSaving || mergeRelationReview !== null
                              }
                              onClick={() =>
                                beginMergeRelationReview(assessment)
                              }
                            >
                              核对后加入
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                  {mergeCompatiblePrinciples.length === 0 &&
                  mergeReviewCandidates.length === 0 ? (
                    <p>
                      暂无可扩展的重复原则；没有任何已确认重复连接的原则不会在这里出现。
                    </p>
                  ) : null}
                </>
              )}
            </fieldset>

            {mergeRelationReview !== null &&
            mergeRelationCandidate !== null &&
            mergeRelationSource !== null ? (
              <section
                className="methodology-merge-relation-review"
                aria-label="补齐合并关系"
              >
                <header>
                  <div>
                    <strong>逐对核对后加入</strong>
                    <span>
                      第 {mergeRelationCompleted + 1} /
                      {mergeRelationReview.totalPairCount} 对
                    </span>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={mergeRelationSaving}
                    onClick={() => {
                      setMergeRelationReview(null);
                      setMergeRelationError(null);
                    }}
                  >
                    取消核对
                  </button>
                </header>
                <div className="methodology-merge-relation-pair">
                  {[mergeRelationSource, mergeRelationCandidate].map((item) => (
                    <article key={item.id}>
                      <strong>{item.title}</strong>
                      <p>{item.principle}</p>
                      <small>适用：{item.appliesWhen}</small>
                    </article>
                  ))}
                </div>
                <p className="methodology-merge-relation-question">
                  这两条原则是否表达同一条规则？本次判断会作为独立关系事实保存。
                </p>
                <div className="form-field methodology-merge-relation-note">
                  <label htmlFor="methodology-merge-relation-note">
                    核对说明（可选）
                  </label>
                  <textarea
                    id="methodology-merge-relation-note"
                    aria-label="合并关系核对说明（可选）"
                    rows={2}
                    maxLength={500}
                    value={mergeRelationReview.note}
                    disabled={mergeRelationSaving}
                    placeholder="记录判断依据，便于以后重新核对"
                    onChange={(event) =>
                      setMergeRelationReview({
                        ...mergeRelationReview,
                        note: event.currentTarget.value,
                      })
                    }
                  />
                </div>
                {mergeRelationError === null ? null : (
                  <p className="form-error" role="alert">
                    保存失败：{mergeRelationError}
                  </p>
                )}
                <footer>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={mergeRelationSaving}
                    onClick={() => void saveMergeRelationReview("unrelated")}
                  >
                    确认无关
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={mergeRelationSaving}
                    onClick={() => void saveMergeRelationReview("conflict")}
                  >
                    确认冲突
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={mergeRelationSaving}
                    onClick={() => void saveMergeRelationReview("duplicate")}
                  >
                    {mergeRelationSaving ? "保存中…" : "确认重复并继续"}
                  </button>
                </footer>
              </section>
            ) : mergeRelationOutcome === null ? null : (
              <p
                className="methodology-dialog-note methodology-merge-relation-outcome"
                role="status"
              >
                {mergeRelationOutcome}
              </p>
            )}

            {mergeRelationReview !== null ? null : (
              <>
                <p
                  className={`methodology-dialog-note methodology-merge-guidance${
                    mergeDraftRecoveryMessage === null ? "" : " recovered"
                  }`}
                  role="note"
                >
                  <strong>
                    {mergeDraftRecoveryMessage === null
                      ? "先以来源 1 预填"
                      : "已重新校验"}
                  </strong>
                  ：
                  {mergeDraftRecoveryMessage ??
                    "请统一表达、适用边界与注意事项；这里不会调用模型。"}
                </p>

                <div className="methodology-merge-workspace">
                  <div className="form-fields methodology-merge-fields">
                    <div className="form-field">
                      <label htmlFor="methodology-merge-title">新标题</label>
                      <input
                        id="methodology-merge-title"
                        autoFocus
                        aria-label="新标题"
                        maxLength={120}
                        value={mergeDraft.input.title}
                        disabled={mergeSaving}
                        onChange={(event) =>
                          updateMergeField("title", event.currentTarget.value)
                        }
                      />
                      <p className="methodology-field-count">
                        {mergeDraft.input.title.length} / 120
                      </p>
                    </div>
                    <div className="form-field">
                      <label htmlFor="methodology-merge-principle">
                        统一后的原则
                      </label>
                      <textarea
                        id="methodology-merge-principle"
                        rows={3}
                        maxLength={2_000}
                        value={mergeDraft.input.principle}
                        disabled={mergeSaving}
                        onChange={(event) =>
                          updateMergeField(
                            "principle",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </div>
                    <div className="form-fields-row">
                      <div className="form-field">
                        <label htmlFor="methodology-merge-applies">适用条件</label>
                        <textarea
                          id="methodology-merge-applies"
                          rows={3}
                          maxLength={2_000}
                          value={mergeDraft.input.appliesWhen}
                          disabled={mergeSaving}
                          onChange={(event) =>
                            updateMergeField(
                              "appliesWhen",
                              event.currentTarget.value,
                            )
                          }
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor="methodology-merge-caution">注意事项</label>
                        <textarea
                          id="methodology-merge-caution"
                          rows={3}
                          maxLength={2_000}
                          value={mergeDraft.input.caution}
                          disabled={mergeSaving}
                          onChange={(event) =>
                            updateMergeField("caution", event.currentTarget.value)
                          }
                        />
                      </div>
                    </div>
                    <div className="form-field">
                      <label htmlFor="methodology-merge-evidence-summary">
                        证据摘要
                      </label>
                      <textarea
                        id="methodology-merge-evidence-summary"
                        rows={3}
                        maxLength={3_000}
                        value={mergeDraft.input.evidenceSummary}
                        disabled={mergeSaving}
                        onChange={(event) =>
                          updateMergeField(
                            "evidenceSummary",
                            event.currentTarget.value,
                          )
                        }
                      />
                    </div>
                  </div>

                  <aside className="methodology-merge-support">
                    <fieldset className="methodology-merge-evidence">
                      <legend>
                        <span>保留哪些复盘证据</span>
                        <small>
                          已选 {mergeDraft.input.sourceDecisionIds.length} / 5
                        </small>
                      </legend>
                      <div>
                        {mergeDraft.availableEvidence.map((decision) => {
                          const checked =
                            mergeDraft.input.sourceDecisionIds.includes(
                              decision.id,
                            );
                          return (
                            <label
                              key={decision.id}
                              className={checked ? "selected" : undefined}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={
                                  mergeSaving ||
                                  (!checked &&
                                    mergeDraft.input.sourceDecisionIds.length >=
                                      5)
                                }
                                onChange={() =>
                                  toggleMergeEvidence(decision.id)
                                }
                              />
                              <span>
                                <strong className="question-clamp">{plainHeadline(decision.question)}</strong>
                                <small>
                                  {decision.project}
                                  {decision.outcomeReview === null
                                    ? ""
                                    : ` · ${verdictLabels[decision.outcomeReview.verdict]}`}
                                </small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <p className="methodology-dialog-note methodology-merge-safety">
                      <strong>可回退</strong>
                      ：只新增一条待确认草案。来源原则、关系结论和已有技能与流程都不会被删除、替换或重新指向。
                    </p>
                  </aside>
                </div>

                {mergeError === null ? null : (
                  <p className="form-error" role="alert">
                    创建失败：{mergeError}
                  </p>
                )}
              </>
            )}
          </section>
        </ModalDialog>
      )}

      {mergeLifecycleOpen ? (
        <ModalDialog
          title="整理合并来源"
          description="逐项迁移引用，确认无遗漏后再归档旧原则。"
          size="wide"
          dismissible={
            !mergeLifecycleSaving && mergeLifecycleBusyAssetId === null
          }
          onClose={() => {
            setMergeLifecycleOpen(false);
            setMergeLifecyclePlan(null);
            setMergeLifecycleError(null);
          }}
          footer={
            <button
              type="button"
              className="secondary-button"
              disabled={
                mergeLifecycleSaving || mergeLifecycleBusyAssetId !== null
              }
              onClick={() => {
                setMergeLifecycleOpen(false);
                setMergeLifecyclePlan(null);
                setMergeLifecycleError(null);
              }}
            >
              关闭
            </button>
          }
        >
          <section
            className="methodology-merge-lifecycle"
            aria-busy={mergeLifecycleLoading}
          >
            {mergeLifecycleLoading ? (
              <p
                className="methodology-inbox-state methodology-merge-lifecycle-loading"
                role="status"
              >
                正在核对来源原则与技能、流程引用…
              </p>
            ) : mergeLifecyclePlan === null ? (
              // A read that failed is said once, as a read: it was shown again below as 「操作失败」, though nothing was done.
              <div className="load-failure" role="alert">
                <span>
                  整理范围暂时无法读取
                  {mergeLifecycleError === null ? "" : `：${mergeLifecycleError}`}
                  。不会更改任何原则或技能与流程。
                </span>
                {selected === null ? null : (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void openMergeLifecycle(selected.id)}
                  >
                    重试
                  </button>
                )}
              </div>
            ) : (
              <>
                <div
                  className="methodology-merge-lifecycle-steps"
                  aria-label="来源整理进度"
                >
                  {(
                    [
                      [
                        "迁移引用",
                        mergeLifecyclePlan.assets.length > 0 ? "current" : "done",
                      ],
                      [
                        "审核草案",
                        mergeLifecyclePlan.pendingReviewCount > 0
                          ? "current"
                          : mergeLifecyclePlan.assets.length === 0
                            ? "done"
                            : "",
                      ],
                      [
                        "归档来源",
                        mergeLifecyclePlan.retired
                          ? "done"
                          : mergeLifecyclePlan.canRetire
                            ? "current"
                            : "",
                      ],
                    ] as const
                  ).map(([label, state], index) => (
                    <Fragment key={label}>
                      {index === 0 ? null : <i aria-hidden="true" />}
                      {/* Done, current and still ahead read apart: current and done were the same green, so at the last step all three were. */}
                      <span
                        className={state}
                        aria-current={state === "current" ? "step" : undefined}
                      >
                        <b aria-hidden="true">{state === "done" ? "✓" : index + 1}</b>
                        <small>
                          {label}
                          {state === "done" ? (
                            <span className="sr-only">（已完成）</span>
                          ) : null}
                        </small>
                      </span>
                    </Fragment>
                  ))}
                </div>

                <section className="methodology-merge-lifecycle-sources">
                  <header>
                    <div>
                      <span>合并后的原则</span>
                      <strong>{mergeLifecyclePlan.mergeTitle}</strong>
                    </div>
                    <em className={`methodology-status ${mergeLifecyclePlan.mergeStatus}`}>
                      {statusLabels[mergeLifecyclePlan.mergeStatus]}
                    </em>
                  </header>
                  <ol>
                    {mergeLifecyclePlan.sources.map((source, index) => (
                      <li key={source.id}>
                        <span>来源 {index + 1}</span>
                        <strong>{source.title}</strong>
                        <small>{statusLabels[source.status]}</small>
                      </li>
                    ))}
                  </ol>
                </section>

                {!mergeLifecyclePlan.relationValid ? (
                  <div className="methodology-merge-lifecycle-warning">
                    <strong>重复关系已经变化</strong>
                    <span>
                      请确认全部来源之间的成对重复结论，当前不会生成草案或归档。
                    </span>
                  </div>
                ) : mergeLifecyclePlan.assets.length > 0 ? (
                  <section className="methodology-merge-lifecycle-assets">
                    <header>
                      <div>
                        <strong>需要迁移的引用</strong>
                        <span>
                          {mergeLifecyclePlan.assets.length} 项 ·{" "}
                          {mergeLifecyclePlan.pendingReviewCount > 0
                            ? `${mergeLifecyclePlan.pendingReviewCount} 项待审核`
                            : `${mergeLifecyclePlan.modelCallsRequired} 次模型调用`}
                        </span>
                      </div>
                      <small>每次只处理一项</small>
                    </header>
                    <ol>
                      {mergeLifecyclePlan.assets.map((asset) => (
                        <li key={asset.id}>
                          <div>
                            <span>
                              {asset.kind === "skill" ? "技能" : "流程"} ·{" "}
                              {asset.status === "accepted"
                                ? "已采纳"
                                : "待确认"}
                            </span>
                            <strong>{asset.title}</strong>
                            <small>
                              {asset.replacementId === null
                                ? "现有内容与发布状态保持不变"
                                : "替换草案已生成，原内容尚未变更"}
                            </small>
                          </div>
                          {/* One per reference, so not solid; the dialog's one solid action is archiving at the end. */}
                          {asset.replacementId === null ? (
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={mergeLifecycleBusyAssetId !== null}
                              onClick={() =>
                                void prepareMergeAsset(
                                  mergeLifecyclePlan.mergeId,
                                  asset.id,
                                )
                              }
                            >
                              {mergeLifecycleBusyAssetId === asset.id
                                ? "正在生成…"
                                : "生成替换草案"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => {
                                setMergeLifecycleOpen(false);
                                setMergeLifecyclePlan(null);
                                chooseRecord(null);
                                setView("assets");
                              }}
                            >
                              去审核草案
                            </button>
                          )}
                        </li>
                      ))}
                    </ol>
                    <p>
                      替换草案只有在“技能与流程”中明确采纳后才会应用；这里不会批量生成、自动发布或改写已采纳内容。
                    </p>
                  </section>
                ) : mergeLifecyclePlan.retired ? (
                  <div className="methodology-merge-lifecycle-complete">
                    <div>
                      <strong>来源原则已归档</strong>
                      <span>合并原则和已审核的技能与流程保持不变。</span>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={mergeLifecycleSaving}
                      onClick={() =>
                        void restoreMergeSources(mergeLifecyclePlan.mergeId)
                      }
                    >
                      {mergeLifecycleSaving ? "正在恢复…" : "恢复来源原则"}
                    </button>
                  </div>
                ) : mergeLifecyclePlan.canRetire ? (
                  <div className="methodology-merge-lifecycle-ready">
                    <div>
                      <strong>所有引用均已迁移</strong>
                      <span>
                        现在可以归档 {mergeLifecyclePlan.sources.length}{" "}
                        条旧来源；之后仍可恢复。
                      </span>
                    </div>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={mergeLifecycleSaving}
                      onClick={() =>
                        void retireMergeSources(mergeLifecyclePlan.mergeId)
                      }
                    >
                      {mergeLifecycleSaving
                        ? "正在归档…"
                        : `归档 ${mergeLifecyclePlan.sources.length} 条来源`}
                    </button>
                  </div>
                ) : (
                  <div className="methodology-merge-lifecycle-warning">
                    <strong>暂时不能归档</strong>
                    <span>
                      {mergeLifecyclePlan.blockers.length > 0
                        ? `${mergeLifecyclePlan.blockers.join("；")}，再归档来源。`
                        : "来源原则状态已经变化，请关闭后重新核对。"}
                    </span>
                  </div>
                )}
              </>
            )}

            {mergeLifecycleError === null || mergeLifecyclePlan === null ? null : (
              <p className="form-error" role="alert">
                操作失败：{mergeLifecycleError}
              </p>
            )}
          </section>
        </ModalDialog>
      ) : null}

      {evolutionRebase === null ? null : (
        <ModalDialog
          title="迁移未完成修订"
          description="逐字段比较原基线、当前正式版本与本机草稿"
          size="wide"
          dismissible={!evolutionRebaseSaving}
          onClose={() => {
            setEvolutionRebase(null);
            setEvolutionRebaseError(null);
          }}
          footer={
            <>
              <div className="modal-dialog-footer-start">
                <button
                  type="button"
                  className="text-button danger-button"
                  disabled={evolutionRebaseSaving}
                  onClick={() => void discardEvolutionFormDraft()}
                >
                  丢弃草稿
                </button>
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={evolutionRebaseSaving}
                onClick={() => {
                  setEvolutionRebase(null);
                  setEvolutionRebaseError(null);
                }}
              >
                暂不迁移
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  evolutionRebaseSaving || evolutionRebaseUnresolvedCount > 0
                }
                onClick={() => void applyEvolutionRebase()}
              >
                {evolutionRebaseSaving ? "正在迁移…" : "迁移并继续编辑"}
              </button>
            </>
          }
        >
          <section className="methodology-revision-rebase">
            <header>
              <div>
                <strong>{evolutionRebase.source.title}</strong>
                <span>
                  正式原则在草稿保存后发生了变化；迁移只更新本机草稿。
                </span>
              </div>
              <em>
                {evolutionRebaseUnresolvedCount === 0
                  ? "选择已齐全"
                  : `${evolutionRebaseUnresolvedCount} 项待选择`}
              </em>
            </header>

            {evolutionRebaseRows.length === 0 ? (
              <p className="methodology-dialog-note methodology-revision-rebase-empty">
                <strong>正文没有字段冲突</strong>
                ：仅来源版本或证据集合变化，可以直接迁移后继续核对。
              </p>
            ) : (
              <div className="methodology-revision-rebase-fields">
                {evolutionRebaseRows.map((row) => (
                  <section key={row.field} aria-label={`${row.label}差异`}>
                    <header>
                      <strong>{row.label}</strong>
                      <span>
                        {row.choice === null
                          ? "当前版本和草稿都已修改"
                          : row.choice === "draft"
                            ? "将保留草稿"
                            : "将采用当前版本"}
                      </span>
                    </header>
                    <div>
                      <article>
                        <span>开始编辑时</span>
                        <p>{row.baseline || "（空）"}</p>
                      </article>
                      <button
                        type="button"
                        aria-pressed={row.choice === "current"}
                        disabled={evolutionRebaseSaving}
                        onClick={() =>
                          setEvolutionRebaseChoice(row.field, "current")
                        }
                      >
                        <span>当前正式版本</span>
                        <p>{row.current || "（空）"}</p>
                        <small>采用当前</small>
                      </button>
                      <button
                        type="button"
                        aria-pressed={row.choice === "draft"}
                        disabled={evolutionRebaseSaving}
                        onClick={() =>
                          setEvolutionRebaseChoice(row.field, "draft")
                        }
                      >
                        <span>未完成草稿</span>
                        <p>{row.draft || "（空）"}</p>
                        <small>保留草稿</small>
                      </button>
                    </div>
                  </section>
                ))}
              </div>
            )}

            <p className="methodology-dialog-note methodology-revision-rebase-evidence">
              <strong>证据按当前事实重新校验</strong>：保留{" "}
              {evolutionRebase.sourceDecisionIds.length} 条可用选择
              {evolutionRebase.removedEvidenceCount === 0
                ? "，没有失效证据。"
                : `，移除 ${evolutionRebase.removedEvidenceCount} 条失效证据。`}
            </p>

            {evolutionRebaseError === null ? null : (
              <p className="form-error" role="alert">
                迁移失败：{evolutionRebaseError}
              </p>
            )}
          </section>
        </ModalDialog>
      )}

      {selected === null ||
      choosingSources ||
      reviewingRelation !== null ||
      relationQueue !== null ||
      mergeDraft !== null ||
      mergeLifecycleOpen ||
      evolutionRebase !== null ? null : (
        <ModalDialog
          title={
            evolving
              ? "建立原则修订候选"
              : editing
                ? "编辑原则"
                : selected.status === "candidate"
                  ? "审核方法论候选"
                  : "方法论详情"
          }
          description={
            evolving
              ? "使用采用后的新复盘修订边界 · 原原则暂不改变"
              : selectedIsUnverifiedExternal
                ? selected.origin === "manual_entry"
                  ? "人工录入 · 尚未关联复盘证据"
                  : "Markdown 导入 · 尚未关联复盘证据"
                : selected.origin === "principle_merge"
                  ? `人工合并草案 · ${selected.sourcePrincipleIds?.length ?? 0} 条来源原则`
                  : selected.origin === "principle_revision"
                    ? "人工修订草案 · 不调用模型"
                    : `${selected.sourceDecisionIds.length} 条证据 · ${selected.generation.provider}`
          }
          size="wide"
          dismissible={
            !saving &&
            // An edit is let go of only by 取消: a stray Escape or click outside threw it away.
            !editing &&
            !evolutionSaving &&
            !evolutionDraftClosing &&
            !restoringVersion
          }
          onClose={() => {
            if (evolving && evolutionDraft !== null) {
              void preserveEvolutionFormDraft(true);
              return;
            }
            chooseRecord(null);
            setEditing(false);
            clearEvolutionEditor();
            setConfirmingAcceptance(false);
          }}
          footer={
            evolving && evolutionDraft !== null ? (
              <>
                <div className="modal-dialog-footer-start">
                  <button
                    type="button"
                    className="text-button danger-button"
                    disabled={evolutionSaving || evolutionDraftClosing}
                    onClick={() => void discardEvolutionFormDraft()}
                  >
                    丢弃草稿
                  </button>
                  <span
                    className={`methodology-footer-status${evolutionDraftSaveState === "error" ? " error" : ""}`}
                    role="status"
                  >
                    {evolutionDraftRestoredAt === null ? null : "已恢复 · "}
                    {evolutionDraftSaveLabel}
                  </span>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={evolutionSaving || evolutionDraftClosing}
                  onClick={() => void preserveEvolutionFormDraft(false)}
                >
                  {evolutionDraftClosing ? "正在保存…" : "返回详情"}
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    evolutionSaving ||
                    evolutionDraftClosing ||
                    !evolutionDraftValid
                  }
                  onClick={() => void saveEvolution()}
                >
                  {evolutionSaving ? "保存中…" : "保存为修订候选"}
                </button>
              </>
            ) : editing && revision !== null ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    saving ||
                    Object.values(revision).some(
                      (value) => value.trim().length === 0,
                    )
                  }
                  onClick={() => void saveRevision()}
                >
                  {saving ? "保存中…" : "保存修改"}
                </button>
              </>
            ) : confirmingAcceptance ? (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={() => setConfirmingAcceptance(false)}
                >
                  返回检查
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    saving || selected.quality.missingEvidenceCount > 0
                  }
                  onClick={() => void setRecordStatus("accepted", true)}
                >
                  {saving
                    ? "保存中…"
                    : selectedIsUnverifiedExternal
                      ? "确认采纳为假设"
                      : selected.origin === "principle_merge"
                        ? "确认采纳合并候选"
                        : selected.origin === "principle_revision"
                          ? "确认应用修订"
                          : "确认仍然采纳"}
                </button>
              </>
            ) : selected.status === "candidate" ? (
              <>
                {/* Leaving a candidate is kept apart from the actions that keep it (the detail dialog's place, by the design). */}
                <div className="modal-dialog-footer-start">
                  <button
                    type="button"
                    className="text-button danger-button"
                    disabled={saving}
                    onClick={() => void setRecordStatus("dismissed")}
                  >
                    忽略
                  </button>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={saving}
                  onClick={beginEditing}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={saving}
                  onClick={() => {
                    if (selectedHasImportPlaceholders) {
                      beginEditing();
                      return;
                    }
                    if (selectedNeedsAcceptanceConfirmation) {
                      setConfirmingAcceptance(true);
                      return;
                    }
                    void setRecordStatus("accepted");
                  }}
                >
                  {saving
                    ? "保存中…"
                    : selectedHasImportPlaceholders
                      ? "补充边界后采纳"
                      : selected.quality.missingEvidenceCount > 0
                        ? "证据缺失"
                        : selected.origin === "principle_revision"
                          ? "检查后应用修订"
                          : selectedRiskRelations.length > 0
                            ? "检查后采纳"
                            : selectedIsUnverifiedExternal
                              ? "采纳为假设"
                              : "采纳原则"}
                </button>
              </>
            ) : undefined
          }
        >
          <article className="methodology-detail">
            {evolving && evolutionDraft !== null ? (
              <div className="methodology-evolution-editor">
                <header>
                  <div>
                    <span>当前已采纳</span>
                    <strong>{selected.title}</strong>
                    <p>{selected.principle}</p>
                  </div>
                  <aside>
                    <strong>保存后仍是待确认草案</strong>
                    <span>不会直接改写原原则，也不会调用模型。</span>
                  </aside>
                </header>
                <div className="form-fields methodology-evolution-form">
                  <div className="form-field">
                    <label htmlFor="methodology-evolution-title">修订标题</label>
                    <input
                      id="methodology-evolution-title"
                      autoFocus
                      maxLength={120}
                      value={evolutionDraft.title}
                      onChange={(event) =>
                        setEvolutionDraft({
                          ...evolutionDraft,
                          title: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor="methodology-evolution-principle">
                      修订后的原则
                    </label>
                    <textarea
                      id="methodology-evolution-principle"
                      rows={3}
                      maxLength={2_000}
                      value={evolutionDraft.principle}
                      onChange={(event) =>
                        setEvolutionDraft({
                          ...evolutionDraft,
                          principle: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                  <div className="form-fields-row">
                    <div className="form-field">
                      <label htmlFor="methodology-evolution-applies">适用条件</label>
                      <textarea
                        id="methodology-evolution-applies"
                        rows={3}
                        maxLength={2_000}
                        value={evolutionDraft.appliesWhen}
                        onChange={(event) =>
                          setEvolutionDraft({
                            ...evolutionDraft,
                            appliesWhen: event.currentTarget.value,
                          })
                        }
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor="methodology-evolution-caution">注意事项</label>
                      <textarea
                        id="methodology-evolution-caution"
                        rows={3}
                        maxLength={2_000}
                        value={evolutionDraft.caution}
                        onChange={(event) =>
                          setEvolutionDraft({
                            ...evolutionDraft,
                            caution: event.currentTarget.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="form-field">
                    <label htmlFor="methodology-evolution-evidence-summary">
                      证据摘要
                    </label>
                    <textarea
                      id="methodology-evolution-evidence-summary"
                      rows={3}
                      maxLength={3_000}
                      value={evolutionDraft.evidenceSummary}
                      onChange={(event) =>
                        setEvolutionDraft({
                          ...evolutionDraft,
                          evidenceSummary: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                </div>
                <section
                  className="methodology-evolution-evidence"
                  aria-label="修订证据"
                >
                  <header>
                    <div>
                      <h4>修订证据</h4>
                      <span>
                        已选 {evolutionDraft.sourceDecisionIds.length} / 5 条
                      </span>
                    </div>
                    <small>至少保留一条“采用后新复盘”</small>
                  </header>
                  <div>
                    {evolutionEvidenceOptions.map((decision) => (
                      <button
                        key={decision.id}
                        type="button"
                        aria-pressed={evolutionDraft.sourceDecisionIds.includes(
                          decision.id,
                        )}
                        onClick={() => toggleEvolutionEvidence(decision.id)}
                      >
                        <span>
                          {decision.isNew ? "采用后新复盘" : "原有证据"}
                        </span>
                        <strong className="question-clamp">{plainHeadline(decision.question)}</strong>
                        <small>
                          {decision.project} ·{" "}
                          {decision.lesson ?? decision.outcome}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
                <p
                  className={`methodology-dialog-note methodology-evolution-boundary${
                    evolutionDraftRecoveryMessage === null ? "" : " recovered"
                  }`}
                >
                  <span>
                    {evolutionDraftRecoveryMessage ??
                      "应用草案时会先保存当前版本"}
                  </span>
                  <span>原则编号与过往决策关联保持不变</span>
                  <span>引用它的技能与流程会提示来源已更新</span>
                </p>
                {evolutionError === null ? null : (
                  <p className="form-error" role="alert">
                    建立修订失败：{evolutionError}
                  </p>
                )}
              </div>
            ) : editing && revision !== null ? (
              <div className="form-fields methodology-revision-form">
                <div className="form-field">
                  <label htmlFor="methodology-revision-title">标题</label>
                  <input
                    id="methodology-revision-title"
                    autoFocus
                    maxLength={120}
                    value={revision.title}
                    onChange={(event) =>
                      setRevision({
                        ...revision,
                        title: event.currentTarget.value,
                      })
                    }
                  />
                </div>
                {(
                  [
                    ["principle", "原则", 2_000],
                    ["appliesWhen", "适用条件", 2_000],
                    ["caution", "注意事项", 2_000],
                    ["evidenceSummary", "证据摘要", 3_000],
                  ] as const
                ).map(([field, label, maxLength]) => (
                  <div key={field} className="form-field">
                    <label htmlFor={`methodology-revision-${field}`}>{label}</label>
                    <textarea
                      id={`methodology-revision-${field}`}
                      rows={3}
                      maxLength={maxLength}
                      value={revision[field]}
                      onChange={(event) =>
                        setRevision({
                          ...revision,
                          [field]: event.currentTarget.value,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <header className="methodology-detail-header">
                  <div>
                    <span className={`methodology-status ${selected.status}`}>
                      {statusLabels[selected.status]}
                    </span>
                    <span
                      className={`methodology-confidence ${confidenceFor(selected).tone}`}
                    >
                      {confidenceFor(selected).label}
                    </span>
                    <small>
                      {selected.generation.provider} ·{" "}
                      {selected.generation.model}
                    </small>
                  </div>
                  <h3>{selected.title}</h3>
                  <p>{selected.principle}</p>
                </header>
                {selected.origin === "principle_merge" ? (
                  <section className="methodology-merge-provenance">
                    <header>
                      <h4>合并来源</h4>
                      <span>原原则保持独立，不会被这条草案覆盖</span>
                    </header>
                    <ol>
                      {(selected.sourcePrinciples ?? []).map(
                        (source, index) => (
                          <li key={source.id}>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() =>
                                void openRelatedPrinciple(source.id)
                              }
                            >
                              <span>原则 {index === 0 ? "A" : "B"}</span>
                              <strong>{source.title}</strong>
                              <small>
                                {statusLabels[source.status]} · 查看原原则
                              </small>
                            </button>
                          </li>
                        ),
                      )}
                    </ol>
                    {(selected.sourcePrinciples?.length ?? 0) ===
                    (selected.sourcePrincipleIds?.length ?? 0) ? null : (
                      <p className="form-error">
                        部分来源原则已不可用，采纳前需要重新核对。
                      </p>
                    )}
                    {selected.status === "accepted" ? (
                      <footer className="methodology-merge-lifecycle-entry">
                        <span>
                          合并原则已采纳；可逐项迁移引用，再归档两条旧来源。
                        </span>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={saving}
                          onClick={() => void openMergeLifecycle(selected.id)}
                        >
                          整理来源
                        </button>
                      </footer>
                    ) : null}
                  </section>
                ) : null}
                {selected.origin === "principle_revision" ? (
                  <section className="methodology-evolution-provenance">
                    <header>
                      <div>
                        <h4>修订来源</h4>
                        <strong>
                          {selected.sourcePrinciples?.[0]?.title ??
                            "原原则暂不可用"}
                        </strong>
                      </div>
                      <em>原原则仍保持已采纳</em>
                    </header>
                    {selected.sourcePrinciples?.[0] === undefined ? (
                      <p className="form-error">
                        原原则已不存在，不能应用这条修订草案。
                      </p>
                    ) : (
                      <div>
                        <article>
                          <span>当前版本</span>
                          <p>{selected.sourcePrinciples[0].principle}</p>
                        </article>
                        <b aria-hidden="true">→</b>
                        <article>
                          <span>修订草案</span>
                          <p>{selected.principle}</p>
                        </article>
                      </div>
                    )}
                    <footer>
                      应用前不会改变原原则、过往决策或下游的技能与流程；应用时会先建立恢复点。
                    </footer>
                  </section>
                ) : null}
                <div className="methodology-detail-grid">
                  <section>
                    <h4>适用条件</h4>
                    <p>{selected.appliesWhen}</p>
                  </section>
                  <section>
                    <h4>注意事项</h4>
                    <p>{selected.caution}</p>
                  </section>
                </div>
                {selectedIsUnverifiedExternal ? null : (
                  <section>
                    <h4>证据摘要</h4>
                    <p>{selected.evidenceSummary}</p>
                  </section>
                )}
                {selected.status === "accepted" ||
                selected.status === "retired" ? (
                  <section
                    className="methodology-usage-section"
                    aria-label="实际采用情况"
                  >
                    <div className="methodology-usage-heading">
                      <div>
                        <h4>实际采用</h4>
                        <strong>采用后的复盘分布</strong>
                      </div>
                      {/* Unread is not none: 「0 次」 under a failed read said this principle was never used. */}
                      <em>
                        {usageError !== null
                          ? "—"
                          : `${usage?.linkedDecisionCount ?? 0} 次`}
                      </em>
                    </div>
                    {usageLoading ? (
                      <p>正在统计采用记录…</p>
                    ) : usageError !== null ? (
                      <p className="form-error">
                        采用记录暂时无法读取：{usageError}
                      </p>
                    ) : usage === null || usage.linkedDecisionCount === 0 ? (
                      <div className="methodology-usage-empty">
                        <p>还没有过往决策明确记录采用了这条原则。</p>
                        {selected.status === "accepted" ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void api.openSurface("decisions")}
                          >
                            去知识页关联
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <dl className="methodology-usage-metrics">
                          <div>
                            <dt>明确采用</dt>
                            <dd>{usage.linkedDecisionCount}</dd>
                          </div>
                          <div>
                            <dt>已完成复盘</dt>
                            <dd>{usage.reviewedCount}</dd>
                          </div>
                          <div className="favorable">
                            <dt>符合或优于预期</dt>
                            <dd>{usage.favorableCount}</dd>
                          </div>
                          <div className="attention">
                            <dt>部分符合或低于预期</dt>
                            <dd>{usage.mixedCount + usage.attentionCount}</dd>
                          </div>
                        </dl>
                        <p className="methodology-usage-causality">
                          这里只显示人工关联后的结果分布；它能辅助判断适用边界，但不能单独证明结果由这条原则造成。
                        </p>
                        {selected.status === "accepted" &&
                        newEvolutionEvidence.length > 0 ? (
                          <div className="methodology-evolution-ready">
                            <div>
                              <span>原则演进</span>
                              <strong>
                                {newEvolutionEvidence.length}{" "}
                                条采用后新复盘可用于修订
                              </strong>
                              <small>
                                只建立待确认草案；原原则会保持不变，直到你明确应用。
                              </small>
                            </div>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={saving}
                              onClick={beginEvolution}
                            >
                              建立修订候选
                            </button>
                          </div>
                        ) : null}
                        {firstPendingUsageDecision === null ? null : (
                          <div className="methodology-usage-next">
                            <span>
                              <strong>
                                {usage.pendingOutcomeCount +
                                  usage.pendingReviewCount}{" "}
                                条仍待验证
                              </strong>
                              <small>
                                {usage.pendingOutcomeCount} 条待记录结果 ·{" "}
                                {usage.pendingReviewCount} 条待完成复盘
                              </small>
                            </span>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                onOpenDecision(firstPendingUsageDecision.id)
                              }
                            >
                              继续验证
                            </button>
                          </div>
                        )}
                        <details className="disclosure methodology-usage-decisions">
                          <summary>
                            {usage.decisions.length < usage.linkedDecisionCount
                              ? `查看最近 ${usage.decisions.length} / ${usage.linkedDecisionCount} 条采用记录`
                              : `查看 ${usage.decisions.length} 条采用记录`}
                          </summary>
                          <div className="methodology-usage-controls">
                            <div
                              className="methodology-status-filter methodology-usage-filters"
                              role="group"
                              aria-label="采用记录状态"
                            >
                              {methodologyUsageFilterOrder.map((filter) => (
                                <button
                                  key={filter}
                                  type="button"
                                  aria-pressed={usageFilter === filter}
                                  onClick={() => setUsageFilter(filter)}
                                >
                                  {methodologyUsageFilterLabels[filter]}{" "}
                                  <small>{usageFilterCounts[filter]}</small>
                                </button>
                              ))}
                            </div>
                            {usageProjects.length <= 1 ? null : (
                              <select
                                aria-label="按项目筛选采用记录"
                                value={usageProject}
                                onChange={(event) =>
                                  setUsageProject(event.currentTarget.value)
                                }
                              >
                                <option value="__all__">全部项目</option>
                                {usageProjects.map((project) => (
                                  <option key={project} value={project}>
                                    {project}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                          {visibleUsageDecisions.length === 0 ? (
                            <p className="methodology-usage-no-results">
                              当前筛选下没有采用记录。
                            </p>
                          ) : (
                            <ol>
                              {visibleUsageDecisions.map((decision) => (
                                <li key={decision.id}>
                                  <button
                                    type="button"
                                    onClick={() => onOpenDecision(decision.id)}
                                  >
                                    <div>
                                      <strong className="question-clamp">{plainHeadline(decision.question)}</strong>
                                      <small>
                                        {decision.project} ·{" "}
                                        {dateFormatter.format(
                                          new Date(decision.created),
                                        )}
                                      </small>
                                    </div>
                                    <span
                                      className={
                                        decision.outcomeReview?.verdict ??
                                        (decision.outcome === null
                                          ? "pending-outcome"
                                          : "pending-review")
                                      }
                                    >
                                      {methodologyUsageDecisionLabel(decision)}
                                    </span>
                                    <b aria-hidden="true">›</b>
                                  </button>
                                </li>
                              ))}
                            </ol>
                          )}
                        </details>
                      </>
                    )}
                  </section>
                ) : null}
                {selected.status === "accepted" ? (
                  <details className="disclosure practice-version-history methodology-version-history">
                    <summary>
                      <span>原则版本</span>
                      <small>
                        {versionsLoading
                          ? "读取中…"
                          : historyError !== null
                            ? "—"
                            : `${versions.length} 个恢复点`}
                      </small>
                    </summary>
                    <div className="practice-version-history-body">
                      {historyError !== null ? (
                        // Said once, as a failed read: an empty history and 「0 个恢复点」 were drawn under it as well.
                        <div className="load-failure" role="alert">
                          <span>版本历史暂时无法读取：{historyError}</span>
                          <button type="button" className="secondary-button" disabled={versionsLoading} onClick={() => setHistoryReads((value) => value + 1)}>
                            重试
                          </button>
                        </div>
                      ) : !versionsLoading && versions.length === 0 ? (
                        <p className="practice-version-empty">
                          第一次应用修订候选前，会自动保存当前原则作为恢复点。
                        </p>
                      ) : (
                        <div className="practice-version-layout">
                          <div className="practice-version-list">
                            {versions.map((version) => (
                              <button
                                type="button"
                                aria-pressed={activeVersion === version.version}
                                key={version.version}
                                onClick={() => {
                                  setActiveVersion(version.version);
                                  setPendingRestoreVersion(null);
                                }}
                              >
                                <strong>版本 {version.version}</strong>
                                <span>
                                  {
                                    methodologyHistoryReasonLabels[
                                      version.reason
                                    ]
                                  }
                                </span>
                                <time dateTime={version.capturedAt}>
                                  {dateFormatter.format(
                                    new Date(version.capturedAt),
                                  )}
                                </time>
                              </button>
                            ))}
                          </div>
                          {selectedHistoryVersion === null ? (
                            <div className="practice-version-placeholder">
                              选择一个恢复点查看它与当前原则的差异。
                            </div>
                          ) : (
                            <div className="practice-version-comparison">
                              <header>
                                <div>
                                  <strong>
                                    版本 {selectedHistoryVersion.version}{" "}
                                    与当前原则
                                  </strong>
                                  <span>
                                    {selectedHistoryDiffs.length} 个字段有变化
                                  </span>
                                </div>
                                {pendingRestoreVersion ===
                                selectedHistoryVersion.version ? null : (
                                  <button
                                    type="button"
                                    className="text-button"
                                    disabled={restoringVersion}
                                    onClick={() =>
                                      setPendingRestoreVersion(
                                        selectedHistoryVersion.version,
                                      )
                                    }
                                  >
                                    恢复此版本
                                  </button>
                                )}
                              </header>
                              {selectedHistoryDiffs.length === 0 ? (
                                <p>这个恢复点的可见内容与当前原则相同。</p>
                              ) : (
                                <div className="practice-version-diff-list">
                                  {selectedHistoryDiffs.map((field) => (
                                    <div key={field.label}>
                                      <span>{field.label}</span>
                                      <div>
                                        <del>
                                          <small>历史版本</small>
                                          {field.before}
                                        </del>
                                        <ins>
                                          <small>当前版本</small>
                                          {field.after}
                                        </ins>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {pendingRestoreVersion ===
                              selectedHistoryVersion.version ? (
                                <div
                                  className="practice-version-restore-confirm"
                                  role="alert"
                                >
                                  <div>
                                    <strong>
                                      恢复版本 {selectedHistoryVersion.version}
                                      ？
                                    </strong>
                                    <p>
                                      当前原则会先保存为新恢复点；技能与流程只会提示来源更新，不会自动改写或发布。
                                    </p>
                                  </div>
                                  <div>
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      disabled={restoringVersion}
                                      onClick={() =>
                                        setPendingRestoreVersion(null)
                                      }
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-button danger-button"
                                      disabled={restoringVersion}
                                      onClick={() =>
                                        void restoreMethodologyVersion(
                                          selectedHistoryVersion.version,
                                        )
                                      }
                                    >
                                      {restoringVersion ? "正在恢复…" : "恢复"}
                                    </button>
                                  </div>
                                </div>
                              ) : null}
                              {restoreError === null ? null : (
                                <p className="form-error" role="alert">
                                  恢复没有完成：{restoreError}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </details>
                ) : null}
                <section
                  className="methodology-quality-section"
                  aria-label="质量检查"
                >
                  <div className="methodology-quality-heading">
                    <h4>质量检查</h4>
                    <strong
                      className={`methodology-quality-result ${
                        selected.quality.missingEvidenceCount > 0
                          ? "conflict"
                          : selectedIsUnverifiedExternal
                            ? "similar"
                            : selectedRiskRelations.some(
                                  (relation) =>
                                    relation.kind === "potential_conflict",
                                )
                              ? "conflict"
                              : selectedRiskRelations.length > 0
                                ? "similar"
                                : "clear"
                      }`}
                    >
                      {selected.quality.missingEvidenceCount > 0
                        ? "来源证据不完整"
                        : selectedIsUnverifiedExternal
                          ? "尚未关联复盘证据"
                          : selectedRiskRelations.some(
                                (relation) =>
                                  relation.kind === "potential_conflict",
                              )
                            ? "存在潜在冲突"
                            : selectedRiskRelations.length > 0
                              ? "存在相近原则"
                              : selected.quality.relations.length > 0
                                ? "人工核对完成"
                                : "未发现明显重复"}
                    </strong>
                  </div>
                  {selectedIsUnverifiedExternal ? null : (
                    <dl className="methodology-quality-metrics">
                      <div>
                        <dt>有效证据</dt>
                        <dd>{selected.quality.evidenceCount}</dd>
                      </div>
                      <div>
                        <dt>覆盖项目</dt>
                        <dd>{selected.quality.projectCount}</dd>
                      </div>
                      <div>
                        <dt>证据来源</dt>
                        <dd>{selected.quality.sourceCount}</dd>
                      </div>
                      <div>
                        <dt>正向 / 注意 / 不明</dt>
                        <dd>
                          {selected.quality.favorableEvidenceCount} /{" "}
                          {selected.quality.attentionEvidenceCount} /{" "}
                          {selected.quality.unclearEvidenceCount}
                        </dd>
                      </div>
                    </dl>
                  )}
                  <p className="methodology-confidence-reason">
                    {selected.quality.confidenceReason}
                  </p>
                  {selected.quality.relations.length === 0 ? (
                    <p className="methodology-quality-clear-copy">
                      {selectedIsUnverifiedExternal
                        ? "已完成本地结构检查；内容仍需人工核对，并在后续决策中验证。"
                        : "当前规则未发现需要核对的高相似表达或对立行动信号。"}
                    </p>
                  ) : (
                    <ol className="methodology-relation-list">
                      {selected.quality.relations.map((relation) => (
                        <li
                          key={`${relation.kind}:${relation.id}`}
                          className={
                            relation.resolution === null ||
                            relation.resolution === undefined
                              ? "unresolved"
                              : `resolved ${relation.resolution}`
                          }
                        >
                          <button
                            type="button"
                            className="methodology-relation-main"
                            disabled={saving}
                            onClick={() =>
                              void openRelatedPrinciple(relation.id)
                            }
                          >
                            <span>
                              <em
                                className={relation.resolution ?? relation.kind}
                              >
                                {relation.resolution === null ||
                                relation.resolution === undefined
                                  ? relation.kind === "potential_conflict"
                                    ? "待核对冲突"
                                    : "待核对相近"
                                  : relationDispositionLabels[
                                      relation.resolution
                                    ]}
                              </em>
                              <strong>{relation.title}</strong>
                              <small>
                                {relation.score > 0
                                  ? `相似度 ${relation.score}%`
                                  : "人工关系"}
                              </small>
                            </span>
                            <p>{relation.reason}</p>
                          </button>
                          <footer>
                            <span>
                              {relation.resolutionNote ??
                                (relation.resolution === "unrelated"
                                  ? "该关系不再影响质量检查。"
                                  : "尚未记录人工结论。")}
                            </span>
                            <button
                              type="button"
                              className="text-button"
                              disabled={saving}
                              onClick={() => beginRelationReview(relation)}
                            >
                              {relation.resolution === null ||
                              relation.resolution === undefined
                                ? "核对关系"
                                : "修改结论"}
                            </button>
                          </footer>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                {selected.origin === "markdown_import" ? (
                  <section
                    className="methodology-import-provenance"
                    aria-label="Markdown 导入来源"
                  >
                    <div>
                      <h4>导入来源</h4>
                      <strong>
                        {selected.importSource?.fileName ??
                          "旧版导入（未记录文件名）"}
                      </strong>
                    </div>
                    <small>
                      {selected.importSource === undefined
                        ? "这条记录创建于来源追溯功能之前。"
                        : `内容校验 ${selected.importSource.contentSha256.slice(0, 12)} · 仅保存文件名与摘要，不保存原路径`}
                    </small>
                  </section>
                ) : null}
                {selected.sourceDecisionIds.some(id => !selected.sourceDecisions.some(decision => decision.id === id)) ? (
                  <section aria-label="缺失的来源决策">
                    {selected.sourceDecisionIds.filter(id => !selected.sourceDecisions.some(decision => decision.id === id)).map(id => (
                      <p className="missing" key={id}>这条决策已删除或暂不可用 · {id}</p>
                    ))}
                  </section>
                ) : null}
                {selectedIsUnverifiedExternal ? (
                  <section className="methodology-import-evidence-note">
                    <h4>来源与依据</h4>
                    <strong>{selected.evidenceSummary}</strong>
                    <p>
                      {selected.origin === "manual_entry"
                        ? "这条候选由你人工录入，当前还不是经过结果复盘验证的原则。可以先核对表达与边界，或关联真实复盘证据。"
                        : "这条候选来自本地 Markdown，不等同于经过 Paraself 复盘验证的原则。可以先编辑适用条件与边界，再明确采纳为待验证假设。"}
                    </p>
                    {selectedTakesEvidence ? (
                      <div className="methodology-evidence-link-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={saving}
                          onClick={() =>
                            openSourceChooser(selected.sourceDecisionIds, "link")
                          }
                        >
                          关联复盘证据
                        </button>
                      </div>
                    ) : null}
                  </section>
                ) : (
                  <>
                    <details className="disclosure methodology-evidence-section">
                      <summary>
                        <span>来源决策</span>
                        <small>
                          {selected.sourceDecisions.length} 条 ·
                          展开核对原始结果
                        </small>
                      </summary>
                      <ol>
                        {selected.sourceDecisions.map((decision, index) => (
                          <li key={decision.id}>
                            <strong>
                              证据 {index + 1} · {plainHeadline(decision.question)}
                            </strong>
                            <p>选择：{decision.selectedAnswer}</p>
                            <p>实际：{decision.outcome}</p>
                            {decision.outcomeReview === null ? null : (
                              <small>
                                {verdictLabels[decision.outcomeReview.verdict]}
                                {decision.outcomeReview.lesson === null
                                  ? ""
                                  : ` · ${decision.outcomeReview.lesson}`}
                              </small>
                            )}
                          </li>
                        ))}
                      </ol>
                    </details>
                    {selected.origin === "markdown_import" ||
                    selected.origin === "manual_entry" ? (
                      <div className="methodology-evidence-link-actions detached">
                        <span>
                          这些证据由你手动关联，原则内容不会被自动改写。
                        </span>
                        {selectedTakesEvidence ? (
                          <button
                            type="button"
                            className="text-button"
                            disabled={saving}
                            onClick={() =>
                              openSourceChooser(
                                selected.sourceDecisionIds,
                                "link",
                              )
                            }
                          >
                            调整证据关联
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
                {confirmingAcceptance ? (
                  <section
                    ref={acceptanceConfirmationRef}
                    className="methodology-acceptance-confirmation"
                    aria-label="采纳确认"
                  >
                    <h4>采纳确认</h4>
                    <p>
                      {selectedIsUnverifiedExternal
                        ? selected.origin === "manual_entry"
                          ? "这条候选由你人工录入，当前没有经过复盘的决策证据。采纳后仍保持低可信；请确认它只是待验证假设，且适用条件与注意事项边界清楚。"
                          : "这条候选来自 Markdown，当前没有经过复盘的决策证据。采纳后仍保持低可信；请确认已经核对原则、适用条件与注意事项。"
                        : selected.origin === "principle_merge"
                          ? "这条候选由两条已确认重复的原则人工整理而成。采纳只会新增这条原则，两个来源及其已有技能与流程仍保持原状；请确认统一后的表达与边界准确。"
                          : selected.origin === "principle_revision"
                            ? "这条草案会应用到原原则并保留原编号。当前版本会先保存为恢复点；过往决策关联保持不变，引用该原则的技能与流程会提示来源已更新，但不会自动改写或发布。"
                            : `质量检查发现 ${selectedRiskRelations.length} 条仍需关注的关联。采纳不会自动合并或覆盖其它原则，请确认已经检查适用条件和差异。`}
                    </p>
                  </section>
                ) : null}
              </>
            )}
            {detailError === null ? null : (
              <p className="form-error" role="alert">
                操作失败：{detailError}
              </p>
            )}
          </article>
        </ModalDialog>
      )}
    </section>
  );
};
