import { zonedFormatter } from "../../../calendar-date.js";
import type {
  PracticeAssetKind,
  PracticeAssetStatus,
  PracticePublicationStatus,
  PracticePublicationTarget,
} from "@cognelis/decision-core";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  ManualFormDraft,
  MethodologyItem,
  PracticeAssetsApi,
  PracticeAssetItem,
  PracticeAssetRevisionInput,
  PracticeAssetVersionItem,
} from "../../../../shared/renderer-api.js";
import { practiceAssetBasis } from "../../../../shared/renderer-api.js";
import { ActionIcon } from "../../IconButton.js";
import { ModalDialog } from "../../ModalDialog.js";

interface PracticeAssetsViewProps {
  api: PracticeAssetsApi;
  onOpenPrinciples(): void;
  toolbarHost?: HTMLElement | null;
  /** Where 新建草案 goes when the page header carries it; beside the filters otherwise. */
  actionHost?: HTMLElement | null;
}

type StatusFilter = PracticeAssetStatus | "all";

const statusLabels: Record<PracticeAssetStatus, string> = {
  candidate: "待确认",
  accepted: "已采纳",
  dismissed: "已忽略",
};

const kindLabels: Record<PracticeAssetKind, string> = {
  skill: "技能",
  workflow: "工作流",
};

const draftDateFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const publicationStateLabels: Record<PracticePublicationStatus["state"], string> = {
  not_published: "未发布",
  up_to_date: "已是最新",
  update_available: "有更新",
  target_modified: "外部已修改",
  occupied: "同名占用",
  missing_target: "目标丢失",
  unsafe_target: "路径不安全",
};

const freshnessLabels: Record<PracticeAssetItem["freshness"]["state"], string> = {
  current: "来源一致",
  sources_updated: "来源已更新",
  sources_unavailable: "来源不可用",
};

const sourceFieldLabels: Record<
  PracticeAssetItem["sourceChanges"][number]["fields"][number]["field"],
  string
> = {
  title: "标题",
  principle: "原则内容",
  appliesWhen: "适用条件",
  caution: "注意事项",
  confidence: "可信度",
};

const historyReasonLabels: Record<PracticeAssetVersionItem["reason"], string> = {
  manual_edit: "编辑前",
  replacement_applied: "应用新草案前",
  restore_checkpoint: "恢复前",
};

const sourceValueLabel = (
  field: PracticeAssetItem["sourceChanges"][number]["fields"][number],
  value: string,
): string =>
  field.field === "confidence"
    ? ({ low: "低", medium: "中", high: "高" }[value] ?? value)
    : value;

const publishButtonLabel = (status: PracticePublicationStatus): string => {
  switch (status.state) {
    case "up_to_date":
      return "已发布";
    case "update_available":
      return "更新";
    case "target_modified":
    case "occupied":
      return "处理冲突";
    case "missing_target":
      return "重新发布";
    case "unsafe_target":
      return "不可发布";
    default:
      return "发布";
  }
};

const dateFormatter = zonedFormatter({
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const revisionFrom = (item: PracticeAssetItem): PracticeAssetRevisionInput => ({
  title: item.title,
  summary: item.summary,
  trigger: item.trigger,
  steps: item.steps,
  checks: item.checks,
  fallback: item.fallback,
});

const nonEmptyLines = (value: string): string[] =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/**
 * One item per line. The text is kept as typed — a line just begun, a space before the next word —
 * and only the lines it makes are handed on: tidied on every key, Enter and a trailing space would
 * vanish as they were typed. Lines changed from outside (a draft opened) are shown as they are.
 */
const LinesField = ({
  id,
  label,
  lines,
  onLines,
}: {
  id: string;
  label: string;
  lines: string[];
  onLines(lines: string[]): void;
}) => {
  const [text, setText] = useState(() => lines.join("\n"));
  const shown =
    nonEmptyLines(text).join("\n") === lines.join("\n") ? text : lines.join("\n");
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={shown}
        onChange={(event) => {
          setText(event.currentTarget.value);
          onLines(nonEmptyLines(event.currentTarget.value));
        }}
      />
    </div>
  );
};

const practiceRevisionValid = (
  revision: PracticeAssetRevisionInput | null,
): boolean =>
  revision !== null &&
  revision.title.trim().length > 0 &&
  revision.summary.trim().length > 0 &&
  revision.trigger.trim().length > 0 &&
  revision.fallback.trim().length > 0 &&
  revision.steps.length >= 2 &&
  revision.steps.length <= 12 &&
  revision.checks.length >= 1 &&
  revision.checks.length <= 8;

const PracticeAssetFormFields = ({
  revision,
  onChange,
  autoFocus = false,
}: {
  revision: PracticeAssetRevisionInput;
  onChange(next: PracticeAssetRevisionInput): void;
  autoFocus?: boolean;
}) => {
  const id = useId();
  return (
    <div className="form-fields practice-asset-editor">
      <div className="form-field">
        <label htmlFor={`${id}-title`}>标题</label>
        <input
          id={`${id}-title`}
          autoFocus={autoFocus}
          maxLength={120}
          value={revision.title}
          onChange={(event) =>
            onChange({ ...revision, title: event.currentTarget.value })
          }
        />
      </div>
      <div className="form-fields-row">
        <div className="form-field">
          <label htmlFor={`${id}-summary`}>简介</label>
          <textarea
            id={`${id}-summary`}
            rows={3}
            maxLength={800}
            value={revision.summary}
            onChange={(event) =>
              onChange({ ...revision, summary: event.currentTarget.value })
            }
          />
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-trigger`}>使用条件</label>
          <textarea
            id={`${id}-trigger`}
            rows={3}
            maxLength={1_500}
            value={revision.trigger}
            onChange={(event) =>
              onChange({ ...revision, trigger: event.currentTarget.value })
            }
          />
        </div>
      </div>
      <div className="form-fields-row">
        <LinesField
          id={`${id}-steps`}
          label="操作步骤（每行一项，2–12 项）"
          lines={revision.steps}
          onLines={(steps) => onChange({ ...revision, steps })}
        />
        <LinesField
          id={`${id}-checks`}
          label="验收检查（每行一项，1–8 项）"
          lines={revision.checks}
          onLines={(checks) => onChange({ ...revision, checks })}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-fallback`}>失败处理</label>
        <textarea
          id={`${id}-fallback`}
          rows={3}
          maxLength={1_500}
          value={revision.fallback}
          onChange={(event) =>
            onChange({ ...revision, fallback: event.currentTarget.value })
          }
        />
      </div>
    </div>
  );
};

