import {
  createJournalEntry,
  type JournalEntry,
  type JournalEntryDraft,
  type JournalEntryRevisionEvent,
  type JournalEntrySnapshot,
  type JournalEntrySource,
  type KnowledgeStatus,
  type ProactiveSourceKind,
  type RecordSensitivity,
  type SourceForm,
} from "@cognelis/decision-core";
import { createHash } from "node:crypto";
import {
  readFile,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { assertVaultPresent, collectMarkdown, inFormOf, normalizedNote, noteText, withProperties } from "./markdown.js";
import { escapeNoteText, namedTitleHeading, notePropertiesYaml, ownTitleHeading, titleAmbiguous, titleHeading, unescapeNoteText } from "./markdown-markers.js";
import { replaceNote } from "./note-rewrite.js";
import { NoteCache } from "./note-cache.js";
import { foldedText, searchTokens } from "./search-text.js";

const DEFAULT_FOLDER = "Decision Journal";
const NOTE_TYPE = "decision-journal-entry";
const NOTE_VERSION = 1;
const HISTORY_FENCE = "decision-journal-history";
const MARKERS = {
  content: [
    "<!-- decision:journal-content-start -->",
    "<!-- decision:journal-content-end -->",
  ],
  context: [
    "<!-- decision:journal-context-start -->",
    "<!-- decision:journal-context-end -->",
  ],
  rationale: [
    "<!-- decision:journal-rationale-start -->",
    "<!-- decision:journal-rationale-end -->",
  ],
  appliesWhen: [
    "<!-- decision:journal-applies-start -->",
    "<!-- decision:journal-applies-end -->",
  ],
  exceptions: [
    "<!-- decision:journal-exceptions-start -->",
    "<!-- decision:journal-exceptions-end -->",
  ],
  whyInteresting: [
    "<!-- decision:journal-interest-start -->",
    "<!-- decision:journal-interest-end -->",
  ],
  openQuestions: [
    "<!-- decision:journal-questions-start -->",
    "<!-- decision:journal-questions-end -->",
  ],
  nextTest: [
    "<!-- decision:journal-next-test-start -->",
    "<!-- decision:journal-next-test-end -->",
  ],
} as const;

export interface JournalEntryDiagnostic {
  path: string;
  message: string;
}

export interface JournalEntryQuery {
  query?: string;
  kind?: JournalEntry["kind"];
  knowledgeStatus?: KnowledgeStatus;
  limit?: number;
  /** Every match, for the app's own recall: a standing preference is no less current for being old. */
  everything?: boolean;
}

export interface JournalEntryScan {
  entries: JournalEntry[];
  diagnostics: JournalEntryDiagnostic[];
}

export interface JournalEntryWriteResult {
  entry: JournalEntry;
  created: boolean;
  /** Found already there, and changed in Obsidian since the app last wrote it. */
  editedOutsideApp?: boolean;
}

interface StoredJournalEntry {
  entry: JournalEntry;
  path: string;
  editedOutsideApp: boolean;
}

interface JournalEntryRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
  /** The vault folder must already exist: a write never makes it up (see assertVaultPresent). */
  existingVault?: boolean;
}

