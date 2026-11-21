import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * A captured question as one run of plain text, for a title. Captured questions are often an assistant's whole
 * message, with lists and emphasis: those marks belong to the full text shown elsewhere, not to a heading.
 */
export const plainHeadline = (text: string): string =>
  text
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/gmu, "")
    .replace(/(\*\*|__|`)(.+?)\1/gu, "$2")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/gu, "$1")
    // Lines joined: after a Chinese stop the next line runs straight on, as it would have been written on one line;
    // anywhere else a space keeps two phrases apart.
    .replace(/(?<=[、。，：；！？」』）])\s*\n\s*/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Whether a line-clamped title shows less than all of its text, followed as the window resizes. Where it does, or
 * where the question had paragraphs and lists the title flattens, the page shows the question whole as well.
 */
export const useClampedTitle = <T extends HTMLElement>(question: string): [RefObject<T | null>, boolean] => {
  const ref = useRef<T>(null);
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const title = ref.current;
    if (title === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setClamped(title.scrollHeight > title.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(title);
    return () => observer.disconnect();
  }, [question]);
  return [ref, clamped || question.trim().includes("\n")];
};
