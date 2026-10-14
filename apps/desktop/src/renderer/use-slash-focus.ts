import { useEffect, type RefObject } from "react";

const editableSelector =
  'input, textarea, select, [contenteditable="true"], [role="dialog"]';

/**
 * Pressing "/" anywhere on the page focuses the referenced search field, the
 * way many keyboard-first tools do. Typing in another field, interacting with
 * a dialog, a disabled field or a hidden field all leave the key alone.
 */
export const useSlashToFocus = (
  ref: RefObject<HTMLInputElement | null>,
): void => {
  useEffect(() => {
    const focusField = (event: KeyboardEvent): void => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(editableSelector) !== null
      ) {
        return;
      }
      const input = ref.current;
      if (input === null || input.disabled || input.closest("[hidden]") !== null) {
        return;
      }
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", focusField);
    return () => {
      window.removeEventListener("keydown", focusField);
    };
  }, [ref]);
};
