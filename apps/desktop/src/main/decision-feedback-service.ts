import { decisionFeedbackUpdateSchema, decisionFeedbackRecordSchema, decisionFeedbackQuerySchema, decisionFeedbackResponseSchema, type DecisionFeedbackRecord, type DecisionFeedbackUpdate, type DecisionFeedbackUpdateResult, type DecisionFeedbackQuery, type DecisionFeedbackResponse } from "@cognelis/decision-protocol";
import { mayBeSetAside, type DecisionContextRepository, type createDecisionFeedbackStore } from "@cognelis/decision-storage";

const payload = (input: DecisionFeedbackUpdate | DecisionFeedbackRecord) => ({
  reference: input.reference, task: input.task, project: input.project, taskScope: input.taskScope,
  rating: input.rating, reason: input.reason, withdrawn: input.withdrawn,
});
export class DecisionFeedbackService {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly context: Pick<DecisionContextRepository, "scan">, private readonly store: ReturnType<typeof createDecisionFeedbackStore>, private readonly now: () => Date = () => new Date()) {}
  save(input: DecisionFeedbackUpdate): Promise<DecisionFeedbackUpdateResult> {
    const request = decisionFeedbackUpdateSchema.parse(input);
    const write = this.#tail.then(() => this.#save(request)); this.#tail = write.catch(() => undefined); return write;
  }
  async #save(request: DecisionFeedbackUpdate): Promise<DecisionFeedbackUpdateResult> {
    const feedback = await this.store.scan(); const current = feedback.records.get(request.feedbackId);
    const result = (status: DecisionFeedbackUpdateResult["status"], revision = current?.revision ?? 0): DecisionFeedbackUpdateResult => ({ status, feedbackId: request.feedbackId, revision, noDecisionChanged: true });
    if (feedback.inDoubt(request.feedbackId)) return result("feedback_unavailable");
    // Retry of the exact just-saved request is acknowledged without another revision,
    // even if the source has changed since the write completed.
    const fields = payload(request);
    if (current !== undefined && current.revision === request.expectedRevision + 1 && JSON.stringify(payload(current)) === JSON.stringify(fields)) return result("unchanged");
    if ((current?.revision ?? 0) !== request.expectedRevision) return result("revision_conflict");
    if (request.withdrawn) {
      if (current === undefined) return result("feedback_not_found");
      // Withdrawal cannot be used to replace the original task, target or rating.
      if (JSON.stringify(payload({ ...request, reason: current.reason, withdrawn: current.withdrawn })) !== JSON.stringify(payload(current))) return result("revision_conflict");
    } else {
      const snapshot = await this.context.scan(true);
      const source = snapshot.sources.find((source) => source.source === request.reference.source);
      const matches = snapshot.documents.filter((doc) => doc.source === request.reference.source && doc.id === request.reference.recordId);
      // Only a note set aside that could be this record stops it: one broken note elsewhere stopped every record's feedback.
      if (source === undefined || source.status === "unavailable" || mayBeSetAside(snapshot, request.reference.source, request.reference.recordId) || matches.length !== 1) return result("source_unavailable");
      if (matches[0]!.contentHash !== request.reference.expectedContentHash) return result("source_changed");
      if (current !== undefined && (current.reference.source !== request.reference.source || current.reference.recordId !== request.reference.recordId)) return result("revision_conflict");
    }
    const history = current === undefined ? [] : [...current.history, { reference: current.reference, task: current.task, project: current.project, taskScope: current.taskScope, rating: current.rating, reason: current.reason, withdrawn: current.withdrawn, revision: current.revision, updatedAt: current.updatedAt }].slice(-20);
    const next = decisionFeedbackRecordSchema.parse({ ...fields, feedbackVersion: 1, feedbackId: request.feedbackId, revision: (current?.revision ?? 0) + 1, updatedAt: this.now().toISOString(), history });
    while (Buffer.byteLength(this.store.encode(next)) > 512 * 1024 && next.history.length > 0) next.history.shift();
    const saved = await this.store.replace(next, feedback.hashes.get(request.feedbackId) ?? null);
    return result(saved === "saved" ? "saved" : "revision_conflict", saved === "saved" ? next.revision : current?.revision ?? 0);
  }
  async list(input: DecisionFeedbackQuery): Promise<DecisionFeedbackResponse> {
    const query = decisionFeedbackQuerySchema.parse(input);
    const [feedback, context] = await Promise.all([this.store.scan(), this.context.scan(true)]);
    const sourceStates = new Map(context.sources.map((source) => [source.source, source.status]));
    const docs = new Map(context.documents.map((doc) => [JSON.stringify([doc.source, doc.id]), doc]));
    const all = [...feedback.records.values()].filter((record) => (query.source === undefined || (record.reference.source === query.source && record.reference.recordId === query.recordId)) && (query.project === undefined || record.project === query.project));
    const state = (record: typeof all[number]): DecisionFeedbackResponse["results"][number]["sourceState"] => {
      const status = sourceStates.get(record.reference.source);
      if (status === "unavailable" || status === undefined || feedback.inDoubt(record.feedbackId) || mayBeSetAside(context, record.reference.source, record.reference.recordId)) return "unavailable";
      const doc = docs.get(JSON.stringify([record.reference.source, record.reference.recordId]));
      return doc === undefined ? "missing" : doc.contentHash === record.reference.expectedContentHash ? "current" : "changed";
    };
    const ratings = { helpful: 0, not_applicable: 0, insufficient_context: 0, irrelevant: 0 }; const currentSourceRatings = { ...ratings };
    for (const record of all) if (!record.withdrawn) { ratings[record.rating]++; if (state(record) === "current") currentSourceRatings[record.rating]++; }
    const filtered = all.filter((record) => query.includeWithdrawn || !record.withdrawn).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.feedbackId.localeCompare(b.feedbackId));
    // A note not read could be feedback on any record: it is named for the feedback, not for what it is about.
    const unavailable = feedback.unavailable || feedback.doubted || all.some((record) => state(record) === "unavailable");
    return decisionFeedbackResponseSchema.parse({ coverage: unavailable ? feedback.records.size > 0 ? "partial" : "unavailable" : "complete",
      results: filtered.slice(query.offset, query.offset + query.limit).map((record) => ({ record, sourceState: state(record), relativePath: this.store.relativePath(record.feedbackId) })),
      total: filtered.length, nextOffset: query.offset + query.limit < filtered.length ? query.offset + query.limit : null,
      activeCount: all.filter((record) => !record.withdrawn).length, withdrawnCount: all.filter((record) => record.withdrawn).length,
      ratings, currentSourceRatings, guidance: "每份反馈按最新修订计数，撤回不参与评价汇总。全部有效反馈包含旧来源版本的使用观察；currentSourceRatings 只计当前可核对版本。数量不代表准确率或实际收益，不自动修改决策、范围、关系或排序。", noDecisionChanged: true });
  }
}
