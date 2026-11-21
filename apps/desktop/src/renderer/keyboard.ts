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

/**
 * Cmd+L or Ctrl+L, L for later: puts a rationale off. By the key's place as well as its letter, so a layout or an
 * input method that reports another character still reaches it.
 */
export const isDeferShortcut = (event: AnyKeyboardEvent): boolean =>
  (event.key.toLowerCase() === "l" || event.code === "KeyL") &&
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey &&
  !isComposing(event);

export const DEFER_SHORTCUT_KEYS = "Meta+L Control+L";

/** Cmd+P or Ctrl+P, P for preference: what is before you is no decision, but where you stand. */
export const isPreferenceShortcut = (event: AnyKeyboardEvent): boolean =>
  (event.key.toLowerCase() === "p" || event.code === "KeyP") &&
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey &&
  !isComposing(event);

export const PREFERENCE_SHORTCUT_KEYS = "Meta+P Control+P";

/** Cmd+D or Ctrl+D, D for dismiss: asks whether to let what is before you go. */
export const isDismissShortcut = (event: AnyKeyboardEvent): boolean =>
  (event.key.toLowerCase() === "d" || event.code === "KeyD") &&
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey &&
  !isComposing(event);

export const DISMISS_SHORTCUT_KEYS = "Meta+D Control+D";

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

/** Visible label for the defer shortcut, e.g. "⌘L" or "Ctrl+L". */
export const deferShortcutLabel = (): string => `${modifierKeyLabel()}L`;

/** Visible label for the preference shortcut, e.g. "⌘P" or "Ctrl+P". */
export const preferenceShortcutLabel = (): string => `${modifierKeyLabel()}P`;

/** Visible label for the dismiss shortcut, e.g. "⌘D" or "Ctrl+D". */
export const dismissShortcutLabel = (): string => `${modifierKeyLabel()}D`;

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
