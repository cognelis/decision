import {
  TextDecisionAnalyzer,
  isCompletedDecisionStatus,
  routeSemanticDecision,
  ruleReading,
  stripRecommendationMarker,
  validateSemanticClassification,
  type CompletedDecisionAnalysis,
} from "@cognelis/decision-core";
import {
  capturedDecisionCandidateSchema,
  capturedDecisionEventSchema,
  type CapturedAnswer,
  type CapturedDecisionCandidate,
  type CapturedDecisionEvent,
  type CaptureAuditErrorCode,
  type SemanticBand,
  type SemanticDecisionPair,
  type SemanticModelBand,
} from "@cognelis/decision-protocol";
import type {
  CaptureAuditRecordInput,
} from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import { decisionProjectFor } from "@cognelis/decision-integrations";

import type {
  SemanticClassificationService,
  SemanticClassifierInput,
} from "./semantic-classifier.js";

/** What the rules saw the reply do instead of taking an option, whatever it names. */
const TAKES_NO_OPTION = new Set([
  "answer_defers_decision",
  "answer_is_question",
  "answer_is_acknowledgement",
  "answer_only_evaluates",
  "answer_only_requests_information",
  "answer_has_no_commitment",
  "answer_describes_current_state",
  "answer_is_status_update",
  "unrelated_new_task",
]);

const labelKey = (value: string): string => stripRecommendationMarker(value).replace(/\s+/gu, " ").trim().replace(/[.。!！]+$/u, "");
const withoutOptionId = (label: string, id?: string): string => id === undefined ? label : label.replace(new RegExp(`^\\s*${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:[.)、:：]\\s*|\\s+[—–-]{1,2}\\s+)`, "u"), "");
const literalSelection = (reply: string, options: { id?: string; label: string }[]) => {
  const matchesFor = (token: string) => {
    const ids = options.filter((option) => option.id !== undefined && option.id.toLowerCase() === token.toLowerCase());
    return ids.length > 0 ? ids : options.filter((option) => labelKey(token) !== "" && labelKey(option.label) === labelKey(token));
  };
  const text = reply.trim().replace(/[.。!！]+$/u, "");
  const whole = matchesFor(text);
  if (whole.length > 0) return whole.length === 1 ? whole : null;
  const exclusion = /^all except\s+(.+)$/iu.exec(text);
  const remaining = exclusion?.[1] ?? text;
  const single = matchesFor(remaining);
  if (single.length > 1) return null;
  // Split only identifiers: separators can also belong to a compound label.
  const selected = single.length === 1 ? single : remaining.split(/\s*(?:[,，、]|\band\b|和)\s*/iu).map((token) => {
    const matches = options.filter(option => option.id?.toLowerCase() === token.toLowerCase());
    return matches.length === 1 ? matches[0]! : null;
  });
  if (selected.every((option) => option !== null)) return exclusion ? options.filter(option => !selected.includes(option)) : [...new Set(selected)];
  return null;
};

const answerFor = (
  reply: string,
  options: { id?: string; label: string }[],
  rule: CompletedDecisionAnalysis | null,
  model: ReturnType<typeof validateSemanticClassification> | null,
): { answer: CapturedAnswer; review: boolean } => {
  const original = { kind: "custom" as const, values: [reply] };
  if (rule !== null && options !== rule.options && rule.selected.length === 0 && rule.signals.some((signal) => TAKES_NO_OPTION.has(signal))) return { answer: original, review: true };
  let taken = literalSelection(reply, options);
  if (taken === null) {
    if (model !== null && (model.answerRelation === "uncertain" || model.answerRelation === "new_task")) return { answer: original, review: true };
    if (model?.selectedOptionIndices === undefined) return { answer: original, review: (rule?.selected.length ?? 0) > 0 };
    if (model.band === "low" || !model.selectionValid || ((rule?.selected.length ?? 0) === 0 && rule?.signals.some((signal) => TAKES_NO_OPTION.has(signal)))) return { answer: original, review: true };
    const matched = model.selectedOptionIndices.map((index) => {
      const selected = model.optionLabels[index - 1]!;
      const candidates = options.filter((option) => {
        const bare = withoutOptionId(selected, option.id);
        return labelKey(bare) !== "" && labelKey(bare) === labelKey(option.label);
      });
      return candidates.length === 1 ? candidates[0]! : null;
    });
    if (matched.some((option) => option === null)) return { answer: original, review: true };
    taken = [...new Set(matched.filter((option) => option !== null))];
    if ((rule?.selected.length ?? 0) > 0 && (rule!.selected.length !== taken.length || rule!.selected.some((option) => !taken!.some((chosen) => chosen.label === option.label)))) return { answer: original, review: true };
  }
  if (taken.length === 0) {
    return { answer: original, review: (rule?.selected.length ?? 0) > 0 };
  }
  const labels = taken.map((option) => option.label);
  const answer: CapturedAnswer = taken.length === 1
    ? { kind: "preset", values: [labels[0] as string], reply }
    : { kind: "multiple", values: labels.slice(0, 8), reply };
  return { answer, review: false };
};

