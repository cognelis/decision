import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  ObsidianSearchIndex,
  ObsidianSearchIndexSchemaError,
  ObsidianSearchIndexUnavailableError,
  type ObsidianIndexedNoteInput,
} from "../src/index.js";

const roots = new Set<string>();
const indexes = new Set<ObsidianSearchIndex>();
const APPLICATION_ID = 0x4449534c;

interface InternalOptions {
  databaseFactory?: (
    path: string,
    options: { timeout: number },
  ) => DatabaseSync;
  onDecodeChunk?: () => void;
}

const InternalObsidianSearchIndex = ObsidianSearchIndex as unknown as new (
  path: string,
  options: InternalOptions,
) => ObsidianSearchIndex;

const temporaryPath = (nested = false): string => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-index-"));
  roots.add(root);
  return nested
    ? join(root, "private", "nested", "index.sqlite")
    : join(root, "index.sqlite");
};

const openIndex = (
  path = temporaryPath(),
  options?: InternalOptions,
): ObsidianSearchIndex => {
  const index = options
    ? new InternalObsidianSearchIndex(path, options)
    : new ObsidianSearchIndex(path);
  indexes.add(index);
  return index;
};

afterEach(() => {
  for (const index of indexes) index.close();
  indexes.clear();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

const semanticNote = (
  relativePath = "notes/semantic.md",
  model = "embedding-a",
): ObsidianIndexedNoteInput => ({
  relativePath,
  title: "Semantic title",
  contentHash: "note-hash",
  size: 42.5,
  modifiedAtMs: 1_765_432_100.25,
  model,
  chunks: [
    {
      id: `${relativePath}#0`,
      ordinal: 0,
      heading: "Parent / Child",
      text: "first semantic chunk",
      contentHash: "chunk-hash-0",
      vector: [1.25, -2.5, 0.125],
    },
    {
      id: `${relativePath}#1`,
      ordinal: 1,
      heading: null,
      text: "second semantic chunk",
      contentHash: "chunk-hash-1",
      vector: [3.5, 4.75, -5.125],
    },
  ],
});

const keywordNote = (
  relativePath = "notes/keyword.MD",
): ObsidianIndexedNoteInput => ({
  relativePath,
  title: "Keyword title",
  contentHash: "keyword-note-hash",
  size: 9.75,
  modifiedAtMs: 2_000.5,
  model: null,
  chunks: [
    {
      id: `${relativePath}#0`,
      ordinal: 0,
      heading: "",
      text: "keyword chunk",
      contentHash: "keyword-chunk-hash",
      vector: null,
    },
  ],
});

const state = (index: ObsidianSearchIndex) => ({
  metadata: index.noteMetadata(),
  chunks: index.listChunks(),
});

const expectRejectedWithoutMutation = (
  index: ObsidianSearchIndex,
  candidate: unknown,
): void => {
  const before = state(index);
  expect(() =>
    index.replaceNote(candidate as ObsidianIndexedNoteInput),
  ).toThrow();
  expect(state(index)).toEqual(before);
};

const withRawDatabase = (
  path: string,
  mutate: (database: DatabaseSync) => void,
): void => {
  const database = new DatabaseSync(path);
  try {
    mutate(database);
  } finally {
    database.close();
  }
};

const closeCountingFactory =
  (
    counter: { value: number },
    prepareOverride?: (
      sql: string,
      database: DatabaseSync,
    ) => StatementSync | undefined,
  ): NonNullable<InternalOptions["databaseFactory"]> =>
  (path, options) => {
    const database = new DatabaseSync(path, options);
    return {
      close() {
        counter.value += 1;
        database.close();
      },
      exec: database.exec.bind(database),
      prepare(sql: string) {
        return prepareOverride?.(sql, database) ?? database.prepare(sql);
      },
    } as DatabaseSync;
  };

interface BoundedQueryCounters {
  prepare: number;
  get: number;
  all: number;
  iterate: number;
}

const boundedQueryFactory =
  (
    counters: BoundedQueryCounters,
  ): NonNullable<InternalOptions["databaseFactory"]> =>
  (path, options) => {
    const database = new DatabaseSync(path, options);
    return {
      close: database.close.bind(database),
      exec: database.exec.bind(database),
      prepare(sql: string) {
        const statement = database.prepare(sql);
        const boundedMetadataQuery =
          sql.includes("total_notes") ||
          sql.includes("metadata_for_path") ||
          sql.includes("note_descendant");
        if (!boundedMetadataQuery) return statement;
        counters.prepare += 1;
        return {
          get(...parameters: SQLInputValue[]) {
            counters.get += 1;
            return statement.get(...parameters);
          },
          all() {
            counters.all += 1;
            throw new Error("bounded metadata query must not call all()");
          },
          iterate() {
            counters.iterate += 1;
            throw new Error("bounded metadata query must not call iterate()");
          },
        } as unknown as StatementSync;
      },
    } as DatabaseSync;
  };

const closeTracked = (index: ObsidianSearchIndex): void => {
  index.close();
  indexes.delete(index);
};

describe("ObsidianSearchIndex round trips", () => {
  it("round-trips every semantic note and chunk field", () => {
    const index = openIndex();
    const input = semanticNote();
    index.replaceNote(input);
    expect(index.noteMetadata()).toEqual([
      {
        relativePath: input.relativePath,
        title: input.title,
        contentHash: input.contentHash,
        size: input.size,
        modifiedAtMs: input.modifiedAtMs,
        model: input.model,
        indexedAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
        ),
      },
    ]);
    expect(index.listChunks()).toEqual([
      {
        id: "notes/semantic.md#0",
        relativePath: "notes/semantic.md",
        ordinal: 0,
        title: "Semantic title",
        heading: "Parent / Child",
        text: "first semantic chunk",
        contentHash: "chunk-hash-0",
        model: "embedding-a",
        vector: [
          expect.closeTo(1.25),
          expect.closeTo(-2.5),
          expect.closeTo(0.125),
        ],
      },
      {
        id: "notes/semantic.md#1",
        relativePath: "notes/semantic.md",
        ordinal: 1,
        title: "Semantic title",
        heading: null,
        text: "second semantic chunk",
        contentHash: "chunk-hash-1",
        model: "embedding-a",
        vector: [
          expect.closeTo(3.5),
          expect.closeTo(4.75),
          expect.closeTo(-5.125),
        ],
      },
    ]);
  });

  it("round-trips every keyword-only field with null vectors", () => {
    const index = openIndex();
    const input = keywordNote();
    index.replaceNote(input);
    expect(index.noteMetadata()).toEqual([
      {
        relativePath: input.relativePath,
        title: input.title,
        contentHash: input.contentHash,
        size: input.size,
        modifiedAtMs: input.modifiedAtMs,
        model: input.model,
        indexedAt: expect.stringMatching(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
        ),
      },
    ]);
    expect(index.listChunks()).toEqual([
      {
        id: "notes/keyword.MD#0",
        relativePath: "notes/keyword.MD",
        ordinal: 0,
        title: "Keyword title",
        heading: "",
        text: "keyword chunk",
        contentHash: "keyword-chunk-hash",
        model: null,
        vector: null,
      },
    ]);
  });

  it("sorts notes and chunks, reports exact counts, and distinguishes present and absent notes", () => {
    const index = openIndex();
    index.replaceNote(semanticNote("z-last.md"));
    index.replaceNote(keywordNote("a-first.md"));
    expect(
      index.noteMetadata().map(({ relativePath }) => relativePath),
    ).toEqual(["a-first.md", "z-last.md"]);
    expect(index.listChunks().map(({ id }) => id)).toEqual([
      "a-first.md#0",
      "z-last.md#0",
      "z-last.md#1",
    ]);
    expect(index.snapshot()).toEqual({
      noteCount: 2,
      chunkCount: 3,
      synchronizedAt: null,
    });
    expect(index.hasNote("a-first.md")).toBe(true);
    expect(index.hasNote("missing.md")).toBe(false);
  });

  it("filters chunks by the exact semantic model", () => {
    const index = openIndex();
    index.replaceNote(semanticNote("alpha.md", "embedding-a"));
    index.replaceNote(semanticNote("beta.md", "embedding-b"));
    index.replaceNote(keywordNote("keyword.md"));
    expect(
      index.listChunks("embedding-a").map(({ relativePath }) => relativePath),
    ).toEqual(["alpha.md", "alpha.md"]);
    expect(
      index.listChunks("embedding-a").every(({ vector }) => vector !== null),
    ).toBe(true);
    expect(index.listChunks("embedding-missing")).toEqual([]);
  });

  it("accepts multiple same-dimension semantic chunks", () => {
    const index = openIndex();
    index.replaceNote(semanticNote());
    expect(
      index.listChunks("embedding-a").map(({ vector }) => vector?.length),
    ).toEqual([3, 3]);
  });
});

describe("ObsidianSearchIndex atomic replacement and pruning", () => {
  it("replaces stale chunks and metadata while preserving another note", () => {
    const index = openIndex();
    index.replaceNote(semanticNote("a.md"));
    index.replaceNote(keywordNote("b.md"));
    index.replaceNote({
      ...semanticNote("a.md", "embedding-new"),
      title: "Updated title",
      contentHash: "updated-note-hash",
      size: 88.25,
      modifiedAtMs: 99.5,
      chunks: [
        {
          id: "a-new",
          ordinal: 0,
          heading: "Updated heading",
          text: "replacement",
          contentHash: "updated-chunk-hash",
          vector: [9, 8],
        },
      ],
    });
    expect(index.noteMetadata()).toEqual([
      expect.objectContaining({
        relativePath: "a.md",
        title: "Updated title",
        contentHash: "updated-note-hash",
        size: 88.25,
        modifiedAtMs: 99.5,
        model: "embedding-new",
      }),
      expect.objectContaining({
        relativePath: "b.md",
        title: "Keyword title",
        model: null,
      }),
    ]);
    expect(index.listChunks().map(({ id }) => id)).toEqual(["a-new", "b.md#0"]);
  });

  it("fully restores existing note B and note A after a cross-note ID collision", () => {
    const index = openIndex();
    index.replaceNote(semanticNote("a.md"));
    index.replaceNote(keywordNote("b.md"));
    const before = state(index);
    expect(() =>
      index.replaceNote({
        ...semanticNote("b.md", "changed-model"),
        title: "Changed title",
        contentHash: "changed hash",
        chunks: [{ ...semanticNote("b.md").chunks[0]!, id: "a.md#0" }],
      }),
    ).toThrow();
    expect(state(index)).toEqual(before);
  });

  it("prunes removed notes and cascades their chunks while keeping active notes", () => {
    const index = openIndex();
    index.replaceNote(semanticNote("keep.md"));
    index.replaceNote(keywordNote("remove.md"));
    index.prune(["keep.md"]);
    expect(
      index.noteMetadata().map(({ relativePath }) => relativePath),
    ).toEqual(["keep.md"]);
    expect(index.listChunks().map(({ relativePath }) => relativePath)).toEqual([
      "keep.md",
      "keep.md",
    ]);
    expect(index.snapshot()).toMatchObject({ noteCount: 1, chunkCount: 2 });
  });

  it("prunes a vault with more notes than SQLite binds variables for", () => {
    const index = openIndex();
    index.replaceNote(semanticNote("keep.md"));
    index.replaceNote(keywordNote("remove.md"));
    // One variable per active note stopped at 32,766: a larger vault failed every sync.
    index.prune(["keep.md", ...Array.from({ length: 32_767 }, (_unused, position) => `vault/${position}.md`)]);
    expect(index.noteMetadata().map(({ relativePath }) => relativePath)).toEqual(["keep.md"]);
  });

  it("prune([]) clears all notes and chunks while retaining synchronizedAt", () => {
    const index = openIndex();
    index.replaceNote(semanticNote());
    index.markSynchronized("2026-08-18T01:02:03.004Z");
    index.prune([]);
    expect(index.noteMetadata()).toEqual([]);
    expect(index.listChunks()).toEqual([]);
    expect(index.snapshot()).toEqual({
      noteCount: 0,
      chunkCount: 0,
      synchronizedAt: "2026-08-18T01:02:03.004Z",
    });
  });
});

describe("ObsidianSearchIndex model dimensions", () => {
  it("registers the first dimension used by a semantic model", () => {
    const path = temporaryPath();
    const index = openIndex(path);
    index.replaceNote(semanticNote("first.md", "shared-model"));

    withRawDatabase(path, (database) => {
      expect(
        database.prepare("SELECT model, dimension FROM models").all(),
      ).toEqual([{ model: "shared-model", dimension: 3 }]);
    });
  });

  it("rejects a second note whose shared model has a different dimension before mutation", () => {
    let begins = 0;
    let rollbacks = 0;
    const index = openIndex(temporaryPath(), {
      databaseFactory: (path, options) => {
        const database = new DatabaseSync(path, options);
        return {
          close: database.close.bind(database),
          prepare: database.prepare.bind(database),
          exec(sql: string) {
            if (sql === "BEGIN") begins += 1;
            if (sql === "BEGIN IMMEDIATE") begins += 1;
            if (sql === "ROLLBACK") rollbacks += 1;
            database.exec(sql);
          },
        } as DatabaseSync;
      },
    });
    index.replaceNote(semanticNote("first.md", "shared-model"));
    const before = state(index);
    const beginsBeforeMismatch = begins;
    const rollbacksBeforeMismatch = rollbacks;
    const mismatch = semanticNote("second.md", "shared-model");
    mismatch.chunks = [{ ...mismatch.chunks[0]!, vector: [1, 2] }];

    expect(() => index.replaceNote(mismatch)).toThrow();

    expect(state(index)).toEqual(before);
    expect(index.hasNote("second.md")).toBe(false);
    expect(begins).toBe(beginsBeforeMismatch + 1);
    expect(rollbacks).toBe(rollbacksBeforeMismatch + 1);
  });

  it("allows a different semantic model to use a different dimension", () => {
    const index = openIndex();
    index.replaceNote(semanticNote("three.md", "three-dimensional"));
    const twoDimensions = semanticNote("two.md", "two-dimensional");
    twoDimensions.chunks = [{ ...twoDimensions.chunks[0]!, vector: [1, 2] }];

    index.replaceNote(twoDimensions);

    expect(index.listChunks("three-dimensional")[0]?.vector).toHaveLength(3);
    expect(index.listChunks("two-dimensional")[0]?.vector).toHaveLength(2);
  });

  it("serializes competing first claims from two real index connections", () => {
    const path = temporaryPath();
    let armed = false;
    let competitor: ObsidianSearchIndex | undefined;
    const first = openIndex(path, {
      databaseFactory: (databasePath, options) => {
        const database = new DatabaseSync(databasePath, options);
        return {
          close: database.close.bind(database),
          prepare: database.prepare.bind(database),
          exec(sql: string) {
            if (armed && (sql === "BEGIN" || sql === "BEGIN IMMEDIATE")) {
              armed = false;
              const competing = semanticNote(
                "competitor.md",
                "contended-model",
              );
              competing.chunks = [{ ...competing.chunks[0]!, vector: [1, 2] }];
              competitor?.replaceNote(competing);
            }
            database.exec(sql);
          },
        } as DatabaseSync;
      },
    });
    competitor = openIndex(path);
    const candidate = semanticNote("candidate.md", "contended-model");
    candidate.chunks = [{ ...candidate.chunks[0]!, vector: [1, 2, 3] }];
    armed = true;

    expect(() => first.replaceNote(candidate)).toThrow(
      "Semantic model dimension mismatch",
    );

    expect(
      competitor.noteMetadata().map(({ relativePath }) => relativePath),
    ).toEqual(["competitor.md"]);
    expect(competitor.listChunks()).toEqual([
      expect.objectContaining({
        relativePath: "competitor.md",
        model: "contended-model",
        vector: [expect.closeTo(1), expect.closeTo(2)],
      }),
    ]);
  });

  it.each([
    [
      "a corrupt registry dimension",
      (database: DatabaseSync) =>
        database.exec(
          "PRAGMA ignore_check_constraints=ON; UPDATE models SET dimension=2",
        ),
    ],
    [
      "a missing registry row",
      (database: DatabaseSync) => database.exec("DELETE FROM models"),
    ],
    [
      "a chunk dimension that disagrees with its registry",
      (database: DatabaseSync) =>
        database.exec("UPDATE chunks SET dimension=2, vector=zeroblob(8)"),
    ],
  ])("rejects %s from both list and iteration", (_name, corrupt) => {
    const path = temporaryPath();
    let index = openIndex(path);
    index.replaceNote(semanticNote());
    closeTracked(index);
    withRawDatabase(path, corrupt);
    index = openIndex(path);

    expect(() => index.listChunks()).toThrow(
      "Corrupt Obsidian search index entry: notes/semantic.md",
    );
    expect(() => index.iterateChunks().next()).toThrow(
      "Corrupt Obsidian search index entry: notes/semantic.md",
    );
  });
});

describe("ObsidianSearchIndex streaming", () => {
  it("decodes only consumed rows and releases an iterator returned early", () => {
    let decoded = 0;
    const index = openIndex(temporaryPath(), {
      onDecodeChunk: () => {
        decoded += 1;
      },
    });
    const candidate = semanticNote("many.md", "stream-model");
    candidate.chunks = Array.from({ length: 2_000 }, (_, ordinal) => ({
      id: `many-${ordinal}`,
      ordinal,
      heading: null,
      text: `chunk ${ordinal}`,
      contentHash: `hash-${ordinal}`,
      vector: [0.25, 0.5, 0.75],
    }));
    index.replaceNote(candidate);

    const iterator = index.iterateChunks("stream-model");
    const consumed = Array.from({ length: 7 }, () => iterator.next().value);
    expect(consumed.map((chunk) => chunk?.ordinal)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(decoded).toBe(7);

    expect(iterator.return?.()).toEqual({ value: undefined, done: true });
    expect(iterator.next()).toEqual({ value: undefined, done: true });
    expect(decoded).toBe(7);
    expect(() => index.prune([])).not.toThrow();
  });

  it("implements listChunks by fully consuming iterateChunks", () => {
    let decoded = 0;
    const index = openIndex(temporaryPath(), {
      onDecodeChunk: () => {
        decoded += 1;
      },
    });
    index.replaceNote(semanticNote());

    expect(index.listChunks()).toHaveLength(2);
    expect(decoded).toBe(2);
  });

  it("does not allocate a statement before first next and finalizes a partially consumed native iterator", () => {
    let chunkStatements = 0;
    let nativeIterators = 0;
    let nativeReturns = 0;
    let decoded = 0;
    const index = openIndex(temporaryPath(), {
      onDecodeChunk: () => {
        decoded += 1;
      },
      databaseFactory: (path, options) => {
        const database = new DatabaseSync(path, options);
        return {
          close: database.close.bind(database),
          exec: database.exec.bind(database),
          prepare(sql: string) {
            const statement = database.prepare(sql);
            if (!sql.includes("SELECT c.*")) return statement;
            chunkStatements += 1;
            return {
              all() {
                throw new Error("chunk streaming query must not call all()");
              },
              iterate(model?: string) {
                nativeIterators += 1;
                const native =
                  model === undefined
                    ? statement.iterate()
                    : statement.iterate(model);
                return {
                  next: native.next.bind(native),
                  return() {
                    nativeReturns += 1;
                    return (
                      native.return?.() ?? { value: undefined, done: true }
                    );
                  },
                  [Symbol.iterator]() {
                    return this;
                  },
                };
              },
            } as unknown as StatementSync;
          },
        } as DatabaseSync;
      },
    });
    index.replaceNote(semanticNote());

    const neverStarted = index.iterateChunks();
    expect(chunkStatements).toBe(0);
    expect(nativeIterators).toBe(0);
    expect(neverStarted.return?.()).toEqual({ value: undefined, done: true });
    expect(chunkStatements).toBe(0);
    expect(nativeIterators).toBe(0);
    expect(nativeReturns).toBe(0);

    const partial = index.iterateChunks();
    expect(chunkStatements).toBe(0);
    expect(partial.next().value?.ordinal).toBe(0);
    expect(chunkStatements).toBe(1);
    expect(nativeIterators).toBe(1);
    expect(decoded).toBe(1);
    expect(partial.return?.()).toEqual({ value: undefined, done: true });
    expect(nativeReturns).toBe(1);
    expect(decoded).toBe(1);
  });
});

describe("ObsidianSearchIndex bounded metadata queries", () => {
  it("computes exact mixed-model coverage over 10,000 notes with one get query", () => {
    const path = temporaryPath();
    const counters: BoundedQueryCounters = {
      prepare: 0,
      get: 0,
      all: 0,
      iterate: 0,
    };
    const index = openIndex(path, {
      databaseFactory: boundedQueryFactory(counters),
    });
    withRawDatabase(path, (database) => {
      database.exec("BEGIN IMMEDIATE");
      const insert = database.prepare(
        `INSERT INTO notes(
           relative_path, title, content_hash, source_bytes,
           source_mtime_ms, model, indexed_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let noteIndex = 0; noteIndex < 10_000; noteIndex += 1) {
        const model =
          noteIndex < 4_000
            ? "embedding-a"
            : noteIndex < 7_500
              ? "embedding-b"
              : null;
        insert.run(
          `bulk/${noteIndex}.md`,
          `Title ${noteIndex}`,
          `hash-${noteIndex}`,
          noteIndex + 0.5,
          noteIndex + 1_000.25,
          model,
          "2026-08-18T01:02:03.004Z",
        );
      }
      database.exec("COMMIT");
    });

    expect(index.semanticCoverage()).toEqual({
      totalNotes: 10_000,
      semanticNotes: 7_500,
      keywordOnlyNotes: 2_500,
      mismatchedModelNotes: 0,
    });
    expect(index.semanticCoverage("embedding-a")).toEqual({
      totalNotes: 10_000,
      semanticNotes: 7_500,
      keywordOnlyNotes: 2_500,
      mismatchedModelNotes: 3_500,
    });
    expect(index.semanticCoverage("embedding-b")).toEqual({
      totalNotes: 10_000,
      semanticNotes: 7_500,
      keywordOnlyNotes: 2_500,
      mismatchedModelNotes: 4_000,
    });
    expect(counters).toEqual({ prepare: 3, get: 3, all: 0, iterate: 0 });
  });

  it("returns exact metadata for one safe path or null using get only", () => {
    const path = temporaryPath();
    const counters: BoundedQueryCounters = {
      prepare: 0,
      get: 0,
      all: 0,
      iterate: 0,
    };
    const index = openIndex(path, {
      databaseFactory: boundedQueryFactory(counters),
    });
    withRawDatabase(path, (database) => {
      database
        .prepare(
          `INSERT INTO notes(
             relative_path, title, content_hash, source_bytes,
             source_mtime_ms, model, indexed_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "point/note.md",
          "Point title",
          "point-hash",
          42.5,
          99.25,
          "embedding-a",
          "2026-08-18T01:02:03.004Z",
        );
    });

    expect(index.noteMetadataForPath("point/note.md")).toEqual({
      relativePath: "point/note.md",
      title: "Point title",
      contentHash: "point-hash",
      size: 42.5,
      modifiedAtMs: 99.25,
      model: "embedding-a",
      indexedAt: "2026-08-18T01:02:03.004Z",
    });
    expect(index.noteMetadataForPath("point/missing.md")).toBeNull();
    expect(counters).toEqual({ prepare: 2, get: 2, all: 0, iterate: 0 });
  });

  it("checks descendants with literal percent and underscore directories using get only", () => {
    const counters: BoundedQueryCounters = {
      prepare: 0,
      get: 0,
      all: 0,
      iterate: 0,
    };
    const index = openIndex(temporaryPath(), {
      databaseFactory: boundedQueryFactory(counters),
    });
    index.replaceNote(keywordNote("percent%folder/child.md"));
    index.replaceNote(keywordNote("percentABfolder/other.md"));
    index.replaceNote(keywordNote("wildABfolder/other.md"));
    index.replaceNote(keywordNote("under_score/child.md"));
    index.replaceNote(keywordNote("underXscore/other.md"));
    index.replaceNote(keywordNote("onlyXscore/other.md"));

    expect(index.hasNoteDescendant("percent%folder")).toBe(true);
    expect(index.hasNoteDescendant("percent%missing")).toBe(false);
    expect(index.hasNoteDescendant("wild%folder")).toBe(false);
    expect(index.hasNoteDescendant("under_score")).toBe(true);
    expect(index.hasNoteDescendant("missing_score")).toBe(false);
    expect(index.hasNoteDescendant("only_score")).toBe(false);
    expect(counters).toEqual({ prepare: 6, get: 6, all: 0, iterate: 0 });
  });

  it("matches descendant directory case exactly", () => {
    const index = openIndex();
    index.replaceNote(keywordNote("CaseDir/child.md"));

    expect(index.hasNoteDescendant("CaseDir")).toBe(true);
    expect(index.hasNoteDescendant("casedir")).toBe(false);
  });

  it("uses an indexed range SEARCH rather than a notes SCAN", () => {
    const path = temporaryPath();
    let descendantSql: string | undefined;
    const index = openIndex(path, {
      databaseFactory: (databasePath, options) => {
        const database = new DatabaseSync(databasePath, options);
        return {
          close: database.close.bind(database),
          exec: database.exec.bind(database),
          prepare(sql: string) {
            if (sql.includes("note_descendant")) descendantSql = sql;
            return database.prepare(sql);
          },
        } as DatabaseSync;
      },
    });
    index.replaceNote(keywordNote("folder/child.md"));
    expect(index.hasNoteDescendant("folder")).toBe(true);
    expect(descendantSql).toBeDefined();
    expect(descendantSql?.match(/\?/gu)).toHaveLength(2);

    withRawDatabase(path, (database) => {
      const plans = database
        .prepare(`EXPLAIN QUERY PLAN ${descendantSql ?? ""}`)
        .all("folder/", "folder0") as Array<{ detail: string }>;
      const detail = plans.map((plan) => plan.detail).join("\n");
      expect(detail).toContain("SEARCH notes USING COVERING INDEX");
      expect(detail).not.toContain("SCAN notes");
    });
  });

  it.each([
    ["empty", ""],
    ["blank", "  "],
    ["POSIX absolute", "/folder"],
    ["Windows drive absolute", "C:/folder"],
    ["Windows drive relative", "C:folder"],
    ["backslashes", "folder\\child"],
    ["NUL", "folder/\0child"],
    ["empty segment", "folder//child"],
    ["dot segment", "folder/./child"],
    ["parent segment", "folder/../child"],
  ])("rejects the %s relative directory", (_name, relativeDirectory) => {
    const index = openIndex();
    expect(() => index.hasNoteDescendant(relativeDirectory)).toThrow(
      "Invalid relative directory",
    );
  });

  it.each(["", " ", "x".repeat(201)])(
    "rejects invalid coverage model %j",
    (model) => {
      const index = openIndex();
      expect(() => index.semanticCoverage(model)).toThrow("Invalid model");
    },
  );
});

describe("ObsidianSearchIndex input validation", () => {
  it("accepts fractional finite nonnegative size and mtime", () => {
    const index = openIndex();
    index.replaceNote({ ...semanticNote(), size: 0.125, modifiedAtMs: 4.75 });
    expect(index.noteMetadata()[0]).toMatchObject({
      size: 0.125,
      modifiedAtMs: 4.75,
    });
  });

  it("accepts zero size and mtime", () => {
    const index = openIndex();
    index.replaceNote({ ...semanticNote(), size: 0, modifiedAtMs: 0 });
    expect(index.noteMetadata()[0]).toMatchObject({ size: 0, modifiedAtMs: 0 });
  });

  it("accepts every exact string-length boundary", () => {
    const index = openIndex();
    const candidate = semanticNote(`${"p".repeat(4093)}.md`, "m".repeat(200));
    candidate.title = "t".repeat(1000);
    candidate.contentHash = "n".repeat(1000);
    candidate.chunks = [
      {
        ...candidate.chunks[0]!,
        id: "i".repeat(1000),
        contentHash: "c".repeat(1000),
      },
    ];

    index.replaceNote(candidate);

    expect(index.noteMetadata()[0]).toMatchObject({
      relativePath: candidate.relativePath,
      title: candidate.title,
      contentHash: candidate.contentHash,
      model: candidate.model,
    });
    expect(index.listChunks()[0]).toMatchObject({
      id: candidate.chunks[0]!.id,
      contentHash: candidate.chunks[0]!.contentHash,
    });
  });

  it.each([
    ["negative size", { size: -1 }],
    ["NaN size", { size: Number.NaN }],
    ["infinite size", { size: Number.POSITIVE_INFINITY }],
    ["negative mtime", { modifiedAtMs: -1 }],
    ["NaN mtime", { modifiedAtMs: Number.NaN }],
    ["infinite mtime", { modifiedAtMs: Number.NEGATIVE_INFINITY }],
  ])("rejects %s without mutation", (_name, change) => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    expectRejectedWithoutMutation(index, { ...semanticNote(), ...change });
  });

  it.each([
    ["blank title", { title: "  " }],
    ["overbound title", { title: "x".repeat(1001) }],
    ["blank note hash", { contentHash: "\t" }],
    ["overbound note hash", { contentHash: "x".repeat(1001) }],
    ["blank model", { model: " " }],
    ["overbound model", { model: "x".repeat(201) }],
  ])("rejects %s without mutation", (_name, change) => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    expectRejectedWithoutMutation(index, { ...semanticNote(), ...change });
  });

  it.each([
    ["blank chunk ID", { id: "" }],
    ["overbound chunk ID", { id: "x".repeat(1001) }],
    ["blank chunk hash", { contentHash: "  " }],
    ["overbound chunk hash", { contentHash: "x".repeat(1001) }],
  ])("rejects %s without mutation", (_name, change) => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    const candidate = semanticNote();
    candidate.chunks[0] = { ...candidate.chunks[0]!, ...change };
    expectRejectedWithoutMutation(index, candidate);
  });

  it("rejects duplicate chunk IDs without mutation", () => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    const candidate = semanticNote();
    candidate.chunks[1] = {
      ...candidate.chunks[1]!,
      id: candidate.chunks[0]!.id,
    };
    expectRejectedWithoutMutation(index, candidate);
  });

  it("accepts reordered contiguous ordinals and returns ordinal order", () => {
    const index = openIndex();
    const candidate = semanticNote();
    candidate.chunks = [candidate.chunks[1]!, candidate.chunks[0]!];
    index.replaceNote(candidate);
    expect(index.listChunks().map(({ ordinal }) => ordinal)).toEqual([0, 1]);
  });

  it.each([
    ["duplicate ordinals", [0, 0]],
    ["an ordinal gap", [0, 2]],
    ["a negative ordinal", [-1, 0]],
    ["a noninteger ordinal", [0, 1.5]],
  ])("rejects %s without mutation", (_name, ordinals) => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    const candidate = semanticNote();
    candidate.chunks = candidate.chunks.map((chunk, position) => ({
      ...chunk,
      ordinal: ordinals[position]!,
    }));
    expectRejectedWithoutMutation(index, candidate);
  });

  it("rejects empty chunk text without mutation", () => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    const candidate = semanticNote();
    candidate.chunks[0] = { ...candidate.chunks[0]!, text: "" };
    expectRejectedWithoutMutation(index, candidate);
  });

  it("accepts whitespace chunk text and any string or null heading", () => {
    const index = openIndex();
    const candidate = semanticNote();
    candidate.chunks[0] = {
      ...candidate.chunks[0]!,
      text: " \t",
      heading: "x".repeat(10_000),
    };
    candidate.chunks[1] = { ...candidate.chunks[1]!, heading: null };
    index.replaceNote(candidate);
    expect(
      index.listChunks().map(({ text, heading }) => ({ text, heading })),
    ).toEqual([
      { text: " \t", heading: "x".repeat(10_000) },
      { text: "second semantic chunk", heading: null },
    ]);
  });

  it("accepts semantic notes with no chunks", () => {
    const index = openIndex();
    index.replaceNote({ ...semanticNote(), chunks: [] });
    expect(index.snapshot()).toEqual({
      noteCount: 1,
      chunkCount: 0,
      synchronizedAt: null,
    });
  });

  it("accepts keyword-only notes with no chunks", () => {
    const index = openIndex();
    index.replaceNote({ ...keywordNote(), chunks: [] });
    expect(index.snapshot()).toEqual({
      noteCount: 1,
      chunkCount: 0,
      synchronizedAt: null,
    });
  });

  it("accepts the maximum semantic vector dimension", () => {
    const index = openIndex();
    const candidate = semanticNote();
    candidate.chunks = [
      { ...candidate.chunks[0]!, vector: new Array(8192).fill(0.25) },
    ];
    index.replaceNote(candidate);
    expect(index.listChunks()[0]?.vector).toHaveLength(8192);
  });

  it.each([
    ["a missing semantic vector", undefined],
    ["a null semantic vector", null],
    ["an empty semantic vector", []],
    ["an overbound semantic vector", new Array(8193).fill(0)],
    ["a NaN semantic vector element", [Number.NaN]],
    ["an infinite semantic vector element", [Number.POSITIVE_INFINITY]],
    ["a finite element that overflows Float32", [Number.MAX_VALUE]],
  ])("rejects %s without mutation", (_name, vector) => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    const candidate = semanticNote();
    candidate.chunks = [
      {
        ...candidate.chunks[0]!,
        vector,
      } as (typeof candidate.chunks)[number],
    ];
    expectRejectedWithoutMutation(index, candidate);
  });

  it("rejects inconsistent semantic dimensions without mutation", () => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    const candidate = semanticNote();
    candidate.chunks[1] = { ...candidate.chunks[1]!, vector: [1, 2] };
    expectRejectedWithoutMutation(index, candidate);
  });

  it("rejects a keyword-only vector without mutation", () => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    const candidate = keywordNote();
    candidate.chunks[0] = { ...candidate.chunks[0]!, vector: [1] };
    expectRejectedWithoutMutation(index, candidate);
  });
});

