import type { MethodologyRecord } from "./methodology.js";
import type { OutcomeVerdict } from "./record.js";

export type MethodologyEvidenceMatchStrength = "strong" | "possible";

export interface MethodologyEvidenceMatchInput {
  id: string;
  project: string;
  question: string;
  selectedAnswer: string;
  rationale: string | null;
  context: string | null;
  outcome: string | null;
  outcomeVerdict: OutcomeVerdict;
  outcomeLesson: string | null;
  reviewedAt: string;
}

export interface MethodologyEvidenceMatch {
  sourceDecisionId: string;
  score: number;
  strength: MethodologyEvidenceMatchStrength;
  reason: string;
  matchedTerms: string[];
  alreadyLinked: boolean;
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
  for (const chunk of chunks) {
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      if (chunk.length === 1) result.add(chunk);
      for (let index = 0; index < chunk.length - 1; index += 1) {
        result.add(chunk.slice(index, index + 2));
      }
    } else if (chunk.length > 1) {
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

const textChunks = (value: string): string[] =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .match(/[\p{Script=Han}]+|[\p{Letter}\p{Number}]+/gu) ?? [];

const sharedPhrases = (left: string, right: string): string[] => {
  const result = new Set<string>();
  const leftChunks = textChunks(left).slice(0, 12);
  const rightChunks = textChunks(right).slice(0, 12);
  for (const rawLeftChunk of leftChunks) {
    const leftChunk = rawLeftChunk.slice(0, 96);
    if (!/^\p{Script=Han}+$/u.test(leftChunk)) {
      if (
        leftChunk.length >= 3 &&
        !genericTerms.has(leftChunk) &&
        rightChunks.includes(leftChunk)
      ) {
        result.add(leftChunk);
      }
      continue;
    }
    for (const rawRightChunk of rightChunks) {
      const rightChunk = rawRightChunk.slice(0, 96);
      if (!/^\p{Script=Han}+$/u.test(rightChunk)) continue;
      for (let start = 0; start < leftChunk.length - 1; start += 1) {
        const maximum = Math.min(10, leftChunk.length - start);
        for (let length = maximum; length >= 2; length -= 1) {
          const phrase = leftChunk.slice(start, start + length);
          if (genericTerms.has(phrase) || !rightChunk.includes(phrase)) continue;
          result.add(phrase);
          break;
        }
      }
    }
  }
  const ordered = [...result].sort(
    (first, second) =>
      second.length - first.length || first.localeCompare(second, "zh-CN"),
  );
  return ordered.filter(
    (phrase, index) =>
      !ordered.slice(0, index).some((longer) => longer.includes(phrase)),
  );
};

const boundedLimit = (value: number): number =>
  Math.max(1, Math.min(12, Math.trunc(value)));

export const buildMethodologyEvidenceMatches = (
  methodology: MethodologyRecord,
  evidence: MethodologyEvidenceMatchInput[],
  limit = 5,
): MethodologyEvidenceMatch[] => {
  const linked = new Set(methodology.sourceDecisionIds);
  const principleText = `${methodology.title}\n${methodology.principle}`;
  const conditionText = methodology.appliesWhen;
  const cautionText = methodology.caution;
  const principleTokens = tokens(principleText);
  const conditionTokens = tokens(methodology.appliesWhen);
  const cautionTokens = tokens(methodology.caution);

  return evidence
    .filter(
      (item) =>
        item.id.trim().length > 0 &&
        item.question.trim().length > 0 &&
        item.selectedAnswer.trim().length > 0 &&
        item.outcome !== null &&
        Number.isFinite(Date.parse(item.reviewedAt)),
    )
    .slice(0, 200)
    .map((item) => {
      const principleEvidenceText = `${item.question}\n${item.selectedAnswer}\n${item.rationale ?? ""}\n${item.outcomeLesson ?? ""}`;
      const conditionEvidenceText = `${item.question}\n${item.context ?? ""}\n${item.rationale ?? ""}`;
      const outcomeEvidenceText = `${item.outcome}\n${item.outcomeLesson ?? ""}`;
      const principleEvidence = tokens(principleEvidenceText);
      const conditionEvidence = tokens(conditionEvidenceText);
      const outcomeEvidence = tokens(outcomeEvidenceText);
      const principleScore = similarity(principleTokens, principleEvidence);
      const conditionScore = similarity(conditionTokens, conditionEvidence);
      const outcomeScore = similarity(cautionTokens, outcomeEvidence);
      const weightedScore =
        principleScore * 0.56 + conditionScore * 0.2 + outcomeScore * 0.24;
      const strongestScore = Math.max(
        principleScore,
        conditionScore,
        outcomeScore,
      );
      const score = Math.round(
        Math.max(weightedScore, strongestScore * 0.72) * 100,
      );
      const signals = [
        principleScore >= 0.12 ? "原则内容" : null,
        conditionScore >= 0.12 ? "适用条件" : null,
        outcomeScore >= 0.12 ? "复盘结果" : null,
      ].filter((value): value is string => value !== null);
      const matchedTerms = [
        ...new Set([
          ...sharedPhrases(principleText, principleEvidenceText),
          ...sharedPhrases(conditionText, conditionEvidenceText),
          ...sharedPhrases(cautionText, outcomeEvidenceText),
        ]),
      ]
        .sort(
          (first, second) =>
            second.length - first.length ||
            first.localeCompare(second, "zh-CN"),
        )
        .filter(
          (phrase, index, values) =>
            !values.slice(0, index).some((longer) => longer.includes(phrase)),
        )
        .slice(0, 3);
      const signalText =
        signals.length > 0 ? signals.join("、") : "原则内容";
      const termText =
        matchedTerms.length > 0
          ? `，共同出现“${matchedTerms.join("、")}”`
          : "";
      return {
        sourceDecisionId: item.id,
        score,
        strength: score >= 24 ? ("strong" as const) : ("possible" as const),
        reason: `${signalText}与这条复盘存在文本重合${termText}。`,
        matchedTerms,
        alreadyLinked: linked.has(item.id),
        reviewedAt: item.reviewedAt,
      };
    })
    .filter((item) => item.score >= 12)
    .sort(
      (left, right) =>
        Number(right.alreadyLinked) - Number(left.alreadyLinked) ||
        right.score - left.score ||
        right.reviewedAt.localeCompare(left.reviewedAt) ||
        left.sourceDecisionId.localeCompare(right.sourceDecisionId),
    )
    .slice(0, boundedLimit(limit))
    .map(({ reviewedAt: _reviewedAt, ...item }) => item);
};
