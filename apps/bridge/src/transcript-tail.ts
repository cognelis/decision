import { clipText, clipTextEnd } from "@cognelis/decision-protocol";
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
  // A prompt typed into Claude Code is written as a plain string; blocks are for everything else.
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
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
  return text.length > 0 ? text : null;
};

interface VisibleMessage {
  role: "assistant" | "user";
  text: string;
  /** The model call it is a chunk of, where its reply comes in more than one (Copilot's `apiCallId`): joined. */
  call?: string;
  /** Such a chunk as written, its edges' spaces and line breaks and all: the reply is trimmed once joined. */
  raw?: string;
}

const visibleMessage = (value: unknown): VisibleMessage | null => {
  const object = asObject(value);
  // Written as the user's but not typed by them: hook feedback, an image placeholder, a check-in.
  if (object === null || object.isMeta === true) {
    return null;
  }
  for (const branch of [object.message, object.payload]) {
    const message = asObject(branch);
    if (
      message?.role === "assistant" ||
      message?.role === "user"
    ) {
      const text = contentText(message.content);
      // A plain string in a wrapper (a background task's notice, a slash command and its output) is the
      // client's, not the reader's.
      if (text !== null && !(typeof message.content === "string" && text.startsWith("<"))) {
        return {
          role: message.role,
          // Match hook payload capture: retain the question at the end of an
          // assistant reply and the task at the start of a user message.
          text: message.role === "assistant"
            ? clipTextEnd(text, 8_000)
            : clipText(text, 8_000),
        };
      }
    }
  }
  return null;
};

