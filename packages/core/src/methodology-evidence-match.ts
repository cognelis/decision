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
/** How much of the principle's wording this decision reuses, 0 to 100. */
  score: number;
  strength: MethodologyEvidenceMatchStrength;
  reason: string;
  matchedTerms: string[];
  alreadyLinked: boolean;
  /** How this decision was found. Semantic hits share no wording to show. */
  matchKind: "keyword" | "semantic";
}

export interface MethodologyEvidenceSemanticCandidate {
  sourceDecisionId: string;
  /**
   * Order among the semantic candidates, best first at the lowest value. It is
   * a rank and not a similarity: the retrieval score behind it blends lexical
   * and vector components, so its magnitude means nothing on its own.
   */
  rank: number;
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
        matchKind: "keyword" as const,
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

/**
 * Appends decisions that read like the principle but share no wording with it.
 *
 * Token overlap can only find a decision that reuses the principle's words, so
 * a principle written months later in different language matches nothing — and
 * an empty suggestion list reads as "there is no evidence" rather than "this
 * matcher cannot see it". These are kept apart from the overlap matches: never
 * `strong`, never ranked against them, and each says plainly that it has no
 * shared wording to show for itself.
 */
export const withSemanticEvidenceMatches = (
  matches: MethodologyEvidenceMatch[],
  candidates: MethodologyEvidenceSemanticCandidate[],
  linked: ReadonlySet<string>,
  limit = 3,
): MethodologyEvidenceMatch[] => {
  const already = new Set(matches.map((match) => match.sourceDecisionId));
  const supplements = candidates
    .filter(
      (candidate) =>
        !already.has(candidate.sourceDecisionId) &&
        candidate.sourceDecisionId.trim().length > 0,
    )
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.sourceDecisionId.localeCompare(right.sourceDecisionId),
    )
    .slice(0, boundedLimit(limit))
    .map((candidate) => ({
      sourceDecisionId: candidate.sourceDecisionId,
      // Zero is the honest value, not a placeholder: no wording overlapped.
      score: 0,
      // Nothing explainable backs a semantic hit, so it never claims strength.
      strength: "possible" as const,
      reason:
        "与这条原则语义相近，但没有共同用词可以展示；请自行核对是否确实是同一判断。",
      matchedTerms: [],
      alreadyLinked: linked.has(candidate.sourceDecisionId),
      matchKind: "semantic" as const,
    }));
  return [...matches, ...supplements];
};
