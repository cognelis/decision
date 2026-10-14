import type { KeyboardEvent as ReactKeyboardEvent } from "react";

const NAVIGATION_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/**
 * Arrow-key navigation over a list of focusable items. Returns `true` when the
 * key was consumed. ArrowUp on the first item calls `onLeaveTop` so a search
 * field above the list can take focus back.
 */
export const navigateList = (
  event: ReactKeyboardEvent<HTMLElement>,
  items: HTMLElement[],
  onLeaveTop?: () => void,
): boolean => {
  const { key } = event;
  if (!NAVIGATION_KEYS.has(key)) return false;
  const index = items.findIndex((item) => item === event.target);
  if (index < 0) return false;
  event.preventDefault();
  if (key === "ArrowUp" && index === 0) {
    onLeaveTop?.();
    return true;
  }
  const lastIndex = items.length - 1;
  const nextIndex =
    key === "Home"
      ? 0
      : key === "End"
        ? lastIndex
        : Math.min(lastIndex, Math.max(0, index + (key === "ArrowDown" ? 1 : -1)));
  items[nextIndex]?.focus();
  return true;
};

/** Focus the first element matching `selector` inside `root`; false if none. */
export const focusFirst = (
  root: ParentNode | null | undefined,
  selector: string,
): boolean => {
  const first = root?.querySelector<HTMLElement>(selector);
  if (first === null || first === undefined) return false;
  first.focus();
  return true;
};
