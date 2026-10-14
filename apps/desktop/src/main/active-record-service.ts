import {
  createJournalEntry,
  createManualDecisionRecord,
  normalizedLanguages,
  reviseJournalEntry,
  type DecisionRecord,
  type JournalEntry,
  type JournalEntryChange,
  type JournalEntryDraft,
} from "@cognelis/decision-core";
import {
  PROACTIVE_RECORD_VERSION,
  proactiveRecordRequestSchema,
  proactiveRecordResultSchema,
  type ProactiveRecordRequest,
  type ProactiveRecordResult,
} from "@cognelis/decision-protocol";
import {
  evictedNote,
  type IndexedDecision,
  type JournalEntryDiagnostic,
  journalEntryGone,
  JournalEntryRepository,
  type JournalEntryQuery,
} from "@cognelis/decision-storage";
import { basename } from "node:path";

import { journalEntryBasis } from "../shared/journal-basis.js";

/**
 * The notice above the preferences and ideas list (health.journalMessage), from what a read could not read. Only a
 * note is one "篇" to check in Obsidian; a folder it could not list, or a note iCloud holds, says its own reason.
 */
export const journalNotice = (diagnostics: readonly JournalEntryDiagnostic[]): string | undefined => {
  const notes = diagnostics.filter((diagnostic) => diagnostic.path.endsWith(".md")).map((diagnostic) => basename(diagnostic.path));
  const others = diagnostics
    .filter((diagnostic) => !diagnostic.path.endsWith(".md"))
    .map((diagnostic) => `${basename(evictedNote(diagnostic.path) ?? diagnostic.path)}（${diagnostic.message.replace(/。$/u, "")}）`);
  const sentences = [
    ...(notes.length === 0 ? [] : [`${notes.length} 篇偏好或想法笔记读不出来，没有出现在列表里：${notes.slice(0, 3).join("、")}${notes.length > 3 ? " 等" : ""}。在 Obsidian 中检查它们的属性后会自动出现。`]),
    ...(others.length === 0 ? [] : [`${others.length} 处偏好或想法这次没能读取：${others.slice(0, 3).join("；")}${others.length > 3 ? " 等" : ""}。`]),
  ];
  return sentences.length === 0 ? undefined : sentences.join("");
};

interface DecisionStoreLike {
  save(record: DecisionRecord): Promise<unknown>;
}

interface DecisionIndexLike {
  findByCaptureSemanticKey(key: string): IndexedDecision | null;
}

export interface ActiveRecordServiceOptions {
  decisionStore: DecisionStoreLike;
  decisionIndex: DecisionIndexLike;
  journalRepository: JournalEntryRepository;
  idFactory: () => string;
  clock?: () => Date;
  /** Told, on every read of the preferences and ideas, which notes could not be read (none: an empty list). */
  onJournalScan?(diagnostics: JournalEntryDiagnostic[]): void;
  /** Told each time a preference or idea is written, by an agent or in the app: a list in view reads again. */
  onJournalWritten?(): void;
}

export interface JournalEntryRevisionInput {
  draft: JournalEntryDraft;
  change: JournalEntryChange;
  /** The entry as the page showed it (journalEntryBasis): a change made since then refuses the revision. */
  basis?: string;
}

const entryDraft = (
  request: Extract<ProactiveRecordRequest, { kind: "preference" | "idea" }>,
): JournalEntryDraft =>
  request.kind === "preference"
    ? {
        kind: "preference",
        title: request.title,
        content: request.content,
        ...(request.knowledgeStatus === undefined
          ? {}
          : { knowledgeStatus: request.knowledgeStatus }),
        context: request.context ?? null,
        rationale: request.rationale ?? null,
        tags: request.tags,
        ...(request.languages === undefined ? {} : { languages: request.languages }),
        appliesWhen: request.appliesWhen ?? null,
        exceptions: request.exceptions ?? null,
        ...(request.strength === undefined ? {} : { strength: request.strength }),
        ...(request.evidenceMaturity === undefined ? {} : { evidenceMaturity: request.evidenceMaturity }),
      }
    : {
        kind: "idea",
        title: request.title,
        content: request.content,
        ...(request.knowledgeStatus === undefined
          ? {}
          : { knowledgeStatus: request.knowledgeStatus }),
        context: request.context ?? null,
        rationale: request.rationale ?? null,
        tags: request.tags,
        ...(request.languages === undefined ? {} : { languages: request.languages }),
        ...(request.ideaForm === undefined ? {} : { ideaForm: request.ideaForm }),
        whyInteresting: request.whyInteresting ?? null,
        openQuestions: request.openQuestions,
        nextTest: request.nextTest ?? null,
        incubateUntil: request.incubateUntil ?? null,
      };

/**
 * What a restated preference or idea says beyond the entry already kept, as a draft of its next
 * revision; null when it says nothing new. Only what the request gives counts: a field left out keeps
 * what the entry says, so restating a hard constraint without its strength does not soften it. Its status,
 * unless given, follows what the entry now holds: completed, a 待澄清 entry is 有效; restated, an archived
 * one stands again.
 */
