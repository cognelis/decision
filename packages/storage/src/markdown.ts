import type {
  DecisionRecord,
  DecisionRecordSourceClient,
  DecisionType,
  OutcomeReview,
  OutcomeVerdict,
  PersistedDecisionStatus,
  ProactiveSourceKind,
  RationaleStatus,
  RecordSensitivity,
  RecordedDecisionOption,
  SelectedAnswer,
  SourceForm,
} from "@cognelis/decision-core";
import { rationaleFactorLabel, RESERVED_SECTION_TEXT } from "@cognelis/decision-core";
import {
  decisionOutcomeStateSchema,
  captureModeSchema,
  capturedAnswerSchema,
  sourceClientSchema,
} from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  realpath,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { DECISION_JOURNAL_FOLDER, ObsidianVaultRepository } from "./obsidian-vault.js";
import { fileStamp, settled } from "./note-cache.js";
import {
  parse as parseYaml,
  parseDocument,
} from "yaml";

import {
  escapeNoteText,
  notePropertiesYaml,
  templaterSafeYaml,
  unescapeNoteText,
} from "./markdown-markers.js";
import { renameReplacing } from "./replace-file.js";

const DEFAULT_FOLDER = DECISION_JOURNAL_FOLDER;

/** One place, as a case-insensitive volume (macOS, Windows) sees it: realpath answers with the case on disk. */
const samePlace = (left: string, right: string): boolean =>
  process.platform === "darwin" || process.platform === "win32"
    ? left.normalize("NFC").toLowerCase() === right.normalize("NFC").toLowerCase()
    : left === right;

/**
 * One property set by lines, or taken out when it is undefined: the key's own line and the lines that carry on
 * its value (an indented block, or a list), looked for in the indented block of the key above it for a nested
 * one. Null where the lines do not fall that way.
 */
const splicedProperty = (text: string, [key, ...rest]: readonly string[], value: unknown): string | null => {
  const entry = new RegExp(`^${key}:[^\\n]*(?:\\n(?:[ \\t]|- |-$)[^\\n]*)*`, "mu");
  const found = entry.exec(text);
  if (rest.length > 0) {
    const [line, ...block] = found?.[0].split("\n") ?? [];
    const indent = /^[ \t]+/u.exec(block[0] ?? "")?.[0];
    if (found === null || line !== `${key}:` || indent === undefined || !block.every((item) => item.startsWith(indent))) return null;
    const inner = splicedProperty(block.map((item) => item.slice(indent.length)).join("\n"), rest, value);
    if (inner === null) return null;
    const indented = inner.split("\n").map((item) => `${indent}${item}`).join("\n");
    return `${text.slice(0, found.index)}${line}\n${indented}${text.slice(found.index + found[0].length)}`;
  }
  if (value !== undefined) {
    const rendered = notePropertiesYaml({ [key!]: value }, { lineWidth: 0 }).trimEnd();
    return found === null ? `${text.trimEnd()}\n${rendered}` : text.replace(entry, () => rendered);
  }
  if (found === null) return text;
  const before = text.slice(0, found.index);
  const after = text.slice(found.index + found[0].length);
  return after === "" ? before.replace(/\n$/u, "") : `${before}${after.slice(1)}`;
};

/**
 * The front matter with these properties set, in the mapping at `under` (the top when empty), an undefined one
 * taken out, and nothing else touched. Re-rendered whole, a write to one field changed the reader's own values:
 * `ticket: 0042` came back as 42, a 19-digit id lost its last digits.
 */
export const withProperties = (frontmatter: string, values: Record<string, unknown>, under: readonly string[] = []): string => {
  const document = parseDocument(frontmatter);
  if (document.errors.length > 0) throw new Error("Decision note has invalid YAML frontmatter");
  let text: string | null = frontmatter;
  for (const [key, value] of Object.entries(values)) {
    text = text === null ? null : splicedProperty(text, [...under, key], value);
    if (value === undefined) document.deleteIn([...under, key]);
    else document.setIn([...under, key], value);
  }
  // Spliced by lines, it reads back as those properties set or it is not used: written whole, as before.
  const spliced = (() => {
    try {
      return text === null ? null : JSON.stringify(parseYaml(text));
    } catch {
      return null;
    }
  })();
  return text !== null && spliced === JSON.stringify(document.toJS())
    ? text.trimEnd()
    : templaterSafeYaml(document, { lineWidth: 0 }).trimEnd();
};

/**
 * Written back as the note was saved: a BOM and Windows line endings (git's autocrlf, a Windows editor) kept,
 * where one field's edit turned every line of the note into a change.
 */
export const inFormOf = (source: string, written: string): string =>
  `${source.startsWith("\uFEFF") ? "\uFEFF" : ""}${source.includes("\r\n") ? written.replaceAll("\n", "\r\n") : written}`;
const OPTIONS_FENCE = "decision-options";
const RATIONALE_END_MARKER = "<!-- decision:rationale-end -->";
const SELECTION_MARKER = /<!-- decision:selection-base64 ([A-Za-z0-9_-]+) -->/u;
const NO_NATIVE_CONTEXT = "（原生问答未提供额外上下文）";
const NO_ORIGINAL_RATIONALE = "（未填写自由输入理由）";
const TASK_BACKGROUND_HEADING = "### 任务背景";
const DECISION_FRAMING_HEADING = "### 约束与考虑";
const TASK_BACKGROUND_START =
  "<!-- decision:task-background-start -->";
const TASK_BACKGROUND_END =
  "<!-- decision:task-background-end -->";
const DECISION_FRAMING_START =
  "<!-- decision:decision-framing-start -->";
const DECISION_FRAMING_END =
  "<!-- decision:decision-framing-end -->";
const CONTEXT_END_MARKER =
  "<!-- decision:context-end -->";
const OUTCOME_END_MARKER =
  "<!-- decision:outcome-end -->";
const EXPECTED_OUTCOME_END_MARKER =
  "<!-- decision:expected-outcome-end -->";
const OUTCOME_REVIEW_END_MARKER =
  "<!-- decision:outcome-review-end -->";
const NO_OUTCOME_REVIEW = "（尚未复盘）";
const DEFERRED_RATIONALE = "（稍后补充）";
const NO_OUTCOME_LESSON = "（未填写复盘经验）";
const NO_EXPECTED_OUTCOME = "（尚未记录）";
const DECISION_TYPES: readonly DecisionType[] = [
  "architecture",
  "scope",
  "implementation",
  "tradeoff",
  "workflow",
  "risk",
  "other",
];
const RATIONALE_STATUSES: readonly RationaleStatus[] = [
  "captured",
  "deferred",
  "skipped",
  "not_recorded",
];
const OUTCOME_VERDICTS: readonly OutcomeVerdict[] = [
  "better",
  "as_expected",
  "mixed",
  "worse",
  "unclear",
];
const OUTCOME_VERDICT_LABELS: Record<OutcomeVerdict, string> = {
  better: "优于预期",
  as_expected: "符合预期",
  mixed: "部分符合",
  worse: "低于预期",
  unclear: "暂无法判断",
};
const PROACTIVE_SOURCE_KINDS = [
  "app_manual",
  "offline_conversation",
  "meeting",
  "observation",
  "agent_capture",
  "pr_comment",
] as const;
const SOURCE_FORMS = [
  "user_original",
  "user_paraphrase",
  "machine_summary",
] as const;
const RECORD_SENSITIVITIES = ["private", "personal", "shareable"] as const;

export interface StoredNote {
  id: string;
  path: string;
  contentHash: string;
}

export interface ParsedStoredNote extends StoredNote {
  record: DecisionRecord;
  /** Its file as it stood before it was read (fileStamp); null when written too recently to tell. */
  stamp?: string | null;
}

export interface NoteDiagnostic {
  path: string;
  message: string;
  /** Said of a note or folder still there behind what was not read (a link): its rows are kept. */
  standing?: true;
}

export interface ScanResult {
  notes: ParsedStoredNote[];
  diagnostics: NoteDiagnostic[];
}

export interface DeferredRationaleUpdate {
  rationale: string;
  reasonFactors?: string[];
}

export interface OutcomeReviewUpdate {
  verdict: OutcomeVerdict;
  lesson: string | null;
  reviewedAt: string;
}

export interface DecisionLifecycleUpdate {
  /** Only while no outcome is recorded: afterwards it would merely restate it. */
  expectedOutcome?: string;
  outcome?: string;
  review?: OutcomeReviewUpdate | null;
  reviewDueDate?: string | null;
}

const LIFECYCLE_WRITE_MESSAGES = {
  source_changed: "这条决策的笔记刚被改过，请重新打开后再保存。",
  source_unavailable: "这条决策的笔记暂时无法安全写入：它可能已缺失、读不出来，或有同一 ID 的副本。请在 Obsidian 中检查后重试。",
  outcome_required: "先记下实际结果，才能写复盘评价。",
  review_required: "实际结果改了，请同时更新或清除原来的复盘评价。",
  review_completed: "这条决策已有复盘评价（或正随本次写入），再安排的复盘日期不会到期提醒；要安排下一轮复盘，请在同一次写入里清除复盘评价。",
} as const;

