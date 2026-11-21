import { adoptedSummaryContext, clipText, CONTEXT_SUMMARY_LINES, type HistoricalDecision, type HistoricalDecisionSourceKind } from "@cognelis/decision-protocol";
import { useEffect, useId, useRef, useState } from "react";

import { CONTEXT_MAX_CHARS, proactiveRecordInputSchema } from "../../../../shared/proactive-record.js";
import type {
  DecisionApi,
  ProactiveRecordInput,
  ProactiveRecordResult,
  UserJournalSourceKind,
} from "../../../../shared/renderer-api.js";
import {
  isSubmitShortcut,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../../../keyboard.js";
import { ModalDialog } from "../../ModalDialog.js";
import { clearActiveRecordDraft, loadActiveRecordDraft, saveActiveRecordDraft } from "./active-record-draft.js";
import {
  emptyHistoricalForm,
  HistoricalField,
  HistoricalMoreFields,
  historicalDecisionInput,
  historicalFormComplete,
  historicalFormProblem,
  historicalMoreFilled,
  type HistoricalFormState,
} from "./HistoricalDecisionForm.js";
import { languagesTyped } from "./JournalEntryView.js";

/** Pre-filled starting text; the reader still edits and saves it themselves. */
export interface ActiveRecordDraft {
  title: string;
  content: string;
  rationale?: string;
  project?: string;
  context?: string;
  /** The PR comment the draft came from: the decision keeps its link, and only a decision can. */
  source?: { url: string; label: string };
  /** Which kind it opens as: without it, a decision or whatever a kept draft was. */
  kind?: RecordKind;
  /** For a 历史决定 made from a captured choice: the other options it had, and that an agent captured it. */
  historical?: { options?: string[]; sourceKind?: HistoricalDecisionSourceKind };
}

/** What was written: a decision, preference or idea as the App answers for those, or a 历史决定 by its id. */
export type ActiveRecordSaved = ProactiveRecordResult | { recordKind: "historical_decision"; recordId: string; status: "created" };

/**
 * Only what the form actually calls, so callers need promise no more. The summary of a context is offered where the
 * caller hands over both of its calls, and only beside a context: a form begun here has none.
 */
export type ActiveRecordApi = Pick<DecisionApi, "createProactiveRecord"> &
  // 历史决定 is offered where the caller hands over its call; the records it may replace, where they can be listed.
  Partial<Pick<DecisionApi, "summarizeRecordContext" | "cancelRecordContextSummary" | "recordHistoricalDecision" | "listHistoricalDecisions">>;

type ContextSummary =
  | { step: "idle"; note?: string }
  | { step: "running" }
  | { step: "ready"; text: string; clipped: boolean }
  // `adopted`: the context as adoption left it; `prefix`: what was put in front of `before`, for a summary put there.
  | { step: "adopted"; text: string; clipped: boolean; how: "replace" | "prepend"; before: string; adopted: string; prefix: string | null }
  | { step: "unavailable"; reason: string }
  | { step: "failed"; message: string };

interface ActiveRecordDialogProps {
  api: ActiveRecordApi;
  /**
   * Present when the text started somewhere other than this form — today, an
   * assistant answer. It is never saved as `user_original`: that value claims
   * the reader's own words, and a claim about provenance in a permanent record
   * has to be true even when the reader accepts the draft verbatim.
   */
  draft?: ActiveRecordDraft;
  /** The kind a form begun here opens on, over what a kept draft was: the page it is opened from says which. */
  initialKind?: RecordKind;
  onClose(): void;
  /** A record was written. A duplicate writes nothing, so the dialog stays open and says so. */
  onSaved(result: ActiveRecordSaved): void;
}

type RecordKind = ProactiveRecordInput["kind"] | "historical";
/** What a 历史决定 holds beyond the title, content, project and source every kind has. */
type HistoricalExtra = Omit<HistoricalFormState, "title" | "decision" | "project" | "sourceKind">;

const kindLabel: Record<RecordKind, string> = { decision: "决策", historical: "历史决定", preference: "偏好", idea: "想法" };
const kindContentLabel: Record<RecordKind, string> = {
  decision: "最终选择",
  historical: "最终决定",
  preference: "当前偏好",
  idea: "想法内容",
};

const historicalExtra = (draft: ActiveRecordDraft | undefined): HistoricalExtra => {
  const { title: _title, decision: _decision, project: _project, sourceKind: _source, ...extra } = emptyHistoricalForm();
  return { ...extra, options: (draft?.historical?.options ?? []).join("\n"), context: draft?.kind === "historical" ? draft.context ?? "" : "" };
};

export const ActiveRecordDialog = ({
  api,
  draft,
  initialKind,
  onClose,
  onSaved,
}: ActiveRecordDialogProps) => {
  const [restored, setRestored] = useState(() => draft === undefined ? loadActiveRecordDraft() : { value: null, error: null });
  const offersHistorical = api.recordHistoricalDecision !== undefined;
  const [kind, setKind] = useState<RecordKind>(() => {
    const opened = draft?.kind ?? initialKind ?? restored.value?.kind ?? "decision";
    return opened === "historical" && !offersHistorical ? "decision" : opened;
  });
  const [history, setHistory] = useState<HistoricalExtra>(() => (draft === undefined ? restored.value?.historical : undefined) ?? historicalExtra(draft));
  // Opened from a captured choice, what it carried over is under the fold: shown, so it is checked before it is saved.
  const [moreOpen, setMoreOpen] = useState(() => historicalMoreFilled({ ...emptyHistoricalForm(), ...history }) > 0);
  const [replaceable, setReplaceable] = useState<HistoricalDecision[]>([]);
  const listHistorical = api.listHistoricalDecisions;
  useEffect(() => {
    if (kind !== "historical" || !moreOpen || listHistorical === undefined) return;
    let current = true;
    // The choices for 替代哪条历史决定: without them the field still says 不替代, and the rest of the form saves.
    void listHistorical({ limit: 100 }).then((listed) => { if (current) setReplaceable(listed.records); }, () => undefined);
    return () => { current = false; };
  }, [kind, moreOpen, listHistorical]);
  const [title, setTitle] = useState(draft?.title ?? restored.value?.title ?? "");
  const [content, setContent] = useState(draft?.content ?? restored.value?.content ?? "");
  const [project, setProject] = useState(draft?.project ?? restored.value?.project ?? "");
  // Only a draft from elsewhere has one: what it was said about, shown so the reader can check it, trim it or add to it.
  const [context, setContext] = useState(draft?.context ?? "");
  const [sourceKind, setSourceKind] = useState<UserJournalSourceKind>(restored.value?.sourceKind ?? "app_manual");
  const [rationale, setRationale] = useState(draft?.rationale ?? restored.value?.rationale ?? "");
  const [expectedOutcome, setExpectedOutcome] = useState(restored.value?.expectedOutcome ?? "");
  const [reviewDueDate, setReviewDueDate] = useState(restored.value?.reviewDueDate ?? "");
  const [appliesWhen, setAppliesWhen] = useState(restored.value?.appliesWhen ?? "");
  const [exceptions, setExceptions] = useState(restored.value?.exceptions ?? "");
  const [strength, setStrength] = useState<"hard_constraint" | "default" | "weak_signal">(restored.value?.strength ?? "default");
  // Shown as 默认偏好 until one is picked: sent only once picked, so recording an entry again does not
  // soften the hard constraint it was by a choice nobody made.
  const [strengthChosen, setStrengthChosen] = useState((restored.value?.strength ?? "default") !== "default");
  const [whyInteresting, setWhyInteresting] = useState(restored.value?.whyInteresting ?? "");
  const [nextTest, setNextTest] = useState(restored.value?.nextTest ?? "");
  const [languages, setLanguages] = useState(restored.value?.languages ?? "");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const contextId = useId();
  const adoptedReasonId = useId();
  const prependReasonId = useId();
  const [summary, setSummary] = useState<ContextSummary>({ step: "idle" });
  // The one the form waits on; a cancelled or replaced one answers into nothing.
  const summaryRun = useRef<string | null>(null);
  const summarizeButton = useRef<HTMLButtonElement>(null);
  const firstChoice = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once a choice has taken away the button pressed: left alone, it fell to the page behind.
  const focusNext = useRef<{ current: HTMLElement | null } | null>(null);
  useEffect(() => {
    focusNext.current?.current?.focus();
    focusNext.current = null;
  });
  const summarizer = api.summarizeRecordContext === undefined || api.cancelRecordContextSummary === undefined || draft?.context === undefined
    ? null : { summarize: api.summarizeRecordContext, cancel: api.cancelRecordContextSummary };
  const cancelOnClose = useRef(summarizer?.cancel);
  cancelOnClose.current = summarizer?.cancel;
  // Closed or saved while a summary runs, nobody is left to read it: the local model is let go.
  useEffect(() => () => {
    const running = summaryRun.current;
    if (running !== null) void cancelOnClose.current?.(running).catch(() => undefined);
  }, []);
  const validationId = useId();
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(restored.error);
  const historicalForm: HistoricalFormState = {
    ...history,
    title,
    decision: content,
    project,
    // 个人观察 is a preference's or an idea's source: a decision someone made was not observed.
    sourceKind: draft?.historical?.sourceKind ?? (sourceKind === "observation" ? "app_manual" : sourceKind),
  };
  const historicalTouched = historicalMoreFilled(historicalForm) > 0 || history.tags.length > 0;
  const rawDraft = JSON.stringify({ version: 1, kind, title, content, project, sourceKind, rationale,
    expectedOutcome, reviewDueDate, appliesWhen, exceptions, strength, whyInteresting, nextTest, languages,
    ...(kind === "historical" || historicalTouched ? { historical: history } : {}) });
  const hasDraftContent = historicalTouched || [title, content, project, rationale, expectedOutcome, reviewDueDate,
    appliesWhen, exceptions, whyInteresting, nextTest, languages].some((value) => value.length > 0);
  // What it opened with. A form begun here is kept as a draft on this device; one opened from an answer or a
  // comment is kept nowhere, so once changed only 取消 closes it, not a stray Escape or click outside.
  const [openedWith] = useState(rawDraft);
  // A summary waited for, or still coming, is not thrown away by a stray Escape either.
  const unchanged = rawDraft === openedWith && context === (draft?.context ?? "") && summary.step !== "running" && summary.step !== "ready";
  const keptElsewhere = draft === undefined && restored.error === null && draftError === null;

  useEffect(() => {
    if (draft !== undefined || restored.error !== null) return;
    try {
      if (hasDraftContent) saveActiveRecordDraft(JSON.parse(rawDraft));
      else clearActiveRecordDraft();
      setDraftError(null);
    } catch {
      setDraftError("草稿暂时无法保存，请保留此窗口或先复制内容。正式记录仍可保存。");
    }
  }, [draft, restored.error, rawDraft, hasDraftContent]);

  const discardDraft = (): void => {
    try {
      clearActiveRecordDraft();
    } catch {
      setDraftError("草稿无法清除，当前内容仍保留，请稍后重试。");
      return;
    }
    setRestored({ value: null, error: null });
    setKind("decision"); setTitle(""); setContent(""); setProject("");
    setSourceKind("app_manual"); setRationale(""); setExpectedOutcome(""); setReviewDueDate("");
    setAppliesWhen(""); setExceptions(""); setStrength("default"); setStrengthChosen(false); setWhyInteresting(""); setNextTest(""); setLanguages("");
    setHistory(historicalExtra(undefined)); setMoreOpen(false);
    setError(null); setDraftError(null);
  };

  const switchKind = (next: RecordKind): void => {
    setKind(next);
    setError(null);
    // It was about the kind just left; this one has not been tried.
    setDuplicate(false);
  };

  const common = {
    title: title.trim(),
    content: content.trim(),
    sourceKind,
    sourceForm:
      draft === undefined && sourceKind === "app_manual"
        ? ("user_original" as const)
        : ("user_paraphrase" as const),
    sensitivity: "private" as const,
    ...(project.trim().length === 0 ? {} : { project: project.trim() }),
    ...(context.trim().length === 0 ? {} : { context: context.trim() }),
    ...(rationale.trim().length === 0 ? {} : { rationale: rationale.trim() }),
    tags: [],
  };
  // A preference or an idea only: none said, it holds whatever the code is written in.
  const languagesSaid = languagesTyped(languages);
  const specificTo = languagesSaid.length === 0 ? {} : { languages: languagesSaid };
  const input: ProactiveRecordInput =
    kind === "decision" || kind === "historical"
      ? {
          ...common,
          ...(draft?.source === undefined ? {} : { sourceKind: "pr_comment" as const, sourceUrl: draft.source.url }),
          kind: "decision",
          knowledgeStatus: "active",
          options: [],
          ...(reviewDueDate === "" ? {} : { reviewDueDate }),
          ...(expectedOutcome.trim().length === 0
            ? {}
            : { expectedOutcome: expectedOutcome.trim() }),
        }
      : kind === "preference"
        ? {
            ...common,
            ...specificTo,
            kind,
            ...(appliesWhen.trim().length === 0 ? {} : { appliesWhen: appliesWhen.trim() }),
            ...(exceptions.trim().length === 0 ? {} : { exceptions: exceptions.trim() }),
            ...(strengthChosen ? { strength } : {}),
          }
        : {
            ...common,
            ...specificTo,
            kind,
            ...(whyInteresting.trim().length === 0
              ? {}
              : { whyInteresting: whyInteresting.trim() }),
            openQuestions: [],
            ...(nextTest.trim().length === 0 ? {} : { nextTest: nextTest.trim() }),
          };
  const validation = proactiveRecordInputSchema.safeParse(input);
  // A 历史决定 is checked by its own rules: the three kinds' schema above is not asked about it.
  const historicalProblem = kind === "historical" ? historicalFormProblem(historicalForm) : null;
  const savable = kind === "historical" ? historicalProblem === null && historicalFormComplete(historicalForm) : validation.success;
  const issue = kind === "historical" || validation.success ? undefined : validation.error.issues.find((item) => item.code !== "too_small");
  const labels: Record<string, string> = {
    title: "标题", content: kindContentLabel[kind], project: "项目", sourceKind: "来源",
    rationale: "补充说明", expectedOutcome: "预期结果", appliesWhen: "适用条件",
    exceptions: "例外与边界", whyInteresting: "为什么值得保留", nextTest: "下一步验证",
    reviewDueDate: "复盘日期", languages: "适用语言", context: "当时上下文",
  };
  const validationMessage = issue === undefined ? null :
    issue.code === "too_big"
      ? `${labels[String(issue.path[0])] ?? "记录内容"}最多 ${issue.maximum} ${issue.origin === "array" ? "项" : "个字符"}，请缩短后再保存。`
      : "请检查记录内容后再保存。";
  const fieldProps = (name: string) => ({
    disabled: saving,
    "aria-invalid": issue?.path[0] === name || undefined,
    "aria-describedby": issue?.path[0] === name ? validationId : undefined,
  });

  const startSummary = async (): Promise<void> => {
    if (summarizer === null) return;
    const requestId = crypto.randomUUID();
    summaryRun.current = requestId;
    setSummary({ step: "running" });
    try {
      const result = await summarizer.summarize({
        requestId, context: context.trim(),
        ...(title.trim() === "" ? {} : { title: clipText(title.trim(), 500) }),
        ...(content.trim() === "" ? {} : { choice: clipText(content.trim(), 8_000) }),
      });
      if (summaryRun.current !== requestId) return;
      setSummary(result.status === "unavailable" ? { step: "unavailable", reason: result.reason }
        : { step: "ready", text: result.summary, clipped: result.clipped });
    } catch (caught) {
      if (summaryRun.current !== requestId) return;
      setSummary({ step: "failed", message: caught instanceof Error && caught.message !== "" ? caught.message : "总结没有完成，可以稍后重试。" });
    } finally {
      if (summaryRun.current === requestId) summaryRun.current = null;
    }
  };
  const cancelSummary = (): void => {
    const running = summaryRun.current;
    summaryRun.current = null;
    setSummary({ step: "idle", note: "已取消总结，上下文没有改动。" });
    if (running !== null) void summarizer?.cancel(running).catch(() => undefined);
  };
  const adoptSummary = (how: "replace" | "prepend"): void => {
    if (summary.step !== "ready") return;
    // In front of nothing, it is in place of it.
    const kept = how === "prepend" && context.trim() !== "" ? context : undefined;
    const adopted = adoptedSummaryContext(summary.text, kept);
    setContext(adopted);
    setSummary({ step: "adopted", text: summary.text, clipped: summary.clipped, how: kept === undefined ? "replace" : "prepend",
      before: context, adopted, prefix: kept === undefined ? null : adopted.slice(0, adopted.length - kept.length) });
    focusNext.current = undoButton;
  };
  /**
   * What 撤回 puts back, or null where it would drop what the reader changed since adopting: put back whole, the
   * context before it took their later edits with it. A summary put in front comes off and leaves the rest as it now is.
   */
  const undone = summary.step !== "adopted" ? null
    : summary.prefix !== null ? (context.startsWith(summary.prefix) ? context.slice(summary.prefix.length) : null)
      : context === summary.adopted ? summary.before : null;
  // Put in front past the context's limit, the record could not be saved until the reader found what to cut.
  const prependFits = summary.step !== "ready" || adoptedSummaryContext(summary.text, context).trim().length <= CONTEXT_MAX_CHARS;
  // Why an adopted summary holds back 用本机模型总结, and 撤回 too once the context was edited since.
  const adoptedReason = summary.step !== "adopted" ? null : undone !== null ? "已采用总结；如需重新总结，请先撤回。"
    : "采用后又改过上下文，撤回会丢掉这些修改，所以撤回和重新总结都不可用；要去掉总结，请直接在上面删改。";
  const undoSummary = (): void => {
    if (summary.step !== "adopted" || undone === null) return;
    setContext(undone);
    setSummary({ step: "ready", text: summary.text, clipped: summary.clipped });
    focusNext.current = firstChoice;
  };

  const save = async (): Promise<void> => {
    if (savingRef.current || !savable) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setDuplicate(false);
    try {
      const result: ActiveRecordSaved | { status: "duplicate" } = kind === "historical"
        ? await api.recordHistoricalDecision!(historicalDecisionInput(historicalForm)).then((saved) =>
            saved.status === "duplicate" ? { status: "duplicate" as const } : { recordKind: "historical_decision" as const, recordId: saved.record.id, status: "created" as const })
        : await api.createProactiveRecord(validation.data!);
      // Nothing was written: what the reader filled in, and the draft holding it, stay theirs.
      if (result.status === "duplicate") {
        setDuplicate(true);
        return;
      }
      if (draft === undefined && restored.error === null) {
        try { clearActiveRecordDraft(); } catch { /* The saved record remains authoritative. */ }
      }
      onSaved(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // Said under the field it is about; one the form does not show (a limit on tags, say) under the whole form.
  const fieldError = (name: string) =>
    validationMessage !== null && issue?.path[0] === name
      ? <p className="form-field-error" role="alert" id={validationId}>{validationMessage}</p>
      : null;
  const shownFields = new Set(["title", "sourceKind", "content", "context", "appliesWhen", "exceptions", "strength",
    "whyInteresting", "nextTest", "expectedOutcome", "reviewDueDate", "languages", "project", "rationale"]);
  const formId = `${contextId}-form`;
  const keepsDraft = draft === undefined && hasDraftContent && draftError === null;

  return (
    <ModalDialog
      title="主动记录"
      description={offersHistorical ? "记录明确的决策、只需留档的历史决定、可复用偏好或尚待验证的想法。默认仅本地私密保存。" : "记录明确的决策、可复用偏好或尚待验证的想法。默认仅本地私密保存。"}
      size="wide"
      dismissible={!saving}
      unsaved={!keptElsewhere && !unchanged}
      onClose={onClose}
      // On the dialog, not its form: the footer's buttons sit outside the form, and ⌘↩ must work from them too.
      onKeyDown={(event) => {
        if (!isSubmitShortcut(event)) return;
        event.preventDefault();
        if (savingRef.current || !savable) {
          return;
        }
        void save();
      }}
      footer={
        <>
          {/* Throwing the draft away is apart from the rest, at the start, in the danger colour; where it stands is said beside it. */}
          <div className="modal-dialog-footer-start active-record-draft">
            {draft === undefined && (hasDraftContent || restored.error !== null) ? (
              <button type="button" className="text-button danger-button" disabled={saving} onClick={discardDraft}>清空草稿</button>
            ) : null}
            {draftError === null && draft === undefined && hasDraftContent ? (
              <p role="status">{restored.value === null ? "草稿已保存在本机，关闭后可继续填写。" : "已恢复上次草稿，修改会继续保存在本机。"}</p>
            ) : null}
          </div>
          <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>{keepsDraft ? "关闭并保留草稿" : "取消"}</button>
          <button
            type="submit"
            form={formId}
            className="primary-button"
            disabled={saving || !savable}
            aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
            title={`${submitShortcutLabel()} 保存记录`}
          >
            {saving ? "保存中…" : "保存记录"}
            <kbd className="shortcut-hint" aria-hidden="true">
              {submitShortcutLabel()}
            </kbd>
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="active-record-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="active-record-kinds" role="group" aria-label="记录类型">
          {(["decision", "historical", "preference", "idea"] as const).filter((value) => value !== "historical" || offersHistorical).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              disabled={saving || (draft?.source !== undefined && value !== "decision")}
              onClick={() => switchKind(value)}
            >
              {kindLabel[value]}
            </button>
          ))}
          {kind === "historical" ? <span className="active-record-kind-note">只留档：不用写理由，不进入待补理由和复盘</span> : null}
        </div>

        {kind === "historical" ? (() => {
          const fields = {
            idPrefix: formId,
            form: historicalForm,
            disabled: saving,
            problem: historicalProblem,
            candidates: replaceable,
            fixedSource: draft?.historical?.sourceKind !== undefined,
            onChange: ({ title: nextTitle, decision, project: nextProject, sourceKind: nextSource, ...extra }: Partial<HistoricalFormState>) => {
              if (nextTitle !== undefined) setTitle(nextTitle);
              if (decision !== undefined) setContent(decision);
              if (nextProject !== undefined) setProject(nextProject);
              // pr_comment has no place among the other kinds' sources: kept for this kind alone, as the form's own.
              if (nextSource !== undefined && nextSource !== "pr_comment" && nextSource !== "agent_capture") setSourceKind(nextSource);
              if (Object.keys(extra).length > 0) setHistory((current) => ({ ...current, ...extra }));
            },
          };
          const more = historicalMoreFilled(historicalForm);
          return (
            <div className="form-fields">
              <div className="form-fields-row historical-record-head">
                <HistoricalField {...fields} name="title" />
                <HistoricalField {...fields} name="decidedOn" />
              </div>
              <HistoricalField {...fields} name="decision" />
              <div className="form-fields-row">
                <HistoricalField {...fields} name="project" optional />
                <HistoricalField {...fields} name="sourceKind" />
                <HistoricalField {...fields} name="tags" optional />
              </div>
              <button type="button" className="historical-more-toggle" aria-expanded={moreOpen} aria-controls={`${formId}-more`} onClick={() => setMoreOpen((open) => !open)}>
                <svg viewBox="0 0 12 12" aria-hidden="true"><path d={moreOpen ? "m3 4.75 3 3 3-3" : "m4.5 3 3 3-3 3"} /></svg>
                更多追踪信息（可选）
                <span>已填 {more} 项</span>
              </button>
              <div id={`${formId}-more`} className="form-fields" hidden={!moreOpen}>
                {moreOpen ? <HistoricalMoreFields {...fields} /> : null}
              </div>
            </div>
          );
        })() : (
        <div className="form-fields">
          <div className="form-fields-row">
            <div className="form-field">
              <label htmlFor={`${formId}-title`}>标题</label>
              <input id={`${formId}-title`} {...fieldProps("title")} value={title} required onChange={(event) => setTitle(event.currentTarget.value)} />
              {fieldError("title")}
            </div>
            <div className="form-field">
              <label htmlFor={`${formId}-source`}>来源</label>
              {draft?.source === undefined ? (
                <select id={`${formId}-source`} {...fieldProps("sourceKind")} value={sourceKind} onChange={(event) => setSourceKind(event.currentTarget.value as UserJournalSourceKind)}>
                  <option value="app_manual">现在手动记录</option>
                  <option value="offline_conversation">线下交流</option>
                  <option value="meeting">会议</option>
                  <option value="observation">个人观察</option>
                </select>
              ) : (
                <input id={`${formId}-source`} value={draft.source.label} readOnly />
              )}
              {fieldError("sourceKind")}
            </div>
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-content`}>{kindContentLabel[kind]}</label>
            <textarea id={`${formId}-content`} {...fieldProps("content")} value={content} required rows={4} onChange={(event) => setContent(event.currentTarget.value)} />
            {fieldError("content")}
          </div>
          {draft?.context === undefined ? null : (
            <div className="form-field active-record-context">
              <div className="active-record-context-head">
                <label htmlFor={contextId}>当时上下文（可修改）</label>
                {summarizer === null ? null : (
                  // One button for both, so focus stays on it: pressed again while it runs, it stops the summary.
                  <button
                    ref={summarizeButton}
                    type="button"
                    className="secondary-button"
                    // Not again over an adopted summary: the context before it is kept only until 撤回. Summarized again
                    // after an edit, it was gone for good, and a second summary put in front of the first marked twice.
                    disabled={saving || summary.step === "adopted" || (summary.step !== "running" && context.trim() === "")}
                    aria-describedby={summary.step === "adopted" ? adoptedReasonId : undefined}
                    onClick={summary.step === "running" ? cancelSummary : () => void startSummary()}
                  >
                    {summary.step === "running" ? "取消总结" : "用本机模型总结"}
                  </button>
                )}
              </div>
              <textarea id={contextId} aria-label="当时上下文" {...fieldProps("context")} readOnly={summary.step === "running"} value={context} rows={6} onChange={(event) => setContext(event.currentTarget.value)} />
              {fieldError("context")}
              {summary.step === "running" ? (
                <p className="active-record-summary-note" role="status">本机模型正在总结，通常要几秒到十几秒，可以随时取消。</p>
              ) : summary.step === "idle" ? (
                summary.note === undefined ? null : <p className="active-record-summary-note" role="status">{summary.note}</p>
              ) : summary.step === "unavailable" ? (
                <p className="active-record-summary-note" role="status">{summary.reason}</p>
              ) : summary.step === "failed" ? (
                <p className="form-field-error" role="alert">{summary.message}原上下文没有改动。</p>
              ) : summary.step === "ready" ? (
                <section className="active-record-summary" aria-label="本机模型总结">
                  <p className="active-record-summary-caution" role="status">
                    本机模型生成，可能遗漏或有误，请核对{summary.clipped ? "；上下文较长，模型只读了开头和结尾" : ""}。
                  </p>
                  <p className="active-record-summary-text">{summary.text}</p>
                  <div className="active-record-summary-actions">
                    <button ref={firstChoice} type="button" className="secondary-button" disabled={saving} onClick={() => adoptSummary("replace")}>用总结替换上下文</button>
                    <button type="button" className="secondary-button" disabled={saving || !prependFits}
                      aria-describedby={prependFits ? undefined : prependReasonId} onClick={() => adoptSummary("prepend")}>放在上下文前面</button>
                    <button type="button" className="text-button" disabled={saving} onClick={() => { setSummary({ step: "idle" }); focusNext.current = summarizeButton; }}>不用</button>
                  </div>
                  {prependFits ? null : (
                    <p id={prependReasonId} className="active-record-summary-note">放在前面后当时上下文会超过 {CONTEXT_MAX_CHARS} 个字符的上限，可以先删减上下文，或用总结替换。</p>
                  )}
                </section>
              ) : (
                <>
                  <div className="active-record-summary-adopted">
                    {/* Said only while it is so: the mark is the reader's to take out, as anything else in their text. */}
                    <p className="active-record-summary-note" role="status">
                      {summary.how === "replace" ? "已用总结替换上下文" : "已把总结放在上下文前面"}
                      {context.startsWith(CONTEXT_SUMMARY_LINES.mark) ? "，开头注明了是本机模型总结" : ""}。
                    </p>
                    <button ref={undoButton} type="button" className="text-button" disabled={saving || undone === null}
                      aria-describedby={undone === null ? adoptedReasonId : undefined} onClick={undoSummary}>撤回，恢复原上下文</button>
                  </div>
                  <p id={adoptedReasonId} className="active-record-summary-note">{adoptedReason}</p>
                </>
              )}
            </div>
          )}

          {kind === "preference" ? (
            <>
              <div className="form-field">
                <label htmlFor={`${formId}-applies`}>适用条件</label>
                <textarea id={`${formId}-applies`} {...fieldProps("appliesWhen")} value={appliesWhen} rows={2} onChange={(event) => setAppliesWhen(event.currentTarget.value)} />
                {fieldError("appliesWhen")}
              </div>
              <div className="form-field">
                <label htmlFor={`${formId}-exceptions`}>例外与边界</label>
                <textarea id={`${formId}-exceptions`} {...fieldProps("exceptions")} value={exceptions} rows={2} onChange={(event) => setExceptions(event.currentTarget.value)} />
                {fieldError("exceptions")}
              </div>
            </>
          ) : kind === "idea" ? (
            <>
              <div className="form-field">
                <label htmlFor={`${formId}-why`}>为什么值得保留（可选）</label>
                <textarea id={`${formId}-why`} aria-label="为什么值得保留" {...fieldProps("whyInteresting")} value={whyInteresting} rows={2} onChange={(event) => setWhyInteresting(event.currentTarget.value)} />
                {fieldError("whyInteresting")}
              </div>
              <div className="form-field">
                <label htmlFor={`${formId}-next`}>下一步验证（可选）</label>
                <textarea id={`${formId}-next`} aria-label="下一步验证" {...fieldProps("nextTest")} value={nextTest} rows={2} onChange={(event) => setNextTest(event.currentTarget.value)} />
                {fieldError("nextTest")}
              </div>
            </>
          ) : (
            <div className="form-field">
              <label htmlFor={`${formId}-expected`}>预期结果（可选）</label>
              <textarea id={`${formId}-expected`} aria-label="预期结果" {...fieldProps("expectedOutcome")} value={expectedOutcome} rows={2} onChange={(event) => setExpectedOutcome(event.currentTarget.value)} />
              {fieldError("expectedOutcome")}
            </div>
          )}

          <div className="form-fields-row">
            {kind === "decision" ? (
              <div className="form-field">
                <label htmlFor={`${formId}-review`}>复盘日期（可选）</label>
                <input id={`${formId}-review`} type="date" aria-label="复盘日期" {...fieldProps("reviewDueDate")}
                  aria-describedby={[issue?.path[0] === "reviewDueDate" ? validationId : null, `${formId}-review-help`].filter(Boolean).join(" ")}
                  value={reviewDueDate} onChange={(event) => setReviewDueDate(event.currentTarget.value)} />
                {fieldError("reviewDueDate")}
                <p id={`${formId}-review-help`}>到期后出现在首页复盘收件箱。</p>
              </div>
            ) : kind === "preference" ? (
              <div className="form-field">
                <label htmlFor={`${formId}-strength`}>偏好强度</label>
                <select id={`${formId}-strength`} {...fieldProps("strength")} value={strength} onChange={(event) => { setStrength(event.currentTarget.value as typeof strength); setStrengthChosen(true); }}>
                  <option value="hard_constraint">硬约束</option>
                  <option value="default">默认偏好</option>
                  <option value="weak_signal">弱信号</option>
                </select>
                {fieldError("strength")}
              </div>
            ) : (
              <div className="form-field">
                <label htmlFor={`${formId}-languages`}>适用语言（可选）</label>
                <input id={`${formId}-languages`} aria-label="适用语言" {...fieldProps("languages")} value={languages} placeholder="如 Go、TypeScript；留空表示各语言通用" onChange={(event) => setLanguages(event.currentTarget.value)} />
                {fieldError("languages")}
              </div>
            )}
            <div className="form-field">
              <label htmlFor={`${formId}-project`}>项目（可选）</label>
              <input id={`${formId}-project`} aria-label="项目" {...fieldProps("project")} value={project} onChange={(event) => setProject(event.currentTarget.value)} />
              {fieldError("project")}
            </div>
          </div>
          {kind === "preference" ? (
            <div className="form-field">
              <label htmlFor={`${formId}-languages`}>适用语言（可选）</label>
              <input id={`${formId}-languages`} aria-label="适用语言" {...fieldProps("languages")} value={languages} placeholder="如 Go、TypeScript；留空表示各语言通用" onChange={(event) => setLanguages(event.currentTarget.value)} />
              {fieldError("languages")}
            </div>
          ) : null}
          <div className="form-field">
            <label htmlFor={`${formId}-rationale`}>{kind === "decision" ? "理由（可稍后补充）" : "补充说明（可选）"}</label>
            {/* Named as shown, so a reader saying the label they see reaches it. */}
            <textarea id={`${formId}-rationale`} aria-label={kind === "decision" ? "理由" : "补充说明"} {...fieldProps("rationale")} value={rationale} rows={2} onChange={(event) => setRationale(event.currentTarget.value)} />
            {fieldError("rationale")}
          </div>
        </div>
        )}

        <p className="active-record-privacy">
          {draft?.source === undefined
            ? "仅保存整理后的字段，不保存会议、聊天或录音原文。"
            : "决策会保留这条 PR 评论的链接；标题请改写成当时要决定的问题。"}
        </p>
        {draftError === null ? null : <p className="form-error" role="alert">{draftError}</p>}
        {validationMessage === null || shownFields.has(String(issue?.path[0])) ? null : <p className="form-error" role="alert" id={validationId}>{validationMessage}</p>}
        {error === null ? null : <p className="form-error" role="alert">保存失败：{error}</p>}
        {duplicate ? (
          <p className="form-error" role="alert">
            {draft?.source !== undefined
              ? "这条 PR 评论已经记为决策，这次填写的内容没有保存。"
              : kind === "historical"
                ? "已有事项、决定、项目和日期都相同的历史决定，没有重复保存。可以改动后再保存，或到「知识 › 历史决定」修改原记录。"
              : kind === "decision"
                ? `已有标题和${kindContentLabel[kind]}都相同的记录，这次填写的其它内容没有保存。可以改动后再保存，或到知识页修改原记录。`
                // A preference or idea with anything new is kept as a revision; one reported here says nothing new.
                : "已有一模一样的记录，没有重复保存。"}
          </p>
        ) : null}
      </form>
    </ModalDialog>
  );
};
