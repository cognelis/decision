import { mkdtemp, open, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SemanticVectorIndex } from "../src/index.js";

// The table as the app before summary vectors made it, word for word.
const OLD_TABLE = `
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
`;

const makeIndex = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-vectors-"));
  return new SemanticVectorIndex(join(root, "vectors.sqlite"));
};

describe("SemanticVectorIndex", () => {
  it("round-trips vectors and replaces stale content atomically", async () => {
    const index = await makeIndex();
    index.upsert([
      {
        entityType: "decision",
        entityId: "decision-1",
        contentHash: "hash-1",
        model: "qwen-embedding-v1",
        vector: [0.6, 0.8],
      },
    ]);

    expect(index.list("decision", "qwen-embedding-v1")).toEqual([
      {
        entityType: "decision",
        entityId: "decision-1",
        contentHash: "hash-1",
        model: "qwen-embedding-v1",
        vector: [expect.closeTo(0.6), expect.closeTo(0.8)],
      },
    ]);

    index.upsert([
      {
        entityType: "decision",
        entityId: "decision-1",
        contentHash: "hash-2",
        sourceHash: "note-2",
        model: "qwen-embedding-v2",
        vector: [1, 0, 0],
      },
    ]);
    expect(index.metadata("decision")).toEqual([
      {
        entityId: "decision-1",
        contentHash: "hash-2",
        sourceHash: "note-2",
        model: "qwen-embedding-v2",
        dimension: 3,
      },
    ]);
    expect(index.list("decision", "qwen-embedding-v1")).toEqual([]);
    index.close();
  });

  it("prunes only missing entities of the requested type", async () => {
    const index = await makeIndex();
    index.upsert([
      {
        entityType: "decision",
        entityId: "keep",
        contentHash: "hash-1",
        model: "model",
        vector: [1, 0],
      },
      {
        entityType: "decision",
        entityId: "remove",
        contentHash: "hash-2",
        model: "model",
        vector: [0, 1],
      },
      {
        entityType: "methodology",
        entityId: "principle-1",
        contentHash: "hash-3",
        model: "model",
        vector: [0.5, 0.5],
      },
    ]);

    index.prune("decision", ["keep"]);

    expect(index.metadata("decision").map((item) => item.entityId)).toEqual([
      "keep",
    ]);
    expect(index.metadata("methodology")).toHaveLength(1);
    index.close();
  });

  it("widens an index made before summaries had vectors, keeping every row it held", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-vectors-"));
    const path = join(root, "vectors.sqlite");
    // As the app before it made it: two kinds allowed, and the note a vector was made from not yet kept.
    const old = new DatabaseSync(path);
    old.exec(OLD_TABLE);
    old.prepare("INSERT INTO semantic_vectors VALUES ('decision', 'd1', 'hash-1', 'model', 2, ?, '2026-10-01T00:00:00.000Z')")
      .run(Buffer.from(new Float32Array([0.6, 0.8]).buffer));
    old.close();

    const index = new SemanticVectorIndex(path);
    index.upsert([{ entityType: "summary", entityId: "DEC-0001", contentHash: "hash-2", sourceHash: "v1:note", model: "model", vector: [1, 0] }]);

    expect(index.metadata("decision")).toEqual([{ entityId: "d1", contentHash: "hash-1", sourceHash: null, model: "model", dimension: 2 }]);
    expect(index.list("decision", "model")[0]?.vector).toEqual([expect.closeTo(0.6), expect.closeTo(0.8)]);
    expect(index.metadata("summary")).toEqual([{ entityId: "DEC-0001", contentHash: "hash-2", sourceHash: "v1:note", model: "model", dimension: 2 }]);
    index.close();
    // Opened again, widened already: nothing more is done to it.
    const again = new SemanticVectorIndex(path);
    expect(again.metadata("summary")).toHaveLength(1);
    again.close();
  });

  it("opens a table it cannot widen just now as it is, holding no summaries until a later start widens it", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-vectors-"));
    const path = join(root, "vectors.sqlite");
    // As the release before left it, its source_hash added; the app quitting still holds the write lock.
    const previous = new DatabaseSync(path);
    previous.exec("PRAGMA journal_mode = WAL");
    previous.exec(OLD_TABLE);
    previous.exec("CREATE INDEX IF NOT EXISTS semantic_vectors_model ON semantic_vectors(entity_type, model)");
    previous.exec("ALTER TABLE semantic_vectors ADD COLUMN source_hash TEXT");
    previous.prepare("INSERT INTO semantic_vectors VALUES ('decision', 'd1', 'hash-1', 'model', 2, ?, 'now', 'v2:note')")
      .run(Buffer.from(new Float32Array([1, 0]).buffer));
    previous.exec("BEGIN IMMEDIATE");

    // Thrown, it stopped the app: "Paraself 无法启动".
    const index = new SemanticVectorIndex(path);
    expect(index.holdsSummaries).toBe(false);
    expect(index.metadata("decision").map((item) => item.entityId)).toEqual(["d1"]);
    index.close();
    previous.exec("ROLLBACK");
    previous.close();

    const later = new SemanticVectorIndex(path);
    expect(later.holdsSummaries).toBe(true);
    later.upsert([{ entityType: "summary", entityId: "DEC-0001", contentHash: "hash-2", sourceHash: "v1:note", model: "model", vector: [0, 1] }]);
    expect(later.metadata("summary")).toHaveLength(1);
    later.close();
  });

  it("sets aside an old table SQLite finds damaged while widening it, and starts it again empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-vectors-"));
    const path = join(root, "vectors.sqlite");
    const previous = new DatabaseSync(path);
    previous.exec("PRAGMA journal_mode = WAL");
    previous.exec(OLD_TABLE);
    previous.exec("CREATE INDEX IF NOT EXISTS semantic_vectors_model ON semantic_vectors(entity_type, model)");
    previous.exec("ALTER TABLE semantic_vectors ADD COLUMN source_hash TEXT");
    previous.prepare("INSERT INTO semantic_vectors VALUES ('decision', 'd1', 'hash-1', 'model', 2, ?, 'now', 'v2:note')")
      .run(Buffer.from(new Float32Array([1, 0]).buffer));
    const { rootpage } = previous.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'semantic_vectors'").get() as { rootpage: number };
    const { page_size: size } = previous.prepare("PRAGMA page_size").get() as { page_size: number };
    previous.close();
    // The table's own page damaged, the schema a start reads first intact: only widening it reads the rows.
    const file = await open(path, "r+");
    await file.write(Buffer.alloc(size, 0xff), 0, size, (rootpage - 1) * size);
    await file.close();

    const index = new SemanticVectorIndex(path);

    // Kept as it was, every read of it said "malformed", and no summary's vector could ever be added.
    expect((await readdir(root)).some((name) => name.startsWith("vectors.sqlite.corrupt-"))).toBe(true);
    expect(index.holdsSummaries).toBe(true);
    expect(index.metadata("decision")).toEqual([]);
    index.close();
  });

  it("stays readable to the app before it, which asks only for its own kinds", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-vectors-"));
    const path = join(root, "vectors.sqlite");
    const index = new SemanticVectorIndex(path);
    index.upsert([
      { entityType: "decision", entityId: "d1", contentHash: "hash-1", sourceHash: "v2:note", model: "model", vector: [1, 0] },
      { entityType: "summary", entityId: "DEC-0001", contentHash: "hash-2", sourceHash: "v1:note", model: "model", vector: [0, 1] },
    ]);
    index.close();

    // The app before it opens it as it always did, then reads, writes and prunes decisions by their kind.
    const previous = new DatabaseSync(path);
    previous.exec(OLD_TABLE);
    previous.exec("CREATE INDEX IF NOT EXISTS semantic_vectors_model ON semantic_vectors(entity_type, model)");
    expect((previous.prepare("PRAGMA table_info(semantic_vectors)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("source_hash");
    expect(previous.prepare("SELECT entity_id FROM semantic_vectors WHERE entity_type = ?").all("decision")).toEqual([{ entity_id: "d1" }]);
    previous.prepare("INSERT INTO semantic_vectors (entity_type, entity_id, content_hash, model, dimension, vector, updated_at, source_hash) VALUES ('decision', 'd2', 'hash-3', 'model', 2, ?, 'now', NULL)")
      .run(Buffer.from(new Float32Array([1, 0]).buffer));
    previous.prepare("DELETE FROM semantic_vectors WHERE entity_type = ? AND entity_id = ?").run("decision", "d1");
    previous.close();

    const reopened = new SemanticVectorIndex(path);
    expect(reopened.metadata("decision").map((item) => item.entityId)).toEqual(["d2"]);
    expect(reopened.metadata("summary").map((item) => item.entityId)).toEqual(["DEC-0001"]);
    reopened.close();
  });

  it("sets a cache SQLite cannot read aside and starts it again empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-vectors-"));
    const path = join(root, "vectors.sqlite");
    await writeFile(path, "this was half a sqlite file before the disk went".repeat(200));

    const index = new SemanticVectorIndex(path);

    expect(index.metadata("decision")).toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith("vectors.sqlite.corrupt-"))).toBe(true);
    index.close();
  });
});
