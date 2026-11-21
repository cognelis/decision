/**
 * The lines the App writes around a local model's summary of a record's context, each a whole line: the mark over an
 * adopted summary, the line before the context it was put in front of, and the summary's own labels. Searching leaves
 * them out as it does a note's headings (DECISION_NOTE_TEMPLATE): read as what a decision says, every decision with an
 * adopted summary was a match for 上下文, 采用, 本机模型 and 观点.
 */
export const CONTEXT_SUMMARY_LINES = {
  /**
   * The model wrote it and the reader took it, which no field of a decision says: without it, the summary read later
   * as what was written down at the time.
   */
  mark: "（本机模型总结，经确认采用）",
  original: "（以下为原上下文）",
  change: "在做什么：",
  views: "各方观点：",
  decided: "定了什么：",
} as const;

/** A record's context once the reader adopts a summary: in place of what was there, or in front of `kept`. */
export const adoptedSummaryContext = (summary: string, kept?: string): string => {
  const head = `${CONTEXT_SUMMARY_LINES.mark}\n${summary}`;
  return kept === undefined || kept.trim() === "" ? head : `${head}\n\n${CONTEXT_SUMMARY_LINES.original}\n${kept}`;
};