const restatedDraft = (
  existing: JournalEntry,
  request: Extract<ProactiveRecordRequest, { kind: "preference" | "idea" }>,
): JournalEntryDraft | null => {
  // A tag is there or not: the same tags in another order, or one named twice, are the same tags.
  const sameTags = (left: readonly string[], right: readonly string[]): boolean =>
    JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  const context = request.context ?? existing.context;
  const rationale = request.rationale ?? existing.rationale;
  const tags = request.tags.length > 0 && !sameTags(request.tags, existing.tags) ? request.tags : existing.tags;
  // As tags: languages said and different are the ones kept, by their one name each; left out — or sent empty, as
  // agents fill an optional list — the entry keeps its own: made general again only by the reader, in the App.
  const said = request.languages === undefined || request.languages.length === 0 ? null : normalizedLanguages(request.languages);
  const languages = said !== null && !sameTags(said, existing.languages) ? said : existing.languages;
  const status = (complete: boolean) => request.knowledgeStatus ?? (complete ? "active" : "inbox");
  const common = { title: existing.title, content: existing.content, context, rationale, tags, languages };
  const commonUnchanged =
    context === existing.context && rationale === existing.rationale && tags === existing.tags &&
    languages === existing.languages;
  if (existing.kind === "preference" && request.kind === "preference") {
    const appliesWhen = request.appliesWhen ?? existing.appliesWhen;
    const exceptions = request.exceptions ?? existing.exceptions;
    const strength = request.strength ?? existing.strength;
    const evidenceMaturity = request.evidenceMaturity ?? existing.evidenceMaturity;
    const knowledgeStatus = status(appliesWhen !== null && exceptions !== null);
    return commonUnchanged && knowledgeStatus === existing.knowledgeStatus &&
      appliesWhen === existing.appliesWhen && exceptions === existing.exceptions &&
      strength === existing.strength && evidenceMaturity === existing.evidenceMaturity
      ? null
      : { ...common, knowledgeStatus, kind: "preference", appliesWhen, exceptions, strength, evidenceMaturity };
  }
  if (existing.kind === "idea" && request.kind === "idea") {
    const ideaForm = request.ideaForm ?? existing.ideaForm;
    const whyInteresting = request.whyInteresting ?? existing.whyInteresting;
    const knowledgeStatus = status(whyInteresting !== null);
    const openQuestions = request.openQuestions.length > 0 ? request.openQuestions : existing.openQuestions;
    const nextTest = request.nextTest ?? existing.nextTest;
    const incubateUntil = request.incubateUntil ?? existing.incubateUntil;
    return commonUnchanged && knowledgeStatus === existing.knowledgeStatus &&
      ideaForm === existing.ideaForm && whyInteresting === existing.whyInteresting &&
      JSON.stringify(openQuestions) === JSON.stringify(existing.openQuestions) &&
      nextTest === existing.nextTest && incubateUntil === existing.incubateUntil
      ? null
      : { ...common, knowledgeStatus, kind: "idea", ideaForm, whyInteresting, openQuestions, nextTest, incubateUntil };
  }
  return null;
};

/**
 * Whether the user wrote the entry, or has changed it since: then it is theirs, and an agent restating it
 * does not rewrite it. What an agent said (or a prompt slipped into it) stood as the user's own words, a
 * hard constraint softened, an exception added or the entry archived, and was read back to every later agent.
 */
const userWrote = (entry: JournalEntry): boolean =>
  entry.sourceKind !== "agent_capture" || entry.revisionEvents.some((event) => event.sourceKind !== "agent_capture");