/** `code` for callers that act on it (MCP); the message is what a reader is shown. */
export class DecisionLifecycleWriteError extends Error {
  constructor(readonly code: keyof typeof LIFECYCLE_WRITE_MESSAGES, message: string = LIFECYCLE_WRITE_MESSAGES[code]) {
    super(message);
  }
}

export interface ReviewScheduleUpdate {
  reviewDueDate: string | null;
}

export interface AppliedPrinciplesUpdate {
  appliedPrincipleIds: string[];
}

interface MarkdownRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
  /** The vault folder must already exist: a write never makes it up (see assertVaultPresent). */
  existingVault?: boolean;
  /** What reads the decisions folder for a lifecycle write (tests count its reads). */
  vault?: ObsidianVaultRepository;
  /** Where the index has a decision's note: looked at first, before the whole folder. */
  locate?: (id: string) => string | null;
}

/**
 * A vault folder that is gone (moved, renamed, on a drive not connected) is not made up again, empty,
 * by the next write: the decision would land where nothing else of the reader's is, and stay unseen.
 */
export const assertVaultPresent = async (vaultPath: string): Promise<void> => {
  if (await stat(vaultPath).then((status) => status.isDirectory(), () => false)) return;
  throw new Error(`找不到仓库目录 ${vaultPath}：它可能被移动、改名，或所在的磁盘没有连接。接回仓库或在设置里更换仓库后再试。`);
};

/**
 * A note's text as its file holds it, BOM and all, for a write back into it: a byte that is not UTF-8 (an editor
 * that wrote Latin-1, a sync from one) is refused. Decoded with a replacement character, the next save wrote the
 * character into the file in the byte's place, without a word.
 */
export const noteText = async (path: string): Promise<string> => {
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error("这篇笔记里有不是 UTF-8 编码的内容，App 无法安全改写它；请在 Obsidian 里修正后再试。", { cause: error });
  }
};

const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

const validCalendarDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const encodeSelection = (selection: SelectedAnswer): string =>
  Buffer.from(JSON.stringify(selection), "utf8").toString("base64url");

const decodeSelection = (body: string): SelectedAnswer => {
  // The marker under 我的选择: one earlier in the note, in an option an agent wrote, is not the user's choice.
  const chosen = /^## 我的选择$/mu.exec(body)?.index ?? 0;
  const encoded = body.slice(chosen).match(SELECTION_MARKER)?.[1];
  if (encoded === undefined) {
    throw new Error("Decision note is missing its selection marker");
  }
  const value = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  ) as unknown;
  const parsed = capturedAnswerSchema.safeParse(value);
  if (parsed.success) {
    return {
      kind: parsed.data.kind,
      values: [...parsed.data.values],
    };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "preset" &&
    "id" in value &&
    typeof value.id === "string" &&
    "label" in value &&
    typeof value.label === "string"
  ) {
    return { kind: "preset", values: [value.label] };
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "custom" &&
    "answer" in value &&
    typeof value.answer === "string"
  ) {
    return { kind: "custom", values: [value.answer] };
  }
  throw new Error("Decision note contains an invalid selection value");
};

const readableAnswer = (answer: SelectedAnswer): string =>
  answer.values.join("、");

const readableOptions = (record: DecisionRecord): string =>
  record.options.length === 0
    ? "（原生问答未提供预设方案）"
    : record.options.map((option) => {
      const tradeoffs =
        option.tradeoffs.length === 0
          ? ""
          : `\n${option.tradeoffs.map((item) => `- 取舍：${escapeNoteText(item)}`).join("\n")}`;
      const description =
        option.description === undefined
          ? ""
          : `\n\n${escapeNoteText(option.description)}`;
      return `### ${escapeNoteText(option.label)}${description}${tradeoffs}`;
    })
    .join("\n\n");

const rationaleBody = (record: DecisionRecord): string => {
  if (record.rationaleOriginal !== null) {
    return escapeNoteText(record.rationaleOriginal);
  }
  if (record.rationaleStatus === "deferred") {
    return DEFERRED_RATIONALE;
  }
  return record.rationaleStatus === "captured"
    ? NO_ORIGINAL_RATIONALE
    : "（已跳过）";
};

const rationaleFactorsSection = (record: DecisionRecord): string =>
  record.reasonFactors.length === 0
    ? ""
    : `## 判断依据

${record.reasonFactors
  .map((factor) => `- ${rationaleFactorLabel(factor)}`)
  .join("\n")}

`;

const decisionContextBody = (record: DecisionRecord): string => {
  if (record.context === null) {
    return record.contextSummary === null ? NO_NATIVE_CONTEXT : escapeNoteText(record.contextSummary);
  }
  const sections = [
    record.context.taskBackground === undefined
      ? null
      : `${TASK_BACKGROUND_HEADING}\n\n${TASK_BACKGROUND_START}\n${escapeNoteText(record.context.taskBackground)}\n${TASK_BACKGROUND_END}`,
    record.context.decisionFraming === undefined
      ? null
      : `${DECISION_FRAMING_HEADING}\n\n${DECISION_FRAMING_START}\n${escapeNoteText(record.context.decisionFraming)}\n${DECISION_FRAMING_END}`,
  ].filter((value): value is string => value !== null);
  return sections.length === 0
    ? NO_NATIVE_CONTEXT
    : sections.join("\n\n");
};

const outcomeReviewBody = (review: OutcomeReview | null): string => {
  if (review === null) return NO_OUTCOME_REVIEW;
  return `### 评价

${OUTCOME_VERDICT_LABELS[review.verdict]}

### 复盘经验

${review.lesson === null ? NO_OUTCOME_LESSON : escapeNoteText(review.lesson)}

${OUTCOME_REVIEW_END_MARKER}`;
};

const validatedAppliedPrincipleIds = (values: string[]): string[] => {
  const normalized = values.map((value) => value.trim());
  if (
    normalized.length > 5 ||
    new Set(normalized).size !== normalized.length ||
    normalized.some((value) => value.length === 0 || value.length > 200)
  ) {
    throw new Error(
      "Applied principles must contain at most 5 unique identifiers",
    );
  }
  return normalized;
};

export const serializeDecision = (record: DecisionRecord): string => {
  const properties = {
    id: record.id,
    created: record.created,
    status: record.status,
    source_client: record.sourceClient,
    source_kind: record.sourceKind ?? null,
    source_form: record.sourceForm ?? null,
    occurred_at: record.occurredAt ?? null,
    sensitivity: record.sensitivity ?? "private",
    project: record.project,
    workflow: record.workflow,
    decision_type: record.decisionType,
    selected_option: readableAnswer(record.selectedAnswer),
    capture_mode: record.captureMode,
    capture_semantic_key: record.captureSemanticKey,
    source_event_id: record.sourceEventId,
    batch_id: record.batchId,
    question_index: record.questionIndex,
    capture_confidence: record.detection?.band ?? null,
    capture_score: record.detection?.score ?? null,
    capture_detector:
      record.detection?.detectorVersion ?? null,
    context_truncated: record.context?.truncated ?? null,
    llm_recommendation: record.llmRecommendation,
    rationale_status: record.rationaleStatus,
    rationale_original_present:
      record.rationaleOriginal !== null,
    reason_factors: record.reasonFactors,
    tags: record.tags,
    related: record.related,
    applied_principles: validatedAppliedPrincipleIds(
      record.appliedPrincipleIds,
    ),
    supersedes: record.supersedes,
    review_due_date: record.reviewDueDate,
    outcome_verdict: record.outcomeReview?.verdict ?? null,
    outcome_reviewed_at: record.outcomeReview?.reviewedAt ?? null,
    outcome_lesson_present: record.outcomeReview?.lesson !== null,
  };
  const frontmatter = notePropertiesYaml(properties, {
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    lineWidth: 0,
  }).trimEnd();
  // `<` as JSON's own escape, which parses back to it: no marker of the note's own begins inside the block.
  const optionsJson = JSON.stringify(record.options, null, 2).replaceAll("<", "\\u003c");
  const selectionMarker = encodeSelection(record.selectedAnswer);
  const outcome = record.outcome === null ? "（尚未记录）" : escapeNoteText(record.outcome);

  // Every text written below, an agent's as much as the user's, is escaped (see escapeNoteText).
  return `---
${frontmatter}
---
# 决策点

${escapeNoteText(record.question)}

## 可选方案

${readableOptions(record)}

\`\`\`${OPTIONS_FENCE}
${optionsJson}
\`\`\`

## 我的选择

${escapeNoteText(readableAnswer(record.selectedAnswer))}

<!-- decision:selection-base64 ${selectionMarker} -->

${rationaleFactorsSection(record)}## 我的理由（原文）

${rationaleBody(record)}

${RATIONALE_END_MARKER}

## 当时上下文

${decisionContextBody(record)}

${CONTEXT_END_MARKER}

## 预期结果

${record.expectedOutcome === null || record.expectedOutcome === undefined ? NO_EXPECTED_OUTCOME : escapeNoteText(record.expectedOutcome)}

${EXPECTED_OUTCOME_END_MARKER}

## 后续结果

${outcome}

${OUTCOME_END_MARKER}

## 复盘结论

${outcomeReviewBody(record.outcomeReview)}
`;
};

