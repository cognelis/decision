import type {
  MethodologyDraft,
  MethodologyHistoryEntry,
  MethodologyRelationDisposition,
  MethodologyRelationRecord,
  MethodologyRecord,
  MethodologyStatus,
  OutcomeVerdict,
} from "@cognelis/decision-core";
import {
  assessMethodologyDuplicateGroup,
  assessMethodologyQuality,
} from "@cognelis/decision-core";
import type { IndexedDecision } from "@cognelis/decision-storage";
import {
  MethodologyRelationRepository,
  MethodologyRepository,
} from "@cognelis/decision-storage";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ProfiledModelGatewayError,
  type ProfiledModelGateway,
} from "./model/profiled-model-gateway.js";
import {
  parseMethodologyMarkdownDrafts,
  type MethodologyMarkdownDraft,
  type MethodologyMarkdownSource,
} from "./methodology-markdown-import.js";

const METHODOLOGY_PROMPT_VERSION = "methodology-extraction-v1";
const METHODOLOGY_SCHEMA_VERSION = "methodology-candidate-v1";
const MAX_IMPORTED_CANDIDATES = 60;

export const methodologyDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    principle: z.string().trim().min(1).max(2_000),
    appliesWhen: z.string().trim().min(1).max(2_000),
    caution: z.string().trim().min(1).max(2_000),
    evidenceSummary: z.string().trim().min(1).max(3_000),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();

export const methodologyOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "principle",
    "appliesWhen",
    "caution",
    "evidenceSummary",
    "confidence",
  ],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    principle: { type: "string", minLength: 1, maxLength: 2_000 },
    appliesWhen: { type: "string", minLength: 1, maxLength: 2_000 },
    caution: { type: "string", minLength: 1, maxLength: 2_000 },
    evidenceSummary: {
      type: "string",
      minLength: 1,
      maxLength: 3_000,
    },
    confidence: {
      type: "string",
      enum: ["low", "medium", "high"],
    },
  },
} as const;

const methodologySystemPrompt = `你是 Decision 的方法论提炼器。输入只包含用户已经记录实际结果并人工复盘的决策证据。

你的任务是从这些证据中提炼一个可复用、可执行、边界清晰的候选原则。必须遵守：
1. 只使用输入证据，不补写未出现的事实、因果或成功指标。
2. “原则”说明以后遇到类似决策时应该怎样判断或行动，不要复述某个具体页面或文件名。
3. “适用条件”说明何时可以使用；“注意事项”说明何时不应套用或需要重新验证。
4. “证据摘要”必须区分已观察到的结果和你的有限归纳，并使用“证据 1”等编号对应输入。
5. 单条证据只能给 low；两条一致证据最高 medium；至少三条独立且一致证据才可以给 high。
6. 输出简体中文，只返回符合 JSON Schema 的对象。`;

const verdictLabels: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};

const bounded = (value: string | null, maximum: number): string | null =>
  value === null ? null : value.trim().slice(0, maximum);

const reviewedVerdict = (value: string | null): OutcomeVerdict | null =>
  value === "better" ||
  value === "as_expected" ||
  value === "mixed" ||
  value === "worse" ||
  value === "unclear"
    ? value
    : null;

const buildEvidence = (decisions: IndexedDecision[]) =>
  decisions.map((decision, index) => {
    const verdict = reviewedVerdict(decision.outcomeVerdict)!;
    return {
      evidence: index + 1,
      project: bounded(decision.project, 200),
      question: bounded(decision.question, 350),
      selectedAnswer: bounded(decision.selectedAnswer, 300),
      rationale: bounded(decision.rationale, 350),
      context: bounded(decision.context, 350),
      actualOutcome: bounded(decision.outcome, 500),
      reviewVerdict: verdictLabels[verdict],
      reviewLesson: bounded(decision.outcomeLesson, 500),
      reviewedAt: decision.outcomeReviewedAt,
    };
  });

const normalizedSourceIds = (ids: string[]): string[] => {
  const values = [...new Set(ids.map((id) => id.trim()))].filter(
    (id) => id.length > 0 && id.length <= 200,
  );
  if (values.length === 0 || values.length > 5) {
    throw new Error("请选择 1 至 5 条已复盘决策作为证据。");
  }
  return values;
};

const sameSources = (left: string[], right: string[]): boolean =>
  [...left].sort().join("\n") === [...right].sort().join("\n");

interface MethodologyDecisionIndex {
  findDecisions(ids: string[]): IndexedDecision[];
}

interface MethodologyHistory {
  list(id: string): Promise<MethodologyHistoryEntry[]>;
  find(id: string, version: number): Promise<MethodologyHistoryEntry | null>;
  capture(
    methodology: MethodologyRecord,
    reason: "revision_applied" | "restore_checkpoint",
    capturedAt: string,
  ): Promise<MethodologyHistoryEntry>;
}

export interface MethodologyRevision {
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
  evidenceSummary: string;
}

export interface MethodologyManualInput {
  title: string;
  principle: string;
  appliesWhen: string;
  caution: string;
}

export interface MethodologyEvidenceManualInput extends MethodologyRevision {
  sourceDecisionIds: string[];
}

