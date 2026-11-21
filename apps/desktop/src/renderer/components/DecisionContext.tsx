import type { CapturedDecisionContext } from "@cognelis/decision-protocol";
import { useState } from "react";

import { ModalDialog } from "./ModalDialog.js";
import { renderMarkdown } from "./pages/assistant/markdown.js";

interface DecisionContextProps {
  context: CapturedDecisionContext | undefined;
}

/** What an assistant wrote, kept with the decision: Markdown, set quieter than the question it surrounds. */
export const CapturedText = ({ text }: { text: string }) => (
  <div className="assistant-answer captured-text">{renderMarkdown(text)}</div>
);

export const DecisionContext = ({ context }: DecisionContextProps) => {
  const [dialogOpen, setDialogOpen] = useState(false);
  const hasContext =
    context?.taskBackground !== undefined ||
    context?.decisionFraming !== undefined;

  if (!hasContext || context === undefined) {
    return null;
  }

  return (
    <>
      <section className="decision-context" aria-label="决策上下文">
        <div className="decision-context-toolbar">
          <h2>当时上下文</h2>
          {context.truncated === true ? <small>上下文已截断</small> : null}
        </div>
        <div className="decision-context-preview">
          {context.taskBackground === undefined ? null : (
            <CapturedText text={context.taskBackground} />
          )}
          {context.decisionFraming === undefined ? null : (
            <CapturedText text={context.decisionFraming} />
          )}
        </div>
        {/* One link, under what it opens in full, wherever the context is shown (C2). */}
        <button
          type="button"
          className="context-toggle"
          aria-haspopup="dialog"
          onClick={() => setDialogOpen(true)}
        >
          查看完整上下文
        </button>
      </section>

      {dialogOpen ? (
        <ModalDialog
          title="当时上下文"
          description={context.truncated === true ? "上下文已截断" : undefined}
          onClose={() => setDialogOpen(false)}
          size="wide"
        >
          <div className="decision-context-body decision-context-dialog-body">
            {context.taskBackground === undefined ? null : (
              <section>
                <h3>任务背景</h3>
                <CapturedText text={context.taskBackground} />
              </section>
            )}
            {context.decisionFraming === undefined ? null : (
              <section>
                <h3>约束与考虑</h3>
                <CapturedText text={context.decisionFraming} />
              </section>
            )}
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
};
