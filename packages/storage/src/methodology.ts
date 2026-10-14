import type {
  MethodologyConfidence,
  MethodologyOrigin,
  MethodologyRecord,
  MethodologyStatus,
} from "@cognelis/decision-core";
import { createHash } from "node:crypto";
import {
  access,
  readFile,
  rename,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertVaultPresent, collectMarkdown, normalizedNote, noteProblem } from "./markdown.js";
import { escapeNoteText, notePropertiesYaml, ownTitleHeading, unescapeNoteText } from "./markdown-markers.js";
import { NoteCache } from "./note-cache.js";
import { existingNote, replaceNote, rewrittenNote } from "./note-rewrite.js";


const DEFAULT_FOLDER = "Decision Journal";
const PRINCIPLE_START = "<!-- decision:methodology-principle-start -->";
const PRINCIPLE_END = "<!-- decision:methodology-principle-end -->";
const APPLIES_START = "<!-- decision:methodology-applies-start -->";
const APPLIES_END = "<!-- decision:methodology-applies-end -->";
const CAUTION_START = "<!-- decision:methodology-caution-start -->";
const CAUTION_END = "<!-- decision:methodology-caution-end -->";
const EVIDENCE_START = "<!-- decision:methodology-evidence-start -->";
const EVIDENCE_END = "<!-- decision:methodology-evidence-end -->";

const STATUSES: readonly MethodologyStatus[] = [
  "candidate",
  "accepted",
  "retired",
  "dismissed",
];
const CONFIDENCES: readonly MethodologyConfidence[] = ["low", "medium", "high"];
const ORIGINS: readonly MethodologyOrigin[] = [
  "decision_evidence",
  "markdown_import",
  "manual_entry",
  "principle_merge",
  "principle_revision",
];

interface MethodologyRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
  /** The vault folder must already exist: a write never makes it up (see assertVaultPresent). */
  existingVault?: boolean;
  /** Told, on every read of the list, which notes it could not read (none: an empty list). */
  onUnreadable?(notes: Array<{ path: string; message: string }>): void;
}

// Each property and section by the name the note shows: named by its field in code ("createdAt is required",
// "Methodology note is missing appliesWhen"), the import and the principle's own page told the reader of nothing they
// could find in the note.
const NOTE_NAMES: Record<string, string> = {
  "methodology id": "id",
  createdAt: "created",
  updatedAt: "updated",
  confirmedAt: "confirmed_at",
  appliedAt: "applied_at",
  "applied methodology id": "applied_to",
  retiredAt: "retired_at",
  "superseding methodology id": "superseded_by",
  "usage validation reviewedAt": "usage_validation_reviewed_at",
  "usage validation decision id": "usage_validation_decision",
  "usage validation validatedAt": "usage_validated_at",
  "import source file name": "import_source_file",
  "import source content sha256": "import_source_sha256",
  "generation request id": "generation_request",
  "generation profile id": "generation_profile",
  "generation provider": "generation_provider",
  "generation model": "generation_model",
  "source decision id": "source_decisions",
  "source principle id": "source_principles",
  title: "标题",
  principle: "原则",
  appliesWhen: "适用条件",
  caution: "注意事项",
  evidenceSummary: "证据摘要",
};
const shown = (label: string): string => NOTE_NAMES[label] ?? label;

const requireText = (
  value: unknown,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string") {
    throw new Error(`「${shown(label)}」需要是文字`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`「${shown(label)}」需要 1–${maximum} 个字`);
  }
  return normalized;
};

const optionalDate = (value: unknown, label: string): string | null => {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const date = requireText(value, label, 100);
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`「${shown(label)}」需要是日期（如 2026-10-05T08:00:00.000Z）`);
  }
  return date;
};

const requireDate = (value: unknown, label: string): string => {
  const date = optionalDate(value, label);
  if (date === null) {
    throw new Error(`缺少「${shown(label)}」属性`);
  }
  return date;
};

