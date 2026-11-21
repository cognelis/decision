import type { JournalEntry } from "@cognelis/decision-core";
import {
  clipText,
  DECISION_ONLY_FIELDS,
  decisionAmendmentRequestSchema,
  DECISION_AMENDMENT_VERSION,
  isSignalSource,
  type AmendmentFields,
  type AmendmentState,
  type DecisionAmendmentRequest,
  type DecisionAmendmentResult,
  type DecisionContextResult,
} from "@cognelis/decision-protocol";
import {
  amendmentKey,
  type AmendableRecord,
  type DecisionAmendmentRepository,
  type DecisionContextDocument,
  type DecisionContextSnapshot,
  type StoredAmendment,
} from "@cognelis/decision-storage";
import { createHash } from "node:crypto";

export interface AmendmentSnapshot {
  records: Map<string, StoredAmendment>;
  unavailable: boolean;
  inDoubt?(key: string): boolean;
}
export const amendmentUncertain = (scan: AmendmentSnapshot, key: string): boolean => scan.unavailable || scan.inDoubt?.(key) === true;

export interface AmendmentSource {
  scan(): Promise<AmendmentSnapshot>;
  relativePath(source: string, recordId: string): string;
}

/** What a preference or idea says, as one hash: the identity a rewrite is made against (its note's own text is not read here). */
export const journalContentHash = (entry: JournalEntry): string =>
  createHash("sha256").update(JSON.stringify([
    entry.kind, entry.title, entry.content, entry.context, entry.rationale, entry.tags, entry.project, entry.knowledgeStatus, entry.languages,
    entry.kind === "preference"
      ? [entry.appliesWhen, entry.exceptions, entry.strength, entry.evidenceMaturity]
      : [entry.ideaForm, entry.whyInteresting, entry.openQuestions, entry.nextTest],
  ]), "utf8").digest("hex");

/** The rewrite, while the original is as it was made against; a stale one is no longer applied. */
export const validOverrides = (record: StoredAmendment | undefined, contentHash: string | undefined): AmendmentFields | null =>
  record?.overrides != null && record.overrides.contentHash === contentHash ? record.overrides.fields : null;

/** The reader's words before a rewrite, in a line: the one field's text alone, several as 字段=文字. */
const quotedOriginals = (originals: AmendmentFields | undefined): string | null => {
  const entries = Object.entries(originals ?? {});
  return entries.length === 0 ? null : entries.length === 1 ? String(entries[0]![1] ?? "（空）") : entries.map(([name, value]) => `${name}=${value ?? "（空）"}`).join("；");
};
export const FIELD_ORDER = ["summary", "appliesWhen", "caution", "question", "choice", "rationale", "context", "expectedOutcome"] as const;
/** What each rewritten field said before it was first rewritten: the earliest `before` that names it. */
export const originalsOf = (record: StoredAmendment): AmendmentFields => {
  const originals: Record<string, unknown> = {};
  for (const item of record.history) {
    if (item.action !== "revise" || item.before == null) continue;
    for (const name of FIELD_ORDER) if (has(item.before, name) && !(name in originals)) originals[name] = item.before[name];
  }
  return originals as AmendmentFields;
};

const has = (fields: AmendmentFields, name: keyof AmendmentFields) => Object.prototype.hasOwnProperty.call(fields, name);

/** The words appended to a note's body for a search to find: the additions and the rewrite in force. */
export const amendedText = (record: StoredAmendment, contentHash: string | undefined): string => {
  const fields = validOverrides(record, contentHash);
  return [
    ...record.amendments.map((item) => `已被 ${item.client} 于 ${item.at.slice(0, 10)} 增补：${item.text}`),
    ...(fields === null ? [] : Object.values(fields).filter((value): value is string => typeof value === "string")),
  ].join("\n");
};

