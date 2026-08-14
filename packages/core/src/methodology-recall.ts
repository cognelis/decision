import type { MethodologyRecord } from "./methodology.js";

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

const genericTerms = new Set([
  "一个",
  "以及",
  "已经",
  "以后",
  "仍然",
  "可以",
  "如果",
  "应该",
  "进行",
  "结果",
  "需要",
  "选择",
  "方案",
  "问题",
  "项目",
  "方法",
  "时候",
  "决策",
  "使用",
  "the",
  "and",
  "for",
  "with",
]);

const tokens = (value: string): Set<string> => {
  const result = new Set<string>();
  const chunks =
    value
      .normalize("NFKC")
      .toLocaleLowerCase("zh-CN")
      .match(/[\p{Script=Han}]+|[\p{Letter}\p{Number}]+/gu) ?? [];
  for (const chunk of chunks.slice(0, 120)) {
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      for (let index = 0; index < chunk.length - 1; index += 1) {
        const token = chunk.slice(index, index + 2);
        if (!genericTerms.has(token)) result.add(token);
      }
    } else if (chunk.length > 1 && !genericTerms.has(chunk)) {
      result.add(chunk);
    }
  }
  return result;
};

const similarity = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return (2 * shared) / (left.size + right.size);
};

const matchedTerms = (left: Set<string>, right: Set<string>): string[] =>
  [...left]
    .filter((token) => right.has(token) && !genericTerms.has(token))
    .sort(
      (first, second) =>
        second.length - first.length || first.localeCompare(second, "zh-CN"),
    )
    .slice(0, 3);

const boundedLimit = (value: number): number =>
  Math.max(1, Math.min(5, Math.trunc(value)));

export const buildMethodologyRecall = (
  records: MethodologyRecord[],
  input: MethodologyRecallInput,
  limit = 3,
): MethodologyRecallMatch[] => {
  const decisionText = `${input.question}\n${input.selectedAnswer ?? ""}\n${input.optionLabels.join("\n")}`;
  const conditionText = `${input.question}\n${input.context ?? ""}`;
  const decisionTokens = tokens(decisionText);
  const conditionTokens = tokens(conditionText);

  return records
    .filter((record) => record.status === "accepted")
    .map((record) => {
      const principleTokens = tokens(`${record.title}\n${record.principle}`);
      const appliesTokens = tokens(record.appliesWhen);
      const cautionTokens = tokens(record.caution);
      const principleScore = similarity(principleTokens, decisionTokens);
      const conditionScore = similarity(appliesTokens, conditionTokens);
      const cautionScore = similarity(cautionTokens, conditionTokens);
      const strongest = Math.max(
        principleScore,
        conditionScore,
        cautionScore,
      );
      const weighted =
        principleScore * 0.58 + conditionScore * 0.32 + cautionScore * 0.1;
      const score = Math.round(Math.max(weighted, strongest * 0.74) * 100);
      const signals = [
        principleScore >= 0.1 ? "原则内容" : null,
        conditionScore >= 0.1 ? "适用条件" : null,
        cautionScore >= 0.1 ? "注意边界" : null,
      ].filter((value): value is string => value !== null);
      const terms = [
        ...new Set([
          ...matchedTerms(principleTokens, decisionTokens),
          ...matchedTerms(appliesTokens, conditionTokens),
          ...matchedTerms(cautionTokens, conditionTokens),
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
        updatedAt: record.updatedAt,
      };
    })
    .filter((match) => match.score >= 10)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.principleId.localeCompare(right.principleId),
    )
    .slice(0, boundedLimit(limit))
    .map(({ updatedAt: _updatedAt, ...match }) => match);
};
