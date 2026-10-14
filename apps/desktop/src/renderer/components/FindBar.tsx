import { useEffect, useRef, useState } from "react";
import { ActionIcon, IconButton } from "./IconButton.js";

/**
 * The dialog on top when one is shown, else the page: what the reader is looking at. A dialog left open on a
 * page kept mounted but hidden is not it: searched instead, every search said 没有匹配.
 */
const searchRoot = (bar: Element | null): Element | null => {
  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(dialog =>
    !bar?.contains(dialog) && dialog.closest("[hidden]") === null &&
    (typeof dialog.checkVisibility !== "function" || dialog.checkVisibility()));
  return dialogs.at(-1) ?? document.querySelector(".desktop-stage");
};

/** Every visible occurrence of the words, in reading order; a hidden page kept mounted is skipped. */
const findRanges = (root: Element, query: string, bar: Element | null): Range[] => {
  const needle = query.toLocaleLowerCase();
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || bar?.contains(parent) || (typeof parent.checkVisibility === "function" && !parent.checkVisibility())) continue;
    const text = (node.textContent ?? "").toLocaleLowerCase();
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
};

const highlight = (ranges: Range[], active: number): void => {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (!ranges.length) { CSS.highlights.delete("find-match"); CSS.highlights.delete("find-active"); return; }
  CSS.highlights.set("find-match", new Highlight(...ranges));
  CSS.highlights.set("find-active", new Highlight(ranges[active]!));
};

/**
 * ⌘F / Ctrl+F finds words on the page or in the dialog on top, as a browser does — Electron has
 * no find bar of its own. Marks go through the CSS Custom Highlight API, so the page is not touched.
 */
export const FindBar = () => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState({ total: 0, active: 0 });
  const bar = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Where the reader was before ⌘F: closing the bar goes back there, as a dialog does.
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.isComposing || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      if (!bar.current?.contains(document.activeElement)) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setOpen(true);
      requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Looked up again on every step, so text that changed since the last one is found as it is now.
  const go = (step: number, from = found.active, reveal = true) => {
    const root = searchRoot(bar.current);
    const ranges = open && query.trim() && root ? findRanges(root, query.trim(), bar.current) : [];
    const active = ranges.length ? (from + step + ranges.length) % ranges.length : 0;
    setFound({ total: ranges.length, active });
    highlight(ranges, active);
    if (reveal) ranges[active]?.startContainer.parentElement?.scrollIntoView?.({ block: "center" });
  };
  const close = () => {
    setOpen(false);
    if (returnTo.current?.isConnected) returnTo.current.focus();
  };
  // A new search starts from its first match.
  useEffect(() => {
    if (!open) { highlight([], 0); return; }
    go(0, 0);
  }, [open, query]);
  useEffect(() => () => highlight([], 0), []);
  // Text that changes under an open search (another record opened, an answer streaming in) is
  // searched again, in place and without scrolling; the bar's own count is not such a change.
  const [changes, setChanges] = useState(0);
  useEffect(() => {
    if (!open || !query.trim()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(records => {
      if (records.every(record => bar.current?.contains(record.target))) return;
      clearTimeout(timer);
      timer = setTimeout(() => setChanges(value => value + 1), 150);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [open, query]);
  useEffect(() => { if (changes) go(0, found.active, false); }, [changes]);

  if (!open) return null;
  return <div ref={bar} className="find-bar" role="search" aria-label="在页面中查找">
    <input ref={input} type="search" aria-label="在页面中查找" placeholder="在页面中查找" value={query}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
        if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); }
      }} />
    <span aria-live="polite">{query.trim() ? found.total ? `${found.active + 1} / ${found.total}` : "没有匹配" : ""}</span>
    <IconButton aria-label="上一个匹配" disabled={found.total < 2} onClick={() => go(-1)}><ActionIcon name="previous" /></IconButton>
    <IconButton aria-label="下一个匹配" disabled={found.total < 2} onClick={() => go(1)}><ActionIcon name="next" /></IconButton>
    <IconButton aria-label="关闭查找" onClick={close}><ActionIcon name="close" /></IconButton>
  </div>;
};
