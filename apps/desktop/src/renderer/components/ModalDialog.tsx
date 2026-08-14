import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

interface ModalDialogProps {
  children: ReactNode;
  description?: string | undefined;
  dismissible?: boolean;
  onClose(): void;
  size?: "compact" | "default" | "wide";
  title: string;
}

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export const ModalDialog = ({
  children,
  description,
  dismissible = true,
  onClose,
  size = "default",
  title,
}: ModalDialogProps) => {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog === null || dialog.contains(document.activeElement)) return;
      dialog.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus();
      }
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && dismissible) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(focusableSelector),
    ];
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="modal-backdrop no-drag"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className={`modal-dialog modal-dialog-${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
      >
        <header className="modal-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description === undefined ? null : (
              <p id={descriptionId}>{description}</p>
            )}
          </div>
          <button
            type="button"
            className="modal-dialog-close"
            aria-label={`关闭${title}`}
            disabled={!dismissible}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="modal-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
};