export const amendmentStateOf = (record: StoredAmendment, contentHash: string | undefined, relativePath: string, historyLimit = 10): AmendmentState => ({
  revision: record.revision,
  relativePath,
  amendments: record.amendments.map((item) => ({ n: item.n, at: item.at, client: item.client, text: item.text, basis: item.basis, reason: item.reason })),
  revised: record.overrides === null ? null : {
    fields: FIELD_ORDER.filter((name) => has(record.overrides!.fields, name)),
    values: record.overrides.fields,
    at: record.overrides.at, client: record.overrides.client, reason: record.overrides.reason,
    stale: record.overrides.contentHash !== contentHash,
  },
  withdrawn: record.withdrawn,
  originals: originalsOf(record),
  history: record.history.slice(-historyLimit).map((item) => ({
    ...item,
    before: item.before === null ? null : Object.fromEntries(Object.entries(item.before).map(([name, value]) => [name, typeof value === "string" ? clipText(value, 1_500) : value])) as AmendmentFields,
    ...(item.before != null && Object.values(item.before).some((value) => typeof value === "string" && value.length > 1_500) ? { beforeTruncated: true } : {}),
  })),
});

/** The notes a search reads with each one's additions in its text, so a search finds what was added. */
export const amendedRepository = (
  inner: { scan(fresh?: boolean): Promise<DecisionContextSnapshot> },
  amendments: AmendmentSource,
): { scan(fresh?: boolean): Promise<DecisionContextSnapshot> } => ({
  scan: async (fresh) => {
    const snapshot = await inner.scan(fresh);
    const { records } = await amendments.scan().catch(() => ({ records: new Map<string, StoredAmendment>() }));
    if (records.size === 0) return snapshot;
    return {
      ...snapshot,
      documents: snapshot.documents.map((document): DecisionContextDocument => {
        const record = document.source === "principles" ? undefined : records.get(amendmentKey(document.source, document.id));
        // Searched with the note but no part of it: its excerpt, line numbers and vectors are the note's.
        return record === undefined ? document : { ...document, amendedText: amendedText(record, document.contentHash) };
      }),
    };
  },
});

/**
 * What a result shows once its additions and rewrite are in: the record as it stands now, with `amendment` for the
 * revision number, the added texts and what each rewrite replaced.
 */
export const amendedResult = (
  result: DecisionContextResult, record: StoredAmendment | undefined, relativePath: string, originalSummary = result.summary,
): DecisionContextResult => {
  if (record === undefined || result.source === "principles") return result;
  const hash = result.sourceRef.contentHash;
  const fields = validOverrides(record, hash);
  const state = amendmentStateOf(record, hash, relativePath);
  const last = record.amendments.at(-1);
  const stale = state.revised?.stale === true;
  const warnings = [
    // A rewrite that does not hold any more is said first, in the words the page uses: it is not applied.
    ...(stale ? [`修改已失效（原笔记已变化）：${record.overrides!.client} 于 ${record.overrides!.at.slice(0, 10)} 的改写（${state.revised!.fields.join("、")}）基于旧版原文，现在不再应用，下面显示的是原笔记；请与用户核对后按新原文重新改写（update_decision_journal_entry revise，带新的 expectedContentHash）。`] : []),
    // The new values in the warnings as well, which a bridge that cannot read `amendment` is shown as it is.
    ...(fields === null || record.overrides === null ? [] : [`改写后的值：${clipText(Object.entries(fields).map(([name, value]) => `${name}=${value ?? "（空）"}`).join("；"), 300)}。sourceRef.excerpt 是原笔记最初版本的摘录，不含这些改写。`]),
    // Said where an agent reads it: what follows the original is not the user's own wording of it.
    ...(record.overrides === null || stale ? [] : [`已被 ${record.overrides.client} 于 ${record.overrides.at.slice(0, 10)} 改写（${state.revised!.fields.join("、")}），原话：${clipText(quotedOriginals(state.originals) ?? originalSummary, 300)}；现在显示的是改写后的值，不是用户的原话。`]),
    ...(last === undefined ? [] : [`已被 ${last.client} 于 ${last.at.slice(0, 10)} 增补，共 ${record.amendments.length} 条（见 amendment.amendments），不是用户原话，与原文一起核对。`]),
    ...(record.withdrawn === null ? [] : [`用户已撤回这条（${record.withdrawn.at.slice(0, 10)}）：${record.withdrawn.reason}。不要当作现行${result.kind === "idea" ? "想法" : "偏好"}。`]),
  ];
  return {
    ...result,
    ...(fields !== null && has(fields, "summary") ? { summary: clipText(fields.summary!, 4_000) } : {}),
    // What a decision's reader wrote at the time: the question is its title, the choice its summary.
    ...(fields !== null && has(fields, "choice") ? { summary: clipText(fields.choice!, 4_000) } : {}),
    ...(fields !== null && has(fields, "question") ? { title: clipText(fields.question!, 500) } : {}),
    ...(fields !== null && has(fields, "expectedOutcome") && result.outcomeState !== undefined ? { outcomeState: { ...result.outcomeState, expectedOutcome: fields.expectedOutcome ?? null } } : {}),
    ...(fields !== null && has(fields, "appliesWhen") ? { appliesWhen: fields.appliesWhen ?? null } : {}),
    ...(fields !== null && has(fields, "caution") ? { caution: fields.caution ?? null } : {}),
    ...(record.withdrawn === null ? {} : { status: "withdrawn", current: false }),
    amendment: state,
    // First: what an agent must not miss (a rewrite not applied, the values it was not shown) before the note's own.
    warnings: [...warnings, ...result.warnings].slice(0, 10),
  };
};

