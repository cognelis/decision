import type {
  MethodologyConfidence,
  MethodologyRecord,
  MethodologyStatus,
} from "./methodology.js";
import type {
  MethodologyRelationDisposition,
  MethodologyRelationRecord,
} from "./methodology-relation.js";
import type { OutcomeVerdict } from "./record.js";

export type MethodologyRelationKind = "similar" | "potential_conflict";

export type MethodologyQualityFlag =
  | "missing_evidence"
  | "no_evidence"
  | "single_evidence"
  | "single_project"
  | "mixed_outcomes"
  | "unclear_outcomes"
  | "similar_principle"
  | "potential_conflict";

export interface MethodologyEvidenceSignal {
  id: string;
  project: string;
  sourceClient: string;
  outcomeVerdict: OutcomeVerdict | null;
}

export interface MethodologyQualityRelation {
  id: string;
  title: string;
  status: MethodologyStatus;
  kind: MethodologyRelationKind;
  score: number;
  sharedEvidenceCount: number;
  reason: string;
  resolution?: MethodologyRelationDisposition | null;
  resolutionNote?: string | null;
  resolutionUpdatedAt?: string | null;
}

export interface MethodologyQualityAssessment {
  recommendedConfidence: MethodologyConfidence;
  confidenceReason: string;
  evidenceCount: number;
  missingEvidenceCount: number;
  projectCount: number;
  sourceCount: number;
  favorableEvidenceCount: number;
  attentionEvidenceCount: number;
  unclearEvidenceCount: number;
  flags: MethodologyQualityFlag[];
  relations: MethodologyQualityRelation[];
}

const favorableVerdicts = new Set<OutcomeVerdict>([
  "better",
  "as_expected",
]);

const attentionVerdicts = new Set<OutcomeVerdict>(["mixed", "worse"]);

const opposingSignals: ReadonlyArray<readonly [string, string]> = [
  ["保留", "删除"],
  ["增加", "减少"],
  ["启用", "禁用"],
  ["允许", "禁止"],
  ["集中", "分散"],
  ["统一", "拆分"],
  ["同步", "异步"],
  ["自动", "人工"],
  ["立即", "延后"],
  ["复用", "重建"],
  ["一次", "分步"],
];

const activeText = (record: MethodologyRecord): string =>
  `${record.title}\n${record.principle}\n${record.appliesWhen}`;

