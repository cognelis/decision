import { useEffect, useRef, useState } from "react";

import type {
  ManualFormDraft,
  MethodologyEvidenceManualInput,
  MethodologyItem,
  MethodologyManualInput,
  MethodologyRecordsApi,
} from "../../../../shared/renderer-api.js";
import type {
  MethodologyNotice,
  StatusFilter,
  MethodologyWorkspaceHost,
  ManualDraftStore,
} from "./methodology-view-types.js";
import type { SourceChooser } from "./use-evidence-linking.js";

type MethodologyCreationMode = "chooser" | "manual" | null;

/**
 * Hand-written principle drafting, lifted out of MethodologyPanel.
 *
 * Thirteen pieces of state, two refs, three effects (one loader and two
 * autosaves) and eleven functions, returned under their original 40 names.
 * `manualFormDrafts` lives here because this
 * is what writes it — the merge workbench only reads a draft out of it, so the
 * panel now calls this hook first and hands merge what it needs. That ordering
 * was always real; until now it was buried in one 7000-line scope where
 * nothing said which state belonged to which flow.
 *
 * Names are returned unchanged, so the panel's JSX did not move.
 */
export interface ManualDraftingOptions {
  api: MethodologyRecordsApi;
  host: MethodologyWorkspaceHost;
  selected: MethodologyItem | null;
  status: StatusFilter;
  /**
   * The evidence picker. The evidence-backed half of manual creation drives
   * it: six of these functions reach into it. That entanglement is a fact
   * about this flow, and the contract still reports it — but as six things
   * this flow does, not as five setters that could do anything.
   */
  chooser: SourceChooser;
}

