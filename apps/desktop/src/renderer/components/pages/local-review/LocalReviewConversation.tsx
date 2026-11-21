import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { LocalReviewConversationAction, LocalReviewExecution, LocalReviewJob, LocalReviewMessage, LocalReviewReference } from "@cognelis/decision-protocol";
import { renderMarkdown } from "../assistant/markdown.js";
import { DRAFT_MAX, EXECUTION_ACTIVE, JOB_BUSY, activeTurn, annotationRange, executionButtons, executionFor, executionLabels, turnButtons, turnLabels, type ConversationButton, type ConversationDraft } from "./conversation-model.js";

export type ConversationActionInput = Pick<LocalReviewConversationAction, "action" | "turnId" | "executionId">;

function ReferenceChip({ job, reference }: { job: LocalReviewJob; reference: LocalReviewReference }) {
  if (reference.kind === "annotation") {
    const a = job.annotations.find(item => item.id === reference.id);
    return <span className="local-review-chat-ref" data-kind="annotation">{a ? `意见 ${a.path}:${annotationRange(a)}` : "意见（已失效）"}</span>;
  }
  const g = job.groups.find(item => item.id === reference.id);
  return <span className="local-review-chat-ref" data-kind="group">{g ? `组 ${g.ordinal}「${g.title}」` : "组（已失效）"}</span>;
}

