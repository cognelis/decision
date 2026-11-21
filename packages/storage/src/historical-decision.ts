import { historicalDecisionSchema, type HistoricalDecision, type HistoricalDecisionReference } from "@cognelis/decision-protocol";
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";

import { assertVaultPresent, collectMarkdown, normalizedNote, noteText, type NoteDiagnostic } from "./markdown.js";
import { escapeNoteText, notePropertiesYaml, ownTitleHeading, unescapeNoteText } from "./markdown-markers.js";
import { NoteCache } from "./note-cache.js";
import { canonical, replaceNote, rewrittenNote } from "./note-rewrite.js";

/** Beside the journal's own folders, and read by none of them: only this repository lists it. */
export const HISTORICAL_DECISION_FOLDER = "Decision Journal/history";
const NOTE_TYPE = "historical-decision";
const NOTE_VERSION = 1;

/**
 * The parts of the note the App writes, each between its own pair of markers, heading included: an empty field is
 * the two markers alone, with no heading left standing over nothing. What the reader writes outside them is kept.
 */
const SECTIONS = {
  decision: { heading: "## 最终决定", markers: ["<!-- decision:history-decision-start -->", "<!-- decision:history-decision-end -->"] },
  options: { heading: "## 备选方案", markers: ["<!-- decision:history-options-start -->", "<!-- decision:history-options-end -->"] },
  context: { heading: "## 当时背景", markers: ["<!-- decision:history-context-start -->", "<!-- decision:history-context-end -->"] },
  references: { heading: "## 相关链接", markers: ["<!-- decision:history-references-start -->", "<!-- decision:history-references-end -->"] },
  notes: { heading: "## 补充备注", markers: ["<!-- decision:history-notes-start -->", "<!-- decision:history-notes-end -->"] },
} as const satisfies Record<string, { heading: string; markers: readonly [string, string] }>;

type Section = keyof typeof SECTIONS;
const MARKERS = Object.values(SECTIONS).map((section) => section.markers);
const MARKER_STARTS = MARKERS.map(([start]) => start);

/** The properties the App writes: set from the record on every write, or taken out when the record has none. */
const OWN_KEYS = [
  "type", "version", "id", "title", "decided_on", "status", "project", "scope", "participants", "source_kind",
  "source_client", "reversibility", "tags", "related_notes", "supersedes", "status_note", "revisit_condition",
  "promoted_decision_id", "revision", "created", "updated",
] as const;

export interface StoredHistoricalDecision {
  record: HistoricalDecision;
  path: string;
  /** Relative to the vault, with "/" separators. */
  notePath: string;
  /** What the record says, as one hash: the index keeps a row while its note still reads so. */
  hash: string;
}

export interface HistoricalDecisionScan {
  records: StoredHistoricalDecision[];
  /** Notes under the folder that could not be read as a record, by their path relative to the vault. */
  diagnostics: Array<{ path: string; message: string }>;
}

interface HistoricalDecisionRepositoryOptions {
  rename?: typeof rename;
  /** The vault folder must already exist: a write never makes it up (see assertVaultPresent). */
  existingVault?: boolean;
}