interface SemanticRuntimeLike {
  ingest(event: CapturedDecisionEvent): Promise<unknown>;
  ingestCandidate(
    candidate: CapturedDecisionCandidate,
  ): Promise<void>;
}

interface CaptureAuditLike {
  record(input: CaptureAuditRecordInput): Promise<unknown>;
}

interface SemanticDecisionCoordinatorOptions {
  runtime: SemanticRuntimeLike;
  audit: CaptureAuditLike;
  classifier?: SemanticClassificationService;
  /**
   * Whether a model is asked at all. Off only when the reader chose the rules
   * alone; by default the classifier is held to this machine's Qwen 4B, which
   * the gateway enforces (IMP-153), since this is the one model caller that
   * runs on every turn without the reader asking. False too, on that default,
   * while the model is not there to ask (IMP-153): no failure, as for the rules.
   */
  modelEnabled?: () => boolean | Promise<boolean>;
  analyzer?: TextDecisionAnalyzer;
  now?: () => Date;
  timeoutMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
// A cold Qwen checks and loads its model (26 s measured) before the 15 s its classification is allowed.
const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 60_000;

/**
 * Out of time, by the backend's own timer (`code`) or as the gateway sums up a chain whose last tried backend timed
 * out (`failureCode`).
 */
const timedOutError = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  ((error as { code?: unknown }).code === "timeout" ||
    (error as { failureCode?: unknown }).failureCode === "timeout");

const uniqueSignals = (signals: string[]): string[] =>
  [...new Set(signals)].slice(0, 32);

const candidateId = (pairId: string): string =>
  createHash("sha256")
    .update(`semantic-candidate\u0000${pairId}`, "utf8")
    .digest("hex");

const fallbackQuestion = (assistantText: string): string => {
  const paragraphs = assistantText
    .split(/\n{2,}/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return (paragraphs.at(-1) ?? assistantText)
    .trim()
    .slice(0, 4_000);
};

const scoreForBand = (
  band: SemanticBand,
  ruleScore: number,
  modelConfidence: number,
): number => {
  const score = Math.max(
    ruleScore,
    Math.round(modelConfidence * 100),
  );
  if (band === "high") {
    return Math.max(75, score);
  }
  if (band === "medium") {
    return Math.max(50, Math.min(74, score));
  }
  return Math.min(49, score);
};

export class SemanticDecisionCoordinator {
  readonly #runtime: SemanticRuntimeLike;
  readonly #audit: CaptureAuditLike;
  readonly #classifier:
    | SemanticClassificationService
    | undefined;
  readonly #modelEnabled: () => boolean | Promise<boolean>;
  readonly #analyzer: TextDecisionAnalyzer;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  #closed = false;

  constructor(options: SemanticDecisionCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#audit = options.audit;
    this.#classifier = options.classifier;
    this.#modelEnabled = options.modelEnabled ?? (() => true);
    this.#analyzer =
      options.analyzer ?? new TextDecisionAnalyzer();
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs =
      options.timeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs < 1
    ) {
      throw new Error(
        "Semantic classification timeout must be a positive integer",
      );
    }
  }

  async process(
    pair: SemanticDecisionPair,
  ): Promise<"processed" | "deferred"> {
    const started = performance.now();
    const pending = this.#analyzer.analyze({
      userText: pair.context?.taskBackground ?? null,
      assistantText: pair.assistantText,
    });
    // A question the rules found only past a closing, read low, is no reading at all:
    // the rules alone had none there, and the model's reading stands as it would.
    const rule = ruleReading(pending === null
      ? null
      : this.#analyzer.complete(pending, pair.userText));
    const ruleBand: SemanticBand = rule?.band ?? "low";
    const ruleScore = rule?.score ?? 0;
    const completedStatus = isCompletedDecisionStatus(pair.userText);
    const answered = completedStatus ? null : await this.#classify(pair, rule?.options ?? []);
    // Cut short by quit, which aborts every model call: left in the spool, the pair is read again at the next
    // start, model and all, rather than by the rules alone now and never by the model.
    if (this.#closed) return "deferred";
    const model = answered === "timeout" ? null : answered;
    const modelBand: SemanticModelBand =
      model?.band ?? "unavailable";
    const route = routeSemanticDecision({
      ruleBand,
      ruleScore,
      modelBand,
      answerRelation: model?.answerRelation ?? null,
      ruleSignals: completedStatus ? ["answer_is_status_update"] : rule?.signals ?? [],
      ...(model === null ? {} : { modelIntent: model.decisionIntent }),
      ...(answered === "timeout" ? { modelTimedOut: true } : {}),
      userText: pair.userText,
      pairAgeMs: Math.max(
        0,
        this.#now().getTime() - Date.parse(pair.capturedAt),
      ),
    });
    let finalBand = route.finalBand;
    try {
      const event = route.finalBand === "low" ? null : this.#event(
          pair,
          await decisionProjectFor(pair.cwd),
          rule,
          model,
          route.finalBand,
          ruleScore,
          route.detectorVersion,
          uniqueSignals([
            ...(rule?.signals ?? []),
            ...route.signals,
          ]),
        );
      finalBand = event?.detection?.band ?? route.finalBand;
      await this.#record(pair, { stage: "classification_completed", ruleBand, modelBand, finalBand, durationMs: Math.round(performance.now() - started) });
      if (event !== null) {
        if (finalBand === "high") {
          await this.#runtime.ingest(event);
        } else {
          await this.#runtime.ingestCandidate(
            capturedDecisionCandidateSchema.parse({
              candidateVersion: 1,
              candidateId: candidateId(pair.pairId),
              createdAt: this.#now().toISOString(),
              expiresAt: new Date(
                this.#now().getTime() + 7 * DAY_MS,
              ).toISOString(),
              event,
            }),
          );
        }
      }
      await this.#record(pair, {
        stage: "routed",
        ruleBand,
        modelBand,
        finalBand,
      });
      return "processed";
    } catch (error) {
      await this.#record(pair, {
        stage: "failed",
        ruleBand,
        modelBand,
        finalBand,
        errorCode: "routing_failed",
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#classifier?.close?.();
  }

  /** The model's reading, `null` when none was asked or it could not answer, `"timeout"` when it ran out of time. */
  async #classify(pair: SemanticDecisionPair, options: CompletedDecisionAnalysis["options"]) {
    // Not an error and not a failure to record: nothing was asked of a model,
    // so the route reads `unavailable` and the rules answer on their own.
    // Not known to be there to ask (the profiles unreadable, the app closing): the rules answer, as when not there.
    if (this.#classifier === undefined || !(await Promise.resolve().then(this.#modelEnabled).catch(() => false))) {
      return null;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const input: SemanticClassifierInput = {
        pairId: pair.pairId,
        assistantText: pair.assistantText,
        userText: pair.userText,
        ...(options.length === 0 ? {} : { selectionOptions: options }),
        locale: /[\p{Script=Han}]/u.test(
          `${pair.assistantText}${pair.userText}`,
        )
          ? "zh-CN"
          : "en",
      };
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          // Said to be a timeout, the model call is filed as one, as the audit files it: not as stopped.
          controller.abort(new DOMException("Semantic classification timed out", "TimeoutError"));
          reject(new Error("Semantic classification timed out"));
        }, this.#timeoutMs);
        timeout.unref();
      });
      const output = await Promise.race([
        this.#classifier.classify(
          input,
          controller.signal,
          {
            sourceClient: pair.sourceClient,
            sessionId: pair.sessionId,
            ...(pair.userTurnId === undefined
              ? {}
              : { turnId: pair.userTurnId }),
          },
        ),
        timeoutPromise,
      ]);
      if (options.length > 0 && output.selectedOptionIndices !== undefined) {
        // Indices refer to the supplied list; a conflicting re-extraction must not silently change their meaning.
        const sameOrder = output.optionLabels.length === 0 || (output.optionLabels.length === options.length && output.optionLabels.every((label, index) => labelKey(withoutOptionId(label, options[index]!.id)) === labelKey(options[index]!.label)));
        const optionLabels = options.map(option => option.label);
        const validated = validateSemanticClassification(pair, { ...output, optionLabels }, optionLabels);
        return sameOrder ? validated : { ...validated, selectionValid: false };
      }
      return validateSemanticClassification(pair, output);
    } catch (error) {
      // A quit is not the model's failure.
      if (this.#closed) return null;
      const timedOut = controller.signal.aborted || timedOutError(error);
      const errorCode: CaptureAuditErrorCode =
        timedOut
          ? "classification_timeout"
          : error instanceof Error &&
              error.name === "ZodError"
            ? "provider_invalid_output"
            : this.#providerErrorCode(error);
      await this.#record(pair, {
        stage: "failed",
        errorCode,
      });
      return timedOut ? "timeout" as const : null;
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  #providerErrorCode(
    error: unknown,
  ): CaptureAuditErrorCode {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error
    ) {
      const code = (error as { code?: unknown }).code;
      if (
        code === "provider_invalid_output" ||
        code === "provider_unavailable" ||
        code === "model_missing" ||
        code === "checksum_failed" ||
        code === "runtime_unavailable" ||
        code === "helper_missing" ||
        code === "helper_crashed"
      ) {
        return code;
      }
    }
    return "provider_unavailable";
  }

  #event(
    pair: SemanticDecisionPair,
    // The repository's name, as search resolves it: a worktree or a subdirectory is the same project.
    project: string,
    rule: CompletedDecisionAnalysis | null,
    model: ReturnType<
      typeof validateSemanticClassification
    > | null,
    band: Exclude<SemanticBand, "low">,
    ruleScore: number,
    detectorVersion: string,
    signals: string[],
  ): CapturedDecisionEvent {
    /*
     * A model that read the exchange as "no decision here" has no standing to
     * say what the decision was: the same reading produced its band, and the
     * band was rejected. The rules lead in any case — they quote whole
     * paragraphs of the message and can be checked against it — and the model
     * only fills what they left empty.
     */
    const extraction = model === null || model.band === "low" ? null : model;
    const question =
      rule?.question ??
      extraction?.question ??
      fallbackQuestion(pair.assistantText);
    const options =
      (rule?.options.length ?? 0) > 0
        ? rule!.options
        : (extraction?.optionLabels ?? []).map((label) => ({ label }));
    const context = rule?.context ?? pair.context;
    const resolved = answerFor(pair.userText, options, rule, model);
    const answer = resolved.answer;
    if (resolved.review) {
      band = "medium";
      signals = uniqueSignals([...signals, "selection_not_verified"]);
    }
    return capturedDecisionEventSchema.parse({
      eventVersion: 1,
      captureMode: "transcript",
      sourceClient: pair.sourceClient,
      sessionId: pair.sessionId,
      ...(pair.userTurnId === undefined
        ? {}
        : { turnId: pair.userTurnId }),
      sourceEventId:
        `${pair.assistantTurnId ?? "stop"}:` +
        `${pair.userTurnId ?? "prompt"}`,
      batchId:
        `${pair.sourceClient}:${pair.sessionId}:semantic:${pair.pairId}`,
      project,
      cwd: pair.cwd,
      capturedAt: pair.capturedAt,
      ...(context === undefined
        ? {}
        : { context }),
      detection: {
        band,
        score: scoreForBand(
          band,
          ruleScore,
          model?.confidence ?? 0,
        ),
        detectorVersion,
        signals,
      },
      questions: [
        {
          questionIndex: 0,
          question,
          options,
          answer,
          multiSelect: answer.kind === "multiple",
        },
      ],
    });
  }

  async #record(
    pair: SemanticDecisionPair,
    input: Omit<
      CaptureAuditRecordInput,
      "sourceClient" | "sessionId" | "turnId"
    >,
  ): Promise<void> {
    await this.#audit
      .record({
        sourceClient: pair.sourceClient,
        sessionId: pair.sessionId,
        ...(pair.userTurnId === undefined
          ? {}
          : { turnId: pair.userTurnId }),
        ...input,
      })
      .catch(() => undefined);
  }
}
