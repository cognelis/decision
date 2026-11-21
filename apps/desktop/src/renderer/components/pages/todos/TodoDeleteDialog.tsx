import { useId, useState, type ReactNode } from "react";

import { ModalDialog } from "../../ModalDialog.js";

interface TodoDeleteDialogProps {
  title: string;
  description: string;
  children: ReactNode;
  confirmLabel: string;
  /** The reader must type this (a list's name) before the button works. */
  expectedText?: string;
  busy: boolean;
  error: string | null;
  onConfirm(): void;
  onClose(): void;
}

/** A deletion asked about first: what goes, and, for a whole list, its name typed. Nothing is deleted until it is confirmed. */
export const TodoDeleteDialog = ({ title, description, children, confirmLabel, expectedText, busy, error, onConfirm, onClose }: TodoDeleteDialogProps) => {
  const id = useId();
  const [typed, setTyped] = useState("");
  const allowed = !busy && (expectedText === undefined || typed.trim() === expectedText.trim());
  return (
    <ModalDialog
      title={title}
      description={description}
      size="compact"
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" form={`${id}-form`} className="primary-button todo-danger-button" disabled={!allowed}>
            {busy ? "正在删除…" : confirmLabel}
          </button>
        </>
      }
    >
      <form
        id={`${id}-form`}
        className="todo-delete-form form-fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (allowed) onConfirm();
        }}
      >
        <div className="todo-delete-body">{children}</div>
        {expectedText === undefined ? null : (
          <div className="form-field">
            <label htmlFor={`${id}-name`}>输入清单名「{expectedText}」确认</label>
            <input id={`${id}-name`} autoFocus autoComplete="off" value={typed} disabled={busy} onChange={(event) => setTyped(event.currentTarget.value)} />
          </div>
        )}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      </form>
    </ModalDialog>
  );
};
