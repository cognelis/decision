import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, win32 } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export interface ObsidianIndexedNoteMetadata {
  relativePath: string;
  title: string;
  contentHash: string;
  size: number;
  modifiedAtMs: number;
  model: string | null;
  indexedAt: string;
}

export interface ObsidianIndexedChunk {
  id: string;
  relativePath: string;
  ordinal: number;
  title: string;
  heading: string | null;
  text: string;
  contentHash: string;
  model: string | null;
  vector: number[] | null;
}

export interface ObsidianIndexedNoteInput extends Omit<
  ObsidianIndexedNoteMetadata,
  "indexedAt"
> {
  chunks: Array<Omit<ObsidianIndexedChunk, "relativePath" | "title" | "model">>;
}

export class ObsidianSearchIndexSchemaError extends Error {}

export class ObsidianSearchIndexUnavailableError extends Error {
  constructor() {
    super("Obsidian search index is unavailable");
    this.name = "ObsidianSearchIndexUnavailableError";
  }
}

interface SearchIndexDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
}

type SearchIndexDatabaseFactory = (
  path: string,
  options: { timeout: number },
) => SearchIndexDatabase;

interface ObsidianSearchIndexInternalOptions {
  databaseFactory?: SearchIndexDatabaseFactory;
  onDecodeChunk?: () => void;
}

interface PreparedChunk {
  id: string;
  ordinal: number;
  heading: string | null;
  text: string;
  contentHash: string;
  dimension: number | null;
  vector: Buffer | null;
}

interface PreparedNote {
  relativePath: string;
  title: string;
  contentHash: string;
  size: number;
  modifiedAtMs: number;
  model: string | null;
  dimension: number | null;
  chunks: PreparedChunk[];
}

type Row = Record<string, unknown>;

const APPLICATION_ID = 0x4449534c;
const SCHEMA_VERSION = 1;
const CLOSED_ERROR = "Obsidian search index is closed";
const INVALID_SCHEMA_ERROR = "Invalid Obsidian search index schema";
const VAULT_IDENTITY_PATTERN = /^[a-f0-9]{64}$/u;

const CREATE_MODELS_SQL = `CREATE TABLE models (
  model TEXT PRIMARY KEY,
  dimension INTEGER NOT NULL
)`;

const CREATE_NOTES_SQL = `CREATE TABLE notes (
  relative_path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_bytes INTEGER NOT NULL,
  source_mtime_ms REAL NOT NULL,
  model TEXT,
  indexed_at TEXT NOT NULL
)`;

const CREATE_CHUNKS_SQL = `CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  note_path TEXT NOT NULL REFERENCES notes(relative_path) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading TEXT,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  dimension INTEGER,
  vector BLOB
)`;

const CREATE_META_SQL = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)";
const CREATE_CHUNK_INDEX_SQL =
  "CREATE UNIQUE INDEX chunks_note_ordinal ON chunks(note_path, ordinal)";

const EXPECTED_COLUMNS: Record<string, Row[]> = {
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
    { cid: 0, name: "key", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    {
      cid: 1,
      name: "value",
      type: "TEXT",
      notnull: 0,
      dflt_value: null,
      pk: 0,
    },
  ],
};

const EXPECTED_CHUNK_FOREIGN_KEYS: Row[] = [
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
];

const createDatabase: SearchIndexDatabaseFactory = (path, options) =>
  new DatabaseSync(path, options);

const sameRows = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);

const normalizeSql = (value: unknown): unknown =>
  typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : value;

const primaryKeyIndexDetails = (columnId: number, name: string): Row[] => [
  {
    seqno: 0,
    cid: columnId,
    name,
    desc: 0,
    coll: "BINARY",
    key: 1,
  },
  {
    seqno: 1,
    cid: -1,
    name: null,
    desc: 0,
    coll: "BINARY",
    key: 0,
  },
];

const boundedString = (
  value: unknown,
  name: string,
  maximum: number,
): string => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
};

const validateRelativeLocation = (value: unknown, name: string): string => {
  const relativeLocation = boundedString(value, name, 4096);
  if (
    relativeLocation.includes("\0") ||
    relativeLocation.includes("\\") ||
    isAbsolute(relativeLocation) ||
    win32.isAbsolute(relativeLocation) ||
    /^[A-Za-z]:/u.test(relativeLocation)
  ) {
    throw new Error(`Invalid ${name}`);
  }

  const segments = relativeLocation.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return relativeLocation;
};

