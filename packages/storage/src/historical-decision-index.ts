import type { HistoricalDecision, HistoricalDecisionEvent, ListHistoricalDecisionsRequest } from "@cognelis/decision-protocol";
import { HISTORICAL_DECISION_LIMITS, historicalDecisionChangeSchema } from "@cognelis/decision-protocol";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { StoredHistoricalDecision } from "./historical-decision.js";
import { foldedText, searchTokens } from "./search-text.js";

type Filters = Omit<ListHistoricalDecisionsRequest, "version">;

const historicalChanges = historicalDecisionChangeSchema.array().max(20);

/** What a search looks through: the text a person reads on a record, and its id. */
const searchable = (record: HistoricalDecision): string => foldedText([
  record.id, record.title, record.decision, record.context, record.notes, record.project, record.scope,
  ...record.options, ...record.tags, ...record.participants,
].filter((part): part is string => part !== null).join("\n"));

/**
 * 历史决定 on this machine, beside the App and outside the vault: an index made from the notes, to filter and page
 * them without reading each again, and the history of changes to each, which the notes do not carry. Its own
 * tables in its own file: nothing here is a `decisions` row or a vector, so no decision search reads it.
 *
 * The index rows can be made again from the vault at any time (rebuild). The history cannot: rebuild leaves it be.
 */
