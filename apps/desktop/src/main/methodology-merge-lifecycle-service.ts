import {
  assessMethodologyDuplicateGroup,
  type MethodologyRecord,
  type MethodologyRelationRecord,
  type PracticeAssetKind,
  type PracticeAssetRecord,
  type PracticeAssetStatus,
} from "@cognelis/decision-core";

interface MethodologyStore {
  list(): Promise<MethodologyRecord[]>;
  save(record: MethodologyRecord): Promise<void>;
}

interface RelationStore {
  list(): Promise<MethodologyRelationRecord[]>;
}

interface PracticeAssetStore {
  list(): Promise<PracticeAssetRecord[]>;
}

interface PracticeAssetMigration {
  createSourceMigrationDraft(
    id: string,
    sourcePrincipleIds: string[],
  ): Promise<PracticeAssetRecord>;
}

export interface MethodologyMergeLifecycleSource {
  id: string;
  title: string;
  status: MethodologyRecord["status"];
  retiredAt: string | null;
  supersededById: string | null;
}

export interface MethodologyMergeLifecycleAsset {
  id: string;
  title: string;
  kind: PracticeAssetKind;
  status: PracticeAssetStatus;
  sourcePrincipleIds: string[];
  targetSourcePrincipleIds: string[];
  replacementId: string | null;
  replacementTitle: string | null;
}

export interface MethodologyMergeLifecyclePlan {
  mergeId: string;
  mergeTitle: string;
  mergeStatus: MethodologyRecord["status"];
  sources: MethodologyMergeLifecycleSource[];
  relationValid: boolean;
  retired: boolean;
  canRetire: boolean;
  canRestore: boolean;
  modelCallsRequired: number;
  pendingReviewCount: number;
  assets: MethodologyMergeLifecycleAsset[];
}

const sameIds = (left: string[], right: string[]): boolean =>
  [...left].sort().join("\n") === [...right].sort().join("\n");

const migrationTargets = (
  asset: PracticeAssetRecord,
  sourceIds: Set<string>,
  mergeId: string,
): string[] => [
  ...new Set([
    ...asset.sourcePrincipleIds.filter((id) => !sourceIds.has(id)),
    mergeId,
  ]),
];

export class MethodologyMergeLifecycleService {
  readonly #methodologies: MethodologyStore;
  readonly #relations: RelationStore;
  readonly #assets: PracticeAssetStore;
  readonly #practiceAssets: PracticeAssetMigration;
  readonly #now: () => Date;

  constructor(options: {
    methodologies: MethodologyStore;
    relations: RelationStore;
    assets: PracticeAssetStore;
    practiceAssets: PracticeAssetMigration;
    now?: () => Date;
  }) {
    this.#methodologies = options.methodologies;
    this.#relations = options.relations;
    this.#assets = options.assets;
    this.#practiceAssets = options.practiceAssets;
    this.#now = options.now ?? (() => new Date());
  }

  async plan(mergeId: string): Promise<MethodologyMergeLifecyclePlan> {
    const [methodologies, relations, assets] = await Promise.all([
      this.#methodologies.list(),
      this.#relations.list(),
      this.#assets.list(),
    ]);
    const merge = this.#requireMerge(mergeId, methodologies);
    const sourceIds = merge.sourcePrincipleIds!;
    const sources = sourceIds.map((id) =>
      methodologies.find((record) => record.id === id),
    );
    if (sources.some((source) => source === undefined)) {
      throw new Error("部分合并来源原则已不存在，已停止整理。");
    }
    const resolvedSources = sources as MethodologyRecord[];
    const relationValid = assessMethodologyDuplicateGroup(
      sourceIds,
      relations,
    ).complete;
    const sourceIdSet = new Set(sourceIds);
    const impacted = assets
      .filter(
        (asset) =>
          asset.status !== "dismissed" &&
          asset.sourcePrincipleIds.some((id) => sourceIdSet.has(id)),
      )
      .map((asset): MethodologyMergeLifecycleAsset => {
        const targetSourcePrincipleIds = migrationTargets(
          asset,
          sourceIdSet,
          merge.id,
        );
        const replacement =
          asset.status !== "accepted"
            ? undefined
            : assets.find(
                (candidate) =>
                  candidate.status === "candidate" &&
                  candidate.supersedesId === asset.id &&
                  sameIds(
                    candidate.sourcePrincipleIds,
                    targetSourcePrincipleIds,
                  ) &&
                  sameIds(
                    candidate.migrationSourcePrincipleIds ?? [],
                    asset.sourcePrincipleIds,
                  ),
              );
        return {
          id: asset.id,
          title: asset.title,
          kind: asset.kind,
          status: asset.status,
          sourcePrincipleIds: [...asset.sourcePrincipleIds],
          targetSourcePrincipleIds,
          replacementId: replacement?.id ?? null,
          replacementTitle: replacement?.title ?? null,
        };
      })
      .sort(
        (left, right) =>
          Number(right.status === "accepted") -
            Number(left.status === "accepted") ||
          left.title.localeCompare(right.title, "zh-CN"),
      );
    const retired = resolvedSources.every(
      (source) =>
        source.status === "retired" && source.supersededById === merge.id,
    );
    const canRestore = retired;
    const sourcesAccepted = resolvedSources.every(
      (source) => source.status === "accepted" && source.confirmedAt !== null,
    );
    return {
      mergeId: merge.id,
      mergeTitle: merge.title,
      mergeStatus: merge.status,
      sources: resolvedSources.map((source) => ({
        id: source.id,
        title: source.title,
        status: source.status,
        retiredAt: source.retiredAt ?? null,
        supersededById: source.supersededById ?? null,
      })),
      relationValid,
      retired,
      canRetire:
        merge.status === "accepted" &&
        relationValid &&
        sourcesAccepted &&
        impacted.length === 0,
      canRestore,
      modelCallsRequired: impacted.filter(
        (asset) => asset.replacementId === null,
      ).length,
      pendingReviewCount: impacted.filter(
        (asset) => asset.replacementId !== null,
      ).length,
      assets: impacted,
    };
  }