export const useManualDrafting = ({
  api,
  host,
  selected,
  status,
  chooser,
}: ManualDraftingOptions) => {
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
  /**
   * This hook owns the on-disk drafts, so it builds the store the other
   * workspace hooks are handed rather than taking one.
   */
  const draftStore: ManualDraftStore = {
    remember: (draft) =>
      setManualFormDrafts((current) => [
        ...current.filter((entry) => entry.key !== draft.key),
        draft,
      ]),
    forget: (key) =>
      setManualFormDrafts((current) =>
        current.filter((entry) => entry.key !== key),
      ),
    failed: (message) => setManualDraftStorageError(message),
    replaceAll: (drafts) => setManualFormDrafts(drafts),
  };


  const manualEvidenceDraftSaveEpoch = useRef(0);
  /** The evidence draft a close could not store: closed again unchanged, it is let go, as the form said. */
  const unsavedOnClose = useRef<MethodologyEvidenceManualInput | null>(null);
  /** The same for the principle written by hand (manualDraftKept). */
  const unsavedManual = useRef<MethodologyManualInput | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .listManualFormDrafts()
      .then((drafts) => {
        if (active) draftStore.replaceAll(drafts);
      })
      .catch((caught: unknown) => {
        if (active) {
          draftStore.failed(
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
          draftStore.remember(saved);
          setManualDraftSaveState("saved");
          draftStore.failed(null);
        })
        .catch((caught: unknown) => {
          if (manualDraftSaveEpoch.current !== epoch) return;
          setManualDraftSaveState("error");
          draftStore.failed(
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
          draftStore.remember(saved);
          setManualEvidenceDraftSaveState("saved");
          draftStore.failed(null);
        })
        .catch((caught: unknown) => {
          if (manualEvidenceDraftSaveEpoch.current !== epoch) return;
          setManualEvidenceDraftSaveState("error");
          draftStore.failed(
            caught instanceof Error ? caught.message : String(caught),
          );
        });
    }, 500);
    return () => window.clearTimeout(timeout);
  }, [api, manualEvidenceDraft]);

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
      chooser.open();
      return;
    }
    setCreationMode(null);
    setManualEvidenceDraft({
      ...saved.input,
      sourceDecisionIds: [...saved.input.sourceDecisionIds],
    });
    setManualEvidenceRestoredAt(saved.updatedAt);
    setManualEvidencePendingSources(null);
    setManualEvidenceDraftSaveState("saved");
    setManualEvidenceError(null);
    void chooser
      .restore([...saved.input.sourceDecisionIds])
      .catch((caught: unknown) => {
        setManualEvidenceError(
          caught instanceof Error ? caught.message : String(caught),
        );
      });
  };

  /**
   * Whether the principle written by hand may be left: stored, empty, or left once already unstored. Saved without
   * waiting, a close or 返回选择 on a full disk let it go without a word, and reopened, an older stored draft took
   * its place. Not stored, the form stays and says so; left again as it is, it goes.
   */
  const manualDraftKept = async (): Promise<boolean> => {
    const draft = manualDraft;
    if (!Object.values(draft).some((value) => value.trim().length > 0) || unsavedManual.current === draft) {
      unsavedManual.current = null;
      return true;
    }
    try {
      draftStore.remember(await api.saveManualFormDraft({ key: "methodology_manual", input: draft }));
      unsavedManual.current = null;
      return true;
    } catch (caught) {
      unsavedManual.current = draft;
      setManualDraftSaveState("error");
      setManualError(
        `${caught instanceof Error ? caught.message : String(caught)}。这份草稿还没存下来，表单先留着；再关闭一次会放弃它。`,
      );
      return false;
    }
  };

  const closeCreation = async (): Promise<void> => {
    if (manualSaving) return;
    if (creationMode === "manual" && !(await manualDraftKept())) return;
    setCreationMode(null);
    setManualError(null);
  };

  const backToChooser = async (): Promise<void> => {
    if (!(await manualDraftKept())) return;
    setManualError(null);
    setCreationMode("chooser");
  };

  const discardManualMethodologyDraft = async (): Promise<void> => {
    manualDraftSaveEpoch.current += 1;
    setManualDraftSaveState("idle");
    draftStore.failed(null);
    try {
      await api.deleteManualFormDraft("methodology_manual");
      draftStore.forget("methodology_manual");
      setManualDraft({
        title: "",
        principle: "",
        appliesWhen: "",
        caution: "",
      });
      setManualDraftRestoredAt(null);
    } catch (caught) {
      setManualDraftSaveState("error");
      draftStore.failed(
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
        draftStore.forget("methodology_manual");
      } catch (caught) {
        host.notify({
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
      host.showRecord(item);
      host.leaveEditor();
      host.dismissAcceptancePrompt();
      host.filterBy("candidate");
      host.refreshRecords();
    } catch (caught) {
      setManualError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setManualSaving(false);
    }
  };

  const beginManualEvidenceMethodology = (): void => {
    if (chooser.selected.length === 0 || chooser.loading) return;
    const requestedSources = [...chooser.selected];
    const saved = manualFormDrafts.find(
      (draft) => draft.key === "methodology_evidence_manual",
    );
    chooser.cancelPendingLoad();
    if (saved?.key === "methodology_evidence_manual") {
      setManualEvidenceDraft({
        ...saved.input,
        sourceDecisionIds: [...saved.input.sourceDecisionIds],
      });
      chooser.choose([...saved.input.sourceDecisionIds]);
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
    chooser.close();
  };

  const updateManualEvidenceDraft = (
    patch: Partial<MethodologyEvidenceManualInput>,
  ): void => {
    setManualEvidenceDraft((current) =>
      current === null ? null : { ...current, ...patch },
    );
  };

  const closeManualEvidenceMethodology = async (): Promise<void> => {
    if (manualEvidenceSaving) return;
    const draft = manualEvidenceDraft;
    // Let go only once stored: closed on an autosave that had failed (a full disk), the principle written in the
    // form was gone, never stored, with nothing said. Not stored, it stays and says so; closed again as it is, it goes.
    if (draft !== null && unsavedOnClose.current !== draft) {
      try {
        draftStore.remember(
          await api.saveManualFormDraft({
            key: "methodology_evidence_manual",
            input: draft,
          }),
        );
      } catch (caught) {
        unsavedOnClose.current = draft;
        setManualEvidenceDraftSaveState("error");
        setManualEvidenceError(
          `${caught instanceof Error ? caught.message : String(caught)}。这份草稿还没存下来，表单先留着；再关闭一次会放弃它。`,
        );
        return;
      }
    }
    unsavedOnClose.current = null;
    setManualEvidenceDraft(null);
    setManualEvidenceError(null);
    chooser.show();
  };

  const discardManualEvidenceMethodologyDraft = async (): Promise<void> => {
    if (manualEvidenceDraft === null) return;
    const sourceDecisionIds = [
      ...(manualEvidencePendingSources ??
        manualEvidenceDraft.sourceDecisionIds),
    ];
    manualEvidenceDraftSaveEpoch.current += 1;
    setManualEvidenceDraftSaveState("idle");
    draftStore.failed(null);
    try {
      await api.deleteManualFormDraft("methodology_evidence_manual");
      draftStore.forget("methodology_evidence_manual");
      chooser.choose(sourceDecisionIds);
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
      draftStore.failed(
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
        draftStore.forget("methodology_evidence_manual");
      } catch (caught) {
        draftCleanupError =
          caught instanceof Error ? caught.message : String(caught);
      }
      setManualEvidenceDraft(null);
      setManualEvidenceRestoredAt(null);
      setManualEvidencePendingSources(null);
      chooser.choose([]);
      host.showRecord(item);
      host.leaveEditor();
      host.dismissAcceptancePrompt();
      host.filterBy("candidate");
      host.notify({
        tone: draftCleanupError === null ? "success" : "warning",
        text:
          draftCleanupError === null
            ? `已基于 ${item.sourceDecisionIds.length} 条复盘建立人工候选，全程未调用模型。`
            : `候选已保存，但未完成草稿未能清除：${draftCleanupError}`,
      });
      host.refreshRecords();
    } catch (caught) {
      setManualEvidenceError(
        caught instanceof Error ? caught.message : String(caught),
      );
    } finally {
      setManualEvidenceSaving(false);
    }
  };

  return {
    draftStore,
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
  };
};
