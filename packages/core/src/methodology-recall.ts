import type { MethodologyRecord } from "./methodology.js";
import { hashSimilarity, matchedTerms, tokenHashCache, tokenHashes, tokens } from "./recall-text.js";

export type MethodologyRecallStrength = "strong" | "possible";

export interface MethodologyRecallInput {
  question: string;
  selectedAnswer: string | null;
  optionLabels: string[];
  context: string | null;
}

export interface MethodologyRecallMatch {
  principleId: string;
  score: number;
  strength: MethodologyRecallStrength;
  reason: string;
  matchedTerms: string[];
}

const boundedLimit = (value: number): number =>
  Math.max(1, Math.min(5, Math.trunc(value)));

const principleHashCache = tokenHashCache();

export const buildMethodologyRecall = (
  records: MethodologyRecord[],
  input: MethodologyRecallInput,
  limit = 3,
): MethodologyRecallMatch[] => {
  const decisionText = `${input.question}\n${input.selectedAnswer ?? ""}\n${input.optionLabels.join("\n")}`;
  const conditionText = `${input.question}\n${input.context ?? ""}`;
  const decisionTokens = tokens(decisionText);
  const conditionTokens = tokens(conditionText);
  const decisionHashes = tokenHashes(decisionTokens);
  const conditionHashes = tokenHashes(conditionTokens);

  const scored = records
    .filter((record) => record.status === "accepted")
    .map((record) => {
      const [principleHashes, appliesHashes, cautionHashes] = principleHashCache.hashes(
        record.id,
        [record.title, record.principle, record.appliesWhen, record.caution],
        () => [`${record.title}\n${record.principle}`, record.appliesWhen, record.caution],
      );
      const principleScore = hashSimilarity(principleHashes!, decisionHashes);
      const conditionScore = hashSimilarity(appliesHashes!, conditionHashes);
      const cautionScore = hashSimilarity(cautionHashes!, conditionHashes);
      const strongest = Math.max(
        principleScore,
        conditionScore,
        cautionScore,
      );
      const weighted =
        principleScore * 0.58 + conditionScore * 0.32 + cautionScore * 0.1;
      const score = Math.round(Math.max(weighted, strongest * 0.74) * 100);
      return { record, score, principleScore, conditionScore, cautionScore };
    });
  principleHashCache.settle();

  return scored
    .filter((match) => match.score >= 10)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.record.updatedAt.localeCompare(left.record.updatedAt) ||
        left.record.id.localeCompare(right.record.id),
    )
    .slice(0, boundedLimit(limit))
    // The shared terms, from the tokens themselves, only for the few recalled.
    .map(({ record, score, principleScore, conditionScore, cautionScore }) => {
      const signals = [
        principleScore >= 0.1 ? "原则内容" : null,
        conditionScore >= 0.1 ? "适用条件" : null,
        cautionScore >= 0.1 ? "注意边界" : null,
      ].filter((value): value is string => value !== null);
      const terms = [
        ...new Set([
          ...matchedTerms(tokens(`${record.title}\n${record.principle}`), decisionTokens),
          ...matchedTerms(tokens(record.appliesWhen), conditionTokens),
          ...matchedTerms(tokens(record.caution), conditionTokens),
        ]),
      ].slice(0, 3);
      return {
        principleId: record.id,
        score,
        strength: score >= 24 ? ("strong" as const) : ("possible" as const),
        reason: `${signals.length > 0 ? signals.join("、") : "原则内容"}与当前决策存在文本重合${
          terms.length > 0 ? `，共同出现“${terms.join("、")}”` : ""
        }。`,
        matchedTerms: terms,
      };
    });
};
