import type { RecentDecisionSummary } from "../../shared/renderer-api.js";

const rationaleLabels: Record<
  RecentDecisionSummary["rationaleStatus"],
  string
> = {
  captured: "理由完整",
  deferred: "待补理由",
  skipped: "未补理由",
};

const sourceLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  test: "Test",
};

export const RecentDecisionList = ({
  decisions,
}: {
  decisions: RecentDecisionSummary[];
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
        {decisions.map((decision) => (
          <li key={decision.id}>
            <div className="recent-decision-copy">
              <strong>{decision.question}</strong>
              <span>{decision.selectedAnswer}</span>
            </div>
            <div className="recent-decision-meta">
              <span>{decision.project}</span>
              <span>
                {sourceLabels[decision.sourceClient] ?? decision.sourceClient}
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
          </li>
        ))}
      </ol>
    )}
  </section>
);
