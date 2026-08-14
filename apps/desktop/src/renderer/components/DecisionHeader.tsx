import type { RationaleCandidate } from "@cognelis/decision-core";

import { SourceBadge } from "./SourceBadge.js";

interface DecisionHeaderProps {
  candidate: RationaleCandidate;
  waitingCount: number;
}

export const DecisionHeader = ({
  candidate,
  waitingCount,
}: DecisionHeaderProps) => (
  <header className="decision-header drag-region">
    <div className="origin-line">
      <SourceBadge source={candidate.event.sourceClient} />
      <span className="project-name">{candidate.event.project}</span>
      {waitingCount > 0 ? (
        <span className="waiting-count">
          还有 {waitingCount} 个待处理
        </span>
      ) : null}
    </div>
    <h1>{candidate.question.question}</h1>
  </header>
);
