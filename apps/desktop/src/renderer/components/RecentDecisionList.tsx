import type { RecentDecisionSummary } from "../../shared/renderer-api.js";
import { sourceLabel } from "../client-labels.js";
import { plainHeadline } from "./question-title.js";
import { ActionIcon, IconButton } from "./IconButton.js";

const rationaleLabels: Record<
  RecentDecisionSummary["rationaleStatus"],
  string
> = {
  captured: "理由完整",
  deferred: "待补理由",
  skipped: "未补理由",
};


export const RecentDecisionList = ({
  decisions,
  onOpenDecision,
  onOpenRetrospective,
  onDeleteDecision,
}: {
  decisions: RecentDecisionSummary[];
  onOpenDecision(id: string): void;
  /** Looking back over these as a whole: what was decided and learned. */
  onOpenRetrospective(): void;
  /** A wrong capture seen here is deleted from here. */
  onDeleteDecision(id: string): void;
}) => (
  <section
    className="dashboard-card dashboard-recent-card"
    aria-labelledby="recent-decisions-title"
  >
    <header className="dashboard-card-header">
      <div>
        <span>已记录</span>
        <h2 id="recent-decisions-title">最近决策</h2>
      </div>
      {decisions.length === 0 ? null : (
        <button type="button" className="text-button" onClick={onOpenRetrospective}>
          周期回顾 ›
        </button>
      )}
      <strong>{decisions.length}</strong>
    </header>
    {decisions.length === 0 ? (
      <p className="dashboard-empty-copy">还没有已记录的决策。</p>
    ) : (
      <ol
        className="recent-decision-list"
        aria-label="已记录的最近决策"
        tabIndex={0}
      >
        {decisions.map((decision, index) => (
          <li key={decision.id} className="recent-decision-row">
            <button
              type="button"
              className="recent-decision-item"
              title="在知识页中查看"
              onClick={() => onOpenDecision(decision.id)}
            >
              <div className="recent-decision-copy">
                <strong id={`recent-decision-question-${index}`}>{plainHeadline(decision.question)}</strong>
                <span>{plainHeadline(decision.selectedAnswer)}</span>
              </div>
              <div className="recent-decision-meta">
                <span>{decision.project}</span>
                <span>
                  {sourceLabel(decision.sourceClient)}
                </span>
                <time dateTime={decision.created}>
                  {new Intl.DateTimeFormat("zh-CN", {
                    month: "short",
                    day: "numeric",
                  }).format(new Date(decision.created))}
                </time>
                <span className={`rationale-state ${decision.rationaleStatus}`}>
                  {rationaleLabels[decision.rationaleStatus]}
                </span>
              </div>
            </button>
            <IconButton className="row-delete-button" aria-label="删除" title="删除这条决策"
              aria-describedby={`recent-decision-question-${index}`}
              onClick={() => onDeleteDecision(decision.id)}>
              <ActionIcon name="trash" />
            </IconButton>
          </li>
        ))}
      </ol>
    )}
  </section>
);
