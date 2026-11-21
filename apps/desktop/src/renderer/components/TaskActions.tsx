import { clipText, HISTORICAL_DECISION_LIMITS } from "@cognelis/decision-protocol";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import {
  DISMISS_SHORTCUT_KEYS,
  dismissShortcutLabel,
  isClearShortcut,
  isDeferShortcut,
  isDismissShortcut,
  isPreferenceShortcut,
  isSubmitShortcut,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../keyboard.js";
import { ActionIcon } from "./IconButton.js";
import { ModalDialog } from "./ModalDialog.js";
import type { ActiveRecordDraft } from "./pages/decisions/ActiveRecordDialog.js";
import { plainHeadline } from "./question-title.js";

interface TaskActionProps {
  label: string;
  primary?: boolean;
  disabled: boolean;
  title?: string;
  /** Its shortcut, as aria-keyshortcuts and as shown on the button. */
  shortcut?: { keys: string; label: string };
  icon?: Parameters<typeof ActionIcon>[0]["name"];
  onAct(): void;
}

/**
 * One answer to what is on the page. The next one takes this one's place with these buttons where they were: the
 * second click of a double-click acted on one shown a moment and never read, so only a click of its own acts.
 */
export const TaskAction = ({ label, primary = false, disabled, title, shortcut, icon, onAct }: TaskActionProps) => (
  <button
    type="button"
    className={primary ? "primary-button" : "secondary-button"}
    disabled={disabled}
    title={title}
    aria-keyshortcuts={shortcut?.keys}
    onClick={(event) => {
      if (event.detail > 1) return;
      onAct();
    }}
  >
    {icon === undefined ? null : <ActionIcon name={icon} />}
    {label}
    {shortcut === undefined ? null : (
      <kbd className="shortcut-hint" aria-hidden="true">{shortcut.label}</kbd>
    )}
  </button>
);

/** Not to record it, apart from the rest and last, as a text button. It only asks: see TaskDismissDialog. */
export const TaskDismissAction = ({ label, disabled, onAct }: Pick<TaskActionProps, "label" | "disabled" | "onAct">) => (
  <button
    type="button"
    className="text-button danger-button task-dismiss"
    disabled={disabled}
    aria-haspopup="dialog"
    aria-keyshortcuts={DISMISS_SHORTCUT_KEYS}
    onClick={(event) => {
      if (event.detail > 1) return;
      onAct();
    }}
  >
    {label}
    <kbd className="shortcut-hint" aria-hidden="true">{dismissShortcutLabel()}</kbd>
  </button>
);

interface TaskDismissDialogProps {
  title: string;
  description: string;
  question: string;
  confirmLabel: string;
  onCancel(): void;
  onConfirm(): void;
}

/**
 * Letting one go, asked first: one stray click on the bar, or ⌘D, lost it. 取消 holds focus, so a plain ↩ keeps it;
 * Esc cancels and ⌘↩ confirms, as everywhere else.
 */
export const TaskDismissDialog = ({ title, description, question, confirmLabel, onCancel, onConfirm }: TaskDismissDialogProps) => (
  <ModalDialog
    title={title}
    description={description}
    size="compact"
    onClose={onCancel}
    onKeyDown={(event) => {
      if (!isSubmitShortcut(event)) return;
      event.preventDefault();
      if (!event.repeat) onConfirm();
    }}
    footer={
      <>
        <button className="secondary-button" type="button" autoFocus aria-keyshortcuts="Escape" onClick={onCancel}>
          取消
          <kbd className="shortcut-hint" aria-hidden="true">Esc</kbd>
        </button>
        <button
          className="primary-button danger-button"
          type="button"
          aria-keyshortcuts={SUBMIT_SHORTCUT_KEYS}
          // Only a click of its own confirms, not the second of a double-click on the button that asked.
          onClick={(event) => {
            if (event.detail > 1) return;
            onConfirm();
          }}
        >
          {confirmLabel}
          <kbd className="shortcut-hint" aria-hidden="true">{submitShortcutLabel()}</kbd>
        </button>
      </>
    }
  >
    <div className="modal-decision-summary">
      <strong>{plainHeadline(question)}</strong>
    </div>
  </ModalDialog>
);

export const TaskActionBar = ({ children }: { children: ReactNode }) => (
  <footer className="task-actions">{children}</footer>
);

interface TaskShortcuts {
  submit(): void;
  skip(): void;
  preference(): void;
  dismiss(): void;
  close?(): void;
}

/** The same keys on 待处理 and on the rationale panel, from anywhere on the page but an open dialog, which has its own. */
export const useTaskShortcuts = (shortcuts: TaskShortcuts): void => {
  const latest = useRef(shortcuts);
  // Both before the page is painted: a key pressed as soon as the panel shows (a passive effect waits for an idle
  // moment, long under load) acts, and on the panel as it now reads, never one gone.
  useLayoutEffect(() => {
    latest.current = shortcuts;
  });
  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== null) return;
      if (isClearShortcut(event)) {
        latest.current.close?.();
        return;
      }
      const act = isSubmitShortcut(event) ? latest.current.submit
        : isDeferShortcut(event) ? latest.current.skip
          : isPreferenceShortcut(event) ? latest.current.preference
            : isDismissShortcut(event) ? latest.current.dismiss
              : undefined;
      if (act === undefined) return;
      event.preventDefault();
      // Held down, the key repeats onto the one that takes this one's place, which then goes unread.
      if (event.repeat) return;
      act();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
};

/** The form's starting text when a captured question turns out to be where the user stands: theirs to edit before saving. */
export const preferenceDraft = ({ question, answer, rationale, project, context }: {
  question: string;
  answer: string;
  rationale?: string;
  project?: string | undefined;
  context?: string | null | undefined;
}): ActiveRecordDraft => ({
  kind: "preference",
  title: clipText(plainHeadline(question), 500),
  content: clipText(answer, 8_000),
  ...(rationale?.trim() ? { rationale: clipText(rationale.trim(), 8_000) } : {}),
  ...(project ? { project } : {}),
  ...(context?.trim() ? { context: clipText(context.trim(), 8_000) } : {}),
});

export const HISTORICAL_TRIAGE_TITLE = "只留档这件事定了什么：不用写理由，不进入待补理由和复盘";

/**
 * The form's starting text when a captured choice is only to be kept on record (历史决定): what was chosen, what was
 * not, and what it was asked in. A rationale written so far is not carried: a 历史决定 has none.
 */
export const historicalDraft = ({ question, answer, alternatives, project, context }: {
  question: string;
  answer: string;
  /** The options not chosen, as captured. */
  alternatives: readonly string[];
  project?: string | undefined;
  context?: string | null | undefined;
}): ActiveRecordDraft => ({
  kind: "historical",
  title: clipText(plainHeadline(question), HISTORICAL_DECISION_LIMITS.title),
  content: clipText(answer, HISTORICAL_DECISION_LIMITS.decision),
  ...(project ? { project } : {}),
  ...(context?.trim() ? { context: clipText(context.trim(), HISTORICAL_DECISION_LIMITS.context) } : {}),
  historical: {
    // An option is one line of the note, and a record holds only so many.
    options: alternatives.map((option) => clipText(plainHeadline(option), HISTORICAL_DECISION_LIMITS.option)).filter((option) => option.length > 0).slice(0, HISTORICAL_DECISION_LIMITS.options),
    sourceKind: "agent_capture",
  },
});
