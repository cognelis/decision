import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openRebuildable } from "./sqlite-index.js";

export type SemanticVectorEntityType = "decision" | "methodology";

export interface SemanticVectorRecord {
  entityType: SemanticVectorEntityType;
  entityId: string;
  contentHash: string;
  /** The content hash of the note its text was made from, where there is one (a decision's). */
  sourceHash?: string | null;
  model: string;
  vector: number[];
}

export interface SemanticVectorMetadata {
  entityId: string;
  contentHash: string;
  sourceHash: string | null;
  model: string;
  dimension: number;
}

interface VectorRow {
  entity_type: SemanticVectorEntityType;
  entity_id: string;
  content_hash: string;
  model: string;
  dimension: number;
  vector: Uint8Array;
}

const encodeVector = (vector: number[]): Buffer => {
  if (
    vector.length === 0 ||
    vector.length > 8_192 ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Semantic vector is invalid");
  }
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, index) => {
    buffer.writeFloatLE(value, index * 4);
  });
  return buffer;
};

const decodeVector = (row: VectorRow): number[] => {
  const buffer = Buffer.from(row.vector);
  if (
    row.dimension < 1 ||
    row.dimension > 8_192 ||
    buffer.byteLength !== row.dimension * 4
  ) {
    throw new Error(`Stored semantic vector is invalid: ${row.entity_id}`);
  }
  return Array.from({ length: row.dimension }, (_, index) =>
    buffer.readFloatLE(index * 4),
  );
};

const openVectors = (path: string): DatabaseSync => {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS semantic_vectors (
        entity_type TEXT NOT NULL CHECK(entity_type IN ('decision', 'methodology')),
        entity_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(entity_type, entity_id)
      );
      CREATE INDEX IF NOT EXISTS semantic_vectors_model
        ON semantic_vectors(entity_type, model);
    `);
    // The note a decision's vector was made from: a start reads again only a decision whose note changed since.
    // Unknown for vectors from before it, whose decisions are read once more and kept as found, not embedded again.
    const columns = (database.prepare("PRAGMA table_info(semantic_vectors)").all() as Array<{ name: string }>).map((column) => column.name);
    if (!columns.includes("source_hash")) database.exec("ALTER TABLE semantic_vectors ADD COLUMN source_hash TEXT");
    chmodSync(path, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export class SemanticVectorIndex {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Only a cache of what the notes say: one SQLite cannot read is set aside and filled again, as the index is,
    // rather than keeping the app from opening.
    this.#database = openRebuildable(path, openVectors);
  }

  metadata(entityType: SemanticVectorEntityType): SemanticVectorMetadata[] {
    return (
      this.#database
        .prepare(`
          SELECT entity_id, content_hash, source_hash, model, dimension
          FROM semantic_vectors
          WHERE entity_type = ?
          ORDER BY entity_id
        `)
        .all(entityType) as Array<{
        entity_id: string;
        content_hash: string;
        source_hash: string | null;
        model: string;
        dimension: number;
      }>
    ).map((row) => ({
      entityId: row.entity_id,
      contentHash: row.content_hash,
      sourceHash: row.source_hash,
      model: row.model,
      dimension: row.dimension,
    }));
  }

  /** Vectors found still to be of these notes' text: kept as made from them, so the next start reads them not. */
  keepSources(entityType: SemanticVectorEntityType, sources: ReadonlyArray<readonly [entityId: string, sourceHash: string]>): void {
    if (sources.length === 0) return;
    const statement = this.#database.prepare("UPDATE semantic_vectors SET source_hash = ? WHERE entity_type = ? AND entity_id = ?");
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const [entityId, sourceHash] of sources) statement.run(sourceHash, entityType, entityId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  upsert(records: SemanticVectorRecord[]): void {
    if (records.length === 0) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.#database.prepare(`
        INSERT INTO semantic_vectors (
          entity_type, entity_id, content_hash, model,
          dimension, vector, updated_at, source_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          source_hash = excluded.source_hash,
          model = excluded.model,
          dimension = excluded.dimension,
          vector = excluded.vector,
          updated_at = excluded.updated_at
      `);
      const updatedAt = new Date().toISOString();
      for (const record of records) {
        const vector = encodeVector(record.vector);
        statement.run(
          record.entityType,
          record.entityId,
          record.contentHash,
          record.model,
          record.vector.length,
          vector,
          updatedAt,
          record.sourceHash ?? null,
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  list(
    entityType: SemanticVectorEntityType,
    model: string,
  ): SemanticVectorRecord[] {
    const rows = this.#database
      .prepare(`
        SELECT entity_type, entity_id, content_hash, model, dimension, vector
        FROM semantic_vectors
        WHERE entity_type = ? AND model = ?
        ORDER BY entity_id
      `)
      .all(entityType, model) as unknown as VectorRow[];
    return rows.map((row) => ({
      entityType: row.entity_type,
      entityId: row.entity_id,
      contentHash: row.content_hash,
      model: row.model,
      vector: decodeVector(row),
    }));
  }

  prune(entityType: SemanticVectorEntityType, activeIds: string[]): void {
    const active = new Set(activeIds);
    const stored = this.metadata(entityType);
    const statement = this.#database.prepare(
      "DELETE FROM semantic_vectors WHERE entity_type = ? AND entity_id = ?",
    );
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of stored) {
        if (!active.has(item.entityId)) {
          statement.run(entityType, item.entityId);
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  clear(): void {
    this.#database.exec("DELETE FROM semantic_vectors");
  }

  close(): void {
    this.#database.close();
  }
}
