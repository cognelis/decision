import { useEffect, useRef, useState } from "react";

import { ActionIcon } from "../../IconButton.js";

export interface MenuEntry {
  label: string;
  /** A setting that is on or off: shown as a checkbox item. */
  checked?: boolean;
  disabled?: boolean;
  onSelect(): void;
}

/** 更多: a button that opens a short menu of things done to the list. Escape or a click outside closes it. */
export const TodoListMenu = ({ entries, busy }: { entries: readonly MenuEntry[]; busy: boolean }) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus();
    const away = (event: MouseEvent): void => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div className="todo-menu" ref={root}>
      <button
        ref={button}
        type="button"
        className="secondary-button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((current) => !current)}
      >
        <ActionIcon name="more" />更多
      </button>
      {open ? (
        <div
          className="todo-menu-popover"
          role="menu"
          aria-label="清单设置"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];
              const at = items.indexOf(document.activeElement as HTMLElement);
              items[(at + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
            }
          }}
        >
          {entries.map((entry) => (
            <button
              key={entry.label}
              type="button"
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              disabled={entry.disabled}
              onClick={() => {
                setOpen(false);
                entry.onSelect();
              }}
            >
              {entry.checked === undefined ? null : <span className="todo-menu-check" aria-hidden="true">{entry.checked ? "✓" : ""}</span>}
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};
