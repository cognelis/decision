import { useEffect, useRef, type ReactNode } from "react";

/** One line of a menu: a choice among several (checked or not), an action, or a rule between groups. */
export type MenuEntry =
  | { kind: "radio"; key: string; label: string; checked: boolean; onSelect(): void }
  | { kind: "action"; key: string; label: string; danger?: boolean; icon?: ReactNode; onSelect(): void }
  | { kind: "rule"; key: string };

interface ItemMenuProps {
  /** Names the menu for a screen reader. */
  menuLabel: string;
  /** The button that opens it; left out, the menu opens beside nothing (the keys E and P open it from the row). */
  button: ReactNode | null;
  buttonLabel: string;
  buttonClassName: string;
  buttonData?: Record<string, string>;
  entries: readonly MenuEntry[];
  open: boolean;
  onOpenChange(open: boolean): void;
  disabled?: boolean;
  popoverClassName?: string;
}

/**
 * A menu a row opens from its button, or from the keyboard: arrows move, Enter picks, Escape closes it and gives focus
 * back to what had it before. Controlled, so that the page can open the one of the row in focus.
 */
export const ItemMenu = ({ menuLabel, button, buttonLabel, buttonClassName, buttonData, entries, open, onOpenChange, disabled = false, popoverClassName = "" }: ItemMenuProps) => {
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    const popover = root.current?.querySelector<HTMLElement>('[role="menu"]');
    (popover?.querySelector<HTMLElement>('[aria-checked="true"]') ?? popover?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
    const away = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) onOpenChange(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, onOpenChange]);
  const close = (): void => {
    onOpenChange(false);
    const back = opener.current;
    const target = back instanceof HTMLElement && back.isConnected && back !== document.body ? back : trigger.current;
    // After the menu is gone from the page.
    queueMicrotask(() => target?.focus());
  };
  return (
    <span className="todo-status-menu" ref={root}>
      {button === null ? null : (
        <button
          ref={trigger}
          type="button"
          className={buttonClassName}
          {...Object.fromEntries(Object.entries(buttonData ?? {}).map(([name, value]) => [`data-${name}`, value]))}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={buttonLabel}
          disabled={disabled}
          onClick={() => onOpenChange(!open)}
        >
          {button}
        </button>
      )}
      {open ? (
        <div
          className={`todo-menu-popover todo-status-popover ${popoverClassName}`}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const choices = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
              const at = choices.indexOf(document.activeElement as HTMLElement);
              choices[(at + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length]?.focus();
            } else if (event.key === "Tab") {
              onOpenChange(false);
            }
          }}
        >
          {entries.map((entry) =>
            entry.kind === "rule" ? (
              <hr key={entry.key} />
            ) : (
              <button
                key={entry.key}
                type="button"
                role={entry.kind === "radio" ? "menuitemradio" : "menuitem"}
                aria-checked={entry.kind === "radio" ? entry.checked : undefined}
                className={entry.kind === "action" && entry.danger === true ? "todo-menu-danger" : undefined}
                onClick={() => {
                  // Focus is the page's to place once the change is made (it goes to the item the menu was opened on).
                  onOpenChange(false);
                  if (entry.kind === "action" || !entry.checked) entry.onSelect();
                }}
              >
                <span className="todo-menu-check" aria-hidden="true">{entry.kind === "radio" && entry.checked ? "✓" : entry.kind === "action" ? entry.icon : ""}</span>
                {entry.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </span>
  );
};