const tokens = (value: string): Set<string> => {
  const result = new Set<string>();
  const chunks = value
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

const diceSimilarity = (left: string, right: string): number => {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return (2 * shared) / (leftTokens.size + rightTokens.size);
};

const sharedEvidenceCount = (
  left: MethodologyRecord,
  right: MethodologyRecord,
): number => {
  const rightIds = new Set(right.sourceDecisionIds);
  return left.sourceDecisionIds.filter((id) => rightIds.has(id)).length;
};

const opposingPairs = (
  left: MethodologyRecord,
  right: MethodologyRecord,
): Array<readonly [string, string]> => {
  const leftText = activeText(left);
  const rightText = activeText(right);
  return opposingSignals.filter(
    ([first, second]) =>
      (leftText.includes(first) && rightText.includes(second)) ||
      (leftText.includes(second) && rightText.includes(first)),
  );
};

const relationship = (
  record: MethodologyRecord,
  candidate: MethodologyRecord,
): MethodologyQualityRelation | null => {
  const similarity = diceSimilarity(activeText(record), activeText(candidate));
  const sharedEvidence = sharedEvidenceCount(record, candidate);
  const opposites = opposingPairs(record, candidate);
  if ((similarity >= 0.16 || sharedEvidence > 0) && opposites.length > 0) {
    const cues = opposites
      .slice(0, 2)
      .map(([left, right]) => `“${left} / ${right}”`)
      .join("、");
    return {
      id: candidate.id,
      title: candidate.title,
      status: candidate.status,
      kind: "potential_conflict",
      score: Math.round(Math.max(similarity, 0.35) * 100),
      sharedEvidenceCount: sharedEvidence,
      reason: `适用内容存在交集，但行动信号出现 ${cues}；需人工核对适用条件。`,
    };
  }
  if (similarity >= 0.34 || (sharedEvidence > 0 && similarity >= 0.2)) {
    return {
      id: candidate.id,
      title: candidate.title,
      status: candidate.status,
      kind: "similar",
      score: Math.round(similarity * 100),
      sharedEvidenceCount: sharedEvidence,
      reason:
        sharedEvidence > 0
          ? `共享 ${sharedEvidence} 条来源证据，且原则表达高度接近；采纳前应判断是否需要合并。`
          : "原则和适用条件高度接近；采纳前应判断是否为重复规则。",
    };
  }
  return null;
};

const relationFactFor = (
  firstId: string,
  secondId: string,
  relations: MethodologyRelationRecord[],
): MethodologyRelationRecord | null =>
  relations.find(
    (relation) =>
      relation.principleIds.includes(firstId) &&
      relation.principleIds.includes(secondId),
  ) ?? null;

const resolvedRelationship = (
  record: MethodologyRecord,
  candidate: MethodologyRecord,
  facts: MethodologyRelationRecord[],
): MethodologyQualityRelation | null => {
  const detected = relationship(record, candidate);
  const fact = relationFactFor(record.id, candidate.id, facts);
  if (detected === null && fact === null) return null;
  const kind =
    fact?.disposition === "conflict"
      ? "potential_conflict"
      : fact?.disposition === "duplicate"
        ? "similar"
        : (detected?.kind ?? "similar");
  return {
    id: candidate.id,
    title: candidate.title,
    status: candidate.status,
    kind,
    score: detected?.score ?? 0,
    sharedEvidenceCount: detected?.sharedEvidenceCount ?? 0,
    reason:
      detected?.reason ??
      (fact?.disposition === "conflict"
        ? "此前已人工确认两条原则存在冲突。"
        : fact?.disposition === "duplicate"
          ? "此前已人工确认两条原则表达重复。"
          : "此前已人工确认两条原则在实际边界上无关。"),
    resolution: fact?.disposition ?? null,
    resolutionNote: fact?.note ?? null,
    resolutionUpdatedAt: fact?.updatedAt ?? null,
  };
};

const evidenceConfidence = (input: {
  evidenceCount: number;
  projectCount: number;
  favorableEvidenceCount: number;
  attentionEvidenceCount: number;
  unclearEvidenceCount: number;
  missingEvidenceCount: number;
}): Pick<
  MethodologyQualityAssessment,
  "recommendedConfidence" | "confidenceReason"
> => {
  const {
    evidenceCount,
    projectCount,
    favorableEvidenceCount,
    attentionEvidenceCount,
    unclearEvidenceCount,
    missingEvidenceCount,
  } = input;
  const dominantCount = Math.max(
    favorableEvidenceCount,
    attentionEvidenceCount,
  );
  const consistent =
    unclearEvidenceCount === 0 && dominantCount === evidenceCount;
  if (evidenceCount === 0) {
    return {
      recommendedConfidence: "low",
      confidenceReason:
        "尚未关联经过结果复盘的决策证据，只能作为待验证假设。",
    };
  }
  if (
    evidenceCount >= 3 &&
    projectCount >= 2 &&
    missingEvidenceCount === 0 &&
    consistent
  ) {
    return {
      recommendedConfidence: "high",
      confidenceReason: `${evidenceCount} 条完整证据来自 ${projectCount} 个项目，结果方向一致。`,
    };
  }
  if (
    evidenceCount >= 2 &&
    missingEvidenceCount === 0 &&
    unclearEvidenceCount === 0 &&
    dominantCount / evidenceCount >= 0.75
  ) {
    return {
      recommendedConfidence: "medium",
      confidenceReason:
        projectCount >= 2
          ? `${evidenceCount} 条证据跨 ${projectCount} 个项目，主要结果方向一致。`
          : `${evidenceCount} 条证据结果方向一致，但仍集中在同一项目。`,
    };
  }
  if (missingEvidenceCount > 0) {
    return {
      recommendedConfidence: "low",
      confidenceReason: `${missingEvidenceCount} 条来源证据已缺失，无法完整核对候选原则。`,
    };
  }
  if (evidenceCount === 1) {
    return {
      recommendedConfidence: "low",
      confidenceReason: "当前只有单条结果证据，只能视为待验证假设。",
    };
  }
  if (unclearEvidenceCount > 0) {
    return {
      recommendedConfidence: "low",
      confidenceReason: `${unclearEvidenceCount} 条证据的实际结果仍不明确。`,
    };
  }
  return {
    recommendedConfidence: "low",
    confidenceReason: "证据的实际结果方向不一致，需要更多复盘或缩小适用范围。",
  };
};

export const assessMethodologyQuality = (
  record: MethodologyRecord,
  records: MethodologyRecord[],
  evidence: MethodologyEvidenceSignal[],
  relationFacts: MethodologyRelationRecord[] = [],
): MethodologyQualityAssessment => {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const availableEvidence = record.sourceDecisionIds.flatMap((id) => {
    const item = evidenceById.get(id);
    return item === undefined ? [] : [item];
  });
  const missingEvidenceCount =
    record.sourceDecisionIds.length - availableEvidence.length;
  const favorableEvidenceCount = availableEvidence.filter(
    (item) =>
      item.outcomeVerdict !== null &&
      favorableVerdicts.has(item.outcomeVerdict),
  ).length;
  const attentionEvidenceCount = availableEvidence.filter(
    (item) =>
      item.outcomeVerdict !== null &&
      attentionVerdicts.has(item.outcomeVerdict),
  ).length;
  const unclearEvidenceCount = availableEvidence.filter(
    (item) =>
      item.outcomeVerdict === null || item.outcomeVerdict === "unclear",
  ).length;
  const projectCount = new Set(
    availableEvidence.map((item) => item.project.trim() || "未命名项目"),
  ).size;
  const sourceCount = new Set(
    availableEvidence.map((item) => item.sourceClient),
  ).size;
  const confidence = evidenceConfidence({
    evidenceCount: availableEvidence.length,
    projectCount,
    favorableEvidenceCount,
    attentionEvidenceCount,
    unclearEvidenceCount,
    missingEvidenceCount,
  });
  const relations = records
    .filter(
      (candidate) =>
        candidate.id !== record.id &&
        !(record.sourcePrincipleIds ?? []).includes(candidate.id) &&
        !(candidate.sourcePrincipleIds ?? []).includes(record.id) &&
        (candidate.status === "candidate" || candidate.status === "accepted"),
    )
    .map((candidate) =>
      resolvedRelationship(record, candidate, relationFacts),
    )
    .filter(
      (item): item is MethodologyQualityRelation => item !== null,
    )
    .sort(
      (left, right) =>
        Number(right.kind === "potential_conflict") -
          Number(left.kind === "potential_conflict") ||
        right.score - left.score ||
        left.title.localeCompare(right.title, "zh-CN"),
    );
  const flags: MethodologyQualityFlag[] = [];
  if (missingEvidenceCount > 0) flags.push("missing_evidence");
  if (availableEvidence.length === 0) flags.push("no_evidence");
  if (availableEvidence.length === 1) flags.push("single_evidence");
  if (availableEvidence.length >= 2 && projectCount <= 1) {
    flags.push("single_project");
  }
  if (favorableEvidenceCount > 0 && attentionEvidenceCount > 0) {
    flags.push("mixed_outcomes");
  }
  if (unclearEvidenceCount > 0) flags.push("unclear_outcomes");
  if (
    relations.some(
      (item) => item.kind === "similar" && item.resolution !== "unrelated",
    )
  ) {
    flags.push("similar_principle");
  }
  if (
    relations.some(
      (item) =>
        item.kind === "potential_conflict" &&
        item.resolution !== "unrelated",
    )
  ) {
    flags.push("potential_conflict");
  }
  return {
    ...confidence,
    evidenceCount: availableEvidence.length,
    missingEvidenceCount,
    projectCount,
    sourceCount,
    favorableEvidenceCount,
    attentionEvidenceCount,
    unclearEvidenceCount,
    flags,
    relations,
  };
};
