import type { CapturedDecisionContext } from "@cognelis/decision-protocol";
import { useState } from "react";

import { ModalDialog } from "./ModalDialog.js";

interface DecisionContextProps {
  context: CapturedDecisionContext | undefined;
}

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
          <span>当时上下文</span>
          {context.truncated === true ? <small>上下文已截断</small> : null}
          <button
            type="button"
            className="text-button context-toggle"
            aria-haspopup="dialog"
            onClick={() => setDialogOpen(true)}
          >
            查看完整上下文
          </button>
        </div>
        <div className="decision-context-preview">
          {context.taskBackground === undefined ? null : (
            <p>{context.taskBackground}</p>
          )}
          {context.decisionFraming === undefined ? null : (
            <p>{context.decisionFraming}</p>
          )}
        </div>
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
                <p>{context.taskBackground}</p>
              </section>
            )}
            {context.decisionFraming === undefined ? null : (
              <section>
                <h3>约束与考虑</h3>
                <p>{context.decisionFraming}</p>
              </section>
            )}
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
};
