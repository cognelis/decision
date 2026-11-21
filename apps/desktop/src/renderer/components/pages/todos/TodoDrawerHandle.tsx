import { useLayoutEffect, useRef, useState } from "react";

const STORAGE_KEY = "paraself.todos.drawer-width";
export const DRAWER_DEFAULT = 560;
export const DRAWER_MIN = 360;
/** The widest the drawer goes: 60% of the window's width. */
const SHARE = 0.6;

const saved = (): number | null => {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= DRAWER_MIN ? value : null;
  } catch {
    return null;
  }
};

/**
 * The drawer's left edge: dragged (or moved with the arrow keys) it sets the drawer's width, between 360px and 60% of the
 * window; a double click puts the default (560px) back. The width is kept on this machine. It sets `--todo-drawer-width`
 * on the workspace, so nothing else renders while it moves.
 */
export const TodoDrawerHandle = ({ controls }: { controls: string }) => {
  const handle = useRef<HTMLDivElement>(null);
  const preferred = useRef<number | null>(saved());
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [width, setWidth] = useState(preferred.current ?? DRAWER_DEFAULT);
  const [maximum, setMaximum] = useState(Math.round(window.innerWidth * SHARE));
  const limit = (): number => Math.max(DRAWER_MIN, Math.round(window.innerWidth * SHARE));
  const apply = (value: number): number => {
    const next = Math.round(Math.max(DRAWER_MIN, Math.min(limit(), value)));
    handle.current?.closest<HTMLElement>(".todo-workspace")?.style.setProperty("--todo-drawer-width", `${next}px`);
    setWidth(next);
    setMaximum(limit());
    return next;
  };
  const persist = (): void => {
    try {
      if (preferred.current === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(preferred.current));
    } catch {
      // Not kept: the width is the default again at the next start.
    }
  };
  useLayoutEffect(() => {
    apply(preferred.current ?? DRAWER_DEFAULT);
    const again = (): void => void apply(preferred.current ?? DRAWER_DEFAULT);
    window.addEventListener("resize", again);
    return () => {
      window.removeEventListener("resize", again);
      handle.current?.closest<HTMLElement>(".todo-workspace")?.style.removeProperty("--todo-drawer-width");
    };
  }, []);
  return (
    <div
      ref={handle}
      className="todo-drawer-handle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="拖动调整详情宽度"
      aria-controls={controls}
      aria-valuemin={DRAWER_MIN}
      aria-valuemax={maximum}
      aria-valuenow={width}
      aria-valuetext={`${width} 像素`}
      title="拖动调整详情宽度；双击恢复默认。也可用左右方向键调整。"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current !== null) return;
        event.preventDefault();
        event.currentTarget.focus();
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag.current === null) return;
        // The drawer is on the right: dragging left makes it wider.
        preferred.current = apply(drag.current.width + drag.current.x - event.clientX);
      }}
      onPointerUp={(event) => {
        if (drag.current === null) return;
        drag.current = null;
        persist();
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => {
        preferred.current = null;
        apply(DRAWER_DEFAULT);
        persist();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const next = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step : event.key === "Home" ? DRAWER_MIN : event.key === "End" ? limit() : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        preferred.current = apply(next);
        persist();
      }}
    />
  );
};
