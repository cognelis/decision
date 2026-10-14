import type { PrReviewProgress } from "@cognelis/decision-protocol";
import { zonedFormatter } from "../../../calendar-date.js";

export interface StepGroup { index: number; head?: PrReviewProgress; steps: PrReviewProgress[] }
export type StepItem = { step: PrReviewProgress } | { group: StepGroup };

/**
 * A review's steps as the reader follows them: each group's under it, as Claude Code shows each reviewer's work, and
 * the rest (the PR's brief, the verification) in their place. A group's model call, once done, is said by the steps it
 * chose; shown too, every step stood twice, under "模型 · 已完成" and "工具 · 已完成".
 */
export function reviewSteps(events: readonly PrReviewProgress[]): StepItem[] {
  const items: StepItem[] = [];
  const groups = new Map<number, StepGroup>();
  for (const event of events) {
    if (event.group === undefined) { items.push({ step: event }); continue; }
    if (event.kind === "model" && event.status === "done") continue;
    let group = groups.get(event.group);
    if (!group) { group = { index: event.group, steps: [] }; groups.set(event.group, group); items.push({ group }); }
    if (event.id === `batch-${event.group}`) group.head = event;
    else group.steps.push(event);
  }
  return items;
}

/** What a deep review's reviewer reads for, as its steps and its conclusion are labelled. */
export const LENS = { bugs: "缺陷", rules: "规则与决策" } as const;
const GROUP_STATUS = { running: "进行中", done: "已完成", error: "没能评完", cancelled: "已停止" } as const;
const clock = zonedFormatter({ hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A step left running by a review that has ended was cut off, and is shown as stopped. */
const statusOf = (event: PrReviewProgress, running: boolean) => (!running && event.status === "running" ? "cancelled" : event.status);

const STEP_STATUS = { running: "进行中", done: "已完成", error: "失败", cancelled: "已停止" } as const;
const FIT = { scope_match: "适用", needs_review: "需核对适用范围", out_of_scope: "不在适用范围" } as const;
type CodeAt = NonNullable<PrReviewProgress["code"]>;
/**
 * `opens`: whether the PR's details hold that code. A source read is often of a file the PR does not change (where a
 * definition lives); opened there, the dialog showed the PR's first changed file instead, as if it were that one.
 */
export interface StepActions { onOpenCode?: (code: CodeAt) => void; opens?: (code: CodeAt) => boolean; onOpenNote?: (relativePath: string) => void }

/** A diff as a step read it ("旧/新 行号 ±文本"), each line marked added or removed for the eye. */
const diffLines = (text: string) => text.split("\n").map((line, index) => {
  const sign = /^\S+\/\S+ ([+-])/u.exec(line)?.[1];
  return <span key={index} data-change={sign === "+" ? "add" : sign === "-" ? "remove" : undefined}>{line}{"\n"}</span>;
});

function Step({ event, running, onOpenCode, opens, onOpenNote }: { event: PrReviewProgress; running: boolean } & StepActions) {
  const status = statusOf(event, running);
  const { decisions, code, detail } = event;
  return <li data-status={status} data-kind={event.kind}>
    <div className="review-step-line">
      {/* The mark says it to the eye; a screen reader is told in words, as it was told under every step before. */}
      <span className="sr-only">{STEP_STATUS[status]}：</span>
      {event.lens ? <span className="review-step-lens">{LENS[event.lens]}</span> : null}
      <span className="review-step-text">{event.message}</span>
      <time dateTime={event.at}>{clock.format(new Date(event.at))}</time>
    </div>
    {/* What the step found, to read where it stands: each decision and its note. */}
    {decisions?.length ? <details className="review-step-more"><summary>查看 {decisions.length} 条决策</summary>
      <ul className="review-step-decisions">{decisions.map(item => <li key={`${item.source}/${item.id}`}>
        <div><code>{item.source}/{item.id}</code><strong>{item.title}</strong>{item.otherProject ? <span className="review-step-fit" data-fit="other_project">{`其它项目 · ${item.otherProject}`}</span>
          : item.applicability ? <span className="review-step-fit" data-fit={item.applicability}>{FIT[item.applicability]}</span> : null}</div>
        {item.summary ? <p>{item.summary}</p> : null}
        {onOpenNote ? <button type="button" className="text-button" aria-label={`打开来源笔记：${item.title}`} onClick={() => onOpenNote(item.relativePath)}>打开来源笔记</button> : null}
      </li>)}</ul>
    </details> : null}
    {/* The code a read got, as the model saw it, and the whole file or change in the PR's details. */}
    {code && detail ? <details className="review-step-more"><summary>查看代码</summary>
      <pre className="review-step-code">{code.view === "diff" ? diffLines(detail) : detail}</pre>
      {onOpenCode && (opens?.(code) ?? true) ? <button type="button" className="text-button" onClick={() => onOpenCode(code)}>{code.view === "diff" ? "在 PR 详情中查看这处变更" : "在 PR 详情中查看整个文件"}</button> : null}
    </details> : null}
    {!code && detail && detail !== event.message && event.kind !== "status" ? <details className="review-step-more">
      <summary>{event.kind === "model" && event.status === "error" && detail.includes("模型原始输出") ? "查看模型原始输出" : "详情"}</summary><pre>{detail}</pre>
    </details> : null}
  </li>;
}

/** The steps, a group's folded once it is over: its name, how it ended and how many steps it took. */
export function ReviewSteps({ items, running, ...actions }: { items: StepItem[]; running: boolean } & StepActions) {
  return <ol className="review-steps">{items.map(item => {
    if ("step" in item) return <Step key={item.step.id} event={item.step} running={running} {...actions} />;
    const { index, head, steps } = item.group;
    const status = head ? statusOf(head, running) : running ? "running" : "done";
    return <li key={`group-${index}`} className="review-step-group" data-status={status}>
      <details open={status === "running" ? true : undefined}>
        <summary><span className="review-step-text">{head?.message ?? `评审分组 ${index + 1}`}</span><span>{GROUP_STATUS[status]} · {steps.length} 步</span></summary>
        <ol className="review-steps">{steps.map(step => <Step key={step.id} event={step} running={running} {...actions} />)}</ol>
      </details>
    </li>;
  })}</ol>;
}