export const updateDeferredRationaleMarkdown = (
  markdown: string,
  input: DeferredRationaleUpdate,
): string => {
  if (input.rationale.trim().length === 0 || input.rationale.length > 8_000) {
    throw new Error("Rationale must contain 1 to 8000 characters");
  }
  return resolveDeferredRationaleMarkdown(markdown, {
    status: "completed",
    rationaleStatus: "captured",
    rationaleOriginalPresent: true,
    reasonFactors: input.reasonFactors ?? [],
    rationale: input.rationale,
  });
};

interface DeferredRationaleResolution {
  status: "completed" | "rationale_skipped";
  rationaleStatus: "captured" | "skipped";
  rationaleOriginalPresent: boolean;
  reasonFactors: string[];
  rationale: string;
}

const resolveDeferredRationaleMarkdown = (
  markdown: string,
  resolution: DeferredRationaleResolution,
): string => {
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }

  const frontmatter = withProperties(markdown.slice(4, boundary), {
    status: resolution.status,
    rationale_status: resolution.rationaleStatus,
    rationale_original_present: resolution.rationaleOriginalPresent,
    reason_factors: resolution.reasonFactors,
  });

  const body = markdown.slice(boundary + 5);
  const marker = "## 我的理由（原文）\n\n";
  const sectionStart = body.indexOf(marker);
  if (sectionStart < 0) {
    throw new Error("Decision note is missing its rationale section");
  }
  const contentStart = sectionStart + marker.length;
  const explicitBoundary = body.indexOf(
    `\n\n${RATIONALE_END_MARKER}`,
    contentStart,
  );
  const nextSection =
    explicitBoundary >= 0
      ? explicitBoundary
      : body.indexOf("\n\n## ", contentStart);
  if (nextSection < 0) {
    throw new Error("Decision note rationale section is unterminated");
  }
  const updatedBody =
    body.slice(0, contentStart) +
    escapeNoteText(resolution.rationale) +
    body.slice(nextSection);
  return `---\n${frontmatter}\n---\n${updatedBody}`;
};

export const skipDeferredRationaleMarkdown = (
  markdown: string,
): string =>
  resolveDeferredRationaleMarkdown(markdown, {
    status: "rationale_skipped",
    rationaleStatus: "skipped",
    rationaleOriginalPresent: false,
    reasonFactors: [],
    rationale: "（已跳过）",
  });

/**
 * Where parseDecision finds 后续结果: the first after the context. The last one in the note was written to, so an
 * outcome went into a section of that name the reader had added further down, and read back as not recorded.
 */
const outcomeSectionStart = (body: string, heading: string): number => {
  const contextEnd = body.indexOf(CONTEXT_END_MARKER);
  return body.indexOf(heading, contextEnd >= 0 ? contextEnd : Math.max(body.indexOf("## 当时上下文"), 0));
};

