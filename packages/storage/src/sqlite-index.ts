import type { RationaleStatus } from "@cognelis/decision-core";
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
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  rationaleStatus?: Exclude<RationaleStatus, "not_recorded">;
  sourceClient?: string;
  reviewState?:
    | "pending_outcome"
    | "pending_review"
    | "reviewed"
    | "attention"
    | "due"
    | "scheduled"
    | "unscheduled";
  asOfDate?: string;
  limit?: number;
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
  outcome: string | null;
  outcome_verdict: string | null;
  outcome_lesson: string | null;
  outcome_reviewed_at: string | null;
  review_due_date: string | null;
  applied_principle_ids: string;
}

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
  outcome: row.outcome,
  outcomeVerdict: row.outcome_verdict,
  outcomeLesson: row.outcome_lesson,
  outcomeReviewedAt: row.outcome_reviewed_at,
  reviewDueDate: row.review_due_date,
  appliedPrincipleIds: parseAppliedPrincipleIds(
    row.applied_principle_ids ?? "[]",
  ),
});

const ftsQuery = (query: string): string =>
  query
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");

const searchTokens = (query: string): string[] =>
  query
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);

const escapedLikePattern = (token: string): string =>
  `%${token
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;

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
    }
  }
};

const ensureContextFts = (database: DatabaseSync): void => {
  const columns = (
    database
      .prepare("PRAGMA table_info(decisions_fts)")
      .all() as Array<{ name: string }>
  ).map((column) => column.name);
  if (
    columns.includes("context") &&
    columns.includes("outcome") &&
    columns.includes("outcome_lesson")
  ) {
    return;
  }
  database.exec(`
    DROP TABLE IF EXISTS decisions_fts;
    CREATE VIRTUAL TABLE decisions_fts USING fts5(
      id UNINDEXED,
      question,
      selected_option,
      rationale,
      context,
      outcome,
      outcome_lesson,
      project,
      tags,
      tokenize='trigram'
    );
    INSERT INTO decisions_fts (
      id, question, selected_option, rationale, context, outcome,
      outcome_lesson, project, tags
    )
    SELECT
      id,
      question,
      selected_option,
      coalesce(rationale, ''),
      coalesce(context, ''),
      coalesce(outcome, ''),
      coalesce(outcome_lesson, ''),
      project,
      ''
    FROM decisions;
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
        outcome TEXT,
        outcome_verdict TEXT,
        outcome_lesson TEXT,
        outcome_reviewed_at TEXT,
        review_due_date TEXT,
        applied_principle_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS decisions_rationale_status
        ON decisions(rationale_status, created DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
        id UNINDEXED,
        question,
        selected_option,
        rationale,
        context,
        outcome,
        outcome_lesson,
        project,
        tags,
        tokenize='trigram'
      );
    `);
    ensureCaptureColumns(database);
    ensureContextFts(database);
    database.exec(`
      CREATE INDEX IF NOT EXISTS decisions_capture_semantic
        ON decisions(capture_semantic_key, created);
      CREATE INDEX IF NOT EXISTS decisions_review_due
        ON decisions(review_due_date, outcome_verdict);
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

