import type {
  MethodologyRecord,
  PracticeAssetDraft,
  PracticeAssetHistoryEntry,
  PracticeAssetHistoryReason,
  PracticeAssetKind,
  PracticeAssetRecord,
  PracticeAssetStatus,
} from "@cognelis/decision-core";
import {
  assessPracticeAssetFreshness,
  snapshotPracticeAssetSources,
} from "@cognelis/decision-core";
import {
  MethodologyRepository,
  PracticeAssetRepository,
} from "@cognelis/decision-storage";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ProfiledModelGatewayError,
  type ProfiledModelGateway,
} from "./model/profiled-model-gateway.js";

const SKILL_PROMPT_VERSION = "skill-drafting-v1";
const WORKFLOW_PROMPT_VERSION = "workflow-drafting-v1";
const PRACTICE_SCHEMA_VERSION = "practice-asset-v1";

export const practiceAssetDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(800),
    trigger: z.string().trim().min(1).max(1_500),
    steps: z.array(z.string().trim().min(1).max(500)).min(2).max(12),
    checks: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    fallback: z.string().trim().min(1).max(1_500),
  })
  .strict();

export const practiceAssetOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "trigger", "steps", "checks", "fallback"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    summary: { type: "string", minLength: 1, maxLength: 800 },
    trigger: { type: "string", minLength: 1, maxLength: 1_500 },
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    checks: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    fallback: { type: "string", minLength: 1, maxLength: 1_500 },
  },
} as const;

const promptFor = (kind: PracticeAssetKind): string => `你是 Decision 的${
  kind === "skill" ? "技能草案" : "工作流草案"
}生成器。输入只包含用户已经审核并采纳的方法论原则。

必须遵守：
1. 只把输入原则转成可执行步骤，不补写未出现的工具、文件路径、权限、指标或组织流程。
2. 每一步使用明确动作开头，保持顺序和边界清晰；验收检查必须能够由执行者观察。
3. 使用条件必须包含适用场景，也要尊重来源原则中的注意事项。
4. 失败处理说明何时停止、回退或重新评估，不能要求静默继续。
5. ${
  kind === "skill"
    ? "技能应可被不同开发任务复用，不绑定当前项目名称。"
    : "工作流应表达阶段顺序、阶段出口与最终验收，不写成一次性的任务清单。"
}
6. 输出简体中文，只返回符合 JSON Schema 的对象。`;

const normalizedIds = (ids: string[]): string[] => {
  const values = [...new Set(ids.map((id) => id.trim()))].filter(
    (id) => id.length > 0 && id.length <= 200,
  );
  if (values.length === 0 || values.length > 5) {
    throw new Error("请选择 1 至 5 条已采纳原则作为来源。");
  }
  return values;
};

const sameSources = (left: string[], right: string[]): boolean =>
  [...left].sort().join("\n") === [...right].sort().join("\n");

const buildPrincipleInput = (records: MethodologyRecord[]) =>
  records.map((record, index) => ({
    principle: index + 1,
    title: record.title.slice(0, 120),
    guidance: record.principle.slice(0, 2_000),
    appliesWhen: record.appliesWhen.slice(0, 1_500),
    caution: record.caution.slice(0, 1_500),
    evidenceSummary: record.evidenceSummary.slice(0, 1_500),
    confidence: record.confidence,
  }));

const slugFor = (
  kind: PracticeAssetKind,
  title: string,
  id: string,
): string => {
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
  const readable = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 43)
    .replace(/-+$/u, "");
  if (readable.length > 0) return `decision-${readable}-${digest}`;
  return `decision-${kind}-${digest}`;
};

interface MethodologySourceRepository {
  list(): Promise<MethodologyRecord[]>;
}

interface PracticeRepository {
  list(): Promise<PracticeAssetRecord[]>;
  find(id: string): Promise<PracticeAssetRecord | null>;
  save(record: PracticeAssetRecord): Promise<void>;
}

