import { IconButton, ActionIcon } from "./IconButton.js";
import type { KeyboardEvent, ReactNode } from "react";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isClearShortcut } from "../keyboard.js";

/**
 * Set over a page kept mounted but out of sight (a captured decision has the window). Its dialogs are
 * portalled to the body, past the page's own `hidden`, so they go out of sight on this, keeping what is
 * typed in them for when the page is back.
 */
export const PageHidden = createContext(false);

/**
 * Runs `refresh` when a page kept mounted out of sight is shown again: kept as it was left (its view, its
 * filters, the record open), what it shows is read again, or what was done meanwhile elsewhere (a review
 * saved on another page) showed as it was before.
 */
export const usePageShownAgain = (refresh: () => void): void => {
  const hidden = useContext(PageHidden);
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (wasHidden.current && !hidden) refresh();
    wasHidden.current = hidden;
  }, [hidden]);
};

/** Focus gone with a control taken off the page: left on the document itself, or out of sight with a page kept. */
export const pageFocusLost = (): boolean => {
  const active = document.activeElement;
  return active === null || active === document.body || active.closest("[hidden]") !== null;
};

/**
 * Focus on the title of the page in view, for when what had it went with the page before it (a jump from the home
 * page, a dialog whose opener is gone): left on the document itself, Tab started over at the top of the window and a
 * screen reader said nothing of where the reader now was.
 */
export const focusPageHeading = (): void => {
  const heading = [...document.querySelectorAll<HTMLElement>("main h1")].find((element) => element.closest("[hidden]") === null);
  if (heading === undefined) return;
  if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
};

