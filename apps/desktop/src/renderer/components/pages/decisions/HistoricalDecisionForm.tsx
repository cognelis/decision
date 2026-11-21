import { HISTORICAL_REVERSIBILITY_LABELS, HISTORICAL_SOURCE_LABELS, localCalendarDate } from "@cognelis/decision-core/historical-decision";
import {
  HISTORICAL_DECISION_LIMITS as LIMITS,
  HISTORICAL_DECISION_VERSION,
  recordHistoricalDecisionRequestSchema,
  type HistoricalDecision,
  type HistoricalDecisionReversibility,
  type HistoricalDecisionSourceKind,
} from "@cognelis/decision-protocol";
import { useState, type ReactNode } from "react";

import type { HistoricalDecisionChange, HistoricalDecisionInput } from "../../../../shared/renderer-api.js";

/**
 * 历史决定's fields as a form holds them: what is typed, before it is a record. Lists typed a line each stay text
 * until saved, so a half-typed link is not thrown away between keystrokes.
 */
export interface HistoricalFormState {
  title: string;
  decision: string;
  decidedOn: string;
  project: string;
  sourceKind: HistoricalDecisionSourceKind;
  tags: string[];
  options: string;
  context: string;
  scope: string;
  participants: string[];
  reversibility: "" | HistoricalDecisionReversibility;
  references: string;
  relatedNotes: string;
  supersedesId: string;
  revisitCondition: string;
  notes: string;
}

export type HistoricalFieldName = keyof HistoricalFormState;

export const HISTORICAL_FIELD_LABELS: Readonly<Record<HistoricalFieldName, string>> = {
  title: "决定事项",
  decision: "最终决定",
  decidedOn: "决定日期",
  project: "项目",
  sourceKind: "来源",
  tags: "标签",
  options: "备选方案",
  context: "当时背景",
  scope: "影响范围",
  participants: "参与方",
  reversibility: "可逆性",
  references: "相关链接",
  relatedNotes: "关联笔记",
  supersedesId: "替代哪条历史决定",
  revisitCondition: "重看条件",
  notes: "补充备注",
};

/** The fields under 更多追踪信息: none of them is asked for. */
export const HISTORICAL_MORE_FIELDS = ["options", "context", "scope", "participants", "reversibility", "references", "relatedNotes", "supersedesId", "revisitCondition", "notes"] as const satisfies readonly HistoricalFieldName[];

export const emptyHistoricalForm = (now = new Date()): HistoricalFormState => ({
  title: "", decision: "", decidedOn: localCalendarDate(now), project: "", sourceKind: "app_manual", tags: [], options: "", context: "", scope: "",
  participants: [], reversibility: "", references: "", relatedNotes: "", supersedesId: "", revisitCondition: "", notes: "",
});

export const historicalFormOf = (record: HistoricalDecision): HistoricalFormState => ({
  title: record.title,
  decision: record.decision,
  decidedOn: record.decidedOn,
  project: record.project ?? "",
  sourceKind: record.sourceKind,
  tags: record.tags,
  options: record.options.join("\n"),
  context: record.context ?? "",
  scope: record.scope ?? "",
  participants: record.participants,
  reversibility: record.reversibility ?? "",
  references: record.references.map((reference) => (reference.label === undefined ? reference.url : `${reference.url} ${reference.label}`)).join("\n"),
  relatedNotes: record.relatedNotes.join("\n"),
  supersedesId: record.supersedesId ?? "",
  revisitCondition: record.revisitCondition ?? "",
  notes: record.notes ?? "",
});

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
const filled = (value: string | readonly string[]): boolean => (typeof value === "string" ? value.trim() !== "" : value.length > 0);

/** How many of the fields under 更多追踪信息 hold something. */
export const historicalMoreFilled = (form: HistoricalFormState): number => HISTORICAL_MORE_FIELDS.filter((name) => filled(form[name])).length;

/** The form as the record it would save: every field said, an empty one as null or an empty list. */
const said = (form: HistoricalFormState) => ({
  title: form.title.trim(),
  decision: form.decision.trim(),
  decidedOn: form.decidedOn,
  project: form.project.trim() || null,
  sourceKind: form.sourceKind,
  tags: form.tags,
  options: lines(form.options),
  context: form.context.trim() || null,
  scope: form.scope.trim() || null,
  participants: form.participants,
  reversibility: form.reversibility === "" ? null : form.reversibility,
  references: lines(form.references).map((line) => {
    const [url = "", ...label] = line.split(/\s+/u);
    return label.length === 0 ? { url } : { url, label: label.join(" ") };
  }),
  relatedNotes: lines(form.relatedNotes),
  supersedesId: form.supersedesId || null,
  revisitCondition: form.revisitCondition.trim() || null,
  notes: form.notes.trim() || null,
});

