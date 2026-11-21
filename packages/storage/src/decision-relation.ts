import { canonicalDecisionRelation, decisionRelationKey } from "@cognelis/decision-core";
import { decisionRelationRecordSchema, decisionRelationRevisionSchema, type DecisionRelationRecord, type DecisionRelationUpdate, type DecisionRelationUpdateResult } from "@cognelis/decision-protocol";
import { MarkdownFactStore } from "./markdown-fact-store.js";

export class DecisionRelationRepository {
  readonly #facts: MarkdownFactStore<DecisionRelationRecord>;
  #writeTail: Promise<unknown> = Promise.resolve();
  constructor(vaultPath: string) {
    this.#facts = new MarkdownFactStore<DecisionRelationRecord>(vaultPath, "decision-relations", {
      parse: (value) => canonicalDecisionRelation(decisionRelationRecordSchema.parse(value)),
      key: decisionRelationKey, heading: "决策关系",
    });
  }
  // A relation in doubt cannot be placed: its note is named for a pair, not for the decisions in it, so which
  // decisions it could make current or not is unknown. Any one makes them all unavailable, as scopes no longer do.
  async scan() {
    const read = await this.#facts.scan();
    return { ...read, unavailable: read.unavailable || read.doubted };
  }
  relativePath(record: DecisionRelationRecord): string { return this.#facts.relativePath(decisionRelationKey(record)); }
  save(input: DecisionRelationUpdate): Promise<DecisionRelationUpdateResult> {
    const save = this.#writeTail.then(() => this.#save(input));
    this.#writeTail = save.catch(() => undefined);
    return save;
  }
  /**
   * After the App's own review of a decision (its outcome, expectation, verdict or next date), the relations bound to
   * the version that write replaced, bound to the new one in place: no revision, no history (IMP-128). One bound to an
   * older version (an edit in Obsidian) stays stale. How many were left stale, -1 when they could not be read.
   */
  rebind(reference: { source: string; recordId: string }, from: string, to: string): Promise<number> {
    const rebind = this.#writeTail.then(() => this.#rebind(reference, from, to));
    this.#writeTail = rebind.catch(() => undefined);
    return rebind;
  }
  async #rebind(reference: { source: string; recordId: string }, from: string, to: string): Promise<number> {
    const scanned = await this.scan();
    if (scanned.unavailable) return -1;
    let stale = 0;
    for (const [key, record] of scanned.records) {
      const sides = (["first", "second"] as const).filter((side) => record[side].source === reference.source && record[side].recordId === reference.recordId);
      if (sides.length === 0 || record.disposition === "revoked") continue;
      if (sides.some((side) => record[side].contentHash === from)) {
        const next = { ...record, ...Object.fromEntries(sides.map((side) => [side, { ...record[side], contentHash: to }])) } as DecisionRelationRecord;
        if (await this.#facts.replace(next, scanned.hashes.get(key) ?? null) === "saved") continue;
      }
      if (sides.some((side) => record[side].contentHash !== to)) stale += 1;
    }
    return stale;
  }
  async #save(input: DecisionRelationUpdate): Promise<DecisionRelationUpdateResult> {
    const request = canonicalDecisionRelation(input);
    const scanned = await this.scan();
    const key = decisionRelationKey(request);
    if (scanned.unavailable) return { status: "source_unavailable", revision: 0, originalNotesUnchanged: true };
    const current = scanned.records.get(key);
    if ((current?.revision ?? 0) !== request.expectedRevision) return { status: "revision_conflict", revision: current?.revision ?? 0, originalNotesUnchanged: true };
    const next = decisionRelationRecordSchema.parse({
      relationVersion: 1, first: request.first, second: request.second,
      disposition: request.disposition, successor: request.successor, reason: request.reason,
      revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
      history: current === undefined ? [] : [...current.history, decisionRelationRevisionSchema.parse({
        first: current.first, second: current.second, disposition: current.disposition, successor: current.successor,
        reason: current.reason, revision: current.revision, updatedAt: current.updatedAt,
      })].slice(-20),
    });
    const result = await this.#facts.replace(next, scanned.hashes.get(key) ?? null);
    return { status: result === "saved" ? "saved" : "revision_conflict", revision: result === "saved" ? next.revision : current?.revision ?? 0, originalNotesUnchanged: true };
  }
}