/** Whether a note at this vault-relative path can be held here (and so opened by the app at all). */
export const isIndexableNotePath = (value: string): boolean => {
  try {
    validateRelativePath(value);
    return true;
  } catch {
    return false;
  }
};

const validateRelativePath = (value: unknown): string => {
  const relativePath = validateRelativeLocation(value, "relative path");
  if (!relativePath.toLowerCase().endsWith(".md")) {
    throw new Error("Invalid relative path");
  }
  return relativePath;
};

const validateRelativeDirectory = (value: unknown): string =>
  validateRelativeLocation(value, "relative directory");

const encodeVector = (value: unknown): { dimension: number; bytes: Buffer } => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 8192 ||
    !value.every(
      (component) =>
        typeof component === "number" &&
        Number.isFinite(component) &&
        Number.isFinite(Math.fround(component)),
    )
  ) {
    throw new Error("Invalid vector");
  }

  const bytes = Buffer.alloc(value.length * 4);
  value.forEach((component, index) => bytes.writeFloatLE(component, index * 4));
  return { dimension: value.length, bytes };
};

const prepareNote = (note: ObsidianIndexedNoteInput): PreparedNote => {
  const relativePath = validateRelativePath(note.relativePath);
  const title = boundedString(note.title, "title", 1000);
  const contentHash = boundedString(note.contentHash, "content hash", 1000);
  const model =
    note.model === null ? null : boundedString(note.model, "model", 200);

  if (
    !Number.isFinite(note.size) ||
    note.size < 0 ||
    !Number.isFinite(note.modifiedAtMs) ||
    note.modifiedAtMs < 0
  ) {
    throw new Error("Invalid source metadata");
  }
  if (!Array.isArray(note.chunks)) {
    throw new Error("Invalid chunks");
  }

  const identifiers = new Set<string>();
  const ordinals = new Set<number>();
  const chunks: PreparedChunk[] = [];
  let semanticDimension: number | null = null;

  for (const chunk of note.chunks) {
    const id = boundedString(chunk.id, "chunk id", 1000);
    if (identifiers.has(id)) {
      throw new Error("Invalid chunk identity or ordinal");
    }
    identifiers.add(id);

    if (!Number.isInteger(chunk.ordinal) || chunk.ordinal < 0) {
      throw new Error("Invalid chunk identity or ordinal");
    }
    ordinals.add(chunk.ordinal);

    if (typeof chunk.text !== "string" || chunk.text.length === 0) {
      throw new Error("Invalid chunk text");
    }
    if (chunk.heading !== null && typeof chunk.heading !== "string") {
      throw new Error("Invalid heading");
    }

    const chunkHash = boundedString(
      chunk.contentHash,
      "chunk content hash",
      1000,
    );

    if (model === null) {
      if (chunk.vector !== null) {
        throw new Error("Keyword-only note cannot have vectors");
      }
      chunks.push({
        id,
        ordinal: chunk.ordinal,
        heading: chunk.heading,
        text: chunk.text,
        contentHash: chunkHash,
        dimension: null,
        vector: null,
      });
      continue;
    }

    const encoded = encodeVector(chunk.vector);
    semanticDimension ??= encoded.dimension;
    if (encoded.dimension !== semanticDimension) {
      throw new Error("Inconsistent vector dimensions");
    }
    chunks.push({
      id,
      ordinal: chunk.ordinal,
      heading: chunk.heading,
      text: chunk.text,
      contentHash: chunkHash,
      dimension: encoded.dimension,
      vector: encoded.bytes,
    });
  }

  const sortedOrdinals = [...ordinals].sort((left, right) => left - right);
  if (
    ordinals.size !== chunks.length ||
    sortedOrdinals.some((ordinal, index) => ordinal !== index)
  ) {
    throw new Error("Ordinals must be contiguous");
  }

  return {
    relativePath,
    title,
    contentHash,
    size: note.size,
    modifiedAtMs: note.modifiedAtMs,
    model,
    dimension: semanticDimension,
    chunks,
  };
};