const versionDiffs = (
  current: PracticeAssetItem,
  version: PracticeAssetVersionItem,
): Array<{ label: string; before: string; after: string }> => {
  const fields: Array<{
    label: string;
    before: string;
    after: string;
  }> = [
    { label: "标题", before: version.snapshot.title, after: current.title },
    { label: "简介", before: version.snapshot.summary, after: current.summary },
    { label: "使用条件", before: version.snapshot.trigger, after: current.trigger },
    {
      label: "操作步骤",
      before: version.snapshot.steps.join("\n"),
      after: current.steps.join("\n"),
    },
    {
      label: "验收检查",
      before: version.snapshot.checks.join("\n"),
      after: current.checks.join("\n"),
    },
    { label: "失败处理", before: version.snapshot.fallback, after: current.fallback },
  ];
  return fields.filter((field) => field.before !== field.after);
};

export const PracticeAssetsView = ({
  api,
  onOpenPrinciples,
  toolbarHost = null,
  actionHost = null,
}: PracticeAssetsViewProps) => {
  const [status, setStatus] = useState<StatusFilter>("candidate");
  const [items, setItems] = useState<PracticeAssetItem[]>([]);
  // Which filter the rows shown were read for.
  const [itemsFor, setItemsFor] = useState<StatusFilter | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revisionKey, setRevisionKey] = useState(0);
  const [selected, setSelected] = useState<PracticeAssetItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState<PracticeAssetRevisionInput | null>(
    null,
  );
  // What the edit began from (practiceAssetBasis), sent with it: the note changed in Obsidian since is refused.
  const [revisionBasis, setRevisionBasis] = useState<string | null>(null);
  const beginRevision = (item: PracticeAssetItem): void => {
    setRevision(revisionFrom(item));
    setRevisionBasis(practiceAssetBasis(item));
  };
  const [saving, setSaving] = useState(false);
  // Said of the asset it was about, and shown on that one alone: one opened from anywhere else, say once generated,
  // showed it as its own. Cleared instead as the selection moved, the warning that a manual draft was saved but its
  // form not cleared went the moment the draft it was about opened.
  const [detailError, setDetailErrorFor] = useState<{ id: string | null; text: string } | null>(null);
  const setDetailError = (text: string | null, id: string | null = selected?.id ?? null): void =>
    setDetailErrorFor(text === null ? null : { id, text });
  const [choosing, setChoosing] = useState(false);
  const [kind, setKind] = useState<PracticeAssetKind>("skill");
  const [principles, setPrinciples] = useState<MethodologyItem[]>([]);
  const [selectedPrinciples, setSelectedPrinciples] = useState<string[]>([]);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [manualDraft, setManualDraft] =
    useState<PracticeAssetRevisionInput | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [manualFormDrafts, setManualFormDrafts] = useState<ManualFormDraft[]>(
    [],
  );
  const [manualDraftRestoredAt, setManualDraftRestoredAt] = useState<
    string | null
  >(null);
  const [manualDraftPendingSelection, setManualDraftPendingSelection] =
    useState<{ kind: PracticeAssetKind; sourcePrincipleIds: string[] } | null>(
      null,
    );
  const [manualDraftSaveState, setManualDraftSaveState] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [manualDraftStorageError, setManualDraftStorageError] = useState<
    string | null
  >(null);
  const manualDraftSaveEpoch = useRef(0);
  /** The draft a leave could not store: left again unchanged, it is let go, as the form said. */
  const unsavedOnLeave = useRef<PracticeAssetRevisionInput | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [publicationStatuses, setPublicationStatuses] = useState<
    PracticePublicationStatus[]
  >([]);
  const [publicationLoading, setPublicationLoading] = useState(false);
  const [publicationBusyTarget, setPublicationBusyTarget] =
    useState<PracticePublicationTarget | null>(null);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  // A status that could not be read is not a failed operation: said in the card with its retry (audit G5).
  const [publicationReadError, setPublicationReadError] = useState<string | null>(null);
  const [publicationReads, setPublicationReads] = useState(0);
  const [pendingPublicationAction, setPendingPublicationAction] = useState<{
    kind: "overwrite" | "rollback";
    target: PracticePublicationTarget;
  } | null>(null);
  const [versions, setVersions] = useState<PracticeAssetVersionItem[]>([]);
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
    if (manualDraft === null || selectedPrinciples.length === 0) return;
    const epoch = manualDraftSaveEpoch.current + 1;
    manualDraftSaveEpoch.current = epoch;
    setManualDraftSaveState("idle");
    const timeout = window.setTimeout(() => {
      if (manualDraftSaveEpoch.current !== epoch) return;
      setManualDraftSaveState("saving");
      void api
        .saveManualFormDraft({
          key: "practice_asset_manual",
          practiceKind: kind,
          sourcePrincipleIds: selectedPrinciples,
          input: manualDraft,
        })
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
  }, [api, kind, manualDraft, selectedPrinciples]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .listPracticeAssets(status === "all" ? undefined : status)
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

  // Read for any asset, adopted or not: one dismissed or so set in Obsidian may still have a copy in a client, to be
  // withdrawn. Read for adopted ones alone, that copy went on being loaded with no way to take it back here.
  useEffect(() => {
    if (selected === null) {
      setPublicationStatuses([]);
      setPublicationLoading(false);
      return;
    }
    let active = true;
    setPublicationLoading(true);
    setPublicationError(null);
    setPublicationReadError(null);
    void api
      .listPracticePublicationStatuses(selected.id)
      .then((statuses) => {
        if (active) setPublicationStatuses(statuses);
      })
      .catch((caught: unknown) => {
        if (active) {
          setPublicationStatuses([]);
          setPublicationReadError(
            `发布状态暂时无法读取：${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      })
      .finally(() => {
        if (active) setPublicationLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revisionKey, selected?.id, selected?.status, publicationReads]);

  useEffect(() => {
    setActiveVersion(null);
    setPendingRestoreVersion(null);
    setRestoreError(null);
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
      .listPracticeAssetVersions(selected.id)
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

  const openChooser = (): void => {
    const saved = manualFormDrafts.find(
      (draft) => draft.key === "practice_asset_manual",
    );
    setChoosing(true);
    if (saved?.key === "practice_asset_manual") {
      setKind(saved.practiceKind);
      setSelectedPrinciples([...saved.sourcePrincipleIds]);
      setManualDraft({
        ...saved.input,
        steps: [...saved.input.steps],
        checks: [...saved.input.checks],
      });
      setManualDraftRestoredAt(saved.updatedAt);
      setManualDraftSaveState("saved");
    } else {
      setKind("skill");
      setSelectedPrinciples([]);
      setManualDraft(null);
      setManualDraftRestoredAt(null);
      setManualDraftSaveState("idle");
    }
    setManualDraftPendingSelection(null);
    setGenerationError(null);
    setSourceLoading(true);
    void api
      .listMethodologies("accepted")
      .then(setPrinciples)
      .catch((caught: unknown) => {
        setPrinciples([]);
        setGenerationError(
          caught instanceof Error ? caught.message : String(caught),
        );
      })
      .finally(() => setSourceLoading(false));
  };

  /**
   * Stored before the form lets it go: closed on an autosave that had failed (a full disk), the steps written in it
   * were gone, never stored, with nothing said. Not stored, it stays and says so; left again as it is, it goes.
   */
  const draftKeptOnLeaving = async (): Promise<boolean> => {
    const draft = manualDraft;
    if (draft !== null && selectedPrinciples.length > 0 && unsavedOnLeave.current !== draft) {
      try {
        const saved = await api.saveManualFormDraft({
          key: "practice_asset_manual",
          practiceKind: kind,
          sourcePrincipleIds: selectedPrinciples,
          input: draft,
        });
        setManualFormDrafts((current) => [
          ...current.filter((entry) => entry.key !== saved.key),
          saved,
        ]);
      } catch (caught) {
        unsavedOnLeave.current = draft;
        setManualDraftSaveState("error");
        setGenerationError(
          `${caught instanceof Error ? caught.message : String(caught)}。这份草稿还没存下来，表单先留着；再关闭一次会放弃它。`,
        );
        return false;
      }
    }
    unsavedOnLeave.current = null;
    return true;
  };

  const closeChooser = async (): Promise<void> => {
    if (generating || manualSaving) return;
    if (!(await draftKeptOnLeaving())) return;
    setChoosing(false);
    setManualDraft(null);
    setSelectedPrinciples([]);
    setGenerationError(null);
  };

  const togglePrinciple = (id: string): void => {
    setSelectedPrinciples((current) =>
      current.includes(id)
        ? current.filter((value) => value !== id)
        : current.length >= 5
          ? current
          : [...current, id],
    );
  };

  const generate = async (): Promise<void> => {
    if (selectedPrinciples.length === 0) return;
    setGenerating(true);
    setGenerationError(null);
    try {
      const item = await api.generatePracticeAsset(kind, selectedPrinciples);
      setChoosing(false);
      setSelectedPrinciples([]);
      setSelected(item);
      // Listed where it is: switched to 待确认, an asset found adopted already was behind a list saying none waits.
      setStatus(item.status);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setGenerationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setGenerating(false);
    }
  };

  const beginManualDraft = (): void => {
    const sources = principles.filter((principle) =>
      selectedPrinciples.includes(principle.id),
    );
    if (sources.length === 0) return;
    const requestedSelection = {
      kind,
      sourcePrincipleIds: [...selectedPrinciples],
    };
    const saved = manualFormDrafts.find(
      (draft) => draft.key === "practice_asset_manual",
    );
    if (saved?.key === "practice_asset_manual") {
      setKind(saved.practiceKind);
      setSelectedPrinciples([...saved.sourcePrincipleIds]);
      setManualDraft({
        ...saved.input,
        steps: [...saved.input.steps],
        checks: [...saved.input.checks],
      });
      setManualDraftRestoredAt(saved.updatedAt);
      setManualDraftPendingSelection(
        saved.practiceKind === requestedSelection.kind &&
          saved.sourcePrincipleIds.join("\u0000") ===
            requestedSelection.sourcePrincipleIds.join("\u0000")
          ? null
          : requestedSelection,
      );
      setManualDraftSaveState("saved");
      setGenerationError(null);
      return;
    }
    const title =
      sources.length === 1
        ? `${sources[0]!.title} · ${kindLabels[kind]}`.slice(0, 120)
        : "";
    setManualDraft({
      title,
      summary: "",
      trigger: sources
        .map((source) => source.appliesWhen)
        .join("\n")
        .slice(0, 1_500),
      steps: [],
      checks: [],
      fallback: sources
        .map((source) => source.caution)
        .join("\n")
        .slice(0, 1_500),
    });
    setManualDraftRestoredAt(null);
    setManualDraftPendingSelection(null);
    setManualDraftSaveState("idle");
    setGenerationError(null);
  };

  const discardManualDraft = async (): Promise<void> => {
    if (manualDraft === null) return;
    const nextKind = manualDraftPendingSelection?.kind ?? kind;
    const nextSourceIds = [
      ...(manualDraftPendingSelection?.sourcePrincipleIds ??
        selectedPrinciples),
    ];
    const sources = principles.filter((principle) =>
      nextSourceIds.includes(principle.id),
    );
    manualDraftSaveEpoch.current += 1;
    setManualDraftSaveState("idle");
    setManualDraftStorageError(null);
    try {
      await api.deleteManualFormDraft("practice_asset_manual");
      setManualFormDrafts((current) =>
        current.filter((draft) => draft.key !== "practice_asset_manual"),
      );
      setKind(nextKind);
      setSelectedPrinciples(nextSourceIds);
      setManualDraft({
        title:
          sources.length === 1
            ? `${sources[0]!.title} · ${kindLabels[nextKind]}`.slice(0, 120)
            : "",
        summary: "",
        trigger: sources
          .map((source) => source.appliesWhen)
          .join("\n")
          .slice(0, 1_500),
        steps: [],
        checks: [],
        fallback: sources
          .map((source) => source.caution)
          .join("\n")
          .slice(0, 1_500),
      });
      setManualDraftRestoredAt(null);
      setManualDraftPendingSelection(null);
    } catch (caught) {
      setManualDraftSaveState("error");
      setManualDraftStorageError(
        caught instanceof Error ? caught.message : String(caught),
      );
    }
  };

  const saveManualDraft = async (): Promise<void> => {
    if (
      manualDraft === null ||
      selectedPrinciples.length === 0 ||
      !practiceRevisionValid(manualDraft)
    ) {
      return;
    }
    setManualSaving(true);
    setGenerationError(null);
    try {
      const item = await api.createManualPracticeAsset(
        kind,
        selectedPrinciples,
        manualDraft,
      );
      manualDraftSaveEpoch.current += 1;
      let draftCleanupError: string | null = null;
      try {
        await api.deleteManualFormDraft("practice_asset_manual");
        setManualFormDrafts((current) =>
          current.filter((draft) => draft.key !== "practice_asset_manual"),
        );
      } catch (caught) {
        draftCleanupError =
          caught instanceof Error ? caught.message : String(caught);
      }
      setChoosing(false);
      setManualDraft(null);
      setManualDraftRestoredAt(null);
      setManualDraftPendingSelection(null);
      setSelectedPrinciples([]);
      setSelected(item);
      setEditing(false);
      setStatus("candidate");
      if (draftCleanupError !== null) {
        setDetailError(
          `技能与流程草案已保存，但未完成表单未能清除：${draftCleanupError}`,
          item.id,
        );
      }
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setGenerationError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setManualSaving(false);
    }
  };

  const saveRevision = async (): Promise<void> => {
    if (selected === null || revision === null) return;
    setSaving(true);
    setDetailError(null);
    try {
      const updated = await api.revisePracticeAsset(selected.id, revision, revisionBasis ?? undefined);
      setSelected(updated);
      setEditing(false);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const setRecordStatus = async (
    nextStatus: "accepted" | "dismissed",
  ): Promise<void> => {
    if (selected === null) return;
    setSaving(true);
    setDetailError(null);
    try {
      const updated = await api.setPracticeAssetStatus(selected.id, nextStatus);
      setSelected(nextStatus === "dismissed" ? null : updated);
      setEditing(false);
      setStatus(nextStatus === "dismissed" ? "candidate" : "accepted");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  // Done, but the status could not be read after: said as that. As a failure of the operation, a
  // publish already written to the client invited publishing it again.
  const refreshPublicationStatuses = async (assetId: string): Promise<void> => {
    try {
      setPublicationStatuses(await api.listPracticePublicationStatuses(assetId));
    } catch (caught) {
      setPublicationError(
        `已完成，但发布状态暂时无法刷新：${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
  };

  // After a failed publish or rollback, the card is read again as things now are (a client file changed
  // under it, say): left as it was, it offered only the action that had just failed, and no way to
  // confirm overwriting. The failure said stands; a refresh that fails says nothing more.
  const refreshAfterFailure = async (assetId: string): Promise<void> => {
    try {
      setPublicationStatuses(await api.listPracticePublicationStatuses(assetId));
    } catch {
      // The failure already said is the one that matters.
    }
  };

  const publish = async (
    target: PracticePublicationTarget,
    confirmOverwrite = false,
  ): Promise<void> => {
    if (selected === null) return;
    setPublicationBusyTarget(target);
    setPublicationError(null);
    try {
      await api.publishPracticeAsset(selected.id, target, confirmOverwrite);
      setPendingPublicationAction(null);
      await refreshPublicationStatuses(selected.id);
    } catch (caught) {
      setPublicationError(`发布操作失败：${caught instanceof Error ? caught.message : String(caught)}`);
      await refreshAfterFailure(selected.id);
    } finally {
      setPublicationBusyTarget(null);
    }
  };

  const rollbackPublication = async (
    target: PracticePublicationTarget,
  ): Promise<void> => {
    if (selected === null) return;
    setPublicationBusyTarget(target);
    setPublicationError(null);
    try {
      await api.rollbackPracticeAssetPublication(selected.id, target);
      setPendingPublicationAction(null);
      await refreshPublicationStatuses(selected.id);
    } catch (caught) {
      setPublicationError(`发布操作失败：${caught instanceof Error ? caught.message : String(caught)}`);
      await refreshAfterFailure(selected.id);
    } finally {
      setPublicationBusyTarget(null);
    }
  };

  const regenerate = async (): Promise<void> => {
    if (selected === null) return;
    setRegenerating(true);
    setDetailError(null);
    setPublicationError(null);
    try {
      const replacement = await api.regeneratePracticeAsset(selected.id);
      setSelected(replacement);
      setEditing(false);
      setPendingPublicationAction(null);
      setStatus("candidate");
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setDetailError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRegenerating(false);
    }
  };

  const restoreVersion = async (version: number): Promise<void> => {
    if (selected === null) return;
    setRestoringVersion(true);
    setRestoreError(null);
    setPublicationError(null);
    try {
      const restored = await api.restorePracticeAssetVersion(selected.id, version);
      setSelected(restored);
      setActiveVersion(null);
      setPendingRestoreVersion(null);
      setRevisionKey((value) => value + 1);
    } catch (caught) {
      setRestoreError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRestoringVersion(false);
    }
  };

  const revisionValid = practiceRevisionValid(revision);
  const visibleSourceChanges =
    selected?.sourceChanges.filter((change) => change.state !== "unchanged") ?? [];
  const selectedHistoryVersion =
    activeVersion === null
      ? null
      : versions.find((version) => version.version === activeVersion) ?? null;
  const selectedHistoryDiffs =
    selected === null || selectedHistoryVersion === null
      ? []
      : versionDiffs(selected, selectedHistoryVersion);

  // One solid button: 新建草案 in the header (or beside the filters); the empty list no longer offers a second one.
  const create = (
    <button type="button" className="primary-button" onClick={openChooser}>
      {actionHost === null ? null : <ActionIcon name="plus" />}
      新建草案
    </button>
  );
  // Read for another filter, the rows shown are the last one's: dimmed while the right ones are read.
  const switchingFilter = loading && itemsFor !== status;
  const toolbar = (
    <div className="practice-assets-toolbar">
        <div className="methodology-status-filter" aria-label="草案状态">
          {(
            [
              ["candidate", "待确认"],
              ["accepted", "已采纳"],
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
        {/* A failed read counts nothing: 「0 条」 there read as nothing kept. */}
        <span role="status">
          {error !== null ? "—" : loading ? "正在读取…" : `${items.length} 条`}
        </span>
        {actionHost === null ? create : null}
    </div>
  );
  const closeDetail = (): void => {
    setSelected(null);
    setEditing(false);
    setPendingPublicationAction(null);
    setPublicationError(null);
    setActiveVersion(null);
    setPendingRestoreVersion(null);
    setHistoryError(null);
  };
  const leaveManualDraft = async (): Promise<void> => {
    if (!(await draftKeptOnLeaving())) return;
    setManualDraft(null);
    setManualDraftRestoredAt(null);
    setManualDraftPendingSelection(null);
    setGenerationError(null);
  };

  return (
    <section className="practice-assets" aria-label="技能与流程">
      {toolbarHost === null ? toolbar : createPortal(toolbar, toolbarHost)}
      {actionHost === null ? null : createPortal(create, actionHost)}

      {error !== null ? (
        <div className="load-failure" role="alert">
          <span>技能与流程暂时无法读取：{error}</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setRevisionKey((value) => value + 1)}
          >
            重试
          </button>
        </div>
      ) : !loading && items.length === 0 ? (
        <div className="methodology-empty practice-assets-empty">
          <strong>{status === "candidate" ? "没有待确认草案" : "暂无记录"}</strong>
          <span>从已采纳原则人工编写，或调用模型生成第一份草案。</span>
          <div>
            <button type="button" className="text-button" onClick={onOpenPrinciples}>
              查看原则
            </button>
          </div>
        </div>
      ) : (
        <>
        <div className="methodology-list-head practice-assets-list-head" aria-hidden="true">
          <span>类型</span>
          <span>草案</span>
          <span>来源</span>
          <span>更新时间</span>
          <span>状态</span>
          <span />
        </div>
        <ol className="practice-assets-list" aria-busy={switchingFilter}>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="practice-asset-row"
                onClick={() => {
                  setSelected(item);
                  setEditing(false);
                  setDetailError(null);
                  setPublicationError(null);
                  setPendingPublicationAction(null);
                }}
              >
                <span className={`practice-kind ${item.kind}`}>
                  {kindLabels[item.kind]}
                </span>
                <span className="practice-asset-copy">
                  <span className="practice-asset-title">
                    <strong>{item.title}</strong>
                    {item.freshness.state === "current" ? null : (
                      <em className={item.freshness.state}>
                        {freshnessLabels[item.freshness.state]}
                      </em>
                    )}
                  </span>
                  <span>{item.summary}</span>
                </span>
                <span>{item.sourcePrincipleIds.length} 条原则</span>
                <time dateTime={item.updatedAt}>
                  {dateFormatter.format(new Date(item.updatedAt))}
                </time>
                <span className={`methodology-status ${item.status}`}>
                  {statusLabels[item.status]}
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
          ))}
        </ol>
        </>
      )}

      {choosing ? (
        <ModalDialog
          title={
            manualDraft === null
              ? "新建技能或工作流"
              : `人工编写${kindLabels[kind]}草案`
          }
          description={
            manualDraft === null
              ? "选择已采纳原则作为来源，再决定人工编写或调用模型。"
              : "只保存你填写的内容，不调用模型；保存后仍需单独审核。"
          }
          size="wide"
          dismissible={!generating && !manualSaving}
          onClose={closeChooser}
          footer={
            manualDraft === null ? (
              <>
                <span className="modal-dialog-footer-start methodology-footer-status">
                  已选 {selectedPrinciples.length} / 5
                </span>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={generating}
                  onClick={closeChooser}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={generating || selectedPrinciples.length === 0}
                  onClick={beginManualDraft}
                >
                  手动编写
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={generating || selectedPrinciples.length === 0}
                  onClick={() => void generate()}
                >
                  {generating
                    ? "正在生成…"
                    : `调用模型生成${kindLabels[kind]}`}
                </button>
              </>
            ) : (
              <>
                <div className="modal-dialog-footer-start">
                  {manualDraftRestoredAt === null ? null : (
                    <button
                      type="button"
                      className="text-button danger-button"
                      disabled={manualSaving}
                      onClick={() => void discardManualDraft()}
                    >
                      {manualDraftPendingSelection === null
                        ? "丢弃并重写"
                        : `丢弃并使用刚选的 ${manualDraftPendingSelection.sourcePrincipleIds.length} 条原则`}
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
                  onClick={() => void leaveManualDraft()}
                >
                  返回选择
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={manualSaving || !practiceRevisionValid(manualDraft)}
                  onClick={() => void saveManualDraft()}
                >
                  {manualSaving ? "正在保存…" : "保存为待确认草案"}
                </button>
              </>
            )
          }
        >
          {manualDraft === null ? (
            <section className="practice-source-chooser">
              <div
                className="practice-kind-picker"
                role="group"
                aria-label="草案类型"
              >
                {(["skill", "workflow"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={kind === value}
                    onClick={() => setKind(value)}
                  >
                    <strong>{kindLabels[value]}</strong>
                    <span>
                      {value === "skill"
                        ? "可复用的执行能力与检查清单"
                        : "带阶段出口的顺序化工作过程"}
                    </span>
                  </button>
                ))}
              </div>
              {sourceLoading ? (
                <p className="methodology-inbox-state" role="status">
                  正在读取已采纳原则…
                </p>
              ) : principles.length === 0 ? (
                <div className="methodology-inbox-state">
                  <strong>还没有可用原则</strong>
                  <span>先审核并采纳至少一条方法论候选。</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      setChoosing(false);
                      onOpenPrinciples();
                    }}
                  >
                    去采纳原则
                  </button>
                </div>
              ) : (
                <ol className="practice-principle-list">
                  {principles.map((principle) => {
                    const checked = selectedPrinciples.includes(principle.id);
                    return (
                      <li key={principle.id}>
                        <label className={checked ? "selected" : undefined}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && selectedPrinciples.length >= 5}
                            onChange={() => togglePrinciple(principle.id)}
                          />
                          <span>
                            <strong>{principle.title}</strong>
                            <small>{principle.principle}</small>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ol>
              )}
              <p className="methodology-dialog-note practice-creation-boundary">
                <span>人工编写不调用模型</span>
                <span>模型生成会发起 1 次调用</span>
                <span>两种方式都只保存为待确认草案</span>
              </p>
              {generationError === null ? null : (
                <p className="form-error" role="alert">
                  暂时无法创建：{generationError}
                </p>
              )}
            </section>
          ) : (
            <section className="practice-manual-draft">
              {manualDraftRestoredAt === null ? null : (
                <p className="methodology-dialog-note">
                  <strong>已恢复未完成的{kindLabels[kind]}草稿</strong> ·{" "}
                  {draftDateFormatter.format(new Date(manualDraftRestoredAt))}{" "}
                  保存，尚未进入待确认列表。
                </p>
              )}
              <p className="practice-manual-source-summary">
                <span>
                  {kindLabels[kind]} · {selectedPrinciples.length} 条来源原则
                </span>
                <strong>
                  {principles
                    .filter((principle) => selectedPrinciples.includes(principle.id))
                    .map((principle) => principle.title)
                    .join("、")}
                </strong>
              </p>
              <PracticeAssetFormFields
                revision={manualDraft}
                onChange={setManualDraft}
                autoFocus
              />
              <p className="methodology-dialog-note practice-manual-safety">
                来源原则只用于建立追溯关系和预填适用条件、失败边界；系统不会替你补写步骤或验收标准。未完成的内容只自动保存在这台 Mac 上，不会发布到任何终端。
              </p>
              {generationError === null ? null : (
                <p className="form-error" role="alert">
                  暂时无法保存：{generationError}
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
      ) : null}

      {selected === null ? null : (
        <ModalDialog
          title={
            editing
              ? "编辑技能与流程"
              : selected.status === "candidate"
                ? "审核技能与流程草案"
                : "技能与流程详情"
          }
          description={`${kindLabels[selected.kind]} · ${selected.sourcePrincipleIds.length} 条来源原则`}
          size="wide"
          dismissible={
            !saving &&
            // An edit is let go of only by 取消: a stray Escape or click outside threw it away.
            !editing &&
            !regenerating &&
            !restoringVersion &&
            publicationBusyTarget === null
          }
          onClose={closeDetail}
          footer={
            editing && revision !== null ? (
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
                  disabled={saving || !revisionValid}
                  onClick={() => void saveRevision()}
                >
                  {saving ? "保存中…" : "保存修改"}
                </button>
              </>
            ) : selected.status === "candidate" ? (
              <>
                {/* Leaving a draft is kept apart from the actions that keep it. */}
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
                  onClick={() => {
                    beginRevision(selected);
                    setDetailError(null);
                    setEditing(true);
                  }}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={saving || selected.freshness.state !== "current"}
                  onClick={() => void setRecordStatus("accepted")}
                >
                  {saving
                    ? "保存中…"
                    : selected.supersedesId === null
                      ? "采纳草案"
                      : (selected.migrationSourcePrincipleIds?.length ?? 0) > 0
                        ? "确认迁移来源"
                        : "应用到原资产"}
                </button>
              </>
            ) : selected.status === "accepted" ? (
              <button
                type="button"
                className="secondary-button"
                disabled={saving || publicationBusyTarget !== null}
                onClick={() => {
                  beginRevision(selected);
                  setDetailError(null);
                  setPublicationError(null);
                  setPendingPublicationAction(null);
                  setEditing(true);
                }}
              >
                编辑内容
              </button>
            ) : undefined
          }
        >
          <article className="practice-asset-detail">
            {editing && revision !== null ? (
              <PracticeAssetFormFields
                revision={revision}
                onChange={setRevision}
                autoFocus
              />
            ) : (
              <>
                <header className="practice-detail-header">
                  <div>
                    <span className={`practice-kind ${selected.kind}`}>
                      {kindLabels[selected.kind]}
                    </span>
                    <span className={`methodology-status ${selected.status}`}>
                      {statusLabels[selected.status]}
                    </span>
                    {selected.freshness.state === "current" ? null : (
                      <span
                        className={`practice-freshness-badge ${selected.freshness.state}`}
                      >
                        {freshnessLabels[selected.freshness.state]}
                      </span>
                    )}
                    <small>
                      {selected.generation.provider} · {selected.generation.model} · 保存在 Obsidian；发布只在明确确认后执行
                    </small>
                  </div>
                  <h3>{selected.title}</h3>
                  <p>{selected.summary}</p>
                </header>
                {selected.supersedesId === null ? null : (
                  <section className="practice-replacement-notice">
                    <h4>
                      {(selected.migrationSourcePrincipleIds?.length ?? 0) > 0
                        ? "这是来源迁移草案"
                        : "这是替换草案"}
                    </h4>
                    <p>
                      {(selected.migrationSourcePrincipleIds?.length ?? 0) > 0
                        ? "采纳后会把原资产切换到合并原则，并用这份草案的内容替换原资产的内容（原内容先存为可恢复的版本），保留原标识；当前客户端内容仍保持不变，之后由你确认是否发布更新。"
                        : "采纳后会更新原资产并保留原标识；当前客户端内容仍保持不变，之后由你确认是否发布更新。"}
                    </p>
                  </section>
                )}
                {selected.freshness.state === "current" ? null : (
                  <section
                    className={`practice-freshness-notice ${selected.freshness.state}`}
                    aria-label="来源状态"
                  >
                    <div>
                      <h4>{freshnessLabels[selected.freshness.state]}</h4>
                      <p>{selected.freshness.message}</p>
                    </div>
                    {selected.freshness.canRegenerate ? (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={saving || regenerating}
                        onClick={() => void regenerate()}
                      >
                        {regenerating ? "正在重新生成…" : "重新生成新草案"}
                      </button>
                    ) : null}
                  </section>
                )}
                {visibleSourceChanges.length === 0 ? null : (
                  <details
                    className="disclosure practice-source-diff"
                    open={selected.freshness.state !== "current"}
                  >
                    <summary>
                      <span>来源变化</span>
                      <small>{visibleSourceChanges.length} 项</small>
                    </summary>
                    <div className="practice-source-diff-body">
                      {visibleSourceChanges.map((change) => (
                        <article className={change.state} key={change.id}>
                          <header>
                            <strong>{change.title}</strong>
                            <span>
                              {change.state === "updated"
                                ? "内容有变化"
                                : change.state === "unavailable"
                                  ? "来源不可用"
                                  : "尚无对比基线"}
                            </span>
                          </header>
                          {change.state === "baseline_missing" ? (
                            <p>
                              此资产创建于来源快照启用前。下一次人工保存或重新生成后，将开始记录逐项差异。
                            </p>
                          ) : change.state === "unavailable" ? (
                            <p>
                              原来源已删除或不再采纳；恢复来源前不会生成新草案或发布更新。
                            </p>
                          ) : change.fields.length === 0 ? (
                            <p>来源更新时间发生变化，正文内容没有可见差异。</p>
                          ) : (
                            <div className="practice-source-field-list">
                              {change.fields.map((field) => (
                                <div key={field.field}>
                                  <span>{sourceFieldLabels[field.field]}</span>
                                  <div>
                                    <del>
                                      <small>原内容</small>
                                      {sourceValueLabel(field, field.before)}
                                    </del>
                                    <ins>
                                      <small>当前内容</small>
                                      {sourceValueLabel(field, field.after)}
                                    </ins>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  </details>
                )}
                <section>
                  <h4>使用条件</h4>
                  <p>{selected.trigger}</p>
                </section>
                <section>
                  <h4>操作步骤</h4>
                  <ol>
                    {selected.steps.map((step, index) => (
                      <li key={`${index}-${step}`}>{step}</li>
                    ))}
                  </ol>
                </section>
                <section>
                  <h4>验收检查</h4>
                  <ul>
                    {selected.checks.map((check, index) => (
                      <li key={`${index}-${check}`}>{check}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h4>失败处理</h4>
                  <p>{selected.fallback}</p>
                </section>
                {selected.status === "accepted" || publicationStatuses.some((status) => status.version !== null) ? (
                  <section className="practice-publication-section">
                    <header>
                      <div>
                        <h4>发布到客户端</h4>
                        <span>技能与工作流均以 Skill 包发布，只在点击后写入。</span>
                      </div>
                      <small>手动触发</small>
                    </header>
                    {publicationLoading ? (
                      <p className="practice-publication-message">正在检查客户端…</p>
                    ) : (
                      <>
                        {selected.freshness.state === "current" ? null : (
                          <p className="practice-publication-source-warning">
                            新发布已暂停；现有客户端版本仍可安全回滚。
                          </p>
                        )}
                        <div className="practice-publication-grid">
                        {publicationStatuses.map((publication) => {
                          const pending =
                            pendingPublicationAction?.target === publication.target
                              ? pendingPublicationAction
                              : null;
                          const busy =
                            publicationBusyTarget === publication.target;
                          return (
                            <div
                              className={`practice-publication-card ${publication.state}`}
                              key={publication.target}
                            >
                              <div className="practice-publication-card-heading">
                                <strong>{publication.targetLabel}</strong>
                                <span>{publicationStateLabels[publication.state]}</span>
                              </div>
                              <p>{publication.message}</p>
                              <small>
                                {publication.version === null
                                  ? "尚无发布版本"
                                  : `版本 ${publication.version}${
                                      publication.publishedAt === null
                                        ? ""
                                        : ` · ${dateFormatter.format(
                                            new Date(publication.publishedAt),
                                          )}`
                                    }`}
                              </small>
                              {pending === null ? (
                                <div className="practice-publication-actions">
                                  {publication.canRollback ? (
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={publicationBusyTarget !== null}
                                      onClick={() =>
                                        setPendingPublicationAction({
                                          kind: "rollback",
                                          target: publication.target,
                                        })
                                      }
                                    >
                                      回滚
                                    </button>
                                  ) : null}
                                  {/* Nothing to do is said as words: a disabled solid 已发布 read as an action at 2:1. */}
                                  {publication.canPublish ? (
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      disabled={
                                        selected.freshness.state !== "current" ||
                                        publicationBusyTarget !== null
                                      }
                                      onClick={() => {
                                        if (publication.requiresOverwriteConfirmation) {
                                          setPendingPublicationAction({
                                            kind: "overwrite",
                                            target: publication.target,
                                          });
                                        } else {
                                          void publish(publication.target);
                                        }
                                      }}
                                    >
                                      {busy
                                        ? "处理中…"
                                        : publishButtonLabel(publication)}
                                    </button>
                                  ) : (
                                    <span className="practice-publication-state">
                                      {publishButtonLabel(publication)}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <div
                                  className="practice-publication-confirm"
                                  role="alert"
                                >
                                  <strong>
                                    {pending.kind === "overwrite"
                                      ? "覆盖客户端现有内容？"
                                      : "回滚最近一次发布？"}
                                  </strong>
                                  <p>
                                    {pending.kind === "overwrite"
                                      ? "现有内容会先完整保存，之后可以回滚恢复。"
                                      : "若客户端内容后来被修改，系统会停止回滚以保护修改。"}
                                  </p>
                                  <div>
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      disabled={publicationBusyTarget !== null}
                                      onClick={() => setPendingPublicationAction(null)}
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-button danger-button"
                                      disabled={publicationBusyTarget !== null}
                                      onClick={() =>
                                        pending.kind === "overwrite"
                                          ? void publish(publication.target, true)
                                          : void rollbackPublication(
                                              publication.target,
                                            )
                                      }
                                    >
                                      {busy
                                        ? "处理中…"
                                        : pending.kind === "overwrite"
                                          ? "覆盖"
                                          : "回滚发布"}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        </div>
                      </>
                    )}
                    {publicationReadError === null ? null : (
                      <div className="load-failure" role="alert">
                        <span>{publicationReadError}</span>
                        <button type="button" className="secondary-button" disabled={publicationLoading} onClick={() => setPublicationReads((value) => value + 1)}>
                          重试
                        </button>
                      </div>
                    )}
                    {publicationError === null ? null : (
                      <p className="form-error" role="alert">
                        {publicationError}
                      </p>
                    )}
                  </section>
                ) : null}
                {selected.status === "accepted" ? (
                  <details className="disclosure practice-version-history">
                    <summary>
                      <span>资产版本</span>
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
                          下一次编辑或应用替换草案前，会自动保存当前内容作为恢复点。
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
                                <span>{historyReasonLabels[version.reason]}</span>
                                <time dateTime={version.capturedAt}>
                                  {dateFormatter.format(new Date(version.capturedAt))}
                                </time>
                              </button>
                            ))}
                          </div>
                          {selectedHistoryVersion === null ? (
                            <div className="practice-version-placeholder">
                              选择一个恢复点查看它与当前内容的差异。
                            </div>
                          ) : (
                            <div className="practice-version-comparison">
                              <header>
                                <div>
                                  <strong>
                                    版本 {selectedHistoryVersion.version} 与当前内容
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
                                <p>这个恢复点的可见内容与当前版本相同。</p>
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
                                    <strong>恢复版本 {selectedHistoryVersion.version}？</strong>
                                    <p>
                                      当前内容会先保存为新的恢复点；客户端内容不会自动变化。
                                    </p>
                                  </div>
                                  <div>
                                    <button
                                      type="button"
                                      className="secondary-button"
                                      disabled={restoringVersion}
                                      onClick={() => setPendingRestoreVersion(null)}
                                    >
                                      取消
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-button danger-button"
                                      disabled={restoringVersion}
                                      onClick={() =>
                                        void restoreVersion(
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
                <details className="disclosure practice-source-principles">
                  <summary>
                    <span>来源原则</span>
                    <small>
                      {selected.sourcePrinciples.length ===
                      selected.sourcePrincipleIds.length
                        ? `${selected.sourcePrinciples.length} 条`
                        : `${selected.sourcePrinciples.length} / ${selected.sourcePrincipleIds.length} 条可用`}
                    </small>
                  </summary>
                  <ol>
                    {selected.sourcePrinciples.map((principle) => (
                      <li key={principle.id}>
                        <strong>{principle.title}</strong>
                        <p>{principle.principle}</p>
                      </li>
                    ))}
                  </ol>
                </details>
              </>
            )}
            {detailError === null || detailError.id !== selected.id ? null : (
              <p className="form-error" role="alert">
                操作失败：{detailError.text}
              </p>
            )}
          </article>
        </ModalDialog>
      )}
    </section>
  );
};