/** A new record from the form: only what holds something is sent. */
export const historicalDecisionInput = (form: HistoricalFormState): HistoricalDecisionInput =>
  Object.fromEntries(Object.entries(said(form)).filter(([, value]) => value !== null && !(Array.isArray(value) && value.length === 0))) as unknown as HistoricalDecisionInput;

/** What the form changes in `record`, of the fields named: each that reads differently now, a cleared one as null. */
export const historicalDecisionChanges = (record: HistoricalDecision, form: HistoricalFormState, names: readonly HistoricalFieldName[]): Partial<HistoricalDecisionChange> => {
  const now = said(form);
  const was = said(historicalFormOf(record));
  return Object.fromEntries(names.filter((name) => JSON.stringify(now[name]) !== JSON.stringify(was[name])).map((name) => [name, now[name]]));
};

/** Why the form cannot be saved as it stands, in the reader's words and the field it is about; null when it can, or only lacks what is required. */
export const historicalFormProblem = (form: HistoricalFormState): { field: HistoricalFieldName; message: string } | null => {
  const checked = recordHistoricalDecisionRequestSchema.safeParse({ ...historicalDecisionInput(form), version: HISTORICAL_DECISION_VERSION, sourceClient: null });
  const issue = checked.success ? undefined : checked.error.issues.find((item) => item.code !== "too_small" && !(item.code === "invalid_type" && item.input === undefined));
  if (issue === undefined) return null;
  const field = String(issue.path[0]) as HistoricalFieldName;
  const label = HISTORICAL_FIELD_LABELS[field] ?? "记录内容";
  const message = issue.code === "too_big"
    ? `${label}${typeof issue.path[1] === "number" && issue.origin === "string" ? "的每一项" : ""}最多 ${issue.maximum} ${issue.origin === "array" ? "项" : "个字符"}，请缩短后再保存。`
    : field === "references"
      ? "相关链接每行一条，要是 https 链接（或本机的 http 链接），不能带账号密码；名称写在链接后面，用空格隔开。"
      : field === "decidedOn"
        ? "决定日期要是一个有效的日期。"
        : `请检查${label}后再保存。`;
  return { field, message };
};

/** Whether the two required fields hold something. */
export const historicalFormComplete = (form: HistoricalFormState): boolean => form.title.trim() !== "" && form.decision.trim() !== "" && form.decidedOn !== "";

interface ChipsInputProps {
  id: string;
  label: string;
  values: readonly string[];
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  onChange(values: string[]): void;
}

