import { decisionOutcomeUpdateSchema, type DecisionContextResult, type DecisionOutcomeUpdate, type DecisionOutcomeUpdateResult } from "@cognelis/decision-protocol";
import { DecisionLifecycleWriteError, type DecisionStore } from "@cognelis/decision-storage";
import { relative, sep } from "node:path";

/** Updates the existing Markdown lifecycle and its rebuildable index in one operation. */
export class DecisionOutcomeService {
  constructor(
    private readonly store: Pick<DecisionStore, "updateLifecycle">,
    private readonly vaultPath: string,
    private readonly onSaved: (indexed: boolean) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
    /** The decision as search_decision_context tells it, for where it stands; null when that cannot be read. */
    private readonly standing: (recordId: string) => Promise<Pick<DecisionContextResult, "lifecycleState" | "successors" | "warnings"> | null> = async () => null,
  ) {}

  async update(input: DecisionOutcomeUpdate): Promise<DecisionOutcomeUpdateResult> {
    const request = decisionOutcomeUpdateSchema.parse(input);
    // Read before the write moves the note's version, past which every relation bound to it reads stale.
    const standing = await this.standing(request.recordId).catch(() => null);
    let saved;
    try {
      saved = await this.store.updateLifecycle(request.recordId, {
        ...(request.outcome === undefined ? {} : { outcome: request.outcome }),
        ...(request.review === undefined ? {} : { review: request.review === null ? null : { ...request.review, reviewedAt: this.now().toISOString() } }),
        ...(request.reviewDueDate === undefined ? {} : { reviewDueDate: request.reviewDueDate }),
      }, request.expectedContentHash);
    } catch (error) {
      if (!(error instanceof DecisionLifecycleWriteError)) throw error;
      // Its own reason, when it gave one (a note grown past 8000 characters in Obsidian): told only the code, the
      // agent was sent to look for a note missing, copied or broken.
      const reason = error.message === new DecisionLifecycleWriteError(error.code).message ? [] : [error.message.slice(0, 500)];
      return { status: error.code, contentHash: null, relativePath: null, state: null, indexed: null, warnings: reason };
    }
    const changed = saved.note.contentHash !== request.expectedContentHash;
    const record = saved.note.record;
    const warnings: string[] = [];
    if (changed) warnings.push("笔记版本已改变；绑定旧版本的范围和人工关系需要重新核对，本次没有自动更新这些判断。");
    if (!saved.indexed) warnings.push("Markdown 已保存，但决策索引更新失败；请在设置中重建决策索引，勿重复回填。");
    // Said by search_decision_context and by nothing here: a result went onto a decision replaced since as onto one
    // that stands, and the agent built on it.
    if (standing?.lifecycleState === "superseded") {
      // A→B→C: B is no answer to what replaced A. Named as standing only while it does; where a chain ends is said
      // in search's own words.
      const chain = standing.warnings.filter((warning) => warning.includes("本身也已被替代"));
      const current = standing.successors
        .map((successor) => ({ successor, at: `${successor.source ?? "decisions"}/${successor.id}` }))
        .filter(({ at }) => !chain.some((warning) => warning.includes(`后继记录 ${at} 本身也已被替代`))).slice(0, 3)
        .map(({ successor, at }) => `${at}《${successor.title.slice(0, 40)}》`);
      warnings.push(`此记录已被替代${current.length === 0 ? "" : `，当前有效的是 ${current.join("、")}`}；${chain.join("")}结果已按用户要求回填，请核对后继记录后再据此判断。`);
    } else if (standing?.lifecycleState === "uncertain") {
      warnings.push("此记录的有效状态待核对（关系依据过期、来源不完整或替代链存在循环）；结果已回填，但不能当作已确认的当前规则。");
    }
    try { this.onSaved(saved.indexed); } catch { warnings.push("保存已完成，界面刷新失败；请重新打开记录核对。"); }
    return {
      status: changed ? "saved" : "unchanged", contentHash: saved.note.contentHash,
      relativePath: relative(this.vaultPath, saved.note.path).split(sep).join("/"),
      state: { expectedOutcome: record.expectedOutcome ?? null, outcome: record.outcome, review: record.outcomeReview, reviewDueDate: record.reviewDueDate },
      indexed: saved.indexed, warnings,
    };
  }
}
