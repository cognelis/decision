import type {
  MethodologyRelationDisposition,
  MethodologyRelationRecord,
} from "@cognelis/decision-core";
import { canonicalMethodologyPair } from "@cognelis/decision-core";
import { createHash } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertVaultPresent, normalizedNote } from "./markdown.js";
import { escapeNoteText, notePropertiesYaml, unescapeNoteText } from "./markdown-markers.js";
import { existingNote, replaceNote, rewrittenNote } from "./note-rewrite.js";


const DEFAULT_FOLDER = "Decision Journal";
const NOTE_START = "<!-- decision:methodology-relation-note-start -->";
const NOTE_END = "<!-- decision:methodology-relation-note-end -->";
// Where the app's part starts: its title line, whole. A heading of the reader's that only begins the same way
// ("# 方法论关系核对的补充") was taken for it, and everything of theirs from there on was written over.
const APP_PART_START = "# 方法论关系核对\n";
/** Every property serializeMethodologyRelation writes. */
const RELATION_KEYS = ["type", "version", "id", "created", "updated", "principles", "principle_titles", "disposition"] as const;
const DISPOSITIONS: readonly MethodologyRelationDisposition[] = [
  "duplicate",
  "conflict",
  "unrelated",
];

interface MethodologyRelationRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
  /** The vault folder must already exist: a write never makes it up (see assertVaultPresent). */
  existingVault?: boolean;
  /** Told, on every read of the list, which notes it could not read (none: an empty list). */
  onUnreadable?(notes: Array<{ path: string; message: string }>): void;
}