const createSchema = (database: SearchIndexDatabase): void => {
  database.exec("BEGIN");
  try {
    database.exec(CREATE_MODELS_SQL);
    database.exec(CREATE_NOTES_SQL);
    database.exec(CREATE_CHUNKS_SQL);
    database.exec(CREATE_CHUNK_INDEX_SQL);
    database.exec(CREATE_META_SQL);
    database.exec(`PRAGMA application_id=${APPLICATION_ID}`);
    database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The failing SQLite statement may already have ended the transaction.
    }
    throw error;
  }
};

const schemaError = (): ObsidianSearchIndexSchemaError =>
  new ObsidianSearchIndexSchemaError(INVALID_SCHEMA_ERROR);

/** SQLite saying a file is not a database, or is damaged: not a full disk, a permission or a lock. */
export const isSqliteCorruptionError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "errcode" in error &&
  typeof error.errcode === "number" &&
  Number.isFinite(error.errcode) &&
  Number.isInteger(error.errcode) &&
  error.errcode >= 0 &&
  ((error.errcode & 0xff) === 11 || (error.errcode & 0xff) === 26);

const validateSchema = (database: SearchIndexDatabase): void => {
  const manifest = database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all()
    .map((entry) => ({ ...entry, sql: normalizeSql(entry.sql) }));
  if (
    !sameRows(manifest, [
      {
        type: "index",
        name: "chunks_note_ordinal",
        tbl_name: "chunks",
        sql: normalizeSql(CREATE_CHUNK_INDEX_SQL),
      },
      {
        type: "table",
        name: "chunks",
        tbl_name: "chunks",
        sql: normalizeSql(CREATE_CHUNKS_SQL),
      },
      {
        type: "table",
        name: "meta",
        tbl_name: "meta",
        sql: normalizeSql(CREATE_META_SQL),
      },
      {
        type: "table",
        name: "models",
        tbl_name: "models",
        sql: normalizeSql(CREATE_MODELS_SQL),
      },
      {
        type: "table",
        name: "notes",
        tbl_name: "notes",
        sql: normalizeSql(CREATE_NOTES_SQL),
      },
    ])
  ) {
    throw schemaError();
  }

  for (const table of ["models", "notes", "chunks", "meta"]) {
    const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all();
    const expected = EXPECTED_COLUMNS[table]?.map((column) => ({
      ...column,
      hidden: 0,
    }));
    if (!sameRows(columns, expected)) {
      throw schemaError();
    }
  }

  const chunkForeignKeys = database
    .prepare("PRAGMA foreign_key_list(chunks)")
    .all();
  if (!sameRows(chunkForeignKeys, EXPECTED_CHUNK_FOREIGN_KEYS)) {
    throw schemaError();
  }
  for (const table of ["models", "notes", "meta"]) {
    if (
      database.prepare(`PRAGMA foreign_key_list(${table})`).all().length !== 0
    ) {
      throw schemaError();
    }
    if (
      !sameRows(database.prepare(`PRAGMA index_list(${table})`).all(), [
        {
          seq: 0,
          name: `sqlite_autoindex_${table}_1`,
          unique: 1,
          origin: "pk",
          partial: 0,
        },
      ])
    ) {
      throw schemaError();
    }
    const primaryKeyName =
      table === "models"
        ? "model"
        : table === "notes"
          ? "relative_path"
          : "key";
    if (
      !sameRows(
        database
          .prepare(`PRAGMA index_xinfo(sqlite_autoindex_${table}_1)`)
          .all(),
        primaryKeyIndexDetails(0, primaryKeyName),
      )
    ) {
      throw schemaError();
    }
  }

  const chunkIndexes = database.prepare("PRAGMA index_list(chunks)").all();
  if (
    !sameRows(chunkIndexes, [
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
    ]) ||
    !sameRows(
      database.prepare("PRAGMA index_xinfo(chunks_note_ordinal)").all(),
      [
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
      ],
    ) ||
    !sameRows(
      database.prepare("PRAGMA index_xinfo(sqlite_autoindex_chunks_1)").all(),
      primaryKeyIndexDetails(0, "id"),
    )
  ) {
    throw schemaError();
  }

  const namedIndexes = database
    .prepare(
      "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  if (
    !sameRows(namedIndexes, [
      { name: "chunks_note_ordinal", tbl_name: "chunks" },
    ])
  ) {
    throw schemaError();
  }
};

