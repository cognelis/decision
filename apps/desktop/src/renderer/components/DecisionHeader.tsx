import type { RationaleCandidate } from "@cognelis/decision-core";

import { SourceBadge } from "./SourceBadge.js";

interface DecisionHeaderProps {
  candidate: RationaleCandidate;
  waitingCount: number;
  /**
   * The id of the question as the page shows it. The title takes focus when one capture gives way to the next; it
   * names the page, and through this a screen reader also says which question is now asked.
   */
  questionId?: string;
}

/**
 * The page's name, where the decision came from under it, and what still waits on the right. The question is the
 * panel's first thing, in full: as the title, an assistant's whole message stood there as two lines of large bold text.
 */
export const DecisionHeader = ({
  candidate,
  waitingCount,
  questionId,
}: DecisionHeaderProps) => (
  <header className="decision-header drag-region">
    <div>
      <h1 aria-describedby={questionId}>补充理由</h1>
      <p className="origin-line">
        <SourceBadge source={candidate.event.sourceClient} />
        <span className="project-name">{candidate.event.project}</span>
      </p>
    </div>
    {waitingCount > 0 ? (
      <span className="waiting-count">
        还有 <strong>{waitingCount}</strong> 个待处理
      </span>
    ) : null}
  </header>
);