export class SqliteIndex {
  #database: DatabaseSync;
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    try {
      this.#database = createDatabase(path);
    } catch (error) {
      if (!existsSync(path)) {
        throw error;
      }
      quarantineDatabase(path);
      this.#database = createDatabase(path);
    }
  }

  upsert(note: ParsedStoredNote): void {
    this.#transaction(() =>
      this.#upsertWithoutTransaction(this.#database, note),
    );
  }

  removePath(path: string): void {
    this.#transaction(() => {
      const row = this.#database
        .prepare("SELECT id FROM decisions WHERE file_path = ?")
        .get(path) as { id: string } | undefined;
      if (row === undefined) {
        return;
      }
      this.#database.prepare("DELETE FROM decisions_fts WHERE id = ?").run(row.id);
      this.#database.prepare("DELETE FROM decisions WHERE id = ?").run(row.id);
    });
  }

  rebuild(notes: ParsedStoredNote[]): void {
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.rebuild`;
    let rebuilt: DatabaseSync | null = null;
    let currentClosed = false;
    try {
      rebuilt = createDatabase(temporary);
      this.#transactionOn(rebuilt, () => {
        for (const note of notes) {
          this.#upsertWithoutTransaction(rebuilt as DatabaseSync, note);
        }
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
    const tokens = searchTokens(query.query ?? "");
    const expression = ftsQuery(query.query ?? "");
    const useFts =
      tokens.length > 0 &&
      tokens.every((token) => Array.from(token).length >= 3);
    const boundedLimit = Math.max(
      1,
      Math.min(200, Math.trunc(query.limit ?? 100)),
    );
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (query.decisionId !== undefined) {
      clauses.push("d.id = ?");
      parameters.push(query.decisionId);
    }
    if (useFts) {
      clauses.push("decisions_fts MATCH ?");
      parameters.push(expression);
    } else {
      for (const token of tokens) {
        clauses.push(`(
          d.question LIKE ? ESCAPE '\\' OR
          d.selected_option LIKE ? ESCAPE '\\' OR
          coalesce(d.rationale, '') LIKE ? ESCAPE '\\' OR
          coalesce(d.context, '') LIKE ? ESCAPE '\\' OR
          coalesce(d.outcome, '') LIKE ? ESCAPE '\\' OR
          coalesce(d.outcome_lesson, '') LIKE ? ESCAPE '\\' OR
          d.project LIKE ? ESCAPE '\\'
        )`);
        const pattern = escapedLikePattern(token);
        parameters.push(
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
          pattern,
        );
      }
    }
    if (query.rationaleStatus !== undefined) {
      clauses.push("d.rationale_status = ?");
      parameters.push(query.rationaleStatus);
    }
    if (query.sourceClient !== undefined) {
      clauses.push("d.source_client = ?");
      parameters.push(query.sourceClient);
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
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const order =
      !useFts
        ? query.reviewState === "due" || query.reviewState === "scheduled"
          ? "d.review_due_date ASC, d.created DESC, d.id DESC"
          : "d.created DESC, d.id DESC"
        : "bm25(decisions_fts), d.created DESC, d.id DESC";
    const from =
      !useFts
        ? "decisions d"
        : "decisions_fts JOIN decisions d ON d.id = decisions_fts.id";
    const rows = this.#database
      .prepare(`
        SELECT d.*
        FROM ${from}
        ${where}
        ORDER BY ${order}
        LIMIT ?
      `)
      .all(...parameters, boundedLimit) as unknown as DecisionRow[];
    return rows.map(mapRow);
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

  countSince(created: string): number {
    const row = this.#database
      .prepare(
        "SELECT count(*) AS count FROM decisions WHERE created >= ?",
      )
      .get(created) as { count: number };
    return Number(row.count);
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

  listByRationaleStatus(
    status: Exclude<RationaleStatus, "not_recorded">,
  ): IndexedDecision[] {
    const rows = this.#database
      .prepare(
        "SELECT * FROM decisions WHERE rationale_status = ? ORDER BY created DESC",
      )
      .all(status) as unknown as DecisionRow[];
    return rows.map(mapRow);
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

  #upsertWithoutTransaction(
    database: DatabaseSync,
    note: ParsedStoredNote,
  ): void {
    const record = note.record;
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
          outcome_lesson, outcome_reviewed_at, review_due_date,
          applied_principle_ids
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          outcome = excluded.outcome,
          outcome_verdict = excluded.outcome_verdict,
          outcome_lesson = excluded.outcome_lesson,
          outcome_reviewed_at = excluded.outcome_reviewed_at,
          review_due_date = excluded.review_due_date,
          applied_principle_ids = excluded.applied_principle_ids
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
        record.outcomeReview?.lesson ?? null,
        record.outcomeReview?.reviewedAt ?? null,
        record.reviewDueDate,
        JSON.stringify(record.appliedPrincipleIds),
      );
    database.prepare("DELETE FROM decisions_fts WHERE id = ?").run(record.id);
    database
      .prepare(`
        INSERT INTO decisions_fts (
          id, question, selected_option, rationale, context, outcome,
          outcome_lesson, project, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.question,
        selectedOption,
        record.rationaleOriginal ?? "",
        context,
        record.outcome ?? "",
        record.outcomeReview?.lesson ?? "",
        record.project,
        record.tags.join(" "),
      );
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