const requiredText = (
  value: unknown,
  label: string,
  maximum: number,
): string => {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const optionalText = (
  value: unknown,
  label: string,
  maximum: number,
): string | null => {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  return requiredText(value, label, maximum);
};

const requiredDate = (value: unknown, label: string): string => {
  const date = requiredText(value, label, 100);
  if (!Number.isFinite(Date.parse(date))) {
    throw new Error(`${label} must be an ISO date time`);
  }
  return date;
};

const optionalDate = (value: unknown, label: string): string | null => {
  const date = optionalText(value, label, 100);
  if (date !== null && !Number.isFinite(Date.parse(date))) {
    throw new Error(`${label} must be an ISO date time`);
  }
  return date;
};

const requiredInteger = (value: unknown, label: string): number => {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
};

const optionalBody = (value: string | null): string => value ?? "";

/**
 * What a search looks through: the text a person can read on an entry, and its id, which a jump finds it by. Field
 * names, states, dates and earlier revisions are not in it, so a common word does not match every entry.
 */
const searchableText = (entry: JournalEntry): string => [
  entry.id, entry.title, entry.content, entry.context, entry.rationale, entry.project, ...entry.tags,
  ...(entry.kind === "preference" ? [entry.appliesWhen, entry.exceptions] : [entry.whyInteresting, ...entry.openQuestions, entry.nextTest]),
].filter((part): part is string => typeof part === "string").join("\n");

// A marker counts only where a line begins with it (spaces an editor left around it aside), and text that
// quotes one is escaped where it is written: an entry saying "<!-- decision:journal-content-end -->" keeps
// the rest of what it says.
const lineMarker = (marker: string): RegExp =>
  new RegExp(`\\n[ \\t]*${marker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");

const markedSection = (
  body: string,
  markers: readonly [string, string],
  label: string,
  maximum: number,
): string | null => {
  const start = lineMarker(markers[0]).exec(body);
  const rest = start === null ? "" : body.slice(start.index + start[0].length);
  const end = start === null ? null : lineMarker(markers[1]).exec(rest);
  if (end === null) throw new Error(`Journal entry is missing ${label}`);
  return optionalText(
    unescapeNoteText(rest.slice(0, end.index)),
    label,
    maximum,
  );
};

const marked = (
  markers: readonly [string, string],
  value: string | null,
): string => `${markers[0]}\n${optionalBody(value === null ? null : escapeNoteText(value))}\n${markers[1]}`;

const splitDocument = (
  markdown: string,
): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Journal entry must begin with YAML frontmatter");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("Journal entry has unterminated YAML frontmatter");
  }
  const parsed = parseYaml(markdown.slice(4, boundary));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Journal entry frontmatter must be an object");
  }
  return {
    properties: parsed as Record<string, unknown>,
    body: markdown.slice(boundary + 5),
  };
};

const MARKER_STARTS = Object.values(MARKERS).map(([start]) => start);

const titleFrom = (body: string, property: unknown): string => {
  const match = ownTitleHeading(body, MARKER_STARTS, property);
  if (match === null) throw new Error("Journal entry is missing title");
  return requiredText(unescapeNoteText(match.text), "Title", 500);
};

const stringArray = (value: unknown, label: string, maximum: number): string[] => {
  if (value === null || value === undefined) return [];
  // One value, as Obsidian writes a list property holding one, and as the decision and principle notes read it:
  // refused here, the whole entry left every list for a tag.
  const items = typeof value === "string" ? [value] : value;
  if (!Array.isArray(items) || items.length > maximum) {
    throw new Error(`${label} must be an array with at most ${maximum} values`);
  }
  const result = items.map((item) => requiredText(item, label, 1_000));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} values must be unique`);
  }
  return result;
};

const bulletList = (value: string | null): string[] =>
  value === null
    ? []
    : value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/^-\s*/u, ""))
        .map((line) => requiredText(line, "Open question", 1_000));

const snapshotDraft = (snapshot: JournalEntrySnapshot): JournalEntryDraft =>
  snapshot.kind === "preference"
    ? {
        kind: "preference",
        title: snapshot.title,
        content: snapshot.content,
        knowledgeStatus: snapshot.knowledgeStatus,
        context: snapshot.context,
        rationale: snapshot.rationale,
        tags: [...snapshot.tags],
        // Kept by a revision written before languages were: none, as then.
        languages: [...(snapshot.languages ?? [])],
        appliesWhen: snapshot.appliesWhen,
        exceptions: snapshot.exceptions,
        strength: snapshot.strength,
        evidenceMaturity: snapshot.evidenceMaturity,
      }
    : {
        kind: "idea",
        title: snapshot.title,
        content: snapshot.content,
        knowledgeStatus: snapshot.knowledgeStatus,
        context: snapshot.context,
        rationale: snapshot.rationale,
        tags: [...snapshot.tags],
        languages: [...(snapshot.languages ?? [])],
        ideaForm: snapshot.ideaForm,
        whyInteresting: snapshot.whyInteresting,
        openQuestions: [...snapshot.openQuestions],
        nextTest: snapshot.nextTest,
        incubateUntil: snapshot.incubateUntil,
      };