/** Preferences and ideas as they stand: withdrawn ones out (unless asked for), rewrites in, additions among the fields. */
export const amendedEntries = (
  entries: JournalEntry[],
  records: ReadonlyMap<string, StoredAmendment>,
  includeWithdrawn: boolean,
): Array<{ entry: JournalEntry; original: JournalEntry; record: StoredAmendment | undefined }> =>
  entries.flatMap((original) => {
    const record = records.get(amendmentKey(original.kind === "preference" ? "preferences" : "ideas", original.id));
    if (record?.withdrawn != null && !includeWithdrawn) return [];
    const fields = validOverrides(record, journalContentHash(original));
    if (fields === null) return [{ entry: original, original, record }];
    const entry = {
      ...original,
      ...(has(fields, "summary") ? { content: fields.summary! } : {}),
      ...(original.kind === "preference" && has(fields, "appliesWhen") ? { appliesWhen: fields.appliesWhen ?? null } : {}),
      ...(original.kind === "preference" && has(fields, "caution") ? { exceptions: fields.caution ?? null } : {}),
    } as JournalEntry;
    return [{ entry, original, record }];
  });

/** Every record's amendments for the page, each against the note as it is now (a rewrite's `stale` is told by that). */
export const amendmentOverview = async (
  amendments: Pick<AmendmentSource, "scan" | "relativePath">,
  hashes: () => Promise<ReadonlyMap<string, string>>,
): Promise<{ records: Array<{ source: DecisionAmendmentRequest["source"]; recordId: string; contentHash: string | null; state: AmendmentState }>; unavailable: boolean }> => {
  const scanned = await amendments.scan().catch(() => null);
  if (scanned === null || scanned.unavailable) return { records: [], unavailable: true };
  if (scanned.records.size === 0) return { records: [], unavailable: false };
  const current = await hashes().catch(() => new Map<string, string>());
  return {
    unavailable: false,
    records: [...scanned.records.values()].map((record) => {
      const hash = current.get(amendmentKey(record.source, record.recordId));
      return { source: record.source, recordId: record.recordId, contentHash: hash ?? null, state: amendmentStateOf(record, hash, amendments.relativePath(record.source, record.recordId), 60) };
    }),
  };
};

/** The results with their additions and rewrites in, for every reader that is not the agents' search itself (the handoff). */
export const annotateResults = async (results: DecisionContextResult[], amendments: AmendmentSource | undefined): Promise<{ results: DecisionContextResult[]; unread: boolean }> => {
  if (amendments === undefined) return { results, unread: false };
  const scanned = await amendments.scan().catch(() => null);
  if (scanned === null) return { results, unread: true };
  return {
    unread: scanned.unavailable,
    results: results.map((result) => result.source === "principles" ? result
      : amendedResult(result, scanned.records.get(amendmentKey(result.source, result.id)), amendments.relativePath(result.source, result.id))),
  };
};

