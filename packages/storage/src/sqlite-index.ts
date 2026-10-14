import type { OutcomeVerdict, RationaleStatus } from "@cognelis/decision-core";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { isSqliteCorruptionError } from "./obsidian-search-index.js";
import { expireQuarantined, QUARANTINE_MAXIMUM_AGE_MS } from "./quarantine.js";
import { foldedText, searchTokens } from "./search-text.js";

import type { ParsedStoredNote } from "./markdown.js";

export interface IndexedDecision {
  id: string;
  created: string;
  status: string;
  sourceClient: string;
  project: string;
  workflow: string | null;
  decisionType: string;
  selectedAnswer: string;
  captureMode: string | null;
  captureSemanticKey: string | null;
  sourceEventId: string | null;
  batchId: string | null;
  questionIndex: number | null;
  rationaleStatus: string;
  filePath: string;
  contentHash: string;
  question: string;
  rationale: string | null;
  context: string | null;
  expectedOutcome?: string | null;
  outcome: string | null;
  outcomeVerdict: string | null;
  outcomeLesson: string | null;
  outcomeReviewedAt: string | null;
  reviewDueDate: string | null;
  appliedPrincipleIds: string[];
}

export interface DecisionQuery {
  query?: string;
  decisionId?: string;
  /** An ISO timestamp; only decisions created at or after it. */
  createdSince?: string;
  rationaleStatus?: Exclude<RationaleStatus, "not_recorded">;
  sourceClient?: string;
  /** Trimmed, the way the analytics group decisions by project. */
  project?: string;
  /** Reviewed with this verdict. */
  outcomeVerdict?: OutcomeVerdict;
  reviewState?:
    | "pending_outcome"
    | "pending_review"
    | "reviewed"
    | "attention"
    | "due"
    | "scheduled"
    | "unscheduled"
    | "expectation_missing";
  asOfDate?: string;
  limit?: number;
  /**
   * Every decision the filters let through, not the newest 200: for the main process to rank by meaning
   * (the IPC does not accept it). Ranked among the newest 200, an older decision could not be found.
   */
  everything?: boolean;
}

interface DecisionRow {
  id: string;
  created: string;
  status: string;
  source_client: string;
  project: string;
  workflow: string | null;
  decision_type: string;
  selected_option: string;
  capture_mode: string | null;
  capture_semantic_key: string | null;
  source_event_id: string | null;
  batch_id: string | null;
  question_index: number | null;
  rationale_status: string;
  file_path: string;
  content_hash: string;
  question: string;
  rationale: string | null;
  context: string | null;
  expected_outcome: string | null;
  outcome: string | null;
  outcome_verdict: string | null;
  outcome_lesson: string | null;
  outcome_reviewed_at: string | null;
  review_due_date: string | null;
  applied_principle_ids: string;
}

/** Every character String.prototype.trim() removes. */
const JS_TRIMMED_WHITESPACE =
  "\t\n\v\f\r                  　﻿";

const readableSelection = (note: ParsedStoredNote): string =>
  note.record.selectedAnswer.values.join("、");

const parseAppliedPrincipleIds = (value: string): string[] => {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length > 5 ||
    !parsed.every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 200,
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error("Indexed decision has invalid applied principle IDs");
  }
  return [...parsed];
};

const mapRow = (row: DecisionRow): IndexedDecision => ({
  id: row.id,
  created: row.created,
  status: row.status,
  sourceClient: row.source_client,
  project: row.project,
  workflow: row.workflow,
  decisionType: row.decision_type,
  selectedAnswer: row.selected_option,
  captureMode: row.capture_mode,
  captureSemanticKey: row.capture_semantic_key,
  sourceEventId: row.source_event_id,
  batchId: row.batch_id,
  questionIndex: row.question_index,
  rationaleStatus: row.rationale_status,
  filePath: row.file_path,
  contentHash: row.content_hash,
  question: row.question,
  rationale: row.rationale,
  context: row.context,
  expectedOutcome: row.expected_outcome,
  outcome: row.outcome,
  outcomeVerdict: row.outcome_verdict,
  outcomeLesson: row.outcome_lesson,
  outcomeReviewedAt: row.outcome_reviewed_at,
  reviewDueDate: row.review_due_date,
  appliedPrincipleIds: parseAppliedPrincipleIds(
    row.applied_principle_ids ?? "[]",
  ),
});

/** The search rows' text columns, each folded (search-text.ts). */
const SEARCHED_COLUMNS = [
  "question", "selected_option", "rationale", "context", "expected_outcome", "outcome", "outcome_lesson", "project", "tags", "options",
] as const;

const allOf = (tokens: readonly string[]): string =>
  tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");

const ftsQuery = (query: string): string => allOf(searchTokens(query));

