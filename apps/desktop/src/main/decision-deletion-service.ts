import type { DecisionRecord, MethodologyRecord } from "@cognelis/decision-core";
import type { CaptureMode } from "@cognelis/decision-protocol";
import { parseDecision, type MarkdownRepository, type DecisionStore, type LocalDecisionStore, type DecisionRelationRepository } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import { decisionDeletionTargetSchema, decisionDeletionRequestSchema, decisionDeletionPreviewSchema, type DecisionDeletionTarget, type DecisionDeletionRequest, type DecisionDeletionPreview, type DecisionDeletionResult } from "../shared/decision-deletion.js";
import type { MisrecognitionReceiptStore } from "./misrecognition-receipts.js";

const LABEL = /^[a-z0-9_]{1,64}$/u, VERSION = /^[a-z0-9.+-]{1,64}$/u;
/** Labels and counts only: a signal or version that is not one of the rules' own identifiers is left out, not copied. */
const receiptOf = (record: DecisionRecord & { captureMode: CaptureMode }) => ({
  version: 1 as const,
  captureMode: record.captureMode,
  detectorVersion: record.detection !== null && VERSION.test(record.detection.detectorVersion) ? record.detection.detectorVersion : null,
  band: record.detection?.band ?? null,
  score: record.detection?.score ?? null,
  signals: [...new Set(record.detection?.signals ?? [])].filter(signal => LABEL.test(signal)).slice(0, 32),
  sourceClient: record.sourceClient,
  optionCount: record.options.length,
  capturedAt: record.created,
});

export class DecisionDeletionService {
  constructor(private readonly options: {
    repository: Pick<MarkdownRepository, "findDecision">;
    store: Pick<DecisionStore, "trashDecision">;
    local: Pick<LocalDecisionStore, "content" | "discard">;
    methodologies(): Promise<Array<Pick<MethodologyRecord, "sourceDecisionIds">>>;
    relations: Pick<DecisionRelationRepository, "scan">;
    trashItem(path: string): Promise<void>;
    removeVector(id: string): Promise<void>;
    /**
     * A decision put off for its rationale that the capture runtime still holds (its spool event and disposition):
     * left there, the home page and the tray kept counting it, completing it wrote the note back, and a restart put it
     * on the list again. It is discarded there first, as 不保留 does.
     */
    deferred?: { holds(id: string): boolean; discard(id: string): Promise<void> };
    onDeleted?(warnings: string[]): void;
    misrecognitions?: Pick<MisrecognitionReceiptStore, "record">;
    /** Other records of the same capture still kept (vault and local): a batch of one has nothing to say 只删这一条 about. */
    batchSiblings?(batchId: string, id: string): number;
    /** 整理与记忆: what deleting a vault decision forgets with it, previewed and then done as previewed (IMP-191). */
    organization?: {
      previewForget(input: { key: string }, options?: { preserveChoices: boolean }): Promise<{ experiences: Array<{ id: string; title: string }>; suggestions: number; modelCalls: number; complete: boolean; previewHash: string }>;
      forget(input: { key: string; confirm: true; expectedPreviewHash: string }, options?: { preserveChoices: boolean }): Promise<{ status: string; failed: string[] }>;
    };
  }) {}

