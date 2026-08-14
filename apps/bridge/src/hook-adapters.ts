import {
  CAPTURE_EVENT_VERSION,
  capturedDecisionEventSchema,
  type CapturedAnswer,
  type CapturedDecisionEvent,
  type CapturedOption,
} from "@cognelis/decision-protocol";
import { basename } from "node:path";

interface NativeQuestion {
  id?: string;
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
      ...(header === null ? {} : { header }),
      question,
      options,
      multiSelect: value.multiSelect === true,
    });
  }
  return questions;
};

const answerValues = (
  value: unknown,
  multiSelect: boolean,
): string[] | null => {
  if (typeof value === "string") {
    const normalized = multiSelect
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [value.trim()].filter((item) => item.length > 0);
    return normalized.length === 0 ? null : normalized;
  }
  if (Array.isArray(value)) {
    const values = value.map(string);
    return values.every((item) => item !== null)
      ? (values as string[])
      : null;
  }
  const wrapped = object(value);
  return wrapped === null
    ? null
    : answerValues(wrapped.answers, multiSelect);
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
    return values === null
      ? []
      : [
          {
            questionIndex,
            ...(question.header === undefined
              ? {}
              : { header: question.header }),
            question: question.question,
            options: question.options,
            answer: capturedAnswer(values, question),
            multiSelect: question.multiSelect,
          },
        ];
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
    project: basename(payload.cwd),
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
  const questions = nativeQuestions(payload.toolInput.questions, false);
  const answers = object(payload.toolResponse.answers);
  if (questions === null || answers === null) {
    return null;
  }
  return eventFrom(
    payload,
    "claude-code",
    questions,
    (question) =>
      answerValues(answers[question.question], question.multiSelect),
    now,
  );
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
      answerValues(answers[question.id as string], question.multiSelect),
    now,
  );
};