const escapedLikePattern = (token: string): string =>
  `%${token
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;

/**
 * Opened with columns or search rows a newer app filled in from nothing (tags among them), the notes are owed a
 * full read. Kept in the file, not the process: a start that could not rebuild (the vault not mounted, a read
 * that failed) left the debt forgotten, and the next start found the rows aligned and never paid it.
 */
const REBUILD_OWED = 1;
const oweRebuild = (database: DatabaseSync): void => {
  database.exec(`PRAGMA user_version = ${REBUILD_OWED}`);
};

const ensureCaptureColumns = (database: DatabaseSync): void => {
  const existing = new Set(
    (
      database.prepare("PRAGMA table_info(decisions)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  const columns = [
    ["capture_mode", "TEXT"],
    ["capture_semantic_key", "TEXT"],
    ["source_event_id", "TEXT"],
    ["batch_id", "TEXT"],
    ["question_index", "INTEGER"],
    ["context", "TEXT"],
    ["expected_outcome", "TEXT"],
    ["outcome", "TEXT"],
    ["outcome_verdict", "TEXT"],
    ["outcome_lesson", "TEXT"],
    ["outcome_reviewed_at", "TEXT"],
    ["review_due_date", "TEXT"],
    ["applied_principle_ids", "TEXT NOT NULL DEFAULT '[]'"],
  ] as const;
  for (const [name, type] of columns) {
    if (!existing.has(name)) {
      database.exec(
        `ALTER TABLE decisions ADD COLUMN ${name} ${type}`,
      );
      oweRebuild(database);
    }
  }
};

/**
 * Each row's note file as it stood when read (fileStamp): a start looks at the file and reads only one changed
 * since. Unknown for rows from before it, which are read once and stamped then; no rebuild is owed for it.
 */
const ensureStampColumn = (database: DatabaseSync): void => {
  const columns = (database.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>).map((column) => column.name);
  if (!columns.includes("file_stamp")) database.exec("ALTER TABLE decisions ADD COLUMN file_stamp TEXT");
};

/**
 * The search rows as this build writes them: folded to one width and case (search-text.ts), the options the note
 * weighed among them. Rows from before (raw text, no options) are made again here and owed a read of the notes.
 */
const ensureContextFts = (database: DatabaseSync): void => {
  const columns = (
    database
      .prepare("PRAGMA table_info(decisions_fts)")
      .all() as Array<{ name: string }>
  ).map((column) => column.name);
  if (
    columns.includes("context") &&
    columns.includes("expected_outcome") &&
    columns.includes("outcome") &&
    columns.includes("outcome_lesson") &&
    columns.includes("options")
  ) {
    return;
  }
  oweRebuild(database);
  keepTags(database, columns);
  database.exec(`
    DROP TABLE IF EXISTS decisions_fts;
    CREATE VIRTUAL TABLE decisions_fts USING fts5(
      id UNINDEXED,
      question,
      selected_option,
      rationale,
      context,
      expected_outcome,
      outcome,
      outcome_lesson,
      project,
      tags,
      options,
      tokenize='trigram'
    );
    INSERT INTO decisions_fts (
      id, question, selected_option, rationale, context, expected_outcome,
      outcome, outcome_lesson, project, tags, options
    )
    SELECT
      id,
      ${REFILLED_COLUMNS},
      ''
    FROM decisions;
    DROP TABLE temp.kept_tags;
  `);
};

/**
 * The tags the search rows hold, by id, for rows made again from the decisions table: a note's tags are in no other
 * table. Written blank, a tag found nothing until the notes were read again, which a vault's disk not there at a
 * start puts off, for several starts.
 */
const keepTags = (database: DatabaseSync, columns: readonly string[]): void => {
  database.exec(`
    DROP TABLE IF EXISTS temp.kept_tags;
    CREATE TEMP TABLE kept_tags (id TEXT PRIMARY KEY, tags TEXT NOT NULL);
    ${columns.includes("tags") ? "INSERT OR IGNORE INTO temp.kept_tags SELECT id, coalesce(tags, '') FROM decisions_fts;" : ""}
  `);
};
const KEPT_TAGS = "coalesce((SELECT tags FROM temp.kept_tags kept WHERE kept.id = decisions.id), '')";
// Folded as every row this build writes is (fold is foldedText, registered with the database): written as they were,
// a word typed in full width found nothing it had found before, until the notes were read again.
const REFILLED_COLUMNS = [
  "question",
  "selected_option",
  "coalesce(rationale, '')",
  "coalesce(context, '')",
  "coalesce(expected_outcome, '')",
  "coalesce(outcome, '')",
  "coalesce(outcome_lesson, '')",
  "project",
  KEPT_TAGS,
].map((column) => `fold(${column})`).join(", ");

/**
 * Each search row kept at its decision's rowid, where every write now looks for it. Kept by id alone (a column
 * the search table does not index), each write read the whole table to find its row, and three hundred notes
 * synced at once held the window for seconds. Rows from before are put at their rowid once.
 */
const alignFtsRows = (database: DatabaseSync): void => {
  const misaligned = database
    .prepare("SELECT 1 FROM decisions_fts f WHERE NOT EXISTS (SELECT 1 FROM decisions d WHERE d.rowid = f.rowid AND d.id = f.id) LIMIT 1")
    .get();
  if (misaligned === undefined) return;
  oweRebuild(database);
  keepTags(database, ["tags"]);
  database.exec(`
    DELETE FROM decisions_fts;
    INSERT INTO decisions_fts (
      rowid, id, question, selected_option, rationale, context, expected_outcome,
      outcome, outcome_lesson, project, tags, options
    )
    SELECT
      rowid,
      id,
      ${REFILLED_COLUMNS},
      ''
    FROM decisions;
    DROP TABLE temp.kept_tags;
  `);
};

const createDatabase = (path: string): DatabaseSync => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  chmodSync(path, 0o600);
  const database = new DatabaseSync(path, { timeout: 5_000 });
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        created TEXT NOT NULL,
        status TEXT NOT NULL,
        source_client TEXT NOT NULL,
        project TEXT NOT NULL,
        workflow TEXT,
        decision_type TEXT NOT NULL,
        selected_option TEXT NOT NULL,
        capture_mode TEXT,
        capture_semantic_key TEXT,
        source_event_id TEXT,
        batch_id TEXT,
        question_index INTEGER,
        rationale_status TEXT NOT NULL,
        file_path TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        question TEXT NOT NULL,
        rationale TEXT,
        context TEXT,
        expected_outcome TEXT,
        outcome TEXT,
        outcome_verdict TEXT,
        outcome_lesson TEXT,
        outcome_reviewed_at TEXT,
        review_due_date TEXT,
        applied_principle_ids TEXT NOT NULL DEFAULT '[]',
        file_stamp TEXT
      );
      CREATE INDEX IF NOT EXISTS decisions_rationale_status
        ON decisions(rationale_status, created DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        id UNINDEXED,
        question,
        selected_option,
        rationale,
        context,
        expected_outcome,
        outcome,
        outcome_lesson,
        project,
        tags,
        options,
        tokenize='trigram'
      );
    `);
    ensureCaptureColumns(database);
    ensureStampColumn(database);
    database.function("fold", { deterministic: true }, (text) => (typeof text === "string" ? foldedText(text) : text));
    ensureContextFts(database);
    alignFtsRows(database);
    database.exec(`
      CREATE INDEX IF NOT EXISTS decisions_capture_semantic
        ON decisions(capture_semantic_key, created);
      CREATE INDEX IF NOT EXISTS decisions_review_due
        ON decisions(review_due_date, outcome_verdict);
      -- The newest first, as every list and each snapshot's twelve are read: sorted whole, on every push.
      CREATE INDEX IF NOT EXISTS decisions_created
        ON decisions(created DESC, id DESC);
    `);
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) {
        chmodSync(candidate, 0o600);
      }
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const removeSidecars = (path: string): void => {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
};

