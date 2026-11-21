import type { SelectedAnswer } from "@cognelis/decision-core";
import { foldedText, searchTokens, type DecisionContextRepository, type DecisionQuery, type SqliteIndex } from "@cognelis/decision-storage";

/** Index writes invalidate answers; concurrent readers share one scan, including while a write overtakes it. */
export class DecisionAnswerCache {
  #cached: { revision: number; answers: ReadonlyMap<string, SelectedAnswer> } | undefined;
  #pending: Promise<{ revision: number; answers: ReadonlyMap<string, SelectedAnswer>; cacheable: boolean }> | undefined;

  constructor(
    private readonly repository: Pick<DecisionContextRepository, "scan">,
    private readonly index: Pick<SqliteIndex, "revision">,
  ) {}

  async read(): Promise<ReadonlyMap<string, SelectedAnswer>> {
    for (;;) {
      const revision = this.index.revision();
      if (this.#cached?.revision === revision) return this.#cached.answers;
      this.#pending ??= this.repository.scan()
        .then(({ documents, sources }) => ({
          revision,
          answers: new Map(documents.flatMap((document) => document.source === "decisions" && document.answer !== undefined ? [[document.id, document.answer] as const] : [])),
          cacheable: sources.some((source) => source.source === "decisions" && source.status !== "unavailable"),
        }))
        .finally(() => { this.#pending = undefined; });
      const loaded = await this.#pending;
      // A scan begun before a watcher update may still hold the old note; finish it before scanning again.
      if (loaded.revision !== this.index.revision()) continue;
      if (loaded.cacheable) this.#cached = loaded;
      return loaded.answers;
    }
  }
}

/** Reply terms supplement the existing index from the cached note snapshot, including indexes written before reply. */
export const queryDecisionsWithReplies = (
  index: Pick<SqliteIndex, "queryDecisions">,
  query: DecisionQuery,
  answers: ReadonlyMap<string, SelectedAnswer>,
) => {
  const found = index.queryDecisions(query);
  const tokens = searchTokens(query.query ?? "");
  if (tokens.length === 0) return found;
  const ids = new Set(found.map((decision) => decision.id));
  // shortcut: checks each cached reply per keyword query; add an index only if reply volume makes this slow.
  for (const [id, answer] of answers) {
    if (ids.has(id) || (query.decisionId !== undefined && query.decisionId !== id) || answer.kind === "custom" || answer.reply === undefined) continue;
    const reply = foldedText(answer.reply);
    const remaining = tokens.filter((token) => !reply.includes(token));
    if (remaining.length === tokens.length) continue;
    // Keep every non-text filter, and let the existing index match terms outside the reply.
    found.push(...index.queryDecisions({ ...query, decisionId: id, query: remaining.join(" "), limit: 1 }));
  }
  return query.everything === true ? found : found.slice(0, Math.max(1, Math.min(200, Math.trunc(query.limit ?? 100))));
};
