export type JournalEntryKind = "preference" | "idea";
export type KnowledgeStatus = "inbox" | "active" | "archived";
export type RecordSensitivity = "private" | "personal" | "shareable";
export type ProactiveSourceKind =
  | "app_manual"
  | "offline_conversation"
  | "meeting"
  | "observation"
  | "agent_capture"
  | "pr_comment";
export type SourceForm =
  | "user_original"
  | "user_paraphrase"
  | "machine_summary";
export type PreferenceStrength =
  | "hard_constraint"
  | "default"
  | "weak_signal";
export type EvidenceMaturity = "self_declared" | "repeated" | "reviewed";
export type IdeaForm =
  | "observation"
  | "question"
  | "hypothesis"
  | "possibility";

export interface JournalEntrySource {
  sourceKind: ProactiveSourceKind;
  sourceForm: SourceForm;
  project?: string | null;
  occurredAt?: string | null;
  sensitivity?: RecordSensitivity;
}

interface JournalEntryDraftBase {
  title: string;
  content: string;
  knowledgeStatus?: KnowledgeStatus;
  context?: string | null;
  rationale?: string | null;
  tags?: string[];
  /** The programming languages it is about; none: it holds whatever the code is written in. */
  languages?: string[];
}

export interface PreferenceEntryDraft extends JournalEntryDraftBase {
  kind: "preference";
  appliesWhen?: string | null;
  exceptions?: string | null;
  strength?: PreferenceStrength;
  evidenceMaturity?: EvidenceMaturity;
}

export interface IdeaEntryDraft extends JournalEntryDraftBase {
  kind: "idea";
  ideaForm?: IdeaForm;
  whyInteresting?: string | null;
  openQuestions?: string[];
  nextTest?: string | null;
  incubateUntil?: string | null;
}

export type JournalEntryDraft = PreferenceEntryDraft | IdeaEntryDraft;

interface JournalEntrySnapshotBase {
  kind: JournalEntryKind;
  title: string;
  content: string;
  knowledgeStatus: KnowledgeStatus;
  sourceKind: ProactiveSourceKind;
  sourceForm: SourceForm;
  project: string | null;
  occurredAt: string | null;
  sensitivity: RecordSensitivity;
  context: string | null;
  rationale: string | null;
  tags: string[];
  /** Canonical language ids (see normalizedLanguages); empty: general, recalled whatever the code is written in. */
  languages: string[];
}

export interface PreferenceEntrySnapshot extends JournalEntrySnapshotBase {
  kind: "preference";
  appliesWhen: string | null;
  exceptions: string | null;
  strength: PreferenceStrength;
  evidenceMaturity: EvidenceMaturity;
}

export interface IdeaEntrySnapshot extends JournalEntrySnapshotBase {
  kind: "idea";
  ideaForm: IdeaForm;
  whyInteresting: string | null;
  openQuestions: string[];
  nextTest: string | null;
  incubateUntil: string | null;
}

export type JournalEntrySnapshot =
  | PreferenceEntrySnapshot
  | IdeaEntrySnapshot;

export interface JournalEntryRevisionEvent {
  revision: number;
  changedAt: string;
  changeNote: string;
  sourceKind: ProactiveSourceKind;
  sourceForm: SourceForm;
  previous: JournalEntrySnapshot;
}

export type JournalEntry = JournalEntrySnapshot & {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  revisionEvents: JournalEntryRevisionEvent[];
};

export interface JournalEntryChange {
  changeNote: string;
  sourceKind: ProactiveSourceKind;
  sourceForm: SourceForm;
}

const boundedText = (
  value: string,
  label: string,
  maximum: number,
): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new Error(`${label} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const optionalText = (
  value: string | null | undefined,
  label: string,
  maximum: number,
): string | null => {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  return boundedText(value, label, maximum);
};

const validDateTime = (value: string | null, label: string): string | null => {
  if (value === null) return null;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date time`);
  }
  return value;
};