const quarantineDatabase = (path: string): void => {
  const suffix = `.corrupt-${Date.now()}-${randomUUID()}`;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(candidate)) {
      const quarantined = `${candidate}${suffix}`;
      renameSync(candidate, quarantined);
      chmodSync(quarantined, 0o600);
    }
  }
};

/**
 * Opens a database filled only from other files (the notes, the models), setting aside one SQLite cannot read and
 * starting it again empty, to be filled again; what was set aside is kept a week for a look at what went wrong.
 * A full disk, a permission or a lock leaves a whole one behind it, and is passed on: set aside, a healthy index
 * was rebuilt from nothing once the problem went, and deleted a week later as corrupt.
 */
export const openRebuildable = (path: string, open: (path: string) => DatabaseSync): DatabaseSync => {
  let database: DatabaseSync;
  try {
    database = open(path);
  } catch (error) {
    if (!existsSync(path) || !isSqliteCorruptionError(error)) {
      throw error;
    }
    quarantineDatabase(path);
    database = open(path);
  }
  void expireQuarantined(dirname(path), QUARANTINE_MAXIMUM_AGE_MS, Date.now(), (name) =>
    name.startsWith(basename(path)) && name.includes(".corrupt-"));
  return database;
};

export class SqliteIndex {
  #database: DatabaseSync;
  readonly #path: string;
  #revision = 0;

  constructor(path: string) {
    this.#path = path;
    this.#database = openRebuildable(path, createDatabase);
  }