const initializeSchema = (database: SearchIndexDatabase): void => {
  const version = (
    database.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  const applicationId = (
    database.prepare("PRAGMA application_id").get() as {
      application_id: number;
    }
  ).application_id;

  if (version === 0) {
    const userObject = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1",
      )
      .get();
    if (applicationId !== 0 || userObject !== undefined) {
      throw schemaError();
    }
    createSchema(database);
  } else if (version === SCHEMA_VERSION) {
    if (applicationId !== APPLICATION_ID) {
      throw schemaError();
    }
  } else {
    throw new ObsidianSearchIndexSchemaError(
      `Unsupported Obsidian index schema: ${version}`,
    );
  }

  validateSchema(database);
  const quickCheck = database.prepare("PRAGMA quick_check").all();
  if (!sameRows(quickCheck, [{ quick_check: "ok" }])) {
    throw schemaError();
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw schemaError();
  }
};

/** Damage found while the index is in use: SQLite's own, or what it decodes failing its checks (corruptionError). */
export const isObsidianSearchIndexDamage = (error: unknown): boolean =>
  isSqliteCorruptionError(error) || (error instanceof Error && error.message.startsWith("Corrupt Obsidian search index"));

const corruptionError = (relativePath?: unknown): Error =>
  relativePath === undefined
    ? new Error("Corrupt Obsidian search index")
    : new Error(`Corrupt Obsidian search index entry: ${String(relativePath)}`);

const decodeChunk = (row: Row): ObsidianIndexedChunk => {
  const rawVector = row.vector as Uint8Array | null;
  const dimension = row.dimension as number | null;
  const model = row.model;
  const registryDimension = row.registry_dimension;
  const hasNullVectorFields = dimension === null && rawVector === null;

  if (
    (model !== null && typeof model !== "string") ||
    (model === null) !== hasNullVectorFields ||
    (model !== null && (dimension === null || rawVector === null)) ||
    (model === null && registryDimension !== null) ||
    (model !== null &&
      (!Number.isInteger(registryDimension) ||
        (registryDimension as number) < 1 ||
        (registryDimension as number) > 8192 ||
        registryDimension !== dimension))
  ) {
    throw corruptionError(row.note_path);
  }

  let vector: number[] | null = null;
  if (rawVector !== null && dimension !== null) {
    if (
      !Number.isInteger(dimension) ||
      dimension < 1 ||
      dimension > 8192 ||
      rawVector.byteLength !== dimension * 4
    ) {
      throw corruptionError(row.note_path);
    }

    const bytes = Buffer.from(rawVector);
    vector = Array.from({ length: dimension }, (_, index) =>
      bytes.readFloatLE(index * 4),
    );
    if (!vector.every(Number.isFinite)) {
      throw corruptionError(row.note_path);
    }
  }

  return {
    id: row.id as string,
    relativePath: row.note_path as string,
    ordinal: row.ordinal as number,
    title: row.title as string,
    heading: row.heading as string | null,
    text: row.text as string,
    contentHash: row.content_hash as string,
    model: model as string | null,
    vector,
  };
};

const noteMetadataFromRow = (row: Row): ObsidianIndexedNoteMetadata => ({
  relativePath: row.relative_path as string,
  title: row.title as string,
  contentHash: row.content_hash as string,
  size: row.source_bytes as number,
  modifiedAtMs: row.source_mtime_ms as number,
  model: row.model as string | null,
  indexedAt: row.indexed_at as string,
});

const isCanonicalTimestamp = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
};

export class ObsidianSearchIndex {
  private readonly database: SearchIndexDatabase;
  private readonly databasePath: string;
  private readonly onDecodeChunk: () => void;
  private closed = false;

