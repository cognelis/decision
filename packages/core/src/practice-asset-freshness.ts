import type { MethodologyRecord } from "./methodology.js";
import type { PracticeAssetRecord } from "./practice-asset.js";
import { comparePracticeAssetSources } from "./practice-asset-source-diff.js";

export type PracticeAssetFreshnessState =
  | "current"
  | "sources_updated"
  | "sources_unavailable";

export interface PracticeAssetFreshness {
  state: PracticeAssetFreshnessState;
  sourceCount: number;
  updatedSourceCount: number;
  missingSourceCount: number;
  unacceptedSourceCount: number;
  latestSourceUpdatedAt: string | null;
  canRegenerate: boolean;
  message: string;
}

export const assessPracticeAssetFreshness = (
  asset: PracticeAssetRecord,
  sources: MethodologyRecord[],
): PracticeAssetFreshness => {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const resolved = asset.sourcePrincipleIds.flatMap((id) => {
    const source = byId.get(id);
    return source === undefined ? [] : [source];
  });
  const missingSourceCount = asset.sourcePrincipleIds.length - resolved.length;
  const unacceptedSourceCount = resolved.filter(
    (source) => source.status !== "accepted" || source.confirmedAt === null,
  ).length;
  const accepted = resolved.filter(
    (source) => source.status === "accepted" && source.confirmedAt !== null,
  );
  const sourceChanges = comparePracticeAssetSources(asset, sources);
  const updatedSourceCount = sourceChanges.filter((change) =>
    change.state === "baseline_missing"
      ? asset.sourceSnapshots !== undefined ||
        accepted.some(
          (source) => source.id === change.id && source.updatedAt > asset.updatedAt,
        )
      : change.state === "updated",
  ).length;
  const latestSourceUpdatedAt =
    accepted
      .map((source) => source.updatedAt)
      .sort((left, right) => right.localeCompare(left))[0] ?? null;

  if (missingSourceCount > 0 || unacceptedSourceCount > 0) {
    const parts = [
      missingSourceCount > 0 ? `${missingSourceCount} 条已缺失` : null,
      unacceptedSourceCount > 0
        ? `${unacceptedSourceCount} 条不再是已采纳原则`
        : null,
    ].filter((part): part is string => part !== null);
    return {
      state: "sources_unavailable",
      sourceCount: asset.sourcePrincipleIds.length,
      updatedSourceCount,
      missingSourceCount,
      unacceptedSourceCount,
      latestSourceUpdatedAt,
      canRegenerate: false,
      message: `来源原则不可用：${parts.join("，")}。恢复来源后才能采纳或发布。`,
    };
  }
  if (updatedSourceCount > 0) {
    return {
      state: "sources_updated",
      sourceCount: asset.sourcePrincipleIds.length,
      updatedSourceCount,
      missingSourceCount: 0,
      unacceptedSourceCount: 0,
      latestSourceUpdatedAt,
      canRegenerate: true,
      message: `${updatedSourceCount} 条来源原则在此资产之后更新，内容需要重新生成或人工校对。`,
    };
  }
  return {
    state: "current",
    sourceCount: asset.sourcePrincipleIds.length,
    updatedSourceCount: 0,
    missingSourceCount: 0,
    unacceptedSourceCount: 0,
    latestSourceUpdatedAt,
    canRegenerate: accepted.length > 0,
    message: "内容与当前已采纳原则一致。",
  };
};