const snapshotSource = (snapshot: JournalEntrySnapshot): JournalEntrySource => ({
  sourceKind: snapshot.sourceKind,
  sourceForm: snapshot.sourceForm,
  project: snapshot.project,
  occurredAt: snapshot.occurredAt,
  sensitivity: snapshot.sensitivity,
});

const validatedSnapshot = (value: unknown): JournalEntrySnapshot => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Revision snapshot must be an object");
  }
  const candidate = value as JournalEntrySnapshot;
  if (candidate.kind !== "preference" && candidate.kind !== "idea") {
    throw new Error("Revision snapshot kind is invalid");
  }
  const normalized = createJournalEntry(
    snapshotDraft(candidate),
    snapshotSource(candidate),
    "revision-snapshot",
    new Date("2000-01-01T00:00:00.000Z"),
  );
  const { id: _id, createdAt: _created, updatedAt: _updated, revision: _revision, revisionEvents: _events, ...snapshot } = normalized;
  return snapshot;
};

const historyFrom = (
  body: string,
  expectedRevision: number,
  kind: JournalEntry["kind"],
): JournalEntryRevisionEvent[] => {
  const pattern = new RegExp(
    "\\n\\n```" + HISTORY_FENCE + "\\n([\\s\\S]*?)\\n```",
    "u",
  );
  const encoded = body.match(pattern)?.[1];
  if (encoded === undefined) throw new Error("Journal entry is missing revision history");
  const value = JSON.parse(encoded) as unknown;
  if (!Array.isArray(value) || value.length !== expectedRevision - 1) {
    throw new Error("Journal entry revision history length is invalid");
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Journal entry revision event must be an object");
    }
    const event = item as Record<string, unknown>;
    const revision = requiredInteger(event.revision, "Revision event number");
    if (revision !== index + 2) {
      throw new Error("Journal entry revision sequence is invalid");
    }
    const sourceKind = requiredText(event.sourceKind, "Revision source kind", 100);
    const sourceForm = requiredText(event.sourceForm, "Revision source form", 100);
    if (
      !["app_manual", "offline_conversation", "meeting", "observation", "agent_capture"].includes(sourceKind) ||
      !["user_original", "user_paraphrase", "machine_summary"].includes(sourceForm)
    ) {
      throw new Error("Journal entry revision source is invalid");
    }
    const previous = validatedSnapshot(event.previous);
    if (previous.kind !== kind) {
      throw new Error("Journal entry revision kind cannot change");
    }
    return {
      revision,
      changedAt: requiredDate(event.changedAt, "Revision changedAt"),
      changeNote: requiredText(event.changeNote, "Revision change note", 1_000),
      sourceKind: sourceKind as ProactiveSourceKind,
      sourceForm: sourceForm as SourceForm,
      previous,
    };
  });
};

/**
 * A property typed by hand in Obsidian outside its values (硬约束 for hard_constraint): said by name when the
 * note is read. Taken as it stood, the entry was listed, then every archive and revision of it refused.
 */
const oneOf = <T extends string>(value: unknown, property: string, allowed: readonly T[]): T => {
  const text = requiredText(value, property, 100);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`属性 ${property} 的值「${text}」无效，只能是 ${allowed.join("、")} 之一`);
  }
  return text as T;
};

const sourceKind = (value: unknown): ProactiveSourceKind =>
  oneOf(value, "source_kind", ["app_manual", "offline_conversation", "meeting", "observation", "agent_capture"]);

const sourceForm = (value: unknown): SourceForm =>
  oneOf(value, "source_form", ["user_original", "user_paraphrase", "machine_summary"]);

const sensitivity = (value: unknown): RecordSensitivity =>
  oneOf(value, "sensitivity", ["private", "personal", "shareable"]);

const knowledgeStatus = (value: unknown): KnowledgeStatus =>
  oneOf(value, "knowledge_status", ["inbox", "active", "archived"]);

