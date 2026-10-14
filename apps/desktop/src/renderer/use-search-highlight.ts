import { useEffect, type RefObject } from "react";

/** Where each whitespace-separated term of `query` occurs in `text`, merged and in order. */
export const findTermRanges = (
  text: string,
  query: string,
): Array<[start: number, end: number]> => {
  const ranges: Array<[number, number]> = [];
  for (const term of new Set(query.toLowerCase().split(/\s+/u))) {
    if (term.length === 0) continue;
    // Matched on the text itself, not on a lower-cased copy: "İ" lower-cases to two units, and offsets
    // taken from the copy ran past the end of the text, which threw and took the page down.
    const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
};

/**
 * Marks the search words inside `selector` under `container` through the CSS
 * Custom Highlight API: the text nodes stay whole, so nothing that reads or
 * queries the rows sees a different DOM. Where the API is missing (jsdom) it
 * does nothing.
 */
export const useSearchHighlight = (
  container: RefObject<HTMLElement | null>,
  selector: string,
  query: string,
  name: string,
  revision: unknown,
): void => {
  useEffect(() => {
    const root = container.current;
    if (root === null || typeof CSS === "undefined" || !("highlights" in CSS)) {
      return;
    }
    const ranges: Range[] = [];
    if (query.trim().length > 0) {
      for (const element of root.querySelectorAll(selector)) {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          for (const [start, end] of findTermRanges(node.textContent ?? "", query)) {
            const range = new Range();
            range.setStart(node, start);
            range.setEnd(node, end);
            ranges.push(range);
          }
        }
      }
    }
    if (ranges.length === 0) CSS.highlights.delete(name);
    else CSS.highlights.set(name, new Highlight(...ranges));
    return () => {
      CSS.highlights.delete(name);
    };
  }, [container, selector, query, name, revision]);
};
