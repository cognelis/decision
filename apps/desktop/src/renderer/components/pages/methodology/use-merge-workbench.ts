import type {
  MethodologyRelationDisposition,
  MethodologyStatus,
} from "@cognelis/decision-core";

import type {
  ManualFormDraft,
  MethodologyItem,
  MethodologyMergeLifecyclePlan,
  MethodologyRecordsApi,
  MethodologyRevisionInput,
} from "../../../../shared/renderer-api.js";
import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

import {
  mergeEvidence,
  mergeEvidenceSummary,
  sameIdSet,
  updateMergeSources,
  type MethodologyMergeDraftState,
} from "./methodology-merge-model.js";
import {
  allPairsConfirmedDuplicate,
  confirmedDuplicate,
  type MethodologyMergeCandidateAssessment,
} from "./methodology-relation-model.js";
import type {
  MethodologyNotice,
  MethodologyView,
  StatusFilter,
  MethodologyWorkspaceHost,
  ManualDraftStore,
} from "./methodology-view-types.js";

/**
 * The merge workbench, lifted out of MethodologyPanel.
 *
 * It was eighteen pieces of state, one ref, an autosave effect and seventeen
 * functions sitting inside a 7000-line component that held 121 useState calls
 * in one scope — a scope in which no reader could tell which state any change
 * touched. Moving it changes no behaviour: every name is returned unchanged so
 * the panel destructures them exactly as it declared them.
 *
 * Six options, none of them a raw setter: the page is reached through
 * `host` and `draftStore`, which say what may be asked of it rather than
 * handing over permission to set any state to anything.
 */

/** The stored draft entry this workbench autosaves into. */
export type MethodologyMergeFormDraft = Extract<
  ManualFormDraft,
  { key: "methodology_merge" }
>;

interface MethodologyMergeRelationReviewState {
  candidateId: string;
  pendingSourceIds: string[];
  totalPairCount: number;
  note: string;
}

export interface MergeWorkbenchOptions {
  api: MethodologyRecordsApi;
  host: MethodologyWorkspaceHost;
  draftStore: ManualDraftStore;
  selected: MethodologyItem | null;
  status: StatusFilter;
  storedMergeDraft: MethodologyMergeFormDraft | undefined;
}

export const useMergeWorkbench = ({
  api,
  host,
  draftStore,
  selected,
  status,
  storedMergeDraft,
}: MergeWorkbenchOptions) => {
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
          draftStore.remember(saved);
          setMergeDraftRestoredAt(saved.updatedAt);
          setMergeDraftSaveState("saved");
          draftStore.failed(null);
        })
        .catch((caught: unknown) => {
          if (mergeDraftSaveEpoch.current !== epoch) return;
          setMergeDraftSaveState("error");
          draftStore.failed(
            caught instanceof Error ? caught.message : String(caught),
          );
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [api, mergeDraft]);

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
    draftStore.failed(null);
    try {
      await api.deleteManualFormDraft("methodology_merge");
      draftStore.forget("methodology_merge");
      clearMergeEditor();
      host.notify(null);
    } catch (caught) {
      setMergeDraftSaveState("error");
      const message = caught instanceof Error ? caught.message : String(caught);
      draftStore.failed(message);
      if (mergeDraft === null) {
        host.notify({
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
      draftStore.remember(saved);
      setMergeDraftSaveState("saved");
      draftStore.failed(null);
      clearMergeEditor();
      host.showView("records");
    } catch (caught) {
      if (mergeDraftSaveEpoch.current !== epoch) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setMergeDraftSaveState("error");
      draftStore.failed(message);
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
    host.notify(null);
    host.showView("records");
    const current = host.opening();
    try {
      const records = await api.listMethodologies();
      // Read once the reader had opened a principle themselves: the draft does not close it to open over it.
      if (!current()) return;
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
      host.showRecord(null);
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
      host.notify({
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
        host.showView("records");
        host.notify({
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
    host.notify(null);
    const current = host.opening();
    try {
      const records = await api.listMethodologies();
      if (!current()) return;
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
      host.showRecord(null);
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
      host.notify({
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
        host.refreshRecords();
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
        host.refreshRecords();
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
      host.refreshRecords();
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
        draftStore.forget("methodology_merge");
      } catch (caught) {
        host.notify({
          tone: "warning",
          text: `合并候选已创建，但本机草稿未能清除：${caught instanceof Error ? caught.message : String(caught)}`,
          action: "discard_merge_draft",
        });
      }
      clearMergeEditor();
      host.openRecord(created, { status: "candidate" });
      host.refreshRecords();
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
      if (refreshed !== undefined) host.showRecord(refreshed);
      host.refreshRecords();
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
      if (refreshed !== undefined) host.showRecord(refreshed);
      host.refreshRecords();
    } catch (caught) {
      setMergeLifecycleError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setMergeLifecycleSaving(false);
    }
  };

  return {
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
  };
};