export const journalEntryFingerprint = (
  entry: Pick<JournalEntry, "kind" | "title" | "content">,
): string =>
  createHash("sha256")
    .update(
      [entry.kind, entry.title, entry.content]
        .map((value) => value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN"))
        .join("\n"),
      "utf8",
    )
    .digest("hex");

const historySummary = (entry: JournalEntry): string =>
  entry.revisionEvents.length === 0
    ? `### v1 · ${entry.createdAt}\n\n- 首次记录`
    : [
        `### v1 · ${entry.createdAt}\n\n- 首次记录`,
        ...entry.revisionEvents.map(
          (event) =>
            `### v${event.revision} · ${event.changedAt}\n\n- ${event.changeNote}`,
        ),
      ].join("\n\n");

export const serializeJournalEntry = (entry: JournalEntry): string => {
  const frontmatter = notePropertiesYaml(
    {
      type: NOTE_TYPE,
      version: NOTE_VERSION,
      id: entry.id,
      // Which heading is the app's title, wherever headings of the reader's stand beside it (namedTitleHeading).
      title: escapeNoteText(entry.title),
      record_kind: entry.kind,
      created: entry.createdAt,
      updated: entry.updatedAt,
      revision: entry.revision,
      knowledge_status: entry.knowledgeStatus,
      source_kind: entry.sourceKind,
      source_form: entry.sourceForm,
      project: entry.project,
      occurred_at: entry.occurredAt,
      sensitivity: entry.sensitivity,
      tags: entry.tags,
      // Left out for a general entry: such a note reads as it did before languages were kept.
      languages: entry.languages.length > 0 ? entry.languages : undefined,
      content_fingerprint: journalEntryFingerprint(entry),
      app_written: appWritten(entry),
      ...(entry.kind === "preference"
        ? {
            preference_strength: entry.strength,
            evidence_maturity: entry.evidenceMaturity,
          }
        : {
            idea_form: entry.ideaForm,
            incubate_until: entry.incubateUntil,
          }),
    },
    { lineWidth: 0 },
  ).trimEnd();

  const common = `## 背景\n\n${marked(MARKERS.context, entry.context)}\n\n## 为什么值得记录\n\n${marked(MARKERS.rationale, entry.rationale)}`;
  const typed =
    entry.kind === "preference"
      ? `## 当前偏好\n\n${marked(MARKERS.content, entry.content)}\n\n## 适用条件\n\n${marked(MARKERS.appliesWhen, entry.appliesWhen)}\n\n## 例外与边界\n\n${marked(MARKERS.exceptions, entry.exceptions)}`
      : `## 想法\n\n${marked(MARKERS.content, entry.content)}\n\n## 为什么值得保留\n\n${marked(MARKERS.whyInteresting, entry.whyInteresting)}\n\n## 开放问题\n\n${marked(MARKERS.openQuestions, entry.openQuestions.map((item) => `- ${item}`).join("\n") || null)}\n\n## 下一步验证\n\n${marked(MARKERS.nextTest, entry.nextTest)}`;
  // `<` as its JSON unicode escape, read back as itself: a revision's previous text, an agent's, kept Templater's
  // `<%` in it.
  const history = JSON.stringify(entry.revisionEvents, null, 2).replaceAll("<", "\\u003c");
  return `---\n${frontmatter}\n---\n\n# ${escapeNoteText(entry.title)}\n\n${typed}\n\n${common}\n\n## 变更记录\n\n${historySummary(entry)}\n\n\`\`\`${HISTORY_FENCE}\n${history}\n\`\`\`\n`;
};

export const parseJournalEntry = (note: string): JournalEntry => {
  // Saved with Windows line endings (git's autocrlf) or a BOM, the same note: read as it was, it left every list.
  const markdown = normalizedNote(note);
  const { properties, body } = splitDocument(markdown);
  if (properties.type !== NOTE_TYPE || properties.version !== NOTE_VERSION) {
    throw new Error("Journal entry type or version is invalid");
  }
  const kind = properties.record_kind;
  if (kind !== "preference" && kind !== "idea") {
    throw new Error("Journal entry kind is invalid");
  }
  const revision = requiredInteger(properties.revision, "Revision");
  const commonDraft = {
    title: titleFrom(body, properties.title),
    content: requiredText(
      markedSection(body, MARKERS.content, "content", 8_000),
      "Content",
      8_000,
    ),
    knowledgeStatus: knowledgeStatus(properties.knowledge_status),
    context: markedSection(body, MARKERS.context, "context", 8_000),
    rationale: markedSection(body, MARKERS.rationale, "rationale", 8_000),
    tags: stringArray(properties.tags, "Tags", 12),
    languages: stringArray(properties.languages, "Languages", 8),
  };
  const draft: JournalEntryDraft =
    kind === "preference"
      ? {
          ...commonDraft,
          kind,
          appliesWhen: markedSection(body, MARKERS.appliesWhen, "appliesWhen", 4_000),
          exceptions: markedSection(body, MARKERS.exceptions, "exceptions", 4_000),
          strength: oneOf(properties.preference_strength, "preference_strength", ["hard_constraint", "default", "weak_signal"]),
          evidenceMaturity: oneOf(properties.evidence_maturity, "evidence_maturity", ["self_declared", "repeated", "reviewed"]),
        }
      : {
          ...commonDraft,
          kind,
          ideaForm: oneOf(properties.idea_form, "idea_form", ["observation", "question", "hypothesis", "possibility"]),
          whyInteresting: markedSection(body, MARKERS.whyInteresting, "whyInteresting", 4_000),
          openQuestions: bulletList(markedSection(body, MARKERS.openQuestions, "openQuestions", 8_000)),
          nextTest: markedSection(body, MARKERS.nextTest, "nextTest", 4_000),
          incubateUntil: optionalText(properties.incubate_until, "Incubate until", 10),
        };
  const createdAt = requiredDate(properties.created, "Created");
  const base = createJournalEntry(
    draft,
    {
      sourceKind: sourceKind(properties.source_kind),
      sourceForm: sourceForm(properties.source_form),
      project: optionalText(properties.project, "Project", 500),
      occurredAt: optionalDate(properties.occurred_at, "Occurred at"),
      sensitivity: sensitivity(properties.sensitivity),
    },
    requiredText(properties.id, "Journal entry ID", 200),
    new Date(createdAt),
  );
  const updatedAt = requiredDate(properties.updated, "Updated");
  const revisionEvents = historyFrom(body, revision, kind);
  return {
    ...base,
    createdAt,
    updatedAt,
    revision,
    revisionEvents,
  };
};

/**
 * The note for an entry, refused rather than written when it would not read back as that entry: text the
 * note's own structure would cut short or change is caught here, before a file a scan cannot read exists.
 */
// Compared as what the entry says, in any key order: a revision read back lists its fields in its own.
// No languages is left out, as a note written before they were kept has none: its app_written hash still matches,
// where every such entry read as changed in Obsidian.
const canonical = (value: unknown): string => JSON.stringify(value, (key, item: unknown) =>
  key === "languages" && Array.isArray(item) && item.length === 0
    ? undefined
    : item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1)))
      : item);

