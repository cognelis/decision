import { z } from "zod";
import { decisionScopeSchema, type DecisionScopeUpdate, type DecisionScopeUpdateResult } from "@cognelis/decision-protocol";
import { MarkdownFactStore } from "./markdown-fact-store.js";

const revisionSchema = z.object({
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  scope: decisionScopeSchema,
  changeReason: z.string().trim().min(1).max(2_000),
}).strict();
const storedSchema = revisionSchema.extend({
  scopeVersion: z.literal(1),
  source: z.enum(["summarize", "decisions", "principles"]),
  recordId: z.string().trim().min(1).max(200),
  history: z.array(revisionSchema).max(20),
}).strict();
export type StoredDecisionScope = z.infer<typeof storedSchema>;
const identity = (source: string, id: string) => `${source}:${id}`;
export class DecisionScopeRepository {
  readonly #facts: MarkdownFactStore<StoredDecisionScope>;
  #writeTail: Promise<unknown> = Promise.resolve();
  constructor(vaultPath: string) {
    this.#facts = new MarkdownFactStore(vaultPath, "decision-scopes", {
      parse: (value) => storedSchema.parse(value), key: (record) => identity(record.source, record.recordId), heading: "决策适用范围",
    });
  }
  scan() { return this.#facts.scan(); }
  save(input: DecisionScopeUpdate): Promise<DecisionScopeUpdateResult> {
    const save = this.#writeTail.then(() => this.#save(input));
    this.#writeTail = save.catch(() => undefined);
    return save;
  }
  async #save(input: DecisionScopeUpdate): Promise<DecisionScopeUpdateResult> {
    const scanned = await this.scan();
    const key = identity(input.source, input.recordId);
    if (scanned.inDoubt(key)) return { status: "source_unavailable", revision: 0, originalNoteUnchanged: true };
    const current = scanned.records.get(key);
    // The very request just saved, sent again after a transport timeout (as feedback answers it): acknowledged,
    // not told of "a newer version" that is its own.
    if (current !== undefined && current.revision === input.expectedRevision + 1 && current.contentHash === input.expectedContentHash &&
      JSON.stringify(current.scope) === JSON.stringify(input.scope) && current.changeReason === input.changeReason) {
      return { status: "unchanged", revision: current.revision, originalNoteUnchanged: true };
    }
    if ((current?.revision ?? 0) !== input.expectedRevision) return { status: "revision_conflict", revision: current?.revision ?? 0, originalNoteUnchanged: true };
    const next = storedSchema.parse({
      scopeVersion: 1, source: input.source, recordId: input.recordId,
      revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
      contentHash: input.expectedContentHash, scope: input.scope, changeReason: input.changeReason,
      history: current === undefined ? [] : [...current.history, revisionSchema.parse({
        revision: current.revision, updatedAt: current.updatedAt, contentHash: current.contentHash, scope: current.scope, changeReason: current.changeReason,
      })].slice(-20),
    });
    while (Buffer.byteLength(this.#facts.encode(next)) > 512 * 1024 && next.history.length > 0) next.history.shift();
    const result = await this.#facts.replace(next, scanned.hashes.get(key) ?? null);
    return { status: result === "saved" ? "saved" : "revision_conflict", revision: result === "saved" ? next.revision : current?.revision ?? 0, originalNoteUnchanged: true };
  }
}