/** What Antigravity wraps the reader's message in: the request alone, or the message without the metadata. */
export const unwrapEnvelope = (text: string, envelope: { keep: string; drop: readonly string[] }): string => {
  const kept = new RegExp(`<${envelope.keep}>\\s*([\\s\\S]*?)\\s*</${envelope.keep}>`, "u").exec(text)?.[1];
  return (kept ?? envelope.drop.reduce((rest, tag) => rest.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gu"), ""), text)).trim();
};

const ANTIGRAVITY_ENVELOPE = { keep: "USER_REQUEST", drop: ["ADDITIONAL_METADATA", "USER_SETTINGS_CHANGE"] } as const;

/**
 * A line of Antigravity's transcript.jsonl, one step of the conversation: `{step_index, source, type, content}`, `type`
 * USER_INPUT for what the reader sent (wrapped in <USER_REQUEST>), PLANNER_RESPONSE for the agent's reply (a step of
 * tool calls alone has no text). `content` a string, or a list of `{text}`. As agy 1.4.8's own guide and claude-mem's
 * reader (src/shared/transcript-parser.ts) describe it, not seen on a real agy: a line of any other form is skipped.
 */
const antigravityMessage = (value: unknown): VisibleMessage | null => {
  const object = asObject(value);
  const role = object?.type === "USER_INPUT" ? "user" : object?.type === "PLANNER_RESPONSE" ? "assistant" : null;
  const content = object?.content;
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => {
            const item = asObject(part);
            return item !== null && (item.type === undefined || item.type === "text") && typeof item.text === "string" ? [item.text] : [];
          }).join("\n")
        : "";
  const text = role === "user" ? unwrapEnvelope(raw, ANTIGRAVITY_ENVELOPE) : raw.trim();
  if (role === null || text.length === 0) return null;
  return { role, text: role === "assistant" ? clipTextEnd(text, 8_000) : clipText(text, 8_000) };
};

/**
 * A line of Copilot CLI's events.jsonl (session-state/<id>/events.jsonl): `{ type, data, agentId? }`, `user.message`
 * for what the reader sent and `assistant.message` for the agent's (`data.content`). A message that asks for tools
 * (`data.toolRequests`) is a step on the way, not the turn's reply, nor is its thinking (`phase`); a subagent's
 * (`agentId`) is not this conversation's.
 * As github/copilot-sdk's session events describe it, not seen on a real Copilot CLI.
 */
const copilotMessage = (value: unknown): VisibleMessage | null => {
  const object = asObject(value);
  const data = asObject(object?.data);
  const role = object?.type === "user.message" ? "user" : object?.type === "assistant.message" ? "assistant" : null;
  if (role === null || data === null || object?.agentId !== undefined || object?.ephemeral === true) return null;
  if (role === "assistant" && ((Array.isArray(data.toolRequests) && data.toolRequests.length > 0) || data.phase === "thinking")) return null;
  // One model call's reply may come in chunks (`chunkIndex` of `chunkCount`), each a message of the same `apiCallId`:
  // kept as written, a space at a chunk's edge (`Use ` + `SQLite`) and a chunk of spaces alone too.
  if (role === "assistant" && typeof data.apiCallId === "string" && typeof data.content === "string") {
    return { role, text: data.content.trim(), call: data.apiCallId, raw: data.content };
  }
  const text = contentText(data.content);
  if (text === null) return null;
  return { role, text: role === "assistant" ? clipTextEnd(text, 8_000) : clipText(text, 8_000) };
};

/**
 * A line of CodeBuddy Code's transcript: a Responses-style item, `{ type: "message", role, content: [{ type:
 * "input_text" | "output_text", text }], providerData }`. What the client put in as the reader's (`providerData.skipRun`
 * or `isMeta`, or a text in one of its tags) is not theirs. As third parties that read it describe it (OpenViking's
 * codebuddy-turns.mjs), not seen on a real CodeBuddy.
 */
const codebuddyMessage = (value: unknown): VisibleMessage | null => {
  const object = asObject(value);
  const role = object?.type === "message" && (object.role === "user" || object.role === "assistant") ? object.role : null;
  const provider = asObject(object?.providerData);
  if (role === null || provider?.skipRun === true || provider?.isMeta === true) return null;
  const text = contentText(object?.content);
  if (text === null || (role === "user" && text.startsWith("<"))) return null;
  return { role, text: role === "assistant" ? clipTextEnd(text, 8_000) : clipText(text, 8_000) };
};

/**
 * How a client's transcript lines are read (the registry's `capture.transcript`). `droid`: Claude Code's reading of a
 * message (`{ type: "message", message: { role, content } }`), with Droid's turns told apart as below.
 */
export type TranscriptFormat = "claude-codex" | "antigravity" | "copilot" | "codebuddy" | "droid";

const MESSAGE_READERS: Record<TranscriptFormat, (value: unknown) => VisibleMessage | null> = {
  "claude-codex": (value) => visibleMessage(value),
  antigravity: (value) => antigravityMessage(value),
  copilot: (value) => copilotMessage(value),
  codebuddy: (value) => codebuddyMessage(value),
  droid: (value) => visibleMessage(value),
};

/**
 * A line that begins a turn of the reader's though no text of theirs can be read in it (an attachment alone, an empty
 * message): the reply before it is no longer the latest. Not a tool's result handed back as the user's, nor what the
 * client puts in as theirs (a meta line, a text in one of its tags). Claude Code's and Codex's are read as before.
 */
const USER_TURN: Partial<Record<TranscriptFormat, (value: unknown) => boolean>> = {
  antigravity: (value) => antigravityStep(value)?.role === "user",
  copilot: (value) => {
    const object = asObject(value);
    return object?.type === "user.message" && object.agentId === undefined && object.ephemeral !== true;
  },
  codebuddy: (value) => {
    const object = asObject(value);
    const provider = asObject(object?.providerData);
    if (object?.type !== "message" || object.role !== "user" || provider?.skipRun === true || provider?.isMeta === true) return false;
    return !(contentText(object.content)?.startsWith("<") ?? false);
  },
  droid: (value) => {
    const object = asObject(value);
    const message = asObject(object?.message);
    if (object?.type !== "message" || object.isMeta === true || message?.role !== "user") return false;
    const content = message.content;
    if (typeof content === "string") return !content.trim().startsWith("<");
    return !(Array.isArray(content) && content.length > 0 && content.every((part) => asObject(part)?.type === "tool_result"));
  },
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
      // Only a line cut in half is dropped: a tail starting right after a "\n" starts with a whole one, which
      // was dropped all the same (a request_user_input call, and its answer had nothing to pair with).
      const before = Buffer.alloc(1);
      await read(file, { buffer: before, offset: 0, length: 1, position: position - 1 });
      if (before[0] !== 0x0a) {
        const firstNewline = tail.indexOf("\n");
        tail =
          firstNewline < 0 ? "" : tail.slice(firstNewline + 1);
      }
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
  options: TailReadOptions & { format?: TranscriptFormat } = {},
): Promise<string | null> =>
  (await readLastDecisionTurn(path, options))?.assistantText ?? null;

export const readLastDecisionTurn = async (
  path: string,
  options: TailReadOptions & { format?: TranscriptFormat } = {},
): Promise<DecisionTurnExcerpt | null> => (await readDecisionTurns(path, options)).latest;

/** The turns before the last, nearest first, as far back as the tail reaches. */
export const readEarlierDecisionTurns = async (
  path: string,
  options: TailReadOptions & { format?: TranscriptFormat } = {},
): Promise<DecisionTurnExcerpt[]> => (await readDecisionTurns(path, options)).earlier.reverse();

const readDecisionTurns = async (
  path: string,
  options: TailReadOptions & { format?: TranscriptFormat },
): Promise<{ latest: DecisionTurnExcerpt | null; earlier: DecisionTurnExcerpt[] }> => {
  const earlier: DecisionTurnExcerpt[] = [];
  const messageOf = MESSAGE_READERS[options.format ?? "claude-codex"];
  try {
    const lines = await readTailLines(path, options);
    if (lines === null) {
      return { latest: null, earlier };
    }
    let userText: string | null = null;
    let latest: DecisionTurnExcerpt | null = null;
    let latestCall: string | undefined;
    // The chunks of latestCall's reply so far, as written.
    let callRaw = "";
    const userTurn = USER_TURN[options.format ?? "claude-codex"];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }
      try {
        const value = JSON.parse(line) as unknown;
        const message = messageOf(value);
        // A turn the reader began whose message cannot be read still ends the one before: its reply is not this
        // turn's, and was paired with the next answer. This turn's own, if none can be read, is none.
        if (message === null && userTurn?.(value) === true) {
          if (latest !== null) earlier.push(latest);
          userText = null;
          latest = null;
          latestCall = undefined;
        } else if (message?.role === "user") {
          if (latest !== null) earlier.push(latest);
          userText = message.text;
          latest = null;
          latestCall = undefined;
        } else if (message?.role === "assistant" && message.call !== undefined) {
          // The next chunk of the same model call's reply follows the one before, joined as written and trimmed whole;
          // any other message starts anew.
          callRaw = message.call === latestCall ? `${callRaw}${message.raw ?? message.text}` : (message.raw ?? message.text);
          latestCall = message.call;
          const text = callRaw.trim();
          if (text.length > 0) latest = { userText, assistantText: clipTextEnd(text, 8_000) };
        } else if (message?.role === "assistant") {
          latest = { userText, assistantText: message.text };
          latestCall = undefined;
        }
      } catch {
        // Invalid tail lines are ignored without exposing their contents.
      }
    }
    return { latest, earlier };
  } catch {
    return { latest: null, earlier };
  }
};

/**
 * Whether the transcript's last step it can read is the reader's message, with nothing of the agent's after it: a
 * model call then starts a turn. Unread, or no such step: false.
 */
export const readTurnStart = async (
  path: string,
  options: TailReadOptions & { format?: TranscriptFormat } = {},
): Promise<boolean> => {
  const lines = await readTailLines(path, options).catch(() => null);
  if (lines === null) return false;
  const messageOf = options.format === "antigravity" ? antigravityStep : MESSAGE_READERS[options.format ?? "claude-codex"];
  let last: VisibleMessage["role"] | null = null;
  for (const line of lines) {
    try {
      last = messageOf(JSON.parse(line) as unknown)?.role ?? last;
    } catch {
      // Invalid tail lines are ignored without exposing their contents.
    }
  }
  return last === "user";
};

/** Any step of the agent's counts here, one of tool calls alone too: a turn under way. */
const antigravityStep = (value: unknown): Pick<VisibleMessage, "role"> | null => {
  const type = asObject(value)?.type;
  return type === "USER_INPUT" ? { role: "user" } : type === "PLANNER_RESPONSE" ? { role: "assistant" } : null;
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
