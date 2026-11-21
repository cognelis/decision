import {
  DECISION_ONLY_FIELDS,
  amendableSourceSchema,
  amendmentFieldsSchema,
  DECISION_AMENDMENT_VERSION,
  type AmendmentFields,
  type DecisionAmendmentRequest,
  type DecisionAmendmentResult,
} from "@cognelis/decision-protocol";
import { z } from "zod";
import { MarkdownFactStore } from "./markdown-fact-store.js";

const text = (max: number) => z.string().min(1).max(max);
const action = z.enum(["append", "revise", "withdraw", "restore"]);
const storedSchema = z.object({
  amendVersion: z.literal(DECISION_AMENDMENT_VERSION),
  source: amendableSourceSchema,
  recordId: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  /** Texts added, oldest first. Never edited: an addition is withdrawn by a later one saying so. */
  amendments: z.array(z.object({
    n: z.number().int().positive(), at: z.string().datetime(), client: text(100), text: text(4_000),
    basis: z.enum(["user_said", "user_confirmed"]), reason: text(1_000).nullable(),
  }).strict()).max(200),
  /** The rewrite in force; only while the original note still has the hash it was made against. */
  overrides: z.object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u), fields: amendmentFieldsSchema,
    at: z.string().datetime(), client: text(100), reason: text(2_000),
  }).strict().nullable(),
  withdrawn: z.object({ at: z.string().datetime(), client: text(100), reason: text(2_000) }).strict().nullable(),
  /** Every action, with the text a rewrite replaced: what was there before can always be found. */
  history: z.array(z.object({
    revision: z.number().int().positive(), at: z.string().datetime(), client: text(100), action,
    reason: text(2_000).nullable(), before: amendmentFieldsSchema.nullable(),
    replacedOverride: amendmentFieldsSchema.nullable().optional(),
    basis: z.enum(["user_said", "user_confirmed"]).nullable().optional(),
  }).strict()).max(60),
}).strict();
export type StoredAmendment = z.infer<typeof storedSchema>;

const identity = (source: string, id: string) => `${source}:${id}`;
export const amendmentKey = identity;
const MAX_AMENDMENTS = 200;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;

/** The record as it stands in its note, which a rewrite is made against and replaces nothing of. */
export interface AmendableRecord {
  contentHash: string;
  /** What a search shows of it now, the original or an earlier rewrite of it. */
  effective: { summary: string; appliesWhen: string | null; caution: string | null } & Partial<Record<"question" | "choice" | "rationale" | "context" | "expectedOutcome", string | null>>;
}

/**
 * Texts added to, rewrites of and withdrawals of a decision, summary, preference or idea, in a note of their own in the
 * vault beside the scope and relation notes (decision-amendments/): the original note is never written, so a summary
 * made again, or a preference edited in Obsidian, keeps them, and what a rewrite replaced stays in the history.
 */