/**
 * An entry's text as its note keeps it: line breaks as \n, and a backslash before `##` gone as Markdown reads
 * it (see unescapeNoteText). Compared as given, an agent's preference sent with Windows line breaks would not
 * read back as written, and was refused as not recorded. Read until it reads back as itself: each reading takes
 * one more backslash off one before a marker (`\\<!-- decision:`, read as a marker escaped long ago).
 */
const asKept = (entry: JournalEntry): JournalEntry => {
  const once = (text: string): string => unescapeNoteText(escapeNoteText(text));
  const kept = (text: string): string => {
    let read = text.replace(/\r\n?/gu, "\n");
    // A reading only takes backslashes off: shorter each time, it settles.
    for (let next = once(read); next !== read && next.length < read.length; next = once(read)) read = next;
    return read;
  };
  const keptOrNull = (text: string | null): string | null => (text === null ? null : kept(text));
  const common = { title: kept(entry.title), content: kept(entry.content), context: keptOrNull(entry.context), rationale: keptOrNull(entry.rationale) };
  return entry.kind === "preference"
    ? { ...entry, ...common, appliesWhen: keptOrNull(entry.appliesWhen), exceptions: keptOrNull(entry.exceptions) }
    : { ...entry, ...common, whyInteresting: keptOrNull(entry.whyInteresting), openQuestions: entry.openQuestions.map(kept), nextTest: keptOrNull(entry.nextTest) };
};