function PlanCard({ job, message, busy, onExecute }: { job: LocalReviewJob; message: LocalReviewMessage; busy: boolean; onExecute(messageId: string): void }) {
  const plan = message.plan!, execution = executionFor(job, message.id);
  const target = plan.target.kind === "existing" ? (() => { const id = plan.target.groupId, g = job.groups.find(item => item.id === id); return g ? `追加到组 ${g.ordinal}「${g.title}」` : "追加到已有组"; })() : `新建组「${plan.target.title}」`;
  const annotations = plan.annotationIds.map(id => job.annotations.find(a => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
  return <section className="local-review-plan" aria-label="执行方案" data-executable={plan.executable}>
    <header><strong>执行方案</strong><span>{target}</span></header>
    {annotations.length ? <ul className="local-review-plan-notes">{annotations.map(a => <li key={a.id}><code>{a.path}:{annotationRange(a)}</code></li>)}</ul> : null}
    {plan.requirements ? <div className="local-review-plan-field"><h4>对话中的要求</h4><div className="assistant-answer">{renderMarkdown(plan.requirements)}</div></div> : null}
    <div className="local-review-plan-field"><h4>预期改动</h4><div className="assistant-answer">{renderMarkdown(plan.expectedChanges)}</div></div>
    <div className="local-review-plan-field"><h4>理由</h4><div className="assistant-answer">{renderMarkdown(plan.reason)}</div></div>
    {execution ? <p className="local-review-plan-state" role="status" data-state={execution.state}>执行状态：{executionLabels[execution.state] ?? execution.state}{execution.error ? ` · ${execution.error}` : ""}</p>
      : plan.executable ? <div className="local-review-plan-actions"><button type="button" disabled={busy} onClick={() => onExecute(message.id)}>执行</button><small>点击后才会修改代码；高风险改动仍需单独授权。</small></div>
      : <p className="local-review-plan-invalid" role="status">此方案无法执行：{plan.invalidReason ?? "方案已失效，请重新讨论。"}</p>}
  </section>;
}

function Buttons({ buttons, busy, onClick }: { buttons: ConversationButton[]; busy: boolean; onClick(button: ConversationButton): void }) {
  return buttons.length ? <div className="local-review-chat-actions">{buttons.map(button => <button key={button.key} type="button" className={button.secondary ? "secondary-button" : undefined} disabled={busy} onClick={() => onClick(button)}>{button.label}</button>)}</div> : null;
}

export function LocalReviewConversation({ job, busy, active, sending, error, draft, composerRef, onDraft, onSend, onExecute, onAction, onReviewRisk, onMarkRead }: {
  job: LocalReviewJob; busy: boolean; active: boolean; sending: boolean; error: string; draft: ConversationDraft; composerRef: RefObject<HTMLTextAreaElement | null>;
  onDraft(body: string): void; onSend(): void; onExecute(messageId: string): void; onAction(action: ConversationActionInput): void; onReviewRisk(execution: LocalReviewExecution): void; onMarkRead(seq: number): Promise<void>;
}) {
  const messages = job.conversation.messages, maxSeq = messages.reduce((max, message) => Math.max(max, message.seq), 0), readSeq = job.conversation.readSeq;
  const marked = useRef(new Map<string, number>()), log = useRef<HTMLDivElement>(null), lastSeen = useRef(0);
  // Only what this render shows is marked read; a reply that arrives after it stays unread until it has been rendered too.
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  useEffect(() => { const change = () => setVisible(document.visibilityState !== "hidden"); document.addEventListener("visibilitychange", change); return () => document.removeEventListener("visibilitychange", change); }, []);
  useEffect(() => {
    if (!active || !visible || maxSeq <= readSeq || (marked.current.get(job.id) ?? 0) >= maxSeq) return;
    marked.current.set(job.id, maxSeq);
    void onMarkRead(maxSeq).catch(() => { if (marked.current.get(job.id) === maxSeq) marked.current.delete(job.id); });
  }, [active, visible, job.id, maxSeq, readSeq, onMarkRead]);
  useLayoutEffect(() => {
    const element = log.current; if (!element || maxSeq === lastSeen.current) return;
    const first = lastSeen.current === 0, nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    lastSeen.current = maxSeq; if (first || nearBottom) element.scrollTop = element.scrollHeight;
  }, [maxSeq]);
  const turn = activeTurn(job), jobBusy = JOB_BUSY.has(job.state), executionRunning = job.executions.some(e => EXECUTION_ACTIVE.has(e.state));
  const reason = turn ? "本回合进行中，可先编辑草稿，回答后再发送。" : jobBusy || executionRunning ? "任务正在处理变更，完成后可以继续对话。" : "";
  const canSend = !!draft.body.trim() && draft.body.length <= DRAFT_MAX && !turn && !jobBusy && !executionRunning && !sending;
  const hostOfExecution = new Map<string, string>(), hostOfTurn = new Map<string, string>();
  for (const message of messages) { if (message.executionId) hostOfExecution.set(message.executionId, message.id); if (message.turnId) hostOfTurn.set(message.turnId, message.id); }
  for (const execution of job.executions) if (!hostOfExecution.has(execution.id)) hostOfExecution.set(execution.id, execution.messageId);
  const run = (button: ConversationButton, execution?: LocalReviewExecution, turnId?: string) => {
    if (button.action === "review_risk") { if (execution) onReviewRisk(execution); return; }
    onAction({ action: button.action.action, ...(execution ? { executionId: execution.id } : {}), ...(turnId ? { turnId } : {}) });
  };
  const actionsFor = (message: LocalReviewMessage) => {
    const nodes: ReactNode[] = [];
    const execution = job.executions.find(e => hostOfExecution.get(e.id) === message.id);
    if (execution) nodes.push(<Buttons key={`e-${execution.id}`} buttons={executionButtons(job, execution)} busy={busy} onClick={button => run(button, execution)} />);
    const turn = job.turns.find(t => hostOfTurn.get(t.id) === message.id && (t.state === "failed" || t.state === "cancelled" || t.state === "interrupted"));
    if (turn) nodes.push(<Buttons key={`t-${turn.id}`} buttons={turnButtons(turn)} busy={busy} onClick={button => run(button, undefined, turn.id)} />);
    return nodes;
  };
  return <section className="local-review-chat" aria-label="任务对话">
    <div className="local-review-chat-log" ref={log} role="log" aria-live="polite" aria-label="对话消息">
      {messages.length ? null : <p className="local-review-chat-empty">还没有对话。可以追问结论、补充信息，或要求按意见修改。</p>}
      {messages.map(message => <article key={message.id} className="local-review-message" data-role={message.role} data-seq={message.seq} data-unread={message.seq > readSeq && message.role !== "user" ? "" : undefined} aria-label={message.role === "user" ? "我的消息" : message.role === "worker" ? "审阅代理" : "系统消息"}>
        <header><strong>{message.role === "user" ? "我" : message.role === "worker" ? "审阅代理" : "系统"}</strong><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></header>
        {message.references.length ? <div className="local-review-chat-refs">{message.references.map(reference => <ReferenceChip key={`${reference.kind}:${reference.id}`} job={job} reference={reference} />)}</div> : null}
        {message.role === "user" ? <pre className="local-review-message-body local-review-verbatim">{message.body}</pre> : <div className="assistant-answer local-review-message-body">{renderMarkdown(message.body, undefined, { linkTargets: true })}</div>}
        {message.role === "system" ? <details className="local-review-original"><summary>查看原文</summary><pre className="local-review-verbatim">{message.body}</pre></details> : null}
        {message.plan ? <PlanCard job={job} message={message} busy={busy} onExecute={onExecute} /> : null}
        {actionsFor(message)}
      </article>)}
      {turn ? <div className="local-review-chat-pending" role="status"><span>{turnLabels[turn.state]}…</span><Buttons buttons={turnButtons(turn)} busy={busy} onClick={button => run(button, undefined, turn.id)} /></div> : null}
    </div>
    <form className="local-review-composer" aria-label="发送消息" onSubmit={event => { event.preventDefault(); if (canSend) onSend(); }}>
      <label><span>给审阅代理发消息</span><textarea ref={composerRef} aria-label="消息内容" value={draft.body} rows={4} placeholder="追问、补充信息或提出修改要求。Enter 换行，⌘↩ 发送。" onChange={event => onDraft(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); if (canSend) onSend(); } }} /></label>
      {error ? <p className="load-failure" role="alert">{error}</p> : null}
      <div className="local-review-composer-bar"><small>{reason || `${draft.body.length}/${DRAFT_MAX} · ⌘↩ 发送`}</small><button disabled={!canSend}>{sending ? "正在发送…" : "发送"}</button></div>
    </form>
  </section>;
}
