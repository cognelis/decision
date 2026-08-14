import type {
  KnowledgeGraphSnapshot,
  MethodologyEvidenceMatch,
  MethodologyQualityRelation,
  MethodologyRelationDisposition,
  MethodologyStatus,
  MethodologySuggestion,
} from "@cognelis/decision-core";
import { useEffect, useMemo, useRef, useState } from "react";

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
import { ModalDialog } from "../../ModalDialog.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
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
  pendingRelationCount,
  qualityBadgeFor,
  type MethodologyMergeCandidateAssessment,
  type MethodologyRelationReviewItem,
} from "./methodology-relation-model.js";

interface MethodologyPanelProps {
  api: MethodologyWorkspaceApi;
  onOpenDecision(id: string): void;
}

type StatusFilter = MethodologyStatus | "all";
type MethodologyView = "records" | "analysis" | "graph" | "assets";
type MethodologyCreationMode = "chooser" | "manual" | null;

interface MethodologyNotice {
  tone: "success" | "warning" | "error";
  text: string;
  action?: "discard_merge_draft" | "discard_revision_draft";
}

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

type MethodologyMergeFormDraft = Extract<
  ManualFormDraft,
  { key: "methodology_merge" }
>;

type MethodologyRevisionFormDraft = Extract<
  ManualFormDraft,
  { key: "methodology_revision" }
>;

type MethodologyRevisionField = keyof MethodologyRevisionInput;
type MethodologyRevisionRebaseChoice = "current" | "draft" | null;

interface MethodologyRevisionRebaseState {
  saved: MethodologyRevisionFormDraft;
  baseline: MethodologyEvolutionInput;
  source: MethodologyItem;
  usage: MethodologyUsageSnapshot;
  sourceDecisionIds: string[];
  removedEvidenceCount: number;
  choices: Record<
    MethodologyRevisionField,
    MethodologyRevisionRebaseChoice
  >;
}

const methodologyRevisionFields: Array<{
  field: MethodologyRevisionField;
  label: string;
}> = [
  { field: "title", label: "标题" },
  { field: "principle", label: "原则" },
  { field: "appliesWhen", label: "适用条件" },
  { field: "caution", label: "注意事项" },
  { field: "evidenceSummary", label: "证据摘要" },
];

interface MethodologyMergeRelationReviewState {
  candidateId: string;
  pendingSourceIds: string[];
  totalPairCount: number;
  note: string;
}

const methodologyViews: Array<{
  value: MethodologyView;
  label: string;
}> = [
  { value: "records", label: "原则" },
  { value: "analysis", label: "分析" },
  { value: "graph", label: "图谱" },
  { value: "assets", label: "技能与流程" },
];

const statusLabels: Record<MethodologyStatus, string> = {
  candidate: "待确认",
  accepted: "已采纳",
  retired: "已归档",
  dismissed: "已忽略",
};

const confidenceLabels: Record<MethodologyItem["confidence"], string> = {
  low: "单点证据",
  medium: "多条印证",
  high: "稳定模式",
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
};

const normalizedSearch = (value: string): string =>
  value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");

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

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const revisionFrom = (item: MethodologyItem): MethodologyRevisionInput => ({
  title: item.title,
  principle: item.principle,
  appliesWhen: item.appliesWhen,
  caution: item.caution,
  evidenceSummary: item.evidenceSummary,
});

const evolutionSourceSnapshot = (
  item: MethodologyItem,
): MethodologyEvolutionInput => ({
  ...revisionFrom(item),
  sourceDecisionIds: [...item.sourceDecisionIds],
});

const initialRevisionRebaseChoice = (
  baseline: string,
  current: string,
  draft: string,
): MethodologyRevisionRebaseChoice => {
  if (current === draft) return "current";
  if (current === baseline) return "draft";
  if (draft === baseline) return "current";
  return null;
};

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

const confidenceLabelFor = (item: MethodologyItem): string =>
  item.quality.evidenceCount === 0
    ? "待验证"
    : confidenceLabels[item.quality.recommendedConfidence];

