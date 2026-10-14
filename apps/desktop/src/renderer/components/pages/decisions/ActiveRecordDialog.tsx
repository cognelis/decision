import { useEffect, useId, useRef, useState } from "react";

import { proactiveRecordInputSchema } from "../../../../shared/proactive-record.js";
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
}

/** Only what the form actually calls, so callers need promise no more. */
export type ActiveRecordApi = Pick<DecisionApi, "createProactiveRecord">;

interface ActiveRecordDialogProps {
  api: ActiveRecordApi;
  /**
   * Present when the text started somewhere other than this form — today, an
   * assistant answer. It is never saved as `user_original`: that value claims
   * the reader's own words, and a claim about provenance in a permanent record
   * has to be true even when the reader accepts the draft verbatim.
   */
  draft?: ActiveRecordDraft;
  onClose(): void;
  /** A record was written. A duplicate writes nothing, so the dialog stays open and says so. */
  onSaved(result: ProactiveRecordResult): void;
}

type RecordKind = ProactiveRecordInput["kind"];

const kindContentLabel: Record<RecordKind, string> = {
  decision: "最终选择",
  preference: "当前偏好",
  idea: "想法内容",
};

export const ActiveRecordDialog = ({
  api,
  draft,
  onClose,
  onSaved,
}: ActiveRecordDialogProps) => {
  const [restored, setRestored] = useState(() => draft === undefined ? loadActiveRecordDraft() : { value: null, error: null });
  const [kind, setKind] = useState<RecordKind>(restored.value?.kind ?? "decision");
  const [title, setTitle] = useState(draft?.title ?? restored.value?.title ?? "");
  const [content, setContent] = useState(draft?.content ?? restored.value?.content ?? "");
  const [project, setProject] = useState(draft?.project ?? restored.value?.project ?? "");
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
  const validationId = useId();
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(restored.error);
  const rawDraft = JSON.stringify({ version: 1, kind, title, content, project, sourceKind, rationale,
    expectedOutcome, reviewDueDate, appliesWhen, exceptions, strength, whyInteresting, nextTest, languages });
  const hasDraftContent = [title, content, project, rationale, expectedOutcome, reviewDueDate,
    appliesWhen, exceptions, whyInteresting, nextTest, languages].some((value) => value.length > 0);
  // What it opened with. A form begun here is kept as a draft on this device; one opened from an answer or a
  // comment is kept nowhere, so once changed only 取消 closes it, not a stray Escape or click outside.
  const [openedWith] = useState(rawDraft);
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
    ...(draft?.context === undefined ? {} : { context: draft.context }),
    ...(rationale.trim().length === 0 ? {} : { rationale: rationale.trim() }),
    tags: [],
  };
  // A preference or an idea only: none said, it holds whatever the code is written in.
  const languagesSaid = languagesTyped(languages);
  const specificTo = languagesSaid.length === 0 ? {} : { languages: languagesSaid };
  const input: ProactiveRecordInput =
    kind === "decision"
      ? {
          ...common,
          ...(draft?.source === undefined ? {} : { sourceKind: "pr_comment" as const, sourceUrl: draft.source.url }),
          kind,
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
  const issue = validation.success ? undefined : validation.error.issues.find((item) => item.code !== "too_small");
  const labels: Record<string, string> = {
    title: "标题", content: kindContentLabel[kind], project: "项目", sourceKind: "来源",
    rationale: "补充说明", expectedOutcome: "预期结果", appliesWhen: "适用条件",
    exceptions: "例外与边界", whyInteresting: "为什么值得保留", nextTest: "下一步验证",
    reviewDueDate: "复盘日期", languages: "适用语言",
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

  const save = async (): Promise<void> => {
    if (savingRef.current || !validation.success) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    setDuplicate(false);
    try {
      const result = await api.createProactiveRecord(validation.data);
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

  return (
    <ModalDialog
      title="主动记录"
      description="记录明确的决策、可复用偏好或尚待验证的想法。默认仅本地私密保存。"
      size="wide"
      dismissible={!saving && (keptElsewhere || rawDraft === openedWith)}
      onClose={onClose}
    >
      <form
        className="active-record-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          if (!isSubmitShortcut(event)) return;
          event.preventDefault();
          if (savingRef.current || !validation.success) {
            return;
          }
          void save();
        }}
      >
        <div className="active-record-kinds" role="group" aria-label="记录类型">
          {(["decision", "preference", "idea"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              disabled={saving || (draft?.source !== undefined && value !== "decision")}
              onClick={() => switchKind(value)}
            >
              {value === "decision" ? "决策" : value === "preference" ? "偏好" : "想法"}
            </button>
          ))}
        </div>

        <div className="active-record-grid">
          <label>
            <span>标题</span>
            <input aria-label="标题" {...fieldProps("title")} value={title} required onChange={(event) => setTitle(event.currentTarget.value)} />
          </label>
          <label>
            <span>来源</span>
            {draft?.source === undefined ? (
              <select aria-label="来源" {...fieldProps("sourceKind")} value={sourceKind} onChange={(event) => setSourceKind(event.currentTarget.value as UserJournalSourceKind)}>
                <option value="app_manual">现在手动记录</option>
                <option value="offline_conversation">线下交流</option>
                <option value="meeting">会议</option>
                <option value="observation">个人观察</option>
              </select>
            ) : (
              <input aria-label="来源" value={draft.source.label} readOnly />
            )}
          </label>
          <label className="active-record-wide">
            <span>{kindContentLabel[kind]}</span>
            <textarea aria-label={kindContentLabel[kind]} {...fieldProps("content")} value={content} required rows={4} onChange={(event) => setContent(event.currentTarget.value)} />
          </label>

          {kind === "preference" ? (
            <>
              <label className="active-record-wide">
                <span>适用条件</span>
                <textarea aria-label="适用条件" {...fieldProps("appliesWhen")} value={appliesWhen} rows={2} onChange={(event) => setAppliesWhen(event.currentTarget.value)} />
              </label>
              <label className="active-record-wide">
                <span>例外与边界</span>
                <textarea aria-label="例外与边界" {...fieldProps("exceptions")} value={exceptions} rows={2} onChange={(event) => setExceptions(event.currentTarget.value)} />
              </label>
              <label>
                <span>偏好强度</span>
                <select aria-label="偏好强度" {...fieldProps("strength")} value={strength} onChange={(event) => { setStrength(event.currentTarget.value as typeof strength); setStrengthChosen(true); }}>
                  <option value="hard_constraint">硬约束</option>
                  <option value="default">默认偏好</option>
                  <option value="weak_signal">弱信号</option>
                </select>
              </label>
            </>
          ) : kind === "idea" ? (
            <>
              <label className="active-record-wide">
                <span>为什么值得保留（可选）</span>
                <textarea aria-label="为什么值得保留" {...fieldProps("whyInteresting")} value={whyInteresting} rows={2} onChange={(event) => setWhyInteresting(event.currentTarget.value)} />
              </label>
              <label className="active-record-wide">
                <span>下一步验证（可选）</span>
                <textarea aria-label="下一步验证" {...fieldProps("nextTest")} value={nextTest} rows={2} onChange={(event) => setNextTest(event.currentTarget.value)} />
              </label>
            </>
          ) : (
            <>
            <label className="active-record-wide">
              <span>预期结果（可选）</span>
              <textarea aria-label="预期结果" {...fieldProps("expectedOutcome")} value={expectedOutcome} rows={2} onChange={(event) => setExpectedOutcome(event.currentTarget.value)} />
            </label>
            <label>
              <span>复盘日期（可选）</span>
              <input type="date" aria-label="复盘日期" {...fieldProps("reviewDueDate")} value={reviewDueDate} onChange={(event) => setReviewDueDate(event.currentTarget.value)} />
              <small>到期后出现在首页复盘收件箱。</small>
            </label>
            </>
          )}

          {kind === "decision" ? null : (
            <label>
              <span>适用语言（可选）</span>
              <input aria-label="适用语言" {...fieldProps("languages")} value={languages} placeholder="如 Go、TypeScript；留空表示各语言通用" onChange={(event) => setLanguages(event.currentTarget.value)} />
            </label>
          )}
          <label>
            <span>项目（可选）</span>
            <input aria-label="项目" {...fieldProps("project")} value={project} onChange={(event) => setProject(event.currentTarget.value)} />
          </label>
          <label className="active-record-wide">
            <span>{kind === "decision" ? "理由（可稍后补充）" : "补充说明（可选）"}</span>
            {/* Named as shown, so a reader saying the label they see reaches it. */}
            <textarea aria-label={kind === "decision" ? "理由" : "补充说明"} {...fieldProps("rationale")} value={rationale} rows={2} onChange={(event) => setRationale(event.currentTarget.value)} />
          </label>
        </div>

        <p className="active-record-privacy">
          {draft?.source === undefined
            ? "仅保存整理后的字段，不保存会议、聊天或录音原文。"
            : "决策会保留这条 PR 评论的链接；标题请改写成当时要决定的问题。"}
        </p>
        {draftError !== null ? <p className="error-message" role="alert">{draftError}</p> : draft === undefined && hasDraftContent ? (
          <p role="status">{restored.value === null ? "草稿已保存在本机，关闭后可继续填写。" : "已恢复上次草稿，修改会继续保存在本机。"}</p>
        ) : null}
        {validationMessage === null ? null : <p className="error-message" role="alert" id={validationId}>{validationMessage}</p>}
        {error === null ? null : <p className="error-message" role="alert">保存失败：{error}</p>}
        {duplicate ? (
          <p className="error-message" role="alert">
            {draft?.source !== undefined
              ? "这条 PR 评论已经记为决策，这次填写的内容没有保存。"
              : kind === "decision"
                ? `已有标题和${kindContentLabel[kind]}都相同的记录，这次填写的其它内容没有保存。可以改动后再保存，或到知识页修改原记录。`
                // A preference or idea with anything new is kept as a revision; one reported here says nothing new.
                : "已有一模一样的记录，没有重复保存。"}
          </p>
        ) : null}
        <footer className="active-record-actions">
          {draft === undefined && (hasDraftContent || restored.error !== null) ? (
            <button type="button" className="text-button" disabled={saving} onClick={discardDraft}>清空草稿</button>
          ) : null}
          <button type="button" className="text-button" disabled={saving} onClick={onClose}>{draft === undefined && hasDraftContent && draftError === null ? "关闭并保留草稿" : "取消"}</button>
          <button
            type="submit"
            className="primary-button"
            disabled={saving || !validation.success}
            aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
            title={`${submitShortcutLabel()} 保存记录`}
          >
            {saving ? "保存中…" : "保存记录"}
            <kbd className="shortcut-hint" aria-hidden="true">
              {submitShortcutLabel()}
            </kbd>
          </button>
        </footer>
      </form>
    </ModalDialog>
  );
};