export interface AmendmentLookup {
  /** The record as its note has it now; null: none such; "unavailable": its source could not be read. */
  find(source: DecisionAmendmentRequest["source"], recordId: string): Promise<{
    contentHash: string; summary: string; appliesWhen: string | null; caution: string | null;
    /** A decision's own words as its note has them, for a rewrite to be made against. */
    decision?: { question: string; choice: string; rationale: string | null; context: string | null; expectedOutcome: string | null };
    /** A preference or idea the user wrote or changed: only the user's word may rewrite or withdraw it. */
    userWrote?: boolean;
  } | null | "unavailable">;
}

export class DecisionAmendmentService {
  readonly #repository: DecisionAmendmentRepository;
  readonly #lookup: AmendmentLookup;
  readonly #onWritten: () => void;

  constructor(repository: DecisionAmendmentRepository, lookup: AmendmentLookup, onWritten: () => void = () => undefined) {
    this.#repository = repository;
    this.#lookup = lookup;
    this.#onWritten = onWritten;
  }

  async update(input: DecisionAmendmentRequest): Promise<DecisionAmendmentResult> {
    const request = decisionAmendmentRequestSchema.parse(input);
    const refuse = (status: DecisionAmendmentResult["status"]): DecisionAmendmentResult =>
      ({ amendVersion: DECISION_AMENDMENT_VERSION, status, revision: 0, relativePath: null, originalUnchanged: true });
    if ((request.action === "withdraw" || request.action === "restore") && !isSignalSource(request.source)) return refuse("not_allowed");
    const found = await this.#lookup.find(request.source, request.recordId).catch((): "unavailable" => "unavailable");
    if (found === "unavailable") return refuse("source_unavailable");
    if (found === null) return refuse("not_found");
    if ((request.action === "revise" || request.action === "withdraw") && found.userWrote === true && request.basis === undefined) return refuse("basis_required");
    // A rewrite of what a decision's reader wrote at the time is the user's word, or none.
    if (request.action === "revise" && request.basis === undefined && DECISION_ONLY_FIELDS.some((name) => name in request.fields)) return refuse("basis_required");
    const scanned = await this.#repository.scan();
    if (scanned.unavailable) return refuse("source_unavailable");
    const held = validOverrides(scanned.records.get(amendmentKey(request.source, request.recordId)), found.contentHash);
    const record: AmendableRecord = {
      contentHash: found.contentHash,
      effective: {
        summary: clipText(held !== null && has(held, "summary") ? held.summary! : found.summary, 4_000),
        appliesWhen: held !== null && has(held, "appliesWhen") ? held.appliesWhen ?? null : found.appliesWhen,
        caution: held !== null && has(held, "caution") ? held.caution ?? null : found.caution,
      ...(found.decision === undefined ? {} : Object.fromEntries((["question", "choice", "rationale", "context", "expectedOutcome"] as const).map((name) =>
          [name, held !== null && has(held, name) ? held[name] ?? null : found.decision![name]]))),
      },
    };
    const result = await this.#repository.save(request, record, new Date(), async () => {
      const again = await this.#lookup.find(request.source, request.recordId);
      return again === null || again === "unavailable" ? null : again.contentHash;
    });
    if (result.status === "saved") this.#onWritten();
    return result;
  }
}

/** Preferences and ideas as a consultation reads them: those withdrawn out, a rewrite in, the added texts at the end of each. */
export const entriesForConsultation = (entries: JournalEntry[], records: ReadonlyMap<string, StoredAmendment>): JournalEntry[] =>
  amendedEntries(entries, records, false).map(({ entry, original, record }) => {
    const added = record === undefined ? "" : amendedText({ ...record, overrides: null }, journalContentHash(original));
    const rewritten = record?.overrides != null && validOverrides(record, journalContentHash(original)) !== null
      ? `【已被 ${record.overrides.client} 于 ${record.overrides.at.slice(0, 10)} 改写，原话：${clipText(original.content, 200)}；上面是改写后的值，不是用户的原话】` : "";
    const marked = [entry.content, rewritten, added].filter(Boolean).join("\n");
    return marked === entry.content ? entry : { ...entry, content: marked };
  });
