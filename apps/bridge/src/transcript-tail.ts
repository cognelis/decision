import {
  open,
  type FileHandle,
} from "node:fs/promises";

interface TailReadOptions {
  maximumBytes?: number;
  read?: (
    file: FileHandle,
    options: {
      buffer: Buffer;
      offset: number;
      length: number;
      position: number;
    },
  ) => Promise<{ bytesRead: number; buffer: Buffer }>;
}

export interface CodexTranscriptDecision {
  turnId: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  toolResponse: Record<string, unknown>;
}

export interface DecisionTurnExcerpt {
  userText: string | null;
  assistantText: string;
}

const asObject = (
  value: unknown,
): Record<string, unknown> | null =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const contentText = (value: unknown): string | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value.flatMap((item) => {
    const object = asObject(item);
    return object !== null &&
      (object.type === "text" ||
        object.type === "output_text" ||
        object.type === "input_text") &&
      typeof object.text === "string"
      ? [object.text]
      : [];
  });
  if (parts.length === 0) {
    return null;
  }
  const text = parts.join("\n").trim();
  return text.length > 0 && text.length <= 8_000 ? text : null;
};

interface VisibleMessage {
  role: "assistant" | "user";
  text: string;
}

const visibleMessage = (value: unknown): VisibleMessage | null => {
  const object = asObject(value);
  if (object === null) {
    return null;
  }
  for (const branch of [object.message, object.payload]) {
    const message = asObject(branch);
    if (
      message?.role === "assistant" ||
      message?.role === "user"
    ) {
      const text = contentText(message.content);
      if (text !== null) {
        return { role: message.role, text };
      }
    }
  }
  return null;
};

const assistantText = (value: unknown): string | null => {
  const message = visibleMessage(value);
  return message?.role === "assistant" ? message.text : null;
};

const nonEmptyString = (
  value: unknown,
  maximum: number,
): string | null =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maximum
    ? value
    : null;

const parsedObject = (
  value: unknown,
): Record<string, unknown> | null => {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return asObject(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
};

const codexTurnId = (
  payload: Record<string, unknown>,
): string | null => {
  const metadata = asObject(
    payload.internal_chat_message_metadata_passthrough,
  );
  return nonEmptyString(metadata?.turn_id, 500);
};

const readTailLines = async (
  path: string,
  options: TailReadOptions,
): Promise<string[] | null> => {
  const maximumBytes = options.maximumBytes ?? 64 * 1_024;
  if (
    !Number.isInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 1024 * 1024
  ) {
    throw new Error("Transcript tail size is invalid");
  }
  let file: FileHandle | null = null;
  try {
    file = await open(path, "r");
    const { size } = await file.stat();
    const length = Math.min(size, maximumBytes);
    const position = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    const read =
      options.read ??
      ((handle: FileHandle, input) => handle.read(input));
    const result = await read(file, {
      buffer,
      offset: 0,
      length,
      position,
    });
    let tail = result.buffer
      .subarray(0, result.bytesRead)
      .toString("utf8");
    if (position > 0) {
      const firstNewline = tail.indexOf("\n");
      tail =
        firstNewline < 0 ? "" : tail.slice(firstNewline + 1);
    }
    return tail.split(/\r?\n/u);
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
};

export const readLastAssistantText = async (
  path: string,
  options: TailReadOptions = {},
): Promise<string | null> => {
  try {
    const lines = await readTailLines(path, options);
    if (lines === null) {
      return null;
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (line === undefined || line.length === 0) {
        continue;
      }
      try {
        const text = assistantText(JSON.parse(line) as unknown);
        if (text !== null) {
          return text;
        }
      } catch {
        // Invalid tail lines are ignored without exposing their contents.
      }
    }
    return null;
  } catch {
    return null;
  }
};

export const readLastDecisionTurn = async (
  path: string,
  options: TailReadOptions = {},
): Promise<DecisionTurnExcerpt | null> => {
  try {
    const lines = await readTailLines(path, options);
    if (lines === null) {
      return null;
    }
    let userText: string | null = null;
    let latest: DecisionTurnExcerpt | null = null;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      try {
        const message = visibleMessage(
          JSON.parse(line) as unknown,
        );
        if (message?.role === "user") {
          userText = message.text;
        } else if (message?.role === "assistant") {
          latest = {
            userText,
            assistantText: message.text,
          };
        }
      } catch {
        // Invalid tail lines are ignored without exposing their contents.
      }
    }
    return latest;
  } catch {
    return null;
  }
};

export const readCodexDecisions = async (
  path: string,
  options: TailReadOptions & { turnId: string },
): Promise<CodexTranscriptDecision[]> => {
  const turnId = nonEmptyString(options.turnId, 500);
  if (turnId === null) {
    return [];
  }
  const lines = await readTailLines(path, options);
  if (lines === null) {
    return [];
  }
  const calls = new Map<string, Record<string, unknown>>();
  const decisions: CodexTranscriptDecision[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) {
      continue;
    }
    try {
      const record = asObject(JSON.parse(line) as unknown);
      const payload = asObject(record?.payload);
      if (
        record?.type !== "response_item" ||
        payload === null ||
        codexTurnId(payload) !== turnId
      ) {
        continue;
      }
      const callId = nonEmptyString(payload.call_id, 500);
      if (callId === null) {
        continue;
      }
      if (
        payload.type === "function_call" &&
        payload.name === "request_user_input"
      ) {
        const toolInput = parsedObject(payload.arguments);
        if (toolInput !== null) {
          calls.set(callId, toolInput);
        }
        continue;
      }
      if (payload.type !== "function_call_output") {
        continue;
      }
      const toolInput = calls.get(callId);
      const toolResponse = parsedObject(payload.output);
      if (toolInput !== undefined && toolResponse !== null) {
        decisions.push({
          turnId,
          toolUseId: callId,
          toolInput,
          toolResponse,
        });
        calls.delete(callId);
      }
    } catch {
      // Invalid tail lines are ignored without exposing their contents.
    }
  }
  return decisions;
};
