import type { KeyboardEvent as ReactKeyboardEvent } from "react";

type AnyKeyboardEvent = KeyboardEvent | ReactKeyboardEvent<Element>;

/** True while an IME is mid-composition, where keys are not yet commands. */
export const isComposing = (event: AnyKeyboardEvent): boolean =>
  "nativeEvent" in event
    ? event.nativeEvent.isComposing
    : event.isComposing;

/**
 * Cmd+Enter on macOS or Ctrl+Enter elsewhere. Both modifiers are accepted on
 * every platform so muscle memory carries across machines; Shift/Alt variants
 * and in-progress IME composition never count as a submit.
 */
export const isSubmitShortcut = (event: AnyKeyboardEvent): boolean =>
  event.key === "Enter" &&
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey &&
  !isComposing(event);

export const SUBMIT_SHORTCUT_KEYS = "Meta+Enter Control+Enter";

export const isApplePlatform = (): boolean => {
  if (typeof navigator === "undefined") return false;
  return (
    /Mac|iPhone|iPad|iPod/u.test(navigator.platform ?? "") ||
    /Macintosh|Mac OS X/u.test(navigator.userAgent ?? "")
  );
};

/** Visible label for the primary modifier, e.g. "⌘" or "Ctrl+". */
export const modifierKeyLabel = (): string =>
  isApplePlatform() ? "⌘" : "Ctrl+";

/** Visible label for the submit shortcut, e.g. "⌘↩" or "Ctrl+↩". */
export const submitShortcutLabel = (): string => `${modifierKeyLabel()}↩`;

/** Escape inside a text field, ignoring IME composition. */
export const isClearShortcut = (event: AnyKeyboardEvent): boolean =>
  event.key === "Escape" && !isComposing(event);

/**
 * A control disabled while its change is saved loses focus to the page, and a row moved in the list
 * does too: once the change is done, focus goes back to it.
 */
export const keepSwitchFocus = (control: HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement, pending: Promise<unknown>): void => {
  const focused = document.activeElement === control;
  const restore = (): void => {
    if (!focused) return;
    requestAnimationFrame(() => {
      if (control.isConnected && !control.disabled && document.activeElement === document.body) {
        control.focus();
      }
    });
  };
  void pending.then(restore, restore);
};