export const MethodologyPanel = ({
  api,
  onOpenDecision,
}: MethodologyPanelProps) => {
  const [status, setStatus] = useState<StatusFilter>("candidate");
  const [items, setItems] = useState<MethodologyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MethodologyItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState<MethodologyRevisionInput | null>(
    null,
  );
  const [evolving, setEvolving] = useState(false);
  const [evolutionDraft, setEvolutionDraft] =
    useState<MethodologyEvolutionInput | null>(null);
  const [evolutionSaving, setEvolutionSaving] = useState(false);
  const [evolutionError, setEvolutionError] = useState<string | null>(null);
  const [evolutionDraftSaveState, setEvolutionDraftSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [evolutionDraftClosing, setEvolutionDraftClosing] = useState(false);
  const [evolutionDraftRestoredAt, setEvolutionDraftRestoredAt] = useState<
    string | null
  >(null);
  const [evolutionDraftRecoveryMessage, setEvolutionDraftRecoveryMessage] =
    useState<string | null>(null);
  const [evolutionRebase, setEvolutionRebase] =
    useState<MethodologyRevisionRebaseState | null>(null);
  const [evolutionRebaseSaving, setEvolutionRebaseSaving] = useState(false);
  const [evolutionRebaseError, setEvolutionRebaseError] = useState<
    string | null
  >(null);
  const evolutionDraftSaveEpoch = useRef(0);
  const hydratedUsageForPrinciple = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmingAcceptance, setConfirmingAcceptance] = useState(false);
  const [choosingSources, setChoosingSources] = useState(false);
  const [linkingEvidence, setLinkingEvidence] = useState(false);
  const [reviewedDecisions, setReviewedDecisions] = useState<
    DecisionLibraryItem[]
  >([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [sourceQuery, setSourceQuery] = useState("");
  const [evidenceMatches, setEvidenceMatches] = useState<
    MethodologyEvidenceMatch[]
  >([]);
  const [evidenceMatchLoading, setEvidenceMatchLoading] = useState(false);
  const [evidenceMatchError, setEvidenceMatchError] = useState<string | null>(
    null,
  );
  const [sourceLoading, setSourceLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [revisionKey, setRevisionKey] = useState(0);
  const [view, setView] = useState<MethodologyView>("records");
  const [practiceToolbarHost, setPracticeToolbarHost] =
    useState<HTMLElement | null>(null);
  const [graph, setGraph] = useState<KnowledgeGraphSnapshot | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [buildProgress, setBuildProgress] =
    useState<MethodologyBuildProgress | null>(null);
  const [buildProgressUnavailable, setBuildProgressUnavailable] =
    useState(false);
  const [suggestions, setSuggestions] = useState<MethodologySuggestion[]>([]);
  const [deferredSuggestions, setDeferredSuggestions] = useState<
    MethodologySuggestion[]
  >([]);
  const [suggestionLoading, setSuggestionLoading] = useState(true);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [suggestionActionError, setSuggestionActionError] = useState<
    string | null
  >(null);
  const [suggestionRevision, setSuggestionRevision] = useState(0);
  const [suggestionInboxOpen, setSuggestionInboxOpen] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [suggestionInboxMode, setSuggestionInboxMode] = useState<
    "active" | "deferred"
  >("active");
  const [suggestionActionId, setSuggestionActionId] = useState<string | null>(
    null,
  );
  const [validationItems, setValidationItems] = useState<
    MethodologyValidationItem[]
  >([]);
  const [validationLoading, setValidationLoading] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [validationInboxOpen, setValidationInboxOpen] = useState(false);
  const [validationActionId, setValidationActionId] = useState<string | null>(
    null,
  );
  const [validationActionError, setValidationActionError] = useState<
    string | null
  >(null);
  const [importing, setImporting] = useState(false);
  const [importPreview, setImportPreview] =
    useState<MethodologyImportPreview | null>(null);
  const [selectedImportCandidates, setSelectedImportCandidates] = useState<
    string[]
  >([]);
  const [importSaving, setImportSaving] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [creationMode, setCreationMode] =
    useState<MethodologyCreationMode>(null);
  const [manualDraft, setManualDraft] = useState<MethodologyManualInput>({
    title: "",
    principle: "",
    appliesWhen: "",
    caution: "",
  });
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualEvidenceDraft, setManualEvidenceDraft] =
    useState<MethodologyEvidenceManualInput | null>(null);
  const [manualEvidenceSaving, setManualEvidenceSaving] = useState(false);
  const [manualEvidenceError, setManualEvidenceError] = useState<string | null>(
    null,
  );
  const [manualFormDrafts, setManualFormDrafts] = useState<ManualFormDraft[]>(
    [],
  );
  const [manualDraftRestoredAt, setManualDraftRestoredAt] = useState<
    string | null
  >(null);
  const [manualEvidenceRestoredAt, setManualEvidenceRestoredAt] = useState<
    string | null
  >(null);
  const [manualEvidencePendingSources, setManualEvidencePendingSources] =
    useState<string[] | null>(null);
  const [manualDraftSaveState, setManualDraftSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [manualEvidenceDraftSaveState, setManualEvidenceDraftSaveState] =
    useState<"idle" | "saving" | "saved" | "error">("idle");
  const [manualDraftStorageError, setManualDraftStorageError] = useState<
    string | null
  >(null);
  const manualDraftSaveEpoch = useRef(0);
  const manualEvidenceDraftSaveEpoch = useRef(0);
  const [notice, setNotice] = useState<MethodologyNotice | null>(null);
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [batchGenerating, setBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [reviewingRelation, setReviewingRelation] =
    useState<MethodologyQualityRelation | null>(null);
  const [relationDisposition, setRelationDisposition] =
    useState<MethodologyRelationDisposition | null>(null);
  const [relationNote, setRelationNote] = useState("");
  const [relationSaving, setRelationSaving] = useState(false);
  const [relationError, setRelationError] = useState<string | null>(null);
  const [relationQueue, setRelationQueue] = useState<
    MethodologyRelationReviewItem[] | null
  >(null);
  const [relationQueueTotal, setRelationQueueTotal] = useState(0);
  const [relationQueueLoading, setRelationQueueLoading] = useState(false);
  const [relationQueueSaving, setRelationQueueSaving] = useState(false);
  const [relationQueueDisposition, setRelationQueueDisposition] =
    useState<MethodologyRelationDisposition | null>(null);
  const [relationQueueNote, setRelationQueueNote] = useState("");
  const [relationQueueError, setRelationQueueError] = useState<string | null>(
    null,
  );
  const [mergeDraft, setMergeDraft] =
    useState<MethodologyMergeDraftState | null>(null);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeSaving, setMergeSaving] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeDraftSaveState, setMergeDraftSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [mergeDraftClosing, setMergeDraftClosing] = useState(false);
  const [mergeDraftRestoredAt, setMergeDraftRestoredAt] = useState<
    string | null
  >(null);
  const [mergeDraftRecoveryMessage, setMergeDraftRecoveryMessage] = useState<
    string | null
  >(null);
  const mergeDraftSaveEpoch = useRef(0);
  const [mergeRelationReview, setMergeRelationReview] =
    useState<MethodologyMergeRelationReviewState | null>(null);
  const [mergeRelationSaving, setMergeRelationSaving] = useState(false);
  const [mergeRelationError, setMergeRelationError] = useState<string | null>(
    null,
  );
  const [mergeRelationOutcome, setMergeRelationOutcome] = useState<
    string | null
  >(null);
  const [mergeLifecycleOpen, setMergeLifecycleOpen] = useState(false);
  const [mergeLifecyclePlan, setMergeLifecyclePlan] =
    useState<MethodologyMergeLifecyclePlan | null>(null);
  const [mergeLifecycleLoading, setMergeLifecycleLoading] = useState(false);
  const [mergeLifecycleError, setMergeLifecycleError] = useState<string | null>(
    null,
  );
  const [mergeLifecycleBusyAssetId, setMergeLifecycleBusyAssetId] = useState<
    string | null
  >(null);
  const [mergeLifecycleSaving, setMergeLifecycleSaving] = useState(false);
  const [usage, setUsage] = useState<MethodologyUsageSnapshot | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageFilter, setUsageFilter] = useState<MethodologyUsageFilter>("all");
  const [usageProject, setUsageProject] = useState("__all__");
  const [versions, setVersions] = useState<MethodologyVersionItem[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [pendingRestoreVersion, setPendingRestoreVersion] = useState<
    number | null
  >(null);
  const [restoringVersion, setRestoringVersion] = useState(false);
  const sourceRequestSequence = useRef(0);
  const acceptanceConfirmationRef = useRef<HTMLElement>(null);
  const storedMergeDraft = manualFormDrafts.find(
    (draft): draft is MethodologyMergeFormDraft =>
      draft.key === "methodology_merge",
  );
  const storedRevisionDraft = manualFormDrafts.find(
    (draft): draft is MethodologyRevisionFormDraft =>
      draft.key === "methodology_revision",
  );

  useEffect(() => {
    if (!confirmingAcceptance) return;
    acceptanceConfirmationRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [confirmingAcceptance]);

  useEffect(() => {
    let active = true;
    void api
      .listManualFormDrafts()
      .then((drafts) => {
        if (active) setManualFormDrafts(drafts);
      })
      .catch((caught: unknown) => {
        if (active) {
          setManualDraftStorageError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      });
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (
      creationMode !== "manual" ||
      !Object.values(manualDraft).some((value) => value.trim().length > 0)
    ) {
      return;
    }
    const epoch = manualDraftSaveEpoch.current + 1;
    manualDraftSaveEpoch.current = epoch;
    setManualDraftSaveState("idle");
    const timeout = window.setTimeout(() => {
      if (manualDraftSaveEpoch.current !== epoch) return;
      setManualDraftSaveState("saving");
      void api
        .saveManualFormDraft({ key: "methodology_manual", input: manualDraft })
        .then((saved) => {
          if (manualDraftSaveEpoch.current !== epoch) return;
          setManualFormDrafts((current) => [
            ...current.filter((draft) => draft.key !== saved.key),
            saved,
          ]);
          setManualDraftSaveState("saved");
          setManualDraftStorageError(null);
        })
        .catch((caught: unknown) => {
          if (manualDraftSaveEpoch.current !== epoch) return;
          setManualDraftSaveState("error");
          setManualDraftStorageError(
            caught instanceof Error ? caught.message : String(caught),
          );
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [api, creationMode, manualDraft]);

  useEffect(() => {
    if (manualEvidenceDraft === null) return;
    const epoch = manualEvidenceDraftSaveEpoch.current + 1;
    manualEvidenceDraftSaveEpoch.current = epoch;
    setManualEvidenceDraftSaveState("idle");
    const timeout = window.setTimeout(() => {
      if (manualEvidenceDraftSaveEpoch.current !== epoch) return;
      setManualEvidenceDraftSaveState("saving");
      void api
        .saveManualFormDraft({
          key: "methodology_evidence_manual",
          input: manualEvidenceDraft,
        })
        .then((saved) => {
          if (manualEvidenceDraftSaveEpoch.current !== epoch) return;
          setManualFormDrafts((current) => [
            ...current.filter((draft) => draft.key !== saved.key),
            saved,
          ]);
          setManualEvidenceDraftSaveState("saved");
          setManualDraftStorageError(null);
        })
        .catch((caught: unknown) => {
          if (manualEvidenceDraftSaveEpoch.current !== epoch) return;
          setManualEvidenceDraftSaveState("error");
          setManualDraftStorageError(
            caught instanceof Error ? caught.message : String(caught),
          );
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [api, manualEvidenceDraft]);

  useEffect(() => {
    if (mergeDraft === null) return;
    const epoch = mergeDraftSaveEpoch.current + 1;
    mergeDraftSaveEpoch.current = epoch;
    setMergeDraftSaveState("idle");
    const timeout = window.setTimeout(() => {
      if (mergeDraftSaveEpoch.current !== epoch) return;
      setMergeDraftSaveState("saving");
      void api
        .saveManualFormDraft({
          key: "methodology_merge",
          sourcePrincipleIds: mergeDraft.sources.map((source) => source.id),
          input: mergeDraft.input,
        })
        .then((saved) => {
          if (
            mergeDraftSaveEpoch.current !== epoch ||
            saved.key !== "methodology_merge"
          ) {
            return;
          }
          setManualFormDrafts((current) => [
            ...current.filter((draft) => draft.key !== saved.key),
            saved,
          ]);
          setMergeDraftRestoredAt(saved.updatedAt);
          setMergeDraftSaveState("saved");
          setManualDraftStorageError(null);
        })
        .catch((caught: unknown) => {
          if (mergeDraftSaveEpoch.current !== epoch) return;
          setMergeDraftSaveState("error");
          setManualDraftStorageError(
            caught instanceof Error ? caught.message : String(caught),
          );
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [api, mergeDraft]);

  useEffect(() => {
    if (!evolving || evolutionDraft === null || selected === null) return;
    const epoch = evolutionDraftSaveEpoch.current + 1;
    evolutionDraftSaveEpoch.current = epoch;
    setEvolutionDraftSaveState("idle");
    const timeout = window.setTimeout(() => {
      if (evolutionDraftSaveEpoch.current !== epoch) return;
      setEvolutionDraftSaveState("saving");
      void api
        .saveManualFormDraft({
          key: "methodology_revision",
          sourcePrincipleId: selected.id,
          sourceUpdatedAt: selected.updatedAt,
          sourceSnapshot: evolutionSourceSnapshot(selected),
          input: evolutionDraft,
        })
        .then((saved) => {
          if (
            evolutionDraftSaveEpoch.current !== epoch ||
            saved.key !== "methodology_revision"
          ) {
            return;
          }
          setManualFormDrafts((current) => [
            ...current.filter((draft) => draft.key !== saved.key),
            saved,
          ]);
          setEvolutionDraftRestoredAt(saved.updatedAt);
          setEvolutionDraftSaveState("saved");
          setManualDraftStorageError(null);
        })
        .catch((caught: unknown) => {
          if (evolutionDraftSaveEpoch.current !== epoch) return;
          setEvolutionDraftSaveState("error");
          setManualDraftStorageError(
            caught instanceof Error ? caught.message : String(caught),
          );
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [api, evolutionDraft, evolving, selected]);

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
    setUsageFilter("all");
    setUsageProject("__all__");
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
    setActiveVersion(null);
    setPendingRestoreVersion(null);
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
  }, [api, revisionKey, selected?.id, selected?.status]);

  const evidenceMatchById = useMemo(
    () =>
      new Map(
        evidenceMatches.map((match, index) => [
          match.sourceDecisionId,
          { match, index },
        ]),
      ),
    [evidenceMatches],
  );

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
  const visibleSuggestionInboxItems =
    suggestionInboxMode === "active" ? suggestions : deferredSuggestions;

  const visibleReviewedDecisions = useMemo(() => {
    const query = normalizedSearch(sourceQuery);
    return reviewedDecisions
      .filter((decision) => {
        if (query.length === 0) return true;
        return normalizedSearch(
          [
            decision.question,
            decision.selectedAnswer,
            decision.project,
            decision.rationale ?? "",
            decision.context ?? "",
            decision.outcome ?? "",
            decision.outcomeReview?.lesson ?? "",
          ].join("\n"),
        ).includes(query);
      })
      .sort((left, right) => {
        const leftRank = evidenceMatchById.get(left.id)?.index;
        const rightRank = evidenceMatchById.get(right.id)?.index;
        return (
          (leftRank ?? Number.MAX_SAFE_INTEGER) -
            (rightRank ?? Number.MAX_SAFE_INTEGER) ||
          (right.outcomeReview?.reviewedAt ?? "").localeCompare(
            left.outcomeReview?.reviewedAt ?? "",
          ) ||
          left.id.localeCompare(right.id)
        );
      });
  }, [evidenceMatchById, reviewedDecisions, sourceQuery]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .listMethodologies(status === "all" ? undefined : status)
      .then((records) => {
        if (active) setItems(records);
      })
      .catch((caught: unknown) => {
        if (active) {
          setItems([]);
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
    let active = true;
    setSuggestionLoading(true);
    setSuggestionError(null);
    void Promise.all([
      api.getMethodologySuggestions(),
      api.getDeferredMethodologySuggestions(),
    ])
      .then(([records, deferred]) => {
        if (active) {
          setSuggestions(records);
          setDeferredSuggestions(deferred);
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setSuggestions([]);
          setDeferredSuggestions([]);
          setSuggestionError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (active) setSuggestionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey, suggestionRevision]);

  useEffect(() => {
    if (
      suggestionInboxOpen &&
      suggestionInboxMode === "active" &&
      suggestions.length === 0 &&
      deferredSuggestions.length > 0
    ) {
      setSuggestionInboxMode("deferred");
    } else if (
      suggestionInboxOpen &&
      suggestionInboxMode === "deferred" &&
      deferredSuggestions.length === 0 &&
      suggestions.length > 0
    ) {
      setSuggestionInboxMode("active");
    }
  }, [
    deferredSuggestions.length,
    suggestionInboxMode,
    suggestionInboxOpen,
    suggestions.length,
  ]);

  useEffect(() => {
    let active = true;
    setValidationLoading(true);
    setValidationError(null);
    void api
      .getMethodologyValidationInbox()
      .then((items) => {
        if (active) setValidationItems(items);
      })
      .catch((caught: unknown) => {
        if (active) {
          setValidationItems([]);
          setValidationError(
            caught instanceof Error ? caught.message : String(caught),
          );
        }
      })
      .finally(() => {
        if (active) setValidationLoading(false);
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
  }, [api, revisionKey, view]);

  const openSourceChooser = (
    preselected: string[] = [],
    mode: "generate" | "link" = "generate",
  ): void => {
    const requestSequence = sourceRequestSequence.current + 1;
    sourceRequestSequence.current = requestSequence;
    setChoosingSources(true);
    setLinkingEvidence(mode === "link");
    setSelectedSources([...new Set(preselected)].slice(0, 5));
    setSourceQuery("");
    setEvidenceMatches([]);
    setEvidenceMatchError(null);
    setEvidenceMatchLoading(mode === "link");
    setGenerationError(null);
    setSourceLoading(true);
    void api
      .listDecisions({ query: "", reviewState: "reviewed", limit: 200 })
      .then((records) => {
        if (sourceRequestSequence.current !== requestSequence) return;
        setReviewedDecisions(records);
        if (mode === "link") {
          const available = new Set(records.map((record) => record.id));
          setSelectedSources((current) =>
            current.filter((id) => available.has(id)),
          );
        }
      })
      .catch((caught: unknown) => {
        if (sourceRequestSequence.current !== requestSequence) return;
        setReviewedDecisions([]);
        setGenerationError(
          caught instanceof Error ? caught.message : String(caught),
        );
      })
      .finally(() => {
        if (sourceRequestSequence.current === requestSequence) {
          setSourceLoading(false);
        }
      });
    if (mode === "link" && selected !== null) {
      void api
        .getMethodologyEvidenceMatches(selected.id)
        .then((matches) => {
          if (sourceRequestSequence.current === requestSequence) {
            setEvidenceMatches(matches);
          }
        })
        .catch((caught: unknown) => {
          if (sourceRequestSequence.current !== requestSequence) return;
          setEvidenceMatches([]);
          setEvidenceMatchError(
            caught instanceof Error ? caught.message : String(caught),
          );
        })
        .finally(() => {
          if (sourceRequestSequence.current === requestSequence) {
            setEvidenceMatchLoading(false);
          }
        });
    } else {
      setEvidenceMatchLoading(false);
    }
  };

  const toggleSource = (id: string): void => {
    setSelectedSources((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= 5
          ? current
          : [...current, id],
    );
  };

  const generate = async (): Promise<void> => {
    if (selectedSources.length === 0) return;
    setGenerating(true);
    setGenerationError(null);
    try {
      const item = await api.generateMethodology(selectedSources);
      sourceRequestSequence.current += 1;
      setChoosingSources(false);
      setLinkingEvidence(false);
      setSelectedSources([]);
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
      sourceRequestSequence.current += 1;
      setSelected(updated);
      setChoosingSources(false);
      setLinkingEvidence(false);
      setSelectedSources([]);
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

  const importMarkdown = async (): Promise<void> => {
    setImporting(true);
    setNotice(null);
    try {
      const preview = await api.importMethodologyMarkdown();
      if (preview.cancelled) return;
      if (preview.batchId === null || preview.candidates.length === 0) {
        const firstFailure = preview.failures[0];
        setNotice({
          tone: "warning",
          text:
            preview.duplicates.length > 0
              ? `没有新增候选；已识别并跳过 ${preview.duplicates.length} 条重复内容。`
              : firstFailure === undefined
                ? "没有发现可导入的内容。"
                : `没有可导入内容（${firstFailure.fileName}：${firstFailure.message}）。`,
        });
        return;
      }
      setImportPreview(preview);
      setSelectedImportCandidates(
        preview.candidates
          .filter((candidate) => candidate.similarTo === null)
          .map((candidate) => candidate.id),
      );
      setImportError(null);
    } catch (caught) {
      setNotice({
        tone: "error",
        text: `导入失败：${caught instanceof Error ? caught.message : String(caught)}`,
      });
    } finally {
      setImporting(false);
    }
  };

  const openCreation = (): void => {
    setCreationMode("chooser");
    setManualError(null);
  };

  const openManualCreation = (): void => {
    const saved = manualFormDrafts.find(
      (draft) => draft.key === "methodology_manual",
    );
    if (saved?.key === "methodology_manual") {
      setManualDraft({ ...saved.input });
      setManualDraftRestoredAt(saved.updatedAt);
      setManualDraftSaveState("saved");
    } else if (
      !Object.values(manualDraft).some((value) => value.trim().length > 0)
    ) {
      setManualDraft({
        title: "",
        principle: "",
        appliesWhen: "",
        caution: "",
      });
      setManualDraftRestoredAt(null);
      setManualDraftSaveState("idle");
    } else {
      setManualDraftRestoredAt(null);
    }
    setManualError(null);
    setCreationMode("manual");
  };

  const openEvidenceCreation = (): void => {
    const saved = manualFormDrafts.find(
      (draft) => draft.key === "methodology_evidence_manual",
    );
    if (saved?.key !== "methodology_evidence_manual") {
      setCreationMode(null);
      openSourceChooser();
      return;
    }
    sourceRequestSequence.current += 1;
    setCreationMode(null);
    setManualEvidenceDraft({
      ...saved.input,
      sourceDecisionIds: [...saved.input.sourceDecisionIds],
    });
    setSelectedSources([...saved.input.sourceDecisionIds]);
    setManualEvidenceRestoredAt(saved.updatedAt);
    setManualEvidencePendingSources(null);
    setManualEvidenceDraftSaveState("saved");
    setManualEvidenceError(null);
    setSourceLoading(true);
    void Promise.all([
      api.listDecisions({ query: "", reviewState: "reviewed", limit: 200 }),
      ...saved.input.sourceDecisionIds.map((decisionId) =>
        api.listDecisions({ query: "", decisionId, limit: 1 }),
      ),
    ])
      .then((groups) => {
        setReviewedDecisions([
          ...new Map(
            groups.flat().map((decision) => [decision.id, decision]),
          ).values(),
        ]);
      })
      .catch((caught: unknown) => {
        setReviewedDecisions([]);
        setManualEvidenceError(
          caught instanceof Error ? caught.message : String(caught),
        );
      })
      .finally(() => setSourceLoading(false));
  };

  const closeCreation = (): void => {
    if (manualSaving) return;
    if (
      creationMode === "manual" &&
      Object.values(manualDraft).some((value) => value.trim().length > 0)
    ) {
      void api
        .saveManualFormDraft({
          key: "methodology_manual",
          input: manualDraft,
        })
        .then((saved) => {
          setManualFormDrafts((current) => [
            ...current.filter((draft) => draft.key !== saved.key),
            saved,
          ]);
        })
        .catch(() => undefined);
    }
    setCreationMode(null);
    setManualError(null);
  };

  const discardManualMethodologyDraft = async (): Promise<void> => {
    manualDraftSaveEpoch.current += 1;
    setManualDraftSaveState("idle");
    setManualDraftStorageError(null);
    try {
      await api.deleteManualFormDraft("methodology_manual");
      setManualFormDrafts((current) =>
        current.filter((draft) => draft.key !== "methodology_manual"),
      );
      setManualDraft({
        title: "",
        principle: "",
        appliesWhen: "",
        caution: "",
      });
      setManualDraftRestoredAt(null);
    } catch (caught) {
      setManualDraftSaveState("error");
      setManualDraftStorageError(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  };

  const saveManualMethodology = async (): Promise<void> => {
    setManualSaving(true);
    setManualError(null);
    try {
      const item = await api.createManualMethodology(manualDraft);
      manualDraftSaveEpoch.current += 1;
      try {
        await api.deleteManualFormDraft("methodology_manual");
        setManualFormDrafts((current) =>
          current.filter((draft) => draft.key !== "methodology_manual"),
        );
      } catch (caught) {
        setNotice({
          tone: "warning",
          text: `候选已保存，但未完成草稿未能清除：${caught instanceof Error ? caught.message : String(caught)}`,
        });
      }
      setCreationMode(null);
      setManualDraft({
        title: "",
        principle: "",
        appliesWhen: "",
        caution: "",
      });
      setManualDraftRestoredAt(null);
      setSelected(item);
      setEditing(false);
      setConfirmingAcceptance(false);
      setStatus("candidate");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setManualError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setManualSaving(false);
    }
  };

  const beginManualEvidenceMethodology = (): void => {
    if (selectedSources.length === 0 || sourceLoading) return;
    const requestedSources = [...selectedSources];
    const saved = manualFormDrafts.find(
      (draft) => draft.key === "methodology_evidence_manual",
    );
    sourceRequestSequence.current += 1;
    if (saved?.key === "methodology_evidence_manual") {
      setManualEvidenceDraft({
        ...saved.input,
        sourceDecisionIds: [...saved.input.sourceDecisionIds],
      });
      setSelectedSources([...saved.input.sourceDecisionIds]);
      setManualEvidenceRestoredAt(saved.updatedAt);
      setManualEvidencePendingSources(
        requestedSources.join("\u0000") ===
          saved.input.sourceDecisionIds.join("\u0000")
          ? null
          : requestedSources,
      );
      setManualEvidenceDraftSaveState("saved");
    } else {
      setManualEvidenceDraft({
        title: "",
        principle: "",
        appliesWhen: "",
        caution: "",
        evidenceSummary: "",
        sourceDecisionIds: requestedSources,
      });
      setManualEvidenceRestoredAt(null);
      setManualEvidencePendingSources(null);
      setManualEvidenceDraftSaveState("idle");
    }
    setManualEvidenceError(null);
    setChoosingSources(false);
    setLinkingEvidence(false);
  };

  const updateManualEvidenceDraft = (
    patch: Partial<MethodologyEvidenceManualInput>,
  ): void => {
    setManualEvidenceDraft((current) =>
      current === null ? null : { ...current, ...patch },
    );
  };

  const closeManualEvidenceMethodology = (): void => {
    if (manualEvidenceSaving) return;
    if (manualEvidenceDraft !== null) {
      void api
        .saveManualFormDraft({
          key: "methodology_evidence_manual",
          input: manualEvidenceDraft,
        })
        .then((saved) => {
          setManualFormDrafts((current) => [
            ...current.filter((draft) => draft.key !== saved.key),
            saved,
          ]);
        })
        .catch(() => undefined);
    }
    setManualEvidenceDraft(null);
    setManualEvidenceError(null);
    setChoosingSources(true);
  };

  const discardManualEvidenceMethodologyDraft = async (): Promise<void> => {
    if (manualEvidenceDraft === null) return;
    const sourceDecisionIds = [
      ...(manualEvidencePendingSources ??
        manualEvidenceDraft.sourceDecisionIds),
    ];
    manualEvidenceDraftSaveEpoch.current += 1;
    setManualEvidenceDraftSaveState("idle");
    setManualDraftStorageError(null);
    try {
      await api.deleteManualFormDraft("methodology_evidence_manual");
      setManualFormDrafts((current) =>
        current.filter((draft) => draft.key !== "methodology_evidence_manual"),
      );
      setSelectedSources(sourceDecisionIds);
      setManualEvidenceDraft({
        title: "",
        principle: "",
        appliesWhen: "",
        caution: "",
        evidenceSummary: "",
        sourceDecisionIds,
      });
      setManualEvidenceRestoredAt(null);
      setManualEvidencePendingSources(null);
    } catch (caught) {
      setManualEvidenceDraftSaveState("error");
      setManualDraftStorageError(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  };

  const saveManualEvidenceMethodology = async (): Promise<void> => {
    if (manualEvidenceDraft === null) return;
    setManualEvidenceSaving(true);
    setManualEvidenceError(null);
    try {
      const item =
        await api.createManualMethodologyFromEvidence(manualEvidenceDraft);
      manualEvidenceDraftSaveEpoch.current += 1;
      let draftCleanupError: string | null = null;
      try {
        await api.deleteManualFormDraft("methodology_evidence_manual");
        setManualFormDrafts((current) =>
          current.filter(
            (draft) => draft.key !== "methodology_evidence_manual",
          ),
        );
      } catch (caught) {
        draftCleanupError =
          caught instanceof Error ? caught.message : String(caught);
      }
      setManualEvidenceDraft(null);
      setManualEvidenceRestoredAt(null);
      setManualEvidencePendingSources(null);
      setSelectedSources([]);
      setSelected(item);
      setEditing(false);
      setConfirmingAcceptance(false);
      setStatus("candidate");
      setNotice({
        tone: draftCleanupError === null ? "success" : "warning",
        text:
          draftCleanupError === null
            ? `已基于 ${item.sourceDecisionIds.length} 条复盘建立人工候选，全程未调用模型。`
            : `候选已保存，但未完成草稿未能清除：${draftCleanupError}`,
      });
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setManualEvidenceError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setManualEvidenceSaving(false);
    }
  };

  const toggleImportCandidate = (id: string): void => {
    setSelectedImportCandidates((current) =>
      current.includes(id)
        ? current.filter((candidateId) => candidateId !== id)
        : [...current, id],
    );
  };

  const closeImportPreview = (): void => {
    if (importSaving) return;
    setImportPreview(null);
    setSelectedImportCandidates([]);
    setImportError(null);
  };

  const commitMarkdownImport = async (): Promise<void> => {
    if (
      importPreview?.batchId === null ||
      importPreview?.batchId === undefined ||
      selectedImportCandidates.length === 0
    ) {
      return;
    }
    setImportSaving(true);
    setImportError(null);
    try {
      const report = await api.commitMethodologyMarkdownImport(
        importPreview.batchId,
        selectedImportCandidates,
      );
      setImportPreview(null);
      setSelectedImportCandidates([]);
      const summary = [
        report.imported.length > 0
          ? `已导入 ${report.imported.length} 条候选`
          : null,
        report.duplicates.length > 0
          ? `提交前又识别到 ${report.duplicates.length} 条重复内容`
          : null,
        report.failures.length > 0
          ? `${report.failures.length} 条未完成`
          : null,
      ]
        .filter((value): value is string => value !== null)
        .join("；");
      setNotice({
        tone: report.failures.length > 0 ? "warning" : "success",
        text: summary || "没有新增候选。",
      });
      if (report.imported.length > 0) {
        setStatus("candidate");
        setRevisionKey((value) => value + 1);
      }
    } catch (caught) {
      setImportError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImportSaving(false);
    }
  };

  const generateSuggestionBatch = async (): Promise<void> => {
    const queue = suggestions.slice(0, 6);
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
    setSuggestionInboxOpen(false);
    setChoosingSources(false);
    setStatus("candidate");
    if (completed > 0) setRevisionKey((value) => value + 1);
    setNotice({
      tone: failures.length > 0 ? "warning" : "success",
      text:
        failures.length === 0
          ? `已生成 ${completed} 条候选，等待逐条审核。`
          : `已生成 ${completed} 条，${failures.length} 条未完成：${failures[0]}`,
    });
  };

  const openSuggestionInbox = (): void => {
    setSuggestionInboxMode(
      suggestions.length > 0 || deferredSuggestions.length === 0
        ? "active"
        : "deferred",
    );
    setSuggestionActionError(null);
    setSuggestionInboxOpen(true);
  };

  const deferSuggestion = async (
    suggestion: MethodologySuggestion,
  ): Promise<void> => {
    setSuggestionActionId(suggestion.id);
    setSuggestionActionError(null);
    try {
      await api.deferMethodologySuggestion(suggestion.id);
      setNotice({
        tone: "success",
        text: "已搁置这组复盘素材；有新复盘形成新组合时仍会再次提示。",
      });
      setSuggestionRevision((value) => value + 1);
    } catch (caught) {
      setSuggestionActionError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setSuggestionActionId(null);
    }
  };

  const restoreSuggestion = async (
    suggestion: MethodologySuggestion,
  ): Promise<void> => {
    setSuggestionActionId(suggestion.id);
    setSuggestionActionError(null);
    try {
      await api.restoreMethodologySuggestion(suggestion.id);
      setNotice({ tone: "success", text: "已恢复到可提炼素材。" });
      setSuggestionInboxMode("active");
      setSuggestionRevision((value) => value + 1);
    } catch (caught) {
      setSuggestionActionError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setSuggestionActionId(null);
    }
  };

  const openValidationItem = (item: MethodologyValidationItem): void => {
    setValidationInboxOpen(false);
    setValidationActionError(null);
    void openRelatedPrinciple(item.revisionDraftId ?? item.principleId);
  };

  const acknowledgeValidation = async (
    item: MethodologyValidationItem,
  ): Promise<void> => {
    if (item.revisionDraftId !== null) return;
    setValidationActionId(item.principleId);
    setValidationActionError(null);
    try {
      await api.acknowledgeMethodologyValidation(item.principleId);
      setValidationItems((current) =>
        current.filter(
          (candidate) => candidate.principleId !== item.principleId,
        ),
      );
      setNotice({
        tone: "success",
        text: `已确认“${item.title}”在这批新增复盘中仍适用；原则内容与可信度未改变。`,
      });
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setValidationActionError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setValidationActionId(null);
    }
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
      const updated = await api.reviseMethodology(selected.id, revision);
      setSelected(updated);
      setEditing(false);
      setConfirmingAcceptance(false);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const clearEvolutionEditor = (): void => {
    setEvolving(false);
    setEvolutionDraft(null);
    setEvolutionError(null);
    setEvolutionDraftRestoredAt(null);
    setEvolutionDraftRecoveryMessage(null);
  };

  const discardEvolutionFormDraft = async (): Promise<void> => {
    evolutionDraftSaveEpoch.current += 1;
    setEvolutionDraftClosing(true);
    setEvolutionDraftSaveState("idle");
    setManualDraftStorageError(null);
    try {
      await api.deleteManualFormDraft("methodology_revision");
      setManualFormDrafts((current) =>
        current.filter((draft) => draft.key !== "methodology_revision"),
      );
      clearEvolutionEditor();
      setEvolutionRebase(null);
      setEvolutionRebaseError(null);
      setNotice(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setEvolutionDraftSaveState("error");
      setManualDraftStorageError(message);
      if (evolutionDraft === null) {
        setNotice({
          tone: "error",
          text: `未能丢弃本机修订草稿：${message}`,
          action: "discard_revision_draft",
        });
      } else {
        setEvolutionError(`未能丢弃本机草稿：${message}`);
      }
    } finally {
      setEvolutionDraftClosing(false);
    }
  };

  const preserveEvolutionFormDraft = async (
    closeDetail: boolean,
  ): Promise<void> => {
    if (
      selected === null ||
      evolutionDraft === null ||
      evolutionDraftClosing
    ) {
      return;
    }
    const source = selected;
    const draft = evolutionDraft;
    const epoch = evolutionDraftSaveEpoch.current + 1;
    evolutionDraftSaveEpoch.current = epoch;
    setEvolutionDraftClosing(true);
    setEvolutionDraftSaveState("saving");
    setEvolutionError(null);
    try {
      const saved = await api.saveManualFormDraft({
        key: "methodology_revision",
        sourcePrincipleId: source.id,
        sourceUpdatedAt: source.updatedAt,
        sourceSnapshot: evolutionSourceSnapshot(source),
        input: draft,
      });
      if (saved.key !== "methodology_revision") {
        throw new Error("本机草稿类型不匹配");
      }
      if (evolutionDraftSaveEpoch.current !== epoch) return;
      setManualFormDrafts((current) => [
        ...current.filter((item) => item.key !== saved.key),
        saved,
      ]);
      setEvolutionDraftSaveState("saved");
      setManualDraftStorageError(null);
      clearEvolutionEditor();
      if (closeDetail) {
        setSelected(null);
        setEditing(false);
        setConfirmingAcceptance(false);
        setView("records");
      }
    } catch (caught) {
      if (evolutionDraftSaveEpoch.current !== epoch) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setEvolutionDraftSaveState("error");
      setManualDraftStorageError(message);
      setEvolutionError(`本机草稿保存失败，编辑窗口仍保持打开：${message}`);
    } finally {
      if (evolutionDraftSaveEpoch.current === epoch) {
        setEvolutionDraftClosing(false);
      }
    }
  };

  const restoreEvolutionFormDraft = async (
    saved: MethodologyRevisionFormDraft,
  ): Promise<void> => {
    setEvolutionDraftClosing(true);
    setNotice(null);
    setView("records");
    try {
      const records = await api.listMethodologies();
      const source = records.find(
        (item) => item.id === saved.sourcePrincipleId,
      );
      if (source === undefined) {
        throw new Error("来源原则已不存在");
      }
      if (source.status !== "accepted") {
        throw new Error("来源原则已不再处于已采纳状态");
      }
      const existingRevision = records.find(
        (item) =>
          item.status === "candidate" &&
          item.origin === "principle_revision" &&
          item.sourcePrincipleIds?.[0] === source.id,
      );
      if (existingRevision !== undefined) {
        throw new Error(`已经存在修订候选“${existingRevision.title}”`);
      }
      if (
        source.updatedAt !== saved.sourceUpdatedAt &&
        saved.sourceSnapshot === undefined
      ) {
        throw new Error("来源原则内容已更新，旧草稿缺少可比较的基线");
      }
      const usageSnapshot = await api.getMethodologyUsage(source.id);
      const originalEvidence = new Set(source.sourceDecisionIds);
      const newReviewedIds = usageSnapshot.decisions.flatMap((decision) =>
        decision.outcomeReview !== null && !originalEvidence.has(decision.id)
          ? [decision.id]
          : [],
      );
      if (newReviewedIds.length === 0) {
        throw new Error("已经没有可用于修订的采用后新复盘");
      }
      const allowedEvidence = new Set([
        ...source.sourceDecisions.flatMap((decision) =>
          decision.outcome !== null && decision.outcomeReview !== null
            ? [decision.id]
            : [],
        ),
        ...newReviewedIds,
      ]);
      const sourceDecisionIds = saved.input.sourceDecisionIds.filter((id) =>
        allowedEvidence.has(id),
      );
      const removedEvidenceCount =
        saved.input.sourceDecisionIds.length - sourceDecisionIds.length;
      if (source.updatedAt !== saved.sourceUpdatedAt) {
        const baseline = saved.sourceSnapshot!;
        const current = revisionFrom(source);
        const choices = Object.fromEntries(
          methodologyRevisionFields.map(({ field }) => [
            field,
            initialRevisionRebaseChoice(
              baseline[field],
              current[field],
              saved.input[field],
            ),
          ]),
        ) as Record<
          MethodologyRevisionField,
          MethodologyRevisionRebaseChoice
        >;
        clearEvolutionEditor();
        setSelected(null);
        setEvolutionRebase({
          saved,
          baseline,
          source,
          usage: usageSnapshot,
          sourceDecisionIds,
          removedEvidenceCount,
          choices,
        });
        setEvolutionRebaseError(null);
        return;
      }
      setEvolutionRebase(null);
      setEvolutionRebaseError(null);
      hydratedUsageForPrinciple.current =
        selected?.id === source.id ? null : source.id;
      setSelected(source);
      setUsage(usageSnapshot);
      setUsageLoading(false);
      setUsageError(null);
      setEditing(false);
      setConfirmingAcceptance(false);
      setEvolutionDraft({ ...saved.input, sourceDecisionIds });
      setEvolutionDraftRestoredAt(saved.updatedAt);
      setEvolutionDraftSaveState("saved");
      setEvolutionDraftRecoveryMessage(
        removedEvidenceCount === 0
          ? "已按当前原则版本和采用后复盘重新校验。"
          : `已移除 ${removedEvidenceCount} 条不再可用的证据，请重新确认。`,
      );
      setEvolutionError(null);
      setEvolving(true);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      clearEvolutionEditor();
      setEvolutionRebase(null);
      setEvolutionRebaseError(null);
      setSelected(null);
      setNotice({
        tone: "warning",
        text: `未恢复修订草稿：${message}。草稿仍保留在本机，可直接丢弃。`,
        action: "discard_revision_draft",
      });
    } finally {
      setEvolutionDraftClosing(false);
    }
  };

  const setEvolutionRebaseChoice = (
    field: MethodologyRevisionField,
    choice: Exclude<MethodologyRevisionRebaseChoice, null>,
  ): void => {
    setEvolutionRebase((current) =>
      current === null
        ? null
        : { ...current, choices: { ...current.choices, [field]: choice } },
    );
    setEvolutionRebaseError(null);
  };

  const applyEvolutionRebase = async (): Promise<void> => {
    if (
      evolutionRebase === null ||
      Object.values(evolutionRebase.choices).some((choice) => choice === null)
    ) {
      return;
    }
    const current = revisionFrom(evolutionRebase.source);
    const input = {
      ...Object.fromEntries(
        methodologyRevisionFields.map(({ field }) => [
          field,
          evolutionRebase.choices[field] === "draft"
            ? evolutionRebase.saved.input[field]
            : current[field],
        ]),
      ),
      sourceDecisionIds: evolutionRebase.sourceDecisionIds,
    } as MethodologyEvolutionInput;
    const source = evolutionRebase.source;
    const usageSnapshot = evolutionRebase.usage;
    const removedEvidenceCount = evolutionRebase.removedEvidenceCount;
    const epoch = evolutionDraftSaveEpoch.current + 1;
    evolutionDraftSaveEpoch.current = epoch;
    setEvolutionRebaseSaving(true);
    setEvolutionRebaseError(null);
    try {
      const saved = await api.saveManualFormDraft({
        key: "methodology_revision",
        sourcePrincipleId: source.id,
        sourceUpdatedAt: source.updatedAt,
        sourceSnapshot: evolutionSourceSnapshot(source),
        input,
      });
      if (saved.key !== "methodology_revision") {
        throw new Error("本机草稿类型不匹配");
      }
      if (evolutionDraftSaveEpoch.current !== epoch) return;
      setManualFormDrafts((drafts) => [
        ...drafts.filter((draft) => draft.key !== saved.key),
        saved,
      ]);
      hydratedUsageForPrinciple.current = source.id;
      setSelected(source);
      setUsage(usageSnapshot);
      setUsageLoading(false);
      setUsageError(null);
      setEditing(false);
      setConfirmingAcceptance(false);
      setEvolutionDraft(input);
      setEvolutionDraftRestoredAt(saved.updatedAt);
      setEvolutionDraftSaveState("saved");
      setEvolutionDraftRecoveryMessage(
        removedEvidenceCount === 0
          ? "已按逐字段选择迁移到当前正式版本。"
          : `已迁移到当前版本，并移除 ${removedEvidenceCount} 条不再可用的证据。`,
      );
      setEvolutionError(null);
      setEvolutionRebase(null);
      setEvolving(true);
      setManualDraftStorageError(null);
    } catch (caught) {
      setEvolutionRebaseError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setEvolutionRebaseSaving(false);
    }
  };

  const beginEvolution = (): void => {
    if (selected === null || newEvolutionEvidence.length === 0) return;
    if (storedRevisionDraft !== undefined) {
      if (storedRevisionDraft.sourcePrincipleId === selected.id) {
        void restoreEvolutionFormDraft(storedRevisionDraft);
      } else {
        setDetailError(
          "已有另一条原则的未完成修订草稿，请先从原则页继续或丢弃。",
        );
      }
      return;
    }
    const newIds = newEvolutionEvidence.map((decision) => decision.id);
    const sourceDecisionIds = [
      ...newIds,
      ...selected.sourceDecisions
        .map((decision) => decision.id)
        .filter((id) => !newIds.includes(id)),
    ].slice(0, 5);
    const observations = newEvolutionEvidence
      .filter((decision) => sourceDecisionIds.includes(decision.id))
      .map(
        (decision, index) =>
          `新增复盘 ${index + 1}：${decision.outcomeReview?.lesson ?? decision.outcome ?? "已完成复盘"}`,
      )
      .join("；");
    setEvolutionDraft({
      ...revisionFrom(selected),
      evidenceSummary: `${selected.evidenceSummary}\n\n${observations}`.slice(
        0,
        3_000,
      ),
      sourceDecisionIds,
    });
    setEvolutionError(null);
    setEvolutionDraftRestoredAt(null);
    setEvolutionDraftRecoveryMessage(null);
    setEvolutionDraftSaveState("idle");
    setConfirmingAcceptance(false);
    setEvolving(true);
  };

  const toggleEvolutionEvidence = (id: string): void => {
    setEvolutionDraft((current) => {
      if (current === null) return current;
      return current.sourceDecisionIds.includes(id)
        ? {
            ...current,
            sourceDecisionIds: current.sourceDecisionIds.filter(
              (sourceId) => sourceId !== id,
            ),
          }
        : current.sourceDecisionIds.length >= 5
          ? current
          : {
              ...current,
              sourceDecisionIds: [...current.sourceDecisionIds, id],
            };
    });
  };

  const saveEvolution = async (): Promise<void> => {
    if (selected === null || evolutionDraft === null) return;
    setEvolutionSaving(true);
    setEvolutionError(null);
    try {
      const candidate = await api.createMethodologyRevisionDraft(
        selected.id,
        evolutionDraft,
      );
      evolutionDraftSaveEpoch.current += 1;
      try {
        await api.deleteManualFormDraft("methodology_revision");
        setManualFormDrafts((current) =>
          current.filter((draft) => draft.key !== "methodology_revision"),
        );
      } catch (caught) {
        setNotice({
          tone: "warning",
          text: `修订候选已创建，但本机草稿未能清除：${caught instanceof Error ? caught.message : String(caught)}`,
          action: "discard_revision_draft",
        });
      }
      setSelected(candidate);
      clearEvolutionEditor();
      setStatus("candidate");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setEvolutionError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setEvolutionSaving(false);
    }
  };

  const restoreMethodologyVersion = async (version: number): Promise<void> => {
    if (selected === null) return;
    setRestoringVersion(true);
    setHistoryError(null);
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
      setHistoryError(
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
    setSaving(true);
    setDetailError(null);
    try {
      const related = (await api.listMethodologies()).find(
        (item) => item.id === id,
      );
      if (related === undefined) {
        throw new Error("关联原则已不存在，请刷新后重试。");
      }
      setSelected(related);
      setEditing(false);
      setConfirmingAcceptance(false);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const clearMergeEditor = (): void => {
    setMergeDraft(null);
    setMergeError(null);
    setMergeRelationReview(null);
    setMergeRelationError(null);
    setMergeRelationOutcome(null);
    setMergeDraftRestoredAt(null);
    setMergeDraftRecoveryMessage(null);
  };

  const discardMergeFormDraft = async (): Promise<void> => {
    mergeDraftSaveEpoch.current += 1;
    setMergeDraftClosing(true);
    setMergeDraftSaveState("idle");
    setManualDraftStorageError(null);
    try {
      await api.deleteManualFormDraft("methodology_merge");
      setManualFormDrafts((current) =>
        current.filter((draft) => draft.key !== "methodology_merge"),
      );
      clearMergeEditor();
      setNotice(null);
    } catch (caught) {
      setMergeDraftSaveState("error");
      const message = caught instanceof Error ? caught.message : String(caught);
      setManualDraftStorageError(message);
      if (mergeDraft === null) {
        setNotice({
          tone: "error",
          text: `未能丢弃本机合并草稿：${message}`,
          action: "discard_merge_draft",
        });
      } else {
        setMergeError(`未能丢弃本机草稿：${message}`);
      }
    } finally {
      setMergeDraftClosing(false);
    }
  };

  const preserveAndCloseMergeDraft = async (): Promise<void> => {
    if (mergeDraft === null || mergeDraftClosing) return;
    const draft = mergeDraft;
    const epoch = mergeDraftSaveEpoch.current + 1;
    mergeDraftSaveEpoch.current = epoch;
    setMergeDraftClosing(true);
    setMergeDraftSaveState("saving");
    setMergeError(null);
    try {
      const saved = await api.saveManualFormDraft({
        key: "methodology_merge",
        sourcePrincipleIds: draft.sources.map((source) => source.id),
        input: draft.input,
      });
      if (saved.key !== "methodology_merge") {
        throw new Error("本机草稿类型不匹配");
      }
      if (mergeDraftSaveEpoch.current !== epoch) return;
      setManualFormDrafts((current) => [
        ...current.filter((item) => item.key !== saved.key),
        saved,
      ]);
      setMergeDraftSaveState("saved");
      setManualDraftStorageError(null);
      clearMergeEditor();
      setView("records");
    } catch (caught) {
      if (mergeDraftSaveEpoch.current !== epoch) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setMergeDraftSaveState("error");
      setManualDraftStorageError(message);
      setMergeError(`本机草稿保存失败，编辑窗口仍保持打开：${message}`);
    } finally {
      if (mergeDraftSaveEpoch.current === epoch) {
        setMergeDraftClosing(false);
      }
    }
  };

  const restoreMergeFormDraft = async (
    saved: MethodologyMergeFormDraft,
  ): Promise<void> => {
    setMergeLoading(true);
    setMergeError(null);
    setMergeRelationReview(null);
    setMergeRelationError(null);
    setMergeRelationOutcome(null);
    setNotice(null);
    setView("records");
    try {
      const records = await api.listMethodologies();
      const sources = saved.sourcePrincipleIds.flatMap((id) => {
        const source = records.find((item) => item.id === id);
        return source === undefined ? [] : [source];
      });
      if (sources.length !== saved.sourcePrincipleIds.length) {
        throw new Error("部分来源原则已不存在");
      }
      if (sources.some((source) => source.status !== "accepted")) {
        throw new Error("部分来源原则已不再处于已采纳状态");
      }
      if (!allPairsConfirmedDuplicate(sources)) {
        throw new Error("来源之间的重复关系已经变化");
      }
      const existingMerge = records.find(
        (item) =>
          item.origin === "principle_merge" &&
          (item.status === "candidate" || item.status === "accepted") &&
          sameIdSet(item.sourcePrincipleIds ?? [], saved.sourcePrincipleIds),
      );
      if (existingMerge !== undefined) {
        throw new Error(`同一组来源已经存在“${existingMerge.title}”`);
      }
      const availableEvidence = mergeEvidence(sources);
      if (availableEvidence.length === 0) {
        throw new Error("来源原则已没有可用于合并的复盘证据");
      }
      const allowedEvidence = new Set(
        availableEvidence.map((decision) => decision.id),
      );
      const sourceDecisionIds = saved.input.sourceDecisionIds.filter((id) =>
        allowedEvidence.has(id),
      );
      const removedEvidenceCount =
        saved.input.sourceDecisionIds.length - sourceDecisionIds.length;
      const autoEvidenceSummary = mergeEvidenceSummary(sources);
      setSelected(null);
      setMergeDraft({
        sources,
        availablePrinciples: records.filter(
          (item) => item.status === "accepted",
        ),
        availableEvidence,
        autoEvidenceSummary,
        input: { ...saved.input, sourceDecisionIds },
      });
      setMergeDraftRestoredAt(saved.updatedAt);
      setMergeDraftSaveState("saved");
      setMergeDraftRecoveryMessage(
        removedEvidenceCount === 0
          ? "已按当前原则状态和成对关系重新校验。"
          : `已移除 ${removedEvidenceCount} 条不再可用的证据，请重新确认。`,
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      clearMergeEditor();
      setNotice({
        tone: "warning",
        text: `未恢复合并草稿：${message}。草稿仍保留在本机，可直接丢弃。`,
        action: "discard_merge_draft",
      });
    } finally {
      setMergeLoading(false);
    }
  };

  const beginMergePrinciples = async (
    firstId: string,
    secondId: string,
  ): Promise<void> => {
    if (storedMergeDraft !== undefined) {
      if (
        storedMergeDraft.sourcePrincipleIds.includes(firstId) &&
        storedMergeDraft.sourcePrincipleIds.includes(secondId)
      ) {
        await restoreMergeFormDraft(storedMergeDraft);
      } else {
        setView("records");
        setNotice({
          tone: "warning",
          text: "已有一份未完成的合并草稿。请先继续或丢弃，再建立另一组。",
          action: "discard_merge_draft",
        });
      }
      return;
    }
    setMergeLoading(true);
    setMergeError(null);
    setMergeRelationReview(null);
    setMergeRelationError(null);
    setMergeRelationOutcome(null);
    setNotice(null);
    try {
      const records = await api.listMethodologies();
      const first = records.find((item) => item.id === firstId);
      const second = records.find((item) => item.id === secondId);
      if (first === undefined || second === undefined) {
        throw new Error("来源原则已变化，请刷新图谱后重试。");
      }
      const sources = [first, second];
      const availableEvidence = mergeEvidence(sources);
      if (availableEvidence.length === 0) {
        throw new Error("这组原则没有可用于合并草案的已复盘证据。");
      }
      const autoEvidenceSummary = mergeEvidenceSummary(sources);
      setSelected(null);
      setMergeDraftRestoredAt(null);
      setMergeDraftRecoveryMessage(null);
      setMergeDraftSaveState("idle");
      setMergeDraft({
        sources,
        availablePrinciples: records.filter(
          (item) => item.status === "accepted",
        ),
        availableEvidence,
        autoEvidenceSummary,
        input: {
          title: first.title,
          principle: first.principle,
          appliesWhen: first.appliesWhen,
          caution: first.caution,
          evidenceSummary: autoEvidenceSummary,
          sourceDecisionIds: availableEvidence
            .slice(0, 5)
            .map((decision) => decision.id),
        },
      });
    } catch (caught) {
      setNotice({
        tone: "error",
        text: `无法建立合并草案：${caught instanceof Error ? caught.message : String(caught)}`,
      });
    } finally {
      setMergeLoading(false);
    }
  };

  const toggleMergeSource = (id: string): void => {
    setMergeRelationOutcome(null);
    setMergeDraft((current) => {
      if (current === null) return null;
      const selected = current.sources.some((source) => source.id === id);
      let sources: MethodologyItem[];
      if (selected) {
        if (current.sources.length <= 2) return current;
        sources = current.sources.filter((source) => source.id !== id);
      } else {
        if (current.sources.length >= 5) return current;
        const candidate = current.availablePrinciples.find(
          (item) => item.id === id,
        );
        if (
          candidate === undefined ||
          !current.sources.every((source) =>
            confirmedDuplicate(source, candidate),
          )
        ) {
          return current;
        }
        sources = [...current.sources, candidate];
      }
      return updateMergeSources(current, sources);
    });
  };

  const beginMergeRelationReview = (
    assessment: MethodologyMergeCandidateAssessment,
  ): void => {
    if (assessment.missingSources.length === 0) {
      toggleMergeSource(assessment.item.id);
      return;
    }
    setMergeRelationError(null);
    setMergeRelationOutcome(null);
    setMergeRelationReview({
      candidateId: assessment.item.id,
      pendingSourceIds: assessment.missingSources.map((source) => source.id),
      totalPairCount: assessment.missingSources.length,
      note: "",
    });
  };

  const saveMergeRelationReview = async (
    disposition: MethodologyRelationDisposition,
  ): Promise<void> => {
    if (mergeDraft === null || mergeRelationReview === null) return;
    const sourceId = mergeRelationReview.pendingSourceIds[0];
    if (sourceId === undefined) return;
    const candidateId = mergeRelationReview.candidateId;
    setMergeRelationSaving(true);
    setMergeRelationError(null);
    try {
      await api.setMethodologyRelation(
        sourceId,
        candidateId,
        disposition,
        mergeRelationReview.note.trim() || null,
      );
      const refreshed = await api.listMethodologies();
      const availablePrinciples = refreshed.filter(
        (item) => item.status === "accepted",
      );
      if (disposition !== "duplicate") {
        setMergeDraft((current) => {
          if (current === null) return null;
          const sources = current.sources.map(
            (source) =>
              availablePrinciples.find((item) => item.id === source.id) ??
              source,
          );
          return updateMergeSources(current, sources, availablePrinciples);
        });
        setMergeRelationReview(null);
        setMergeRelationOutcome(
          disposition === "conflict"
            ? "已记录为冲突；这条原则不会加入当前合并组。"
            : "已记录为无关；这条原则不会加入当前合并组。",
        );
        setRevisionKey((value) => value + 1);
        return;
      }

      const remaining = mergeRelationReview.pendingSourceIds.slice(1);
      if (remaining.length > 0) {
        setMergeDraft((current) => {
          if (current === null) return null;
          const sources = current.sources.map(
            (source) =>
              availablePrinciples.find((item) => item.id === source.id) ??
              source,
          );
          return updateMergeSources(current, sources, availablePrinciples);
        });
        setMergeRelationReview({
          ...mergeRelationReview,
          pendingSourceIds: remaining,
          note: "",
        });
        setRevisionKey((value) => value + 1);
        return;
      }

      setMergeDraft((current) => {
        if (current === null) return null;
        const sources = current.sources.map(
          (source) =>
            availablePrinciples.find((item) => item.id === source.id) ?? source,
        );
        const candidate = availablePrinciples.find(
          (item) => item.id === candidateId,
        );
        if (candidate === undefined || sources.length >= 5) {
          return updateMergeSources(current, sources, availablePrinciples);
        }
        return updateMergeSources(
          current,
          [...sources, candidate],
          availablePrinciples,
        );
      });
      setMergeRelationReview(null);
      setMergeRelationOutcome("缺失关系已逐对确认，这条原则已加入合并组。");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setMergeRelationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setMergeRelationSaving(false);
    }
  };

  const updateMergeField = (
    field: keyof MethodologyRevisionInput,
    value: string,
  ): void => {
    setMergeDraft((current) =>
      current === null
        ? null
        : { ...current, input: { ...current.input, [field]: value } },
    );
  };

  const toggleMergeEvidence = (id: string): void => {
    setMergeDraft((current) => {
      if (current === null) return null;
      const selectedIds = current.input.sourceDecisionIds;
      const sourceDecisionIds = selectedIds.includes(id)
        ? selectedIds.filter((value) => value !== id)
        : selectedIds.length >= 5
          ? selectedIds
          : [...selectedIds, id];
      return { ...current, input: { ...current.input, sourceDecisionIds } };
    });
  };

  const createMergeDraft = async (): Promise<void> => {
    if (mergeDraft === null) return;
    setMergeSaving(true);
    setMergeError(null);
    try {
      const created = await api.createMethodologyMergeDraft(
        mergeDraft.sources.map((source) => source.id),
        mergeDraft.input,
      );
      mergeDraftSaveEpoch.current += 1;
      try {
        await api.deleteManualFormDraft("methodology_merge");
        setManualFormDrafts((current) =>
          current.filter((draft) => draft.key !== "methodology_merge"),
        );
      } catch (caught) {
        setNotice({
          tone: "warning",
          text: `合并候选已创建，但本机草稿未能清除：${caught instanceof Error ? caught.message : String(caught)}`,
          action: "discard_merge_draft",
        });
      }
      clearMergeEditor();
      setSelected(created);
      setEditing(false);
      setConfirmingAcceptance(false);
      setStatus("candidate");
      setView("records");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setMergeError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMergeSaving(false);
    }
  };

  const loadMergeLifecycle = async (
    mergeId: string,
  ): Promise<MethodologyMergeLifecyclePlan> => {
    const plan = await api.getMethodologyMergePlan(mergeId);
    setMergeLifecyclePlan(plan);
    return plan;
  };

  const openMergeLifecycle = async (mergeId: string): Promise<void> => {
    setMergeLifecycleOpen(true);
    setMergeLifecycleLoading(true);
    setMergeLifecycleError(null);
    try {
      await loadMergeLifecycle(mergeId);
    } catch (caught) {
      setMergeLifecyclePlan(null);
      setMergeLifecycleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setMergeLifecycleLoading(false);
    }
  };

  const prepareMergeAsset = async (
    mergeId: string,
    assetId: string,
  ): Promise<void> => {
    setMergeLifecycleBusyAssetId(assetId);
    setMergeLifecycleError(null);
    try {
      await api.prepareMethodologyMergeAsset(mergeId, assetId);
      await loadMergeLifecycle(mergeId);
    } catch (caught) {
      setMergeLifecycleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setMergeLifecycleBusyAssetId(null);
    }
  };

  const retireMergeSources = async (mergeId: string): Promise<void> => {
    setMergeLifecycleSaving(true);
    setMergeLifecycleError(null);
    try {
      const plan = await api.retireMethodologyMergeSources(mergeId);
      setMergeLifecyclePlan(plan);
      const refreshed = (await api.listMethodologies()).find(
        (item) => item.id === mergeId,
      );
      if (refreshed !== undefined) setSelected(refreshed);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setMergeLifecycleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setMergeLifecycleSaving(false);
    }
  };

  const restoreMergeSources = async (mergeId: string): Promise<void> => {
    setMergeLifecycleSaving(true);
    setMergeLifecycleError(null);
    try {
      const plan = await api.restoreMethodologyMergeSources(mergeId);
      setMergeLifecyclePlan(plan);
      const refreshed = (await api.listMethodologies()).find(
        (item) => item.id === mergeId,
      );
      if (refreshed !== undefined) setSelected(refreshed);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setMergeLifecycleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setMergeLifecycleSaving(false);
    }
  };

  const beginRelationReview = (relation: MethodologyQualityRelation): void => {
    setReviewingRelation(relation);
    setRelationDisposition(relation.resolution ?? null);
    setRelationNote(relation.resolutionNote ?? "");
    setRelationError(null);
    setConfirmingAcceptance(false);
  };

  const saveRelationReview = async (): Promise<void> => {
    if (
      selected === null ||
      reviewingRelation === null ||
      relationDisposition === null
    ) {
      return;
    }
    setRelationSaving(true);
    setRelationError(null);
    try {
      const updated = await api.setMethodologyRelation(
        selected.id,
        reviewingRelation.id,
        relationDisposition,
        relationNote.trim() || null,
      );
      setSelected(updated);
      setReviewingRelation(null);
      setRelationDisposition(null);
      setRelationNote("");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setRelationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRelationSaving(false);
    }
  };

  const clearRelationReview = async (): Promise<void> => {
    if (selected === null || reviewingRelation === null) return;
    setRelationSaving(true);
    setRelationError(null);
    try {
      const updated = await api.clearMethodologyRelation(
        selected.id,
        reviewingRelation.id,
      );
      setSelected(updated);
      setReviewingRelation(null);
      setRelationDisposition(null);
      setRelationNote("");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setRelationError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRelationSaving(false);
    }
  };

  const closeRelationQueue = (): void => {
    setRelationQueue(null);
    setRelationQueueTotal(0);
    setRelationQueueDisposition(null);
    setRelationQueueNote("");
    setRelationQueueError(null);
  };

  const openRelationQueue = async (): Promise<void> => {
    setRelationQueueLoading(true);
    setNotice(null);
    try {
      const records = await api.listMethodologies();
      const queue = buildRelationReviewQueue(records);
      if (queue.length === 0) {
        setNotice({ tone: "success", text: "当前没有待核对的原则关系。" });
        return;
      }
      setSelected(null);
      setReviewingRelation(null);
      setRelationQueue(queue);
      setRelationQueueTotal(queue.length);
      setRelationQueueDisposition(null);
      setRelationQueueNote("");
      setRelationQueueError(null);
    } catch (caught) {
      setNotice({
        tone: "error",
        text: `关系整理失败：${caught instanceof Error ? caught.message : String(caught)}`,
      });
    } finally {
      setRelationQueueLoading(false);
    }
  };

  const saveRelationQueueItem = async (): Promise<void> => {
    const queue = relationQueue;
    if (queue === null || relationQueueDisposition === null) return;
    const current = queue[0];
    if (current === undefined) return;
    setRelationQueueSaving(true);
    setRelationQueueError(null);
    try {
      const updated = await api.setMethodologyRelation(
        current.left.id,
        current.right.id,
        relationQueueDisposition,
        relationQueueNote.trim() || null,
      );
      setItems((records) =>
        records.map((record) => (record.id === updated.id ? updated : record)),
      );
      const remaining = queue.slice(1);
      setRelationQueueDisposition(null);
      setRelationQueueNote("");
      if (remaining.length === 0) {
        closeRelationQueue();
        setNotice({
          tone: "success",
          text: `已完成 ${relationQueueTotal} 组原则关系核对。`,
        });
        setRevisionKey((value) => value + 1);
      } else {
        setRelationQueue(remaining);
      }
    } catch (caught) {
      setRelationQueueError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setRelationQueueSaving(false);
    }
  };

  const postponeRelationQueueItem = (): void => {
    if (relationQueue === null || relationQueue.length <= 1) {
      closeRelationQueue();
      return;
    }
    const [current, ...remaining] = relationQueue;
    setRelationQueue([...remaining, current!]);
    setRelationQueueDisposition(null);
    setRelationQueueNote("");
    setRelationQueueError(null);
  };

  const selectedIsUnverifiedExternal =
    (selected?.origin === "markdown_import" ||
      selected?.origin === "manual_entry") &&
    selected.sourceDecisionIds.length === 0;
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

  return (
    <section
      className="desktop-view methodology-panel"
      role="region"
      aria-label="方法论"
    >
      <DesktopPageHeader
        eyebrow="沉淀"
        title="方法论"
        description="从真实结果与复盘中提炼可复用原则。"
        meta={
          view === "assets" || view === "analysis"
            ? undefined
            : view === "graph"
              ? (graph?.principles.length ?? 0)
              : items.length
        }
        metaLabel={view === "graph" ? "已采纳原则" : "当前列表"}
      />

      <div className="desktop-page-scroll methodology-content">
        <section
          className={`methodology-card${view === "records" ? "" : " graph-view"}`}
          aria-label="方法论工作区"
        >
          <div className="methodology-toolbar">
            <div
              className="methodology-view-tabs"
              role="tablist"
              aria-label="方法论视图"
            >
              {methodologyViews.map(({ value, label }) => (
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
                  {label}
                </button>
              ))}
            </div>
            {view === "records" ? (
              <div className="methodology-records-toolbar">
                <span
                  className="methodology-toolbar-divider"
                  aria-hidden="true"
                />
                <div
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
                  {loading ? "正在读取…" : `${items.length} 条`}
                </span>
                <div className="methodology-toolbar-actions">
                  {storedRevisionDraft === undefined ? null : (
                    <button
                      type="button"
                      className="text-button methodology-draft-resume-button"
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
                      className="text-button methodology-merge-resume-button"
                      disabled={mergeLoading || mergeDraftClosing}
                      onClick={() =>
                        void restoreMergeFormDraft(storedMergeDraft)
                      }
                    >
                      {mergeLoading ? "正在校验…" : "继续合并"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`text-button methodology-workbench-button${
                      suggestions.length +
                        validationItems.length +
                        pendingRelationCount(items) >
                      0
                        ? " pending"
                        : ""
                    }`}
                    aria-label={`方法论工作箱 ${
                      suggestions.length +
                      validationItems.length +
                      pendingRelationCount(items)
                    }`}
                    onClick={() => setWorkbenchOpen(true)}
                  >
                    工作箱
                    {suggestions.length +
                      validationItems.length +
                      pendingRelationCount(items) >
                    0
                      ? ` ${
                          suggestions.length +
                          validationItems.length +
                          pendingRelationCount(items)
                        }`
                      : ""}
                  </button>
                  <button
                    type="button"
                    className="primary-button methodology-create-button"
                    disabled={importing || batchGenerating}
                    onClick={openCreation}
                  >
                    新建原则
                  </button>
                </div>
              </div>
            ) : view === "assets" ? (
              <div className="methodology-records-toolbar practice-assets-toolbar-host">
                <span
                  className="methodology-toolbar-divider"
                  aria-hidden="true"
                />
                <div
                  ref={setPracticeToolbarHost}
                  className="practice-assets-toolbar-portal"
                />
              </div>
            ) : null}
          </div>

          {view === "records" && notice !== null ? (
            <div
              className={`methodology-operation-notice ${notice.tone}`}
              role={notice.tone === "error" ? "alert" : "status"}
            >
              <span>{notice.text}</span>
              {notice.action === "discard_merge_draft" ? (
                <button
                  type="button"
                  disabled={mergeDraftClosing}
                  onClick={() => void discardMergeFormDraft()}
                >
                  {mergeDraftClosing ? "正在丢弃…" : "丢弃草稿"}
                </button>
              ) : null}
              {notice.action === "discard_revision_draft" ? (
                <button
                  type="button"
                  disabled={evolutionDraftClosing}
                  onClick={() => void discardEvolutionFormDraft()}
                >
                  {evolutionDraftClosing ? "正在丢弃…" : "丢弃草稿"}
                </button>
              ) : null}
              <button type="button" onClick={() => setNotice(null)}>
                关闭
              </button>
            </div>
          ) : null}

          <div
            id="methodology-tab-panel"
            className={`methodology-tab-panel ${view}`}
            role="tabpanel"
            aria-labelledby={`methodology-tab-${view}`}
            tabIndex={-1}
          >
            {view === "analysis" ? (
              <DecisionAnalyticsView
                api={api}
                onOpenDecisions={() => void api.openSurface("decisions")}
              />
            ) : view === "graph" ? (
              <KnowledgeGraphView
                graph={graph}
                loading={graphLoading}
                error={graphError}
                mergeLoading={mergeLoading}
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
            ) : view === "assets" ? (
              <PracticeAssetsView
                api={api}
                toolbarHost={practiceToolbarHost}
                onOpenPrinciples={() => {
                  setStatus("candidate");
                  setView("records");
                }}
              />
            ) : error !== null ? (
              <p className="methodology-message error-message">
                方法论记录暂时无法读取：{error}
              </p>
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
              <div className="methodology-records-body">
                <ol
                  className={`methodology-list${
                    status === "candidate" &&
                    items.length > 0 &&
                    items.length <= 4
                      ? " guided"
                      : ""
                  }`}
                  aria-label="方法论列表"
                >
                  {items.map((item) => {
                    const qualityBadge = qualityBadgeFor(item);
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="methodology-row"
                          onClick={() => {
                            setSelected(item);
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
                          <span
                            className={`methodology-confidence ${item.quality.recommendedConfidence}`}
                          >
                            {confidenceLabelFor(item)}
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
                  })}
                </ol>

                {status === "candidate" &&
                items.length > 0 &&
                items.length <= 4 ? (
                  <section
                    className="methodology-build-guide"
                    aria-label="方法论建设进度"
                  >
                    <header>
                      <div>
                        <span>建设进度</span>
                        <strong>把真实决策逐步变成可复用方法</strong>
                      </div>
                      <small>只统计本地事实，不会自动生成或采纳</small>
                    </header>

                    {buildProgress === null ? (
                      <p className="methodology-build-loading" role="status">
                        {buildProgressUnavailable
                          ? "建设进度暂时无法读取，现有原则仍可正常处理。"
                          : "正在汇总完整建设进度…"}
                      </p>
                    ) : (
                      <dl className="methodology-build-metrics">
                        {(
                          [
                            ["已记录决策", buildProgress.decisions.total],
                            ["完整复盘", buildProgress.decisions.reviewed],
                            ["待确认原则", buildProgress.principles.candidate],
                            ["已采纳原则", buildProgress.principles.accepted],
                            [
                              "已采纳实践",
                              buildProgress.practiceAssets.accepted,
                            ],
                          ] as const
                        ).map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}

                    {buildProgress === null ? null : (
                      <ol
                        className="methodology-build-path"
                        aria-label="方法论建设路径"
                      >
                        <li>
                          <b>1</b>
                          <div>
                            <span>复盘证据</span>
                            <strong>
                              {buildProgress.decisions.reviewed} 条可用
                            </strong>
                            <small>
                              {buildProgress.decisions.pendingOutcome} 条待结果
                              · {buildProgress.decisions.pendingReview} 条待复盘
                            </small>
                          </div>
                        </li>
                        <li>
                          <b>2</b>
                          <div>
                            <span>原则沉淀</span>
                            <strong>
                              {buildProgress.principles.accepted} 条已采纳
                            </strong>
                            <small>
                              {buildProgress.principles.candidate}{" "}
                              条等待人工审核
                            </small>
                          </div>
                        </li>
                        <li>
                          <b>3</b>
                          <div>
                            <span>实践落地</span>
                            <strong>
                              {buildProgress.practiceAssets.accepted} 条已采纳
                            </strong>
                            <small>
                              {buildProgress.practiceAssets.candidate}{" "}
                              条草案等待确认
                            </small>
                          </div>
                        </li>
                      </ol>
                    )}

                    <div className="methodology-build-next">
                      <div>
                        <span>建议下一步</span>
                        <strong>
                          先审核{" "}
                          {buildProgress?.principles.candidate ?? items.length}{" "}
                          条待确认原则
                        </strong>
                        <p>
                          {suggestions.length > 0
                            ? `处理完现有候选后，还有 ${suggestions.length} 组复盘证据可以继续提炼。`
                            : "核对原则、适用条件和边界；明确采纳后才会进入图谱与实践资产。"}
                        </p>
                      </div>
                      <div className="methodology-build-actions">
                        <button
                          type="button"
                          className="primary-button"
                          onClick={() => {
                            const first = items[0];
                            if (first === undefined) return;
                            setSelected(first);
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
                              openSourceChooser(
                                suggestions[0]?.sourceDecisionIds,
                              )
                            }
                          >
                            查看 {suggestions.length} 组建议
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-button"
                          disabled={importing || batchGenerating}
                          onClick={openCreation}
                        >
                          新建原则
                        </button>
                      </div>
                    </div>
                  </section>
                ) : null}
              </div>
            )}
          </div>
        </section>
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
              <div className="methodology-create-boundary">
                <span>不会自动采纳</span>
                <span>不会自动建立证据关系</span>
                <span>采纳后才进入图谱与实践资产</span>
              </div>
              <footer>
                <button
                  type="button"
                  className="text-button"
                  onClick={closeCreation}
                >
                  取消
                </button>
              </footer>
            </section>
          ) : (
            <section className="methodology-manual-entry">
              <div
                className={`manual-form-draft-status${
                  manualDraftRestoredAt === null ? "" : " restored"
                }`}
                role="status"
              >
                <span>
                  <strong>
                    {manualDraftRestoredAt === null
                      ? "未完成内容会自动保存"
                      : "已恢复未完成草稿"}
                  </strong>
                  <small>
                    {manualDraftRestoredAt === null
                      ? "只写入这台 Mac 的 App 私有目录，不会进入方法论列表。"
                      : `${dateFormatter.format(new Date(manualDraftRestoredAt))} 保存，只在本机可见。`}
                  </small>
                </span>
                <div>
                  <em>
                    {manualDraftSaveState === "saving"
                      ? "正在保存…"
                      : manualDraftSaveState === "saved"
                        ? "已自动保存"
                        : manualDraftSaveState === "error"
                          ? "自动保存失败"
                          : "本机草稿"}
                  </em>
                  {manualDraftRestoredAt === null ? null : (
                    <button
                      type="button"
                      className="text-button"
                      disabled={manualSaving}
                      onClick={() => void discardManualMethodologyDraft()}
                    >
                      丢弃并新建
                    </button>
                  )}
                </div>
              </div>
              <div className="methodology-editor methodology-manual-entry-form">
                <label>
                  <span>标题</span>
                  <input
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
                </label>
                <label>
                  <span>原则</span>
                  <textarea
                    maxLength={2_000}
                    value={manualDraft.principle}
                    onChange={(event) =>
                      setManualDraft({
                        ...manualDraft,
                        principle: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  <span>适用条件</span>
                  <textarea
                    maxLength={2_000}
                    value={manualDraft.appliesWhen}
                    onChange={(event) =>
                      setManualDraft({
                        ...manualDraft,
                        appliesWhen: event.currentTarget.value,
                      })
                    }
                  />
                </label>
                <label>
                  <span>注意事项</span>
                  <textarea
                    maxLength={2_000}
                    value={manualDraft.caution}
                    onChange={(event) =>
                      setManualDraft({
                        ...manualDraft,
                        caution: event.currentTarget.value,
                      })
                    }
                  />
                </label>
              </div>
              <p className="methodology-manual-entry-safety">
                系统不会补写事实或调用模型，也不会把人工输入视为已有证据支持；保存后仍需单独审核。
              </p>
              {manualError === null ? null : (
                <p className="error-message" role="alert">
                  暂时无法保存：{manualError}
                </p>
              )}
              {manualDraftStorageError === null ? null : (
                <p className="error-message" role="alert">
                  草稿箱暂不可用：{manualDraftStorageError}
                </p>
              )}
              <footer>
                <button
                  type="button"
                  className="text-button"
                  disabled={manualSaving}
                  onClick={() => {
                    if (
                      Object.values(manualDraft).some(
                        (value) => value.trim().length > 0,
                      )
                    ) {
                      void api
                        .saveManualFormDraft({
                          key: "methodology_manual",
                          input: manualDraft,
                        })
                        .then((saved) => {
                          setManualFormDrafts((current) => [
                            ...current.filter(
                              (draft) => draft.key !== saved.key,
                            ),
                            saved,
                          ]);
                        })
                        .catch(() => undefined);
                    }
                    setManualError(null);
                    setCreationMode("chooser");
                  }}
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
              </footer>
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
        >
          <section className="methodology-import-preview">
            <div
              className="methodology-import-summary"
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
                    setSelectedImportCandidates(
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
                  onClick={() => setSelectedImportCandidates([])}
                >
                  清空
                </button>
              </div>
            </div>

            <ol className="methodology-import-candidates">
              {importPreview.candidates.map((candidate) => {
                const checked = selectedImportCandidates.includes(candidate.id);
                return (
                  <li key={candidate.id} className={checked ? "selected" : ""}>
                    <label>
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
                    <details className="methodology-import-candidate-details">
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
              <details className="methodology-import-issues">
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

            <p className="methodology-import-safety">
              导入后仍是待确认候选，不会自动采纳、调用模型或生成技能与流程。
            </p>
            {importError === null ? null : (
              <p className="error-message" role="alert">
                导入失败：{importError}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="text-button"
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
            </footer>
          </section>
        </ModalDialog>
      )}

      {workbenchOpen ? (
        <ModalDialog
          title="方法论工作箱"
          description="把新增复盘、原则复验和关系核对集中在一个入口，逐项处理才会改变知识事实。"
          size="wide"
          onClose={() => setWorkbenchOpen(false)}
        >
          <section className="methodology-workbench">
            <header>
              <div>
                <strong>待处理事项</strong>
                <span>这里只汇总本地状态，不会自动生成、采纳或修改原则。</span>
              </div>
              <em>
                {suggestions.length +
                  validationItems.length +
                  pendingRelationCount(items)}{" "}
                项
              </em>
            </header>
            <ol>
              <li>
                <button
                  type="button"
                  className="methodology-materials-button"
                  aria-label={`复盘素材 ${suggestions.length}`}
                  disabled={suggestionLoading}
                  onClick={() => {
                    setWorkbenchOpen(false);
                    openSuggestionInbox();
                  }}
                >
                  <span>
                    <strong>复盘素材</strong>
                    <small>把尚未使用的完整复盘整理成可解释证据组合。</small>
                  </span>
                  <em>{suggestionLoading ? "…" : suggestions.length}</em>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="methodology-validation-button"
                  aria-label={`原则复验 ${validationItems.length}`}
                  disabled={validationLoading}
                  onClick={() => {
                    setWorkbenchOpen(false);
                    setValidationActionError(null);
                    setValidationInboxOpen(true);
                  }}
                >
                  <span>
                    <strong>原则复验</strong>
                    <small>核对已采纳原则在新增真实结果中是否仍然适用。</small>
                  </span>
                  <em>{validationLoading ? "…" : validationItems.length}</em>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="methodology-relations-button"
                  aria-label={`关系核对 ${pendingRelationCount(items)}`}
                  disabled={
                    importing || batchGenerating || relationQueueLoading
                  }
                  onClick={() => {
                    setWorkbenchOpen(false);
                    void openRelationQueue();
                  }}
                >
                  <span>
                    <strong>关系核对</strong>
                    <small>集中判断相近或冲突原则，结论仍需逐组确认。</small>
                  </span>
                  <em>
                    {relationQueueLoading ? "…" : pendingRelationCount(items)}
                  </em>
                </button>
              </li>
            </ol>
            <footer>
              <span>三个队列相互独立；关闭工作箱不会确认或忽略任何事项。</span>
              <button
                type="button"
                className="text-button"
                onClick={() => setWorkbenchOpen(false)}
              >
                关闭
              </button>
            </footer>
          </section>
        </ModalDialog>
      ) : null}

      {validationInboxOpen ? (
        <ModalDialog
          title="原则复验"
          description="集中核对已采纳原则在后续真实使用中的新复盘；结论必须由你确认。"
          size="wide"
          dismissible={validationActionId === null}
          onClose={() => setValidationInboxOpen(false)}
        >
          <section className="methodology-validation-inbox">
            <header>
              <div>
                <strong>只处理采用后的新增复盘</strong>
                <span>
                  这里不会把相关性当作因果，也不会自动提高可信度或改写原则。
                </span>
              </div>
              <em>{validationItems.length} 条原则待核对</em>
            </header>

            {validationError === null ? null : (
              <p className="error-message" role="alert">
                原则复验暂时无法更新：{validationError}
              </p>
            )}
            {validationActionError === null ? null : (
              <p className="error-message" role="alert">
                操作未完成：{validationActionError}
              </p>
            )}

            {validationLoading ? (
              <p className="methodology-validation-empty" role="status">
                正在核对采用后的复盘…
              </p>
            ) : validationItems.length === 0 ? (
              <div className="methodology-validation-empty">
                <strong>没有待复验原则</strong>
                <span>
                  后续决策明确关联已采纳原则，并完成结果复盘后，会自动出现在这里。
                </span>
              </div>
            ) : (
              <ol className="methodology-validation-list">
                {validationItems.map((item) => (
                  <li
                    key={item.principleId}
                    className={item.attentionCount > 0 ? "attention" : ""}
                  >
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
                                setValidationInboxOpen(false);
                                onOpenDecision(decision.id);
                              }}
                            >
                              <span>
                                {decision.project} ·{" "}
                                {verdictLabels[decision.verdict]}
                              </span>
                              <strong>{decision.question}</strong>
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
                          {item.revisionDraftId === null ? (
                            <button
                              type="button"
                              className="primary-button"
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

            <footer className="methodology-validation-actions">
              <button
                type="button"
                className="text-button"
                disabled={validationActionId !== null}
                onClick={() => setValidationInboxOpen(false)}
              >
                关闭
              </button>
            </footer>
          </section>
        </ModalDialog>
      ) : null}

      {suggestionInboxOpen ? (
        <ModalDialog
          title="复盘素材"
          description="把已完成的结果复盘整理成可审核的证据组合；浏览和搁置都不会调用模型。"
          size="wide"
          dismissible={suggestionActionId === null && !batchGenerating}
          onClose={() => setSuggestionInboxOpen(false)}
        >
          <section className="methodology-material-inbox">
            <header>
              <div
                className="methodology-material-modes"
                role="group"
                aria-label="复盘素材状态"
              >
                <button
                  type="button"
                  aria-pressed={suggestionInboxMode === "active"}
                  onClick={() => setSuggestionInboxMode("active")}
                >
                  可提炼 <strong>{suggestions.length}</strong>
                </button>
                <button
                  type="button"
                  aria-pressed={suggestionInboxMode === "deferred"}
                  onClick={() => setSuggestionInboxMode("deferred")}
                >
                  已搁置 <strong>{deferredSuggestions.length}</strong>
                </button>
              </div>
              {suggestionInboxMode === "active" && suggestions.length > 1 ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={batchGenerating || suggestionActionId !== null}
                  onClick={() => {
                    setSuggestionInboxOpen(false);
                    setConfirmingBatch(true);
                  }}
                >
                  批量提炼 {suggestions.length} 组
                </button>
              ) : null}
            </header>

            {suggestionError === null ? null : (
              <p className="error-message" role="alert">
                复盘素材暂时无法更新：{suggestionError}
              </p>
            )}
            {suggestionActionError === null ? null : (
              <p className="error-message" role="alert">
                操作未完成：{suggestionActionError}
              </p>
            )}
            {suggestionLoading ? (
              <p className="methodology-material-empty" role="status">
                正在整理完整复盘…
              </p>
            ) : visibleSuggestionInboxItems.length === 0 ? (
              <div className="methodology-material-empty">
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
                            <strong>{source.question}</strong>
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
                              className="primary-button"
                              disabled={suggestionActionId !== null}
                              onClick={() => {
                                setSuggestionInboxOpen(false);
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

            <footer className="methodology-material-boundary">
              <span>本地整理</span>
              <span>不会自动生成原则</span>
              <span>不会自动采纳或发布</span>
            </footer>
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
            sourceRequestSequence.current += 1;
            setChoosingSources(false);
            setLinkingEvidence(false);
            setSourceQuery("");
          }}
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
                      setChoosingSources(false);
                      setConfirmingBatch(true);
                    }}
                  >
                    批量生成 {suggestions.length} 条
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
                          setSelectedSources(suggestion.sourceDecisionIds)
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
                    <span>只依据原则与复盘中的可解释文本重合</span>
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
                              <strong>{decision.question}</strong>
                              <em className={match.strength}>
                                {match.alreadyLinked
                                  ? "已关联"
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
                <span>搜索复盘证据</span>
                <input
                  type="search"
                  value={sourceQuery}
                  placeholder="搜索问题、选择、项目或复盘经验"
                  onChange={(event) => setSourceQuery(event.target.value)}
                />
              </label>
            )}
            {sourceLoading ? (
              <p className="methodology-message">正在读取已复盘决策…</p>
            ) : reviewedDecisions.length === 0 ? (
              <div className="methodology-empty compact">
                <strong>还没有可用证据</strong>
                <span>先在决策库记录实际结果并完成复盘。</span>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    sourceRequestSequence.current += 1;
                    setChoosingSources(false);
                    void api.openSurface("decisions");
                  }}
                >
                  去复盘决策
                </button>
              </div>
            ) : visibleReviewedDecisions.length === 0 ? (
              <div className="methodology-empty compact">
                <strong>没有匹配的复盘</strong>
                <span>换个关键词，或清空搜索查看全部证据。</span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSourceQuery("")}
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
                          <strong>{decision.question}</strong>
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
              <p className="error-message" role="alert">
                {linkingEvidence ? "暂时无法保存关联" : "暂时无法提炼"}：
                {generationError}
              </p>
            )}
            <footer className="methodology-source-actions">
              <span>
                已选 {selectedSources.length} / 5
                {suggestionLoading ? " · 正在整理建议" : ""}
              </span>
              <div>
                <button
                  type="button"
                  className="text-button"
                  disabled={generating}
                  onClick={() => {
                    setChoosingSources(false);
                    setLinkingEvidence(false);
                    setSourceQuery("");
                  }}
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
              </div>
            </footer>
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
        >
          <section className="methodology-manual-evidence-entry">
            <header>
              <div>
                <strong>证据已经确定，内容完全由你填写</strong>
                <span>
                  不调用模型，也不会根据复盘正文自动补写原则或因果结论。
                </span>
              </div>
              <em>0 次模型调用</em>
            </header>

            <div
              className={`manual-form-draft-status${
                manualEvidenceRestoredAt === null ? "" : " restored"
              }`}
              role="status"
            >
              <span>
                <strong>
                  {manualEvidenceRestoredAt === null
                    ? "人工整理内容会自动保存"
                    : "已恢复未完成的人工整理"}
                </strong>
                <small>
                  {manualEvidenceRestoredAt === null
                    ? "证据选择和输入只保存在这台 Mac 的 App 私有目录。"
                    : `${dateFormatter.format(new Date(manualEvidenceRestoredAt))} 保存，尚未建立方法论候选。`}
                </small>
              </span>
              <div>
                <em>
                  {manualEvidenceDraftSaveState === "saving"
                    ? "正在保存…"
                    : manualEvidenceDraftSaveState === "saved"
                      ? "已自动保存"
                      : manualEvidenceDraftSaveState === "error"
                        ? "自动保存失败"
                        : "本机草稿"}
                </em>
                {manualEvidenceRestoredAt === null ? null : (
                  <button
                    type="button"
                    className="text-button"
                    disabled={manualEvidenceSaving}
                    onClick={() => void discardManualEvidenceMethodologyDraft()}
                  >
                    {manualEvidencePendingSources === null
                      ? "丢弃并重写"
                      : `丢弃并使用刚选的 ${manualEvidencePendingSources.length} 条证据`}
                  </button>
                )}
              </div>
            </div>

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
                  <strong>{decision.question}</strong>
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

            <div className="methodology-editor methodology-manual-evidence-form">
              <label className="title-field">
                <span>候选标题</span>
                <input
                  autoFocus
                  value={manualEvidenceDraft.title}
                  placeholder="例如：先验证，再扩大不可逆投入"
                  maxLength={120}
                  onChange={(event) =>
                    updateManualEvidenceDraft({ title: event.target.value })
                  }
                />
              </label>
              <label className="principle-field">
                <span>原则</span>
                <textarea
                  value={manualEvidenceDraft.principle}
                  placeholder="以后遇到类似决策时，应该如何判断或行动？"
                  maxLength={2_000}
                  onChange={(event) =>
                    updateManualEvidenceDraft({
                      principle: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>适用条件</span>
                <textarea
                  value={manualEvidenceDraft.appliesWhen}
                  placeholder="什么场景和前提下适用？"
                  maxLength={2_000}
                  onChange={(event) =>
                    updateManualEvidenceDraft({
                      appliesWhen: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>注意事项</span>
                <textarea
                  value={manualEvidenceDraft.caution}
                  placeholder="什么情况下不应套用，或需要重新验证？"
                  maxLength={2_000}
                  onChange={(event) =>
                    updateManualEvidenceDraft({ caution: event.target.value })
                  }
                />
              </label>
              <label className="evidence-field">
                <span>证据摘要</span>
                <textarea
                  value={manualEvidenceDraft.evidenceSummary}
                  placeholder="区分已观察到的结果与有限归纳，并用“证据 1”等编号对应上方复盘。"
                  maxLength={3_000}
                  onChange={(event) =>
                    updateManualEvidenceDraft({
                      evidenceSummary: event.target.value,
                    })
                  }
                />
              </label>
            </div>

            <div className="methodology-manual-evidence-boundary">
              <span>证据关系由你确认</span>
              <span>可信度仍由复盘数量与一致性计算</span>
              <span>保存后只进入待确认列表</span>
            </div>

            {manualEvidenceError === null ? null : (
              <p className="error-message" role="alert">
                暂时无法保存：{manualEvidenceError}
              </p>
            )}
            {manualDraftStorageError === null ? null : (
              <p className="error-message" role="alert">
                草稿箱暂不可用：{manualDraftStorageError}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="text-button"
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
            </footer>
          </section>
        </ModalDialog>
      )}

      {confirmingBatch ? (
        <ModalDialog
          title="批量提炼方法论"
          description={`${suggestions.length} 组复盘建议将依次生成候选。`}
          size="compact"
          dismissible={!batchGenerating}
          onClose={() => setConfirmingBatch(false)}
        >
          <section className="methodology-batch-confirmation">
            <div className="methodology-batch-route" aria-label="批量提炼流程">
              <span>
                <strong>{suggestions.length}</strong>
                <small>证据组合</small>
              </span>
              <b aria-hidden="true">→</b>
              <span>
                <strong>{suggestions.length}</strong>
                <small>待确认候选</small>
              </span>
            </div>
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
                {suggestions.slice(0, 3).map((suggestion) => (
                  <li key={suggestion.id}>{suggestion.title}</li>
                ))}
                {suggestions.length > 3 ? (
                  <li>以及另外 {suggestions.length - 3} 组</li>
                ) : null}
              </ol>
            )}
            <footer>
              <button
                type="button"
                className="text-button"
                disabled={batchGenerating}
                onClick={() => setConfirmingBatch(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={batchGenerating || suggestions.length === 0}
                onClick={() => void generateSuggestionBatch()}
              >
                {batchGenerating
                  ? "正在生成…"
                  : `生成 ${suggestions.length} 条候选`}
              </button>
            </footer>
          </section>
        </ModalDialog>
      ) : null}

      {currentRelationQueueItem === null ? null : (
        <ModalDialog
          title="批量核对原则关系"
          description={`第 ${relationQueueCompleted + 1} 组，共 ${relationQueueTotal} 组`}
          size="wide"
          dismissible={!relationQueueSaving}
          onClose={closeRelationQueue}
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
                    relationQueueDisposition === value ? "selected" : ""
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

            <label className="methodology-relation-queue-note">
              <span>判断依据（可选）</span>
              <textarea
                aria-label="批量核对说明（可选）"
                maxLength={500}
                value={relationQueueNote}
                disabled={relationQueueSaving}
                placeholder="简要记录边界差异，之后仍可在原则详情中修改"
                onChange={(event) =>
                  setRelationQueueNote(event.currentTarget.value)
                }
              />
              <small>{relationQueueNote.length} / 500</small>
            </label>

            <div className="methodology-relation-queue-safety">
              <span>只记录关系结论</span>
              <p>不会自动合并、删除或改写任何原则。</p>
            </div>

            {relationQueueError === null ? null : (
              <p className="error-message" role="alert">
                保存失败：{relationQueueError}
              </p>
            )}

            <footer>
              <button
                type="button"
                className="text-button"
                disabled={relationQueueSaving}
                onClick={postponeRelationQueueItem}
              >
                {relationQueue?.length === 1 ? "稍后处理" : "跳过这一组"}
              </button>
              <div>
                <span>还剩 {relationQueue?.length ?? 0} 组</span>
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
              </div>
            </footer>
          </section>
        </ModalDialog>
      )}

      {selected !== null && reviewingRelation !== null ? (
        <ModalDialog
          title="核对原则关系"
          description={`“${selected.title}” 与 “${reviewingRelation.title}”`}
          size="compact"
          dismissible={!relationSaving}
          onClose={() => {
            setReviewingRelation(null);
            setRelationDisposition(null);
            setRelationNote("");
            setRelationError(null);
          }}
        >
          <section className="methodology-relation-editor">
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
                  className={relationDisposition === value ? "selected" : ""}
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
            <label className="methodology-relation-note">
              <span>核对说明（可选）</span>
              <textarea
                aria-label="核对说明（可选）"
                maxLength={500}
                value={relationNote}
                disabled={relationSaving}
                placeholder="记录为什么作出这个判断，便于以后重新核对"
                onChange={(event) => setRelationNote(event.currentTarget.value)}
              />
              <small>{relationNote.length} / 500</small>
            </label>
            <p className="methodology-relation-safety-copy">
              这里只记录人工结论，不会合并、删除或改写任何原则。
            </p>
            {relationError === null ? null : (
              <p className="error-message" role="alert">
                保存失败：{relationError}
              </p>
            )}
            <footer>
              <div>
                {reviewingRelation.resolution === null ||
                reviewingRelation.resolution === undefined ? null : (
                  <button
                    type="button"
                    className="text-button danger-button"
                    disabled={relationSaving}
                    onClick={() => void clearRelationReview()}
                  >
                    撤销结论
                  </button>
                )}
              </div>
              <div>
                <button
                  type="button"
                  className="text-button"
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
              </div>
            </footer>
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
        >
          <section className="methodology-merge-editor">
            <header className="methodology-merge-source-heading">
              <div>
                <strong>合并来源</strong>
                <span>每一对都必须已经人工确认重复</span>
              </div>
              <div className="methodology-merge-source-meta">
                <small
                  className={
                    mergeDraftSaveState === "error" ? "error" : undefined
                  }
                  role="status"
                >
                  {mergeDraftRestoredAt === null ? null : "已恢复 · "}
                  {mergeDraftSaveLabel}
                </small>
                <em>{mergeDraft.sources.length} / 5</em>
              </div>
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
                    <button
                      type="button"
                      aria-label={`移除来源 ${item.title}`}
                      disabled={mergeSaving || mergeRelationReview !== null}
                      onClick={() => toggleMergeSource(item.id)}
                    >
                      ×
                    </button>
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
                                待核对{assessment.missingSources.length} 对
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
                <label className="methodology-merge-relation-note">
                  <span>核对说明（可选）</span>
                  <textarea
                    aria-label="合并关系核对说明（可选）"
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
                </label>
                {mergeRelationError === null ? null : (
                  <p className="error-message" role="alert">
                    保存失败：{mergeRelationError}
                  </p>
                )}
                <footer>
                  <button
                    type="button"
                    className="text-button"
                    disabled={mergeRelationSaving}
                    onClick={() => void saveMergeRelationReview("unrelated")}
                  >
                    确认无关
                  </button>
                  <button
                    type="button"
                    className="text-button"
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
              <p className="methodology-merge-relation-outcome" role="status">
                {mergeRelationOutcome}
              </p>
            )}

            {mergeRelationReview !== null ? null : (
              <>
                <div
                  className={`methodology-merge-guidance${
                    mergeDraftRecoveryMessage === null ? "" : " recovered"
                  }`}
                  role="note"
                >
                  <strong>
                    {mergeDraftRecoveryMessage === null
                      ? "先以来源 1 预填"
                      : "已重新校验"}
                  </strong>
                  <span>
                    {mergeDraftRecoveryMessage ??
                      "请统一表达、适用边界与注意事项；这里不会调用模型。"}
                  </span>
                </div>

                <div className="methodology-merge-workspace">
                  <div className="methodology-merge-fields">
                    <label className="methodology-merge-title-field">
                      <span>新标题</span>
                      <input
                        autoFocus
                        aria-label="新标题"
                        maxLength={120}
                        value={mergeDraft.input.title}
                        disabled={mergeSaving}
                        onChange={(event) =>
                          updateMergeField("title", event.currentTarget.value)
                        }
                      />
                      <small>{mergeDraft.input.title.length} / 120</small>
                    </label>
                    <label className="methodology-merge-wide-field">
                      <span>统一后的原则</span>
                      <textarea
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
                    </label>
                    <label>
                      <span>适用条件</span>
                      <textarea
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
                    </label>
                    <label>
                      <span>注意事项</span>
                      <textarea
                        maxLength={2_000}
                        value={mergeDraft.input.caution}
                        disabled={mergeSaving}
                        onChange={(event) =>
                          updateMergeField("caution", event.currentTarget.value)
                        }
                      />
                    </label>
                    <label className="methodology-merge-wide-field">
                      <span>证据摘要</span>
                      <textarea
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
                    </label>
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
                              className={checked ? "selected" : ""}
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
                                <strong>{decision.question}</strong>
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

                    <div className="methodology-merge-safety">
                      <strong>可回退</strong>
                      <p>
                        只新增一条待确认草案。来源原则、关系结论和已有技能与流程都不会被删除、替换或重新指向。
                      </p>
                    </div>
                  </aside>
                </div>

                {mergeError === null ? null : (
                  <p className="error-message" role="alert">
                    创建失败：{mergeError}
                  </p>
                )}

                <footer className="methodology-merge-actions">
                  <button
                    type="button"
                    className="text-button methodology-merge-discard-button"
                    disabled={
                      mergeSaving || mergeRelationSaving || mergeDraftClosing
                    }
                    onClick={() => void discardMergeFormDraft()}
                  >
                    丢弃草稿
                  </button>
                  <div>
                    <button
                      type="button"
                      className="text-button"
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
                  </div>
                </footer>
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
        >
          <section className="methodology-merge-lifecycle">
            {mergeLifecycleLoading ? (
              <div
                className="methodology-merge-lifecycle-loading"
                role="status"
              >
                正在核对来源原则与技能、流程引用…
              </div>
            ) : mergeLifecyclePlan === null ? (
              <div className="methodology-merge-lifecycle-empty">
                <strong>暂时无法读取整理范围</strong>
                <span>不会更改任何原则或实践资产。</span>
              </div>
            ) : (
              <>
                <div
                  className="methodology-merge-lifecycle-steps"
                  aria-label="来源整理进度"
                >
                  <span
                    className={
                      mergeLifecyclePlan.assets.length > 0 ? "current" : "done"
                    }
                  >
                    <b>1</b>
                    <small>迁移引用</small>
                  </span>
                  <i aria-hidden="true" />
                  <span
                    className={
                      mergeLifecyclePlan.pendingReviewCount > 0
                        ? "current"
                        : mergeLifecyclePlan.assets.length === 0
                          ? "done"
                          : ""
                    }
                  >
                    <b>2</b>
                    <small>审核草案</small>
                  </span>
                  <i aria-hidden="true" />
                  <span
                    className={
                      mergeLifecyclePlan.retired
                        ? "done"
                        : mergeLifecyclePlan.canRetire
                          ? "current"
                          : ""
                    }
                  >
                    <b>3</b>
                    <small>归档来源</small>
                  </span>
                </div>

                <section className="methodology-merge-lifecycle-sources">
                  <header>
                    <div>
                      <span>合并后的原则</span>
                      <strong>{mergeLifecyclePlan.mergeTitle}</strong>
                    </div>
                    <em>{statusLabels[mergeLifecyclePlan.mergeStatus]}</em>
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
                          {mergeLifecyclePlan.assets.length} 项 ·
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
                              {asset.kind === "skill" ? "技能" : "流程"} ·
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
                          {asset.replacementId === null ? (
                            <button
                              type="button"
                              className="primary-button"
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
                                setSelected(null);
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
                      <span>合并原则与已审核的实践资产保持不变。</span>
                    </div>
                    <button
                      type="button"
                      className="text-button"
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
                    <span>来源原则状态已经变化，请关闭后重新核对。</span>
                  </div>
                )}
              </>
            )}

            {mergeLifecycleError === null ? null : (
              <p className="error-message" role="alert">
                操作失败：{mergeLifecycleError}
              </p>
            )}

            <footer className="methodology-merge-lifecycle-actions">
              <button
                type="button"
                className="text-button"
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
            </footer>
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
              <div className="methodology-revision-rebase-empty">
                <strong>正文没有字段冲突</strong>
                <span>仅来源版本或证据集合变化，可以直接迁移后继续核对。</span>
              </div>
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
                        className={
                          row.choice === "current" ? "selected" : undefined
                        }
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
                        className={
                          row.choice === "draft" ? "selected" : undefined
                        }
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

            <div className="methodology-revision-rebase-evidence">
              <strong>证据按当前事实重新校验</strong>
              <span>
                保留 {evolutionRebase.sourceDecisionIds.length} 条可用选择
                {evolutionRebase.removedEvidenceCount === 0
                  ? "，没有失效证据。"
                  : `，移除 ${evolutionRebase.removedEvidenceCount} 条失效证据。`}
              </span>
            </div>

            {evolutionRebaseError === null ? null : (
              <p className="error-message" role="alert">
                迁移失败：{evolutionRebaseError}
              </p>
            )}

            <footer className="methodology-revision-rebase-actions">
              <button
                type="button"
                className="text-button danger"
                disabled={evolutionRebaseSaving}
                onClick={() => void discardEvolutionFormDraft()}
              >
                丢弃草稿
              </button>
              <div>
                <button
                  type="button"
                  className="text-button"
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
                    evolutionRebaseSaving ||
                    evolutionRebaseUnresolvedCount > 0
                  }
                  onClick={() => void applyEvolutionRebase()}
                >
                  {evolutionRebaseSaving ? "正在迁移…" : "迁移并继续编辑"}
                </button>
              </div>
            </footer>
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
            !evolutionSaving &&
            !evolutionDraftClosing &&
            !restoringVersion
          }
          onClose={() => {
            if (evolving && evolutionDraft !== null) {
              void preserveEvolutionFormDraft(true);
              return;
            }
            setSelected(null);
            setEditing(false);
            clearEvolutionEditor();
            setConfirmingAcceptance(false);
          }}
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
                    <small
                      className={
                        evolutionDraftSaveState === "error"
                          ? "error"
                          : undefined
                      }
                      role="status"
                    >
                      {evolutionDraftRestoredAt === null ? null : "已恢复 · "}
                      {evolutionDraftSaveLabel}
                    </small>
                  </aside>
                </header>
                <div className="methodology-evolution-form">
                  <label className="full-width">
                    <span>修订标题</span>
                    <input
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
                  </label>
                  <label className="full-width">
                    <span>修订后的原则</span>
                    <textarea
                      maxLength={2_000}
                      value={evolutionDraft.principle}
                      onChange={(event) =>
                        setEvolutionDraft({
                          ...evolutionDraft,
                          principle: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>适用条件</span>
                    <textarea
                      maxLength={2_000}
                      value={evolutionDraft.appliesWhen}
                      onChange={(event) =>
                        setEvolutionDraft({
                          ...evolutionDraft,
                          appliesWhen: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>注意事项</span>
                    <textarea
                      maxLength={2_000}
                      value={evolutionDraft.caution}
                      onChange={(event) =>
                        setEvolutionDraft({
                          ...evolutionDraft,
                          caution: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label className="full-width">
                    <span>证据摘要</span>
                    <textarea
                      maxLength={3_000}
                      value={evolutionDraft.evidenceSummary}
                      onChange={(event) =>
                        setEvolutionDraft({
                          ...evolutionDraft,
                          evidenceSummary: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                </div>
                <section
                  className="methodology-evolution-evidence"
                  aria-label="修订证据"
                >
                  <header>
                    <div>
                      <span>修订证据</span>
                      <strong>
                        已选 {evolutionDraft.sourceDecisionIds.length} / 5 条
                      </strong>
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
                        <strong>{decision.question}</strong>
                        <small>
                          {decision.project} ·{" "}
                          {decision.lesson ?? decision.outcome}
                        </small>
                      </button>
                    ))}
                  </div>
                </section>
                <div
                  className={`methodology-evolution-boundary${
                    evolutionDraftRecoveryMessage === null ? "" : " recovered"
                  }`}
                >
                  <span>
                    {evolutionDraftRecoveryMessage ??
                      "应用草案时会先保存当前版本"}
                  </span>
                  <span>原则编号与历史决策关联保持不变</span>
                  <span>引用它的技能与流程会提示来源已更新</span>
                </div>
                {evolutionError === null ? null : (
                  <p className="error-message" role="alert">
                    建立修订失败：{evolutionError}
                  </p>
                )}
                <footer className="methodology-detail-actions">
                  <button
                    type="button"
                    className="text-button methodology-evolution-discard"
                    disabled={evolutionSaving || evolutionDraftClosing}
                    onClick={() => void discardEvolutionFormDraft()}
                  >
                    丢弃草稿
                  </button>
                  <div>
                    <button
                      type="button"
                      className="text-button"
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
                  </div>
                </footer>
              </div>
            ) : editing && revision !== null ? (
              <div className="methodology-editor">
                <label>
                  <span>标题</span>
                  <input
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
                </label>
                {(
                  [
                    ["principle", "原则", 2_000],
                    ["appliesWhen", "适用条件", 2_000],
                    ["caution", "注意事项", 2_000],
                    ["evidenceSummary", "证据摘要", 3_000],
                  ] as const
                ).map(([field, label, maxLength]) => (
                  <label key={field}>
                    <span>{label}</span>
                    <textarea
                      maxLength={maxLength}
                      value={revision[field]}
                      onChange={(event) =>
                        setRevision({
                          ...revision,
                          [field]: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                ))}
                <div className="methodology-detail-actions">
                  <button
                    type="button"
                    className="text-button"
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
                </div>
              </div>
            ) : (
              <>
                <header className="methodology-detail-header">
                  <div>
                    <span className={`methodology-status ${selected.status}`}>
                      {statusLabels[selected.status]}
                    </span>
                    <span
                      className={`methodology-confidence ${selected.quality.recommendedConfidence}`}
                    >
                      {confidenceLabelFor(selected)}
                    </span>
                  </div>
                  <h3>{selected.title}</h3>
                  <p>{selected.principle}</p>
                </header>
                {selected.origin === "principle_merge" ? (
                  <section className="methodology-merge-provenance">
                    <div>
                      <span>合并来源</span>
                      <strong>原原则保持独立，不会被这条草案覆盖</strong>
                    </div>
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
                      <p>部分来源原则已不可用，采纳前需要重新核对。</p>
                    )}
                    {selected.status === "accepted" ? (
                      <footer className="methodology-merge-lifecycle-entry">
                        <span>
                          合并原则已采纳；可逐项迁移引用，再归档两条旧来源。
                        </span>
                        <button
                          type="button"
                          className="text-button"
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
                        <span>修订来源</span>
                        <strong>
                          {selected.sourcePrinciples?.[0]?.title ??
                            "原原则暂不可用"}
                        </strong>
                      </div>
                      <em>原原则仍保持已采纳</em>
                    </header>
                    {selected.sourcePrinciples?.[0] === undefined ? (
                      <p>原原则已不存在，不能应用这条修订草案。</p>
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
                      应用前不会改变原原则、历史决策或下游实践资产；应用时会先建立恢复点。
                    </footer>
                  </section>
                ) : null}
                <div className="methodology-detail-grid">
                  <section>
                    <span>适用条件</span>
                    <p>{selected.appliesWhen}</p>
                  </section>
                  <section>
                    <span>注意事项</span>
                    <p>{selected.caution}</p>
                  </section>
                </div>
                {selectedIsUnverifiedExternal ? null : (
                  <section>
                    <span>证据摘要</span>
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
                        <span>实际采用</span>
                        <strong>采用后的复盘分布</strong>
                      </div>
                      <em>{usage?.linkedDecisionCount ?? 0} 次</em>
                    </div>
                    {usageLoading ? (
                      <p>正在统计采用记录…</p>
                    ) : usageError !== null ? (
                      <p className="error-message">
                        采用记录暂时无法读取：{usageError}
                      </p>
                    ) : usage === null || usage.linkedDecisionCount === 0 ? (
                      <div className="methodology-usage-empty">
                        <p>还没有历史决策明确记录采用了这条原则。</p>
                        {selected.status === "accepted" ? (
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => void api.openSurface("decisions")}
                          >
                            去决策库关联
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <div className="methodology-usage-metrics">
                          <div>
                            <strong>{usage.linkedDecisionCount}</strong>
                            <span>明确采用</span>
                          </div>
                          <div>
                            <strong>{usage.reviewedCount}</strong>
                            <span>已完成复盘</span>
                          </div>
                          <div className="favorable">
                            <strong>{usage.favorableCount}</strong>
                            <span>符合或优于预期</span>
                          </div>
                          <div className="attention">
                            <strong>
                              {usage.mixedCount + usage.attentionCount}
                            </strong>
                            <span>部分符合或低于预期</span>
                          </div>
                        </div>
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
                              className="primary-button"
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
                        <details className="methodology-usage-decisions">
                          <summary>
                            {usage.decisions.length < usage.linkedDecisionCount
                              ? `查看最近 ${usage.decisions.length} / ${usage.linkedDecisionCount} 条采用记录`
                              : `查看 ${usage.decisions.length} 条采用记录`}
                          </summary>
                          <div className="methodology-usage-controls">
                            <div
                              className="methodology-usage-filters"
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
                              <label>
                                <span>项目</span>
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
                              </label>
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
                                      <strong>{decision.question}</strong>
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
                  <details className="practice-version-history methodology-version-history">
                    <summary>
                      <span>原则版本</span>
                      <small>
                        {versionsLoading
                          ? "读取中…"
                          : `${versions.length} 个恢复点`}
                      </small>
                    </summary>
                    <div className="practice-version-history-body">
                      {historyError === null ? null : (
                        <p className="error-message" role="alert">
                          版本历史暂时无法读取：{historyError}
                        </p>
                      )}
                      {!versionsLoading &&
                      historyError === null &&
                      versions.length === 0 ? (
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
                                      className="text-button"
                                      disabled={restoringVersion}
                                      onClick={() =>
                                        setPendingRestoreVersion(null)
                                      }
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="primary-button"
                                      disabled={restoringVersion}
                                      onClick={() =>
                                        void restoreMethodologyVersion(
                                          selectedHistoryVersion.version,
                                        )
                                      }
                                    >
                                      {restoringVersion
                                        ? "正在恢复…"
                                        : "确认恢复"}
                                    </button>
                                  </div>
                                </div>
                              ) : null}
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
                    <span>质量检查</span>
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
                    <div className="methodology-quality-metrics">
                      <div>
                        <strong>{selected.quality.evidenceCount}</strong>
                        <span>有效证据</span>
                      </div>
                      <div>
                        <strong>{selected.quality.projectCount}</strong>
                        <span>覆盖项目</span>
                      </div>
                      <div>
                        <strong>{selected.quality.sourceCount}</strong>
                        <span>证据来源</span>
                      </div>
                      <div>
                        <strong>
                          {selected.quality.favorableEvidenceCount} /{" "}
                          {selected.quality.attentionEvidenceCount} /{" "}
                          {selected.quality.unclearEvidenceCount}
                        </strong>
                        <span>正向 / 注意 / 不明</span>
                      </div>
                    </div>
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
                      <span>导入来源</span>
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
                {selectedIsUnverifiedExternal ? (
                  <section className="methodology-import-evidence-note">
                    <span>来源与依据</span>
                    <strong>{selected.evidenceSummary}</strong>
                    <p>
                      {selected.origin === "manual_entry"
                        ? "这条候选由你人工录入，当前还不是经过结果复盘验证的原则。可以先核对表达与边界，或关联真实复盘证据。"
                        : "这条候选来自本地 Markdown，不等同于经过 Decision 复盘验证的原则。可以先编辑适用条件与边界，再明确采纳为待验证假设。"}
                    </p>
                    <div className="methodology-evidence-link-actions">
                      <button
                        type="button"
                        className="text-button"
                        disabled={saving}
                        onClick={() =>
                          openSourceChooser(selected.sourceDecisionIds, "link")
                        }
                      >
                        关联复盘证据
                      </button>
                    </div>
                  </section>
                ) : (
                  <>
                    <details className="methodology-evidence-section">
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
                              证据 {index + 1} · {decision.question}
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
                    <span>采纳确认</span>
                    <p>
                      {selectedIsUnverifiedExternal
                        ? selected.origin === "manual_entry"
                          ? "这条候选由你人工录入，当前没有经过复盘的决策证据。采纳后仍保持低可信；请确认它只是待验证假设，且适用条件与注意事项边界清楚。"
                          : "这条候选来自 Markdown，当前没有经过复盘的决策证据。采纳后仍保持低可信；请确认已经核对原则、适用条件与注意事项。"
                        : selected.origin === "principle_merge"
                          ? "这条候选由两条已确认重复的原则人工整理而成。采纳只会新增这条原则，两个来源及其已有技能与流程仍保持原状；请确认统一后的表达与边界准确。"
                          : selected.origin === "principle_revision"
                            ? "这条草案会应用到原原则并保留原编号。当前版本会先保存为恢复点；历史决策关联保持不变，引用该原则的技能与流程会提示来源已更新，但不会自动改写或发布。"
                            : `质量检查发现 ${selectedRiskRelations.length} 条仍需关注的关联。采纳不会自动合并或覆盖其它原则，请确认已经检查适用条件和差异。`}
                    </p>
                    <div className="methodology-detail-actions">
                      <button
                        type="button"
                        className="text-button"
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
                    </div>
                  </section>
                ) : null}
                {confirmingAcceptance ? null : (
                  <footer className="methodology-detail-footer">
                    <small>
                      {selected.generation.provider} ·{" "}
                      {selected.generation.model}
                    </small>
                    {selected.status === "candidate" ? (
                      <div className="methodology-detail-actions">
                        <button
                          type="button"
                          className="text-button danger-button"
                          disabled={saving}
                          onClick={() => void setRecordStatus("dismissed")}
                        >
                          忽略
                        </button>
                        <button
                          type="button"
                          className="text-button"
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
                      </div>
                    ) : null}
                  </footer>
                )}
              </>
            )}
            {detailError === null ? null : (
              <p className="error-message" role="alert">
                操作失败：{detailError}
              </p>
            )}
          </article>
        </ModalDialog>
      )}
    </section>
  );
};
