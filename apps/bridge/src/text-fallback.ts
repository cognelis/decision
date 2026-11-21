import { answersNumbersNotAsked, TextDecisionAnalyzer } from "@cognelis/decision-core";
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
import { clientById, type ClientDescriptor } from "@cognelis/decision-integrations";
import { createHash } from "node:crypto";

import {
  TextCaptureStore,
  type PendingMissReason,
  type TextCaptureClient,
} from "./text-capture-store.js";
import { adaptCodexPostToolUse } from "./hook-adapters.js";
import {
  readCodexDecisions,
  readEarlierDecisionTurns,
  readLastDecisionTurn,
  readLastAssistantText,
  type CodexTranscriptDecision,
  type DecisionTurnExcerpt,
  type TranscriptFormat,
} from "./transcript-tail.js";

interface CaptureAuditRecorder {
  record(input: CaptureAuditRecordInput): Promise<unknown>;
}

/**
 * A prompt the client wrote itself, in the tags it wraps them in: a background task's notice, a command and its
 * output, an agent's report handed back, another session's message. Any prompt that began with "<" counted, and the
 * reader's own JSX or HTML held the question too. A background agent's report reaches the hook (Claude Code 2.1.304)
 * as <agent-message from="…">, which none of these tags matched: paired as the reader's answer. So does an
 * autonomous /loop's firing, under the headings its sentinel resolves to before the hook runs (the loop's
 * instructions, then a tick's reminder, or a loop.md's tasks), and the scheduler's notice of a one-shot task it missed.
 * So does a Codex automation's <heartbeat>, the envelope its scheduler submits as input (codex-rs history/src/heartbeat.rs).
 */
const CLIENT_PROMPT =
  /^\s*(?:<(?:task-notification|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr|system-reminder|heartbeat)>|<(?:agent-message|cross-session-message|teammate-message)[\s>]|# Autonomous loop (?:check|tick)\b|# \/loop tick \u2014 |The following one-shot scheduled tasks? (?:was|were) missed while Claude was not running\.)/u;

/** Reminders an app on the SDK puts before what its reader typed, joined to it in one prompt. */
const LEADING_REMINDERS = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+/u;

/** The state of its own browser, which the Codex app puts before what its reader typed. */
const LEADING_BROWSER_CONTEXT = /^\s*<in-app-browser-context[\s>][\s\S]*?<\/in-app-browser-context>/u;

/**
 * What Codex puts before the reader's request, and the heading it puts the request under: the IDE's context (as
 * codex-rs tui/src/ide_context/prompt.rs writes it, in the app's format), the files the reader mentioned. The request
 * is what follows the last such heading, as Codex reads it back itself; the app also writes the heading as
 * "## My request:".
 */
const REQUEST_PREAMBLE = /^\s*(?:# Context from my IDE setup:|# Files mentioned by the user:|## My request(?: for Codex)?:)/u;
const REQUEST_HEADING = /^## My request(?: for Codex)?:[ \t]*$/gmu;

/** What the reader typed, without what the client joined to it in the same prompt. */
const typedPrompt = (prompt: string): string => {
  const text = prompt.replace(LEADING_REMINDERS, "").replace(LEADING_BROWSER_CONTEXT, "");
  const heading = REQUEST_PREAMBLE.test(text) ? [...text.matchAll(REQUEST_HEADING)].at(-1) : undefined;
  return heading === undefined ? text : text.slice(heading.index + heading[0].length);
};

/**
 * Who Claude Code says wrote the prompt, where it says (`source`, not sent yet by 2.1.304): a /loop wakeup or a
 * schedule firing repeats a configured prompt as plain text, and only this tells it apart. `sdk` is not among them:
 * an app on the SDK sends what its reader typed.
 */
const INJECTED_SOURCES = new Set(["system", "loop_wakeup", "schedule_wakeup", "poll_event"]);

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
    options: { format?: TranscriptFormat },
  ) => Promise<string | null>;
  readCodexDecisions?: (
    path: string,
    options: { turnId: string },
  ) => Promise<CodexTranscriptDecision[]>;
  readLastDecisionTurn?: (
    path: string,
    options: { format?: TranscriptFormat },
  ) => Promise<DecisionTurnExcerpt | null>;
  readEarlierDecisionTurns?: (
    path: string,
    options: { format?: TranscriptFormat; maximumBytes?: number },
  ) => Promise<DecisionTurnExcerpt[]>;
  audit?: CaptureAuditRecorder;
  now?: () => Date;
  /** A client by its id, one the reader added among them; the built-in registry unless said. */
  describe?: (id: string) => ClientDescriptor | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/** How many turns back a numbered reply's question is looked for, and in how much of the transcript. */
const EARLIER_QUESTION_TURNS = 5;
const EARLIER_QUESTION_BYTES = 512 * 1_024;

/** A turn's reply with no text, as Qwen Code (`getLastModelMessageText() || '[no response text]'`) and Gemini CLI send it. */
const NO_RESPONSE_TEXT = "[no response text]";

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
  // What the reader typed, as an answer is read: the prompt in the transcript has what the client joined to it too.
  const typed =
    turn?.userText === null || turn?.userText === undefined
      ? null
      : typedPrompt(turn.userText);
  const taskBackground = boundedText(
    typed,
    4_000,
    "start",
  );
  if (taskBackground === null) {
    return undefined;
  }
  return capturedDecisionContextSchema.parse({
    taskBackground,
    ...(typed !== null &&
    typed.trim().length > taskBackground.length
      ? { truncated: true }
      : {}),
  });
};

