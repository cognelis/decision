/**
 * Whether a single-choice answer is the option the agent marked as
 * recommended. Only an explicit marker in an option's label counts: a
 * description often says "推荐用于…" without recommending that option.
 */
const MARKER_IN_BRACKETS = /[（(【［[]\s*(?:推荐|recommended)\s*[）)】］\]]/giu;
const MARKER_LEADING = /^\s*(?:推荐|recommended)\s*[:：]/iu;

export const hasRecommendationMarker = (label: string): boolean =>
  new RegExp(MARKER_IN_BRACKETS.source, "iu").test(label) ||
  MARKER_LEADING.test(label);

export const stripRecommendationMarker = (label: string): string =>
  label.replace(MARKER_IN_BRACKETS, "").replace(MARKER_LEADING, "").trim();

/** The one option whose label carries a marker; none when no option or several do. */
export const markedRecommendation = <T extends { label: string }>(
  options: ReadonlyArray<T>,
): T | undefined => {
  const marked = options.filter((option) => hasRecommendationMarker(option.label));
  return marked.length === 1 ? marked[0] : undefined;
};

export interface RecommendationAnswer {
  kind: string;
  values: readonly string[];
}

/**
 * "followed" / "not_followed" when exactly one option carries a marker and the
 * answer is a single pick; null when there is no unique recommendation or the
 * answer is a multi-select. A custom answer did not follow it.
 */
export const recommendationFollow = (
  options: ReadonlyArray<{ label: string; description?: string | undefined }>,
  answer: RecommendationAnswer,
): "followed" | "not_followed" | null => {
  const marked = options.filter((option) => hasRecommendationMarker(option.label));
  const [recommended] = marked;
  if (marked.length !== 1 || recommended === undefined) return null;
  if (answer.kind === "multiple") return null;
  const [value] = answer.values;
  if (answer.kind !== "preset" || answer.values.length !== 1 || value === undefined) {
    return "not_followed";
  }
  return stripRecommendationMarker(value) === stripRecommendationMarker(recommended.label)
    ? "followed"
    : "not_followed";
};