const section = (
  markdown: string,
  start: string,
  end: string,
  label: string,
  maximum: number,
): string => {
  const heading = shown(label);
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`缺少「${heading}」一节，或它前后的标记被删改了`);
  }
  const text = unescapeNoteText(markdown.slice(startIndex + start.length, endIndex)).trim();
  if (text.length === 0 || text.length > maximum) {
    throw new Error(`「${heading}」需要 1–${maximum} 个字`);
  }
  return text;
};

const safeIdentifier = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "methodology";

const fileNameFor = (id: string): string => {
  const digest = createHash("sha256")
    .update(id, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `${safeIdentifier(id)}-${digest}.md`;
};

const duplicateId = (id: string): string =>
  `有不止一篇原则笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`;

const parseFrontmatter = (
  markdown: string,
): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Methodology note must begin with YAML frontmatter");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("Methodology note has unterminated YAML frontmatter");
  }
  const parsed = parseYaml(markdown.slice(4, boundary));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Methodology note frontmatter must be an object");
  }
  return {
    properties: parsed as Record<string, unknown>,
    body: markdown.slice(boundary + 5),
  };
};

const validatedRecord = (input: MethodologyRecord): MethodologyRecord => {
  const id = requireText(input.id, "methodology id", 200);
  const createdAt = requireDate(input.createdAt, "createdAt");
  const updatedAt = requireDate(input.updatedAt, "updatedAt");
  if (!STATUSES.includes(input.status)) {
    throw new Error("Methodology status is invalid");
  }
  if (!CONFIDENCES.includes(input.confidence)) {
    throw new Error("Methodology confidence is invalid");
  }
  if (!ORIGINS.includes(input.origin)) {
    throw new Error("Methodology origin is invalid");
  }
  const sourceDecisionIds = [
    ...new Set(
      input.sourceDecisionIds.map((value) =>
        requireText(value, "source decision id", 200),
      ),
    ),
  ];
  const sourcePrincipleIds = [
    ...new Set(
      (input.sourcePrincipleIds ?? []).map((value) =>
        requireText(value, "source principle id", 200),
      ),
    ),
  ];
  const importSource =
    input.importSource === undefined
      ? null
      : {
          fileName: requireText(
            input.importSource.fileName,
            "import source file name",
            240,
          ),
          contentSha256: requireText(
            input.importSource.contentSha256,
            "import source content sha256",
            64,
          ).toLocaleLowerCase("en-US"),
        };
  if (
    importSource !== null &&
    !/^[a-f0-9]{64}$/u.test(importSource.contentSha256)
  ) {
    throw new Error("Import source content sha256 is invalid");
  }
  if (
    (input.origin !== "markdown_import" && importSource !== null) ||
    (input.origin === "markdown_import" &&
      input.importSource !== undefined &&
      importSource === null)
  ) {
    throw new Error("Only imported methodology can retain an import source");
  }
  const requiresEvidence =
    input.origin === "decision_evidence" ||
    input.origin === "principle_merge" ||
    input.origin === "principle_revision";
  if (
    sourceDecisionIds.length > 5 ||
    (requiresEvidence && sourceDecisionIds.length === 0)
  ) {
    throw new Error(
      requiresEvidence
        ? "Evidence-based, merged, and revised methodology requires 1-5 source decisions"
        : "Imported and manually entered methodology supports at most 5 source decisions",
    );
  }
  if (
    (input.origin === "principle_merge" &&
      (sourcePrincipleIds.length < 2 || sourcePrincipleIds.length > 5)) ||
    (input.origin === "principle_revision" &&
      sourcePrincipleIds.length !== 1) ||
    (input.origin !== "principle_merge" &&
      input.origin !== "principle_revision" &&
      sourcePrincipleIds.length > 0)
  ) {
    throw new Error(
      "Merged methodology requires 2-5 source principles and revised methodology requires exactly 1",
    );
  }
  if (sourcePrincipleIds.includes(id)) {
    throw new Error("Methodology cannot use itself as a source principle");
  }
  const appliedAt = optionalDate(input.appliedAt, "appliedAt");
  const appliedToId =
    input.appliedToId === undefined
      ? null
      : requireText(input.appliedToId, "applied methodology id", 200);
  if (
    (appliedAt === null) !== (appliedToId === null) ||
    (appliedAt !== null &&
      (input.origin !== "principle_revision" || input.status !== "dismissed"))
  ) {
    throw new Error(
      "Applied revision requires appliedAt and appliedToId on a dismissed revision candidate",
    );
  }
  if (appliedToId === id) {
    throw new Error("Methodology revision cannot apply to itself");
  }
  const confirmedAt = optionalDate(input.confirmedAt, "confirmedAt");
  if (
    (input.status === "accepted" || input.status === "retired") &&
    confirmedAt === null
  ) {
    throw new Error("Accepted and retired methodology requires confirmedAt");
  }
  const retiredAt = optionalDate(input.retiredAt, "retiredAt");
  const supersededById =
    input.supersededById === undefined
      ? null
      : requireText(input.supersededById, "superseding methodology id", 200);
  if (
    (input.status === "retired" &&
      (retiredAt === null || supersededById === null)) ||
    (input.status !== "retired" &&
      (retiredAt !== null || supersededById !== null))
  ) {
    throw new Error(
      "Retired methodology requires retiredAt and supersededById",
    );
  }
  if (supersededById === id) {
    throw new Error("Methodology cannot supersede itself");
  }
  const usageValidation =
    input.usageValidation === undefined
      ? null
      : {
          reviewedAt: requireDate(
            input.usageValidation.reviewedAt,
            "usage validation reviewedAt",
          ),
          decisionId: requireText(
            input.usageValidation.decisionId,
            "usage validation decision id",
            200,
          ),
          validatedAt: requireDate(
            input.usageValidation.validatedAt,
            "usage validation validatedAt",
          ),
        };
  return {
    id,
    createdAt,
    updatedAt,
    origin: input.origin,
    status: input.status,
    confirmedAt,
    // One line, as it is read back from its "# " heading: a model's title broken over two lost the second.
    title: requireText(input.title.replace(/\s*[\r\n]+\s*/gu, " "), "title", 120),
    principle: requireText(input.principle, "principle", 2_000),
    appliesWhen: requireText(input.appliesWhen, "appliesWhen", 2_000),
    caution: requireText(input.caution, "caution", 2_000),
    evidenceSummary: requireText(
      input.evidenceSummary,
      "evidenceSummary",
      3_000,
    ),
    sourceDecisionIds,
    ...(sourcePrincipleIds.length === 0 ? {} : { sourcePrincipleIds }),
    ...(importSource === null ? {} : { importSource }),
    ...(appliedAt === null ? {} : { appliedAt }),
    ...(appliedToId === null ? {} : { appliedToId }),
    ...(retiredAt === null ? {} : { retiredAt }),
    ...(supersededById === null ? {} : { supersededById }),
    ...(usageValidation === null ? {} : { usageValidation }),
    confidence: input.confidence,
    generation: {
      requestId: requireText(
        input.generation.requestId,
        "generation request id",
        200,
      ),
      profileId: requireText(
        input.generation.profileId,
        "generation profile id",
        200,
      ),
      provider: requireText(
        input.generation.provider,
        "generation provider",
        100,
      ),
      model: requireText(input.generation.model, "generation model", 200),
    },
  };
};

