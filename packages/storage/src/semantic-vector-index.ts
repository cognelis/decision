import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SemanticVectorEntityType = "decision" | "methodology";

export interface SemanticVectorRecord {
  entityType: SemanticVectorEntityType;
  entityId: string;
  contentHash: string;
  model: string;
  vector: number[];
}

export interface SemanticVectorMetadata {
  entityId: string;
  contentHash: string;
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

export class SemanticVectorIndex {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
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
    chmodSync(path, 0o600);
  }

  metadata(entityType: SemanticVectorEntityType): SemanticVectorMetadata[] {
    return (
      this.#database
        .prepare(`
          SELECT entity_id, content_hash, model, dimension
          FROM semantic_vectors
          WHERE entity_type = ?
          ORDER BY entity_id
        `)
        .all(entityType) as Array<{
        entity_id: string;
        content_hash: string;
        model: string;
        dimension: number;
      }>
    ).map((row) => ({
      entityId: row.entity_id,
      contentHash: row.content_hash,
      model: row.model,
      dimension: row.dimension,
    }));
  }

  upsert(records: SemanticVectorRecord[]): void {
    if (records.length === 0) return;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.#database.prepare(`
        INSERT INTO semantic_vectors (
          entity_type, entity_id, content_hash, model,
          dimension, vector, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_id) DO UPDATE SET
          content_hash = excluded.content_hash,
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
