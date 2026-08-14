import type {
  CaptureAuditRecordInput,
} from "@cognelis/decision-storage";
import {
  capturedDecisionContextSchema,
  semanticDecisionPairSchema,
  type CapturedDecisionEvent,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { createHash } from "node:crypto";

import {
  TextCaptureStore,
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
  if (trimmed.length <= maximum) {
    return trimmed;
  }
  return edge === "start"
    ? trimmed.slice(0, maximum)
    : trimmed.slice(-maximum);
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
    if (sessionId === null || cwd === null) {
      return [];
    }
    const events: CapturedDecisionEvent[] = [];
    const turnId = text(object, "turn_id", 500);
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
        const event = adaptCodexPostToolUse(
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
      });
    } catch (error) {
      await this.#record({
        sourceClient: client,
        sessionId,
        ...(turnId === null ? {} : { turnId }),
        stage: "failed",
        errorCode: "pending_write_failed",
      });
      throw error;
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
    if (sessionId === null || userText === null) {
      return null;
    }
    const userTurnId = text(object, "turn_id", 500);
    const pending = await this.#store.consume(client, sessionId);
    if (pending === null) {
      await this.#record({
        sourceClient: client,
        sessionId,
        ...(userTurnId === null
          ? {}
          : { turnId: userTurnId }),
        stage: "failed",
        errorCode: "pair_not_found",
      });
      return null;
    }
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