const validCalendarDate = (value: string | null, label: string): string | null => {
  if (value === null) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} must be a calendar date`);
  }
  return value;
};

const normalizedTags = (values: string[] | undefined): string[] => {
  // A tag is there or not: one named twice is one tag, not a reason to refuse the entry.
  const tags = [...new Set((values ?? []).map((value) => boundedText(value, "Tag", 100)))];
  if (tags.length > 12) {
    throw new Error("Tags must contain at most 12 unique values");
  }
  return tags;
};

// The names a language goes by, said as one: an entry about "TS" applies where the code is "typescript".
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: "typescript",
  js: "javascript",
  golang: "go",
  py: "python",
  "c#": "csharp",
  cs: "csharp",
  "c++": "cpp",
  kt: "kotlin",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  objc: "objective-c",
};

/** Languages as one canonical lowercase id each, once each: at most 8, each at most 40 characters. */
export const normalizedLanguages = (values: readonly string[] | undefined): string[] => {
  const languages = [...new Set((values ?? []).map((value) => {
    const id = boundedText(value, "Language", 40).toLocaleLowerCase("en-US");
    return LANGUAGE_ALIASES[id] ?? id;
  }))];
  if (languages.length > 8) {
    throw new Error("Languages must contain at most 8 unique values");
  }
  return languages;
};

const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  go: "Go",
  python: "Python",
  rust: "Rust",
  java: "Java",
  kotlin: "Kotlin",
  csharp: "C#",
  cpp: "C++",
  c: "C",
  ruby: "Ruby",
  php: "PHP",
  swift: "Swift",
  dart: "Dart",
  shell: "Shell",
  "objective-c": "Objective-C",
};

/** A canonical language id as people write it: "go" as Go, "csharp" as C#; one not listed as itself. */
export const languageLabel = (language: string): string => LANGUAGE_LABELS[language] ?? language;

const normalizedQuestions = (values: string[] | undefined): string[] => {
  const questions = (values ?? []).map((value) =>
    boundedText(value, "Open question", 1_000),
  );
  if (questions.length > 8) {
    throw new Error("Open questions must contain at most 8 values");
  }
  return questions;
};

const normalizedStatus = (
  draft: JournalEntryDraft,
  appliesWhen: string | null,
  exceptions: string | null,
  whyInteresting: string | null,
): KnowledgeStatus => {
  const requested = draft.knowledgeStatus;
  if (draft.kind === "preference") {
    const complete = appliesWhen !== null && exceptions !== null;
    if (requested === "active" && !complete) {
      throw new Error("有效偏好必须填写作用域和例外");
    }
    return requested ?? (complete ? "active" : "inbox");
  }
  if (requested === "active" && whyInteresting === null) {
    throw new Error("有效想法必须说明为什么值得保留");
  }
  return requested ?? (whyInteresting === null ? "inbox" : "active");
};

const snapshotFrom = (
  draft: JournalEntryDraft,
  source: JournalEntrySource,
): JournalEntrySnapshot => {
  const title = boundedText(draft.title, "Title", 500);
  const content = boundedText(draft.content, "Content", 8_000);
  const context = optionalText(draft.context, "Context", 8_000);
  const rationale = optionalText(draft.rationale, "Rationale", 8_000);
  const project = optionalText(source.project, "Project", 500);
  const occurredAt = validDateTime(
    source.occurredAt ?? null,
    "Occurred at",
  );
  const common = {
    title,
    content,
    sourceKind: source.sourceKind,
    sourceForm: source.sourceForm,
    project,
    occurredAt,
    sensitivity: source.sensitivity ?? "private",
    context,
    rationale,
    tags: normalizedTags(draft.tags),
    languages: normalizedLanguages(draft.languages),
  };

  if (draft.kind === "preference") {
    const appliesWhen = optionalText(
      draft.appliesWhen,
      "Applies when",
      4_000,
    );
    const exceptions = optionalText(draft.exceptions, "Exceptions", 4_000);
    return {
      ...common,
      kind: "preference",
      knowledgeStatus: normalizedStatus(draft, appliesWhen, exceptions, null),
      appliesWhen,
      exceptions,
      strength: draft.strength ?? "default",
      evidenceMaturity: draft.evidenceMaturity ?? "self_declared",
    };
  }

  const whyInteresting = optionalText(
    draft.whyInteresting,
    "Why interesting",
    4_000,
  );
  return {
    ...common,
    kind: "idea",
    knowledgeStatus: normalizedStatus(draft, null, null, whyInteresting),
    ideaForm: draft.ideaForm ?? "possibility",
    whyInteresting,
    openQuestions: normalizedQuestions(draft.openQuestions),
    nextTest: optionalText(draft.nextTest, "Next test", 4_000),
    incubateUntil: validCalendarDate(
      optionalText(draft.incubateUntil, "Incubate until", 10),
      "Incubate until",
    ),
  };
};

const cloneSnapshot = (entry: JournalEntry): JournalEntrySnapshot =>
  entry.kind === "preference"
    ? {
        kind: "preference",
        title: entry.title,
        content: entry.content,
        knowledgeStatus: entry.knowledgeStatus,
        sourceKind: entry.sourceKind,
        sourceForm: entry.sourceForm,
        project: entry.project,
        occurredAt: entry.occurredAt,
        sensitivity: entry.sensitivity,
        context: entry.context,
        rationale: entry.rationale,
        tags: [...entry.tags],
        languages: [...entry.languages],
        appliesWhen: entry.appliesWhen,
        exceptions: entry.exceptions,
        strength: entry.strength,
        evidenceMaturity: entry.evidenceMaturity,
      }
    : {
        kind: "idea",
        title: entry.title,
        content: entry.content,
        knowledgeStatus: entry.knowledgeStatus,
        sourceKind: entry.sourceKind,
        sourceForm: entry.sourceForm,
        project: entry.project,
        occurredAt: entry.occurredAt,
        sensitivity: entry.sensitivity,
        context: entry.context,
        rationale: entry.rationale,
        tags: [...entry.tags],
        languages: [...entry.languages],
        ideaForm: entry.ideaForm,
        whyInteresting: entry.whyInteresting,
        openQuestions: [...entry.openQuestions],
        nextTest: entry.nextTest,
        incubateUntil: entry.incubateUntil,
      };

export const createJournalEntry = (
  draft: JournalEntryDraft,
  source: JournalEntrySource,
  id: string,
  now: Date,
): JournalEntry => {
  const normalizedId = boundedText(id, "Journal entry ID", 200);
  const snapshot = snapshotFrom(draft, source);
  const timestamp = now.toISOString();
  return {
    ...snapshot,
    id: normalizedId,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    revisionEvents: [],
  };
};

export const reviseJournalEntry = (
  current: JournalEntry,
  draft: JournalEntryDraft,
  change: JournalEntryChange,
  now: Date,
): JournalEntry => {
  if (draft.kind !== current.kind) {
    throw new Error("Journal entry kind cannot change");
  }
  const changeNote = boundedText(change.changeNote, "变更原因", 1_000);
  const snapshot = snapshotFrom(draft, {
    sourceKind: current.sourceKind,
    sourceForm: current.sourceForm,
    project: current.project,
    occurredAt: current.occurredAt,
    sensitivity: current.sensitivity,
  });
  const revision = current.revision + 1;
  const changedAt = now.toISOString();
  return {
    ...snapshot,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: changedAt,
    revision,
    revisionEvents: [
      ...current.revisionEvents.map((event) => ({
        ...event,
        previous:
          event.previous.kind === "idea"
            ? { ...event.previous, tags: [...event.previous.tags], languages: [...event.previous.languages], openQuestions: [...event.previous.openQuestions] }
            : { ...event.previous, tags: [...event.previous.tags], languages: [...event.previous.languages] },
      })),
      {
        revision,
        changedAt,
        changeNote,
        sourceKind: change.sourceKind,
        sourceForm: change.sourceForm,
        previous: cloneSnapshot(current),
      },
    ],
  };
};