export interface MethodologyMergeInput extends MethodologyRevision {
  sourceDecisionIds: string[];
}

export interface MethodologyEvolutionInput extends MethodologyRevision {
  sourceDecisionIds: string[];
}

export interface MethodologyStatusOptions {
  acknowledgeQualityRisks?: boolean;
}

export interface MethodologyImportFailure {
  fileName: string;
  title?: string;
  message: string;
}

export interface MethodologyImportDuplicate {
  fileName: string;
  title: string;
  existingTitle: string;
}

export interface MethodologyImportSimilarity {
  title: string;
  status: MethodologyStatus | "selection";
}

export interface MethodologyImportCandidate extends MethodologyMarkdownDraft {
  id: string;
  fileName: string;
  contentSha256: string;
  missingFields: Array<"appliesWhen" | "caution">;
  similarTo: MethodologyImportSimilarity | null;
}

export interface MethodologyImportPlan {
  candidates: MethodologyImportCandidate[];
  duplicates: MethodologyImportDuplicate[];
  failures: MethodologyImportFailure[];
}

export interface MethodologyImportResult {
  imported: MethodologyRecord[];
  duplicates: MethodologyImportDuplicate[];
  failures: MethodologyImportFailure[];
}

const normalizedImportText = (value: string): string =>
  value.normalize("NFKC").trim().replace(/\s+/gu, " ");

const importFingerprint = (record: {
  principle: string;
  appliesWhen: string;
  caution: string;
}): string =>
  [record.principle, record.appliesWhen, record.caution]
    .map(normalizedImportText)
    .join("\n");

const principleFingerprint = (record: { principle: string }): string =>
  normalizedImportText(record.principle);

