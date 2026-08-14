import type { MethodologyRecord } from "./methodology.js";
import type { OutcomeVerdict } from "./record.js";

export type MethodologySuggestionReadiness =
  | "strong"
  | "ready"
  | "exploratory";

export type MethodologySuggestionDirection =
  | "favorable"
  | "attention"
  | "unclear";

export interface MethodologySuggestionEvidence {
  id: string;
  project: string;
  question: string;
  selectedAnswer: string;
  outcomeVerdict: OutcomeVerdict;
  outcomeLesson: string | null;
  reviewedAt: string;
}

export interface MethodologySuggestion {
  id: string;
  title: string;
  summary: string;
  readiness: MethodologySuggestionReadiness;
  direction: MethodologySuggestionDirection;
  evidenceCount: number;
  projectCount: number;
  sourceDecisionIds: string[];
  sources: MethodologySuggestionEvidence[];
}

const favorableVerdicts = new Set<OutcomeVerdict>([
  "better",
  "as_expected",
]);
const attentionVerdicts = new Set<OutcomeVerdict>(["mixed", "worse"]);

const directionFor = (
  verdict: OutcomeVerdict,
): MethodologySuggestionDirection =>
  favorableVerdicts.has(verdict)
    ? "favorable"
    : attentionVerdicts.has(verdict)
      ? "attention"
      : "unclear";

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

const similarity = (
  left: MethodologySuggestionEvidence,
  right: MethodologySuggestionEvidence,
): number => {
  const leftTokens = tokens(
    `${left.question}\n${left.selectedAnswer}\n${left.outcomeLesson ?? ""}`,
  );
  const rightTokens = tokens(
    `${right.question}\n${right.selectedAnswer}\n${right.outcomeLesson ?? ""}`,
  );
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return (2 * shared) / (leftTokens.size + rightTokens.size);
};

const normalizedProject = (value: string): string =>
  value.trim() || "未命名项目";

const sourceOrder = (
  left: MethodologySuggestionEvidence,
  right: MethodologySuggestionEvidence,
): number =>
  right.reviewedAt.localeCompare(left.reviewedAt) ||
  left.id.localeCompare(right.id);

const readinessFor = (
  evidenceCount: number,
  projectCount: number,
  direction: MethodologySuggestionDirection,
): MethodologySuggestionReadiness =>
  evidenceCount >= 3 && projectCount >= 2 && direction !== "unclear"
    ? "strong"
    : evidenceCount >= 2 && direction !== "unclear"
      ? "ready"
      : "exploratory";

const titleFor = (sources: MethodologySuggestionEvidence[]): string => {
  if (sources.length === 1) return sources[0]!.question;
  const projects = new Set(sources.map((source) => normalizedProject(source.project)));
  return projects.size === 1
    ? `${[...projects][0]} · 相近复盘`
    : `跨 ${projects.size} 个项目 · 相近复盘`;
};

const summaryFor = (
  evidenceCount: number,
  projectCount: number,
  readiness: MethodologySuggestionReadiness,
  direction: MethodologySuggestionDirection,
): string => {
  const directionLabel =
    direction === "favorable"
      ? "结果方向一致"
      : direction === "attention"
        ? "都提示需要修正"
        : "结果仍不明确";
  if (readiness === "strong") {
    return `${evidenceCount} 条复盘跨 ${projectCount} 个项目且${directionLabel}，适合提炼为较稳定原则。`;
  }
  if (readiness === "ready") {
    return `${evidenceCount} 条相近复盘${directionLabel}，可以提炼候选并继续验证。`;
  }
  return `单条完整复盘，适合先提炼为探索性假设，不应直接视为稳定规律。`;
};

const suggestionFrom = (
  sources: MethodologySuggestionEvidence[],
): MethodologySuggestion => {
  const ordered = [...sources].sort(sourceOrder).slice(0, 5);
  const projectCount = new Set(
    ordered.map((source) => normalizedProject(source.project)),
  ).size;
  const direction = directionFor(ordered[0]!.outcomeVerdict);
  const readiness = readinessFor(ordered.length, projectCount, direction);
  const sourceDecisionIds = ordered.map((source) => source.id);
  return {
    id: `suggestion:${[...sourceDecisionIds].sort().join(":")}`,
    title: titleFor(ordered),
    summary: summaryFor(ordered.length, projectCount, readiness, direction),
    readiness,
    direction,
    evidenceCount: ordered.length,
    projectCount,
    sourceDecisionIds,
    sources: ordered,
  };
};

const suggestionOrder = (
  left: MethodologySuggestion,
  right: MethodologySuggestion,
): number => {
  const weight: Record<MethodologySuggestionReadiness, number> = {
    strong: 3,
    ready: 2,
    exploratory: 1,
  };
  return (
    weight[right.readiness] - weight[left.readiness] ||
    right.evidenceCount - left.evidenceCount ||
    (right.sources[0]?.reviewedAt ?? "").localeCompare(
      left.sources[0]?.reviewedAt ?? "",
    ) ||
    left.id.localeCompare(right.id)
  );
};

export const buildMethodologySuggestions = (
  evidence: MethodologySuggestionEvidence[],
  existing: MethodologyRecord[],
  limit = 6,
): MethodologySuggestion[] => {
  const covered = new Set(
    existing
      .flatMap((record) => record.sourceDecisionIds),
  );
  const eligible = evidence
    .filter(
      (item) =>
        !covered.has(item.id) &&
        item.id.trim().length > 0 &&
        item.question.trim().length > 0 &&
        item.selectedAnswer.trim().length > 0 &&
        Number.isFinite(Date.parse(item.reviewedAt)),
    )
    .sort(sourceOrder)
    .slice(0, 300);
  const assigned = new Set<string>();
  const grouped: MethodologySuggestion[] = [];

  for (const seed of eligible) {
    if (assigned.has(seed.id) || directionFor(seed.outcomeVerdict) === "unclear") {
      continue;
    }
    const direction = directionFor(seed.outcomeVerdict);
    const matches = eligible
      .filter(
        (candidate) =>
          candidate.id !== seed.id &&
          !assigned.has(candidate.id) &&
          directionFor(candidate.outcomeVerdict) === direction,
      )
      .map((candidate) => ({
        candidate,
        score: similarity(seed, candidate),
      }))
      .filter(({ candidate, score }) => {
        const sameProject =
          normalizedProject(candidate.project) === normalizedProject(seed.project);
        return score >= (sameProject ? 0.15 : 0.2);
      })
      .sort(
        (left, right) =>
          right.score - left.score || sourceOrder(left.candidate, right.candidate),
      )
      .slice(0, 4)
      .map(({ candidate }) => candidate);
    if (matches.length === 0) continue;
    const sources = [seed, ...matches];
    for (const source of sources) assigned.add(source.id);
    grouped.push(suggestionFrom(sources));
  }

  const singles = eligible
    .filter((item) => !assigned.has(item.id))
    .slice(0, 4)
    .map((item) => suggestionFrom([item]));
  const boundedLimit = Math.max(1, Math.min(12, Math.trunc(limit)));
  return [...grouped, ...singles]
    .sort(suggestionOrder)
    .slice(0, boundedLimit);
};
