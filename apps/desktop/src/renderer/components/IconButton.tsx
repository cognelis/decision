import { useEffect, useId, useState, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";

const paths = {
  diff: "M4 2.5h8l4 4v11H4zM12 2.5v4h4M7 10h6M10 8v4M7 15h6",
  help: "M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM7.5 7.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 1.5-2.5 3.5M10 14h.01",
  refresh: "M16.5 7A7 7 0 1 0 17 12M16.5 2.5V7H12",
  download: "M10 2v10m-4-4 4 4 4-4M3 13v4h14v-4",
  more: "M4 10h.01M10 10h.01M16 10h.01",
  down: "M10 3v14m-5-5 5 5 5-5",
  send: "M10 17V3m-5 5 5-5 5 5",
  stop: "M5 5h10v10H5z",
  panel: "M2 3h16v14H2zM7 3v14",
  check: "m4 10 4 4 8-8",
  warning: "M10 3 2.5 16.5h15ZM10 8v4M10 14.5h.01",
  search: "M13 13l4 4M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0",
  copy: "M7 7h10v10H7zM13 7V3H3v10h4",
  close: "m5 5 10 10M15 5 5 15",
  previous: "m12.5 4-6 6 6 6",
  next: "m7.5 4 6 6-6 6",
  edit: "m12.5 3.5 4 4M3 17l4.5-1 10-10a1.4 1.4 0 0 0 0-2l-1.5-1.5a1.4 1.4 0 0 0-2 0L4 12.5 3 17Z",
  open: "M11 3h6v6m0-6-8 8M8 4H4v12h12v-4",
  star: "m10 2 2.5 5 5.5.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9L7.5 7Z",
  settings: "M4 3v4m0 4v6m6-14v8m0 4v2m6-14v2m0 4v8M2 7h4v4H2zm6 4h4v4H8zm6-6h4v4h-4z",
  test: "m7 4 9 6-9 6Z",
  trash: "M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6m4-6v6",
  // 页内标签页的图标，和侧栏用的是同一套 20×20 描边语汇。
  principles: "M7 5.5h9M7 10h9M7 14.5h9M3.7 5.5h.01M3.7 10h.01M3.7 14.5h.01",
  analysis: "M3 16.5h14M6.5 16.5V9M10 16.5V4.5M13.5 16.5V11.5",
  graph: "M2.6 5.5a2.4 2.4 0 1 0 4.8 0 2.4 2.4 0 1 0-4.8 0M12.6 5.5a2.4 2.4 0 1 0 4.8 0 2.4 2.4 0 1 0-4.8 0M7.6 15a2.4 2.4 0 1 0 4.8 0 2.4 2.4 0 1 0-4.8 0M7.4 5.5h5.2M6.3 7.7l2.3 5.1M13.7 7.7l-2.3 5.1",
  flow: "M2.5 3.5h5.5v4H2.5zM12 12.5h5.5v4H12zM5.2 7.5v4a2 2 0 0 0 2 2H12",
  record: "M4.5 3.5h11v13h-11zM7.5 9.6l1.8 1.8 3.2-3.6",
  idea: "M10 3.2a4.6 4.6 0 0 0-2.8 8.3v1.5h5.6v-1.5A4.6 4.6 0 0 0 10 3.2ZM8.2 15.5h3.6M8.8 17.6h2.4",
  // 历史决定页：分栏、链接与笔记、撤回、转为正式决策、列表底部的说明。
  history: "M3.5 10A6.5 6.5 0 1 0 10 3.5a7 7 0 0 0-4.9 2L3.5 7.2M3.5 3.6v3.6h3.6M10 6.5V10l2.7 1.5",
  link: "M8.5 11.5a3 3 0 0 0 4.2 0l2.8-2.8a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.8 2.8a3 3 0 0 0 4.2 4.2l1-1",
  note: "M5 3h7l3 3v11H5zM12 3v3h3",
  undo: "M4 8h8a4 4 0 0 1 0 8H8M7 5 4 8l3 3",
  promote: "M10 16V5M5.5 9.5 10 5l4.5 4.5",
  info: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM10 9v4.5M10 6.5h.01",
  // 方法论页头的两个操作：新建与工作箱。
  plus: "M10 4v12M4 10h12",
  inbox: "M3 11h3.8l1.2 2h4l1.2-2H17M5 4.5h10l2 6.5v3.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 14.5V11Z",
} as const;

/*
 * Whether the last thing the reader did was press a key rather than point. A button reached by Tab says what it does; one
 * given focus by code after a click (a dialog opening on its close button, focus handed back to what opened it) does not:
 * its tooltip stood over the dialog until the next click.
 */
let lastInputWasKey = true;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { lastInputWasKey = true; }, true);
  window.addEventListener("pointerdown", () => { lastInputWasKey = false; }, true);
}

export const ActionIcon = ({ name }: { name: keyof typeof paths }) =>
  <svg viewBox="0 0 20 20" aria-hidden="true"><path d={paths[name]} /></svg>;

export const IconButton = ({ children, className = "", title: _title, tooltipSide = "above", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string; tooltipSide?: "above" | "right" }) => {
  const id = useId();
  const [anchor, setAnchor] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = (button: HTMLButtonElement) => {
    if (props.disabled) return;
    const rect = button.getBoundingClientRect();
    const below = rect.top < 100;
    setAnchor({ x: tooltipSide === "right" ? rect.right + 8 : Math.max(128, Math.min(window.innerWidth - 128, rect.x + rect.width / 2)), y: tooltipSide === "right" ? rect.top + rect.height / 2 : below ? rect.bottom + 8 : rect.top - 8, below });
  };
  useEffect(() => {
    if (anchor === null) return;
    const hide = () => setAnchor(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [anchor]);
  return <>
    <button {...props} type={props.type ?? "button"} className={`icon-button ${className}`}
      aria-describedby={anchor === null ? props["aria-describedby"] : [props["aria-describedby"], id].filter(Boolean).join(" ")}
      onMouseEnter={(event) => { props.onMouseEnter?.(event); show(event.currentTarget); }}
      onMouseLeave={(event) => { props.onMouseLeave?.(event); if (document.activeElement !== event.currentTarget) setAnchor(null); }}
      onFocus={(event) => { props.onFocus?.(event); if (lastInputWasKey) show(event.currentTarget); }}
      onBlur={(event) => { props.onBlur?.(event); setAnchor(null); }}
      onClick={(event) => { setAnchor(null); props.onClick?.(event); }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setAnchor(null);
        props.onKeyDown?.(event);
      }}
    >{children}</button>
    {anchor === null || props.disabled ? null : createPortal(
      <span id={id} role="tooltip" className="action-tooltip" style={{ left: anchor.x, top: anchor.y, transform: tooltipSide === "right" ? "translateY(-50%)" : anchor.below ? "translateX(-50%)" : "translate(-50%, -100%)" }}>{_title ?? props["aria-label"]}</span>,
      document.body,
    )}
  </>;
};
