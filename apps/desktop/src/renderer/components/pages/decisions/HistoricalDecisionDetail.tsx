import { HISTORICAL_REVERSIBILITY_LABELS, HISTORICAL_SOURCE_LABELS, HISTORICAL_STATUS_LABELS, localCalendarDate } from "@cognelis/decision-core/historical-decision";
import type { GetHistoricalDecisionResult, HistoricalDecision, HistoricalDecisionEvent, HistoricalDecisionLink, HistoricalDecisionStatus } from "@cognelis/decision-protocol";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

import { sourceLabel } from "../../../client-labels.js";
import type { DecisionApi, HistoricalDecisionChange } from "../../../../shared/renderer-api.js";
import { ActionIcon, IconButton } from "../../IconButton.js";
import { ModalDialog } from "../../ModalDialog.js";
import { clockLabel, historyByDay } from "../todos/todo-text.js";
import { clientLabel, READER } from "./amendment-view.js";
import {
  HistoricalField,
  historicalDecisionChanges,
  historicalFormOf,
  historicalFormProblem,
  type HistoricalFieldName,
  type HistoricalFormState,
} from "./HistoricalDecisionForm.js";

export type HistoricalDetailApi = Pick<DecisionApi, "getHistoricalDecision" | "updateHistoricalDecision" | "listHistoricalDecisions" | "openHistoricalDecision">;

interface HistoricalDecisionDetailProps {
  api: HistoricalDetailApi;
  id: string;
  /** The list it was opened from, in its order: what 上一条 and 下一条 step through. */
  order: readonly string[];
  /** Moves when a record is written anywhere (an agent's change, an edit in Obsidian): the one shown reads again. */
  revision: number;
  onOpen(id: string): void;
  onClose(): void;
  /** A change was saved here: the list behind reads again. */
  onChanged(): void;
  onOpenDecision(id: string): void;
}

/** What one 修改 opens: a section's own fields, saved together. */
const EDITORS = {
  title: { label: "决定事项", fields: ["title"] },
  decision: { label: "最终决定", fields: ["decision"] },
  options: { label: "备选方案", fields: ["options"] },
  context: { label: "当时背景", fields: ["context"] },
  links: { label: "相关链接与关联笔记", fields: ["references", "relatedNotes"] },
  notes: { label: "补充备注", fields: ["notes"] },
  tracking: { label: "追踪信息", fields: ["decidedOn", "project", "scope", "participants", "sourceKind", "tags", "reversibility", "revisitCondition"] },
  chain: { label: "演化链", fields: ["supersedesId"] },
} as const satisfies Record<string, { label: string; fields: readonly HistoricalFieldName[] }>;

type EditorKey = keyof typeof EDITORS;

export const HistoricalStatusChip = ({ status }: { status: HistoricalDecisionStatus }) =>
  <em className={`historical-chip ${status}`}>{HISTORICAL_STATUS_LABELS[status]}</em>;

/**
 * What was done to the record through Paraself, by day, newest first: who, what, and for a field rewritten its words
 * before and after, as a decision's 修订记录 shows them. Folded at the foot of the detail; read only.
 */