  /** Empty, or opened short of what only the notes hold: brought up to the vault by reading it all again. */
  get needsRebuild(): boolean {
    const { user_version: version } = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
    return version === REBUILD_OWED || this.count() === 0;
  }

  indexedPaths(): string[] {
    return (this.#database.prepare("SELECT file_path FROM decisions").all() as Array<{ file_path: string }>)
      .map((row) => row.file_path);
  }

  pathOf(id: string): string | null {
    const row = this.#database.prepare("SELECT file_path FROM decisions WHERE id = ?").get(id) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  /**
   * How many times what the index holds has changed in this process: a page in view reads its decisions again when
   * it moves. An outcome an agent recorded left the count of decisions as it was, and the knowledge page as well.
   */
  revision(): number {
    return this.#revision;
  }

  upsert(note: ParsedStoredNote): void {
    this.#transaction(() =>
      this.#upsertWithoutTransaction(this.#database, note),
    );
    this.#revision += 1;
  }

  removePath(path: string): string | null {
    const row = this.#database
      .prepare("SELECT id FROM decisions WHERE file_path = ?")
      .get(path) as { id: string } | undefined;
    if (row === undefined) {
      return null;
    }
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM decisions_fts WHERE rowid = (SELECT rowid FROM decisions WHERE id = ?)").run(row.id);
      this.#database.prepare("DELETE FROM decisions WHERE id = ?").run(row.id);
    });
    this.#revision += 1;
    return row.id;
  }

  rebuild(notes: ParsedStoredNote[], keep: string[] = []): void {
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.rebuild`;
    let rebuilt: DatabaseSync | null = null;
    let currentClosed = false;
    try {
      rebuilt = createDatabase(temporary);
      // Filled from empty: an id not yet put in has nothing to replace. Looking for it anyway scanned the
      // whole full-text table (its id is not indexed) for every note, and a start-up rebuild of a few
      // thousand decisions took seconds, growing with the square of their number.
      const filled = new Set<string>();
      const { user_version: version } = this.#database.prepare("PRAGMA user_version").get() as { user_version: number };
      this.#transactionOn(rebuilt, () => {
        for (const note of notes) {
          this.#upsertWithoutTransaction(rebuilt as DatabaseSync, note, filled);
        }
        for (const path of keep) this.#carryOver(rebuilt as DatabaseSync, path, filled, version === REBUILD_OWED);
      });
      rebuilt.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      rebuilt.close();
      rebuilt = null;

      this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.#database.close();
      currentClosed = true;
      removeSidecars(this.#path);
      renameSync(temporary, this.#path);
      chmodSync(this.#path, 0o600);
      this.#database = createDatabase(this.#path);
      currentClosed = false;
      this.#revision += 1;
    } catch (error) {
      rebuilt?.close();
      rmSync(temporary, { force: true });
      removeSidecars(temporary);
      if (currentClosed) {
        this.#database = createDatabase(this.#path);
      }
      throw error;
    }
  }

  search(query: string, limit = 50): IndexedDecision[] {
    const expression = ftsQuery(query);
    if (expression.length === 0) {
      return [];
    }
    const rows = this.#database
      .prepare(`
        SELECT d.*
        FROM decisions_fts
        JOIN decisions d ON d.id = decisions_fts.id
        WHERE decisions_fts MATCH ?
        ORDER BY bm25(decisions_fts), d.created DESC
        LIMIT ?
      `)
      .all(expression, limit) as unknown as DecisionRow[];
    return rows.map(mapRow);
  }

  queryDecisions(query: DecisionQuery = {}): IndexedDecision[] {
    return (this.#queryRows(query, "d.*") as unknown as DecisionRow[]).map(mapRow);
  }

  /**
   * What queryDecisions finds, as identifier, note hash and date alone: enough to learn which changed. Every
   * decision whole, every semantic search read ten thousand of them, text and all, to rank by vectors.
   */
  queryDecisionStamps(query: DecisionQuery = {}): Array<Pick<IndexedDecision, "id" | "contentHash" | "created">> {
    return this.#queryRows(query, "d.id AS id, d.content_hash AS contentHash, d.created AS created") as unknown as Array<
      Pick<IndexedDecision, "id" | "contentHash" | "created">
    >;
  }

  #queryRows(query: DecisionQuery, columns: string): unknown[] {
    const tokens = searchTokens(query.query ?? "");
    // A word of three characters or more is looked for through the trigram index; a shorter one (most Chinese words:
    // 架构, 缓存) in the search rows themselves, which hold the tags and options, folded as the query is. Looked for in
    // the decisions' own columns, a two-character tag found nothing, and one short word sent every word there.
    // ponytail: a query of short words alone reads every search row (tens of milliseconds at ten thousand
    // decisions); a bigram index would answer them through an index if that grows.
    const long = tokens.filter((token) => Array.from(token).length >= 3);
    const short = tokens.filter((token) => Array.from(token).length < 3);
    const useFts = long.length > 0;
    // SQLite reads a negative limit as none.
    const boundedLimit = query.everything === true ? -1 : Math.max(
      1,
      Math.min(200, Math.trunc(query.limit ?? 100)),
    );
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.decisionId !== undefined) {
      clauses.push("d.id = ?");
      parameters.push(query.decisionId);
    }
    if (query.createdSince !== undefined) {
      // julianday reads offsets as well as Z, where comparing text would not.
      clauses.push("julianday(d.created) >= julianday(?)");
      parameters.push(query.createdSince);
    }
    if (useFts) {
      clauses.push("decisions_fts MATCH ?");
      parameters.push(allOf(long));
    }
    for (const token of short) {
      clauses.push(`(${SEARCHED_COLUMNS.map((column) => `decisions_fts.${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
      parameters.push(...SEARCHED_COLUMNS.map(() => escapedLikePattern(token)));
    }
    if (query.rationaleStatus !== undefined) {
      clauses.push("d.rationale_status = ?");
      parameters.push(query.rationaleStatus);
    }
    if (query.sourceClient !== undefined) {
      clauses.push("d.source_client = ?");
      parameters.push(query.sourceClient);
    }
    if (query.project !== undefined) {
      // SQLite's trim() strips only ASCII spaces; hand it JavaScript's whole
      // set so a note edited to end in a full-width space still matches. The
      // analytics count a blank project as 未命名项目, so that name finds them.
      clauses.push(
        query.project === "未命名项目"
          ? "trim(d.project, ?) IN ('', ?)"
          : "trim(d.project, ?) = ?",
      );
      parameters.push(JS_TRIMMED_WHITESPACE, query.project);
    }
    if (query.outcomeVerdict !== undefined) {
      clauses.push("d.outcome_verdict = ?");
      parameters.push(query.outcomeVerdict);
    }
    if (query.reviewState === "pending_outcome") {
      clauses.push("d.outcome IS NULL");
    } else if (query.reviewState === "pending_review") {
      clauses.push("d.outcome IS NOT NULL AND d.outcome_verdict IS NULL");
    } else if (query.reviewState === "reviewed") {
      clauses.push("d.outcome_verdict IS NOT NULL");
    } else if (query.reviewState === "attention") {
      clauses.push(
        "d.outcome_verdict IS NULL AND (d.outcome IS NOT NULL OR (d.review_due_date IS NOT NULL AND d.review_due_date <= ?))",
      );
      parameters.push(query.asOfDate ?? new Date().toISOString().slice(0, 10));
    } else if (query.reviewState === "due") {
      clauses.push(
        "d.outcome_verdict IS NULL AND d.review_due_date IS NOT NULL AND d.review_due_date <= ?",
      );
      parameters.push(query.asOfDate ?? new Date().toISOString().slice(0, 10));
    } else if (query.reviewState === "scheduled") {
      clauses.push(
        "d.outcome_verdict IS NULL AND d.review_due_date IS NOT NULL AND d.review_due_date > ?",
      );
      parameters.push(query.asOfDate ?? new Date().toISOString().slice(0, 10));
    } else if (query.reviewState === "unscheduled") {
      clauses.push("d.outcome_verdict IS NULL AND d.review_due_date IS NULL");
    } else if (query.reviewState === "expectation_missing") {
      // Still worth writing: once the outcome is in it would only restate it.
      clauses.push("coalesce(d.expected_outcome, '') = '' AND d.outcome IS NULL");
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    // A decision whose question holds more of the words first, then (words of three characters or more) bm25 with the
    // question and tags weighted. Ranked by bm25 over every column alike, the decision whose question was the query came
    // below one that only mentioned it; by date alone (a short word), ⌘K's five left it out.
    const order = [
      ...(tokens.length === 0 ? [] : [`${tokens.map(() => "(instr(decisions_fts.question, ?) > 0)").join(" + ")} DESC`]),
      // id, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags, options
      ...(useFts ? ["bm25(decisions_fts, 0, 10, 4, 1, 1, 1, 1, 1, 2, 3, 1)"] : []),
      ...(query.reviewState === "due" || query.reviewState === "scheduled" ? ["d.review_due_date ASC"] : []),
      "d.created DESC",
      "d.id DESC",
    ].join(", ");
    // Each search row at its decision's rowid (alignFtsRows).
    const from =
      tokens.length === 0
        ? "decisions d"
        : "decisions_fts JOIN decisions d ON d.rowid = decisions_fts.rowid";
    return this.#database
      .prepare(`
        SELECT ${columns}
        FROM ${from}
        ${where}
        ORDER BY ${order}
        LIMIT ?
      `)
      .all(...parameters, ...tokens, boundedLimit);
  }

  listRecent(limit = 12): IndexedDecision[] {
    const bounded = Math.max(
      1,
      Math.min(50, Math.trunc(limit)),
    );
    const rows = this.#database
      .prepare(
        "SELECT * FROM decisions ORDER BY created DESC, id DESC LIMIT ?",
      )
      .all(bounded) as unknown as DecisionRow[];
    return rows.map(mapRow);
  }

  snapshotDecisions(): IndexedDecision[] {
    const rows = this.#database
      .prepare("SELECT * FROM decisions ORDER BY created ASC, id ASC")
      .all() as unknown as DecisionRow[];
    return rows.map(mapRow);
  }

  /** The decisions that applied this principle, oldest first: one principle's usage once read every decision. */
  decisionsApplying(principleId: string): IndexedDecision[] {
    const rows = this.#database
      .prepare(
        `SELECT * FROM decisions
         WHERE json_valid(applied_principle_ids)
           AND EXISTS (SELECT 1 FROM json_each(decisions.applied_principle_ids) WHERE value = ?)
         ORDER BY created ASC, id ASC`,
      )
      .all(principleId) as unknown as DecisionRow[];
    return rows.map(mapRow);
  }

  findDecisions(ids: string[]): IndexedDecision[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) {
      return [];
    }
    const byId = new Map<string, IndexedDecision>();
    for (let start = 0; start < uniqueIds.length; start += 200) {
      const batch = uniqueIds.slice(start, start + 200);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.#database
        .prepare(
          `SELECT * FROM decisions WHERE id IN (${placeholders})`,
        )
        .all(...batch) as unknown as DecisionRow[];
      for (const row of rows) {
        byId.set(row.id, mapRow(row));
      }
    }
    return uniqueIds
      .map((id) => byId.get(id))
      .filter((value): value is IndexedDecision => value !== undefined);
  }

  findByCaptureSemanticKey(key: string): IndexedDecision | null {
    const normalized = key.trim();
    if (normalized.length === 0 || normalized.length > 200) {
      throw new Error("Capture semantic key must contain 1 to 200 characters");
    }
    const row = this.#database
      .prepare(
        "SELECT * FROM decisions WHERE capture_semantic_key = ? ORDER BY created ASC LIMIT 1",
      )
      .get(normalized) as DecisionRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  countSince(created: string): number {
    const row = this.#database
      .prepare(
        "SELECT count(*) AS count FROM decisions WHERE julianday(created) >= julianday(?)",
      )
      .get(created) as { count: number };
    return Number(row.count);
  }

  /**
   * Named projects with their decision counts, most used first. Grouped with
   * the same trim as the project filter, so every entry filters to its count;
   * a blank project cannot be filtered on and is left out.
   */
  listProjects(limit = 200): Array<{ project: string; count: number }> {
    const rows = this.#database
      .prepare(`
        SELECT trim(project, ?) AS project, count(*) AS count
        FROM decisions
        WHERE trim(project, ?) <> ''
        GROUP BY 1
        ORDER BY count DESC, project ASC
        LIMIT ?
      `)
      .all(JS_TRIMMED_WHITESPACE, JS_TRIMMED_WHITESPACE, limit) as Array<{ project: string; count: number }>;
    return rows.map((row) => ({ project: row.project, count: Number(row.count) }));
  }

  countReviewAttention(asOfDate: string): number {
    const row = this.#database
      .prepare(`
        SELECT count(*) AS count
        FROM decisions
        WHERE outcome_verdict IS NULL
          AND (
            outcome IS NOT NULL OR
            (review_due_date IS NOT NULL AND review_due_date <= ?)
          )
      `)
      .get(asOfDate) as { count: number };
    return Number(row.count);
  }

  /**
   * Decisions whose review date has arrived and that carry no verdict yet.
   * `countReviewAttention` folds these together with decisions that merely
   * have an outcome waiting — a merged number cannot tell a reader that a
   * review came due, which is the whole point of scheduling one.
   */
  listReviewDue(asOfDate: string, limit: number): IndexedDecision[] {
    // Newest due first: a backlog of older reviews already announced must not keep a newly due one
    // out of the reminder's window.
    const rows = this.#database
      .prepare(
        `SELECT * FROM decisions
         WHERE outcome_verdict IS NULL
           AND review_due_date IS NOT NULL
           AND review_due_date <= ?
         ORDER BY review_due_date DESC, created DESC
         LIMIT ?`,
      )
      .all(asOfDate, limit) as unknown as DecisionRow[];
    return rows.map(mapRow);
  }

  /** Most recent first; only the first `limit` when given. */
  listByRationaleStatus(
    status: Exclude<RationaleStatus, "not_recorded">,
    limit?: number,
  ): IndexedDecision[] {
    const query = "SELECT * FROM decisions WHERE rationale_status = ? ORDER BY created DESC, id DESC";
    const rows = (limit === undefined
      ? this.#database.prepare(query).all(status)
      : this.#database.prepare(`${query} LIMIT ?`).all(status, limit)) as unknown as DecisionRow[];
    return rows.map(mapRow);
  }

  /**
   * Whether each decision has its outcome and its verdict, and nothing else: what build progress counts.
   * Every decision whole, text and all, was read for it. An outcome there is "", its text not being counted.
   */
  progressFacts(): Array<{ outcome: string | null; outcomeVerdict: string | null }> {
    return this.#database
      .prepare("SELECT CASE WHEN outcome IS NULL THEN NULL ELSE '' END AS outcome, outcome_verdict AS outcomeVerdict FROM decisions")
      .all() as Array<{ outcome: string | null; outcomeVerdict: string | null }>;
  }

  /** Which decisions are in a state, without reading their text: to count them. */
  idsByRationaleStatus(status: Exclude<RationaleStatus, "not_recorded">): string[] {
    return (this.#database
      .prepare("SELECT id FROM decisions WHERE rationale_status = ?")
      .all(status) as Array<{ id: string }>).map((row) => row.id);
  }

  /** Each indexed note's path, with its file's stamp when it was read (null where none was kept). */
  indexedStamps(): Map<string, string | null> {
    const rows = this.#database.prepare("SELECT file_path, file_stamp FROM decisions").all() as Array<{ file_path: string; file_stamp: string | null }>;
    return new Map(rows.map((row) => [row.file_path, row.file_stamp]));
  }

  stampForPath(path: string): string | null {
    const row = this.#database.prepare("SELECT file_stamp FROM decisions WHERE file_path = ?").get(path) as { file_stamp: string | null } | undefined;
    return row?.file_stamp ?? null;
  }

  /** Read again and found as indexed: its file is kept as it now stands, so the next look does not read it. */
  setStamp(path: string, stamp: string): void {
    this.#database.prepare("UPDATE decisions SET file_stamp = ? WHERE file_path = ?").run(stamp, path);
  }

  contentHashForPath(path: string): string | null {
    const row = this.#database
      .prepare("SELECT content_hash FROM decisions WHERE file_path = ?")
      .get(path) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  hasDecision(id: string): boolean {
    return (
      this.#database
        .prepare("SELECT 1 AS found FROM decisions WHERE id = ?")
        .get(id) !== undefined
    );
  }

  count(): number {
    const row = this.#database
      .prepare("SELECT count(*) AS count FROM decisions")
      .get() as { count: number };
    return Number(row.count);
  }

  close(): void {
    this.#database.close();
  }

  /**
   * `filled`: the ids already put into a database being filled from empty (a rebuild). One not among
   * them has nothing to replace there, so its old rows are not looked for.
   */
  #upsertWithoutTransaction(
    database: DatabaseSync,
    note: ParsedStoredNote,
    filled?: Set<string>,
  ): void {
    const record = note.record;
    const replacing = filled === undefined || filled.has(record.id);
    filled?.add(record.id);
    // A file now holding another id (a copy whose id was changed in Obsidian) is indexed as that id, in place
    // of what it was indexed as, rather than clashing with it on the path.
    const previous = database
      .prepare("SELECT id FROM decisions WHERE file_path = ? AND id <> ?")
      .all(note.path, record.id) as { id: string }[];
    for (const { id } of previous) {
      database.prepare("DELETE FROM decisions_fts WHERE rowid = (SELECT rowid FROM decisions WHERE id = ?)").run(id);
      database.prepare("DELETE FROM decisions WHERE id = ?").run(id);
    }
    const selectedOption = readableSelection(note);
    const context = [
      record.contextSummary,
      record.context?.taskBackground,
      record.context?.decisionFraming,
    ]
      .filter((value): value is string => value !== null && value !== undefined)
      .join("\n\n");
    database
      .prepare(`
        INSERT INTO decisions (
          id, created, status, source_client, project, workflow,
          decision_type, selected_option, capture_mode,
          capture_semantic_key, source_event_id, batch_id,
          question_index, rationale_status, file_path, content_hash,
          question, rationale, context, outcome, outcome_verdict,
          expected_outcome, outcome_lesson, outcome_reviewed_at, review_due_date,
          applied_principle_ids, file_stamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          created = excluded.created,
          status = excluded.status,
          source_client = excluded.source_client,
          project = excluded.project,
          workflow = excluded.workflow,
          decision_type = excluded.decision_type,
          selected_option = excluded.selected_option,
          capture_mode = excluded.capture_mode,
          capture_semantic_key = excluded.capture_semantic_key,
          source_event_id = excluded.source_event_id,
          batch_id = excluded.batch_id,
          question_index = excluded.question_index,
          rationale_status = excluded.rationale_status,
          file_path = excluded.file_path,
          content_hash = excluded.content_hash,
          question = excluded.question,
          rationale = excluded.rationale,
          context = excluded.context,
          expected_outcome = excluded.expected_outcome,
          outcome = excluded.outcome,
          outcome_verdict = excluded.outcome_verdict,
          outcome_lesson = excluded.outcome_lesson,
          outcome_reviewed_at = excluded.outcome_reviewed_at,
          review_due_date = excluded.review_due_date,
          applied_principle_ids = excluded.applied_principle_ids,
          file_stamp = excluded.file_stamp
      `)
      .run(
        record.id,
        record.created,
        record.status,
        record.sourceClient,
        record.project,
        record.workflow,
        record.decisionType,
        selectedOption,
        record.captureMode,
        record.captureSemanticKey,
        record.sourceEventId,
        record.batchId,
        record.questionIndex,
        record.rationaleStatus,
        note.path,
        note.contentHash,
        record.question,
        record.rationaleOriginal,
        context.length === 0 ? null : context,
        record.outcome,
        record.outcomeReview?.verdict ?? null,
        record.expectedOutcome ?? null,
        record.outcomeReview?.lesson ?? null,
        record.outcomeReview?.reviewedAt ?? null,
        record.reviewDueDate,
        JSON.stringify(record.appliedPrincipleIds),
        note.stamp ?? null,
      );
    if (replacing) database.prepare("DELETE FROM decisions_fts WHERE rowid = (SELECT rowid FROM decisions WHERE id = ?)").run(record.id);
    // The alternatives weighed too: a decision asked "存储层怎么选？" with its candidates only among the options was not
    // found by the one rejected, nor by the tradeoff written against it.
    const options = record.options.map((option) => [option.label, option.description, ...option.tradeoffs].join(" ")).join("\n");
    database
      .prepare(`
        INSERT INTO decisions_fts (
          rowid, id, question, selected_option, rationale, context, expected_outcome,
          outcome, outcome_lesson, project, tags, options
        ) VALUES ((SELECT rowid FROM decisions WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.id,
        ...[
          record.question,
          selectedOption,
          record.rationaleOriginal ?? "",
          context,
          record.expectedOutcome ?? "",
          record.outcome ?? "",
          record.outcomeReview?.lesson ?? "",
          record.project,
          record.tags.join(" "),
          options,
        ].map(foldedText),
      );
  }

  /**
   * A decision's rows copied as they stand here into a database being filled from empty: its note is still there,
   * only not read now. One read meanwhile under the same id (`filled`) is the one kept.
   */
  #carryOver(target: DatabaseSync, path: string, filled: Set<string>, owed: boolean): void {
    const found = this.#database.prepare("SELECT * FROM decisions WHERE file_path = ?").get(path);
    if (found === undefined || filled.has(String(found.id))) return;
    filled.add(String(found.id));
    // From rows owed a full read (columns filled in from nothing): carried as they were, the note's hash matched once
    // it was back, it was never read, and its review date, principles and tags stayed empty. Marked unread instead.
    const row = owed ? { ...found, content_hash: "", file_stamp: null } : found;
    const columns = Object.keys(row);
    target
      .prepare(`INSERT INTO decisions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...Object.values(row));
    const searched = "id, question, selected_option, rationale, context, expected_outcome, outcome, outcome_lesson, project, tags, options";
    const search = this.#database
      .prepare(`SELECT ${searched} FROM decisions_fts WHERE rowid = (SELECT rowid FROM decisions WHERE file_path = ?)`)
      .get(path);
    if (search === undefined) return;
    // Folded as this build's rows are: carried from rows written before, a word in full width found nothing until
    // the note was read again (folding again what is folded changes nothing).
    const [id, ...texts] = Object.values(search);
    target
      .prepare(`INSERT INTO decisions_fts (rowid, ${searched}) VALUES ((SELECT rowid FROM decisions WHERE id = ?), ${Object.keys(search).map(() => "?").join(", ")})`)
      .run(String(row.id), id ?? null, ...texts.map((text) => (typeof text === "string" ? foldedText(text) : text ?? null)));
  }

  #transaction(operation: () => void): void {
    this.#transactionOn(this.#database, operation);
  }

  #transactionOn(
    database: DatabaseSync,
    operation: () => void,
  ): void {
    database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}