export const serializeMethodology = (input: MethodologyRecord): string => {
  const record = validatedRecord(input);
  const frontmatter = notePropertiesYaml(
    {
      type: "decision-methodology",
      version: 1,
      id: record.id,
      // Which heading is the app's title, wherever headings of the reader's stand beside it (namedTitleHeading).
      title: escapeNoteText(record.title),
      origin: record.origin,
      created: record.createdAt,
      updated: record.updatedAt,
      status: record.status,
      confirmed_at: record.confirmedAt,
      confidence: record.confidence,
      source_decisions: record.sourceDecisionIds,
      ...(record.sourcePrincipleIds === undefined
        ? {}
        : { source_principles: record.sourcePrincipleIds }),
      ...(record.importSource === undefined
        ? {}
        : {
            import_source_file: record.importSource.fileName,
            import_source_sha256: record.importSource.contentSha256,
          }),
      ...(record.appliedAt === undefined
        ? {}
        : { applied_at: record.appliedAt, applied_to: record.appliedToId }),
      ...(record.retiredAt === undefined
        ? {}
        : { retired_at: record.retiredAt }),
      ...(record.supersededById === undefined
        ? {}
        : { superseded_by: record.supersededById }),
      ...(record.usageValidation === undefined
        ? {}
        : {
            usage_validation_reviewed_at: record.usageValidation.reviewedAt,
            usage_validation_decision: record.usageValidation.decisionId,
            usage_validated_at: record.usageValidation.validatedAt,
          }),
      generation_request: record.generation.requestId,
      generation_profile: record.generation.profileId,
      generation_provider: record.generation.provider,
      generation_model: record.generation.model,
    },
    { lineWidth: 0 },
  ).trimEnd();
  // Drawn by a model from decisions an agent captured: text, not structure or Dataview code (markdown-markers).
  return `---
${frontmatter}
---

# ${escapeNoteText(record.title)}

## 原则

${PRINCIPLE_START}
${escapeNoteText(record.principle)}
${PRINCIPLE_END}

## 适用条件

${APPLIES_START}
${escapeNoteText(record.appliesWhen)}
${APPLIES_END}

## 注意事项

${CAUTION_START}
${escapeNoteText(record.caution)}
${CAUTION_END}

## 证据摘要

${EVIDENCE_START}
${escapeNoteText(record.evidenceSummary)}
${EVIDENCE_END}
`;
};