export class HistoricalDecisionIndex {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS historical_decisions (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL, note_path TEXT NOT NULL, decided_on TEXT NOT NULL, status TEXT NOT NULL,
        project TEXT, reversibility TEXT, tags TEXT NOT NULL, search TEXT NOT NULL, record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS historical_decisions_by_day ON historical_decisions (decided_on DESC, id DESC);
      CREATE TABLE IF NOT EXISTS historical_decision_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, changes TEXT
      );
      CREATE INDEX IF NOT EXISTS historical_decision_events_by_record ON historical_decision_events (id, seq DESC);
      CREATE TABLE IF NOT EXISTS historical_decision_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // An index kept before changes were (IMP-207's first version) gains the column; its rows keep none.
    if (this.#db.prepare("SELECT 1 FROM pragma_table_info('historical_decision_events') WHERE name = 'changes'").get() === undefined) {
      this.#db.exec("ALTER TABLE historical_decision_events ADD COLUMN changes TEXT");
    }
  }

  /** Brings the rows to what the vault holds, in one transaction: a note that reads differently is written again, one gone is dropped. */
  sync(stored: readonly StoredHistoricalDecision[], now: Date): void {
    const stale = new Map(this.#db.prepare("SELECT id, hash, note_path FROM historical_decisions").all().map((row) => [String(row.id), `${String(row.hash)}\n${String(row.note_path)}`]));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const upsert = this.#db.prepare(`INSERT INTO historical_decisions (id, hash, note_path, decided_on, status, project, reversibility, tags, search, record)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET hash = excluded.hash, note_path = excluded.note_path, decided_on = excluded.decided_on, status = excluded.status,
          project = excluded.project, reversibility = excluded.reversibility, tags = excluded.tags, search = excluded.search, record = excluded.record`);
      for (const { record, hash, notePath } of stored) {
        const unchanged = stale.get(record.id) === `${hash}\n${notePath}`;
        stale.delete(record.id);
        if (unchanged) continue;
        upsert.run(record.id, hash, notePath, record.decidedOn, record.status, record.project, record.reversibility, JSON.stringify(record.tags), searchable(record), JSON.stringify(record));
      }
      const drop = this.#db.prepare("DELETE FROM historical_decisions WHERE id = ?");
      for (const id of stale.keys()) drop.run(id);
      this.#db.prepare("INSERT INTO historical_decision_meta (key, value) VALUES ('synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now.toISOString());
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Every row made again from the vault. The history of changes is not the vault's to remake, and stays. */
  rebuild(stored: readonly StoredHistoricalDecision[], now: Date): void {
    this.#db.exec("DELETE FROM historical_decisions");
    this.sync(stored, now);
  }

  /** One page of the records that match, newest decision first, and how many match in all. */
  query(filters: Filters): { records: HistoricalDecision[]; total: number } {
    const where: string[] = [];
    const values: Array<string | number> = [];
    const add = (clause: string, ...bound: Array<string | number>): void => { where.push(clause); values.push(...bound); };
    if (filters.status !== undefined) add("status = ?", filters.status);
    else if (filters.includeWithdrawn !== true) add("status != 'withdrawn'");
    if (filters.project !== undefined) add("project = ?", filters.project);
    if (filters.reversibility !== undefined) add("reversibility = ?", filters.reversibility);
    if (filters.tag !== undefined) add("EXISTS (SELECT 1 FROM json_each(historical_decisions.tags) WHERE json_each.value = ?)", filters.tag);
    if (filters.fromDate !== undefined) add("decided_on >= ?", filters.fromDate);
    if (filters.toDate !== undefined) add("decided_on <= ?", filters.toDate);
    if (filters.promotedDecisionId !== undefined) add("json_extract(record, '$.promotedDecisionId') = ?", filters.promotedDecisionId);
    for (const token of searchTokens(filters.query ?? "")) add("instr(search, ?) > 0", token);
    const condition = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const limit = Math.min(filters.limit ?? HISTORICAL_DECISION_LIMITS.page, HISTORICAL_DECISION_LIMITS.page);
    const rows = this.#db.prepare(`SELECT record FROM historical_decisions ${condition} ORDER BY decided_on DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, filters.offset ?? 0);
    const count = this.#db.prepare(`SELECT count(*) AS total FROM historical_decisions ${condition}`).get(...values)!;
    return { records: rows.map((row) => JSON.parse(String(row.record)) as HistoricalDecision), total: Number(count.total) };
  }

  /** What the filters offer: every project and tag in use, and how many records are kept in all. */
  facets(): { kept: number; projects: string[]; tags: string[] } {
    const kept = Number(this.#db.prepare("SELECT count(*) AS total FROM historical_decisions").get()!.total);
    const projects = this.#db.prepare("SELECT DISTINCT project FROM historical_decisions WHERE project IS NOT NULL ORDER BY project LIMIT 500").all().map((row) => String(row.project));
    const tags = this.#db.prepare("SELECT DISTINCT json_each.value AS tag FROM historical_decisions, json_each(historical_decisions.tags) ORDER BY tag LIMIT 500").all().map((row) => String(row.tag));
    return { kept, projects, tags };
  }

  syncedAt(): string | null {
    const row = this.#db.prepare("SELECT value FROM historical_decision_meta WHERE key = 'synced_at'").get();
    return row === undefined ? null : String(row.value);
  }

  // ponytail: kept for good, a row a change; trim per record if a record is ever changed thousands of times.
  appendEvent(id: string, event: HistoricalDecisionEvent): void {
    this.#db.prepare("INSERT INTO historical_decision_events (id, at, actor, kind, summary, changes) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, event.at, event.actor, event.kind, event.summary, event.changes === undefined || event.changes.length === 0 ? null : JSON.stringify(event.changes));
  }

  /** A record's changes, newest first. */
  events(id: string): HistoricalDecisionEvent[] {
    return this.#db.prepare("SELECT at, actor, kind, summary, changes FROM historical_decision_events WHERE id = ? ORDER BY seq DESC LIMIT ?").all(id, HISTORICAL_DECISION_LIMITS.history)
      .map((row) => {
        // A row whose changes do not read is still the change it says it was: only what it rewrote is left out.
        const changes = typeof row.changes === "string" ? historicalChanges.safeParse((() => { try { return JSON.parse(row.changes); } catch { return null; } })()) : null;
        return {
          at: String(row.at), actor: String(row.actor), kind: String(row.kind) as HistoricalDecisionEvent["kind"], summary: String(row.summary),
          ...(changes?.success === true ? { changes: changes.data } : {}),
        };
      });
  }

  close(): void {
    this.#db.close();
  }
}
