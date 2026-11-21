import type { AmendmentFields, AmendmentState } from "@cognelis/decision-protocol";

import { localDay } from "../todos/todo-dates.js";
import { historyDayLabel } from "../todos/todo-text.js";
import { OriginalWords } from "./AmendmentBlocks.js";
import { clientLabel, fieldHistory, READER } from "./amendment-view.js";

/** The five things a decision's reader wrote at the time, each with the words the page uses for editing it. */
export const DECISION_FIELDS = {
  question: { label: "问题", open: "编辑问题", save: "保存问题", max: 2_000, clearable: false, placeholder: "这条决策当时要回答的问题。" },
  choice: { label: "最终选择", open: "修改选择", save: "保存选择", max: 4_000, clearable: false, placeholder: "最后选了什么。" },
  rationale: { label: "决策理由", open: "修改理由", save: "保存理由", max: 8_000, clearable: true, placeholder: "写下当时为什么这样选。" },
  context: { label: "当时上下文", open: "修改上下文", save: "保存上下文", max: 8_000, clearable: true, placeholder: "当时的背景和约束。" },
  expectedOutcome: { label: "预期结果", open: "修改预期", save: "保存预期", max: 4_000, clearable: true, placeholder: "结果出来之前写下：做完之后预期会看到什么。" },
} as const;
export type DecisionField = keyof typeof DECISION_FIELDS;

export const STALE_TAG = "修改已失效";

/** 已修改 · 今天 (the reader's), 已被 Codex 修改 · 昨天 (another's): by whoever rewrote that field last. */
export const amendedTag = (state: AmendmentState | undefined, field: DecisionField, now = new Date()): string | null => {
  const last = fieldHistory(state, field).at(-1);
  if (last === undefined) return null;
  // The original has changed since: the rewrite is not in force, so it is not "已修改" either.
  if (state?.revised?.stale === true && field in state.revised.values) return STALE_TAG;
  const day = historyDayLabel(localDay(new Date(last.at)), localDay(now));
  return last.client === READER ? `已修改 · ${day}` : `已被 ${clientLabel(last.client)} 修改 · ${day}`;
};

/** The tag beside a section's title, and the original words one click away. */
export const AmendedMark = ({ state, field, original }: { state: AmendmentState | undefined; field: DecisionField; original: string | null | undefined }) => {
  const tag = amendedTag(state, field);
  if (tag === null) return null;
  return (
    <>
      <span className={`amendment-tag ${tag.startsWith("已修改") ? "count" : "rewritten"}`}>{tag}</span>
      {original === undefined ? null : <OriginalWords label="最初版本" lines={[{ name: null, text: original ?? "" }]} />}
    </>
  );
};

export interface FieldEdit {
  field: DecisionField;
  draft: string;
  reason: string;
  saving: boolean;
  error: string | null;
}

/** The editor the other sections use (a text box, the count, 取消 and 保存), with the reason for the change, which is optional. */
export const DecisionFieldEditor = ({ edit, onChange, onCancel, onSave }: {
  edit: FieldEdit;
  onChange(patch: Partial<Pick<FieldEdit, "draft" | "reason">>): void;
  onCancel(): void;
  onSave(): void;
}) => {
  const spec = DECISION_FIELDS[edit.field];
  const empty = edit.draft.trim().length === 0;
  return (
    <div className="decision-outcome-editor">
      <textarea
        aria-label={spec.label}
        autoFocus
        rows={edit.field === "question" ? 2 : 4}
        maxLength={spec.max}
        value={edit.draft}
        placeholder={spec.placeholder}
        onChange={(event) => onChange({ draft: event.currentTarget.value })}
      />
      <input
        type="text"
        aria-label="修改原因（可选）"
        placeholder="修改原因（可选）"
        maxLength={1_000}
        value={edit.reason}
        onChange={(event) => onChange({ reason: event.currentTarget.value })}
      />
      {edit.error === null ? null : <p className="form-error" role="alert">{spec.label}暂时无法保存：{edit.error}</p>}
      <div className="decision-outcome-editor-footer">
        <span>{edit.draft.length} / {spec.max}</span>
        <div>
          <button type="button" className="secondary-button" disabled={edit.saving} onClick={onCancel}>取消</button>
          <button type="button" className="primary-button" disabled={edit.saving || (empty && !spec.clearable) || (empty && spec.clearable && false)} onClick={onSave}>
            {edit.saving ? "保存中…" : spec.save}
          </button>
        </div>
      </div>
    </div>
  );
};

/** What a rewrite's values are, as the fields it touched: for a record's fields in force. */
export const valueOf = (rewrite: AmendmentFields | null, field: DecisionField): string | null | undefined =>
  rewrite !== null && field in rewrite ? rewrite[field] ?? null : undefined;