const HistoricalChanges = ({ history }: { history: readonly HistoricalDecisionEvent[] }) => {
  const days = historyByDay(history, localCalendarDate(new Date()));
  return (
    <div className="decision-evidence-disclosures historical-history">
      <details>
        <summary>
          <svg className="decision-evidence-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 3 3 3-3 3" /></svg>
          <span>变更历史</span>
          <small>{history.length === 0 ? "无" : `${history.length} 条`}</small>
        </summary>
        <div className="decision-evidence-body">
          {days.length === 0 ? <p className="historical-history-empty">还没有变更记录。</p> : (
            <div className="amendment-history">
              {days.map((day) => (
                <section key={day.day} aria-label={day.label}>
                  <h3>{day.label}</h3>
                  {day.events.map((event, index) => (
                    <div className="amendment-history-row" key={`${event.at}-${index}`}>
                      <div className="amendment-row">
                        <time dateTime={event.at}>{clockLabel(event.at)}</time>
                        <span className="amendment-who" title={clientLabel(event.actor === "app" ? READER : event.actor)}>{clientLabel(event.actor === "app" ? READER : event.actor)}</span>
                        <span className="amendment-text">{event.summary}</span>
                      </div>
                      {event.changes === undefined ? null : (
                        <div className="amendment-diff">
                          {event.changes.map((change) => (
                            <div key={change.field}>
                              <span className="amendment-diff-label">{change.field}</span>
                              {/* Nothing written before is said as such, not struck through: nothing was taken away. */}
                              {change.before === "" ? <span className="historical-empty-value">（空）</span> : <del>{change.before}</del>}
                              {change.after === "" ? <span className="historical-empty-value">（空）</span> : <ins>{change.after}</ins>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          )}
          <p className="historical-history-note">
            {days.length === 0 ? "在 Obsidian 里直接写或改的笔记不会有记录；本机索引读不了、重建过的，之前的记录留在另存的那份索引文件里。" : "只记经 Paraself 做的修改（这个页面和 Agent）；在 Obsidian 里直接改的不在这里。"}
          </p>
        </div>
      </details>
    </div>
  );
};

const messageOf = (error: unknown): string => (error instanceof Error && error.message !== "" ? error.message : "没有保存，请稍后重试。");

export const HistoricalDecisionDetail = ({ api, id, order, revision, onOpen, onClose, onChanged, onOpenDecision }: HistoricalDecisionDetailProps) => {
  const formId = useId();
  const [detail, setDetail] = useState<GetHistoricalDecisionResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: EditorKey; form: HistoricalFormState } | null>(null);
  const [candidates, setCandidates] = useState<HistoricalDecision[]>([]);
  // A change of status, or 转为正式决策, asked about before it is made.
  const [asking, setAsking] = useState<{ status: HistoricalDecisionStatus; note: string } | "promote" | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await api.getHistoricalDecision(id));
      setFailure(null);
    } catch (error) {
      setFailure(messageOf(error));
    }
  }, [api, id]);
  useEffect(() => {
    setDetail((current) => (current?.record.id === id ? current : null));
    void load();
  }, [id, load, revision]);
  // Another record opened: nothing half-typed for the last one is carried over to it.
  useEffect(() => { setEditing(null); setAsking(null); setRefusal(null); setNotice(null); }, [id]);

  const record = detail?.record ?? null;
  const readOnly = record?.status === "withdrawn";
  const busy = editing !== null || asking !== null;

  const apply = async (change: Omit<HistoricalDecisionChange, "id" | "expectedRevision">): Promise<boolean> => {
    if (record === null) return false;
    setSaving(true);
    setRefusal(null);
    try {
      const result = await api.updateHistoricalDecision({ id, expectedRevision: record.revision, ...change });
      setNotice(result.releasedIds.length > 0 ? "已恢复有效，并解除了后任决定对它的替代关系。" : result.supersededId !== null ? "已保存，被替代的那一条已标为已替代。" : "已保存。");
      await load();
      onChanged();
      return true;
    } catch (error) {
      setRefusal(messageOf(error));
      // Refused because it changed meanwhile: what is shown is brought up to it, as the refusal says.
      await load();
      return false;
    } finally {
      setSaving(false);
    }
  };

  const begin = (key: EditorKey): void => {
    if (record === null) return;
    setRefusal(null);
    setNotice(null);
    setEditing({ key, form: historicalFormOf(record) });
    // The records it may be said to replace: without them the field still offers 不替代.
    if (key === "chain") void api.listHistoricalDecisions({ limit: 100 }).then((listed) => setCandidates(listed.records.filter((item) => item.id !== id)), () => undefined);
  };
  const problem = editing === null ? null : historicalFormProblem(editing.form);
  const save = async (): Promise<void> => {
    if (editing === null || record === null) return;
    const changes = historicalDecisionChanges(record, editing.form, EDITORS[editing.key].fields);
    if (Object.keys(changes).length === 0 || await apply(changes)) setEditing(null);
  };

  const editButton = (key: EditorKey, label: string): ReactNode =>
    readOnly || busy ? null : (
      <button type="button" className="text-button decision-detail-edit" onClick={() => begin(key)}>
        <ActionIcon name="edit" />
        {label}
      </button>
    );
  const editor = (key: EditorKey): ReactNode => {
    if (editing?.key !== key) return null;
    const required = (["title", "decision"] as const).some((name) => (EDITORS[key].fields as readonly string[]).includes(name) && editing.form[name].trim() === "");
    return (
      <div className="decision-outcome-editor historical-editor">
        {EDITORS[key].fields.map((name) => (
          <HistoricalField
            key={name}
            name={name}
            idPrefix={formId}
            form={editing.form}
            disabled={saving}
            problem={problem}
            candidates={candidates}
            onChange={(patch) => setEditing((current) => (current === null ? null : { ...current, form: { ...current.form, ...patch } }))}
          />
        ))}
        {refusal === null ? null : <p className="form-error" role="alert">{refusal}</p>}
        <div className="decision-outcome-editor-footer">
          <span />
          <div>
            <button type="button" className="secondary-button" disabled={saving} onClick={() => { setEditing(null); setRefusal(null); }}>取消</button>
            <button type="button" className="primary-button" disabled={saving || required || (problem !== null && (EDITORS[key].fields as readonly string[]).includes(problem.field))} onClick={() => void save()}>
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const chainNode = (step: string, link: HistoricalDecisionLink, current = false): ReactNode => (
    <li key={`${step}-${link.id}`}>
      <span>{step}</span>
      {current ? (
        <div className="historical-chain-node current">
          <strong>{link.decision}</strong>
          <small>{link.decidedOn} · {HISTORICAL_STATUS_LABELS[link.status]}</small>
        </div>
      ) : (
        <button type="button" className="historical-chain-node" disabled={busy} onClick={() => onOpen(link.id)}>
          <strong>{link.decision}</strong>
          <small>{link.decidedOn} · {HISTORICAL_STATUS_LABELS[link.status]}</small>
        </button>
      )}
    </li>
  );

  const index = order.indexOf(id);
  const step = (offset: number): void => {
    const next = order[index + offset];
    if (next !== undefined) onOpen(next);
  };
  const meta = record === null ? "" : `历史决定 · ${record.project ?? "未归属项目"} · 决定于 ${record.decidedOn}`;

  if (record === null || detail === null) {
    return (
      <ModalDialog title="历史决定详情" size="wide" onClose={onClose} footer={<button type="button" className="secondary-button" onClick={onClose}>关闭</button>}>
        {failure === null ? <p className="historical-detail-loading" role="status">正在读取…</p> : <p className="form-error" role="alert">{failure}</p>}
      </ModalDialog>
    );
  }

  // When it was withdrawn, from its history: one withdrawn by editing the note in Obsidian has none to say.
  const withdrawnAt = readOnly ? detail.history.find((event) => event.kind === "status" && event.summary.includes(`→ ${HISTORICAL_STATUS_LABELS.withdrawn}`))?.at : undefined;
  const missing = (["options", "context", "links", "notes"] as const).filter((key) =>
    key === "options" ? record.options.length === 0 : key === "context" ? record.context === null : key === "notes" ? record.notes === null : record.references.length + record.relatedNotes.length === 0);
  const statusChoices: HistoricalDecisionStatus[] = record.status === "active" ? ["superseded", "ended"] : record.status === "superseded" ? ["active", "ended"] : record.status === "ended" ? ["active", "superseded"] : [];
  const statusAction = (status: HistoricalDecisionStatus): string => (status === "active" ? "恢复有效" : status === "withdrawn" ? "撤回记录" : `标记${HISTORICAL_STATUS_LABELS[status]}`);

  return (
    <ModalDialog
      // Named 历史决定详情 (its close button 关闭历史决定详情); what shows as its title is the matter decided.
      title="历史决定详情"
      description={meta}
      size="wide"
      // While something is being written here, Escape or a click outside does not throw it away: its own 取消 does.
      dismissible={!busy || saving}
      onClose={onClose}
      actions={
        <>
          <div className="decision-detail-heading">
            <p aria-hidden="true">{meta}</p>
            <div className="decision-detail-title-row">
              <h3>{record.title}</h3>
              {readOnly || busy ? null : (
                <IconButton aria-label="编辑决定事项" onClick={() => begin("title")}>
                  <ActionIcon name="edit" />
                </IconButton>
              )}
            </div>
          </div>
          <button type="button" className="text-button decision-detail-edit" onClick={() => void api.openHistoricalDecision({ id }).catch((error: unknown) => setRefusal(messageOf(error)))}>
            <ActionIcon name="open" />
            在 Obsidian 打开
          </button>
          {index < 0 || order.length < 2 ? null : (
            <>
              <span className="decision-detail-divider" aria-hidden="true" />
              <div className="decision-detail-nav" role="group" aria-label="逐条查看">
                <IconButton aria-label="上一条历史决定" disabled={busy || index === 0} onClick={() => step(-1)}>
                  <ActionIcon name="previous" />
                </IconButton>
                <span>{index + 1} / {order.length}</span>
                <IconButton aria-label="下一条历史决定" disabled={busy || index === order.length - 1} onClick={() => step(1)}>
                  <ActionIcon name="next" />
                </IconButton>
              </div>
            </>
          )}
        </>
      }
      footer={
        <>
          <div className="modal-dialog-footer-start historical-detail-footer">
            {readOnly ? (
              <button type="button" className="secondary-button" disabled={busy} onClick={() => setAsking({ status: "active", note: record.statusNote ?? "" })}>
                <ActionIcon name="undo" />
                恢复有效
              </button>
            ) : (
              <>
                <button type="button" className="text-button danger-button" disabled={busy} onClick={() => setAsking({ status: "withdrawn", note: "" })}>
                  <ActionIcon name="undo" />
                  撤回记录
                </button>
                <p>不删除笔记，保留历史，之后可以恢复有效。</p>
              </>
            )}
          </div>
          <button type="button" className="secondary-button" disabled={busy && !saving} onClick={onClose}>关闭</button>
        </>
      }
    >
      <article className="decision-library-detail historical-detail">
        <p className="sr-only" role="status">{notice}</p>
        <div className="decision-detail-main">
          {readOnly ? (
            <div className="historical-notice danger" role="status">
              <ActionIcon name="undo" />
              <p>
                <strong>这条记录已撤回{withdrawnAt === undefined ? "" : ` · ${localCalendarDate(new Date(withdrawnAt))}`}</strong>
                {record.statusNote === null ? null : <span>状态说明：{record.statusNote}</span>}
                <span>笔记还在 Obsidian，变更历史也保留；它不再出现在默认列表和 Agent 的默认查询里，在「已撤回」筛选下能找到。内容只读，要改先恢复有效。</span>
              </p>
            </div>
          ) : null}
          {editing?.key === "title" ? (
            <section>
              <div className="decision-outcome-heading"><h4>决定事项</h4></div>
              {editor("title")}
            </section>
          ) : null}
          <section className="decision-detail-choice">
            <div className="decision-outcome-heading"><h4>最终决定</h4>{editButton("decision", "修改决定")}</div>
            {editor("decision") ?? <p className="decision-detail-answer">{record.decision}</p>}
            <div className="decision-detail-choice-meta">
              <HistoricalStatusChip status={record.status} />
              {record.reversibility === null ? null : <em className="historical-chip">{HISTORICAL_REVERSIBILITY_LABELS[record.reversibility]}</em>}
              <span>{HISTORICAL_SOURCE_LABELS[record.sourceKind]}{record.sourceClient === null ? "" : ` · ${sourceLabel(record.sourceClient)}`}</span>
            </div>
            {record.statusNote === null || readOnly ? null : <p className="historical-status-note">状态说明：{record.statusNote}</p>}
          </section>
          {record.options.length === 0 && editing?.key !== "options" ? null : (
            <section>
              <div className="decision-outcome-heading"><h4>备选方案</h4>{editButton("options", "修改方案")}</div>
              {editor("options") ?? <ul className="historical-options">{record.options.map((option) => <li key={option}>{option}</li>)}</ul>}
            </section>
          )}
          {record.context === null && editing?.key !== "context" ? null : (
            <section>
              <div className="decision-outcome-heading"><h4>当时背景</h4>{editButton("context", "修改背景")}</div>
              {editor("context") ?? <p className="historical-prose">{record.context}</p>}
            </section>
          )}
          {record.references.length + record.relatedNotes.length === 0 && editing?.key !== "links" ? null : (
            <section>
              <div className="decision-outcome-heading"><h4>相关链接与关联笔记</h4>{editButton("links", "修改链接")}</div>
              {editor("links") ?? (
                <div className="historical-references">
                  {record.references.map((reference) => (
                    <button key={reference.url} type="button" title={reference.url} onClick={() => void api.openHistoricalDecision({ id, link: reference.url }).catch((error: unknown) => setRefusal(messageOf(error)))}>
                      <ActionIcon name="link" />
                      {reference.label ?? reference.url}
                      {/* Where it leads, beside whatever it is called: a name alone could be anyone's. */}
                      {reference.label === undefined ? null : <small>{new URL(reference.url).host}</small>}
                    </button>
                  ))}
                  {record.relatedNotes.map((note) => (
                    <button key={note} type="button" onClick={() => void api.openHistoricalDecision({ id, relatedNote: note }).catch((error: unknown) => setRefusal(messageOf(error)))}>
                      <ActionIcon name="note" />
                      {note}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}
          {record.notes === null && editing?.key !== "notes" ? null : (
            <section>
              <div className="decision-outcome-heading"><h4>补充备注</h4>{editButton("notes", "修改备注")}</div>
              {editor("notes") ?? <p className="historical-prose">{record.notes}</p>}
            </section>
          )}
          {readOnly || busy || missing.length === 0 ? null : (
            <p className="historical-add">
              还可以补充：
              {missing.map((key) => <button key={key} type="button" className="text-button" onClick={() => begin(key)}>{EDITORS[key].label}</button>)}
            </p>
          )}
          {refusal === null || editing !== null || asking !== null ? null : <p className="form-error" role="alert">{refusal}</p>}
          {record.promotedDecisionId !== null ? (
            <section className="historical-promote promoted">
              <span>
                <strong>已转为正式决策</strong>
                <small>理由、预期和复盘在正式决策里继续；这条历史决定保留为留档，仍然不进入检索和复盘。</small>
              </span>
              <button type="button" className="decision-detail-link" onClick={() => onOpenDecision(record.promotedDecisionId!)}>
                打开正式决策
                <ActionIcon name="next" />
              </button>
            </section>
          ) : readOnly ? null : (
            <section className="historical-promote">
              <span>
                <strong>想补理由、跟踪结果时，转为正式决策</strong>
                <small>事项、决定、备选方案和背景带过去；这条保留为留档，两边互相可跳转。</small>
              </span>
              <button type="button" className="secondary-button" disabled={busy} onClick={() => { setRefusal(null); setAsking("promote"); }}>
                <ActionIcon name="promote" />
                转为正式决策
              </button>
            </section>
          )}
          <HistoricalChanges history={detail.history} />
        </div>
        <aside className="decision-detail-side" aria-label="追踪与演化">
          <section>
            <div className="decision-outcome-heading"><h4>追踪信息</h4>{editButton("tracking", "修改")}</div>
            {editor("tracking") ?? (
              <dl className="historical-facts">
                <div><dt>决定日期</dt><dd className="numeric">{record.decidedOn}</dd></div>
                <div><dt>项目</dt><dd>{record.project ?? "—"}</dd></div>
                <div><dt>影响范围</dt><dd>{record.scope ?? "—"}</dd></div>
                <div><dt>参与方</dt><dd>{record.participants.length === 0 ? "—" : record.participants.join("、")}</dd></div>
                <div><dt>来源方式</dt><dd>{HISTORICAL_SOURCE_LABELS[record.sourceKind]}</dd></div>
                <div><dt>标签</dt><dd>{record.tags.length === 0 ? "—" : <span className="historical-tags">{record.tags.map((tag) => <span key={tag} className="historical-tag">#{tag}</span>)}</span>}</dd></div>
                <div>
                  <dt>重看条件</dt>
                  <dd>{record.revisitCondition ?? "—"}{record.revisitCondition === null ? null : <small>仅作静态备忘，不自动提醒</small>}</dd>
                </div>
              </dl>
            )}
          </section>
          <section>
            <div className="decision-outcome-heading"><h4>演化链</h4>{editButton("chain", "修改")}</div>
            {editor("chain") ?? (
              <>
                <ol className="historical-chain">
                  {detail.predecessor === null ? null : chainNode("前任", detail.predecessor)}
                  {chainNode("当前", record, true)}
                  {detail.successors.map((successor) => chainNode("后任", successor))}
                </ol>
                {detail.predecessor === null && record.supersedesId !== null ? <p className="historical-chain-note">它替代的那条笔记已经找不到了。</p> : null}
                {detail.successors.length === 0 ? <p className="historical-chain-note">还没有后任决定</p> : null}
              </>
            )}
          </section>
          {statusChoices.length === 0 ? null : (
            <section>
              <div className="decision-outcome-heading"><h4>状态管理</h4></div>
              <div className="historical-status-actions">
                {statusChoices.map((status) => (
                  <button key={status} type="button" className="secondary-button" disabled={busy} onClick={() => { setRefusal(null); setAsking({ status, note: status === "active" ? "" : record.statusNote ?? "" }); }}>
                    {statusAction(status)}
                  </button>
                ))}
              </div>
              <p className="historical-chain-note">切换时可以写一句状态说明，例如「v2.0 重构后不再适用」。</p>
            </section>
          )}
        </aside>
      </article>

      {asking === null ? null : asking === "promote" ? (
        <ModalDialog
          title="转为正式决策"
          size="compact"
          dismissible={!saving}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className="secondary-button" disabled={saving} onClick={() => setAsking(null)}>取消</button>
              <button type="button" className="primary-button" disabled={saving} onClick={() => void apply({ promote: true }).then((done) => { if (done) setAsking(null); })}>
                {saving ? "正在转…" : "转为正式决策"}
              </button>
            </>
          }
        >
          <p className="historical-confirm">会新建一条正式决策，把事项、最终决定、备选方案和当时背景带过去。之后那一条参与检索、待补理由和复盘；这条历史决定保留为留档，两边互相可跳转。只能转一次。</p>
          {refusal === null ? null : <p className="form-error" role="alert">{refusal}</p>}
        </ModalDialog>
      ) : (
        <ModalDialog
          title={statusAction(asking.status)}
          size="compact"
          dismissible={!saving}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button type="button" className="secondary-button" disabled={saving} onClick={() => setAsking(null)}>取消</button>
              <button
                type="button"
                className={asking.status === "withdrawn" ? "primary-button danger-button" : "primary-button"}
                disabled={saving}
                onClick={() => void apply({ status: asking.status, expectedStatus: record.status, statusNote: asking.note.trim() === "" ? null : asking.note.trim() }).then((done) => { if (done) setAsking(null); })}
              >
                {saving ? "保存中…" : statusAction(asking.status)}
              </button>
            </>
          }
        >
          <p className="historical-confirm">
            {asking.status === "withdrawn"
              ? "撤回不删除笔记，也保留变更历史；撤回后它不再出现在默认列表和 Agent 的默认查询里，内容只读，之后可以恢复有效。"
              : asking.status === "active" && detail.successors.length > 0
                ? `恢复有效会同时解除它和后任决定的替代关系：${detail.successors.map((successor) => `「${successor.decision}」`).join("、")}不再标为替代它。`
                : asking.status === "active"
                  ? "恢复后它重新算作有效的决定。"
                  : `把这条历史决定${statusAction(asking.status)}。${asking.status === "superseded" ? "有了替代它的新决定时，也可以在新决定里选「替代哪条历史决定」，两条会互相链接。" : ""}`}
          </p>
          <div className="form-field">
            <label htmlFor={`${formId}-status-note`}>状态说明（可选）</label>
            <textarea id={`${formId}-status-note`} rows={2} maxLength={1_000} disabled={saving} value={asking.note} onChange={(event) => setAsking({ status: asking.status, note: event.currentTarget.value })} />
          </div>
          {refusal === null ? null : <p className="form-error" role="alert">{refusal}</p>}
        </ModalDialog>
      )}
    </ModalDialog>
  );
};