export class TextCaptureFallback {
  readonly #store: TextCaptureStore;
  readonly #readLastAssistantText: (
    path: string,
    options: { format?: TranscriptFormat },
  ) => Promise<string | null>;
  readonly #readCodexDecisions: (
    path: string,
    options: { turnId: string },
  ) => Promise<CodexTranscriptDecision[]>;
  readonly #readLastDecisionTurn: (
    path: string,
    options: { format?: TranscriptFormat },
  ) => Promise<DecisionTurnExcerpt | null>;
  readonly #readEarlierDecisionTurns: (
    path: string,
    options: { format?: TranscriptFormat; maximumBytes?: number },
  ) => Promise<DecisionTurnExcerpt[]>;
  readonly #audit: CaptureAuditRecorder | undefined;
  readonly #now: () => Date;
  readonly #describe: (id: string) => ClientDescriptor | undefined;

  constructor(options: TextCaptureFallbackOptions) {
    this.#describe = options.describe ?? ((id) => clientById(id));
    this.#store = options.store;
    this.#readLastAssistantText =
      options.readLastAssistantText ?? readLastAssistantText;
    this.#readCodexDecisions =
      options.readCodexDecisions ?? readCodexDecisions;
    this.#readLastDecisionTurn =
      options.readLastDecisionTurn ?? readLastDecisionTurn;
    this.#readEarlierDecisionTurns =
      options.readEarlierDecisionTurns ?? readEarlierDecisionTurns;
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

    const format = this.#describe(client)?.capture.transcript ?? "claude-codex";
    // Qwen Code and Gemini CLI send this in place of a reply that had no text.
    const direct = object.last_assistant_message === NO_RESPONSE_TEXT
      ? null
      : boundedText(
          object.last_assistant_message,
          8_000,
          "end",
        );
    const turn =
      direct !== null || transcriptPath === null
        ? null
        : await this.#readLastDecisionTurn(transcriptPath, { format });
    const transcriptMessage =
      direct !== null
        ? null
        : turn?.assistantText ??
          (transcriptPath === null
            ? null
            : await this.#readLastAssistantText(transcriptPath, { format }));
    const assistantText =
      direct ??
      boundedText(transcriptMessage, 8_000, "end");
    if (assistantText === null) {
      // This turn's reply unread, the one waiting from the turn before is no question for the next answer either.
      if (this.#describe(client)?.capture.dropPendingWithoutReply === true) {
        await this.#store.consume(client, sessionId).catch(() => undefined);
      }
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
    const prompt = boundedText(
      object.prompt,
      2_000,
      "start",
    );
    const userTurnId = text(object, "turn_id", 500);
    // Claude Code sends no turn id; this prompt's own id tells a question answered the same way twice in a session
    // from a replay of the first, which it was dropped as. ponytail: a client sending neither id still names the pair
    // by its text alone; a random id kept with the pending turn if such a client needs it.
    const promptId = text(object, "prompt_id", 500);
    if (sessionId === null || prompt === null) {
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
    // through that turn, unless the reply asks something itself. So is one a subagent fired.
    const userText = boundedText(
      typedPrompt(String(object.prompt)),
      2_000,
      "start",
    );
    const source = text(object, "source", 100);
    if (
      userText === null ||
      CLIENT_PROMPT.test(userText) ||
      (source !== null && INJECTED_SOURCES.has(source)) ||
      text(object, "agent_id", 500) !== null
    ) {
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
    const waiting = consumed.pending;
    const pending = await this.#withAskingTurn(waiting, userText, text(object, "transcript_path", 4_000), client);
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
        userTurnId ?? promptId ?? undefined,
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

  /**
   * "1 直推，2 可以，3 升" paired with the progress report that came after the numbered questions: the turn that asked
   * is taken instead, if the transcript still has it. Not found, the pair goes on as it was, and the rules leave it out.
   */
  async #withAskingTurn<T extends { assistantText: string; context?: unknown }>(
    pending: T,
    userText: string,
    transcriptPath: string | null,
    client: TextCaptureClient,
  ): Promise<T> {
    if (transcriptPath === null || !answersNumbersNotAsked(pending.assistantText, userText)) return pending;
    const turns = await this.#readEarlierDecisionTurns(transcriptPath, {
      format: this.#describe(client)?.capture.transcript ?? "claude-codex",
      maximumBytes: EARLIER_QUESTION_BYTES,
    }).catch(() => []);
    const asking = turns
      .slice(0, EARLIER_QUESTION_TURNS)
      .find((turn) => asksReader(turn.assistantText) && !answersNumbersNotAsked(turn.assistantText, userText));
    if (asking === undefined) return pending;
    const context = contextFromTurn(asking);
    const { context: _replaced, ...rest } = pending;
    return { ...rest, assistantText: asking.assistantText, ...(context === undefined ? {} : { context }) } as T;
  }

  async #record(
    input: CaptureAuditRecordInput,
  ): Promise<void> {
    await this.#audit?.record(input).catch(() => undefined);
  }
}
