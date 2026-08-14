import type {
  MethodologyQualityRelation,
  MethodologyRelationDisposition,
} from "@cognelis/decision-core";

import type { MethodologyItem } from "../../../../shared/renderer-api.js";

export interface MethodologyRelationReviewItem {
  key: string;
  left: MethodologyItem;
  right: MethodologyItem;
  relation: MethodologyQualityRelation;
}

export interface MethodologyMergeCandidateAssessment {
  item: MethodologyItem;
  confirmedPairCount: number;
  missingSources: MethodologyItem[];
}

export interface MethodologyQualityBadge {
  label: string;
  tone: "similar" | "conflict" | "resolved";
}

export const explicitRelationBetween = (
  first: MethodologyItem,
  second: MethodologyItem,
): MethodologyRelationDisposition | null => {
  const resolutions = [
    ...first.quality.relations
      .filter((relation) => relation.id === second.id)
      .map((relation) => relation.resolution),
    ...second.quality.relations
      .filter((relation) => relation.id === first.id)
      .map((relation) => relation.resolution),
  ].filter(
    (resolution): resolution is MethodologyRelationDisposition =>
      resolution !== null && resolution !== undefined,
  );
  if (resolutions.includes("conflict")) return "conflict";
  if (resolutions.includes("unrelated")) return "unrelated";
  return resolutions.includes("duplicate") ? "duplicate" : null;
};

export const confirmedDuplicate = (
  first: MethodologyItem,
  second: MethodologyItem,
): boolean => explicitRelationBetween(first, second) === "duplicate";

export const allPairsConfirmedDuplicate = (
  sources: MethodologyItem[],
): boolean =>
  sources.every((source, index) =>
    sources
      .slice(index + 1)
      .every((candidate) => confirmedDuplicate(source, candidate)),
  );

export const assessMergeCandidate = (
  sources: MethodologyItem[],
  item: MethodologyItem,
): MethodologyMergeCandidateAssessment | null => {
  const dispositions = sources.map((source) => ({
    source,
    disposition: explicitRelationBetween(source, item),
  }));
  if (
    dispositions.some(
      ({ disposition }) =>
        disposition === "conflict" || disposition === "unrelated",
    )
  ) {
    return null;
  }
  const confirmedPairCount = dispositions.filter(
    ({ disposition }) => disposition === "duplicate",
  ).length;
  if (confirmedPairCount === 0) return null;
  return {
    item,
    confirmedPairCount,
    missingSources: dispositions.flatMap(({ source, disposition }) =>
      disposition === null ? [source] : [],
    ),
  };
};

export const relationPairKey = (leftId: string, rightId: string): string =>
  [leftId, rightId].sort().join("\0");

export const buildRelationReviewQueue = (
  records: MethodologyItem[],
): MethodologyRelationReviewItem[] => {
  const byId = new Map(records.map((record) => [record.id, record]));
  const pairs = new Map<string, MethodologyRelationReviewItem>();
  for (const record of records) {
    if (record.status !== "candidate" && record.status !== "accepted") continue;
    for (const relation of record.quality.relations) {
      if (relation.resolution !== null && relation.resolution !== undefined) {
        continue;
      }
      const related = byId.get(relation.id);
      if (
        related === undefined ||
        (related.status !== "candidate" && related.status !== "accepted")
      ) {
        continue;
      }
      const key = relationPairKey(record.id, related.id);
      if (!pairs.has(key)) {
        pairs.set(key, { key, left: record, right: related, relation });
      }
    }
  }
  return [...pairs.values()].sort(
    (left, right) =>
      Number(right.relation.kind === "potential_conflict") -
        Number(left.relation.kind === "potential_conflict") ||
      right.relation.score - left.relation.score ||
      left.key.localeCompare(right.key),
  );
};

export const pendingRelationCount = (records: MethodologyItem[]): number => {
  const pairs = new Set<string>();
  for (const record of records) {
    if (record.status !== "candidate" && record.status !== "accepted") {
      continue;
    }
    for (const relation of record.quality.relations) {
      if (relation.resolution === null || relation.resolution === undefined) {
        pairs.add(relationPairKey(record.id, relation.id));
      }
    }
  }
  return pairs.size;
};

export const qualityBadgeFor = (
  item: MethodologyItem,
): MethodologyQualityBadge | null => {
  const unresolved = item.quality.relations.filter(
    (relation) =>
      relation.resolution === null || relation.resolution === undefined,
  );
  if (unresolved.some((relation) => relation.kind === "potential_conflict")) {
    return { label: "待核对冲突", tone: "conflict" };
  }
  if (unresolved.length > 0) {
    return { label: "待核对相近", tone: "similar" };
  }
  if (
    item.quality.relations.some(
      (relation) => relation.resolution === "conflict",
    )
  ) {
    return { label: "已确认冲突", tone: "conflict" };
  }
  if (
    item.quality.relations.some(
      (relation) => relation.resolution === "duplicate",
    )
  ) {
    return { label: "已确认重复", tone: "resolved" };
  }
  return null;
};