const relationIdFor = (firstId: string, secondId: string): string => {
  const principleIds = [firstId, secondId].sort();
  return `principle-relation-${createHash("sha256")
    .update(principleIds.join("\0"), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
};

export class MethodologyService {
  readonly #repository: MethodologyRepository;
  readonly #relationRepository: MethodologyRelationRepository;
  readonly #index: MethodologyDecisionIndex;
  readonly #history: MethodologyHistory;
  readonly #gateway: ProfiledModelGateway;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: {
    repository: MethodologyRepository;
    relationRepository: MethodologyRelationRepository;
    index: MethodologyDecisionIndex;
    history: MethodologyHistory;
    gateway: ProfiledModelGateway;
    now?: () => Date;
    idFactory?: () => string;
  }) {
    this.#repository = options.repository;
    this.#relationRepository = options.relationRepository;
    this.#index = options.index;
    this.#history = options.history;
    this.#gateway = options.gateway;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  async list(status?: MethodologyStatus): Promise<MethodologyRecord[]> {
    const records = (await this.#repository.list()).filter(
      (record) => record.appliedAt === undefined,
    );
    return status === undefined
      ? records
      : records.filter((record) => record.status === status);
  }

  async listRelations(): Promise<MethodologyRelationRecord[]> {
    return this.#relationRepository.list();
  }

  async setRelation(
    id: string,
    relatedId: string,
    disposition: MethodologyRelationDisposition,
    note: string | null,
  ): Promise<MethodologyRecord> {
    if (
      !(["duplicate", "conflict", "unrelated"] as const).includes(disposition)
    ) {
      throw new Error("原则关系结论无效。");
    }
    const [current, related] = await Promise.all([
      this.#require(id),
      this.#require(relatedId),
    ]);
    if (current.id === related.id) {
      throw new Error("不能核对原则与自身的关系。");
    }
    if (current.status === "dismissed" || related.status === "dismissed") {
      throw new Error("已忽略的原则不能建立人工关系。");
    }
    const normalizedNote = note?.trim() || null;
    if (normalizedNote !== null && normalizedNote.length > 500) {
      throw new Error("核对说明最多 500 字。");
    }
    const relations = await this.#relationRepository.list();
    const existing = relations.find(
      (relation) =>
        relation.principleIds.includes(current.id) &&
        relation.principleIds.includes(related.id),
    );
    const now = this.#now().toISOString();
    const ordered = [current, related].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    await this.#relationRepository.save({
      id: existing?.id ?? relationIdFor(current.id, related.id),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      principleIds: [ordered[0]!.id, ordered[1]!.id],
      principleTitles: [ordered[0]!.title, ordered[1]!.title],
      disposition,
      note: normalizedNote,
    });
    return current;
  }

  async clearRelation(
    id: string,
    relatedId: string,
  ): Promise<MethodologyRecord> {
    const [current, related] = await Promise.all([
      this.#require(id),
      this.#require(relatedId),
    ]);
    if (current.id === related.id) {
      throw new Error("不能撤销原则与自身的关系。");
    }
    const relations = await this.#relationRepository.list();
    const existing = relations.find(
      (relation) =>
        relation.principleIds.includes(current.id) &&
        relation.principleIds.includes(related.id),
    );
    if (existing !== undefined) {
      await this.#relationRepository.remove(existing.id);
    }
    return current;
  }

  async createMergeDraft(
    inputSourcePrincipleIds: string[],
    input: MethodologyMergeInput,
  ): Promise<MethodologyRecord> {
    const sourcePrincipleIds = [
      ...new Set(inputSourcePrincipleIds.map((id) => id.trim())),
    ].sort();
    if (
      sourcePrincipleIds.length !== inputSourcePrincipleIds.length ||
      sourcePrincipleIds.length < 2 ||
      sourcePrincipleIds.length > 5
    ) {
      throw new Error("合并草案需要 2–5 条不重复的来源原则。");
    }
    const sources = await Promise.all(
      sourcePrincipleIds.map((id) => this.#require(id)),
    );
    if (sources.some((source) => source.status !== "accepted")) {
      throw new Error("只有全部已采纳的原则才能建立合并草案。");
    }
    const relations = await this.#relationRepository.list();
    const duplicateCoverage = assessMethodologyDuplicateGroup(
      sourcePrincipleIds,
      relations,
    );
    if (!duplicateCoverage.complete) {
      throw new Error(
        `这组原则还缺少 ${duplicateCoverage.missingPairs.length} 对人工重复结论，不能建立合并草案。`,
      );
    }
    const records = await this.#repository.list();
    const existing = records.find(
      (record) =>
        record.status !== "dismissed" &&
        record.origin === "principle_merge" &&
        [...(record.sourcePrincipleIds ?? [])].sort().join("\0") ===
          sourcePrincipleIds.join("\0"),
    );
    if (existing !== undefined) {
      throw new Error("这组原则已经有一个待处理的合并草案。");
    }
    const sourceDecisionIds = normalizedSourceIds(input.sourceDecisionIds);
    const allowedEvidence = new Set([
      ...sources.flatMap((source) => source.sourceDecisionIds),
    ]);
    if (sourceDecisionIds.some((id) => !allowedEvidence.has(id))) {
      throw new Error("合并草案只能保留来源原则已有的复盘证据。");
    }
    const decisions = this.#index.findDecisions(sourceDecisionIds);
    if (decisions.length !== sourceDecisionIds.length) {
      throw new Error("部分合并证据已不存在，请刷新后重新选择。");
    }
    for (const decision of decisions) {
      if (
        decision.outcome === null ||
        reviewedVerdict(decision.outcomeVerdict) === null ||
        decision.outcomeReviewedAt === null
      ) {
        throw new Error("合并草案只能保留完成实际结果与复盘的证据。");
      }
    }
    const validated = methodologyDraftSchema.parse({
      title: input.title,
      principle: input.principle,
      appliesWhen: input.appliesWhen,
      caution: input.caution,
      evidenceSummary: input.evidenceSummary,
      confidence: "low",
    });
    const now = this.#now().toISOString();
    const token = this.#idFactory();
    const record: MethodologyRecord = {
      id: `principle-${token}`,
      createdAt: now,
      updatedAt: now,
      origin: "principle_merge",
      status: "candidate",
      confirmedAt: null,
      title: validated.title,
      principle: validated.principle,
      appliesWhen: validated.appliesWhen,
      caution: validated.caution,
      evidenceSummary: validated.evidenceSummary,
      sourceDecisionIds,
      sourcePrincipleIds,
      confidence: "low",
      generation: {
        requestId: `methodology-merge:${token}`,
        profileId: "manual-principle-merge",
        provider: "人工合并",
        model: "不调用模型",
      },
    };
    record.confidence = assessMethodologyQuality(
      record,
      [...records, record],
      decisions.map((decision) => ({
        id: decision.id,
        project: decision.project,
        sourceClient: decision.sourceClient,
        outcomeVerdict: reviewedVerdict(decision.outcomeVerdict),
      })),
      relations,
    ).recommendedConfidence;
    await this.#repository.save(record);
    return record;
  }

  async createRevisionDraft(
    id: string,
    input: MethodologyEvolutionInput,
  ): Promise<MethodologyRecord> {
    const current = await this.#require(id);
    if (current.status !== "accepted") {
      throw new Error("只有已采纳原则才能建立修订草案。");
    }
    const records = await this.#repository.list();
    const existing = records.find(
      (record) =>
        record.status === "candidate" &&
        record.origin === "principle_revision" &&
        record.sourcePrincipleIds?.[0] === current.id,
    );
    if (existing !== undefined) return existing;

    const sourceDecisionIds = normalizedSourceIds(input.sourceDecisionIds);
    const decisions = this.#validateRevisionEvidence(
      current,
      sourceDecisionIds,
    );
    const validated = methodologyDraftSchema.parse({
      title: input.title,
      principle: input.principle,
      appliesWhen: input.appliesWhen,
      caution: input.caution,
      evidenceSummary: input.evidenceSummary,
      confidence: "low",
    });
    const now = this.#now().toISOString();
    const token = this.#idFactory();
    const record: MethodologyRecord = {
      id: `principle-${token}`,
      createdAt: now,
      updatedAt: now,
      origin: "principle_revision",
      status: "candidate",
      confirmedAt: null,
      title: validated.title,
      principle: validated.principle,
      appliesWhen: validated.appliesWhen,
      caution: validated.caution,
      evidenceSummary: validated.evidenceSummary,
      sourceDecisionIds,
      sourcePrincipleIds: [current.id],
      confidence: "low",
      generation: {
        requestId: `methodology-revision:${token}`,
        profileId: "manual-principle-revision",
        provider: "人工修订",
        model: "不调用模型",
      },
    };
    const relations = await this.#relationRepository.list();
    record.confidence = assessMethodologyQuality(
      record,
      [...records, record],
      decisions.map((decision) => ({
        id: decision.id,
        project: decision.project,
        sourceClient: decision.sourceClient,
        outcomeVerdict: reviewedVerdict(decision.outcomeVerdict),
      })),
      relations,
    ).recommendedConfidence;
    await this.#repository.save(record);
    return record;
  }

  async generate(sourceDecisionIds: string[]): Promise<MethodologyRecord> {
    const ids = normalizedSourceIds(sourceDecisionIds);
    const records = await this.#repository.list();
    const existing = records.find(
      (record) =>
        record.status !== "dismissed" &&
        sameSources(record.sourceDecisionIds, ids),
    );
    if (existing !== undefined) {
      return existing;
    }
    const decisions = this.#index.findDecisions(ids);
    if (decisions.length !== ids.length) {
      throw new Error("部分来源决策已不存在，请刷新后重新选择。");
    }
    for (const decision of decisions) {
      if (
        decision.outcome === null ||
        reviewedVerdict(decision.outcomeVerdict) === null ||
        decision.outcomeReviewedAt === null
      ) {
        throw new Error("只有完成实际结果与复盘的决策才能作为方法论证据。");
      }
    }

    const requestId = `methodology:${this.#idFactory()}`;
    const result = await this.#gateway
      .generate(
        {
          requestId,
          purpose: "methodology-extraction",
          promptVersion: METHODOLOGY_PROMPT_VERSION,
          schemaVersion: METHODOLOGY_SCHEMA_VERSION,
          locale: "zh-CN",
          systemPrompt: methodologySystemPrompt,
          userPrompt: `请基于以下已复盘决策证据提炼一个候选原则：\n${JSON.stringify(
            buildEvidence(decisions),
            null,
            2,
          )}`,
          outputSchema: methodologyOutputJsonSchema,
          maxOutputTokens: 768,
        },
        (value) => methodologyDraftSchema.parse(value),
      )
      .catch((error: unknown) => {
        if (error instanceof ProfiledModelGatewayError) {
          throw new Error(
            "当前没有可用于方法论提炼的模型，请先在“模型”中启用并确认 Qwen、API 或终端模型可用。",
            { cause: error },
          );
        }
        throw error;
      });
    const now = this.#now().toISOString();
    const draft = result.parsedOutput;
    const record: MethodologyRecord = {
      id: `principle-${this.#idFactory()}`,
      createdAt: now,
      updatedAt: now,
      origin: "decision_evidence",
      status: "candidate",
      confirmedAt: null,
      title: draft.title,
      principle: draft.principle,
      appliesWhen: draft.appliesWhen,
      caution: draft.caution,
      evidenceSummary: draft.evidenceSummary,
      sourceDecisionIds: ids,
      confidence: draft.confidence,
      generation: {
        requestId: result.requestId,
        profileId: result.profileId,
        provider: result.provider,
        model: result.model,
      },
    };
    record.confidence = assessMethodologyQuality(
      record,
      [...records, record],
      decisions.map((decision) => ({
        id: decision.id,
        project: decision.project,
        sourceClient: decision.sourceClient,
        outcomeVerdict: reviewedVerdict(decision.outcomeVerdict),
      })),
    ).recommendedConfidence;
    await this.#repository.save(record);
    return record;
  }

  async createManual(
    input: MethodologyManualInput,
  ): Promise<MethodologyRecord> {
    const draft = methodologyDraftSchema.parse({
      ...input,
      evidenceSummary: "人工录入，尚未关联经过结果复盘的决策证据。",
      confidence: "low",
    });
    const records = await this.#repository.list();
    const duplicate = records.find(
      (record) =>
        record.status !== "dismissed" &&
        importFingerprint(record) === importFingerprint(draft),
    );
    if (duplicate !== undefined) {
      throw new Error(
        `已经存在内容相同的原则“${duplicate.title}”，请直接打开审核。`,
      );
    }
    const now = this.#now().toISOString();
    const token = this.#idFactory();
    const record: MethodologyRecord = {
      id: `principle-${token}`,
      createdAt: now,
      updatedAt: now,
      origin: "manual_entry",
      status: "candidate",
      confirmedAt: null,
      title: draft.title,
      principle: draft.principle,
      appliesWhen: draft.appliesWhen,
      caution: draft.caution,
      evidenceSummary: draft.evidenceSummary,
      sourceDecisionIds: [],
      confidence: "low",
      generation: {
        requestId: `methodology-manual:${token}`,
        profileId: "manual-methodology-entry",
        provider: "人工录入",
        model: "不调用模型",
      },
    };
    record.confidence = assessMethodologyQuality(
      record,
      [...records, record],
      [],
    ).recommendedConfidence;
    await this.#repository.save(record);
    return record;
  }

  async createManualFromEvidence(
    input: MethodologyEvidenceManualInput,
  ): Promise<MethodologyRecord> {
    const ids = normalizedSourceIds(input.sourceDecisionIds);
    const decisions = this.#index.findDecisions(ids);
    if (decisions.length !== ids.length) {
      throw new Error("部分来源决策已不存在，请刷新后重新选择。");
    }
    for (const decision of decisions) {
      if (
        decision.outcome === null ||
        reviewedVerdict(decision.outcomeVerdict) === null ||
        decision.outcomeReviewedAt === null
      ) {
        throw new Error("只有完成实际结果与复盘的决策才能作为方法论证据。");
      }
    }
    const { sourceDecisionIds: _sourceDecisionIds, ...manualDraft } = input;
    const draft = methodologyDraftSchema.parse({
      ...manualDraft,
      confidence: "low",
    });
    const records = await this.#repository.list();
    const existingSources = records.find(
      (record) =>
        record.status !== "dismissed" &&
        sameSources(record.sourceDecisionIds, ids),
    );
    if (existingSources !== undefined) {
      throw new Error(
        `这组复盘证据已经用于候选“${existingSources.title}”，请直接打开审核。`,
      );
    }
    const duplicate = records.find(
      (record) =>
        record.status !== "dismissed" &&
        importFingerprint(record) === importFingerprint(draft),
    );
    if (duplicate !== undefined) {
      throw new Error(
        `已经存在内容相同的原则“${duplicate.title}”，请直接打开审核并关联证据。`,
      );
    }
    const now = this.#now().toISOString();
    const token = this.#idFactory();
    const record: MethodologyRecord = {
      id: `principle-${token}`,
      createdAt: now,
      updatedAt: now,
      origin: "manual_entry",
      status: "candidate",
      confirmedAt: null,
      title: draft.title,
      principle: draft.principle,
      appliesWhen: draft.appliesWhen,
      caution: draft.caution,
      evidenceSummary: draft.evidenceSummary,
      sourceDecisionIds: ids,
      confidence: "low",
      generation: {
        requestId: `methodology-manual-evidence:${token}`,
        profileId: "manual-evidence-methodology",
        provider: "人工整理",
        model: "不调用模型",
      },
    };
    record.confidence = assessMethodologyQuality(
      record,
      [...records, record],
      decisions.map((decision) => ({
        id: decision.id,
        project: decision.project,
        sourceClient: decision.sourceClient,
        outcomeVerdict: reviewedVerdict(decision.outcomeVerdict),
      })),
    ).recommendedConfidence;
    await this.#repository.save(record);
    return record;
  }

  async importMarkdown(
    sources: MethodologyMarkdownSource[],
  ): Promise<MethodologyImportResult> {
    const plan = await this.previewMarkdown(sources);
    if (plan.candidates.length === 0) {
      return {
        imported: [],
        duplicates: plan.duplicates,
        failures: plan.failures,
      };
    }
    const imported = await this.importMarkdownCandidates(
      plan.candidates,
      plan.candidates.map((candidate) => candidate.id),
    );
    return {
      imported: imported.imported,
      duplicates: [...plan.duplicates, ...imported.duplicates],
      failures: [...plan.failures, ...imported.failures],
    };
  }

  async previewMarkdown(
    sources: MethodologyMarkdownSource[],
  ): Promise<MethodologyImportPlan> {
    if (sources.length === 0 || sources.length > 20) {
      throw new Error("请选择 1 至 20 个 Markdown 文件。");
    }
    const records = await this.#repository.list();
    const result: MethodologyImportPlan = {
      candidates: [],
      duplicates: [],
      failures: [],
    };
    const activeRecords = records.filter(
      (record) => record.status !== "dismissed",
    );
    const knownFingerprints = new Map<string, { title: string }>(
      activeRecords.map((record) => [
        importFingerprint(record),
        { title: record.title },
      ]),
    );
    const knownPrinciples = new Map<
      string,
      { title: string; status: MethodologyStatus | "selection" }
    >(
      activeRecords.map((record) => [
        principleFingerprint(record),
        { title: record.title, status: record.status },
      ]),
    );
    for (const source of sources) {
      const candidateStart = result.candidates.length;
      const duplicateStart = result.duplicates.length;
      try {
        const drafts = parseMethodologyMarkdownDrafts(source);
        const contentSha256 = createHash("sha256")
          .update(source.markdown, "utf8")
          .digest("hex");
        for (const [index, draft] of drafts.entries()) {
          const fingerprint = importFingerprint(draft);
          const duplicate = knownFingerprints.get(fingerprint);
          if (duplicate !== undefined) {
            result.duplicates.push({
              fileName: source.fileName,
              title: draft.title,
              existingTitle: duplicate.title,
            });
            continue;
          }
          if (result.candidates.length >= MAX_IMPORTED_CANDIDATES) {
            throw new Error(
              `一次最多预检 ${MAX_IMPORTED_CANDIDATES} 条原则候选，请缩小文件范围。`,
            );
          }
          const similarTo =
            knownPrinciples.get(principleFingerprint(draft)) ?? null;
          const candidate: MethodologyImportCandidate = {
            ...draft,
            id: `methodology-import-preview-${createHash("sha256")
              .update(`${contentSha256}\0${index}\0${fingerprint}`, "utf8")
              .digest("hex")
              .slice(0, 24)}`,
            fileName: source.fileName,
            contentSha256,
            missingFields: [
              ...(draft.appliesWhen.startsWith("待补充：")
                ? (["appliesWhen"] as const)
                : []),
              ...(draft.caution.startsWith("待补充：")
                ? (["caution"] as const)
                : []),
            ],
            similarTo,
          };
          result.candidates.push(candidate);
          knownFingerprints.set(fingerprint, { title: candidate.title });
          if (!knownPrinciples.has(principleFingerprint(candidate))) {
            knownPrinciples.set(principleFingerprint(candidate), {
              title: candidate.title,
              status: "selection",
            });
          }
        }
      } catch (error) {
        result.candidates.splice(candidateStart);
        result.duplicates.splice(duplicateStart);
        knownFingerprints.clear();
        knownPrinciples.clear();
        for (const record of activeRecords) {
          knownFingerprints.set(importFingerprint(record), {
            title: record.title,
          });
          knownPrinciples.set(principleFingerprint(record), {
            title: record.title,
            status: record.status,
          });
        }
        for (const candidate of result.candidates) {
          knownFingerprints.set(importFingerprint(candidate), {
            title: candidate.title,
          });
          if (!knownPrinciples.has(principleFingerprint(candidate))) {
            knownPrinciples.set(principleFingerprint(candidate), {
              title: candidate.title,
              status: "selection",
            });
          }
        }
        result.failures.push({
          fileName: source.fileName,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async importMarkdownCandidates(
    candidates: MethodologyImportCandidate[],
    selectedCandidateIds: string[],
  ): Promise<MethodologyImportResult> {
    const selectedIds = [...new Set(selectedCandidateIds)];
    if (
      selectedIds.length === 0 ||
      selectedIds.length > MAX_IMPORTED_CANDIDATES
    ) {
      throw new Error(`请选择 1 至 ${MAX_IMPORTED_CANDIDATES} 条候选。`);
    }
    const candidatesById = new Map(
      candidates.map((candidate) => [candidate.id, candidate]),
    );
    if (selectedIds.some((id) => !candidatesById.has(id))) {
      throw new Error("导入预检结果已经变化，请重新选择文件。");
    }
    const records = await this.#repository.list();
    const knownFingerprints = new Map(
      records
        .filter((record) => record.status !== "dismissed")
        .map((record) => [importFingerprint(record), record]),
    );
    const result: MethodologyImportResult = {
      imported: [],
      duplicates: [],
      failures: [],
    };
    for (const id of selectedIds) {
      const candidate = candidatesById.get(id)!;
      try {
        const fingerprint = importFingerprint(candidate);
        const duplicate = knownFingerprints.get(fingerprint);
        if (duplicate !== undefined) {
          result.duplicates.push({
            fileName: candidate.fileName,
            title: candidate.title,
            existingTitle: duplicate.title,
          });
          continue;
        }
        const now = this.#now().toISOString();
        const token = this.#idFactory();
        const record: MethodologyRecord = {
          id: `principle-${token}`,
          createdAt: now,
          updatedAt: now,
          origin: "markdown_import",
          status: "candidate",
          confirmedAt: null,
          title: candidate.title,
          principle: candidate.principle,
          appliesWhen: candidate.appliesWhen,
          caution: candidate.caution,
          evidenceSummary: candidate.evidenceSummary,
          sourceDecisionIds: candidate.sourceDecisionIds,
          importSource: {
            fileName: candidate.fileName,
            contentSha256: candidate.contentSha256,
          },
          confidence: "low",
          generation: {
            requestId: `methodology-import:${token}`,
            profileId: "local-markdown-import",
            provider: "本地导入",
            model: "Markdown",
          },
        };
        const decisions = this.#index.findDecisions(record.sourceDecisionIds);
        record.confidence = assessMethodologyQuality(
          record,
          [...records, record],
          decisions.map((decision) => ({
            id: decision.id,
            project: decision.project,
            sourceClient: decision.sourceClient,
            outcomeVerdict: reviewedVerdict(decision.outcomeVerdict),
          })),
        ).recommendedConfidence;
        await this.#repository.save(record);
        records.push(record);
        knownFingerprints.set(fingerprint, record);
        result.imported.push(record);
      } catch (error) {
        result.failures.push({
          fileName: candidate.fileName,
          title: candidate.title,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  async setEvidence(
    id: string,
    sourceDecisionIds: string[],
  ): Promise<MethodologyRecord> {
    const current = await this.#require(id);
    if (
      current.origin !== "markdown_import" &&
      current.origin !== "manual_entry"
    ) {
      throw new Error("只有 Markdown 导入或人工录入的原则可以调整关联证据。");
    }
    const ids = normalizedSourceIds(sourceDecisionIds);
    const decisions = this.#index.findDecisions(ids);
    if (decisions.length !== ids.length) {
      throw new Error("部分复盘证据已不存在，请刷新后重新选择。");
    }
    for (const decision of decisions) {
      if (
        decision.outcome === null ||
        reviewedVerdict(decision.outcomeVerdict) === null ||
        decision.outcomeReviewedAt === null
      ) {
        throw new Error("只有完成实际结果与复盘的决策才能关联为证据。");
      }
    }
    const records = await this.#repository.list();
    const updated: MethodologyRecord = {
      ...current,
      updatedAt: this.#now().toISOString(),
      sourceDecisionIds: ids,
      confidence: "low",
    };
    updated.confidence = assessMethodologyQuality(
      updated,
      records.map((record) => (record.id === updated.id ? updated : record)),
      decisions.map((decision) => ({
        id: decision.id,
        project: decision.project,
        sourceClient: decision.sourceClient,
        outcomeVerdict: reviewedVerdict(decision.outcomeVerdict),
      })),
    ).recommendedConfidence;
    await this.#repository.save(updated);
    return updated;
  }

  async revise(
    id: string,
    revision: MethodologyRevision,
  ): Promise<MethodologyRecord> {
    const current = await this.#require(id);
    if (current.status !== "candidate") {
      throw new Error("只有待确认候选可以直接编辑；已采纳原则请建立修订草案。");
    }
    const validated = methodologyDraftSchema.parse({
      ...revision,
      confidence: current.confidence,
    });
    const updated: MethodologyRecord = {
      ...current,
      updatedAt: this.#now().toISOString(),
      title: validated.title,
      principle: validated.principle,
      appliesWhen: validated.appliesWhen,
      caution: validated.caution,
      evidenceSummary: validated.evidenceSummary,
    };
    await this.#repository.save(updated);
    return updated;
  }

  async listHistory(id: string): Promise<MethodologyHistoryEntry[]> {
    await this.#require(id);
    return this.#history.list(id);
  }

  async restoreVersion(
    id: string,
    version: number,
  ): Promise<MethodologyRecord> {
    const current = await this.#require(id);
    if (current.status !== "accepted") {
      throw new Error("只有已采纳原则可以恢复旧版本。");
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("原则版本编号无效。");
    }
    const entry = await this.#history.find(id, version);
    if (entry === null) {
      throw new Error("原则历史版本不存在。");
    }
    const now = this.#now().toISOString();
    await this.#history.capture(current, "restore_checkpoint", now);
    const restored: MethodologyRecord = {
      ...entry.snapshot,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: now,
      status: "accepted",
      confirmedAt: current.confirmedAt,
    };
    if (current.usageValidation === undefined) {
      delete restored.usageValidation;
    } else {
      restored.usageValidation = current.usageValidation;
    }
    delete restored.retiredAt;
    delete restored.supersededById;
    await this.#repository.save(restored);
    return restored;
  }

  async acknowledgeUsageValidation(
    id: string,
    cursor: { reviewedAt: string; decisionId: string },
  ): Promise<MethodologyRecord> {
    const current = await this.#require(id);
    if (current.status !== "accepted") {
      throw new Error("只有已采纳原则可以确认采用后的复验结果。");
    }
    if (Number.isNaN(Date.parse(cursor.reviewedAt))) {
      throw new Error("复验游标时间无效。");
    }
    const decisionId = cursor.decisionId.trim();
    if (decisionId.length === 0 || decisionId.length > 200) {
      throw new Error("复验游标决策无效。");
    }
    const records = await this.#repository.list();
    const pendingRevision = records.find(
      (record) =>
        record.status === "candidate" &&
        record.origin === "principle_revision" &&
        record.sourcePrincipleIds?.[0] === current.id,
    );
    if (pendingRevision !== undefined) {
      throw new Error("这条原则已有待确认修订，请先处理修订草案。");
    }
    const decision = this.#index.findDecisions([decisionId])[0];
    if (
      decision === undefined ||
      !decision.appliedPrincipleIds.includes(current.id) ||
      decision.outcomeReviewedAt !== cursor.reviewedAt ||
      reviewedVerdict(decision.outcomeVerdict) === null ||
      current.sourceDecisionIds.includes(decision.id)
    ) {
      throw new Error("复验结果已经变化，请刷新后重新核对。");
    }
    const previous = current.usageValidation;
    if (
      previous !== undefined &&
      (cursor.reviewedAt < previous.reviewedAt ||
        (cursor.reviewedAt === previous.reviewedAt &&
          decisionId <= previous.decisionId))
    ) {
      return current;
    }
    const updated: MethodologyRecord = {
      ...current,
      usageValidation: {
        reviewedAt: cursor.reviewedAt,
        decisionId,
        validatedAt: this.#now().toISOString(),
      },
    };
    await this.#repository.save(updated);
    return updated;
  }

  async setStatus(
    id: string,
    status: Extract<MethodologyStatus, "accepted" | "dismissed">,
    options: MethodologyStatusOptions = {},
  ): Promise<MethodologyRecord> {
    const current = await this.#require(id);
    const now = this.#now().toISOString();
    const records = await this.#repository.list();
    const decisions = this.#index.findDecisions(current.sourceDecisionIds);
    const relations = await this.#relationRepository.list();
    const quality = assessMethodologyQuality(
      current,
      records,
      decisions.map((decision) => ({
        id: decision.id,
        project: decision.project,
        sourceClient: decision.sourceClient,
        outcomeVerdict: reviewedVerdict(decision.outcomeVerdict),
      })),
      relations,
    );
    if (status === "accepted" && current.origin === "principle_merge") {
      const sourcePrincipleIds = current.sourcePrincipleIds ?? [];
      const sources = sourcePrincipleIds.map((sourceId) =>
        records.find((record) => record.id === sourceId),
      );
      const duplicateCoverage = assessMethodologyDuplicateGroup(
        sourcePrincipleIds,
        relations,
      );
      if (
        sourcePrincipleIds.length < 2 ||
        sourcePrincipleIds.length > 5 ||
        sources.some((source) => source?.status !== "accepted") ||
        !duplicateCoverage.complete
      ) {
        throw new Error(
          "合并来源已变化；请确认全部来源原则仍为已采纳，且每一对都保持人工重复结论。",
        );
      }
    }
    if (
      status === "accepted" &&
      current.origin === "markdown_import" &&
      [current.appliesWhen, current.caution].some((value) =>
        value.startsWith("待补充："),
      )
    ) {
      throw new Error("请先补充导入候选的适用条件与注意事项，再确认采纳。");
    }
    if (status === "accepted" && quality.missingEvidenceCount > 0) {
      throw new Error(
        "候选原则的来源证据不完整，不能采纳；请恢复证据或重新生成。",
      );
    }
    if (
      status === "accepted" &&
      quality.evidenceCount === 0 &&
      options.acknowledgeQualityRisks !== true
    ) {
      throw new Error(
        "候选尚未关联经过复盘的决策证据，请先核对内容并明确确认。",
      );
    }
    if (
      status === "accepted" &&
      quality.relations.some(
        (relation) => relation.resolution !== "unrelated",
      ) &&
      options.acknowledgeQualityRisks !== true
    ) {
      throw new Error(
        "该候选存在相近原则或潜在冲突，请先核对质量检查并明确确认。",
      );
    }
    if (
      status === "accepted" &&
      current.origin === "principle_revision" &&
      options.acknowledgeQualityRisks !== true
    ) {
      throw new Error("应用修订会替换正式原则内容，请核对差异并明确确认。");
    }
    if (status === "accepted" && current.origin === "principle_revision") {
      const sourceId = current.sourcePrincipleIds?.[0];
      if (sourceId === undefined) {
        throw new Error("修订草案缺少原原则，不能应用。");
      }
      const target = await this.#require(sourceId);
      if (target.status !== "accepted") {
        throw new Error("原原则已不存在或不再处于已采纳状态，不能应用修订。");
      }
      if (target.generation.requestId === current.generation.requestId) {
        await this.#repository.save({
          ...current,
          status: "dismissed",
          confirmedAt: null,
          updatedAt: now,
          appliedAt: now,
          appliedToId: target.id,
        });
        return target;
      }
      this.#validateRevisionEvidence(target, current.sourceDecisionIds);
      await this.#history.capture(target, "revision_applied", now);
      const updatedTarget: MethodologyRecord = {
        ...target,
        updatedAt: now,
        title: current.title,
        principle: current.principle,
        appliesWhen: current.appliesWhen,
        caution: current.caution,
        evidenceSummary: current.evidenceSummary,
        sourceDecisionIds: current.sourceDecisionIds,
        confidence: quality.recommendedConfidence,
        generation: current.generation,
      };
      await this.#repository.save(updatedTarget);
      await this.#repository.save({
        ...current,
        status: "dismissed",
        confirmedAt: null,
        updatedAt: now,
        appliedAt: now,
        appliedToId: target.id,
      });
      return updatedTarget;
    }

    const updated: MethodologyRecord = {
      ...current,
      status,
      updatedAt: now,
      confirmedAt: status === "accepted" ? now : null,
      confidence:
        status === "accepted"
          ? quality.recommendedConfidence
          : current.confidence,
    };
    await this.#repository.save(updated);
    return updated;
  }

  #validateRevisionEvidence(
    target: MethodologyRecord,
    sourceDecisionIds: string[],
  ): IndexedDecision[] {
    const decisions = this.#index.findDecisions(sourceDecisionIds);
    if (decisions.length !== sourceDecisionIds.length) {
      throw new Error("部分修订证据已不存在，请刷新后重新选择。");
    }
    const existingEvidence = new Set(target.sourceDecisionIds);
    let newReviewedUsage = 0;
    for (const decision of decisions) {
      if (
        decision.outcome === null ||
        reviewedVerdict(decision.outcomeVerdict) === null ||
        decision.outcomeReviewedAt === null
      ) {
        throw new Error("修订草案只能使用完成实际结果与复盘的决策证据。");
      }
      const isNewUsage =
        !existingEvidence.has(decision.id) &&
        decision.appliedPrincipleIds.includes(target.id);
      if (!existingEvidence.has(decision.id) && !isNewUsage) {
        throw new Error("新增修订证据必须明确记录采用了这条原则。");
      }
      if (isNewUsage) newReviewedUsage += 1;
    }
    if (newReviewedUsage === 0) {
      throw new Error("请至少选择一条采用该原则后完成的新复盘。");
    }
    return decisions;
  }

  async #require(id: string): Promise<MethodologyRecord> {
    const normalized = id.trim();
    if (normalized.length === 0 || normalized.length > 200) {
      throw new Error("方法论记录编号无效。");
    }
    const record = await this.#repository.find(normalized);
    if (record === null) {
      throw new Error("方法论记录不存在。");
    }
    return record;
  }
}
