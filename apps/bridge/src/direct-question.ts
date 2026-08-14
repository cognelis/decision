const stripFencedCode = (message: string): string =>
  message.replace(/```[\s\S]*?```/gu, "");

export const extractDirectQuestion = (
  message: string,
): string | null => {
  const stripped = stripFencedCode(message).trim();
  if (stripped.length === 0 || stripped.length > 8_000) {
    return null;
  }
  const paragraphs = stripped.split(/\n{2,}/u);
  const last = paragraphs.at(-1)?.trim() ?? "";
  if (
    last.length === 0 ||
    !/[?？]\s*$/u.test(last) ||
    /^(?:>|```)/u.test(last)
  ) {
    return null;
  }

  const finalQuestionMark = Math.max(
    last.lastIndexOf("?"),
    last.lastIndexOf("？"),
  );
  if (
    /[。.!！]\s*$/u.test(last.slice(finalQuestionMark + 1))
  ) {
    return null;
  }

  const previous = paragraphs.at(-2)?.trim() ?? "";
  const candidate =
    previous.length > 0 &&
    /(?:^|\n)\s*(?:[-*]|\d+\.)\s+/u.test(previous)
      ? `${previous}\n\n${last}`
      : last;
  return candidate.length <= 4_000 ? candidate : null;
};