export class DecisionAmendmentRepository {
  readonly #facts: MarkdownFactStore<StoredAmendment>;
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(vaultPath: string) {
    this.#facts = new MarkdownFactStore(vaultPath, "decision-amendments", {
      parse: (value) => storedSchema.parse(value), key: (record) => identity(record.source, record.recordId), heading: "决策增补与改写",
    });
  }

  scan() { return this.#facts.scan(); }
  relativePath(source: string, recordId: string): string { return this.#facts.relativePath(identity(source, recordId)); }

  /**
   * `current`: the note's hash as it is when the write's turn comes, asked inside the queue (behind a rebind or another
   * write): the one the caller read before may be the note as it was.
   */
  save(request: DecisionAmendmentRequest, record: AmendableRecord, now = new Date(), current?: () => Promise<string | null>): Promise<DecisionAmendmentResult> {
    const save = this.#writeTail.then(() => this.#save(request, record, now, current));
    this.#writeTail = save.catch(() => undefined);
    return save;
  }

  async #save(request: DecisionAmendmentRequest, record: AmendableRecord, now: Date, currentHash?: () => Promise<string | null>): Promise<DecisionAmendmentResult> {
    const scanned = await this.scan();
    const key = identity(request.source, request.recordId);
    const path = this.relativePath(request.source, request.recordId);
    const current = scanned.records.get(key);
    const revision = current?.revision ?? 0;
    const answer = (status: DecisionAmendmentResult["status"], at = revision): DecisionAmendmentResult =>
      ({ amendVersion: DECISION_AMENDMENT_VERSION, status, revision: at, relativePath: path, originalUnchanged: true });
    if (scanned.inDoubt(key)) return answer("source_unavailable");
    // A rewrite is made against the note as it is now: read again in the queue, a rebind or write ahead of this one
    // having moved it on, and a rewrite held at a hash the note no longer has is not written over.
    if (request.action === "revise" || request.action === "revert") {
      const now = currentHash === undefined ? record.contentHash : await currentHash().catch(() => null);
      if (now === null) return answer("source_unavailable");
      if (now !== record.contentHash) return answer("source_changed");
    }
    if (request.action === "revert") {
      const target = current?.history.find((item) => item.revision === request.toRevision && item.action === "revise" && item.before != null);
      if (target?.before == null) return answer("revision_unknown");
      return this.#save({
        amendVersion: request.amendVersion, source: request.source, recordId: request.recordId, sourceClient: request.sourceClient, action: "revise",
        ...(request.basis === undefined ? {} : { basis: request.basis }),
        expectedContentHash: request.expectedContentHash, expectedRevision: request.expectedRevision, fields: target.before, reason: request.reason,
      }, record, now, undefined);
    }
    const at = now.toISOString();
    const base = { amendVersion: DECISION_AMENDMENT_VERSION, source: request.source, recordId: request.recordId } as const;
    let next: StoredAmendment;

    if (request.action === "append") {
      // The very text sent again after a transport timeout: acknowledged, not added twice. Said again another day, it is
      // a new addition: the user is saying it again.
      if (current?.amendments.some((item) => item.text === request.text && now.getTime() - Date.parse(item.at) < DUPLICATE_WINDOW_MS)) return answer("unchanged");
      if ((current?.amendments.length ?? 0) >= MAX_AMENDMENTS) return answer("limit_reached");
      next = {
        ...base, revision: revision + 1, updatedAt: at,
        amendments: [...(current?.amendments ?? []), {
          n: Math.max(0, ...(current?.amendments.map((item) => item.n) ?? [])) + 1, at, client: request.sourceClient,
          text: request.text, basis: request.basis, reason: request.reason ?? null,
        }],
        overrides: current?.overrides ?? null, withdrawn: current?.withdrawn ?? null,
        history: [...(current?.history ?? []), { revision: revision + 1, at, client: request.sourceClient, action: "append", reason: request.reason ?? null, before: null, basis: request.basis }],
      };
    } else if (request.action === "revise") {
      // What the reader wrote at the time is a decision's alone.
      if (request.source !== "decisions" && DECISION_ONLY_FIELDS.some((name) => name in request.fields)) return answer("not_allowed");
      // A decision's summary is its choice: one field, and one path (basis, history), not two that could differ.
      if (request.source === "decisions" && "summary" in request.fields) return answer("not_allowed");
      if (record.contentHash !== request.expectedContentHash) return answer("source_changed");
      if (revision !== request.expectedRevision) return answer("revision_conflict");
      const changed = Object.keys(request.fields).filter((name) =>
        (request.fields as Record<string, unknown>)[name] !== (record.effective as Record<string, unknown>)[name]) as Array<keyof AmendmentFields>;
      if (changed.length === 0) return answer("unchanged");
      // What is replaced, as it showed: the original, or the rewrite before this one.
      const before = Object.fromEntries(changed.map((name) => [name, record.effective[name]])) as AmendmentFields;
      const held = current?.overrides?.contentHash === record.contentHash ? current.overrides.fields : {};
      // A rewrite made against an older original is replaced whole: the words the user approved stay in the history.
      const replacedOverride = current?.overrides != null && current.overrides.contentHash !== record.contentHash ? current.overrides.fields : null;
      next = {
        ...base, revision: revision + 1, updatedAt: at, amendments: current?.amendments ?? [],
        overrides: { contentHash: record.contentHash, fields: { ...held, ...request.fields }, at, client: request.sourceClient, reason: request.reason },
        withdrawn: current?.withdrawn ?? null,
        history: [...(current?.history ?? []), { revision: revision + 1, at, client: request.sourceClient, action: "revise", reason: request.reason, before, replacedOverride, basis: request.basis ?? null }],
      };
    } else {
      // withdraw and restore: a preference or idea only.
      if (request.source !== "preferences" && request.source !== "ideas") return answer("not_allowed");
      if (revision !== request.expectedRevision) return answer("revision_conflict");
      const withdrawing = request.action === "withdraw";
      if ((current?.withdrawn != null) === withdrawing) return answer("unchanged");
      next = {
        ...base, revision: revision + 1, updatedAt: at, amendments: current?.amendments ?? [], overrides: current?.overrides ?? null,
        withdrawn: withdrawing ? { at, client: request.sourceClient, reason: request.reason } : null,
        history: [...(current?.history ?? []), { revision: revision + 1, at, client: request.sourceClient, action: request.action, reason: request.reason, before: null, basis: request.basis ?? null }],
      };
    }
    // Over the note's budget, the records of an append or a withdrawal go first, oldest first; one that holds text a
    // rewrite replaced is never cut. When only those are left, nothing more is taken in.
    const droppable = () => next.history.findIndex((item) => item.before == null && item.replacedOverride == null);
    while (next.history.length > 60 || Buffer.byteLength(this.#facts.encode(next)) > MAX_BYTES) {
      const at = droppable();
      if (at < 0 || at === next.history.length - 1) return answer("limit_reached");
      next.history.splice(at, 1);
    }
    storedSchema.parse(next);
    const written = await this.#facts.replace(next, scanned.hashes.get(key) ?? null);
    return written === "saved" ? answer("saved", next.revision) : answer("revision_conflict");
  }

  /**
   * A decision's note was written by the App (an outcome, a review): its rewrite was made against the version before, and
   * goes on holding for this one (as DecisionScopeRepository.rebind): 1 when it is left stale, -1 when not known.
   */
  rebind(reference: { source: "decisions"; recordId: string }, from: string, to: string): Promise<number> {
    const rebind = this.#writeTail.then(async () => {
      const scanned = await this.scan();
      const key = identity(reference.source, reference.recordId);
      if (scanned.inDoubt(key)) return -1;
      const current = scanned.records.get(key);
      if (current?.overrides == null || current.overrides.contentHash === to) return 0;
      if (current.overrides.contentHash !== from) return 1;
      return (await this.#facts.replace({ ...current, overrides: { ...current.overrides, contentHash: to } }, scanned.hashes.get(key) ?? null)) === "saved" ? 0 : 1;
    });
    this.#writeTail = rebind.catch(() => undefined);
    return rebind;
  }

  /** The user asked for it again (a preference or idea recorded once more): its withdrawal ends, with a record of why. */
  async clearWithdrawal(source: "preferences" | "ideas", recordId: string, client: string): Promise<boolean> {
    const held = (await this.scan()).records.get(identity(source, recordId));
    if (held?.withdrawn == null) return false;
    const result = await this.save({
      amendVersion: DECISION_AMENDMENT_VERSION, source, recordId, sourceClient: client, action: "restore", basis: "user_said",
      expectedRevision: held.revision, reason: "同一条被再次记录，撤回随之解除",
    }, { contentHash: "0".repeat(64), effective: { summary: "", appliesWhen: null, caution: null } });
    return result.status === "saved";
  }
}