export class ActiveRecordService {
  readonly #decisionStore: DecisionStoreLike;
  readonly #decisionIndex: DecisionIndexLike;
  readonly #journalRepository: JournalEntryRepository;
  readonly #idFactory: () => string;
  readonly #clock: () => Date;
  readonly #onJournalScan: (diagnostics: JournalEntryDiagnostic[]) => void;
  readonly #onJournalWritten: () => void;
  #journalScansStarted = 0;
  #journalScanReported = 0;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: ActiveRecordServiceOptions) {
    this.#decisionStore = options.decisionStore;
    this.#decisionIndex = options.decisionIndex;
    this.#journalRepository = options.journalRepository;
    this.#idFactory = options.idFactory;
    this.#clock = options.clock ?? (() => new Date());
    this.#onJournalScan = options.onJournalScan ?? (() => undefined);
    this.#onJournalWritten = options.onJournalWritten ?? (() => undefined);
  }

  create(input: ProactiveRecordRequest): Promise<ProactiveRecordResult> {
    const request = proactiveRecordRequestSchema.parse(input);
    return this.#enqueue(() => this.#create(request));
  }

  async listJournalEntries(query: JournalEntryQuery = {}): Promise<JournalEntry[]> {
    const started = ++this.#journalScansStarted;
    const scan = await this.#journalRepository.list(query).catch((error: unknown) => {
      // Not read at all (the vault gone, a preferences or ideas folder it may not list): the list shows this error
      // and an agent's consultation is told it (null). Said as well as one note it could not read, it was "1 篇…：
      // Decision Journal, check its properties" under the list's own error.
      this.#reportJournalScan(started, []);
      throw error;
    });
    // A note that cannot be read is left out of the list: said, rather than gone without a word.
    this.#reportJournalScan(started, scan.diagnostics);
    return scan.entries;
  }

  /** Reads can finish out of order; one begun earlier does not undo what a later one said. */
  #reportJournalScan(started: number, diagnostics: JournalEntryDiagnostic[]): void {
    if (started <= this.#journalScanReported) return;
    this.#journalScanReported = started;
    this.#onJournalScan(diagnostics);
  }

  reviseJournalEntry(
    id: string,
    input: JournalEntryRevisionInput,
  ): Promise<JournalEntry> {
    return this.#enqueue(async () => {
      const current = await this.#journalRepository.find(id);
      if (current === null) throw new Error(journalEntryGone);
      // Revised from the copy the page had, a change made since (an agent's restatement, an edit in Obsidian)
      // went back to what it was, without a word.
      if (input.basis !== undefined && input.basis !== journalEntryBasis(current)) {
        throw new Error("这条记录在你打开之后又被更新过（比如智能体重述了它，或在 Obsidian 里改过），已重新读取，请在最新内容上再改。");
      }
      const revised = reviseJournalEntry(
        current,
        input.draft,
        input.change,
        this.#clock(),
      );
      const written = await this.#journalRepository.revise(id, revised);
      this.#onJournalWritten();
      return written;
    });
  }

  async #create(request: ProactiveRecordRequest): Promise<ProactiveRecordResult> {
    if (request.kind === "decision") {
      const record = createManualDecisionRecord(
        {
          question: request.title,
          decision: request.content,
          project: request.project ?? "personal",
          rationale: request.rationale ?? null,
          contextSummary: request.context ?? null,
          options: request.options,
          expectedOutcome: request.expectedOutcome ?? null,
          reviewDueDate: request.reviewDueDate ?? null,
          occurredAt: request.occurredAt ?? null,
          sourceKind: request.sourceKind,
          sourceForm: request.sourceForm,
          sensitivity: request.sensitivity,
          tags: request.tags,
          sourceUrl: request.sourceUrl ?? null,
          sourceClient: request.sourceClient,
        },
        this.#idFactory(),
        this.#clock(),
      );
      const duplicate = this.#decisionIndex.findByCaptureSemanticKey(
        record.captureSemanticKey as string,
      );
      if (duplicate === null) await this.#decisionStore.save(record);
      return proactiveRecordResultSchema.parse({
        recordVersion: PROACTIVE_RECORD_VERSION,
        status: duplicate === null ? "created" : "duplicate",
        recordKind: "decision",
        recordId: duplicate?.id ?? record.id,
        knowledgeStatus: "active",
        sensitivity: record.sensitivity ?? "private",
        storedTranscript: false,
      });
    }

    const entry = createJournalEntry(
      entryDraft(request),
      {
        sourceKind: request.sourceKind,
        sourceForm: request.sourceForm,
        project: request.project ?? null,
        occurredAt: request.occurredAt ?? null,
        sensitivity: request.sensitivity,
      },
      this.#idFactory(),
      this.#clock(),
    );
    const stored = await this.#journalRepository.create(entry);
    // Restated with something added or changed (an exception, a condition): kept as the next revision of
    // the entry already there, rather than dropped as a duplicate with the new part lost. One the user
    // wrote or changed, in the app or in Obsidian, an agent leaves as it is: the user changes it in the app.
    const draft = stored.created ||
      (request.sourceKind === "agent_capture" && (userWrote(stored.entry) || stored.editedOutsideApp === true))
      ? null
      : restatedDraft(stored.entry, request);
    const kept = draft === null
      ? stored.entry
      : await this.#journalRepository.revise(
          stored.entry.id,
          reviseJournalEntry(
            stored.entry,
            draft,
            { changeNote: "重新记录时更新了内容", sourceKind: request.sourceKind, sourceForm: request.sourceForm },
            this.#clock(),
          ),
        );
    // Pushed nowhere, an agent's new idea waited unseen in a list left open until the page was shown again.
    if (stored.created || draft !== null) this.#onJournalWritten();
    return proactiveRecordResultSchema.parse({
      recordVersion: PROACTIVE_RECORD_VERSION,
      status: stored.created ? "created" : draft === null ? "duplicate" : "updated",
      recordKind: kept.kind,
      recordId: kept.id,
      knowledgeStatus: kept.knowledgeStatus,
      sensitivity: kept.sensitivity,
      storedTranscript: false,
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation);
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