/** Every property serializeMethodology may write: a save sets the ones it has and takes out the rest. */
const METHODOLOGY_KEYS = [
  "type", "version", "id", "title", "origin", "created", "updated", "status", "confirmed_at", "confidence",
  "source_decisions", "source_principles", "import_source_file", "import_source_sha256", "applied_at",
  "applied_to", "retired_at", "superseded_by", "usage_validation_reviewed_at", "usage_validation_decision",
  "usage_validated_at", "generation_request", "generation_profile", "generation_provider", "generation_model",
] as const;
const METHODOLOGY_MARKERS = [
  [PRINCIPLE_START, PRINCIPLE_END],
  [APPLIES_START, APPLIES_END],
  [CAUTION_START, CAUTION_END],
  [EVIDENCE_START, EVIDENCE_END],
] as const;

export const parseMethodology = (note: string): MethodologyRecord => {
  // Saved with Windows line endings (git's autocrlf) or a BOM, the same note: read as it was, it left every list.
  const markdown = normalizedNote(note);
  const { properties, body } = parseFrontmatter(markdown);
  if (properties.type !== "decision-methodology" || properties.version !== 1) {
    throw new Error("Methodology note type or version is invalid");
  }
  const status = properties.status;
  const confidence = properties.confidence;
  const origin = properties.origin ?? "decision_evidence";
  if (
    typeof status !== "string" ||
    !STATUSES.includes(status as MethodologyStatus)
  ) {
    throw new Error("Methodology note status is invalid");
  }
  if (
    typeof confidence !== "string" ||
    !CONFIDENCES.includes(confidence as MethodologyConfidence)
  ) {
    throw new Error("Methodology note confidence is invalid");
  }
  if (
    typeof origin !== "string" ||
    !ORIGINS.includes(origin as MethodologyOrigin)
  ) {
    throw new Error("Methodology note origin is invalid");
  }
  // One source given as one value, as Obsidian lets a list be, or emptied there: that one, or none.
  const listed = (value: unknown): unknown => (typeof value === "string" ? [value] : value === null ? [] : value);
  const sourceDecisions = listed(properties.source_decisions);
  const sourcePrinciples = listed(properties.source_principles);
  if (!Array.isArray(sourceDecisions)) {
    throw new Error("Methodology note source decisions are invalid");
  }
  if (sourcePrinciples !== undefined && !Array.isArray(sourcePrinciples)) {
    throw new Error("Methodology note source principles are invalid");
  }
  const titleMatch = ownTitleHeading(body, METHODOLOGY_MARKERS.map(([start]) => start), properties.title);
  if (titleMatch === null) {
    throw new Error("Methodology note is missing its title");
  }
  return validatedRecord({
    id: requireText(properties.id, "methodology id", 200),
    createdAt: requireDate(properties.created, "createdAt"),
    updatedAt: requireDate(properties.updated, "updatedAt"),
    origin: origin as MethodologyOrigin,
    status: status as MethodologyStatus,
    confirmedAt: optionalDate(properties.confirmed_at, "confirmedAt"),
    title: unescapeNoteText(titleMatch.text),
    principle: section(
      body,
      PRINCIPLE_START,
      PRINCIPLE_END,
      "principle",
      2_000,
    ),
    appliesWhen: section(
      body,
      APPLIES_START,
      APPLIES_END,
      "appliesWhen",
      2_000,
    ),
    caution: section(body, CAUTION_START, CAUTION_END, "caution", 2_000),
    evidenceSummary: section(
      body,
      EVIDENCE_START,
      EVIDENCE_END,
      "evidenceSummary",
      3_000,
    ),
    sourceDecisionIds: sourceDecisions as string[],
    ...(sourcePrinciples === undefined
      ? {}
      : { sourcePrincipleIds: sourcePrinciples as string[] }),
    ...(properties.import_source_file === undefined &&
    properties.import_source_sha256 === undefined
      ? {}
      : {
          importSource: {
            fileName: requireText(
              properties.import_source_file,
              "import source file name",
              240,
            ),
            contentSha256: requireText(
              properties.import_source_sha256,
              "import source content sha256",
              64,
            ),
          },
        }),
    ...(properties.applied_at === undefined &&
    properties.applied_to === undefined
      ? {}
      : {
          appliedAt: requireDate(properties.applied_at, "appliedAt"),
          appliedToId: requireText(
            properties.applied_to,
            "applied methodology id",
            200,
          ),
        }),
    ...(properties.retired_at === undefined
      ? {}
      : { retiredAt: requireDate(properties.retired_at, "retiredAt") }),
    ...(properties.superseded_by === undefined
      ? {}
      : {
          supersededById: requireText(
            properties.superseded_by,
            "superseding methodology id",
            200,
          ),
        }),
    ...(properties.usage_validation_reviewed_at === undefined &&
    properties.usage_validation_decision === undefined &&
    properties.usage_validated_at === undefined
      ? {}
      : {
          usageValidation: {
            reviewedAt: requireDate(
              properties.usage_validation_reviewed_at,
              "usage validation reviewedAt",
            ),
            decisionId: requireText(
              properties.usage_validation_decision,
              "usage validation decision id",
              200,
            ),
            validatedAt: requireDate(
              properties.usage_validated_at,
              "usage validation validatedAt",
            ),
          },
        }),
    confidence: confidence as MethodologyConfidence,
    generation: {
      requestId: requireText(
        properties.generation_request,
        "generation request id",
        200,
      ),
      profileId: requireText(
        properties.generation_profile,
        "generation profile id",
        200,
      ),
      provider: requireText(
        properties.generation_provider,
        "generation provider",
        100,
      ),
      model: requireText(properties.generation_model, "generation model", 200),
    },
  });
};