export const updateDecisionOutcomeMarkdown = (
  markdown: string,
  outcome: string,
): string => {
  if (outcome.trim().length === 0 || outcome.length > 8_000) {
    throw new Error("Outcome must contain 1 to 8000 characters");
  }
  // Read back, a section heading in it would end the outcome there: what follows is cut off on the next
  // review, or left behind on the next update.
  if (RESERVED_SECTION_TEXT.test(outcome)) {
    throw new Error("Outcome contains reserved note delimiters");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  const document = parseDocument(markdown.slice(4, boundary));
  if (document.errors.length > 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  const body = markdown.slice(boundary + 5);
  const marker = "\n\n## 后续结果\n\n";
  const sectionStart = outcomeSectionStart(body, marker);
  if (sectionStart < 0) {
    throw new Error("Decision note is missing its outcome section");
  }
  const contentStart = sectionStart + marker.length;
  const explicitEnd = body.indexOf(
    `\n\n${OUTCOME_END_MARKER}`,
    contentStart,
  );
  const reviewStart = body.indexOf("\n\n## 复盘结论\n\n", contentStart);
  const suffix =
    explicitEnd >= 0
      ? body.slice(explicitEnd)
      : reviewStart >= 0
        ? `\n\n${OUTCOME_END_MARKER}${body.slice(reviewStart)}`
        : `\n\n${OUTCOME_END_MARKER}\n\n## 复盘结论\n\n${NO_OUTCOME_REVIEW}\n`;
  return `${markdown.slice(0, boundary + 5)}${body.slice(
    0,
    contentStart,
  )}${escapeNoteText(outcome)}${suffix}`;
};

/** Rewrites the expected outcome, or adds the section to a note that predates it. */
export const updateDecisionExpectedOutcomeMarkdown = (
  markdown: string,
  expectedOutcome: string,
): string => {
  if (
    expectedOutcome.trim().length === 0 ||
    expectedOutcome.length > 4_000 ||
    RESERVED_SECTION_TEXT.test(expectedOutcome)
  ) {
    throw new Error("Expected outcome must contain 1 to 4000 characters");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  const head = markdown.slice(0, boundary + 5);
  const body = markdown.slice(boundary + 5);
  const heading = "## 预期结果\n\n";
  const outcomeHeading = "\n\n## 后续结果\n\n";
  // Found where parseDecision finds it: after the context, never in a quote of it.
  const start = body.indexOf(heading, Math.max(body.indexOf(CONTEXT_END_MARKER), 0));
  if (start < 0) {
    const outcomeStart = outcomeSectionStart(body, outcomeHeading);
    if (outcomeStart < 0) {
      throw new Error("Decision note is missing its outcome section");
    }
    return `${head}${body.slice(0, outcomeStart)}\n\n${heading}${escapeNoteText(expectedOutcome)}\n\n${EXPECTED_OUTCOME_END_MARKER}${body.slice(outcomeStart)}`;
  }
  const contentStart = start + heading.length;
  const explicitEnd = body.indexOf(
    `\n\n${EXPECTED_OUTCOME_END_MARKER}`,
    contentStart,
  );
  const outcomeStart = body.indexOf(outcomeHeading, contentStart);
  if (explicitEnd < 0 && outcomeStart < 0) {
    throw new Error("Decision note is missing its outcome section");
  }
  return explicitEnd >= 0
    ? `${head}${body.slice(0, contentStart)}${escapeNoteText(expectedOutcome)}${body.slice(explicitEnd)}`
    : `${head}${body.slice(0, contentStart)}${escapeNoteText(expectedOutcome)}\n\n${EXPECTED_OUTCOME_END_MARKER}${body.slice(outcomeStart)}`;
};

export const updateDecisionReviewDueDateMarkdown = (
  markdown: string,
  reviewDueDate: string | null,
): string => {
  if (reviewDueDate !== null && !validCalendarDate(reviewDueDate)) {
    throw new Error("Review due date must be a valid YYYY-MM-DD date");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  return `---\n${withProperties(markdown.slice(4, boundary), { review_due_date: reviewDueDate })}\n---\n${markdown.slice(boundary + 5)}`;
};

export const updateDecisionAppliedPrinciplesMarkdown = (
  markdown: string,
  input: AppliedPrinciplesUpdate,
): string => {
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  const frontmatter = withProperties(markdown.slice(4, boundary), {
    applied_principles: validatedAppliedPrincipleIds(input.appliedPrincipleIds),
  });
  return `---\n${frontmatter}\n---\n${markdown.slice(boundary + 5)}`;
};

export const updateOutcomeReviewMarkdown = (
  markdown: string,
  input: OutcomeReviewUpdate,
): string => {
  if (!OUTCOME_VERDICTS.includes(input.verdict)) {
    throw new Error("Outcome review verdict is invalid");
  }
  if (input.lesson !== null && input.lesson.length > 8_000) {
    throw new Error("Outcome review lesson exceeds 8000 characters");
  }
  if (Number.isNaN(Date.parse(input.reviewedAt))) {
    throw new Error("Outcome review timestamp is invalid");
  }
  const parsed = parseDecision(markdown);
  if (parsed.outcome === null) {
    throw new Error("Decision outcome must be recorded before review");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  const frontmatter = withProperties(markdown.slice(4, boundary), {
    outcome_verdict: input.verdict,
    outcome_reviewed_at: input.reviewedAt,
    outcome_lesson_present: input.lesson !== null,
  });

  const body = markdown.slice(boundary + 5);
  const reviewHeading = "\n\n## 复盘结论\n\n";
  // After the outcome's end, where the app writes it: an outcome edited in Obsidian may hold the heading.
  const outcomeEnd = body.indexOf(OUTCOME_END_MARKER);
  const reviewStart = body.indexOf(reviewHeading, Math.max(0, outcomeEnd));
  let bodyBeforeReview =
    reviewStart >= 0 ? body.slice(0, reviewStart) : body.replace(/\n$/u, "");
  if (!bodyBeforeReview.includes(OUTCOME_END_MARKER)) {
    bodyBeforeReview += `\n\n${OUTCOME_END_MARKER}`;
  }
  const review: OutcomeReview = {
    verdict: input.verdict,
    lesson: input.lesson,
    reviewedAt: input.reviewedAt,
  };
  const reviewEnd = reviewStart < 0 ? -1 : body.indexOf(OUTCOME_REVIEW_END_MARKER, reviewStart);
  const after = reviewEnd >= 0 ? body.slice(reviewEnd + OUTCOME_REVIEW_END_MARKER.length) : "\n";
  // With no review recorded yet, what stands under the heading besides the placeholder was written in
  // Obsidian (a review of their own, a section after it): it stays, after the app's review, not deleted.
  const region = parsed.outcomeReview !== null || reviewStart < 0 ? ""
    : body.slice(reviewStart + reviewHeading.length, reviewEnd >= 0 ? reviewEnd : body.length);
  const written = (region.startsWith(NO_OUTCOME_REVIEW) ? region.slice(NO_OUTCOME_REVIEW.length) : region).trim();
  const suffix = written === "" ? after : `\n\n${written}${after === "\n" || after.startsWith("\n\n") ? after : `\n${after}`}`;
  return `---\n${frontmatter}\n---\n${bodyBeforeReview}${reviewHeading}${outcomeReviewBody(review)}${suffix}`;
};

const clearOutcomeReviewMarkdown = (markdown: string): string => {
  const boundary = markdown.indexOf("\n---\n", 4);
  const frontmatter = withProperties(markdown.slice(4, boundary), {
    outcome_verdict: null,
    outcome_reviewed_at: null,
    outcome_lesson_present: false,
  });
  const body = markdown.slice(boundary + 5);
  const heading = "\n\n## 复盘结论\n\n";
  const start = body.indexOf(heading);
  if (start < 0) throw new Error("Decision note is missing its review section");
  const end = body.indexOf(OUTCOME_REVIEW_END_MARKER, start);
  const suffix = end < 0 ? "\n" : body.slice(end + OUTCOME_REVIEW_END_MARKER.length);
  return `---\n${frontmatter}\n---\n${body.slice(0, start)}${heading}${NO_OUTCOME_REVIEW}\n\n${OUTCOME_REVIEW_END_MARKER}${suffix}`;
};

/**
 * A note as the parser reads it: saved with a BOM or Windows line endings (git's autocrlf, a Windows
 * editor), it is the same note, as context search already reads it.
 */
export const normalizedNote = (markdown: string): string =>
  markdown.replace(/^﻿/u, "").replaceAll("\r\n", "\n");

const splitDocument = (
  markdown: string,
): { properties: Record<string, unknown>; body: string } => {
  if (!markdown.startsWith("---\n")) {
    throw new Error("Decision note must begin with YAML frontmatter");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) {
    throw new Error("Decision note has unterminated YAML frontmatter");
  }
  const parsed = parseYaml(markdown.slice(4, boundary)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Decision note frontmatter must be an object");
  }
  return {
    properties: parsed as Record<string, unknown>,
    body: markdown.slice(boundary + 5),
  };
};

const requiredString = (
  properties: Record<string, unknown>,
  key: string,
): string => {
  const value = properties[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Decision note property ${key} must be a string`);
  }
  return value;
};

const nullableString = (
  properties: Record<string, unknown>,
  key: string,
): string | null => {
  const value = properties[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Decision note property ${key} must be a string or null`);
  }
  return value;
};

const stringArray = (
  properties: Record<string, unknown>,
  key: string,
): string[] => {
  const value = properties[key];
  // Emptied in Obsidian's property editor, or given one value as Obsidian lets a list be: none, or that one.
  // Refused, the whole decision left every list on the next start.
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`Decision note property ${key} must be a string array`);
  }
  return [...value];
};

const optionalStringArray = (
  properties: Record<string, unknown>,
  key: string,
): string[] => {
  if (properties[key] === undefined || properties[key] === null) return [];
  return stringArray(properties, key);
};

const optionalBoolean = (
  properties: Record<string, unknown>,
  key: string,
): boolean | null => {
  const value = properties[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(
      `Decision note property ${key} must be a boolean or null`,
    );
  }
  return value;
};

const section = (
  body: string,
  heading: string,
  nextHeading?: string,
): string => {
  const startMarker = `${heading}\n\n`;
  const start = body.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Decision note is missing section ${heading}`);
  }
  const contentStart = start + startMarker.length;
  if (nextHeading === undefined) {
    return body.slice(contentStart).replace(/\n$/u, "");
  }
  const end = body.indexOf(`\n\n${nextHeading}`, contentStart);
  if (end < 0) {
    throw new Error(`Decision note is missing section ${nextHeading}`);
  }
  return body.slice(contentStart, end);
};

const parseOptions = (body: string): RecordedDecisionOption[] => {
  const marker = `\`\`\`${OPTIONS_FENCE}\n`;
  const start = body.indexOf(marker);
  if (start < 0) {
    throw new Error("Decision note is missing its options data");
  }
  const contentStart = start + marker.length;
  const end = body.indexOf("\n```", contentStart);
  if (end < 0) {
    throw new Error("Decision note has unterminated options data");
  }
  const value = JSON.parse(body.slice(contentStart, end)) as unknown;
  if (!Array.isArray(value)) {
    throw new Error("Decision note options data must be an array");
  }
  return value.map((option, index) => {
    if (
      typeof option !== "object" ||
      option === null ||
      Array.isArray(option) ||
      !("label" in option) ||
      typeof option.label !== "string" ||
      option.label.trim().length === 0
    ) {
      throw new Error(`Decision note option ${index} is invalid`);
    }
    const id =
      "id" in option && typeof option.id === "string"
        ? option.id
        : undefined;
    const description =
      "description" in option && typeof option.description === "string"
        ? option.description
        : undefined;
    const tradeoffs: unknown[] =
      "tradeoffs" in option && Array.isArray(option.tradeoffs)
        ? option.tradeoffs
        : [];
    if (!tradeoffs.every((item) => typeof item === "string")) {
      throw new Error(`Decision note option ${index} tradeoffs are invalid`);
    }
    return {
      ...(id === undefined ? {} : { id }),
      label: option.label,
      ...(description === undefined ? {} : { description }),
      tradeoffs: [...tradeoffs] as string[],
    };
  });
};

const contextSection = (
  body: string,
  heading: string,
  nextHeading?: string,
): string | null => {
  const marker = `${heading}\n\n`;
  const start = body.indexOf(marker);
  if (start < 0) {
    return null;
  }
  const contentStart = start + marker.length;
  const end =
    nextHeading === undefined
      ? body.length
      : body.indexOf(`\n\n${nextHeading}`, contentStart);
  return unescapeNoteText(body
    .slice(contentStart, end < 0 ? body.length : end)
    .trim());
};

const markedContextSection = (
  body: string,
  startMarker: string,
  endMarker: string,
): string | null => {
  const start = body.indexOf(`${startMarker}\n`);
  if (start < 0) {
    return null;
  }
  const contentStart = start + startMarker.length + 1;
  const end = body.indexOf(`\n${endMarker}`, contentStart);
  return end < 0
    ? null
    : unescapeNoteText(
        body.slice(contentStart, end).trim(),
      );
};

const parseContext = (
  contextBody: string,
  properties: Record<string, unknown>,
): Pick<DecisionRecord, "context" | "contextSummary"> => {
  const marked =
    contextBody.includes(TASK_BACKGROUND_START) ||
    contextBody.includes(DECISION_FRAMING_START);
  const structured =
    marked ||
    contextBody.includes(`${TASK_BACKGROUND_HEADING}\n\n`) ||
    contextBody.includes(`${DECISION_FRAMING_HEADING}\n\n`);
  if (!structured) {
    return {
      context: null,
      contextSummary:
        contextBody === NO_NATIVE_CONTEXT ? null : unescapeNoteText(contextBody),
    };
  }
  const taskBackground = marked
    ? markedContextSection(
        contextBody,
        TASK_BACKGROUND_START,
        TASK_BACKGROUND_END,
      )
    : contextSection(
        contextBody,
        TASK_BACKGROUND_HEADING,
        DECISION_FRAMING_HEADING,
      );
  const decisionFraming = marked
    ? markedContextSection(
        contextBody,
        DECISION_FRAMING_START,
        DECISION_FRAMING_END,
      )
    : contextSection(
        contextBody,
        DECISION_FRAMING_HEADING,
      );
  const truncated = optionalBoolean(
    properties,
    "context_truncated",
  );
  return {
    contextSummary: null,
    context: {
      ...(taskBackground === null || taskBackground.length === 0
        ? {}
        : { taskBackground }),
      ...(decisionFraming === null || decisionFraming.length === 0
        ? {}
        : { decisionFraming }),
      ...(truncated === null ? {} : { truncated }),
    },
  };
};

const parseDetection = (
  properties: Record<string, unknown>,
): DecisionRecord["detection"] => {
  const band = properties.capture_confidence;
  const score = properties.capture_score;
  const detectorVersion = properties.capture_detector;
  if (
    (band === null || band === undefined) &&
    (score === null || score === undefined) &&
    (detectorVersion === null || detectorVersion === undefined)
  ) {
    return null;
  }
  if (
    (band !== "high" && band !== "medium") ||
    !Number.isInteger(score) ||
    (score as number) < 0 ||
    (score as number) > 100 ||
    typeof detectorVersion !== "string" ||
    detectorVersion.length === 0
  ) {
    throw new Error(
      "Decision note capture detection metadata is invalid",
    );
  }
  return {
    band,
    score: score as number,
    detectorVersion,
  };
};

const parseOutcomeReview = (
  body: string,
  properties: Record<string, unknown>,
): OutcomeReview | null => {
  const verdictValue = nullableString(properties, "outcome_verdict");
  const reviewedAt = nullableString(properties, "outcome_reviewed_at");
  if (verdictValue === null && reviewedAt === null) return null;
  if (
    verdictValue === null ||
    reviewedAt === null ||
    !OUTCOME_VERDICTS.some((verdict) => verdict === verdictValue) ||
    Number.isNaN(Date.parse(reviewedAt))
  ) {
    throw new Error("Decision note outcome review metadata is invalid");
  }
  const reviewHeading = "## 复盘结论\n\n";
  const reviewStart = body.indexOf(reviewHeading);
  if (reviewStart < 0) {
    throw new Error("Decision note is missing section ## 复盘结论");
  }
  const lessonHeading = "### 复盘经验\n\n";
  const lessonStart = body.indexOf(
    lessonHeading,
    reviewStart + reviewHeading.length,
  );
  if (lessonStart < 0) {
    throw new Error("Decision note outcome review is missing its lesson");
  }
  const lessonContentStart = lessonStart + lessonHeading.length;
  const explicitEnd = body.indexOf(
    `\n\n${OUTCOME_REVIEW_END_MARKER}`,
    lessonContentStart,
  );
  const lessonBody = unescapeNoteText(body
    .slice(lessonContentStart, explicitEnd < 0 ? body.length : explicitEnd)
    .replace(/\n$/u, ""));
  const lessonPresent = optionalBoolean(
    properties,
    "outcome_lesson_present",
  );
  return {
    verdict: verdictValue as OutcomeVerdict,
    lesson:
      lessonPresent === false ||
      (lessonPresent === null && lessonBody === NO_OUTCOME_LESSON)
        ? null
        : lessonBody,
    reviewedAt,
  };
};

/**
 * Why a decision note could not be read, in the reader's words: the parser's own English ("Decision note must begin
 * with YAML frontmatter", a YAML error drawn with a caret under the line) reached the settings page as it was. One
 * said in Chinese already (a placeholder iCloud moved off this Mac, two notes with one id) is kept: told by its first
 * line, as the note's own line the YAML parser draws under its English is Chinese in a Chinese vault.
 */
export const noteProblem = (message: string): string => {
  if (/\p{Script=Han}/u.test(message.split("\n", 1)[0] ?? "") && !message.startsWith("Decision note")) return message;
  if (/^(?:EACCES|EPERM)\b/u.test(message)) return "没有读取它的权限";
  if (/^ENOENT\b/u.test(message)) return "文件已经不在了";
  if (/^E[A-Z]+\b/u.test(message)) return "这次没能读取（磁盘或同步出了问题）";
  if (message.includes("must begin with YAML frontmatter")) return "开头没有 --- 包住的属性区";
  const line = /at line (\d+)/u.exec(message)?.[1];
  // The parser counts from the line after the opening "---": the note's own line is one more.
  if (/YAML|frontmatter|at line \d+/u.test(message)) return `开头的属性区不是有效的 YAML${line === undefined ? "" : `，笔记第 ${Number(line) + 1} 行附近有误`}`;
  const section = /missing (?:its )?section (## \S+)/u.exec(message)?.[1];
  if (section !== undefined) return `缺少「${section}」一节`;
  if (/missing|unterminated/u.test(message)) return "App 写的某一节或它的标记被删改了";
  if (/property|invalid|must be/u.test(message)) return "有属性的值不是 Decision 能读的格式";
  return "不是 Decision 能读的笔记格式";
};

export const parseDecision = (note: string): DecisionRecord => {
  const markdown = normalizedNote(note);
  const { properties, body } = splitDocument(markdown);
  const status = requiredString(properties, "status");
  if (
    status !== "completed" &&
    status !== "deferred_rationale" &&
    status !== "rationale_skipped"
  ) {
    throw new Error(`Decision note has invalid status: ${status}`);
  }
  const rationaleStatusValue = requiredString(
    properties,
    "rationale_status",
  );
  if (
    !RATIONALE_STATUSES.some(
      (status) => status === rationaleStatusValue,
    )
  ) {
    throw new Error(
      `Decision note has invalid rationale status: ${rationaleStatusValue}`,
    );
  }
  const rationaleStatus = rationaleStatusValue as RationaleStatus;
  if (rationaleStatus === "not_recorded") {
    throw new Error("A persisted decision cannot be not_recorded");
  }
  const rationaleOriginalPresent =
    properties.rationale_original_present;
  if (
    rationaleOriginalPresent !== undefined &&
    typeof rationaleOriginalPresent !== "boolean"
  ) {
    throw new Error(
      "Decision note property rationale_original_present must be a boolean",
    );
  }
  const rationaleSection = (): string => {
    const marker = `## 我的理由（原文）\n\n`;
    const start = body.indexOf(marker);
    if (start < 0) {
      throw new Error(
        "Decision note is missing section ## 我的理由（原文）",
      );
    }
    const contentStart = start + marker.length;
    const explicitBoundary = body.indexOf(
      `\n\n${RATIONALE_END_MARKER}`,
      contentStart,
    );
    return unescapeNoteText(explicitBoundary >= 0
      ? body.slice(contentStart, explicitBoundary)
      : section(
          body,
          "## 我的理由（原文）",
          "## 当时上下文",
        ));
  };
  // Filled in by hand in Obsidian where the note asks for it, a deferred rationale has been given: read as
  // given, not left waiting in 待补理由 until completing or skipping it there writes over it.
  const writtenByHand =
    rationaleStatus !== "deferred"
      ? null
      : (() => {
          try {
            const text = rationaleSection();
            return text.trim() === "" || text.trim() === DEFERRED_RATIONALE ? null : text;
          } catch {
            return null;
          }
        })();
  const rationale =
    rationaleStatus === "captured"
      ? (() => {
          const original = rationaleSection();
          if (rationaleOriginalPresent === false) {
            return null;
          }
          if (rationaleOriginalPresent === true) {
            return original;
          }
          return original === NO_ORIGINAL_RATIONALE ? null : original;
        })()
      : null;
  const contextHeading = "## 当时上下文\n\n";
  const contextStart = body.indexOf(contextHeading);
  if (contextStart < 0) {
    throw new Error(
      "Decision note is missing section ## 当时上下文",
    );
  }
  const contextContentStart =
    contextStart + contextHeading.length;
  const explicitContextEnd = body.indexOf(
    `\n\n${CONTEXT_END_MARKER}`,
    contextContentStart,
  );
  const context =
    explicitContextEnd >= 0
      ? body.slice(contextContentStart, explicitContextEnd)
      : section(
          body,
          "## 当时上下文",
          body.includes("## 预期结果") ? "## 预期结果" : "## 后续结果",
        );
  const expectedOutcomeHeading = "## 预期结果\n\n";
  // The section follows the context: a rationale quoting its heading is not it.
  const expectedOutcomeStart = body.indexOf(
    expectedOutcomeHeading,
    Math.max(explicitContextEnd, 0),
  );
  const expectedOutcome =
    expectedOutcomeStart < 0
      ? null
      : (() => {
          const contentStart = expectedOutcomeStart + expectedOutcomeHeading.length;
          const explicitEnd = body.indexOf(
            `\n\n${EXPECTED_OUTCOME_END_MARKER}`,
            contentStart,
          );
          const outcomeHeading = body.indexOf("\n\n## 后续结果\n\n", contentStart);
          const end = explicitEnd >= 0
            ? explicitEnd
            : outcomeHeading >= 0
              ? outcomeHeading
              : body.length;
          const value = unescapeNoteText(body.slice(contentStart, end).replace(/\n$/u, ""));
          // A section emptied by hand in the vault is no expectation either.
          return value === NO_EXPECTED_OUTCOME || value.trim().length === 0
            ? null
            : value;
        })();
  const outcomeHeading = "## 后续结果\n\n";
  const outcomeStart = body.indexOf(
    outcomeHeading,
    explicitContextEnd < 0
      ? contextContentStart
      : explicitContextEnd + CONTEXT_END_MARKER.length,
  );
  if (outcomeStart < 0) {
    throw new Error("Decision note is missing section ## 后续结果");
  }
  const outcomeContentStart = outcomeStart + outcomeHeading.length;
  const explicitOutcomeEnd = body.indexOf(
    `\n\n${OUTCOME_END_MARKER}`,
    outcomeContentStart,
  );
  const reviewStart = body.indexOf(
    "\n\n## 复盘结论\n\n",
    outcomeContentStart,
  );
  const outcomeEnd =
    explicitOutcomeEnd >= 0
      ? explicitOutcomeEnd
      : reviewStart >= 0
        ? reviewStart
        : body.length;
  const outcomeBody = unescapeNoteText(body
    .slice(outcomeContentStart, outcomeEnd)
    .replace(/\n$/u, ""));
  // Emptied by hand in the vault, as the expectation beside it is read: no outcome yet, not one to review.
  const outcome = outcomeBody === "（尚未记录）" || outcomeBody.trim().length === 0 ? null : outcomeBody;
  const outcomeReview = parseOutcomeReview(body, properties);
  if (outcome === null && outcomeReview !== null) {
    throw new Error("Decision note cannot be reviewed before recording outcome");
  }
  const parsedContext = parseContext(context, properties);
  const captureModeValue = properties.capture_mode;
  const reviewDueDate = nullableString(properties, "review_due_date");
  if (reviewDueDate !== null && !validCalendarDate(reviewDueDate)) {
    throw new Error("Decision note review due date is invalid");
  }
  const questionIndexValue = properties.question_index;
  if (
    questionIndexValue !== null &&
    questionIndexValue !== undefined &&
    (!Number.isInteger(questionIndexValue) ||
      (questionIndexValue as number) < 0)
  ) {
    throw new Error(
      "Decision note property question_index must be a nonnegative integer or null",
    );
  }

  const decisionTypeValue = requiredString(
    properties,
    "decision_type",
  );
  if (
    !DECISION_TYPES.some((type) => type === decisionTypeValue)
  ) {
    throw new Error(
      `Decision note has invalid decision type: ${decisionTypeValue}`,
    );
  }

  const sourceClientValue = requiredString(properties, "source_client");
  const sourceClient: DecisionRecordSourceClient =
    sourceClientValue === "manual" || sourceClientValue === "pr-comment"
      ? sourceClientValue
      : sourceClientSchema.parse(sourceClientValue);
  const sourceKindValue = nullableString(properties, "source_kind");
  if (
    sourceKindValue !== null &&
    !PROACTIVE_SOURCE_KINDS.some((value) => value === sourceKindValue)
  ) {
    throw new Error(`Decision note has invalid source kind: ${sourceKindValue}`);
  }
  const sourceFormValue = nullableString(properties, "source_form");
  if (
    sourceFormValue !== null &&
    !SOURCE_FORMS.some((value) => value === sourceFormValue)
  ) {
    throw new Error(`Decision note has invalid source form: ${sourceFormValue}`);
  }
  const occurredAt = nullableString(properties, "occurred_at");
  if (occurredAt !== null && !Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("Decision note occurred_at must be an ISO date time");
  }
  // Every list and count reads it as a time. One that is not (typed in by hand in Obsidian) took the home
  // and knowledge pages down whole; it is a note the index cannot take, said in the settings as such.
  // Read as a time and kept as one: a calendar date (Obsidian's date property, a note backdated by hand) is
  // that day here. Kept as typed, it was midnight UTC, the day before west of UTC in every list and export.
  const typedCreated = requiredString(properties, "created");
  const createdAt = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(typedCreated) ? `${typedCreated}T00:00:00` : typedCreated);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error(`created 不是有效的日期时间：${typedCreated}`);
  }
  const created = createdAt.toISOString();
  const sensitivityValue = nullableString(properties, "sensitivity") ?? "private";
  if (!RECORD_SENSITIVITIES.some((value) => value === sensitivityValue)) {
    throw new Error(`Decision note has invalid sensitivity: ${sensitivityValue}`);
  }

  return {
    id: requiredString(properties, "id"),
    created,
    status: writtenByHand === null ? status as PersistedDecisionStatus : "completed",
    sourceClient,
    project: requiredString(properties, "project"),
    workflow: nullableString(properties, "workflow"),
    decisionType: decisionTypeValue as DecisionType,
    question: unescapeNoteText(section(body, "# 决策点", "## 可选方案")),
    ...parsedContext,
    detection: parseDetection(properties),
    options: parseOptions(body),
    selectedAnswer: decodeSelection(body),
    llmRecommendation: nullableString(properties, "llm_recommendation"),
    rationaleStatus: writtenByHand === null ? rationaleStatus : "captured",
    rationaleOriginal: writtenByHand ?? rationale,
    reasonFactors: stringArray(properties, "reason_factors"),
    captureMode:
      captureModeValue === null || captureModeValue === undefined
        ? null
        : captureModeSchema.parse(captureModeValue),
    captureSemanticKey: nullableString(
      properties,
      "capture_semantic_key",
    ),
    sourceEventId: nullableString(properties, "source_event_id"),
    batchId: nullableString(properties, "batch_id"),
    questionIndex:
      questionIndexValue === null || questionIndexValue === undefined
        ? null
        : (questionIndexValue as number),
    tags: stringArray(properties, "tags"),
    related: stringArray(properties, "related"),
    appliedPrincipleIds: validatedAppliedPrincipleIds(
      optionalStringArray(properties, "applied_principles"),
    ),
    supersedes: nullableString(properties, "supersedes"),
    reviewDueDate,
    outcome,
    outcomeReview,
    sourceKind: sourceKindValue as ProactiveSourceKind | null,
    sourceForm: sourceFormValue as SourceForm | null,
    occurredAt,
    sensitivity: sensitivityValue as RecordSensitivity,
    expectedOutcome,
  };
};

const slug = (value: string): string => {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  return normalized.length === 0 ? "decision" : normalized;
};

const timestamp = (created: string): string =>
  created.replace(/[-:.]/gu, "");

const identifierSuffix = (id: string): string => {
  const readable = slug(id).slice(0, 12).replace(/-+$/u, "");
  return `${readable}-${sha256(id).slice(0, 8)}`;
};

export const collectMarkdown = async (
  directory: string,
  /** A subfolder it may not list is said here and passed over; the decisions folder itself still throws. */
  unreadable: NoteDiagnostic[],
  nested = false,
): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    if (!nested) throw error;
    // Another owner's or a locked folder (synced from elsewhere, chmod) costs its own notes, not every other.
    // In words: Node's own English line, with the folder's whole path, went on to the page.
    const denied = typeof error === "object" && error !== null && "code" in error && (error.code === "EACCES" || error.code === "EPERM");
    unreadable.push({ path: directory, message: `无法读取这个文件夹，${denied ? "没有读取它的权限" : "磁盘或同步可能出了问题"}` });
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile() && ICLOUD_PLACEHOLDER.test(entry.name)) {
      // Evicted by iCloud ("Optimize Mac Storage"): a note still there, only not on this Mac. Passed over as
      // not a note, it was gone from every list and count, and the rebuild called the folder healthy.
      unreadable.push({ path, message: "这篇笔记被 iCloud 移到了云端（优化 Mac 储存空间），还没下载回本机；在 Finder 里下载后即可读取。" });
    } else if (entry.name.startsWith(".")) {
      // Hidden, as Obsidian hides it: the ._ copies macOS writes beside every file on exFAT or a network share
      // were each read as a note that could not be read.
      continue;
    } else if (entry.isSymbolicLink()) {
      // A link in place of a folder or a note (a year moved to another disk and linked back) is not followed, as it
      // could lead out of the vault; said, so that the decisions behind it keep their rows. Passed over without a
      // word, the rebuild called the folder healthy and dropped every one of them.
      unreadable.push({ path, message: "这里是一个指向别处的链接，App 不读取链接指向的文件夹或笔记；请把真正的文件夹或笔记放回这里。", standing: true });
    } else if (entry.isDirectory()) {
      files.push(...(await collectMarkdown(path, unreadable, true)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
};

const ICLOUD_PLACEHOLDER = /^\..+\.md\.icloud$/u;

/** The note an iCloud placeholder stands for: `.name.md.icloud` beside it, for `name.md`. */
export const evictedNote = (placeholder: string): string | null => {
  const name = basename(placeholder);
  return ICLOUD_PLACEHOLDER.test(name) ? join(dirname(placeholder), name.slice(1, -".icloud".length)) : null;
};

/**
 * Whether a note not found is still there, by what collectMarkdown said of the folder: in a folder it could not
 * list for now, moved off this Mac by iCloud, or itself replaced by a link (said as standing: a note said with
 * its own path because it could not be parsed is not). Its decision stays and is said; taken out of the index,
 * it was gone from every list without a word.
 */
export const stillThere = (unreadable: readonly NoteDiagnostic[]) => (path: string): boolean =>
  unreadable.some((diagnostic) =>
    path.startsWith(`${diagnostic.path}${sep}`) || evictedNote(diagnostic.path) === path || (diagnostic.standing === true && diagnostic.path === path));

export class MarkdownRepository {
  readonly #vaultPath: string;
  readonly #folder: string;
  readonly #rename: typeof rename;
  readonly #existingVault: boolean;
  // Kept across writes, so a note unchanged since the last one is not read again. Made anew for each write,
  // every decision was read on every save: ten thousand took seconds, twenty thousand outran the scan's time.
  readonly #vault: ObsidianVaultRepository;
  readonly #locate: (id: string) => string | null;
  #writeTail: Promise<unknown> = Promise.resolve();
  #lifecycleTail: Promise<unknown> = Promise.resolve();

  constructor(vaultPath: string, options: MarkdownRepositoryOptions = {}) {
    this.#vaultPath = vaultPath;
    this.#folder = options.folder ?? DEFAULT_FOLDER;
    this.#rename = options.rename ?? rename;
    this.#existingVault = options.existingVault ?? false;
    this.#vault = options.vault ?? new ObsidianVaultRepository(vaultPath);
    this.#locate = options.locate ?? (() => null);
  }

  get decisionsPath(): string {
    return join(this.#vaultPath, this.#folder, "decisions");
  }

  pathFor(record: DecisionRecord): string {
    // ponytail: filed by the UTC date of `created`, so a decision made in a month's first hours east of UTC (its
    // last ones west of it) sits in the next month's folder over. Filing by the reader's month strands every note
    // already filed: do it, moving those once, if readers come to browse the folders by month.
    const day = record.created.slice(0, 10).split("-");
    const year = day[0];
    const month = day[1];
    if (year === undefined || month === undefined) {
      throw new Error(`Invalid decision creation date: ${record.created}`);
    }
    const name = `${timestamp(record.created)}-${slug(record.question)}-${identifierSuffix(record.id)}.md`;
    return join(
      this.#vaultPath,
      this.#folder,
      "decisions",
      year,
      month,
      name,
    );
  }

  async write(record: DecisionRecord, originalContent?: string): Promise<StoredNote> {
    const content = originalContent ?? serializeDecision(record);
    if (originalContent !== undefined && parseDecision(content).id !== record.id) throw new Error("记录编号与正文不一致。");
    const target = this.pathFor(record);
    await this.#writeContent(target, content);
    return {
      id: record.id,
      path: target,
      contentHash: sha256(content),
    };
  }

  async read(path: string): Promise<ParsedStoredNote> {
    // Looked at before it is read: a stamp is never of a file newer than what was read from it.
    const file = await stat(path, { bigint: true }).catch(() => null);
    const content = await readFile(path, "utf8");
    const record = parseDecision(content);
    return {
      id: record.id,
      path,
      contentHash: sha256(content),
      record,
      stamp: file !== null && settled(file) ? fileStamp(file) : null,
    };
  }

  /**
   * Notes in one folder still holding this decision, among those named as its file is: an Obsidian copy and
   * a sync conflict keep the name and sit beside the original. One folder is listed and only those few
   * files are opened, so deleting many notes at once costs no scan of the vault per note.
   */
  async notesFor(id: string, directory: string): Promise<ParsedStoredNote[]> {
    const suffix = identifierSuffix(id);
    const names = await readdir(directory).catch(() => [] as string[]);
    const paths = names.filter((name) => name.endsWith(".md") && name.includes(suffix)).sort().map((name) => join(directory, name));
    const notes = await Promise.all(paths.map((path) => this.read(path).catch(() => null)));
    return notes.filter((note): note is ParsedStoredNote => note !== null && note.id === id);
  }

  /**
   * The notes holding this decision, parsed only where its id appears. Read and parsed whole, every 补理由, 跳过 or
   * principle tag on a vault of ten thousand decisions took seconds, and a batch of them minutes.
   */
  async #notesHolding(id: string): Promise<ParsedStoredNote[]> {
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    // Where the index has it, with the copies a sync or Obsidian leaves beside it under its name (as a deleted
    // copy's decision is found again): read through, the folder took most of a second a click at ten thousand
    // decisions. Not there under its name any more (moved, renamed in Obsidian), it is looked for as before.
    const indexed = this.#locate(id);
    if (indexed !== null) {
      const beside = await this.notesFor(id, dirname(indexed));
      if (beside.some((note) => note.path === indexed)) {
        // A copy under its name in another folder (moved there in Finder, a sync's own place) is looked for by name
        // across the folder, unread: missed, the click wrote one copy without a word that there were two.
        // ponytail: a copy renamed to another name elsewhere is said by the next reconcile, not by this click.
        const suffix = identifierSuffix(id);
        const elsewhere = (await collectMarkdown(this.decisionsPath, []))
          .filter((path) => basename(path).includes(suffix) && !beside.some((note) => samePlace(note.path, path)));
        const copies = await Promise.all(elsewhere.map((path) => this.read(path).catch(() => null)));
        return [...beside, ...copies.filter((note): note is ParsedStoredNote => note !== null && note.id === id)];
      }
    }
    const notes: ParsedStoredNote[] = [];
    for (const path of await collectMarkdown(this.decisionsPath, [])) {
      const content = await readFile(path, "utf8").catch(() => null);
      if (content === null || !content.includes(id)) continue;
      try {
        const record = parseDecision(content);
        if (record.id === id) notes.push({ id, path, contentHash: sha256(content), record });
      } catch {
        // A note the app cannot read is not one it edits.
      }
    }
    return notes;
  }

  async scan(): Promise<ScanResult> {
    // A vault that is not there (moved, renamed, its disk not connected) is not a vault with no decisions
    // yet, as a write already knows. Read as empty, a rebuild from Settings emptied the index, its vectors
    // with it, and called it healthy.
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    const diagnostics: NoteDiagnostic[] = [];
    const paths = await collectMarkdown(this.decisionsPath, diagnostics);
    const notes: ParsedStoredNote[] = [];
    for (const path of paths) {
      try {
        notes.push(await this.read(path));
      } catch (error) {
        diagnostics.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { notes, diagnostics };
  }

  async updateDeferredRationale(
    id: string,
    input: DeferredRationaleUpdate,
  ): Promise<ParsedStoredNote> {
    const matches = await this.#notesHolding(id);
    if (matches.length === 0) {
      throw new DecisionLifecycleWriteError("source_unavailable");
    }
    if (matches.length > 1) {
      throw new Error(`有不止一篇决策笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`);
    }
    const note = matches[0] as ParsedStoredNote;
    if (note.record.rationaleStatus !== "deferred") {
      throw new Error("这条决策已经不在待补理由里了（理由可能已在 Obsidian 里补上），请刷新后再看。");
    }
    const source = await readFile(note.path, "utf8");
    const content = inFormOf(source, updateDeferredRationaleMarkdown(normalizedNote(source), input));
    await this.#writeContent(note.path, content, note.contentHash);
    return this.read(note.path);
  }

  async skipDeferredRationale(id: string): Promise<ParsedStoredNote> {
    const matches = await this.#notesHolding(id);
    if (matches.length === 0) {
      throw new DecisionLifecycleWriteError("source_unavailable");
    }
    if (matches.length > 1) {
      throw new Error(`有不止一篇决策笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`);
    }
    const note = matches[0] as ParsedStoredNote;
    if (note.record.rationaleStatus !== "deferred") {
      throw new Error("这条决策已经不在待补理由里了（理由可能已在 Obsidian 里补上），请刷新后再看。");
    }
    const source = await readFile(note.path, "utf8");
    const content = inFormOf(source, skipDeferredRationaleMarkdown(normalizedNote(source)));
    await this.#writeContent(note.path, content, note.contentHash);
    return this.read(note.path);
  }

  async deferredLocalCopy(id: string, input: { rationale?: string; reasonFactors?: string[] }): Promise<ParsedStoredNote & { content: string }> {
    const note = await this.findDecision(id);
    if (!note || note.record.rationaleStatus !== "deferred") throw new Error("这条决策已不在待补理由里，请刷新后再试。");
    const source = await readFile(note.path, "utf8");
    if (sha256(source) !== note.contentHash) throw new DecisionLifecycleWriteError("source_changed");
    const rationale = input.rationale ?? note.record.rationaleOriginal;
    const factors = input.reasonFactors ?? note.record.reasonFactors;
    const captured = Boolean(rationale || factors.length || note.record.appliedPrincipleIds.length);
    const content = inFormOf(source, resolveDeferredRationaleMarkdown(normalizedNote(source), {
      status: captured ? "completed" : "rationale_skipped", rationaleStatus: captured ? "captured" : "skipped",
      rationaleOriginalPresent: Boolean(rationale), rationale: rationale ?? "（已跳过）", reasonFactors: factors,
    }));
    return { ...note, record: parseDecision(content), content };
  }

  async findDecision(id: string): Promise<ParsedStoredNote | null> {
    const matches = await this.#notesHolding(id);
    if (matches.length > 1) throw new Error(`有多篇笔记使用同一编号（${id}），请先处理重复笔记。`);
    return matches[0] ?? null;
  }

  async deleteDeferredRationale(id: string, expectedContentHash?: string): Promise<ParsedStoredNote> {
    const matches = await this.#notesHolding(id);
    if (matches.length === 0) {
      throw new DecisionLifecycleWriteError("source_unavailable");
    }
    if (matches.length > 1) {
      throw new Error(`有不止一篇决策笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`);
    }
    const note = matches[0] as ParsedStoredNote;
    if (note.record.rationaleStatus !== "deferred") {
      throw new Error("这条决策已经不在待补理由里了（理由可能已在 Obsidian 里补上），请刷新后再看。");
    }
    if (expectedContentHash !== undefined && note.contentHash !== expectedContentHash) throw new DecisionLifecycleWriteError("source_changed");
    await unlink(note.path);
    return note;
  }

  /** `basis`: the note's hash when the editor was opened; changed since (in Obsidian), the write is refused. */
  async updateOutcome(id: string, outcome: string, basis?: string): Promise<ParsedStoredNote> {
    return this.updateLifecycle(id, { outcome }, basis, false);
  }

  async updateExpectedOutcome(
    id: string,
    expectedOutcome: string,
    basis?: string,
  ): Promise<ParsedStoredNote> {
    return this.updateLifecycle(id, { expectedOutcome }, basis, false);
  }

  async updateReviewDueDate(
    id: string,
    reviewDueDate: string | null,
  ): Promise<ParsedStoredNote> {
    return this.updateLifecycle(id, { reviewDueDate });
  }

  async updateAppliedPrinciples(
    id: string,
    input: AppliedPrinciplesUpdate,
  ): Promise<ParsedStoredNote> {
    const matches = await this.#notesHolding(id);
    if (matches.length === 0) {
      throw new DecisionLifecycleWriteError("source_unavailable");
    }
    if (matches.length > 1) {
      throw new Error(`有不止一篇决策笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇后再试。`);
    }
    const note = matches[0] as ParsedStoredNote;
    const source = await readFile(note.path, "utf8");
    const content = inFormOf(source, updateDecisionAppliedPrinciplesMarkdown(normalizedNote(source), input));
    await this.#writeContent(note.path, content, note.contentHash);
    return this.read(note.path);
  }

  async updateOutcomeReview(
    id: string,
    input: OutcomeReviewUpdate,
    basis?: string,
  ): Promise<ParsedStoredNote> {
    return this.updateLifecycle(id, { review: input }, basis, false);
  }

  /**
   * `reviewMustBeAcknowledged`: a changed outcome is refused while its review stands unless the write says what
   * becomes of it, as MCP must; the app's own editors keep their edit semantics and only check the version.
   */
  updateLifecycle(
    id: string,
    input: DecisionLifecycleUpdate,
    expectedContentHash?: string,
    reviewMustBeAcknowledged = expectedContentHash !== undefined,
  ): Promise<ParsedStoredNote> {
    const write = this.#lifecycleTail.then(() => this.#updateLifecycle(id, input, expectedContentHash, reviewMustBeAcknowledged));
    this.#lifecycleTail = write.catch(() => undefined);
    return write;
  }

  async #updateLifecycle(
    id: string,
    input: DecisionLifecycleUpdate,
    expectedContentHash: string | undefined,
    reviewMustBeAcknowledged: boolean,
  ): Promise<ParsedStoredNote> {
    // A failed scan must not hide a duplicate identifier; but only what could be this decision stops the
    // write: a folder that cannot be listed, a file it cannot read whose name carries this decision's
    // identifier, a note too large to edit or no decision at all whose `id:` line names this one. Other
    // notes, however many or large, are not this write's business.
    const matches: { path: string; content: string; contentHash: string; record: DecisionRecord }[] = [];
    const namesThis = new RegExp(`^id:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["']?\\s*$`, "mu");
    const suffix = identifierSuffix(id);
    try {
      for await (const entry of this.#vault.iterateFolder(`${this.#folder}/decisions`, AbortSignal.timeout(4_000))) {
        if (entry.kind !== "note") {
          if (entry.diagnostic.relativePath === null || entry.diagnostic.relativePath.includes(suffix)) throw new DecisionLifecycleWriteError("source_unavailable");
          continue;
        }
        // A note without this identifier anywhere in it cannot be this decision: it is not parsed. Parsing
        // every note, a vault of some ten thousand decisions outran the scan's time, and every save failed.
        if (!entry.note.content.includes(id)) continue;
        if (entry.note.size > 512 * 1024) {
          if (namesThis.test(entry.note.content)) throw new DecisionLifecycleWriteError("source_unavailable");
          continue;
        }
        let record: DecisionRecord;
        try { record = parseDecision(entry.note.content); } catch {
          if (!namesThis.test(entry.note.content)) continue;
          throw new DecisionLifecycleWriteError("source_unavailable");
        }
        if (record.id === id) matches.push({ path: join(this.#vaultPath, entry.note.relativePath), content: entry.note.content, contentHash: entry.note.contentHash, record });
      }
    } catch (error) {
      // Not read through in time (a slow or network disk): said in the reader's words, not as Node's
      // "The operation was aborted".
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new DecisionLifecycleWriteError("source_unavailable");
      }
      throw error;
    }
    if (matches.length !== 1) throw new DecisionLifecycleWriteError("source_unavailable");
    const note = matches[0]!;
    // Written longer in Obsidian than the app's limits (a pasted log), it is not rewritten; said as that, where it
    // was said to be missing, unreadable or copied.
    if (!decisionOutcomeStateSchema.safeParse({ expectedOutcome: note.record.expectedOutcome ?? null, outcome: note.record.outcome, review: note.record.outcomeReview, reviewDueDate: note.record.reviewDueDate }).success) {
      throw new DecisionLifecycleWriteError("source_unavailable", "这条决策笔记里的预期、结果或复盘经验超过了 8000 字（多半是在 Obsidian 里写的），App 不能安全改写它；请在 Obsidian 里精简到 8000 字以内后再试。");
    }
    if (expectedContentHash !== undefined && note.contentHash !== expectedContentHash) throw new DecisionLifecycleWriteError("source_changed");
    // MCP explicitly acknowledges the old review when changing its evidence.
    // Desktop callers retain their existing edit semantics, using the same atomic writer.
    if (reviewMustBeAcknowledged && input.outcome !== undefined && input.outcome !== note.record.outcome && note.record.outcomeReview !== null && input.review === undefined) {
      throw new DecisionLifecycleWriteError("review_required");
    }
    // Edited as parsed, line endings normalized; a note left as it was keeps its file and its hash.
    const original = normalizedNote(note.content);
    let content = original;
    if (input.expectedOutcome !== undefined && input.expectedOutcome !== note.record.expectedOutcome) {
      if (note.record.outcome !== null) throw new Error("An expected outcome can only be written before the outcome is known");
      content = updateDecisionExpectedOutcomeMarkdown(content, input.expectedOutcome);
    }
    if (input.outcome !== undefined && input.outcome !== note.record.outcome) content = updateDecisionOutcomeMarkdown(content, input.outcome);
    if (input.review !== undefined) {
      if (input.review === null) {
        if (note.record.outcomeReview !== null) content = clearOutcomeReviewMarkdown(content);
      } else {
        if (parseDecision(content).outcome === null) throw new DecisionLifecycleWriteError("outcome_required");
        content = updateOutcomeReviewMarkdown(content, input.review);
      }
    }
    // Reviewed, a decision comes due by no date (every due query asks for no verdict yet): a next review scheduled
    // on it was saved, shown as 下次复盘日期, and never came — scheduled with the verdict in one write as well. It
    // takes one with the review cleared in the same write.
    const reviewAfter = input.review === undefined ? note.record.outcomeReview : input.review;
    if (input.reviewDueDate !== undefined && input.reviewDueDate !== null && input.reviewDueDate !== note.record.reviewDueDate && reviewAfter !== null) {
      throw new DecisionLifecycleWriteError("review_completed");
    }
    if (input.reviewDueDate !== undefined && input.reviewDueDate !== note.record.reviewDueDate) content = updateDecisionReviewDueDateMarkdown(content, input.reviewDueDate);
    const record = parseDecision(content);
    if (Buffer.byteLength(content, "utf8") > 512 * 1024) throw new DecisionLifecycleWriteError("source_unavailable");
    // As the file holds it: the vault read decodes past a BOM, and a write from the version it read is checked anyway.
    const written = content === original ? content : inFormOf(await readFile(note.path, "utf8").catch(() => note.content), content);
    if (content !== original) await this.#writeContent(note.path, written, note.contentHash);
    return { id, path: note.path, contentHash: content === original ? note.contentHash : sha256(written), record };
  }

  #writeContent(target: string, content: string, expectedHash?: string): Promise<void> {
    const write = this.#writeTail.then(() => this.#replaceContent(target, content, expectedHash));
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  async #checkVersion(target: string, expectedHash: string): Promise<void> {
    const root = resolve(this.#vaultPath);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new DecisionLifecycleWriteError("source_unavailable");
    try {
      // The vault may itself be reached through a link (iCloud, another disk, as Obsidian was pointed at it):
      // refused, every edit of a decision it had just written failed. Nothing within it may be one.
      const realRoot = await realpath(root);
      if (!(await lstat(realRoot)).isDirectory()) throw new DecisionLifecycleWriteError("source_unavailable");
      const parts = rel.split(sep);
      let component = realRoot;
      for (const [index, part] of parts.entries()) {
        component = join(component, part);
        const stat = await lstat(component);
        if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new DecisionLifecycleWriteError("source_unavailable");
      }
      if (!samePlace(await realpath(target), join(realRoot, rel))) throw new DecisionLifecycleWriteError("source_unavailable");
      // Read as the bytes are: a hash of the same lossy reading as the caller's let a replacement character through.
      if (sha256(await noteText(target)) !== expectedHash) throw new DecisionLifecycleWriteError("source_changed");
    } catch (error) {
      if (error instanceof DecisionLifecycleWriteError) throw error;
      throw new DecisionLifecycleWriteError("source_unavailable");
    }
  }

  async #replaceContent(target: string, content: string, expectedHash?: string): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    if (expectedHash === undefined) {
      if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    } else await this.#checkVersion(target, expectedHash);
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (expectedHash !== undefined) await this.#checkVersion(target, expectedHash);
      await renameReplacing(temporary, target, {
        renameFile: this.#rename,
        ...(expectedHash === undefined ? {} : { beforeRetry: () => this.#checkVersion(target, expectedHash) }),
      });
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
