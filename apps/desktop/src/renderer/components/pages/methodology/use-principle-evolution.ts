import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";

import type {
  ManualFormDraft,
  MethodologyEvolutionInput,
  MethodologyItem,
  MethodologyRecordsApi,
  MethodologyRevisionInput,
  MethodologyUsageDecision,
  MethodologyUsageSnapshot,
} from "../../../../shared/renderer-api.js";
import type {
  MethodologyNotice,
  MethodologyView,
  StatusFilter,
  MethodologyWorkspaceHost,
  ManualDraftStore,
} from "./methodology-view-types.js";

export type MethodologyRevisionFormDraft = Extract<
  ManualFormDraft,
  { key: "methodology_revision" }
>;

export type MethodologyRevisionField = keyof MethodologyRevisionInput;
export type MethodologyRevisionRebaseChoice = "current" | "draft" | null;

export interface MethodologyRevisionRebaseState {
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

export const methodologyRevisionFields: Array<{
  field: MethodologyRevisionField;
  label: string;
}> = [
  { field: "title", label: "标题" },
  { field: "principle", label: "原则" },
  { field: "appliesWhen", label: "适用条件" },
  { field: "caution", label: "注意事项" },
  { field: "evidenceSummary", label: "证据摘要" },
];


export const revisionFrom = (item: MethodologyItem): MethodologyRevisionInput => ({
  title: item.title,
  principle: item.principle,
  appliesWhen: item.appliesWhen,
  caution: item.caution,
  evidenceSummary: item.evidenceSummary,
});

export const evolutionSourceSnapshot = (
  item: MethodologyItem,
): MethodologyEvolutionInput => ({
  ...revisionFrom(item),
  sourceDecisionIds: [...item.sourceDecisionIds],
});

export const initialRevisionRebaseChoice = (
  baseline: string,
  current: string,
  draft: string,
): MethodologyRevisionRebaseChoice => {
  if (current === draft) return "current";
  if (current === baseline) return "draft";
  if (draft === baseline) return "current";
  return null;
};


/**
 * Revising an adopted principle, lifted out of MethodologyPanel.
 *
 * Eleven pieces of state, one ref, one autosave effect and nine functions,
 * including the rebase flow that runs when the sources moved underneath a
 * draft, returned under their original 33 names so the panel's JSX did not
 * move. At eleven options it is the widest of the clusters lifted out so far —
 * the merge workbench takes six and manual drafting five — because the rebase
 * flow has to read both the current record and the draft it is rebasing onto.
 *
 * Its draft storage belongs to the manual hook, so the panel hands this one
 * a `draftStore` and the derived revision draft rather than owning
 * them: three flows write into one store, and saying so is better than three
 * copies of the truth.
 */
export interface PrincipleEvolutionOptions {
  api: MethodologyRecordsApi;
  host: MethodologyWorkspaceHost;
  draftStore: ManualDraftStore;
  selected: MethodologyItem | null;
  status: StatusFilter;
  storedRevisionDraft: MethodologyRevisionFormDraft | undefined;
  setDetailError: Dispatch<SetStateAction<string | null>>;
  setUsage: Dispatch<SetStateAction<MethodologyUsageSnapshot | null>>;
  setUsageLoading: Dispatch<SetStateAction<boolean>>;
  setUsageError: Dispatch<SetStateAction<string | null>>;
  newEvolutionEvidence: MethodologyUsageDecision[];
}

export const usePrincipleEvolution = ({
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
}: PrincipleEvolutionOptions) => {
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
          draftStore.remember(saved);
          setEvolutionDraftRestoredAt(saved.updatedAt);
          setEvolutionDraftSaveState("saved");
          draftStore.failed(null);
        })
        .catch((caught: unknown) => {
          if (evolutionDraftSaveEpoch.current !== epoch) return;
          setEvolutionDraftSaveState("error");
          draftStore.failed(
            caught instanceof Error ? caught.message : String(caught),
          );
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [api, evolutionDraft, evolving, selected]);

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
    draftStore.failed(null);
    try {
      await api.deleteManualFormDraft("methodology_revision");
      draftStore.forget("methodology_revision");
      clearEvolutionEditor();
      setEvolutionRebase(null);
      setEvolutionRebaseError(null);
      host.notify(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setEvolutionDraftSaveState("error");
      draftStore.failed(message);
      if (evolutionDraft === null) {
        host.notify({
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
      draftStore.remember(saved);
      setEvolutionDraftSaveState("saved");
      draftStore.failed(null);
      clearEvolutionEditor();
      if (closeDetail) {
        host.showRecord(null);
        host.leaveEditor();
        host.dismissAcceptancePrompt();
        host.showView("records");
      }
    } catch (caught) {
      if (evolutionDraftSaveEpoch.current !== epoch) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setEvolutionDraftSaveState("error");
      draftStore.failed(message);
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
    host.notify(null);
    host.showView("records");
    const current = host.opening();
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
      // Read once the reader had opened a principle themselves: the draft does not close it to open over it.
      if (!current()) return;
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
        host.showRecord(null);
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
      host.showRecord(source);
      setUsage(usageSnapshot);
      setUsageLoading(false);
      setUsageError(null);
      host.leaveEditor();
      host.dismissAcceptancePrompt();
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
      if (!current()) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      clearEvolutionEditor();
      setEvolutionRebase(null);
      setEvolutionRebaseError(null);
      host.showRecord(null);
      host.notify({
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
      draftStore.remember(saved);
      hydratedUsageForPrinciple.current = source.id;
      host.showRecord(source);
      setUsage(usageSnapshot);
      setUsageLoading(false);
      setUsageError(null);
      host.leaveEditor();
      host.dismissAcceptancePrompt();
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
      draftStore.failed(null);
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
    host.dismissAcceptancePrompt();
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
        draftStore.forget("methodology_revision");
      } catch (caught) {
        host.notify({
          tone: "warning",
          text: `修订候选已创建，但本机草稿未能清除：${caught instanceof Error ? caught.message : String(caught)}`,
          action: "discard_revision_draft",
        });
      }
      host.showRecord(candidate);
      clearEvolutionEditor();
      host.filterBy("candidate");
      host.refreshRecords();
    } catch (caught) {
      setEvolutionError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setEvolutionSaving(false);
    }
  };

  return {
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
  };
};
