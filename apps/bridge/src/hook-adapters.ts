import {
  CAPTURE_EVENT_VERSION,
  capturedDecisionEventSchema,
  capturedQuestionSchema,
  clipText,
  type CapturedAnswer,
  type CapturedDecisionEvent,
  type CapturedOption,
} from "@cognelis/decision-protocol";
import { basename } from "node:path";

interface NativeQuestion {
  id?: string;
  /** The key its answer is filed under, exactly as sent: trimmed, a question ending in a newline lost it. */
  answerKey: string;
  header?: string;
  question: string;
  options: CapturedOption[];
  multiSelect: boolean;
}

interface CommonPayload {
  sessionId: string;
  turnId?: string;
  cwd: string;
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResponse: Record<string, unknown>;
}

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const string = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;

const commonPayload = (input: unknown): CommonPayload | null => {
  const value = object(input);
  if (value === null) {
    return null;
  }
  const sessionId = string(value.session_id);
  const cwd = string(value.cwd);
  const toolUseId = string(value.tool_use_id);
  const toolName = string(value.tool_name);
  const toolInput = object(value.tool_input);
  const toolResponse = object(value.tool_response);
  if (
    sessionId === null ||
    cwd === null ||
    toolUseId === null ||
    toolName === null ||
    toolInput === null ||
    toolResponse === null
  ) {
    return null;
  }
  const turnId = string(value.turn_id);
  return {
    sessionId,
    ...(turnId === null ? {} : { turnId }),
    cwd,
    toolUseId,
    toolName,
    toolInput,
    toolResponse,
  };
};

const nativeOptions = (input: unknown): CapturedOption[] | null => {
  if (!Array.isArray(input)) {
    return null;
  }
  const options: CapturedOption[] = [];
  for (const item of input) {
    const value = object(item);
    const label = string(value?.label);
    if (value === null || label === null) {
      return null;
    }
    const id = string(value.id);
    const description = string(value.description);
    options.push({
      ...(id === null ? {} : { id }),
      label,
      ...(description === null ? {} : { description }),
    });
  }
  return options;
};

const nativeQuestions = (
  input: unknown,
  includeIds: boolean,
): NativeQuestion[] | null => {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  const questions: NativeQuestion[] = [];
  for (const item of input) {
    const value = object(item);
    if (value === null) {
      return null;
    }
    const question = string(value.question);
    const options = nativeOptions(value.options);
    if (question === null || options === null) {
      return null;
    }
    const id = includeIds ? string(value.id) : null;
    if (includeIds && id === null) {
      return null;
    }
    const header = string(value.header);
    questions.push({
      ...(id === null ? {} : { id }),
      answerKey: (includeIds ? value.id : value.question) as string,
      ...(header === null ? {} : { header }),
      question,
      options,
      multiSelect: value.multiSelect === true,
    });
  }
  return questions;
};

/**
 * Several options chosen come as one string, joined with commas. Split at every comma, an option whose
 * label has one of its own is cut in pieces, and a list typed as the answer turns into as many
 * "choices" (past eight, the whole capture fails its check and is lost). So the pieces are joined back
 * into the options they spell, longest first, and what spells none is the reader's own answer, one value.
 */
const splitSelection = (value: string, labels: readonly string[]): string[] => {
  // Pieces at even places, the separators between them at odd ones, to join back exactly as written.
  const tokens = value.split(/(,\s*)/u);
  const pieces = tokens.filter((_token, index) => index % 2 === 0);
  const spelled = (from: number, to: number) => tokens.slice(from * 2, to * 2 - 1).join("").trim();
  // No label spans more pieces than its own commas make: trying longer runs only costs time, and that
  // cost was cubic in the commas of a pasted list, past a hook's five seconds at a few kilobytes.
  const span = Math.max(1, ...labels.map((label) => label.split(/,\s*/u).length));
  const chosen: string[] = [];
  // In the order written: the reader's own text stays where it was among the options, pieces of it next
  // to each other being one answer, as written ("1,000" stays "1,000").
  const inPlace: string[] = [];
  const ownAt: number[] = [];
  let ownFrom = -1;
  for (let start = 0; start < pieces.length;) {
    let end = Math.min(pieces.length, start + span);
    while (end > start && !labels.includes(spelled(start, end))) end -= 1;
    if (end > start) {
      chosen.push(spelled(start, end));
      inPlace.push(spelled(start, end));
      ownFrom = -1;
      start = end;
    } else {
      if (pieces[start]!.trim().length > 0) {
        if (ownFrom === -1) {
          ownFrom = start;
          ownAt.push(inPlace.length);
          inPlace.push("");
        }
        inPlace[ownAt.at(-1)!] = spelled(ownFrom, start + 1);
      }
      start += 1;
    }
  }
  // Past eight values (the capture protocol's limit) the capture fails its check and is lost: then the
  // reader's own text is one answer after the options, as few values as it can be.
  if (inPlace.length <= 8) return inPlace;
  return ownAt.length === 0 ? chosen : [...chosen, ownAt.map((index) => inPlace[index]).join(", ")];
};