/** What the app wrote, as one hash kept in the note: read back as something else, it was changed in Obsidian. */
const appWritten = (entry: JournalEntry): string => createHash("sha256").update(canonical(entry), "utf8").digest("hex");

/**
 * Whether the note was changed in Obsidian since the app last wrote it. An agent restating an entry only it had
 * written rewrote the reader's change there (a constraint made hard, an exception taken out). A note from before
 * the hash was kept is taken as the app's.
 */
const editedOutsideApp = (note: string, entry: JournalEntry): boolean => {
  const written = splitDocument(normalizedNote(note)).properties.app_written;
  return typeof written === "string" && written !== appWritten(entry);
};

const faithfulNote = (entry: JournalEntry): string => {
  const markdown = serializeJournalEntry(entry);
  if (canonical(parseJournalEntry(markdown)) !== canonical(entry)) {
    throw new Error("Journal entry would not read back as written");
  }
  return markdown;
};

/** From the line a start marker opens to the end of its end marker, found as the parser finds them. */
const markedRange = (body: string, markers: readonly [string, string]): [number, number] | null => {
  const start = lineMarker(markers[0]).exec(body);
  if (start === null) return null;
  const after = start.index + start[0].length;
  const end = lineMarker(markers[1]).exec(body.slice(after));
  return end === null ? null : [start.index + 1, after + end.index + end[0].length];
};

const historyBlock = new RegExp("\\n## 变更记录\\n[\\s\\S]*?\\n```" + HISTORY_FENCE + "\\n[\\s\\S]*?\\n```", "u");

/**
 * The revised entry written into the note as it stands: the app's own properties, its marked sections, its
 * title and its history are replaced, and what the reader added in Obsidian (aliases, a link after a section,
 * a section of their own) is kept. Written out whole, one click on 归档 took all of that with it.
 */
const revisedNote = (raw: string, entry: JournalEntry): string => {
  // Edited as read, and written back with the line endings and BOM it had.
  const existing = normalizedNote(raw);
  const fresh = serializeJournalEntry(entry);
  const boundary = existing.indexOf("\n---\n", 4);
  // Languages cleared are taken out of the note, not left there to be read back.
  const properties = withProperties(existing.slice(4, boundary), {
    ...splitDocument(fresh).properties,
    languages: entry.languages.length > 0 ? entry.languages : undefined,
  });
  let body = existing.slice(boundary + 5);
  const freshBody = splitDocument(fresh).body;
  for (const markers of Object.values(MARKERS)) {
    const target = markedRange(body, markers);
    const source = markedRange(freshBody, markers);
    if (source === null) continue;
    if (target === null) throw new Error("这条记录在 Obsidian 里少了 App 写的分节标记，无法在保留你的改动的同时写入，请在 Obsidian 里修改它。");
    const section = freshBody.slice(source[0], source[1]);
    // Read back as the same text, a section keeps its bytes (as rewrittenNote's do): written again escaped, a
    // screenshot or a highlight the reader put in it turned into literal text on 归档.
    if (unescapeNoteText(body.slice(target[0], target[1])) === unescapeNoteText(section)) continue;
    body = `${body.slice(0, target[0])}${section}${body.slice(target[1])}`;
  }
  const title = `# ${escapeNoteText(entry.title)}`;
  // The line the note's own `title` property names, known wherever headings of the reader's stand (rewrittenNote's
  // rule); in a note from before it, the line read as the title, refused as there when a heading of the reader's
  // nearer the app's part leaves it a guess.
  const named = namedTitleHeading(body, MARKER_STARTS, splitDocument(existing).properties.title);
  const heading = named ?? titleHeading(body, MARKER_STARTS, title);
  const nearest = titleHeading(body, MARKER_STARTS);
  if (named === null && heading !== null && nearest !== null && nearest.index !== heading.index) throw new Error(titleAmbiguous(nearest.text));
  if (heading !== null && unescapeNoteText(heading.line) !== unescapeNoteText(title)) {
    body = `${body.slice(0, heading.index)}${title}${body.slice(heading.index + heading.line.length)}`;
  }
  const history = freshBody.match(historyBlock)?.[0];
  if (history === undefined || !historyBlock.test(body)) {
    throw new Error("这条记录在 Obsidian 里少了变更记录，无法在保留你的改动的同时写入，请在 Obsidian 里修改它。");
  }
  body = body.replace(historyBlock, () => history);
  const markdown = `---\n${properties}\n---\n${body}`;
  if (canonical(parseJournalEntry(markdown)) !== canonical(entry)) {
    throw new Error("这条记录在 Obsidian 里的改动让 App 无法安全写入，请在 Obsidian 里修改它。");
  }
  return inFormOf(raw, markdown);
};