interface PracticeHistoryRepository {
  list(assetId: string): Promise<PracticeAssetHistoryEntry[]>;
  find(assetId: string, version: number): Promise<PracticeAssetHistoryEntry | null>;
  capture(
    asset: PracticeAssetRecord,
    reason: PracticeAssetHistoryReason,
    capturedAt: string,
  ): Promise<PracticeAssetHistoryEntry>;
}

export interface PracticeAssetRevision extends PracticeAssetDraft {}

export class PracticeAssetService {
  readonly #methodologies: MethodologySourceRepository;
  readonly #assets: PracticeRepository;
  readonly #history: PracticeHistoryRepository;
  readonly #gateway: ProfiledModelGateway;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: {
    methodologies: MethodologyRepository;
    assets: PracticeAssetRepository;
    history: PracticeHistoryRepository;
    gateway: ProfiledModelGateway;
    now?: () => Date;
    idFactory?: () => string;
  }) {
    this.#methodologies = options.methodologies;
    this.#assets = options.assets;
    this.#history = options.history;
    this.#gateway = options.gateway;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async list(status?: PracticeAssetStatus): Promise<PracticeAssetRecord[]> {
    const records = await this.#assets.list();
    return status === undefined
      ? records
      : records.filter((record) => record.status === status);
  }

  async listVersions(id: string): Promise<PracticeAssetHistoryEntry[]> {
    await this.#require(id);
    return this.#history.list(id);
  }

  async generate(
    kind: PracticeAssetKind,
    sourcePrincipleIds: string[],
  ): Promise<PracticeAssetRecord> {
    const ids = normalizedIds(sourcePrincipleIds);
    const methodologies = await this.#methodologies.list();
    const sources = this.#acceptedSources(ids, methodologies);
    const records = await this.#assets.list();
    const matching = records.filter(
      (record) =>
        record.kind === kind &&
        record.status !== "dismissed" &&
        sameSources(record.sourcePrincipleIds, ids),
    );
    const current = matching.find(
      (record) =>
        assessPracticeAssetFreshness(record, methodologies).state === "current",
    );
    if (current !== undefined) return current;
    const accepted = matching.find((record) => record.status === "accepted");
    const staleCandidate = matching.find(
      (record) => record.status === "candidate",
    );
    const generated = await this.#generateDraft(
      kind,
      ids,
      sources,
      accepted?.id ?? null,
    );
    if (accepted === undefined && staleCandidate !== undefined) {
      await this.#dismissReplacedCandidate(staleCandidate);
    }
    return generated;
  }

  async createManual(
    kind: PracticeAssetKind,
    sourcePrincipleIds: string[],
    input: PracticeAssetDraft,
  ): Promise<PracticeAssetRecord> {
    const ids = normalizedIds(sourcePrincipleIds);
    const draft = practiceAssetDraftSchema.parse(input);
    const methodologies = await this.#methodologies.list();
    const sources = this.#acceptedSources(ids, methodologies);
    const records = await this.#assets.list();
    const matching = records.filter(
      (record) =>
        record.kind === kind &&
        record.status !== "dismissed" &&
        sameSources(record.sourcePrincipleIds, ids),
    );
    const current = matching.find(
      (record) =>
        assessPracticeAssetFreshness(record, methodologies).state === "current",
    );
    if (current !== undefined) {
      throw new Error(
        `已经存在使用相同来源的${kind === "skill" ? "技能" : "工作流"}，请直接打开并编辑现有资产。`,
      );
    }
    const accepted = matching.find((record) => record.status === "accepted");
    const staleCandidate = matching.find(
      (record) => record.status === "candidate",
    );
    const generatedId = this.#idFactory();
    const id = `${kind}-${generatedId}`;
    const now = this.#now().toISOString();
    const record: PracticeAssetRecord = {
      id,
      slug: slugFor(kind, draft.title, id),
      kind,
      status: "candidate",
      createdAt: now,
      updatedAt: now,
      acceptedAt: null,
      ...draft,
      sourcePrincipleIds: ids,
      sourceSnapshots: snapshotPracticeAssetSources(sources),
      ...(accepted === undefined ? {} : { supersedesId: accepted.id }),
      generation: {
        requestId: `manual-${kind}:${generatedId}`,
        profileId: "manual-practice-asset",
        provider: "人工创建",
        model: "不调用模型",
      },
    };
    await this.#assets.save(record);
    if (accepted === undefined && staleCandidate !== undefined) {
      await this.#dismissReplacedCandidate(staleCandidate);
    }
    return record;
  }

  async regenerate(id: string): Promise<PracticeAssetRecord> {
    const current = await this.#require(id);
    if (current.status === "dismissed") {
      throw new Error("已忽略的草案不能重新生成。");
    }
    const methodologies = await this.#methodologies.list();
    const freshness = assessPracticeAssetFreshness(current, methodologies);
    if (freshness.state === "sources_unavailable") {
      throw new Error(freshness.message);
    }
    if (freshness.state === "current") {
      throw new Error("来源原则没有更新，无需重新生成；可以直接编辑当前内容。");
    }
    const records = await this.#assets.list();
    const existingReplacement = records.find(
      (record) =>
        record.status === "candidate" &&
        record.supersedesId === current.id &&
        assessPracticeAssetFreshness(record, methodologies).state === "current",
    );
    if (existingReplacement !== undefined) return existingReplacement;
    const sources = this.#acceptedSources(
      current.sourcePrincipleIds,
      methodologies,
    );
    const generated = await this.#generateDraft(
      current.kind,
      current.sourcePrincipleIds,
      sources,
      current.status === "accepted" ? current.id : null,
    );
    if (current.status === "candidate") {
      await this.#dismissReplacedCandidate(current);
    }
    return generated;
  }

  async createSourceMigrationDraft(
    id: string,
    sourcePrincipleIds: string[],
  ): Promise<PracticeAssetRecord> {
    const current = await this.#require(id);
    if (current.status === "dismissed") {
      throw new Error("已忽略的草案不能迁移来源。");
    }
    const ids = normalizedIds(sourcePrincipleIds);
    if (sameSources(current.sourcePrincipleIds, ids)) {
      throw new Error("实践资产已经使用目标来源，无需迁移。");
    }
    const methodologies = await this.#methodologies.list();
    const sources = this.#acceptedSources(ids, methodologies);
    const records = await this.#assets.list();
    if (current.status === "accepted") {
      const existingReplacement = records.find(
        (record) =>
          record.status === "candidate" &&
          record.supersedesId === current.id &&
          sameSources(record.sourcePrincipleIds, ids) &&
          sameSources(
            record.migrationSourcePrincipleIds ?? [],
            current.sourcePrincipleIds,
          ) &&
          assessPracticeAssetFreshness(record, methodologies).state ===
            "current",
      );
      if (existingReplacement !== undefined) return existingReplacement;
      return this.#generateDraft(
        current.kind,
        ids,
        sources,
        current.id,
        current.sourcePrincipleIds,
      );
    }
    const generated = await this.#generateDraft(
      current.kind,
      ids,
      sources,
      null,
    );
    await this.#dismissReplacedCandidate(current);
    return generated;
  }

  async #generateDraft(
    kind: PracticeAssetKind,
    ids: string[],
    sources: MethodologyRecord[],
    supersedesId: string | null,
    migrationSourcePrincipleIds: string[] | null = null,
  ): Promise<PracticeAssetRecord> {
    const generatedId = this.#idFactory();
    const requestId = `${kind}:${generatedId}`;
    const result = await this.#gateway
      .generate(
        {
          requestId,
          purpose: kind === "skill" ? "skill-drafting" : "workflow-drafting",
          promptVersion:
            kind === "skill" ? SKILL_PROMPT_VERSION : WORKFLOW_PROMPT_VERSION,
          schemaVersion: PRACTICE_SCHEMA_VERSION,
          locale: "zh-CN",
          systemPrompt: promptFor(kind),
          userPrompt: `请基于以下已采纳原则生成${
            kind === "skill" ? "技能" : "工作流"
          }草案：\n${JSON.stringify(buildPrincipleInput(sources), null, 2)}`,
          outputSchema: practiceAssetOutputJsonSchema,
          maxOutputTokens: 1_024,
        },
        (value) => practiceAssetDraftSchema.parse(value),
      )
      .catch((error: unknown) => {
        if (error instanceof ProfiledModelGatewayError) {
          throw new Error(
            "当前没有可用于生成草案的模型，请先在“模型”中启用并确认 Qwen、API 或终端模型可用。",
            { cause: error },
          );
        }
        throw error;
      });
    const now = this.#now().toISOString();
    const id = `${kind}-${generatedId}`;
    const record: PracticeAssetRecord = {
      id,
      slug: slugFor(kind, result.parsedOutput.title, id),
      kind,
      status: "candidate",
      createdAt: now,
      updatedAt: now,
      acceptedAt: null,
      ...result.parsedOutput,
      sourcePrincipleIds: ids,
      sourceSnapshots: snapshotPracticeAssetSources(sources),
      ...(supersedesId === null ? {} : { supersedesId }),
      ...(migrationSourcePrincipleIds === null
        ? {}
        : { migrationSourcePrincipleIds }),
      generation: {
        requestId: result.requestId,
        profileId: result.profileId,
        provider: result.provider,
        model: result.model,
      },
    };
    await this.#assets.save(record);
    return record;
  }

  async revise(
    id: string,
    revision: PracticeAssetRevision,
  ): Promise<PracticeAssetRecord> {
    const current = await this.#require(id);
    if (current.status === "dismissed") {
      throw new Error("已忽略的草案不能再编辑。");
    }
    const draft = practiceAssetDraftSchema.parse(revision);
    const methodologies = await this.#methodologies.list();
    const resolvedSources = current.sourcePrincipleIds.flatMap((sourceId) => {
      const source = methodologies.find((record) => record.id === sourceId);
      return source === undefined ? [] : [source];
    });
    const canRefreshSourceBaseline =
      resolvedSources.length === current.sourcePrincipleIds.length &&
      resolvedSources.every(
        (source) => source.status === "accepted" && source.confirmedAt !== null,
      );
    const now = this.#now().toISOString();
    if (current.status === "accepted") {
      await this.#history.capture(current, "manual_edit", now);
    }
    const updated: PracticeAssetRecord = {
      ...current,
      ...draft,
      updatedAt: now,
      ...(canRefreshSourceBaseline
        ? { sourceSnapshots: snapshotPracticeAssetSources(resolvedSources) }
        : {}),
    };
    await this.#assets.save(updated);
    return updated;
  }

  async setStatus(
    id: string,
    status: Extract<PracticeAssetStatus, "accepted" | "dismissed">,
  ): Promise<PracticeAssetRecord> {
    const current = await this.#require(id);
    const now = this.#now().toISOString();
    if (status === "accepted") {
      const freshness = assessPracticeAssetFreshness(
        current,
        await this.#methodologies.list(),
      );
      if (freshness.state !== "current") {
        throw new Error(
          freshness.state === "sources_updated"
            ? "来源原则已更新，请先重新生成，或编辑并保存草案后再采纳。"
            : freshness.message,
        );
      }
    }
    if (status === "accepted" && current.supersedesId != null) {
      const target = await this.#assets.find(current.supersedesId);
      if (target === null || target.status !== "accepted") {
        throw new Error("原资产已不存在或不再处于已采纳状态，不能应用替换草案。");
      }
      const keepsSources = sameSources(
        target.sourcePrincipleIds,
        current.sourcePrincipleIds,
      );
      const migratesSources =
        current.migrationSourcePrincipleIds !== undefined &&
        sameSources(
          target.sourcePrincipleIds,
          current.migrationSourcePrincipleIds,
        );
      if (target.kind !== current.kind || (!keepsSources && !migratesSources)) {
        throw new Error("替换草案与原资产的类型或来源不一致，不能应用。");
      }
      const updatedTarget: PracticeAssetRecord =
        target.generation.requestId === current.generation.requestId
          ? target
          : {
              ...target,
              title: current.title,
              summary: current.summary,
              trigger: current.trigger,
              steps: current.steps,
              checks: current.checks,
              fallback: current.fallback,
              sourcePrincipleIds: current.sourcePrincipleIds,
              ...(current.sourceSnapshots === undefined
                ? {}
                : { sourceSnapshots: current.sourceSnapshots }),
              generation: current.generation,
              updatedAt: now,
            };
      if (updatedTarget !== target) {
        await this.#history.capture(target, "replacement_applied", now);
        await this.#assets.save(updatedTarget);
      }
      await this.#assets.save({
        ...current,
        status: "dismissed",
        acceptedAt: null,
        updatedAt: now,
      });
      return updatedTarget;
    }
    const updated: PracticeAssetRecord = {
      ...current,
      status,
      updatedAt: now,
      acceptedAt: status === "accepted" ? now : null,
    };
    await this.#assets.save(updated);
    return updated;
  }

  async restoreVersion(id: string, version: number): Promise<PracticeAssetRecord> {
    const current = await this.#require(id);
    if (current.status !== "accepted") {
      throw new Error("只有已采纳资产可以恢复历史版本。");
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("实践资产历史版本无效。");
    }
    const entry = await this.#history.find(id, version);
    if (entry === null) throw new Error("指定的实践资产历史版本不存在。");
    if (
      entry.snapshot.id !== current.id ||
      entry.snapshot.slug !== current.slug ||
      entry.snapshot.kind !== current.kind
    ) {
      throw new Error("历史版本与当前资产标识不一致，已停止恢复。");
    }
    const now = this.#now().toISOString();
    await this.#history.capture(current, "restore_checkpoint", now);
    const restored: PracticeAssetRecord = {
      ...current,
      title: entry.snapshot.title,
      summary: entry.snapshot.summary,
      trigger: entry.snapshot.trigger,
      steps: entry.snapshot.steps,
      checks: entry.snapshot.checks,
      fallback: entry.snapshot.fallback,
      sourcePrincipleIds: entry.snapshot.sourcePrincipleIds,
      ...(entry.snapshot.sourceSnapshots === undefined
        ? { sourceSnapshots: [] }
        : { sourceSnapshots: entry.snapshot.sourceSnapshots }),
      generation: entry.snapshot.generation,
      updatedAt: now,
    };
    await this.#assets.save(restored);
    return restored;
  }

  #acceptedSources(
    ids: string[],
    methodologies: MethodologyRecord[],
  ): MethodologyRecord[] {
    const byId = new Map(methodologies.map((record) => [record.id, record]));
    const sources = ids
      .map((sourceId) => byId.get(sourceId))
      .filter((record): record is MethodologyRecord => record !== undefined);
    if (sources.length !== ids.length) {
      throw new Error("部分来源原则已不存在，请刷新后重新选择。");
    }
    if (
      sources.some(
        (record) => record.status !== "accepted" || record.confirmedAt === null,
      )
    ) {
      throw new Error("只有已采纳的方法论原则才能生成技能或工作流。");
    }
    return sources;
  }

  async #dismissReplacedCandidate(
    current: PracticeAssetRecord,
  ): Promise<void> {
    await this.#assets.save({
      ...current,
      status: "dismissed",
      acceptedAt: null,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #require(id: string): Promise<PracticeAssetRecord> {
    const normalized = id.trim();
    if (normalized.length === 0 || normalized.length > 200) {
      throw new Error("草案编号无效。");
    }
    const record = await this.#assets.find(normalized);
    if (record === null) throw new Error("技能或工作流草案不存在。");
    return record;
  }
}