/** Several short values in one field: Enter or a comma ends one, Backspace on nothing takes the last away. */
const ChipsInput = ({ id, label, values, disabled, invalid, describedBy, onChange }: ChipsInputProps) => {
  const [text, setText] = useState("");
  const add = (): void => {
    const value = text.trim();
    if (value !== "" && !values.includes(value)) onChange([...values, value]);
    setText("");
  };
  return (
    <div className="chips-input" aria-invalid={invalid || undefined}>
      {values.map((value) => (
        <span key={value} className="chips-input-chip">
          {value}
          <button type="button" aria-label={`移除${label}：${value}`} disabled={disabled} onClick={() => onChange(values.filter((kept) => kept !== value))}>×</button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={add}
        onKeyDown={(event) => {
          // Typed with an input method, Enter picks a candidate: it ends no value.
          if (event.nativeEvent.isComposing) return;
          if ((event.key === "Enter" || event.key === "," || event.key === "，") && text.trim() !== "") {
            event.preventDefault();
            add();
          } else if (event.key === "Backspace" && text === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
      />
    </div>
  );
};

export interface HistoricalFieldsProps {
  idPrefix: string;
  form: HistoricalFormState;
  disabled: boolean;
  problem: { field: HistoricalFieldName; message: string } | null;
  /** Records this one may be said to replace, newest first. */
  candidates: readonly HistoricalDecision[];
  /** Shown in place of the choices, for a source the form may not change (an agent's capture). */
  fixedSource?: boolean;
  onChange(patch: Partial<HistoricalFormState>): void;
}

const SOURCE_CHOICES: readonly HistoricalDecisionSourceKind[] = ["app_manual", "offline_conversation", "meeting", "pr_comment"];

/**
 * One field of a 历史决定, label, control and hint: the 主动记录 form and the detail's editors both lay out the
 * same ones, so a field reads and behaves the same wherever it is filled in.
 */
export const HistoricalField = ({ name, optional = false, ...props }: HistoricalFieldsProps & { name: HistoricalFieldName; optional?: boolean }): ReactNode => {
  const { form, disabled, problem, onChange } = props;
  const id = `${props.idPrefix}-${name}`;
  const wrong = problem?.field === name;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const hint = HINTS[name];
  const control = {
    id,
    disabled,
    "aria-invalid": wrong || undefined,
    "aria-describedby": [wrong ? errorId : null, hint === undefined ? null : hintId].filter(Boolean).join(" ") || undefined,
  };
  const text = (value: string) => onChange({ [name]: value });
  const body = (() => {
    switch (name) {
      case "title":
        return <input {...control} value={form.title} required maxLength={LIMITS.title} onChange={(event) => text(event.currentTarget.value)} />;
      case "decision":
        return <textarea {...control} value={form.decision} required rows={3} onChange={(event) => text(event.currentTarget.value)} />;
      case "decidedOn":
        return <input {...control} type="date" value={form.decidedOn} required onChange={(event) => text(event.currentTarget.value)} />;
      case "project":
      case "scope":
      case "revisitCondition":
        return <input {...control} value={form[name]} onChange={(event) => text(event.currentTarget.value)} />;
      case "sourceKind":
        return props.fixedSource === true || !SOURCE_CHOICES.includes(form.sourceKind)
          ? <input {...control} value={HISTORICAL_SOURCE_LABELS[form.sourceKind]} readOnly />
          : (
            <select {...control} value={form.sourceKind} onChange={(event) => onChange({ sourceKind: event.currentTarget.value as HistoricalDecisionSourceKind })}>
              {SOURCE_CHOICES.map((kind) => <option key={kind} value={kind}>{kind === "app_manual" ? "现在手动记录" : HISTORICAL_SOURCE_LABELS[kind]}</option>)}
            </select>
          );
      case "tags":
      case "participants":
        return <ChipsInput id={id} label={HISTORICAL_FIELD_LABELS[name]} values={form[name]} disabled={disabled} invalid={wrong} describedBy={control["aria-describedby"]} onChange={(values) => onChange({ [name]: values })} />;
      case "reversibility":
        return (
          <select {...control} value={form.reversibility} onChange={(event) => onChange({ reversibility: event.currentTarget.value as HistoricalFormState["reversibility"] })}>
            <option value="">未标注</option>
            {(Object.keys(HISTORICAL_REVERSIBILITY_LABELS) as HistoricalDecisionReversibility[]).map((value) => <option key={value} value={value}>{HISTORICAL_REVERSIBILITY_LABELS[value]}</option>)}
          </select>
        );
      case "supersedesId":
        // ponytail: a plain list of the newest hundred; a search box when a ledger outgrows it.
        return (
          <select {...control} value={form.supersedesId} onChange={(event) => text(event.currentTarget.value)}>
            <option value="">不替代</option>
            {props.candidates.map((record) => <option key={record.id} value={record.id}>{record.decidedOn} · {record.decision.length > 40 ? `${record.decision.slice(0, 40)}…` : record.decision}</option>)}
          </select>
        );
      case "options":
      case "context":
      case "references":
      case "relatedNotes":
      case "notes":
        return <textarea {...control} value={form[name]} rows={name === "context" || name === "notes" || name === "options" ? 3 : 2} onChange={(event) => text(event.currentTarget.value)} />;
    }
  })();
  return (
    <div className="form-field">
      <label htmlFor={id}>{HISTORICAL_FIELD_LABELS[name]}{optional ? "（可选）" : ""}</label>
      {body}
      {wrong ? <p className="form-field-error" role="alert" id={errorId}>{problem.message}</p> : null}
      {hint === undefined ? null : <p id={hintId}>{hint}</p>}
    </div>
  );
};

const HINTS: Partial<Record<HistoricalFieldName, string>> = {
  options: `每行一个，最多 ${LIMITS.options} 个；不用写优缺点。`,
  context: "当时的客观情况和约束，不是论证。",
  references: `每行一个链接，后面可以写名称；最多 ${LIMITS.references} 条。`,
  relatedNotes: `每行一个笔记名或 [[双链]]；最多 ${LIMITS.relatedNotes} 条。`,
  supersedesId: "保存后那一条标为已替代，两条互相可跳转。",
  revisitCondition: "只是备忘，不会自动提醒。",
};

/** The fields under 更多追踪信息, laid out as the 主动记录 form shows them. */
export const HistoricalMoreFields = (props: HistoricalFieldsProps) => (
  <>
    <div className="form-fields-row">
      <HistoricalField {...props} name="options" />
      <HistoricalField {...props} name="context" />
    </div>
    <div className="form-fields-row">
      <HistoricalField {...props} name="scope" />
      <HistoricalField {...props} name="participants" />
      <HistoricalField {...props} name="reversibility" />
    </div>
    <div className="form-fields-row">
      <HistoricalField {...props} name="references" />
      <HistoricalField {...props} name="relatedNotes" />
    </div>
    <div className="form-fields-row">
      <HistoricalField {...props} name="supersedesId" />
      <HistoricalField {...props} name="revisitCondition" />
    </div>
    <HistoricalField {...props} name="notes" />
  </>
);
