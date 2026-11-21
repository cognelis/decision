import type { ClientDescriptor } from "@cognelis/decision-integrations";
import { readHookField } from "@cognelis/decision-protocol";

import { readTurnStart, unwrapEnvelope } from "./transcript-tail.js";

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Claude Code's name for each field the registry may give another name, as the text capture reads them. */
const CLAUDE_NAMES = {
  sessionId: "session_id",
  cwd: "cwd",
  prompt: "prompt",
  reply: "last_assistant_message",
  transcript: "transcript_path",
  turnId: "turn_id",
  promptId: "prompt_id",
} as const;

/**
 * A client's hook input in Claude Code's names, which the capture reads; null for one it is not to read at all (a
 * turn's end that is no reply, a prompt sent again on each model call). Claude Code's and Codex's pass as they came.
 */
export const normalizeHookInput = async (
  input: unknown,
  client: ClientDescriptor,
  operation: "stop" | "user-prompt-submit",
  turnStart: typeof readTurnStart = readTurnStart,
): Promise<unknown> => {
  const object = asObject(input);
  if (object === null) return input;
  const { fields, stopReason, promptOnly, promptEnvelope } = client.capture;
  if (operation === "stop" && stopReason !== undefined && !stopReason.complete.includes(String(readHookField(object, stopReason.field)))) {
    return null;
  }
  if (
    operation === "user-prompt-submit" &&
    promptOnly !== undefined &&
    !promptOnly.values.some((value) => value === readHookField(object, promptOnly.field))
  ) {
    const transcript = readHookField(object, fields?.transcript ?? "transcript_path");
    const starts =
      promptOnly.orTranscriptTurnStart === true &&
      typeof transcript === "string" &&
      (await turnStart(transcript, client.capture.transcript === undefined ? {} : { format: client.capture.transcript }));
    if (!starts) return null;
  }
  if (fields === undefined) return input;
  const normalized = { ...object };
  for (const [key, claudeName] of Object.entries(CLAUDE_NAMES)) {
    const own = fields[key as keyof typeof CLAUDE_NAMES];
    // Read by the one rule the form's 试解析 shows (readHookField), its name Claude Code's own or not: a list there, by its first item.
    if (own === undefined) continue;
    // A dotted path into the input; a list (Antigravity's workspacePaths) by its first item.
    normalized[claudeName] = readHookField(object, own);
  }
  if (promptEnvelope !== undefined && typeof normalized.prompt === "string") {
    normalized.prompt = unwrapEnvelope(normalized.prompt, promptEnvelope);
  }
  return normalized;
};