  async prepareAsset(
    mergeId: string,
    assetId: string,
  ): Promise<PracticeAssetRecord> {
    const plan = await this.plan(mergeId);
    if (
      plan.mergeStatus !== "accepted" ||
      !plan.relationValid ||
      plan.sources.some((source) => source.status !== "accepted")
    ) {
      throw new Error("合并来源或重复关系已变化，请刷新后重新核对。");
    }
    const impact = plan.assets.find((asset) => asset.id === assetId);
    if (impact === undefined) {
      throw new Error("该技能或流程已经不再引用待归档来源。");
    }
    return this.#practiceAssets.createSourceMigrationDraft(
      impact.id,
      impact.targetSourcePrincipleIds,
    );
  }

  async retireSources(mergeId: string): Promise<MethodologyMergeLifecyclePlan> {
    const plan = await this.plan(mergeId);
    if (plan.retired) return plan;
    if (!plan.canRetire) {
      throw new Error(
        plan.assets.length > 0
          ? "仍有技能或流程引用来源原则，请先完成替换草案审核。"
          : "合并来源或重复关系已变化，当前不能归档。",
      );
    }
    const records = await this.#methodologies.list();
    const sources = plan.sources.map((source) => {
      const record = records.find((item) => item.id === source.id);
      if (record === undefined) {
        throw new Error("部分合并来源原则已不存在，已停止归档。");
      }
      return record;
    });
    const now = this.#now().toISOString();
    await this.#saveBatch(
      sources,
      sources.map((source) => ({
        ...source,
        status: "retired" as const,
        retiredAt: now,
        supersededById: mergeId,
        updatedAt: now,
      })),
    );
    return this.plan(mergeId);
  }

  async restoreSources(
    mergeId: string,
  ): Promise<MethodologyMergeLifecyclePlan> {
    const plan = await this.plan(mergeId);
    if (!plan.canRestore) {
      throw new Error("这些来源原则当前不处于可恢复的归档状态。");
    }
    const records = await this.#methodologies.list();
    const sources = plan.sources.map((source) => {
      const record = records.find((item) => item.id === source.id);
      if (record === undefined) {
        throw new Error("部分归档来源原则已不存在，已停止恢复。");
      }
      return record;
    });
    const now = this.#now().toISOString();
    const restored = sources.map((source): MethodologyRecord => {
      const {
        retiredAt: _retiredAt,
        supersededById: _supersededById,
        ...base
      } = source;
      return { ...base, status: "accepted", updatedAt: now };
    });
    await this.#saveBatch(sources, restored);
    return this.plan(mergeId);
  }

  #requireMerge(
    mergeId: string,
    records: MethodologyRecord[],
  ): MethodologyRecord & { sourcePrincipleIds: string[] } {
    const normalized = mergeId.trim();
    if (normalized.length === 0 || normalized.length > 200) {
      throw new Error("合并原则编号无效。");
    }
    const merge = records.find((record) => record.id === normalized);
    if (
      merge === undefined ||
      merge.origin !== "principle_merge" ||
      merge.sourcePrincipleIds === undefined ||
      merge.sourcePrincipleIds.length < 2 ||
      merge.sourcePrincipleIds.length > 5
    ) {
      throw new Error("指定原则不是可整理的合并原则。");
    }
    return merge as MethodologyRecord & { sourcePrincipleIds: string[] };
  }

  async #saveBatch(
    originals: MethodologyRecord[],
    updates: MethodologyRecord[],
  ): Promise<void> {
    const saved: number[] = [];
    try {
      for (const [index, update] of updates.entries()) {
        await this.#methodologies.save(update);
        saved.push(index);
      }
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      for (const index of saved.reverse()) {
        try {
          await this.#methodologies.save(originals[index]!);
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError);
        }
      }
      if (rollbackFailures.length > 0) {
        throw new Error(
          "来源原则整理未完整写入，且自动恢复失败；请停止操作并检查 Markdown。",
          { cause: error },
        );
      }
      throw error;
    }
  }
}