const lineMarker = (marker: string): RegExp => new RegExp(`\\n[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");

/** A section's text, without the heading the App puts over it; null when the field is empty or its markers are gone. */
const sectionText = (body: string, section: Section): string | null => {
  const [startMarker, endMarker] = SECTIONS[section].markers;
  const start = lineMarker(startMarker).exec(body);
  const rest = start === null ? "" : body.slice(start.index + start[0].length);
  const end = start === null ? null : lineMarker(endMarker).exec(rest);
  if (end === null) return null;
  // The reader's text has its `##` escaped where it is written: an unescaped one first is the section's heading,
  // whatever it has been renamed to in Obsidian.
  const text = unescapeNoteText(rest.slice(0, end.index).replace(/^\s*## [^\n]*\n?/u, "")).trim();
  return text === "" ? null : text;
};

const listItems = (text: string | null): string[] =>
  (text ?? "").split("\n").map((line) => line.trim().replace(/^-\s*/u, "")).filter((line) => line !== "");

const referenceFrom = (line: string): HistoricalDecisionReference => {
  const [url = "", ...label] = line.split(/\s+/u);
  return label.length === 0 ? { url } : { url, label: label.join(" ") };
};

const marked = (section: Section, text: string | null): string => {
  const { heading, markers } = SECTIONS[section];
  return `${markers[0]}\n${text === null ? "" : `${heading}\n\n${escapeNoteText(text)}\n`}${markers[1]}`;
};

const bullets = (items: readonly string[]): string | null => (items.length === 0 ? null : items.map((item) => `- ${item}`).join("\n"));

const splitDocument = (markdown: string): { properties: Record<string, unknown>; body: string } => {
  const boundary = markdown.startsWith("---\n") ? markdown.indexOf("\n---\n", 4) : -1;
  if (boundary < 0) throw new Error("属性区无法解析");
  let parsed: unknown;
  try {
    parsed = parseYaml(markdown.slice(4, boundary));
  } catch (error) {
    throw new Error("属性区无法解析", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("属性区无法解析");
  return { properties: parsed as Record<string, unknown>, body: markdown.slice(boundary + 5) };
};

/** A list property as Obsidian writes one: several values, or one alone as plain text. */
const list = (value: unknown): unknown => (value === null || value === undefined ? [] : typeof value === "string" ? [value] : value);
const orNull = (value: unknown): unknown => (value === undefined || value === "" ? null : value);
// A date a YAML reader took for a timestamp is the day it names.
const day = (value: unknown): unknown => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

const PROPERTY_OF: Readonly<Record<string, string>> = {
  id: "id", title: "标题", decision: "最终决定", decidedOn: "decided_on", options: "备选方案", context: "当时背景", project: "project",
  scope: "scope", participants: "participants", sourceKind: "source_kind", sourceClient: "source_client", reversibility: "reversibility",
  references: "相关链接", relatedNotes: "related_notes", tags: "tags", notes: "补充备注", status: "status", supersedesId: "supersedes",
  statusNote: "status_note", revisitCondition: "revisit_condition", promotedDecisionId: "promoted_decision_id", createdAt: "created",
  updatedAt: "updated", revision: "revision",
};

export const parseHistoricalDecision = (note: string): HistoricalDecision => {
  // Saved with Windows line endings or a BOM, the same note.
  const { properties, body } = splitDocument(normalizedNote(note));
  if (properties.type !== NOTE_TYPE || properties.version !== NOTE_VERSION) throw new Error("不是 App 能读的历史决定笔记（type 或 version 不对）");
  const title = ownTitleHeading(body, MARKER_STARTS, properties.title);
  const candidate: Record<string, unknown> = {
    id: properties.id,
    title: title === null ? undefined : unescapeNoteText(title.text),
    decision: sectionText(body, "decision") ?? undefined,
    decidedOn: day(properties.decided_on),
    options: listItems(sectionText(body, "options")),
    context: sectionText(body, "context"),
    project: orNull(properties.project),
    scope: orNull(properties.scope),
    participants: list(properties.participants),
    sourceKind: properties.source_kind ?? "app_manual",
    sourceClient: orNull(properties.source_client),
    reversibility: orNull(properties.reversibility),
    references: listItems(sectionText(body, "references")).map(referenceFrom),
    relatedNotes: list(properties.related_notes),
    tags: list(properties.tags),
    notes: sectionText(body, "notes"),
    status: properties.status ?? "active",
    supersedesId: orNull(properties.supersedes),
    statusNote: orNull(properties.status_note),
    revisitCondition: orNull(properties.revisit_condition),
    promotedDecisionId: orNull(properties.promoted_decision_id),
    createdAt: properties.created,
    updatedAt: properties.updated,
    revision: properties.revision,
  };
  const read = historicalDecisionSchema.safeParse(candidate);
  if (read.success) return read.data;
  // Said by the name the reader sees in Obsidian: the property, or the section's heading.
  const field = String(read.error.issues[0]?.path[0] ?? "");
  const name = PROPERTY_OF[field] ?? field;
  throw new Error(candidate[field] === undefined ? `缺少 ${name}` : `「${name}」的内容 App 读不了`);
};

export const serializeHistoricalDecision = (record: HistoricalDecision): string => {
  const some = <T>(values: readonly T[]): readonly T[] | undefined => (values.length > 0 ? values : undefined);
  const frontmatter = notePropertiesYaml(
    {
      type: NOTE_TYPE,
      version: NOTE_VERSION,
      id: record.id,
      // Which heading is the App's title, wherever headings of the reader's stand beside it (namedTitleHeading).
      title: escapeNoteText(record.title),
      decided_on: record.decidedOn,
      status: record.status,
      project: record.project ?? undefined,
      scope: record.scope ?? undefined,
      participants: some(record.participants),
      source_kind: record.sourceKind,
      source_client: record.sourceClient ?? undefined,
      reversibility: record.reversibility ?? undefined,
      tags: some(record.tags),
      related_notes: some(record.relatedNotes),
      supersedes: record.supersedesId ?? undefined,
      status_note: record.statusNote ?? undefined,
      revisit_condition: record.revisitCondition ?? undefined,
      promoted_decision_id: record.promotedDecisionId ?? undefined,
      revision: record.revision,
      created: record.createdAt,
      updated: record.updatedAt,
    },
    { lineWidth: 0 },
  ).trimEnd();
  const sections = [
    marked("decision", record.decision),
    marked("options", bullets(record.options)),
    marked("context", record.context),
    marked("references", bullets(record.references.map((reference) => (reference.label === undefined ? reference.url : `${reference.url} ${reference.label}`)))),
    marked("notes", record.notes),
  ].join("\n\n");
  return `---\n${frontmatter}\n---\n\n# ${escapeNoteText(record.title)}\n\n${sections}\n`;
};

/**
 * A record's text as its note keeps it: line breaks as \n, and a backslash before `##` gone as Markdown reads it
 * (see unescapeNoteText). Read until it reads back as itself, as a journal entry's is.
 */
export const asKeptHistoricalDecision = (record: HistoricalDecision): HistoricalDecision => {
  const once = (text: string): string => unescapeNoteText(escapeNoteText(text));
  const kept = (text: string): string => {
    let read = text.replace(/\r\n?/gu, "\n");
    for (let next = once(read); next !== read && next.length < read.length; next = once(read)) read = next;
    return read;
  };
  const orNone = (text: string | null): string | null => (text === null ? null : kept(text));
  return {
    ...record,
    title: kept(record.title),
    decision: kept(record.decision),
    options: record.options.map(kept),
    context: orNone(record.context),
    references: record.references.map((reference) => (reference.label === undefined ? reference : { url: reference.url, label: kept(reference.label) })),
    notes: orNone(record.notes),
  };
};

const hashOf = (record: HistoricalDecision): string => createHash("sha256").update(canonical(record), "utf8").digest("hex");

/** The note for a record, refused rather than written when it would not read back as that record. */
const faithfulNote = (record: HistoricalDecision): string => {
  const markdown = serializeHistoricalDecision(record);
  if (canonical(parseHistoricalDecision(markdown)) !== canonical(record)) throw new Error("这条历史决定写进笔记后读不回原样，这次没有保存；请检查内容里是否有 App 的结构标记。");
  return markdown;
};

const safeSlug = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "") || "decision";

const duplicateId = (id: string): string =>
  `有不止一篇历史决定笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇。`;

/**
 * 历史决定 as notes in the vault, one each under `Decision Journal/history/<year>/`: the facts live there, and the
 * index beside the App is made from what this reads. A note keeps the file it was first written to; a later change
 * of title or date does not move it.
 */
export class HistoricalDecisionRepository {
  readonly #vaultPath: string;
  readonly #rename: typeof rename;
  readonly #existingVault: boolean;
  readonly #notes = new NoteCache<{ record: HistoricalDecision } | { message: string }>(undefined, (read) => "record" in read);

  constructor(vaultPath: string, options: HistoricalDecisionRepositoryOptions = {}) {
    this.#vaultPath = vaultPath;
    this.#rename = options.rename ?? rename;
    this.#existingVault = options.existingVault ?? false;
  }

  async scan(): Promise<HistoricalDecisionScan> {
    // A vault that is not there is not one with no records (see MethodologyRepository.list).
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    const unreadable: NoteDiagnostic[] = [];
    const paths = await collectMarkdown(join(this.#vaultPath, ...HISTORICAL_DECISION_FOLDER.split("/")), unreadable, true);
    const diagnostics = unreadable.map((diagnostic) => ({ path: this.#relative(diagnostic.path), message: diagnostic.message }));
    const records: StoredHistoricalDecision[] = [];
    const listed = new Set<string>();
    for (const path of paths) {
      const read = await this.#notes.read(path, async () => {
        try {
          return { record: parseHistoricalDecision(await readFile(path, "utf8")) };
        } catch (error) {
          return { message: error instanceof Error ? error.message : String(error) };
        }
      });
      if (!("record" in read)) diagnostics.push({ path: this.#relative(path), message: read.message });
      // A sync conflict's copy holds the same id: listed once and said.
      else if (listed.has(read.record.id)) diagnostics.push({ path: this.#relative(path), message: duplicateId(read.record.id) });
      else {
        listed.add(read.record.id);
        records.push({ record: read.record, path, notePath: this.#relative(path), hash: hashOf(read.record) });
      }
    }
    this.#notes.sweep();
    return { records, diagnostics };
  }

  async create(input: HistoricalDecision): Promise<StoredHistoricalDecision> {
    const record = asKeptHistoricalDecision(input);
    const digest = createHash("sha256").update(record.id, "utf8").digest("hex").slice(0, 8);
    const path = join(this.#vaultPath, ...HISTORICAL_DECISION_FOLDER.split("/"), record.decidedOn.slice(0, 4), `${record.decidedOn}-${safeSlug(record.title)}-${digest}.md`);
    await this.#write(path, null, faithfulNote(record));
    return this.#stored(path);
  }

  /** The record written into its note as it stands, the reader's own additions kept (rewrittenNote). */
  async revise(stored: Pick<StoredHistoricalDecision, "path">, input: HistoricalDecision): Promise<StoredHistoricalDecision> {
    const record = asKeptHistoricalDecision(input);
    const raw = await noteText(stored.path);
    const note = rewrittenNote(raw, faithfulNote(record), { ownKeys: OWN_KEYS, markers: MARKERS, parse: parseHistoricalDecision });
    await this.#write(stored.path, raw, note);
    return this.#stored(stored.path);
  }

  async #stored(path: string): Promise<StoredHistoricalDecision> {
    const record = parseHistoricalDecision(await readFile(path, "utf8"));
    return { record, path, notePath: this.#relative(path), hash: hashOf(record) };
  }

  #relative(path: string): string {
    return relative(this.#vaultPath, path).split(sep).join("/");
  }

  async #write(target: string, raw: string | null, content: string): Promise<void> {
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    await replaceNote(target, raw, content, this.#rename);
  }
}
