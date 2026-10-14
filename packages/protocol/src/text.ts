/**
 * `value.slice(0, limit)` that never ends on half of a character. Cut at a
 * UTF-16 boundary, an emoji or a rare CJK character leaves a lone surrogate,
 * which JSON carries as an unpaired escape and stricter parsers refuse.
 */
export const clipText = (value: string, limit: number): string => {
  const clipped = value.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

/** `value.slice(-limit)` that never starts on half of a character: clipText for the end of a text. */
export const clipTextEnd = (value: string, limit: number): string => {
  if (value.length <= limit) return value;
  const clipped = value.slice(value.length - limit);
  const first = clipped.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? clipped.slice(1) : clipped;
};