const safeSlug = (value: string): string =>
  value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "") || "entry";

const fileNameFor = (entry: JournalEntry): string => {
  const digest = createHash("sha256").update(entry.id, "utf8").digest("hex").slice(0, 12);
  return `${safeSlug(entry.title)}-${digest}.md`;
};

const relevance = (entry: JournalEntry, tokens: readonly string[]): number => {
  const title = foldedText(entry.title);
  const content = foldedText(entry.content);
  return tokens.reduce((rank, token) => rank + (title.includes(token) ? 2 : 0) + (content.includes(token) ? 1 : 0), 0);
};

const duplicateId = (id: string): string =>
  `有不止一篇偏好或想法笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`;

/** Gone from the vault since the page listed it (deleted, moved away, or edited past reading). */
export const journalEntryGone = "这条记录在 Obsidian 里已经找不到了（可能已被删除、移走或改坏），列表已重新读取。";

export class JournalEntryRepository {
  readonly #vaultPath: string;
  readonly #folder: string;
  readonly #rename: typeof rename;
  readonly #existingVault: boolean;
  // Every list, lookup and record read all the entries again: quick jump per keystroke, an agent per call.
  readonly #notes = new NoteCache<{ entry: JournalEntry; editedOutsideApp: boolean } | { message: string }>(undefined, (read) => "entry" in read);

  constructor(vaultPath: string, options: JournalEntryRepositoryOptions = {}) {
    this.#vaultPath = vaultPath;
    this.#folder = options.folder ?? DEFAULT_FOLDER;
    this.#rename = options.rename ?? rename;
    this.#existingVault = options.existingVault ?? false;
  }

