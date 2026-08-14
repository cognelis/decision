import type {
  DecisionRecord,
  DecisionType,
  OutcomeReview,
  OutcomeVerdict,
  PersistedDecisionStatus,
  RationaleStatus,
  RecordedDecisionOption,
  SelectedAnswer,
} from "@cognelis/decision-core";
import { rationaleFactorLabel } from "@cognelis/decision-core";
import {
  captureModeSchema,
  capturedAnswerSchema,
  sourceClientSchema,
} from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
} from "yaml";

import {
  escapeDecisionMarkerText,
  normalizeLegacyDecisionMarkers,
  unescapeDecisionMarkerText,
} from "./legacy-markers.js";

const DEFAULT_FOLDER = "Decision Journal";
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
const OUTCOME_REVIEW_END_MARKER =
  "<!-- decision:outcome-review-end -->";
const NO_OUTCOME_REVIEW = "（尚未复盘）";
const NO_OUTCOME_LESSON = "（未填写复盘经验）";
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

export interface StoredNote {
  id: string;
  path: string;
  contentHash: string;
}

export interface ParsedStoredNote extends StoredNote {
  record: DecisionRecord;
}

export interface NoteDiagnostic {
  path: string;
  message: string;
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

export interface ReviewScheduleUpdate {
  reviewDueDate: string | null;
}

export interface AppliedPrinciplesUpdate {
  appliedPrincipleIds: string[];
}

interface MarkdownRepositoryOptions {
  folder?: string;
  rename?: typeof rename;
}

const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

const validCalendarDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

const encodeSelection = (selection: SelectedAnswer): string =>
  Buffer.from(JSON.stringify(selection), "utf8").toString("base64url");

const decodeSelection = (body: string): SelectedAnswer => {
  const encoded = body.match(SELECTION_MARKER)?.[1];
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
          : `\n${option.tradeoffs.map((item) => `- 取舍：${item}`).join("\n")}`;
      const description =
        option.description === undefined
          ? ""
          : `\n\n${option.description}`;
      return `### ${option.label}${description}${tradeoffs}`;
    })
    .join("\n\n");

