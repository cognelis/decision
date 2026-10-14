import { useLayoutEffect, useRef, useState } from "react";

const MIN = 180;
const MAX = 480;
const readWidth = (key: string): number | null => {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= MIN && value <= MAX ? value : null;
  } catch { return null; }
};

/** Resize only the grid column, without rerendering the conversation on every move. */
export function ListWidthHandle({ storageKey, label, controls }: { storageKey: string; label: string; controls: string }) {
  const handle = useRef<HTMLDivElement>(null);
  const [saved] = useState(() => readWidth(storageKey));
  const preferred = useRef(saved);
  const drag = useRef<{ x: number; width: number; preferred: number | null } | null>(null);
  const bounds = useRef({ width: saved ?? 248, max: MAX });
  const [geometry, setGeometry] = useState(bounds.current);
  const apply = (value: number) => {
    const width = Math.round(Math.max(MIN, Math.min(bounds.current.max, value)));
    bounds.current = { ...bounds.current, width };
    handle.current?.parentElement?.style.setProperty("--list-width", `${width}px`);
    setGeometry(previous => previous.width === width && previous.max === bounds.current.max ? previous : { ...bounds.current });
  };
  const defaultWidth = () => (handle.current?.parentElement?.clientWidth ?? 0) <= 850 ? 218 : 248;
  const persist = () => {
    try {
      if (preferred.current === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(preferred.current));
    } catch { /* Width remains adjustable when local storage is unavailable. */ }
  };
  useLayoutEffect(() => {
    const parent = handle.current?.parentElement;
    if (!parent) return;
    const sync = () => {
      if (!parent.clientWidth) return;
      bounds.current.max = Math.max(MIN, Math.min(MAX, parent.clientWidth - 360));
      apply(preferred.current ?? defaultWidth());
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  return <div ref={handle} className="list-width-handle" role="separator" tabIndex={0}
    aria-label={label} aria-controls={controls} aria-orientation="vertical"
    aria-valuemin={MIN} aria-valuemax={geometry.max} aria-valuenow={geometry.width} aria-valuetext={`${geometry.width} 像素`}
    title="拖动调整列表宽度；双击恢复默认。也可用左右方向键调整。"
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      drag.current = { x: event.clientX, width: bounds.current.width, preferred: preferred.current };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event => {
      if (!drag.current) return;
      apply(drag.current.width + event.clientX - drag.current.x);
      preferred.current = bounds.current.width;
    }}
    onPointerUp={event => {
      if (!drag.current) return;
      preferred.current = bounds.current.width;
      drag.current = null;
      persist();
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => {
      if (!drag.current) return;
      preferred.current = drag.current.preferred;
      apply(drag.current.width);
      drag.current = null;
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={() => { preferred.current = null; apply(defaultWidth()); persist(); }}
    onKeyDown={event => {
      const step = event.shiftKey ? 40 : 10;
      const next = event.key === "ArrowLeft" ? geometry.width - step : event.key === "ArrowRight" ? geometry.width + step : event.key === "Home" ? MIN : event.key === "End" ? geometry.max : null;
      if (next === null) return;
      event.preventDefault(); apply(next); preferred.current = bounds.current.width; persist();
    }} />;
}