  async list(query: JournalEntryQuery = {}): Promise<JournalEntryScan> {
    const stored = await this.#scan();
    // A sync conflict's copy holds the same id: listed once and said, where it showed twice under one key.
    const diagnostics = [...stored.diagnostics];
    const listed = new Set<string>();
    const unique = stored.entries.filter((item) => {
      if (!listed.has(item.entry.id)) return listed.add(item.entry.id);
      diagnostics.push({ path: item.path, message: duplicateId(item.entry.id) });
      return false;
    });
    // Words as the decisions in the same search box are looked for, in one width and case (search-text.ts).
    const tokens = searchTokens(query.query ?? "");
    const limit = query.everything === true
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.min(200, Math.trunc(query.limit ?? 200)));
    const entries = unique
      .map((item) => item.entry)
      .filter((entry) => query.kind === undefined || entry.kind === query.kind)
      .filter(
        (entry) =>
          query.knowledgeStatus === undefined ||
          entry.knowledgeStatus === query.knowledgeStatus,
      )
      .filter((entry) => {
        // Nothing asked for, nothing to look through: every consultation lists them all.
        if (tokens.length === 0) return true;
        const haystack = foldedText(searchableText(entry));
        return tokens.every((token) => haystack.includes(token));
      })
      // Searched, an entry whose title holds the words comes before newer ones that only mention them (a project
      // named after them): ranked by recency alone, ⌘K's five and the assistant's five held none of it.
      .map((entry) => ({ entry, rank: relevance(entry, tokens) }))
      .sort((left, right) =>
        right.rank - left.rank ||
        right.entry.updatedAt.localeCompare(left.entry.updatedAt) ||
        right.entry.id.localeCompare(left.entry.id),
      )
      .map(({ entry }) => entry)
      .slice(0, limit);
    return { entries, diagnostics };
  }

  /**
   * `sure`: for a caller that takes "not there" as deleted. A scan that could not read every note (one iCloud moved
   * off this Mac, one busy just then) does not say an entry is gone, and throws instead of answering null.
   */
  async find(id: string, { sure = false }: { sure?: boolean } = {}): Promise<JournalEntry | null> {
    const stored = await this.#scan();
    const matches = stored.entries.filter((item) => item.entry.id === id);
    if (matches.length > 1) throw new Error(duplicateId(id));
    if (sure && matches.length === 0 && stored.diagnostics.length > 0) {
      throw new Error("部分偏好或想法这次没能读取，不能确定这条已不在。");
    }
    return matches[0]?.entry ?? null;
  }

  async create(input: JournalEntry): Promise<JournalEntryWriteResult> {
    const entry = asKept(input);
    const stored = await this.#scan();
    const existing = stored.entries.find(
      (item) => journalEntryFingerprint(item.entry) === journalEntryFingerprint(entry),
    );
    if (existing !== undefined) return { entry: existing.entry, created: false, editedOutsideApp: existing.editedOutsideApp };
    if (stored.entries.some((item) => item.entry.id === entry.id)) {
      throw new Error(`Journal entry ID already exists: ${entry.id}`);
    }
    const note = faithfulNote(entry);
    const target = this.#pathFor(entry);
    await this.#write(target, null, note);
    return { entry: parseJournalEntry(await readFile(target, "utf8")), created: true };
  }

  async revise(id: string, input: JournalEntry): Promise<JournalEntry> {
    const entry = asKept(input);
    if (entry.id !== id) throw new Error("Journal entry revision ID does not match");
    const stored = await this.#scan();
    const matches = stored.entries.filter((item) => item.entry.id === id);
    if (matches.length === 0) throw new Error(journalEntryGone);
    if (matches.length > 1) throw new Error(duplicateId(id));
    const current = matches[0]!;
    if (entry.revision !== current.entry.revision + 1) {
      throw new Error("Journal entry revision must advance by exactly one");
    }
    const raw = await noteText(current.path);
    await this.#write(current.path, raw, revisedNote(raw, entry));
    return parseJournalEntry(await readFile(current.path, "utf8"));
  }

  #pathFor(entry: JournalEntry): string {
    const root = join(
      this.#vaultPath,
      this.#folder,
      entry.kind === "preference" ? "preferences" : "ideas",
    );
    if (entry.kind === "preference") return join(root, fileNameFor(entry));
    const [year, month] = entry.createdAt.slice(0, 10).split("-");
    if (year === undefined || month === undefined) {
      throw new Error("Journal entry created date is invalid");
    }
    return join(root, year, month, fileNameFor(entry));
  }

  async #scan(): Promise<{
    entries: StoredJournalEntry[];
    diagnostics: JournalEntryDiagnostic[];
  }> {
    // A vault that is not there is not one with no preferences or ideas (see MethodologyRepository.list).
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    const root = join(this.#vaultPath, this.#folder);
    // A month's folder it cannot list, or a note iCloud moved off this Mac, is said and passed over: one such
    // folder made every list, lookup and record fail, an agent's included.
    const diagnostics: JournalEntryDiagnostic[] = [];
    const paths = [
      ...(await collectMarkdown(join(root, "preferences"), diagnostics)),
      ...(await collectMarkdown(join(root, "ideas"), diagnostics)),
    ];
    const entries: StoredJournalEntry[] = [];
    for (const path of paths) {
      const read = await this.#notes.read(path, async () => {
        try {
          const note = await readFile(path, "utf8");
          const entry = parseJournalEntry(note);
          return { entry, editedOutsideApp: editedOutsideApp(note, entry) };
        } catch (error) {
          return { message: error instanceof Error ? error.message : String(error) };
        }
      });
      if ("entry" in read) entries.push({ entry: read.entry, path, editedOutsideApp: read.editedOutsideApp });
      else diagnostics.push({ path, message: read.message });
    }
    this.#notes.sweep();
    return { entries, diagnostics };
  }

  /** `raw`: the note as read before `content` was made from it (null for a new one); changed since, the write is refused. */
  async #write(target: string, raw: string | null, content: string): Promise<void> {
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    await replaceNote(target, raw, content, this.#rename);
  }
}