const answerValues = (
  value: unknown,
  question: NativeQuestion,
): string[] | null => {
  if (typeof value === "string") {
    const normalized = question.multiSelect
      ? splitSelection(value, question.options.map((option) => option.label))
      : [value.trim()].filter((item) => item.length > 0);
    return normalized.length === 0 ? null : normalized;
  }
  if (Array.isArray(value)) {
    const values = value.map(string);
    return values.length > 0 && values.every((item) => item !== null)
      ? (values as string[])
      : null;
  }
  const wrapped = object(value);
  return wrapped === null
    ? null
    : answerValues(wrapped.answers, question);
};

const capturedAnswer = (
  values: string[],
  question: NativeQuestion,
): CapturedAnswer => {
  if (question.multiSelect || values.length > 1) {
    return { kind: "multiple", values };
  }
  const labels = new Set(question.options.map((option) => option.label));
  return labels.has(values[0] as string)
    ? { kind: "preset", values: [values[0] as string] }
    : { kind: "custom", values: [values[0] as string] };
};

const eventFrom = (
  payload: CommonPayload,
  sourceClient: "claude-code" | "codex",
  questions: NativeQuestion[],
  answerFor: (question: NativeQuestion) => string[] | null,
  now: () => Date,
): CapturedDecisionEvent | null => {
  const capturedQuestions = questions.flatMap((question, questionIndex) => {
    const values = answerFor(question);
    if (values === null) return [];
    // One question past a limit is that question's, not the batch's: its free text is cut to fit (a long
    // "Other" answer keeps what fits), and what still does not fit is left out on its own.
    const captured = capturedQuestionSchema.safeParse({
      questionIndex,
      ...(question.header === undefined
        ? {}
        : { header: clipText(question.header, 200) }),
      question: clipText(question.question, 4_000),
      options: question.options.map((option) =>
        option.description === undefined ? option : { ...option, description: clipText(option.description, 2_000) }),
      answer: capturedAnswer(values.map((value) => clipText(value, 2_000)), question),
      multiSelect: question.multiSelect,
    });
    return captured.success ? [captured.data] : [];
  });
  if (capturedQuestions.length === 0) {
    return null;
  }
  return capturedDecisionEventSchema.parse({
    eventVersion: CAPTURE_EVENT_VERSION,
    captureMode: "structured_tool",
    sourceClient,
    sessionId: payload.sessionId,
    ...(payload.turnId === undefined ? {} : { turnId: payload.turnId }),
    sourceEventId: payload.toolUseId,
    toolUseId: payload.toolUseId,
    batchId: `${sourceClient}:${payload.sessionId}:${payload.toolUseId}`,
    // A session started at the root has no folder name to go by.
    project: basename(payload.cwd) || "unknown-project",
    cwd: payload.cwd,
    capturedAt: now().toISOString(),
    questions: capturedQuestions,
  });
};

export const adaptClaudePostToolUse = (
  input: unknown,
  now: () => Date = () => new Date(),
): CapturedDecisionEvent | null => {
  const payload = commonPayload(input);
  if (payload === null || payload.toolName !== "AskUserQuestion") {
    return null;
  }
  // Closed on its own while the reader was away from the keyboard: what stood selected then was not chosen.
  if (typeof payload.toolResponse.afkTimeoutMs === "number") {
    return null;
  }
  const questions = nativeQuestions(payload.toolInput.questions, false);
  const answers = object(payload.toolResponse.answers) ?? {};
  const annotations = object(payload.toolResponse.annotations);
  // Another round of questions asked for instead of an answer: what was typed asks for it, and answers nothing.
  const response = payload.toolResponse.followUp === true ? undefined : string(payload.toolResponse.response)?.trim();
  if (questions === null) {
    return null;
  }
  return eventFrom(
    payload,
    "claude-code",
    questions,
    (question) => {
      const value = answers[question.answerKey];
      // Notes written without choosing are filed as "(notes only)": the notes are what the reader answered.
      if (value === "(notes only)") {
        const notes = string(object(annotations?.[question.answerKey])?.notes)?.trim();
        return notes ? [notes] : null;
      }
      // Typed instead of choosing at all: the answer to the one question asked.
      return answerValues(value, question) ?? (questions.length === 1 && response ? [response] : null);
    },
    now,
  );
};

/** Codex sends a note as one more entry of the answer list, prefixed so: the reader's words, not an option. */
const NOTE = "user_note: ";

const withoutNotes = (values: string[] | null): string[] | null => {
  if (values === null) return null;
  const chosen = values.filter((value) => !value.startsWith(NOTE));
  const notes = values
    .filter((value) => value.startsWith(NOTE))
    .map((value) => value.slice(NOTE.length).trim())
    .filter((value) => value.length > 0);
  // Written instead of choosing, the note is the answer; beside a choice it is left out, as Claude Code's are.
  return chosen.length > 0 ? chosen : notes.length > 0 ? [notes.join("\n")] : null;
};

export const adaptCodexPostToolUse = (
  input: unknown,
  now: () => Date = () => new Date(),
): CapturedDecisionEvent | null => {
  const payload = commonPayload(input);
  if (
    payload === null ||
    (payload.toolName !== "request_user_input" &&
      payload.toolName !== "AskUserQuestion")
  ) {
    return null;
  }
  const questions = nativeQuestions(payload.toolInput.questions, true);
  const answers = object(payload.toolResponse.answers);
  if (questions === null || answers === null) {
    return null;
  }
  return eventFrom(
    payload,
    "codex",
    questions,
    (question) =>
      withoutNotes(answerValues(answers[question.answerKey], question)),
    now,
  );
};