export class MethodologyRepository {
  readonly #directory: string;
  readonly #rename: typeof rename;
  readonly #requiredVault: string | null;
  readonly #onUnreadable: (notes: Array<{ path: string; message: string }>) => void;
  // Every list read every principle again: each keystroke in the knowledge search, to name the ones applied.
  readonly #notes = new NoteCache<{ record: MethodologyRecord } | { message: string }>(undefined, (read) => "record" in read);

  constructor(vaultPath: string, options: MethodologyRepositoryOptions = {}) {
    this.#requiredVault = options.existingVault === true ? vaultPath : null;
    this.#onUnreadable = options.onUnreadable ?? (() => undefined);
    this.#directory = join(
      vaultPath,
      options.folder ?? DEFAULT_FOLDER,
      "principles",
    );
    this.#rename = options.rename ?? rename;
  }

  async save(record: MethodologyRecord): Promise<void> {
    // Renamed in Obsidian, the note is written where it now is, not forked under the id's own file name.
    const path = (await this.#locate(record.id)) ?? this.#pathFor(record.id);
    if (this.#requiredVault !== null) await assertVaultPresent(this.#requiredVault);
    const raw = await existingNote(path);
    const content = rewrittenNote(raw, serializeMethodology(record), {
      ownKeys: METHODOLOGY_KEYS,
      markers: METHODOLOGY_MARKERS,
      parse: parseMethodology,
    });
    await replaceNote(path, raw, content, this.#rename);
  }

  async find(id: string): Promise<MethodologyRecord | null> {
    const path = await this.#locate(id);
    if (path === null) return null;
    try {
      return parseMethodology(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(
        `原则笔记 ${basename(path)} 无法读取（${noteProblem(error instanceof Error ? error.message : String(error))}），请在 Obsidian 中修正后再试。`,
        { cause: error },
      );
    }
  }

  async list(): Promise<MethodologyRecord[]> {
    // A vault that is not there (its disk ejected) is not one with no principles: read as empty, an agent asking
    // before a choice was told the reader had adopted none.
    if (this.#requiredVault !== null) await assertVaultPresent(this.#requiredVault);
    const notes: Array<{ path: string; record: MethodologyRecord }> = [];
    // A note iCloud moved off this Mac, or a folder it cannot list, is said rather than passed over: an
    // adopted principle left every list without a word.
    const unreadable: Array<{ path: string; message: string }> = [];
    for (const path of await collectMarkdown(this.#directory, unreadable)) {
      const read = await this.#read(path);
      // Left untouched, and said: edited in Obsidian past reading, an adopted principle left every list without
      // a word, its evidence offered again as new and its skills short of a source.
      if ("record" in read) notes.push({ path, record: read.record });
      else unreadable.push({ path, message: read.message });
    }
    this.#notes.sweep();
    // A sync conflict's copy holds the same id: neither note is listed, and each is said. Both listed, an agent was
    // given whichever sorted last, a principle retired on this Mac served as adopted in the other Mac's words.
    const holders = new Map<string, number>();
    for (const { record } of notes) holders.set(record.id, (holders.get(record.id) ?? 0) + 1);
    const records: MethodologyRecord[] = [];
    for (const { path, record } of notes) {
      if (holders.get(record.id) === 1) records.push(record);
      else unreadable.push({ path, message: duplicateId(record.id) });
    }
    this.#onUnreadable(unreadable);
    return records.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id),
    );
  }

  #pathFor(id: string): string {
    return join(this.#directory, fileNameFor(id));
  }

  /** A principle note as read, or why it could not be: kept while its file is unchanged. */
  #read(path: string): Promise<{ record: MethodologyRecord } | { message: string }> {
    return this.#notes.read(path, async () => {
      try {
        return { record: parseMethodology(await readFile(path, "utf8")) };
      } catch (error) {
        return { message: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  /**
   * The note holding this id: under the id's own file name, or under the name it was given in Obsidian. Held by
   * two (a sync conflict's copy beside it), it is refused, as the list leaves both out: an edit reached one.
   */
  async #locate(id: string): Promise<string | null> {
    const own = this.#pathFor(id);
    let found: string | null = null;
    try {
      await access(own);
      found = own;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Reads every note, each one unchanged since from what was kept.
    for (const path of await collectMarkdown(this.#directory, [])) {
      if (path === own) continue;
      const read = await this.#read(path);
      // One it cannot read is not a principle note of this repository's: it is someone else's.
      if (!("record" in read) || read.record.id !== id) continue;
      if (found !== null) throw new Error(duplicateId(id));
      found = path;
    }
    return found;
  }
}
