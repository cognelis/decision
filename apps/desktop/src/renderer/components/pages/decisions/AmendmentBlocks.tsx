import type { AmendableSource, AmendmentFields, AmendmentState } from "@cognelis/decision-protocol";

import { BASIS_LABELS, changedPart, clientLabel, historyDays, stampLabel, type HistoryRow } from "./amendment-view.js";

/** A rewritten text, the part the rewrite changed marked. */
export const Rewritten = ({ before, after }: { before: string | null; after: string }) => {
  if (before === null || before === after) return <>{after}</>;
  const { prefix, changed, suffix } = changedPart(before, after);
  return <>{prefix}{changed === "" ? null : <mark className="amendment-changed">{changed}</mark>}{suffix}</>;
};

/** The original words of what an agent rewrote, one disclosure for the card or field. */
export const OriginalWords = ({ label, lines, open }: { label: string; lines: Array<{ name: string | null; text: string }>; open?: boolean }) => (
  <details className="amendment-original" {...(open === true ? { open: true } : {})}>
    <summary>{label}</summary>
    {lines.map((line, index) => <p key={index}>{line.name === null ? null : <span>{line.name}：</span>}{line.text === "" ? "（空）" : line.text}</p>)}
  </details>
);

/** What was added after the original, in time order, each with who said it and on what ground. */
export const AmendmentList = ({ state, title }: { state: AmendmentState; title: string }) => state.amendments.length === 0 ? null : (
  <div className="amendment-list" role="group" aria-label={title}>
    <span className="amendment-list-title">{title}</span>
    {state.amendments.map((item) => (
      <div className="amendment-row" key={item.n}>
        <time dateTime={item.at}>{stampLabel(item.at)}</time>
        <span className="amendment-who" title={clientLabel(item.client)}>{clientLabel(item.client)}</span>
        <span className="amendment-text">{item.text}</span>
        <span className={`amendment-basis ${item.basis}`}>{BASIS_LABELS[item.basis] ?? item.basis}</span>
      </div>
    ))}
  </div>
);

/** The record's history by day: who, what, and for a rewrite the text before and after, with a way back. */
export const AmendmentHistory = ({ source, state, today, own, busy, onRestore }: {
  source: AmendableSource;
  state: AmendmentState;
  today: string;
  own?: ReadonlyArray<{ at: string; what: string; reason: string | null }> | undefined;
  busy: boolean;
  /** Puts back what a rewrite replaced; omitted where that is not offered. */
  onRestore?: ((row: HistoryRow, to: AmendmentFields) => void) | undefined;
}) => {
  const days = historyDays(source, state, today, own);
  return days.length === 0 ? <p className="amendment-empty">还没有修订记录。</p> : (
    <div className="amendment-history">
      {days.map((day) => (
        <section key={day.day} aria-label={day.label}>
          <h3>{day.label}</h3>
          {day.events.map((row) => (
            <div className="amendment-history-row" key={row.key}>
              <div className="amendment-row">
                <time dateTime={row.at}>{row.time}</time>
                <span className="amendment-who" title={row.who}>{row.who}</span>
                <span className="amendment-text">{row.what}</span>
              </div>
              {row.diff.length === 0 && row.reason === null ? null : (
                <div className="amendment-diff">
                  {row.diff.map((item) => (
                    <div key={item.label}>
                      <span className="amendment-diff-label">{item.label}</span>
                      <del>{item.before}</del>
                      <ins>{item.after}</ins>
                    </div>
                  ))}
                  {row.reason === null ? null : <p>原因：{row.reason}{row.basis === null ? "" : `（${row.basis}）`}</p>}
                  {row.restoreTo !== null && onRestore !== undefined ? (
                    <button type="button" className="text-button" disabled={busy} onClick={() => onRestore(row, row.restoreTo!)}>恢复为这一版之前</button>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};