interface ModalDialogProps {
  /** Controls placed in the header, just before the close button. */
  actions?: ReactNode;
  children: ReactNode;
  description?: string | undefined;
  dismissible?: boolean;
  /** Keys of the dialog's own, heard from anywhere inside it; one it handles is prevented and goes no further. */
  onKeyDown?: ((event: KeyboardEvent<HTMLElement>) => void) | undefined;
  onClose(): void;
  size?: "compact" | "default" | "wide" | "workspace";
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
  actions,
  children,
  description,
  dismissible = true,
  onKeyDown,
  onClose,
  size = "default",
  title,
}: ModalDialogProps) => {
  const pageHidden = useContext(PageHidden);
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  // Read while rendering: a field with autoFocus takes focus as the dialog
  // mounts, before any effect here could still see what opened it.
  const [previouslyFocused] = useState(() => document.activeElement);

  useEffect(() => {
    const dialogElement = dialogRef.current;
    // A dialog that replaced another saw a button inside the one it replaced; that one is gone now,
    // and its own cleanup has just handed focus back to what opened it, which is where this one returns too.
    // The document itself is no opener: "returned" there, focus stayed lost and the place below was never sought.
    const opener = (element: Element | null): Element | null =>
      element !== null && element !== document.body && element.isConnected ? element : null;
    const returnTo = opener(previouslyFocused) ?? opener(document.activeElement);
    // What opened it may be gone by the time it closes (a row finished from here, taken off its list
    // before the dialog is): then focus goes to whatever stands in its place in that list, else to the
    // nearest part of the page still there, and not to the page itself, where Tab starts over.
    const openerRow = returnTo instanceof Element ? returnTo.closest("li") : null;
    const openerList = openerRow?.parentElement ?? null;
    const openerIndex = openerList === null ? -1 : [...openerList.children].indexOf(openerRow!);
    const openerAncestors: Element[] = [];
    for (let node = returnTo instanceof Element ? returnTo.parentElement : null; node !== null && node !== document.body; node = node.parentElement) {
      openerAncestors.push(node);
    }
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (dialog === null || dialog.contains(document.activeElement)) return;
      // Header actions (such as stepping to another record) are not where a
      // dialog should start: Enter on them would leave what was just opened.
      [...dialog.querySelectorAll<HTMLElement>(focusableSelector)]
        .find((element) => element.closest(".modal-dialog-actions") === null)
        ?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      // StrictMode's rehearsal unmount leaves the dialog on screen; only a real close hands focus back.
      if (dialogElement?.isConnected) return;
      if (returnTo instanceof HTMLElement && returnTo.isConnected) {
        returnTo.focus();
        return;
      }
      const place = (): HTMLElement | null | undefined => {
        const rows = openerList?.isConnected ? [...openerList.children] : [];
        return (
          rows[Math.min(openerIndex, rows.length - 1)]?.querySelector<HTMLElement>(focusableSelector) ??
          openerAncestors.find((node) => node.isConnected)?.querySelector<HTMLElement>(focusableSelector)
        );
      };
      // Controls still disabled by the save that took the row away are enabled a moment later.
      const settle = (again: boolean): void => {
        if (document.activeElement !== null && document.activeElement !== document.body) return;
        const target = place();
        if (target) target.focus();
        else if (again) requestAnimationFrame(() => settle(false));
        // Nothing left of where it was opened (that page went with a jump): the title of the page in view.
        else focusPageHeading();
      };
      settle(true);
    };
  }, []);

  // A control that takes itself away (a cancel or save closing its editor, a row's own button) leaves focus on the page,
  // where this dialog's Escape and Tab no longer reach. After such an update the topmost dialog takes focus back — once
  // whatever the page does about focus itself has run, so a more fitting place set there stands. Opening is left alone.
  const opened = useRef(false);
  useEffect(() => {
    if (!opened.current) { opened.current = true; return; }
    queueMicrotask(() => {
      const dialog = dialogRef.current;
      if (dialog === null || !dialog.isConnected || (document.activeElement !== null && document.activeElement !== document.body)) return;
      const backdrops = document.querySelectorAll(".modal-backdrop:not([hidden])");
      if (backdrops[backdrops.length - 1]?.contains(dialog)) dialog.focus();
    });
  });

  // Back in sight after a capture had the window (its page kept out of sight meanwhile), the dialog takes focus back
  // to where it was in it: left to the shell, it went to the page's title behind the dialog, where Escape and the
  // dialog's Tab did not reach. Run before the shell's own (a parent's effects run after a child's), which then
  // finds focus where it belongs and leaves it.
  const lastFocused = useRef<HTMLElement | null>(null);
  const wasHidden = useRef(pageHidden);
  useEffect(() => {
    const shownAgain = wasHidden.current && !pageHidden;
    wasHidden.current = pageHidden;
    const dialog = dialogRef.current;
    if (!shownAgain || dialog === null || dialog.contains(document.activeElement)) return;
    const backdrops = document.querySelectorAll(".modal-backdrop:not([hidden])");
    if (!backdrops[backdrops.length - 1]?.contains(dialog)) return;
    const last = lastFocused.current;
    (last !== null && last.isConnected && dialog.contains(last) && !last.matches(":disabled") ? last : dialog).focus();
  }, [pageHidden]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    // An Escape that ends an input method's composition belongs to the input method, not to the dialog.
    if (isClearShortcut(event) && dismissible) {
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
    // From the dialog itself too, where focus is put back when a control goes away (an inline editor saved, a
    // field disabled while saving) and where a click on its text leaves it: Shift+Tab walked out onto the page.
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const closeButton = (
    <IconButton
      type="button"
      className="modal-dialog-close"
      aria-label={`关闭${title}`}
      disabled={!dismissible}
      onClick={onClose}
    >
      <ActionIcon name="close" />
    </IconButton>
  );

  return createPortal(
    <div
      className="modal-backdrop no-drag"
      hidden={pageHidden}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        // Not to be closed now, a click outside keeps focus where it was: on the page behind, this dialog's keys
        // would stop working and the app's shortcuts could leave it with its draft.
        if (dismissible) onClose();
        else event.preventDefault();
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
        onFocus={(event) => { lastFocused.current = event.target; }}
      >
        <header className="modal-dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description === undefined ? null : (
              <p id={descriptionId}>{description}</p>
            )}
          </div>
          {actions === undefined ? (
            closeButton
          ) : (
            <div className="modal-dialog-header-actions">
              <div className="modal-dialog-actions">{actions}</div>
              {closeButton}
            </div>
          )}
        </header>
        <div className="modal-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
};