const requireText = (
  value: unknown,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1-${maximum} characters`);
  }
  return normalized;
};

const requireDate = (value: unknown, label: string): string => {
  const date = requireText(value, label, 100);
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`${label} must be an ISO date`);
  }
  return date;
};

const optionalNote = (value: unknown): string | null => {
  if (value === null || value === undefined || value === "") return null;
  return requireText(value, "relation note", 500);
};

const validatedRecord = (
  input: MethodologyRelationRecord,
): MethodologyRelationRecord => {
  if (!DISPOSITIONS.includes(input.disposition)) {
    throw new Error("Methodology relation disposition is invalid");
  }
  if (input.principleIds.length !== 2 || input.principleTitles.length !== 2) {
    throw new Error("Methodology relation requires exactly two principles");
  }
  const rawIds: [string, string] = [
    requireText(input.principleIds[0], "principle id", 200),
    requireText(input.principleIds[1], "principle id", 200),
  ];
  if (rawIds[0] === rawIds[1]) {
    throw new Error("Methodology relation principles must differ");
  }
  const canonicalIds = canonicalMethodologyPair(...rawIds);
  const titlesById = new Map([
    [rawIds[0], requireText(input.principleTitles[0], "principle title", 120)],
    [rawIds[1], requireText(input.principleTitles[1], "principle title", 120)],
  ]);
  return {
    id: requireText(input.id, "methodology relation id", 200),
    createdAt: requireDate(input.createdAt, "createdAt"),
    updatedAt: requireDate(input.updatedAt, "updatedAt"),
    principleIds: canonicalIds,
    principleTitles: [
      titlesById.get(canonicalIds[0])!,
      titlesById.get(canonicalIds[1])!,
    ],
    disposition: input.disposition,
    note: optionalNote(input.note),
  };
};

const fileNameFor = (id: string): string => {
  const digest = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 16);
  return `relation-${digest}.md`;
};

const duplicateId = (id: string): string =>
  `有不止一篇原则关系笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`;

const isMissing = (error: unknown): boolean =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

const parseFrontmatter = (
  markdown: string,
): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Methodology relation must begin with YAML frontmatter");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("Methodology relation has unterminated YAML frontmatter");
  }
  const parsed = parseYaml(markdown.slice(4, boundary));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Methodology relation frontmatter must be an object");
  }
  return {
    properties: parsed as Record<string, unknown>,
    body: markdown.slice(boundary + 5),
  };
};

const noteFromBody = (body: string): string | null => {
  const start = body.indexOf(NOTE_START);
  const end = body.indexOf(NOTE_END);
  if (start < 0 || end <= start) {
    throw new Error("Methodology relation is missing its review note");
  }
  return optionalNote(unescapeNoteText(body.slice(start + NOTE_START.length, end).trim()));
};

const dispositionLabels: Record<MethodologyRelationDisposition, string> = {
  duplicate: "重复",
  conflict: "冲突",
  unrelated: "无关",
};

export const serializeMethodologyRelation = (
  input: MethodologyRelationRecord,
): string => {
  const record = validatedRecord(input);
  const frontmatter = notePropertiesYaml(
    {
      type: "decision-methodology-relation",
      version: 1,
      id: record.id,
      created: record.createdAt,
      updated: record.updatedAt,
      principles: record.principleIds,
      principle_titles: record.principleTitles,
      disposition: record.disposition,
    },
    { lineWidth: 0 },
  ).trimEnd();
  return `---
${frontmatter}
---

# 方法论关系核对

- ${escapeNoteText(record.principleTitles[0])}（${record.principleIds[0]}）
- ${escapeNoteText(record.principleTitles[1])}（${record.principleIds[1]}）

## 人工结论

${dispositionLabels[record.disposition]}

## 核对说明

${NOTE_START}
${escapeNoteText(record.note ?? "")}
${NOTE_END}
`;
};

export const parseMethodologyRelation = (
  note: string,
): MethodologyRelationRecord => {
  // Saved with Windows line endings (git's autocrlf) or a BOM, the same note: read as it was, it left every list.
  const markdown = normalizedNote(note);
  const { properties, body } = parseFrontmatter(markdown);
  if (
    properties.type !== "decision-methodology-relation" ||
    properties.version !== 1
  ) {
    throw new Error("Methodology relation type or version is invalid");
  }
  if (
    !Array.isArray(properties.principles) ||
    properties.principles.length !== 2 ||
    !Array.isArray(properties.principle_titles) ||
    properties.principle_titles.length !== 2 ||
    typeof properties.disposition !== "string" ||
    !DISPOSITIONS.includes(
      properties.disposition as MethodologyRelationDisposition,
    )
  ) {
    throw new Error("Methodology relation metadata is invalid");
  }
  return validatedRecord({
    id: requireText(properties.id, "methodology relation id", 200),
    createdAt: requireDate(properties.created, "createdAt"),
    updatedAt: requireDate(properties.updated, "updatedAt"),
    principleIds: properties.principles as [string, string],
    principleTitles: properties.principle_titles as [string, string],
    disposition: properties.disposition as MethodologyRelationDisposition,
    note: noteFromBody(body),
  });
};

export class MethodologyRelationRepository {
  readonly #directory: string;
  readonly #rename: typeof rename;
  readonly #requiredVault: string | null;
  readonly #onUnreadable: (notes: Array<{ path: string; message: string }>) => void;

  constructor(
    vaultPath: string,
    options: MethodologyRelationRepositoryOptions = {},
  ) {
    this.#requiredVault = options.existingVault === true ? vaultPath : null;
    this.#onUnreadable = options.onUnreadable ?? (() => undefined);
    this.#directory = join(
      vaultPath,
      options.folder ?? DEFAULT_FOLDER,
      "principle-relations",
    );
    this.#rename = options.rename ?? rename;
  }

  async save(record: MethodologyRelationRecord): Promise<void> {
    // Renamed in Obsidian, the note is written where it now is, not forked under the id's own file name: two
    // verdicts for one pair, the merge gate reading the stale 重复 while the page showed 无关.
    const path = (await this.#locate(record.id)) ?? this.#pathFor(record.id);
    if (this.#requiredVault !== null) await assertVaultPresent(this.#requiredVault);
    // The app's part, from its title to the end of the review note, is written as the app writes it; a tag or a
    // section the reader added in Obsidian around it is kept, where the whole note was written over. Retitled in
    // Obsidian, its properties and review note are; one the app cannot read is refused (rewrittenNote), never
    // written over with all the reader had written in it.
    // ponytail: a retitled note is given the app's title back, and its 人工结论 line only at the next 核对; the
    // disposition property is the one read.
    const raw = await existingNote(path);
    const content = rewrittenNote(raw, serializeMethodologyRelation(record), {
      ownKeys: RELATION_KEYS,
      markers: [[APP_PART_START, NOTE_END], [NOTE_START, NOTE_END]],
      parse: parseMethodologyRelation,
    });
    await replaceNote(path, raw, content, this.#rename);
  }

  async remove(id: string): Promise<void> {
    // Renamed in Obsidian, the note is the one cleared: unlinked under the id's own name, it stayed, and 撤销 said done.
    const path = await this.#locate(requireText(id, "methodology relation id", 200));
    if (path === null) return;
    try {
      await unlink(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }

  async list(): Promise<MethodologyRelationRecord[]> {
    // A vault that is not there is not one with no relations (see MethodologyRepository.list).
    if (this.#requiredVault !== null) await assertVaultPresent(this.#requiredVault);
    const { notes, unreadable } = await this.#notes();
    // A sync conflict's copy holds the same id: neither note is listed, and each is said (as MethodologyRepository
    // does). Both listed, the pair had two verdicts, and a write to the id would have reached one of them.
    const holders = new Map<string, number>();
    for (const { record } of notes) holders.set(record.id, (holders.get(record.id) ?? 0) + 1);
    const records: MethodologyRelationRecord[] = [];
    for (const { path, record } of notes) {
      if (holders.get(record.id) === 1) records.push(record);
      else unreadable.push({ path, message: duplicateId(record.id) });
    }
    this.#onUnreadable(unreadable);
    return records.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.id.localeCompare(right.id),
    );
  }

  /** Every note of the folder as read, and those it could not read; a folder not there holds none. */
  async #notes(): Promise<{
    notes: Array<{ path: string; record: MethodologyRelationRecord }>;
    unreadable: Array<{ path: string; message: string }>;
  }> {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return { notes: [], unreadable: [] };
      throw error;
    }
    const notes: Array<{ path: string; record: MethodologyRelationRecord }> = [];
    const unreadable: Array<{ path: string; message: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(this.#directory, entry.name);
      try {
        notes.push({ path, record: parseMethodologyRelation(await readFile(path, "utf8")) });
      } catch (error) {
        // Left untouched, and said: edited in Obsidian past reading, a relation left the principle page without a
        // word, its pair shown again as one to check.
        unreadable.push({ path, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { notes, unreadable };
  }

  /**
   * The note holding this id: under the id's own file name, or under the name it was given in Obsidian. Held by
   * two (a sync conflict's copy beside it), it is refused, as the list leaves both out (see MethodologyRepository).
   */
  async #locate(id: string): Promise<string | null> {
    const own = this.#pathFor(id);
    let found: string | null = null;
    try {
      await access(own);
      found = own;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    for (const { path, record } of (await this.#notes()).notes) {
      if (path === own || record.id !== id) continue;
      if (found !== null) throw new Error(duplicateId(id));
      found = path;
    }
    return found;
  }

  #pathFor(id: string): string {
    return join(this.#directory, fileNameFor(id));
  }
}