describe("ObsidianSearchIndex schema and SQLite settings", () => {
  const expectedColumns = {
    models: [
      {
        cid: 0,
        name: "model",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 1,
      },
      {
        cid: 1,
        name: "dimension",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
    ],
    notes: [
      {
        cid: 0,
        name: "relative_path",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 1,
      },
      {
        cid: 1,
        name: "title",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 2,
        name: "content_hash",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 3,
        name: "source_bytes",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 4,
        name: "source_mtime_ms",
        type: "REAL",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 5,
        name: "model",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 6,
        name: "indexed_at",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
    ],
    chunks: [
      { cid: 0, name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
      {
        cid: 1,
        name: "note_path",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 2,
        name: "ordinal",
        type: "INTEGER",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 3,
        name: "heading",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 4,
        name: "text",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 5,
        name: "content_hash",
        type: "TEXT",
        notnull: 1,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 6,
        name: "dimension",
        type: "INTEGER",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      {
        cid: 7,
        name: "vector",
        type: "BLOB",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
    ],
    meta: [
      {
        cid: 0,
        name: "key",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 1,
      },
      {
        cid: 1,
        name: "value",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
    ],
  } as const;

  it("creates the identified version 1 schema with exactly four tables", () => {
    const path = temporaryPath();
    const index = openIndex(path);
    closeTracked(index);
    withRawDatabase(path, (database) => {
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
      expect(database.prepare("PRAGMA application_id").get()).toEqual({
        application_id: APPLICATION_ID,
      });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all(),
      ).toEqual([
        { name: "chunks" },
        { name: "meta" },
        { name: "models" },
        { name: "notes" },
      ]);
    });
  });

  it("creates the complete declared column contract", () => {
    const path = temporaryPath();
    const index = openIndex(path);
    closeTracked(index);
    withRawDatabase(path, (database) => {
      expect(database.prepare("PRAGMA table_info(models)").all()).toEqual(
        expectedColumns.models,
      );
      expect(database.prepare("PRAGMA table_info(notes)").all()).toEqual(
        expectedColumns.notes,
      );
      expect(database.prepare("PRAGMA table_info(chunks)").all()).toEqual(
        expectedColumns.chunks,
      );
      expect(database.prepare("PRAGMA table_info(meta)").all()).toEqual(
        expectedColumns.meta,
      );
    });
  });

  it("creates exact visible table_xinfo contracts without hidden columns", () => {
    const path = temporaryPath();
    const index = openIndex(path);
    closeTracked(index);
    withRawDatabase(path, (database) => {
      expect(database.prepare("PRAGMA table_xinfo(models)").all()).toEqual(
        expectedColumns.models.map((column) => ({ ...column, hidden: 0 })),
      );
      expect(database.prepare("PRAGMA table_xinfo(notes)").all()).toEqual(
        expectedColumns.notes.map((column) => ({ ...column, hidden: 0 })),
      );
      expect(database.prepare("PRAGMA table_xinfo(chunks)").all()).toEqual(
        expectedColumns.chunks.map((column) => ({ ...column, hidden: 0 })),
      );
      expect(database.prepare("PRAGMA table_xinfo(meta)").all()).toEqual(
        expectedColumns.meta.map((column) => ({ ...column, hidden: 0 })),
      );
    });
  });

  it("creates the exact cascading chunk-to-note foreign key", () => {
    const path = temporaryPath();
    const index = openIndex(path);
    index.replaceNote(semanticNote());
    closeTracked(index);
    withRawDatabase(path, (database) => {
      database.exec("PRAGMA foreign_keys=ON");
      expect(database.prepare("PRAGMA foreign_key_list(notes)").all()).toEqual(
        [],
      );
      expect(database.prepare("PRAGMA foreign_key_list(chunks)").all()).toEqual(
        [
          {
            id: 0,
            seq: 0,
            table: "notes",
            from: "note_path",
            to: "relative_path",
            on_update: "NO ACTION",
            on_delete: "CASCADE",
            match: "NONE",
          },
        ],
      );
      database
        .prepare("DELETE FROM notes WHERE relative_path=?")
        .run("notes/semantic.md");
      expect(
        database.prepare("SELECT count(*) AS count FROM chunks").get(),
      ).toEqual({ count: 0 });
    });
  });

  it("creates one named unique note/ordinal index", () => {
    const path = temporaryPath();
    const index = openIndex(path);
    closeTracked(index);
    withRawDatabase(path, (database) => {
      const dbIndexes = database
        .prepare("PRAGMA index_list(chunks)")
        .all() as Array<Record<string, unknown>>;
      expect(dbIndexes).toEqual([
        {
          seq: 0,
          name: "chunks_note_ordinal",
          unique: 1,
          origin: "c",
          partial: 0,
        },
        {
          seq: 1,
          name: "sqlite_autoindex_chunks_1",
          unique: 1,
          origin: "pk",
          partial: 0,
        },
      ]);
      expect(
        database.prepare("PRAGMA index_info(chunks_note_ordinal)").all(),
      ).toEqual([
        { seqno: 0, cid: 1, name: "note_path" },
        { seqno: 1, cid: 2, name: "ordinal" },
      ]);
      expect(
        database.prepare("PRAGMA index_xinfo(chunks_note_ordinal)").all(),
      ).toEqual([
        {
          seqno: 0,
          cid: 1,
          name: "note_path",
          desc: 0,
          coll: "BINARY",
          key: 1,
        },
        {
          seqno: 1,
          cid: 2,
          name: "ordinal",
          desc: 0,
          coll: "BINARY",
          key: 1,
        },
        {
          seqno: 2,
          cid: -1,
          name: null,
          desc: 0,
          coll: "BINARY",
          key: 0,
        },
      ]);
    });
  });

  it("stores vectors as known Float32 little-endian bytes", () => {
    const path = temporaryPath();
    const index = openIndex(path);
    index.replaceNote({
      ...semanticNote(),
      chunks: [{ ...semanticNote().chunks[0]!, vector: [1, -2.5] }],
    });
    closeTracked(index);
    withRawDatabase(path, (database) => {
      const row = database
        .prepare("SELECT dimension, vector FROM chunks")
        .get() as { dimension: number; vector: Uint8Array };
      expect(row.dimension).toBe(2);
      expect(Buffer.from(row.vector)).toEqual(
        Buffer.from([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x20, 0xc0]),
      );
    });
  });

  it("reopens version 1 without losing data", () => {
    const path = temporaryPath();
    let index = openIndex(path);
    index.replaceNote(semanticNote());
    index.markSynchronized("2026-08-18T01:02:03.004Z");
    const before = state(index);
    closeTracked(index);
    index = openIndex(path);
    expect(state(index)).toEqual(before);
    expect(index.snapshot()).toEqual({
      noteCount: 1,
      chunkCount: 2,
      synchronizedAt: "2026-08-18T01:02:03.004Z",
    });
  });

  it("sets WAL, NORMAL, and foreign keys on the actual index connection", () => {
    const path = temporaryPath();
    let actualConnection: DatabaseSync | undefined;
    const index = openIndex(path, {
      databaseFactory: (databasePath, options) => {
        actualConnection = new DatabaseSync(databasePath, options);
        return actualConnection;
      },
    });
    expect(actualConnection?.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    expect(actualConnection?.prepare("PRAGMA synchronous").get()).toEqual({
      synchronous: 1,
    });
    expect(actualConnection?.prepare("PRAGMA foreign_keys").get()).toEqual({
      foreign_keys: 1,
    });
    expect(index.snapshot()).toEqual({
      noteCount: 0,
      chunkCount: 0,
      synchronizedAt: null,
    });
  });
});

describe("ObsidianSearchIndex schema identity and failure safety", () => {
  it("binds a new index to one persisted lowercase vault identity", () => {
    const path = temporaryPath();
    const identity = "a".repeat(64);
    let index = openIndex(path);

    expect(index.vaultIdentity()).toBeNull();
    index.bindVault(identity);
    expect(index.vaultIdentity()).toBe(identity);
    closeTracked(index);

    index = openIndex(path);
    expect(index.vaultIdentity()).toBe(identity);
    expect(() => index.bindVault(identity)).not.toThrow();
    expect(() => index.bindVault("b".repeat(64))).toThrow(
      ObsidianSearchIndexSchemaError,
    );
  });

  it("rejects populated legacy rows without an identity but binds an empty legacy index", () => {
    const populatedPath = temporaryPath();
    const populated = openIndex(populatedPath);
    populated.replaceNote(semanticNote("private-a.md"));

    expect(() => populated.bindVault("b".repeat(64))).toThrow(
      ObsidianSearchIndexSchemaError,
    );
    expect(populated.vaultIdentity()).toBeNull();
    expect(populated.noteMetadata()).toHaveLength(1);

    const emptyPath = temporaryPath();
    const empty = openIndex(emptyPath);
    empty.markSynchronized("2026-08-18T01:02:03.004Z");
    expect(() => empty.bindVault("c".repeat(64))).not.toThrow();
    expect(empty.vaultIdentity()).toBe("c".repeat(64));
  });

  it.each(["A".repeat(64), "a".repeat(63), "g".repeat(64), "/private/vault"])(
    "rejects invalid vault identity without persisting raw input",
    (identity) => {
      const path = temporaryPath();
      const index = openIndex(path);

      expect(() => index.bindVault(identity)).toThrow(
        ObsidianSearchIndexSchemaError,
      );
      expect(index.vaultIdentity()).toBeNull();
    },
  );

  it("rejects a nonabsolute database path before opening SQLite", () => {
    let factoryCalls = 0;
    let error: unknown;
    try {
      new InternalObsidianSearchIndex("relative-index.sqlite", {
        databaseFactory: () => {
          factoryCalls += 1;
          throw new Error("must not open");
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ObsidianSearchIndexUnavailableError);
    expect((error as Error).message).not.toContain("relative-index.sqlite");
    expect(factoryCalls).toBe(0);
  });

  it("wraps parent-directory filesystem failures without exposing a path", () => {
    const path = temporaryPath();
    writeFileSync(path, "parent blocker");
    const databasePath = join(path, "index.sqlite");

    let error: unknown;
    try {
      new ObsidianSearchIndex(databasePath);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ObsidianSearchIndexUnavailableError);
    expect((error as Error).message).not.toContain(path);
    expect((error as Error).message).not.toContain("index.sqlite");
  });

  it("wraps corrupt SQLite file errors without exposing a path", () => {
    const path = temporaryPath();
    writeFileSync(path, "this is not a SQLite database");
    const closes = { value: 0 };

    let error: unknown;
    try {
      openIndex(path, { databaseFactory: closeCountingFactory(closes) });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ObsidianSearchIndexSchemaError);
    expect((error as Error).message).not.toContain(path);
    expect((error as Error).message).not.toContain(dirname(path));
    expect(closes.value).toBe(1);
  });

  it("classifies database open failures as unavailable without exposing details", () => {
    const path = temporaryPath();
    let error: unknown;
    try {
      openIndex(path, {
        databaseFactory: () => {
          throw Object.assign(new Error(`EACCES ${path}`), { code: "EACCES" });
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ObsidianSearchIndexUnavailableError);
    expect(error).not.toBeInstanceOf(ObsidianSearchIndexSchemaError);
    expect((error as Error).message).toBe(
      "Obsidian search index is unavailable",
    );
    expect((error as Error).message).not.toContain(path);
  });

  it("classifies operational schema PRAGMA failures as unavailable and closes once", () => {
    const path = temporaryPath();
    let closes = 0;
    let error: unknown;
    try {
      openIndex(path, {
        databaseFactory: (databasePath, options) => {
          const real = new DatabaseSync(databasePath, options);
          return {
            close() {
              closes += 1;
              real.close();
            },
            exec: real.exec.bind(real),
            prepare(sql: string) {
              if (sql === "PRAGMA user_version") {
                throw new Error(`disk I/O failed for ${databasePath}`);
              }
              return real.prepare(sql);
            },
          } as DatabaseSync;
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ObsidianSearchIndexUnavailableError);
    expect(error).not.toBeInstanceOf(ObsidianSearchIndexSchemaError);
    expect((error as Error).message).not.toContain(path);
    expect(closes).toBe(1);
  });

  it.each([267, 779, 282, 794])(
    "classifies extended SQLite corruption code %i by its primary code",
    (errcode) => {
      const path = temporaryPath();
      let error: unknown;
      try {
        openIndex(path, {
          databaseFactory: (databasePath, options) => {
            const real = new DatabaseSync(databasePath, options);
            return {
              close: real.close.bind(real),
              exec: real.exec.bind(real),
              prepare() {
                throw Object.assign(new Error("extended corruption"), {
                  errcode,
                });
              },
            } as unknown as DatabaseSync;
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ObsidianSearchIndexSchemaError);
      expect(error).not.toBeInstanceOf(ObsidianSearchIndexUnavailableError);
    },
  );

  it.each([10, 266, -245, Number.NaN, 11.5])(
    "does not classify unrelated or invalid SQLite code %s as corruption",
    (errcode) => {
      const path = temporaryPath();
      let error: unknown;
      try {
        openIndex(path, {
          databaseFactory: (databasePath, options) => {
            const real = new DatabaseSync(databasePath, options);
            return {
              close: real.close.bind(real),
              exec: real.exec.bind(real),
              prepare() {
                throw Object.assign(new Error("operational failure"), {
                  errcode,
                });
              },
            } as unknown as DatabaseSync;
          },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ObsidianSearchIndexUnavailableError);
      expect(error).not.toBeInstanceOf(ObsidianSearchIndexSchemaError);
    },
  );

  it("rejects an unrelated version 0 database without any mutation", () => {
    const path = temporaryPath();
    withRawDatabase(path, (database) => {
      database.exec(
        "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep')",
      );
    });
    chmodSync(path, 0o644);
    chmodSync(dirname(path), 0o755);
    const before = {
      bytes: readFileSync(path),
      mode: statSync(path).mode & 0o777,
      parentMode: statSync(dirname(path)).mode & 0o777,
    };
    const closes = { value: 0 };

    expect(() =>
      openIndex(path, { databaseFactory: closeCountingFactory(closes) }),
    ).toThrow(ObsidianSearchIndexSchemaError);

    expect(readFileSync(path)).toEqual(before.bytes);
    expect(statSync(path).mode & 0o777).toBe(before.mode);
    expect(statSync(dirname(path)).mode & 0o777).toBe(before.parentMode);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(closes.value).toBe(1);
  });

  it("rejects an empty version 0 database with a foreign application ID without mutation", () => {
    const path = temporaryPath();
    withRawDatabase(path, (database) => {
      database.exec("PRAGMA application_id=1234567");
    });
    chmodSync(path, 0o644);
    const before = readFileSync(path);
    const closes = { value: 0 };

    expect(() =>
      openIndex(path, { databaseFactory: closeCountingFactory(closes) }),
    ).toThrow(ObsidianSearchIndexSchemaError);

    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(closes.value).toBe(1);
  });

  const malformedVersionOne = (
    mutation:
      | "empty"
      | "wrong application id"
      | "missing table"
      | "missing index"
      | "missing foreign key"
      | "extra index"
      | "unexpected table"
      | "unexpected view"
      | "unexpected trigger"
      | "nonunique index"
      | "NOCASE index"
      | "descending index"
      | "generated column",
  ): string => {
    const path = temporaryPath();
    if (mutation === "empty") {
      withRawDatabase(path, (database) => {
        database.exec(
          `PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=1`,
        );
      });
      return path;
    }

    const index = openIndex(path);
    closeTracked(index);
    withRawDatabase(path, (database) => {
      if (mutation === "wrong application id") {
        database.exec(`PRAGMA application_id=${APPLICATION_ID + 1}`);
      } else if (mutation === "missing table") {
        database.exec("DROP TABLE meta");
      } else if (mutation === "missing index") {
        database.exec("DROP INDEX chunks_note_ordinal");
      } else if (mutation === "missing foreign key") {
        database.exec(`
          DROP TABLE chunks;
          CREATE TABLE chunks (
            id TEXT PRIMARY KEY,
            note_path TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            heading TEXT,
            text TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            dimension INTEGER,
            vector BLOB
          );
          CREATE UNIQUE INDEX chunks_note_ordinal ON chunks(note_path, ordinal);
        `);
      } else if (mutation === "extra index") {
        database.exec("CREATE INDEX extra_note_title ON notes(title)");
      } else if (mutation === "unexpected table") {
        database.exec("CREATE TABLE unexpected(value TEXT)");
      } else if (mutation === "unexpected view") {
        database.exec("CREATE VIEW unexpected AS SELECT title FROM notes");
      } else if (mutation === "unexpected trigger") {
        database.exec(
          "CREATE TRIGGER unexpected AFTER INSERT ON notes BEGIN SELECT 1; END",
        );
      } else if (mutation === "generated column") {
        database.exec(
          "ALTER TABLE notes ADD COLUMN generated_title TEXT GENERATED ALWAYS AS (title) VIRTUAL",
        );
      } else {
        database.exec("DROP INDEX chunks_note_ordinal");
        const qualifier =
          mutation === "NOCASE index"
            ? " COLLATE NOCASE"
            : mutation === "descending index"
              ? " DESC"
              : "";
        const unique = mutation === "nonunique index" ? "" : "UNIQUE ";
        database.exec(
          `CREATE ${unique}INDEX chunks_note_ordinal ON chunks(note_path${qualifier}, ordinal)`,
        );
      }
    });
    return path;
  };

  it.each([
    "empty",
    "wrong application id",
    "missing table",
    "missing index",
    "missing foreign key",
    "extra index",
    "unexpected table",
    "unexpected view",
    "unexpected trigger",
    "nonunique index",
    "NOCASE index",
    "descending index",
    "generated column",
  ] as const)(
    "rejects version 1 with %s before permission or journal changes and closes once",
    (mutation) => {
      const path = malformedVersionOne(mutation);
      chmodSync(path, 0o644);
      chmodSync(dirname(path), 0o755);
      const before = {
        bytes: readFileSync(path),
        mode: statSync(path).mode & 0o777,
        parentMode: statSync(dirname(path)).mode & 0o777,
      };
      const closes = { value: 0 };

      expect(() =>
        openIndex(path, { databaseFactory: closeCountingFactory(closes) }),
      ).toThrow(ObsidianSearchIndexSchemaError);

      expect(readFileSync(path)).toEqual(before.bytes);
      expect(statSync(path).mode & 0o777).toBe(before.mode);
      expect(statSync(dirname(path)).mode & 0o777).toBe(before.parentMode);
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
      expect(closes.value).toBe(1);
    },
  );

  it("rejects orphaned chunk data through foreign_key_check before changing files", () => {
    const path = temporaryPath();
    const created = openIndex(path);
    closeTracked(created);
    withRawDatabase(path, (database) => {
      database.exec("PRAGMA foreign_keys=OFF");
      database
        .prepare(
          `INSERT INTO chunks(
             id, note_path, ordinal, heading, text, content_hash, dimension, vector
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("orphan", "missing.md", 0, null, "orphan", "hash", null, null);
    });
    chmodSync(path, 0o644);
    const before = readFileSync(path);
    const closes = { value: 0 };

    expect(() =>
      openIndex(path, { databaseFactory: closeCountingFactory(closes) }),
    ).toThrow(ObsidianSearchIndexSchemaError);

    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(closes.value).toBe(1);
  });

  it("rejects a failed quick_check and closes the connection exactly once", () => {
    const path = temporaryPath();
    const created = openIndex(path);
    closeTracked(created);
    chmodSync(path, 0o644);
    chmodSync(dirname(path), 0o755);
    const before = readFileSync(path);
    const closes = { value: 0 };

    expect(() =>
      openIndex(path, {
        databaseFactory: closeCountingFactory(closes, (sql) => {
          if (sql === "PRAGMA quick_check") {
            return {
              all: () => [{ quick_check: "database disk image is malformed" }],
            } as unknown as StatementSync;
          }
          return undefined;
        }),
      }),
    ).toThrow(ObsidianSearchIndexSchemaError);
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o755);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(closes.value).toBe(1);
  });

  it.runIf(process.platform !== "win32")(
    "wraps a post-validation chmod failure without exposing a path and closes once",
    () => {
      const path = temporaryPath();
      const created = openIndex(path);
      closeTracked(created);
      const closes = { value: 0 };

      let error: unknown;
      try {
        openIndex(path, {
          databaseFactory: closeCountingFactory(closes, (sql, database) => {
            if (sql === "PRAGMA quick_check") {
              const statement = database.prepare(sql);
              return {
                all() {
                  const result = statement.all();
                  rmSync(path);
                  return result;
                },
              } as unknown as StatementSync;
            }
            return undefined;
          }),
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(ObsidianSearchIndexUnavailableError);
      expect((error as Error).message).toBe(
        "Obsidian search index is unavailable",
      );
      expect((error as Error).message).not.toContain(path);
      expect(closes.value).toBe(1);
    },
  );
});

describe("ObsidianSearchIndex schema failure safety", () => {
  it("leaves unsupported version 99 byte-for-byte untouched and closes it", () => {
    const path = temporaryPath();
    withRawDatabase(path, (database) =>
      database.exec(
        "CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('untouched'); PRAGMA user_version=99;",
      ),
    );
    chmodSync(path, 0o644);
    chmodSync(dirname(path), 0o755);
    const before = {
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      mode: statSync(path).mode & 0o777,
      parentMode: statSync(dirname(path)).mode & 0o777,
      userVersion: undefined as unknown,
      schema: undefined as unknown,
    };
    withRawDatabase(path, (database) => {
      before.userVersion = database.prepare("PRAGMA user_version").get();
      before.schema = database
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name",
        )
        .all();
    });
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    const closes = { value: 0 };
    expect(() =>
      openIndex(path, { databaseFactory: closeCountingFactory(closes) }),
    ).toThrow(ObsidianSearchIndexSchemaError);
    expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
      before.sha256,
    );
    expect(statSync(path).mode & 0o777).toBe(before.mode);
    expect(statSync(dirname(path)).mode & 0o777).toBe(before.parentMode);
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
    expect(closes.value).toBe(1);
    withRawDatabase(path, (database) => {
      expect(database.prepare("PRAGMA user_version").get()).toEqual(
        before.userVersion,
      );
      expect(
        database
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name",
          )
          .all(),
      ).toEqual(before.schema);
      database
        .prepare("INSERT INTO preserved VALUES(?)")
        .run("writable-after-failure");
      expect(
        database.prepare("SELECT value FROM preserved ORDER BY rowid").all(),
      ).toEqual([{ value: "untouched" }, { value: "writable-after-failure" }]);
    });
  });

  it("rolls back version 0 schema creation after an injected mid-schema failure", () => {
    const path = temporaryPath();
    let closes = 0;
    const factory = (
      databasePath: string,
      options: { timeout: number },
    ): DatabaseSync => {
      const real = new DatabaseSync(databasePath, options);
      return {
        close() {
          closes += 1;
          real.close();
        },
        exec(sql: string) {
          return real.exec(
            sql.includes("CREATE TABLE chunks")
              ? sql.replace("CREATE TABLE chunks", "CREATE TABL chunks")
              : sql,
          );
        },
        prepare: real.prepare.bind(real),
      } as DatabaseSync;
    };
    expect(() => openIndex(path, { databaseFactory: factory })).toThrow();
    expect(closes).toBe(1);
    withRawDatabase(path, (raw) => {
      expect(raw.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 0,
      });
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          )
          .all(),
      ).toEqual([]);
    });
  });
});

describe("ObsidianSearchIndex corruption detection", () => {
  it.each([
    [
      "dimension zero",
      (database: DatabaseSync) =>
        database.exec("UPDATE chunks SET dimension=0"),
    ],
    [
      "dimension 8193",
      (database: DatabaseSync) =>
        database.exec("UPDATE chunks SET dimension=8193"),
    ],
    [
      "byte-length mismatch",
      (database: DatabaseSync) =>
        database
          .prepare("UPDATE chunks SET dimension=2, vector=?")
          .run(Buffer.alloc(4)),
    ],
    [
      "NaN vector",
      (database: DatabaseSync) => {
        const bytes = Buffer.alloc(4);
        bytes.writeFloatLE(Number.NaN);
        database.prepare("UPDATE chunks SET dimension=1, vector=?").run(bytes);
      },
    ],
    [
      "infinite vector",
      (database: DatabaseSync) => {
        const bytes = Buffer.alloc(4);
        bytes.writeFloatLE(Number.POSITIVE_INFINITY);
        database.prepare("UPDATE chunks SET dimension=1, vector=?").run(bytes);
      },
    ],
    [
      "null dimension with a blob",
      (database: DatabaseSync) =>
        database.exec("UPDATE chunks SET dimension=NULL"),
    ],
    [
      "dimension with a null blob",
      (database: DatabaseSync) =>
        database.exec("UPDATE chunks SET vector=NULL"),
    ],
    [
      "semantic model with null dimension and blob",
      (database: DatabaseSync) =>
        database.exec("UPDATE chunks SET dimension=NULL, vector=NULL"),
    ],
    [
      "keyword model with dimension and blob",
      (database: DatabaseSync) => database.exec("UPDATE notes SET model=NULL"),
    ],
  ])("rejects %s with a relative-path-only error", (_name, corrupt) => {
    const path = temporaryPath();
    let index = openIndex(path);
    index.replaceNote({
      ...semanticNote("nested/corrupt.md"),
      chunks: [semanticNote("nested/corrupt.md").chunks[0]!],
    });
    closeTracked(index);
    withRawDatabase(path, corrupt);
    index = openIndex(path);
    let error: unknown;
    try {
      index.listChunks();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Corrupt Obsidian search index entry: nested/corrupt.md",
    );
    expect((error as Error).message).not.toContain(path);
  });
});

describe("ObsidianSearchIndex permissions", () => {
  it.runIf(process.platform !== "win32")(
    "creates nested parents as 0700 and the database as 0600",
    () => {
      const path = temporaryPath(true);
      const index = openIndex(path);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(index.snapshot().noteCount).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "leaves an existing parent directory mode unchanged",
    () => {
      const path = temporaryPath();
      chmodSync(dirname(path), 0o755);
      const index = openIndex(path);
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o755);
      expect(index.snapshot().noteCount).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "changes an existing supported version 1 database from 0644 to 0600",
    () => {
      const path = temporaryPath();
      let index = openIndex(path);
      closeTracked(index);
      chmodSync(path, 0o644);
      index = openIndex(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(index.snapshot().noteCount).toBe(0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "secures the database and live WAL and SHM sidecars as 0600",
    () => {
      const path = temporaryPath();
      const index = openIndex(path);
      index.replaceNote(semanticNote());

      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(existsSync(`${path}-shm`)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-shm`).mode & 0o777).toBe(0o600);
    },
  );
});

describe("ObsidianSearchIndex timestamps and lifecycle", () => {
  it("persists and reopens a canonical synchronization timestamp", () => {
    const path = temporaryPath();
    let index = openIndex(path);
    index.markSynchronized("2026-08-18T01:02:03.004Z");
    closeTracked(index);
    index = openIndex(path);
    expect(index.snapshot().synchronizedAt).toBe("2026-08-18T01:02:03.004Z");
  });

  it.each([
    ["February 30", "2026-02-30T00:00:00.000Z"],
    ["a UTC offset", "2026-08-18T09:02:03.004+08:00"],
    ["a noncanonical timestamp", "2026-08-18T01:02:03Z"],
    ["an invalid timestamp", "not-a-date"],
  ])("rejects %s", (_name, timestamp) => {
    const index = openIndex();
    expect(() => index.markSynchronized(timestamp)).toThrow();
    expect(index.snapshot().synchronizedAt).toBeNull();
  });

  it("closes idempotently", () => {
    const index = openIndex();
    index.close();
    expect(() => index.close()).not.toThrow();
  });

  it.each([
    [
      "replaceNote(valid)",
      (index: ObsidianSearchIndex) => index.replaceNote(semanticNote()),
    ],
    [
      "replaceNote(invalid)",
      (index: ObsidianSearchIndex) =>
        index.replaceNote({ ...semanticNote(), relativePath: "../bad.md" }),
    ],
    ["noteMetadata", (index: ObsidianSearchIndex) => index.noteMetadata()],
    [
      "semanticCoverage(valid)",
      (index: ObsidianSearchIndex) => index.semanticCoverage(),
    ],
    [
      "semanticCoverage(invalid)",
      (index: ObsidianSearchIndex) => index.semanticCoverage(""),
    ],
    [
      "noteMetadataForPath(valid)",
      (index: ObsidianSearchIndex) => index.noteMetadataForPath("a.md"),
    ],
    [
      "noteMetadataForPath(invalid)",
      (index: ObsidianSearchIndex) => index.noteMetadataForPath("../bad.md"),
    ],
    [
      "hasNoteDescendant(valid)",
      (index: ObsidianSearchIndex) => index.hasNoteDescendant("folder"),
    ],
    [
      "hasNoteDescendant(invalid)",
      (index: ObsidianSearchIndex) => index.hasNoteDescendant("../bad"),
    ],
    ["listChunks", (index: ObsidianSearchIndex) => index.listChunks()],
    [
      "listChunks(invalid model)",
      (index: ObsidianSearchIndex) => index.listChunks(""),
    ],
    ["iterateChunks", (index: ObsidianSearchIndex) => index.iterateChunks()],
    [
      "iterateChunks(invalid model)",
      (index: ObsidianSearchIndex) => index.iterateChunks(""),
    ],
    ["prune(valid)", (index: ObsidianSearchIndex) => index.prune([])],
    [
      "prune(invalid)",
      (index: ObsidianSearchIndex) => index.prune(["../bad.md"]),
    ],
    [
      "markSynchronized(valid)",
      (index: ObsidianSearchIndex) =>
        index.markSynchronized("2026-08-18T01:02:03.004Z"),
    ],
    [
      "markSynchronized(invalid)",
      (index: ObsidianSearchIndex) => index.markSynchronized("bad"),
    ],
    ["snapshot", (index: ObsidianSearchIndex) => index.snapshot()],
    ["hasNote(valid)", (index: ObsidianSearchIndex) => index.hasNote("a.md")],
    [
      "hasNote(invalid)",
      (index: ObsidianSearchIndex) => index.hasNote("../bad.md"),
    ],
  ])("guards %s before argument validation", (_name, invoke) => {
    const path = temporaryPath();
    const index = openIndex(path);
    index.close();
    expect(() => invoke(index)).toThrowError(
      new Error("Obsidian search index is closed"),
    );
    try {
      invoke(index);
    } catch (error) {
      expect((error as Error).message).not.toContain(path);
    }
  });
});

describe("ObsidianSearchIndex paths", () => {
  it("accepts an uppercase .MD extension", () => {
    const index = openIndex();
    index.replaceNote(keywordNote("Folder/NOTE.MD"));
    expect(index.hasNote("Folder/NOTE.MD")).toBe(true);
  });

  it.each([
    [
      "replaceNote",
      (index: ObsidianSearchIndex, relativePath: string) =>
        index.replaceNote(keywordNote(relativePath)),
    ],
    [
      "prune",
      (index: ObsidianSearchIndex, relativePath: string) =>
        index.prune([relativePath]),
    ],
    [
      "hasNote",
      (index: ObsidianSearchIndex, relativePath: string) =>
        index.hasNote(relativePath),
    ],
  ])(
    "rejects an embedded NUL in %s without changing state",
    (_name, invoke) => {
      const index = openIndex();
      index.replaceNote(keywordNote("baseline.md"));
      const before = state(index);

      expect(() => invoke(index, "folder/\0note.md")).toThrow();
      expect(state(index)).toEqual(before);
    },
  );

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["POSIX absolute", "/absolute.md"],
    ["Windows drive absolute", "C:/absolute.md"],
    ["Windows drive relative", "C:relative.md"],
    ["backslashes", "folder\\note.md"],
    ["empty segment", "folder//note.md"],
    ["dot segment", "folder/./note.md"],
    ["parent segment", "folder/../note.md"],
    ["wrong extension", "note.txt"],
    ["extension before suffix", "note.md/child"],
    ["overbound", `${"x".repeat(4094)}.md`],
  ])("rejects the %s path form without mutation", (_name, relativePath) => {
    const index = openIndex();
    index.replaceNote(keywordNote("baseline.md"));
    expectRejectedWithoutMutation(index, { ...keywordNote(), relativePath });
  });
});