const rationaleBody = (record: DecisionRecord): string => {
  if (record.rationaleOriginal !== null) {
    return record.rationaleOriginal;
  }
  if (record.rationaleStatus === "deferred") {
    return "（稍后补充）";
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

const escapeContextMarkers = (value: string): string =>
  escapeDecisionMarkerText(value);

const unescapeContextMarkers = (value: string): string =>
  unescapeDecisionMarkerText(value);

const decisionContextBody = (record: DecisionRecord): string => {
  if (record.context === null) {
    return record.contextSummary ?? NO_NATIVE_CONTEXT;
  }
  const sections = [
    record.context.taskBackground === undefined
      ? null
      : `${TASK_BACKGROUND_HEADING}\n\n${TASK_BACKGROUND_START}\n${escapeContextMarkers(record.context.taskBackground)}\n${TASK_BACKGROUND_END}`,
    record.context.decisionFraming === undefined
      ? null
      : `${DECISION_FRAMING_HEADING}\n\n${DECISION_FRAMING_START}\n${escapeContextMarkers(record.context.decisionFraming)}\n${DECISION_FRAMING_END}`,
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

${review.lesson ?? NO_OUTCOME_LESSON}

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
  const frontmatter = stringifyYaml(properties, {
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_DOUBLE",
    lineWidth: 0,
  }).trimEnd();
  const optionsJson = JSON.stringify(record.options, null, 2);
  const selectionMarker = encodeSelection(record.selectedAnswer);
  const outcome = record.outcome ?? "（尚未记录）";

  return `---
${frontmatter}
---
# 决策点

${record.question}

## 可选方案

${readableOptions(record)}

\`\`\`${OPTIONS_FENCE}
${optionsJson}
\`\`\`

## 我的选择

${readableAnswer(record.selectedAnswer)}

<!-- decision:selection-base64 ${selectionMarker} -->

${rationaleFactorsSection(record)}## 我的理由（原文）

${rationaleBody(record)}

${RATIONALE_END_MARKER}

## 当时上下文

${decisionContextBody(record)}

${CONTEXT_END_MARKER}

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
  markdown = normalizeLegacyDecisionMarkers(markdown);
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }

  const document = parseDocument(markdown.slice(4, boundary));
  if (document.errors.length > 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  document.set("status", resolution.status);
  document.set("rationale_status", resolution.rationaleStatus);
  document.set(
    "rationale_original_present",
    resolution.rationaleOriginalPresent,
  );
  document.set("reason_factors", resolution.reasonFactors);

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
    resolution.rationale +
    body.slice(nextSection);
  return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n${updatedBody}`;
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

export const updateDecisionOutcomeMarkdown = (
  markdown: string,
  outcome: string,
): string => {
  markdown = normalizeLegacyDecisionMarkers(markdown);
  if (outcome.trim().length === 0 || outcome.length > 8_000) {
    throw new Error("Outcome must contain 1 to 8000 characters");
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
  const sectionStart = body.lastIndexOf(marker);
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
  )}${outcome}${suffix}`;
};

export const updateDecisionReviewDueDateMarkdown = (
  markdown: string,
  reviewDueDate: string | null,
): string => {
  markdown = normalizeLegacyDecisionMarkers(markdown);
  if (reviewDueDate !== null && !validCalendarDate(reviewDueDate)) {
    throw new Error("Review due date must be a valid YYYY-MM-DD date");
  }
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  const document = parseDocument(markdown.slice(4, boundary));
  if (document.errors.length > 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  document.set("review_due_date", reviewDueDate);
  return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n${markdown.slice(boundary + 5)}`;
};

export const updateDecisionAppliedPrinciplesMarkdown = (
  markdown: string,
  input: AppliedPrinciplesUpdate,
): string => {
  markdown = normalizeLegacyDecisionMarkers(markdown);
  const boundary = markdown.indexOf("\n---\n", 4);
  if (!markdown.startsWith("---\n") || boundary < 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  const document = parseDocument(markdown.slice(4, boundary));
  if (document.errors.length > 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  document.set(
    "applied_principles",
    validatedAppliedPrincipleIds(input.appliedPrincipleIds),
  );
  return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n${markdown.slice(boundary + 5)}`;
};

export const updateOutcomeReviewMarkdown = (
  markdown: string,
  input: OutcomeReviewUpdate,
): string => {
  markdown = normalizeLegacyDecisionMarkers(markdown);
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
  const document = parseDocument(markdown.slice(4, boundary));
  if (document.errors.length > 0) {
    throw new Error("Decision note has invalid YAML frontmatter");
  }
  document.set("outcome_verdict", input.verdict);
  document.set("outcome_reviewed_at", input.reviewedAt);
  document.set("outcome_lesson_present", input.lesson !== null);

  const body = markdown.slice(boundary + 5);
  const reviewHeading = "\n\n## 复盘结论\n\n";
  const reviewStart = body.indexOf(reviewHeading);
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
  return `---\n${document.toString({ lineWidth: 0 }).trimEnd()}\n---\n${bodyBeforeReview}${reviewHeading}${outcomeReviewBody(review)}\n`;
};

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
  return body
    .slice(contentStart, end < 0 ? body.length : end)
    .trim();
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
    : unescapeContextMarkers(
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
        contextBody === NO_NATIVE_CONTEXT ? null : contextBody,
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
  const lessonBody = body
    .slice(lessonContentStart, explicitEnd < 0 ? body.length : explicitEnd)
    .replace(/\n$/u, "");
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

export const parseDecision = (markdown: string): DecisionRecord => {
  markdown = normalizeLegacyDecisionMarkers(markdown);
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
  const rationale =
    rationaleStatus === "captured"
      ? (() => {
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
          const original =
            explicitBoundary >= 0
            ? body.slice(contentStart, explicitBoundary)
            : section(
                body,
                "## 我的理由（原文）",
                "## 当时上下文",
              );
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
          "## 后续结果",
        );
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
  const outcomeBody = body
    .slice(outcomeContentStart, outcomeEnd)
    .replace(/\n$/u, "");
  const outcome = outcomeBody === "（尚未记录）" ? null : outcomeBody;
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

  return {
    id: requiredString(properties, "id"),
    created: requiredString(properties, "created"),
    status: status as PersistedDecisionStatus,
    sourceClient: sourceClientSchema.parse(
      requiredString(properties, "source_client"),
    ),
    project: requiredString(properties, "project"),
    workflow: nullableString(properties, "workflow"),
    decisionType: decisionTypeValue as DecisionType,
    question: section(body, "# 决策点", "## 可选方案"),
    ...parsedContext,
    detection: parseDetection(properties),
    options: parseOptions(body),
    selectedAnswer: decodeSelection(body),
    llmRecommendation: nullableString(properties, "llm_recommendation"),
    rationaleStatus,
    rationaleOriginal: rationale,
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

const collectMarkdown = async (directory: string): Promise<string[]> => {
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
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdown(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
};

export class MarkdownRepository {
  readonly #vaultPath: string;
  readonly #folder: string;
  readonly #rename: typeof rename;

  constructor(vaultPath: string, options: MarkdownRepositoryOptions = {}) {
    this.#vaultPath = vaultPath;
    this.#folder = options.folder ?? DEFAULT_FOLDER;
    this.#rename = options.rename ?? rename;
  }

  get decisionsPath(): string {
    return join(this.#vaultPath, this.#folder, "decisions");
  }

  pathFor(record: DecisionRecord): string {
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

  async write(record: DecisionRecord): Promise<StoredNote> {
    const target = this.pathFor(record);
    const content = serializeDecision(record);
    await this.#writeContent(target, content);
    return {
      id: record.id,
      path: target,
      contentHash: sha256(content),
    };
  }

  async read(path: string): Promise<ParsedStoredNote> {
    const content = await readFile(path, "utf8");
    const record = parseDecision(content);
    return {
      id: record.id,
      path,
      contentHash: sha256(content),
      record,
    };
  }

  async scan(): Promise<ScanResult> {
    const paths = await collectMarkdown(this.decisionsPath);
    const notes: ParsedStoredNote[] = [];
    const diagnostics: NoteDiagnostic[] = [];
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
    const scan = await this.scan();
    const matches = scan.notes.filter((note) => note.id === id);
    if (matches.length === 0) {
      throw new Error(`Decision note not found: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple decision notes use ID: ${id}`);
    }
    const note = matches[0] as ParsedStoredNote;
    if (note.record.rationaleStatus !== "deferred") {
      throw new Error(`Decision rationale is not deferred: ${id}`);
    }
    const content = updateDeferredRationaleMarkdown(
      await readFile(note.path, "utf8"),
      input,
    );
    await this.#writeContent(note.path, content);
    return this.read(note.path);
  }

  async skipDeferredRationale(id: string): Promise<ParsedStoredNote> {
    const scan = await this.scan();
    const matches = scan.notes.filter((note) => note.id === id);
    if (matches.length === 0) {
      throw new Error(`Decision note not found: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple decision notes use ID: ${id}`);
    }
    const note = matches[0] as ParsedStoredNote;
    if (note.record.rationaleStatus !== "deferred") {
      throw new Error(`Decision rationale is not deferred: ${id}`);
    }
    const content = skipDeferredRationaleMarkdown(
      await readFile(note.path, "utf8"),
    );
    await this.#writeContent(note.path, content);
    return this.read(note.path);
  }

  async deleteDeferredRationale(id: string): Promise<ParsedStoredNote> {
    const scan = await this.scan();
    const matches = scan.notes.filter((note) => note.id === id);
    if (matches.length === 0) {
      throw new Error(`Decision note not found: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple decision notes use ID: ${id}`);
    }
    const note = matches[0] as ParsedStoredNote;
    if (note.record.rationaleStatus !== "deferred") {
      throw new Error(`Decision rationale is not deferred: ${id}`);
    }
    await unlink(note.path);
    return note;
  }

  async updateOutcome(id: string, outcome: string): Promise<ParsedStoredNote> {
    const scan = await this.scan();
    const matches = scan.notes.filter((note) => note.id === id);
    if (matches.length === 0) {
      throw new Error(`Decision note not found: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple decision notes use ID: ${id}`);
    }
    const note = matches[0] as ParsedStoredNote;
    const content = updateDecisionOutcomeMarkdown(
      await readFile(note.path, "utf8"),
      outcome,
    );
    await this.#writeContent(note.path, content);
    return this.read(note.path);
  }

  async updateReviewDueDate(
    id: string,
    reviewDueDate: string | null,
  ): Promise<ParsedStoredNote> {
    const scan = await this.scan();
    const matches = scan.notes.filter((note) => note.id === id);
    if (matches.length === 0) {
      throw new Error(`Decision note not found: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple decision notes use ID: ${id}`);
    }
    const note = matches[0] as ParsedStoredNote;
    const content = updateDecisionReviewDueDateMarkdown(
      await readFile(note.path, "utf8"),
      reviewDueDate,
    );
    await this.#writeContent(note.path, content);
    return this.read(note.path);
  }

  async updateAppliedPrinciples(
    id: string,
    input: AppliedPrinciplesUpdate,
  ): Promise<ParsedStoredNote> {
    const scan = await this.scan();
    const matches = scan.notes.filter((note) => note.id === id);
    if (matches.length === 0) {
      throw new Error(`Decision note not found: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple decision notes use ID: ${id}`);
    }
    const note = matches[0] as ParsedStoredNote;
    const content = updateDecisionAppliedPrinciplesMarkdown(
      await readFile(note.path, "utf8"),
      input,
    );
    await this.#writeContent(note.path, content);
    return this.read(note.path);
  }

  async updateOutcomeReview(
    id: string,
    input: OutcomeReviewUpdate,
  ): Promise<ParsedStoredNote> {
    const scan = await this.scan();
    const matches = scan.notes.filter((note) => note.id === id);
    if (matches.length === 0) {
      throw new Error(`Decision note not found: ${id}`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple decision notes use ID: ${id}`);
    }
    const note = matches[0] as ParsedStoredNote;
    const content = updateOutcomeReviewMarkdown(
      await readFile(note.path, "utf8"),
      input,
    );
    await this.#writeContent(note.path, content);
    return this.read(note.path);
  }

  async #writeContent(target: string, content: string): Promise<void> {
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await this.#rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
