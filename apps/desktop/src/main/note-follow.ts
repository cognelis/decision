import { readFileSync } from "node:fs";

import { recommendationFollow } from "@cognelis/decision-core";
import { parseDecision } from "@cognelis/decision-storage";

/**
 * Whether the answer in a note is the option its options marked as recommended. The index keeps no options, so the
 * note is read; its options never change, so each is read once (the home page asks on every snapshot).
 */
export const createNoteFollow = () => {
  const follows = new Map<string, "followed" | "not_followed" | null>();
  return ({ id, filePath }: { id: string; filePath?: string }) => {
    if (filePath === undefined) return null;
    const key = `${id}\0${filePath}`;
    if (!follows.has(key)) {
      try {
        const { options, selectedAnswer } = parseDecision(readFileSync(filePath, "utf8"));
        follows.set(key, recommendationFollow(options, selectedAnswer));
      } catch {
        return null;
      }
    }
    return follows.get(key) ?? null;
  };
};
