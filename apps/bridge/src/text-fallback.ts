import { TextDecisionAnalyzer } from "@cognelis/decision-core";
import type {
  CaptureAuditRecordInput,
} from "@cognelis/decision-storage";
import {
  capturedDecisionContextSchema,
  clipText,
  clipTextEnd,
  semanticDecisionPairSchema,
  type CapturedDecisionEvent,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { createHash } from "node:crypto";

import {
  TextCaptureStore,
  type PendingMissReason,
  type TextCaptureClient,
} from "./text-capture-store.js";
import { adaptCodexPostToolUse } from "./hook-adapters.js";
import {
  readCodexDecisions,
  readLastDecisionTurn,
  readLastAssistantText,
  type CodexTranscriptDecision,
  type DecisionTurnExcerpt,
} from "./transcript-tail.js";

interface CaptureAuditRecorder {
  record(input: CaptureAuditRecordInput): Promise<unknown>;
}

/**
 * A prompt the client wrote itself, in the tags it wraps them in: a background task's notice, a command and its
 * output. Any prompt that began with "<" counted, and the reader's own JSX or HTML held the question too.
 */
const CLIENT_PROMPT =
  /^\s*<(?:task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr)>/u;

/** Whether a turn asks the reader to choose, by the rules the app reads a captured turn with. */
const asksReader = (assistantText: string): boolean =>
  new TextDecisionAnalyzer().analyze({ userText: null, assistantText }) !== null;

/**
 * A prompt with nothing waiting for it is how every session starts, so it is
 * not a failure; only a turn that was captured and then lost is one.
 */
const missReceipt = (
  reason: PendingMissReason,
): Pick<CaptureAuditRecordInput, "stage" | "errorCode"> =>
  reason === "absent"
    ? { stage: "user_prompt_unpaired" }
    : {
        stage: "failed",
        errorCode:
          reason === "expired"
            ? "pair_not_found"
            : "pending_unreadable",
      };

interface TextCaptureFallbackOptions {
  store: TextCaptureStore;
  readLastAssistantText?: (
    path: string,
  ) => Promise<string | null>;
  readCodexDecisions?: (
    path: string,
    options: { turnId: string },
  ) => Promise<CodexTranscriptDecision[]>;
  readLastDecisionTurn?: (
    path: string,
  ) => Promise<DecisionTurnExcerpt | null>;
  audit?: CaptureAuditRecorder;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

const asObject = (
  value: unknown,
): Record<string, unknown> | null =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (
  object: Record<string, unknown>,
  key: string,
  maximum: number,
): string | null => {
  const value = object[key];
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximum
    ? value.trim()
    : null;
};

const boundedText = (
  value: unknown,
  maximum: number,
  edge: "start" | "end",
): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Cut on a whole character: half an emoji was written into the note as U+FFFD.
  return edge === "start"
    ? clipText(trimmed, maximum)
    : clipTextEnd(trimmed, maximum);
};

const pairFingerprint = (
  client: TextCaptureClient,
  sessionId: string,
  assistantTurnId: string | undefined,
  userTurnId: string | undefined,
  assistantText: string,
  userText: string,
): string =>
  createHash("sha256")
    .update(
      [
        client,
        sessionId,
        assistantTurnId ?? "stop",
        userTurnId ?? "prompt",
        assistantText,
        userText,
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex");

const contextFromTurn = (
  turn: DecisionTurnExcerpt | null,
) => {
  const taskBackground = boundedText(
    turn?.userText,
    4_000,
    "start",
  );
  if (taskBackground === null) {
    return undefined;
  }
  return capturedDecisionContextSchema.parse({
    taskBackground,
    ...(turn?.userText !== null &&
    turn?.userText !== undefined &&
    turn.userText.trim().length > taskBackground.length
      ? { truncated: true }
      : {}),
  });
};

export class TextCaptureFallback {
  readonly #store: TextCaptureStore;
  readonly #readLastAssistantText: (
    path: string,
  ) => Promise<string | null>;
  readonly #readCodexDecisions: (
    path: string,
    options: { turnId: string },
  ) => Promise<CodexTranscriptDecision[]>;
  readonly #readLastDecisionTurn: (
    path: string,
  ) => Promise<DecisionTurnExcerpt | null>;
  readonly #audit: CaptureAuditRecorder | undefined;
  readonly #now: () => Date;

  constructor(options: TextCaptureFallbackOptions) {
    this.#store = options.store;
    this.#readLastAssistantText =
      options.readLastAssistantText ?? readLastAssistantText;
    this.#readCodexDecisions =
      options.readCodexDecisions ?? readCodexDecisions;
    this.#readLastDecisionTurn =
      options.readLastDecisionTurn ?? readLastDecisionTurn;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  async onStop(
    input: unknown,
    client: TextCaptureClient,
  ): Promise<CapturedDecisionEvent[]> {
    const object = asObject(input);
    if (object === null) {
      return [];
    }
    const sessionId = text(object, "session_id", 500);
    const cwd = text(object, "cwd", 2_000);
    const turnId = text(object, "turn_id", 500);
    if (sessionId === null || cwd === null) {
      if (sessionId !== null) {
        await this.#record({
          sourceClient: client,
          sessionId,
          ...(turnId === null ? {} : { turnId }),
          stage: "stop_cwd_missing",
        });
      }
      return [];
    }
    const events: CapturedDecisionEvent[] = [];
    const transcriptPath = text(
      object,
      "transcript_path",
      4_000,
    );
    if (
      client === "codex" &&
      turnId !== null &&
      transcriptPath !== null
    ) {
      const nativeDecisions = await this.#readCodexDecisions(
        transcriptPath,
        { turnId },
      );
      for (const nativeDecision of nativeDecisions) {
        // One call that cannot be read is that call's loss: the others in the turn, and the text pair
        // this Stop saves below, still go through.
        let event: CapturedDecisionEvent | null = null;
        try {
          event = adaptCodexPostToolUse(
            {
              session_id: sessionId,
              turn_id: nativeDecision.turnId,
              cwd,
              tool_use_id: nativeDecision.toolUseId,
              tool_name: "request_user_input",
              tool_input: nativeDecision.toolInput,
              tool_response: nativeDecision.toolResponse,
            },
            this.#now,
          );
        } catch {
          continue;
        }
        if (event !== null) {
          events.push(event);
        }
      }
    }

    const direct = boundedText(
      object.last_assistant_message,
      8_000,
      "end",
    );
    const turn =
      direct !== null || transcriptPath === null
        ? null
        : await this.#readLastDecisionTurn(transcriptPath);
    const transcriptMessage =
      direct !== null
        ? null
        : turn?.assistantText ??
          (transcriptPath === null
            ? null
            : await this.#readLastAssistantText(transcriptPath));
    const assistantText =
      direct ??
      boundedText(transcriptMessage, 8_000, "end");
    if (assistantText === null) {
      await this.#record({
        sourceClient: client,
        sessionId,
        ...(turnId === null ? {} : { turnId }),
        stage: "failed",
        errorCode: "assistant_text_unavailable",
      });
      return events;
    }
    await this.#record({
      sourceClient: client,
      sessionId,
      ...(turnId === null ? {} : { turnId }),
      stage: "assistant_text_resolved",
      textSource:
        direct === null ? "transcript_tail" : "hook_payload",
    });
    try {
      const context = direct === null
        ? contextFromTurn(turn)
        : undefined;
      await this.#store.save({
        version: 3,
        sourceClient: client,
        sessionId,
        ...(turnId === null ? {} : { turnId }),
        cwd,
        assistantText,
        ...(context === undefined ? {} : { context }),
        capturedAt: this.#now().toISOString(),
        // A notice's reply that asks something itself is the question the reader answers next: skipped, the
        // answer went to the turn before the notice and the decision was lost.
      }, { asks: asksReader(assistantText) });
    } catch {
      await this.#record({
        sourceClient: client,
        sessionId,
        ...(turnId === null ? {} : { turnId }),
        stage: "failed",
        errorCode: "pending_write_failed",
      });
      // The text pairing is lost with its pending file; the native decisions already read are not, and
      // thrown, they went with it (a full disk, a folder left owned by root after a sudo run).
      return events;
    }
    await this.#record({
      sourceClient: client,
      sessionId,
      ...(turnId === null ? {} : { turnId }),
      stage: "pending_saved",
    });
    return events;
  }

  async onUserPrompt(
    input: unknown,
    client: TextCaptureClient,
  ): Promise<SemanticDecisionPair | null> {
    const object = asObject(input);
    if (object === null) {
      return null;
    }
    const sessionId = text(object, "session_id", 500);
    const userText = boundedText(
      object.prompt,
      2_000,
      "start",
    );
    const userTurnId = text(object, "turn_id", 500);
    if (sessionId === null || userText === null) {
      if (sessionId !== null) {
        await this.#record({
          sourceClient: client,
          sessionId,
          ...(userTurnId === null
            ? {}
            : { turnId: userTurnId }),
          stage: "prompt_text_missing",
        });
      }
      return null;
    }
    // A prompt the client wrote itself (a background task's notice, a command's output) arrives as the
    // reader's, wrapped in a tag. Paired, it took the question's place, and the reader's real answer after it
    // went unpaired. So did the model's reply to it, ending the turn as a question does: the question is held
    // through that turn, unless the reply asks something itself.
    if (CLIENT_PROMPT.test(userText)) {
      await this.#store.hold(client, sessionId).catch(() => undefined);
      return null;
    }
    const consumed = await this.#store.consume(
      client,
      sessionId,
    );
    if (consumed.pending === null) {
      await this.#record({
        sourceClient: client,
        sessionId,
        ...(userTurnId === null
          ? {}
          : { turnId: userTurnId }),
        ...missReceipt(consumed.reason),
      });
      return null;
    }
    const pending = consumed.pending;
    await this.#record({
      sourceClient: client,
      sessionId,
      ...(userTurnId === null
        ? {}
        : { turnId: userTurnId }),
      stage: "user_prompt_matched",
    });
    const capturedAt = this.#now();
    const cwd =
      text(object, "cwd", 2_000) ?? pending.cwd;
    return semanticDecisionPairSchema.parse({
      version: 1,
      pairId: pairFingerprint(
        client,
        sessionId,
        pending.turnId,
        userTurnId ?? undefined,
        pending.assistantText,
        userText,
      ),
      sourceClient: client,
      sessionId,
      ...(pending.turnId === undefined
        ? {}
        : { assistantTurnId: pending.turnId }),
      ...(userTurnId === null
        ? {}
        : { userTurnId }),
      cwd,
      assistantText: pending.assistantText,
      userText,
      ...(pending.context === undefined
        ? {}
        : { context: pending.context }),
      capturedAt: capturedAt.toISOString(),
      expiresAt: new Date(
        capturedAt.getTime() + 7 * DAY_MS,
      ).toISOString(),
    });
  }

  async #record(
    input: CaptureAuditRecordInput,
  ): Promise<void> {
    await this.#audit?.record(input).catch(() => undefined);
  }
}