  async #organizationPreview(target: DecisionDeletionTarget) {
    if (target.storage !== "vault" || this.options.organization === undefined) return undefined;
    const preview = await this.options.organization.previewForget({ key: `decision:${target.id}` }, { preserveChoices: true });
    if (preview.complete && preview.experiences.length === 0 && preview.suggestions === 0 && preview.modelCalls === 0) return undefined;
    return {
      experiences: preview.experiences.map((item) => ({ id: item.id, title: item.title.slice(0, 500) })),
      suggestions: preview.suggestions, modelCalls: preview.modelCalls, complete: preview.complete, previewHash: preview.previewHash,
    };
  }

  async #record(target: DecisionDeletionTarget): Promise<DecisionRecord | null> {
    if (target.storage === "vault") return (await this.options.repository.findDecision(target.id))?.record ?? null;
    const content = this.options.local.content(target.id);
    return content === null ? null : parseDecision(content);
  }

  async preview(input: DecisionDeletionTarget): Promise<DecisionDeletionPreview> {
    const target = decisionDeletionTargetSchema.parse(input);
    const note = target.storage === "vault" ? await this.options.repository.findDecision(target.id) : null;
    const content = target.storage === "local" ? this.options.local.content(target.id) : null;
    const record = note?.record ?? (content === null ? null : parseDecision(content));
    if (record === null) throw new Error("这条决策已删除或暂时无法读取，请刷新后重试。");
    const [principles, relations] = await Promise.all([this.options.methodologies(), this.options.relations.scan()]);
    if (relations.unavailable) throw new Error("暂时无法完整读取决策关系，请修复后再确认删除。");
    return decisionDeletionPreviewSchema.parse({ ...target, question: record.question,
      contentHash: note?.contentHash ?? createHash("sha256").update(content!).digest("hex"),
      evidencePrinciples: principles.filter(principle => principle.sourceDecisionIds.includes(target.id)).length,
      adoptedPrinciples: new Set(record.appliedPrincipleIds).size,
      relations: [...relations.records.values()].filter(relation => [relation.first, relation.second].some(reference => reference.source === "decisions" && reference.recordId === target.id)).length,
      batchId: record.batchId !== null && (this.options.batchSiblings?.(record.batchId, target.id) ?? 1) > 0 ? record.batchId : null,
      captured: record.captureMode !== null,
      deferredHeld: target.storage === "vault" && (this.options.deferred?.holds(target.id) ?? false),
      selectedAnswer: record.selectedAnswer.values.join("、"),
      project: record.project,
      ...await this.#organizationPreview(target).then((organization) => organization === undefined ? {} : { organization }),
    });
  }

  async delete(input: DecisionDeletionRequest): Promise<DecisionDeletionResult> {
    const request = decisionDeletionRequestSchema.parse(input);
    const warnings: string[] = [];
    let receipt: ReturnType<typeof receiptOf> | null = null;
    if (request.misrecognized === true) {
      const record = await this.#record(request);
      if (record === null) throw new Error("这条决策已删除或暂时无法读取，请刷新后重试。");
      const { captureMode } = record;
      if (captureMode === null) throw new Error("这条决策不是从对话里识别的，不能标为识别错误。");
      receipt = receiptOf({ ...record, captureMode });
    }
    if (request.storage === "local") this.options.local.discard(request.id, request.expectedContentHash);
    else {
      if (this.options.deferred?.holds(request.id)) {
        // Checked before the runtime lets go of it: a note changed elsewhere stays, and so does its place in the queue.
        const note = await this.options.repository.findDecision(request.id);
        if (note !== null && note.contentHash !== request.expectedContentHash) throw new Error("这条决策在别处已有改动，请重新读取后再确认删除。");
        // Its own errors (a rationale written to Obsidian whose receipt is not yet updated) are the reader's to see.
        await this.options.deferred.discard(request.id);
      }
      // What it takes with it in 整理与记忆, as the reader saw it, before the note goes: forgotten first, so a decision
      // still there is never one whose experiences went without it being said.
      const organization = await this.#organizationPreview(request);
      if (organization !== undefined) {
        if (!organization.complete) throw new Error("整理记录或经验笔记暂时没能完整读取，无法确认会联动删除什么，请稍后重试。");
        if (request.expectedOrganizationPreviewHash !== organization.previewHash) throw new Error("删除会联动整理与记忆里的内容，且它们在确认之后有变化；请重新打开删除确认核对后再删。");
        const note = await this.options.repository.findDecision(request.id);
        if (note !== null && note.contentHash !== request.expectedContentHash) throw new Error("这条决策在别处已有改动，请重新读取后再确认删除。");
        const forgotten = await this.options.organization!.forget({ key: `decision:${request.id}`, confirm: true, expectedPreviewHash: organization.previewHash }, { preserveChoices: true });
        if (forgotten.status !== "done") throw new Error(`整理与记忆里的联动内容没能全部删除（${forgotten.failed.join("；") || forgotten.status}），决策保留未删。`);
      }
      const result = await this.options.store.trashDecision(request.id, request.expectedContentHash, this.options.trashItem);
      if (!result.indexed) warnings.push("决策已移到废纸篓，但索引更新失败，请重建索引。");
      try { await this.options.removeVector(request.id); }
      catch { warnings.push("决策已移到废纸篓，但语义索引清理失败，请重建索引。"); }
    }
    if (receipt !== null) {
      try {
        if (!this.options.misrecognitions) throw new Error("no receipt store");
        await this.options.misrecognitions.record(receipt);
      } catch { warnings.push("决策已删除，但识别错误回执没能保存。"); }
    }
    try { this.options.onDeleted?.(warnings); }
    catch { warnings.push("决策已删除，但界面刷新失败，请重新打开后核对。"); }
    return { deleted: true, warnings };
  }
}