  constructor(path: string);
  constructor(path: string, options: ObsidianSearchIndexInternalOptions = {}) {
    if (!isAbsolute(path)) {
      throw new ObsidianSearchIndexUnavailableError();
    }

    let database: SearchIndexDatabase | undefined;
    let phase: "filesystem" | "open" | "schema" | "operational" =
      "filesystem";
    try {
      const parent = dirname(path);
      if (!existsSync(parent)) {
        mkdirSync(parent, { recursive: true, mode: 0o700 });
      }

      const databaseFactory = options.databaseFactory ?? createDatabase;
      phase = "open";
      database = databaseFactory(path, { timeout: 5_000 });
      phase = "schema";
      initializeSchema(database);
      phase = "operational";
      chmodSync(path, 0o600);
      database.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
      );

      this.database = database;
      this.databasePath = path;
      this.onDecodeChunk = options.onDecodeChunk ?? (() => undefined);
      this.secureDatabaseFiles();
    } catch (error) {
      if (database !== undefined) {
        try {
          database.close();
        } catch {
          // The original initialization failure is the useful failure.
        }
      }
      if (error instanceof ObsidianSearchIndexSchemaError) {
        throw error;
      }
      if (phase === "schema" && isSqliteCorruptionError(error)) {
        throw schemaError();
      }
      throw new ObsidianSearchIndexUnavailableError();
    }
  }

  private db(): SearchIndexDatabase {
    if (this.closed) {
      throw new Error(CLOSED_ERROR);
    }
    return this.database;
  }

  vaultIdentity(): string | null {
    const row = this.db()
      .prepare("SELECT value FROM meta WHERE key='vault_identity'")
      .get() as { value: unknown } | undefined;
    if (row === undefined) return null;
    if (
      typeof row.value !== "string" ||
      !VAULT_IDENTITY_PATTERN.test(row.value)
    ) {
      throw schemaError();
    }
    return row.value;
  }

  bindVault(identity: string): void {
    if (!VAULT_IDENTITY_PATTERN.test(identity)) throw schemaError();
    const database = this.db();
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = database
        .prepare("SELECT value FROM meta WHERE key='vault_identity'")
        .get() as { value: unknown } | undefined;
      if (existing !== undefined) {
        if (existing.value !== identity) throw schemaError();
      } else {
        const populated = database
          .prepare(
            `SELECT
               (SELECT count(*) FROM models) +
               (SELECT count(*) FROM notes) +
               (SELECT count(*) FROM chunks) AS count`,
          )
          .get() as { count: number };
        if (populated.count !== 0) throw schemaError();
        database
          .prepare("INSERT INTO meta(key, value) VALUES('vault_identity', ?)")
          .run(identity);
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled the transaction back.
      }
      throw error;
    }
    this.secureDatabaseFiles();
  }

  private secureDatabaseFiles(): void {
    try {
      chmodSync(this.databasePath, 0o600);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${this.databasePath}${suffix}`;
        if (existsSync(sidecar)) {
          chmodSync(sidecar, 0o600);
        }
      }
    } catch {
      throw new Error("Failed to secure Obsidian search index files");
    }
  }

  replaceNote(note: ObsidianIndexedNoteInput): void {
    const database = this.db();
    const prepared = prepareNote(note);
    const indexedAt = new Date().toISOString();

    database.exec("BEGIN IMMEDIATE");
    try {
      if (prepared.model !== null && prepared.dimension !== null) {
        const selectDimension = database.prepare(
          "SELECT dimension FROM models WHERE model=?",
        );
        const authoritative = selectDimension.get(prepared.model) as
          { dimension: number } | undefined;
        if (
          authoritative !== undefined &&
          (!Number.isInteger(authoritative.dimension) ||
            authoritative.dimension !== prepared.dimension)
        ) {
          throw new Error("Semantic model dimension mismatch");
        }

        database
          .prepare(
            "INSERT INTO models(model, dimension) VALUES(?, ?) ON CONFLICT(model) DO NOTHING",
          )
          .run(prepared.model, prepared.dimension);
        const claimed = selectDimension.get(prepared.model) as
          { dimension: number } | undefined;
        if (
          claimed === undefined ||
          !Number.isInteger(claimed.dimension) ||
          claimed.dimension !== prepared.dimension
        ) {
          throw new Error("Semantic model dimension mismatch");
        }
      }
      database
        .prepare(
          `INSERT INTO notes(
             relative_path, title, content_hash, source_bytes,
             source_mtime_ms, model, indexed_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(relative_path) DO UPDATE SET
             title=excluded.title,
             content_hash=excluded.content_hash,
             source_bytes=excluded.source_bytes,
             source_mtime_ms=excluded.source_mtime_ms,
             model=excluded.model,
             indexed_at=excluded.indexed_at`,
        )
        .run(
          prepared.relativePath,
          prepared.title,
          prepared.contentHash,
          prepared.size,
          prepared.modifiedAtMs,
          prepared.model,
          indexedAt,
        );
      database
        .prepare("DELETE FROM chunks WHERE note_path=?")
        .run(prepared.relativePath);

      const insertChunk = database.prepare(
        `INSERT INTO chunks(
           id, note_path, ordinal, heading, text, content_hash, dimension, vector
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of prepared.chunks) {
        insertChunk.run(
          chunk.id,
          prepared.relativePath,
          chunk.ordinal,
          chunk.heading,
          chunk.text,
          chunk.contentHash,
          chunk.dimension,
          chunk.vector,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled the transaction back.
      }
      throw error;
    }
    this.secureDatabaseFiles();
  }

  noteMetadata(): ObsidianIndexedNoteMetadata[] {
    const rows = this.db()
      .prepare(
        `SELECT relative_path, title, content_hash, source_bytes,
                source_mtime_ms, model, indexed_at
         FROM notes
         ORDER BY relative_path`,
      )
      .all() as Row[];

    return rows.map(noteMetadataFromRow);
  }

  semanticCoverage(model?: string): {
    totalNotes: number;
    semanticNotes: number;
    keywordOnlyNotes: number;
    mismatchedModelNotes: number;
  } {
    const database = this.db();
    const selectedModel =
      model === undefined ? undefined : boundedString(model, "model", 200);
    const mismatchExpression =
      selectedModel === undefined
        ? "0"
        : "coalesce(sum(CASE WHEN model IS NOT NULL AND model != ? THEN 1 ELSE 0 END), 0)";
    const statement = database.prepare(
      `SELECT
         count(*) AS total_notes,
         coalesce(sum(CASE WHEN model IS NOT NULL THEN 1 ELSE 0 END), 0)
           AS semantic_notes,
         coalesce(sum(CASE WHEN model IS NULL THEN 1 ELSE 0 END), 0)
           AS keyword_only_notes,
         ${mismatchExpression} AS mismatched_model_notes
       FROM notes`,
    );
    const row = (
      selectedModel === undefined
        ? statement.get()
        : statement.get(selectedModel)
    ) as {
      total_notes: number;
      semantic_notes: number;
      keyword_only_notes: number;
      mismatched_model_notes: number;
    };
    return {
      totalNotes: row.total_notes,
      semanticNotes: row.semantic_notes,
      keywordOnlyNotes: row.keyword_only_notes,
      mismatchedModelNotes: row.mismatched_model_notes,
    };
  }

  noteMetadataForPath(
    relativePath: string,
  ): ObsidianIndexedNoteMetadata | null {
    const database = this.db();
    const validatedPath = validateRelativePath(relativePath);
    const row = database
      .prepare(
        `/* metadata_for_path */
         SELECT relative_path, title, content_hash, source_bytes,
                source_mtime_ms, model, indexed_at
         FROM notes
         WHERE relative_path=?`,
      )
      .get(validatedPath) as Row | undefined;
    return row === undefined ? null : noteMetadataFromRow(row);
  }

  hasNoteDescendant(relativeDirectory: string): boolean {
    const database = this.db();
    const validatedDirectory = validateRelativeDirectory(relativeDirectory);
    const prefix = `${validatedDirectory}/`;
    const upperBound = `${validatedDirectory}0`;
    return (
      database
        .prepare(
          `/* note_descendant */
           SELECT 1
           FROM notes
           WHERE relative_path >= ? AND relative_path < ?
           LIMIT 1`,
        )
        .get(prefix, upperBound) !== undefined
    );
  }

  /**
   * Streams chunks in path/ordinal order. Rows are decoded only as the caller
   * advances the iterator; calling `return()` releases the SQLite iterator.
   */
  iterateChunks(model?: string): IterableIterator<ObsidianIndexedChunk> {
    const database = this.db();
    const selectedModel =
      model === undefined ? undefined : boundedString(model, "model", 200);
    const baseQuery = `SELECT c.*, n.title, n.model,
                              m.dimension AS registry_dimension
                       FROM chunks c
                       JOIN notes n ON n.relative_path=c.note_path
                       LEFT JOIN models m ON m.model=n.model`;
    const onDecodeChunk = this.onDecodeChunk;

    return (function* streamChunks() {
      const statement = database.prepare(
        selectedModel === undefined
          ? `${baseQuery} ORDER BY c.note_path, c.ordinal`
          : `${baseQuery} WHERE n.model=? ORDER BY c.note_path, c.ordinal`,
      );
      const rows =
        selectedModel === undefined
          ? statement.iterate()
          : statement.iterate(selectedModel);
      try {
        while (true) {
          const next = rows.next();
          if (next.done) {
            return;
          }
          onDecodeChunk();
          yield decodeChunk(next.value as Row);
        }
      } finally {
        rows.return?.();
      }
    })();
  }

  listChunks(model?: string): ObsidianIndexedChunk[] {
    return Array.from(this.iterateChunks(model));
  }

  /** Removes notes not among `activePaths`, keeping any under a folder in `keepUnder` (one not read this time). */
  prune(activePaths: readonly string[], keepUnder: readonly string[] = []): void {
    const database = this.db();
    const validatedPaths = activePaths.map(validateRelativePath);
    const keptPrefixes = keepUnder.map((folder) => `${folder}/`);

    database.exec("BEGIN");
    try {
      if (validatedPaths.length === 0 && keptPrefixes.length === 0) {
        database.exec("DELETE FROM notes");
      } else {
        // Compared here, not in `NOT IN (?, ?, …)`: one bound variable per note stopped at SQLite's
        // 32,766, and a larger vault then failed every sync and kept every deleted note searchable.
        const active = new Set(validatedPaths);
        const remove = database.prepare("DELETE FROM notes WHERE relative_path = ?");
        for (const row of database.prepare("SELECT relative_path FROM notes").all() as Array<{ relative_path: string }>) {
          if (active.has(row.relative_path)) continue;
          if (keptPrefixes.some((prefix) => row.relative_path.startsWith(prefix))) continue;
          remove.run(row.relative_path);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled the transaction back.
      }
      throw error;
    }
    this.secureDatabaseFiles();
  }

  /**
   * A note read again and found as indexed: its size and time recorded as they are now, and when, its chunks left
   * as they are. Recorded only at its first reading, a note read within its save's clock slot (or touched since)
   * had a stamp no sync could trust, and was read again every time.
   */
  refreshNoteSource(relativePath: string, size: number, modifiedAtMs: number): void {
    const database = this.db();
    if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(modifiedAtMs) || modifiedAtMs < 0) {
      throw new Error("Invalid note source");
    }
    database
      .prepare(
        `UPDATE notes SET source_bytes=?, source_mtime_ms=?, indexed_at=?
         WHERE relative_path=?`,
      )
      .run(size, modifiedAtMs, new Date().toISOString(), validateRelativePath(relativePath));
    this.secureDatabaseFiles();
  }

  markSynchronized(at: string): void {
    const database = this.db();
    if (typeof at !== "string" || !isCanonicalTimestamp(at)) {
      throw new Error("Invalid synchronization timestamp");
    }
    database
      .prepare(
        `INSERT INTO meta(key, value) VALUES('synchronized_at', ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(at);
    this.secureDatabaseFiles();
  }

  snapshot(): {
    noteCount: number;
    chunkCount: number;
    synchronizedAt: string | null;
  } {
    const database = this.db();
    const notes = database
      .prepare("SELECT count(*) AS count FROM notes")
      .get() as { count: number };
    const chunks = database
      .prepare("SELECT count(*) AS count FROM chunks")
      .get() as { count: number };
    const synchronization = database
      .prepare("SELECT value FROM meta WHERE key='synchronized_at'")
      .get() as { value: string } | undefined;
    return {
      noteCount: notes.count,
      chunkCount: chunks.count,
      synchronizedAt: synchronization?.value ?? null,
    };
  }

  hasNote(relativePath: string): boolean {
    const database = this.db();
    const validatedPath = validateRelativePath(relativePath);
    return (
      database
        .prepare("SELECT 1 FROM notes WHERE relative_path=?")
        .get(validatedPath) !== undefined
    );
  }

  close(): void {
    if (!this.closed) {
      this.database.close();
      this.closed = true;
    }
  }
}
