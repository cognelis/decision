import type { DecisionRecord } from "@cognelis/decision-core";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseDecision, serializeDecision } from "./markdown.js";

/** Primary data, separate from the disposable vault index. Resolved IDs prevent capture replay from resurrecting content. */
export class LocalDecisionStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS local_decisions (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, question TEXT NOT NULL, created TEXT NOT NULL,
        content TEXT, state TEXT NOT NULL CHECK(state IN ('local', 'published', 'discarded'))
      );`);
  }
  save(record: DecisionRecord, content = serializeDecision(record)): void {
    if (parseDecision(content).id !== record.id) throw new Error("本机记录编号与正文不一致。");
    const known = this.#db.prepare("SELECT content, state FROM local_decisions WHERE id = ?").get(record.id);
    if (known) {
      if (known.state === "local" && known.content !== content) throw new Error("本机已有同编号的不同记录，请先整理现有记录。");
      return;
    }
    this.#db.prepare("INSERT INTO local_decisions VALUES (?, ?, ?, ?, ?, 'local')").run(record.id, record.project, record.question, record.created, content);
  }
  has(id: string): boolean { return this.#db.prepare("SELECT 1 FROM local_decisions WHERE id = ?").get(id) !== undefined; }
  content(id: string): string | null {
    const row = this.#db.prepare("SELECT content FROM local_decisions WHERE id = ? AND state = 'local'").get(id);
    return row ? String(row.content) : null;
  }
  get(id: string): DecisionRecord | null {
    const content = this.content(id);
    return content === null ? null : parseDecision(content);
  }
  list(query = "", offset = 0): { records: DecisionRecord[]; total: number } {
    const where = "state = 'local' AND instr(lower(project || ' ' || content), lower(?)) > 0";
    const rows = this.#db.prepare(`SELECT content FROM local_decisions WHERE ${where} ORDER BY project, question, created DESC, id LIMIT 100 OFFSET ?`).all(query, offset);
    const count = this.#db.prepare(`SELECT count(*) AS total FROM local_decisions WHERE ${where}`).get(query)!;
    return { records: rows.map(row => parseDecision(String(row.content))), total: Number(count.total) };
  }
  resolve(id: string, state: "published" | "discarded"): void {
    // No question, project or正文 remains after deletion; only the ID and disposition are needed for replay.
    this.#db.prepare("UPDATE local_decisions SET state = ?, content = NULL, project = '', question = '', created = '' WHERE id = ? AND state = 'local'").run(state, id);
  }
  close(): void { this.#db.close(); }
}
