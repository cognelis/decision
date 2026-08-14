import {
  TextDecisionAnalyzer,
  routeSemanticDecision,
  validateSemanticClassification,
  type CompletedDecisionAnalysis,
} from "@cognelis/decision-core";
import {
  capturedDecisionCandidateSchema,
  capturedDecisionEventSchema,
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
import { basename } from "node:path";

import type {
  SemanticClassificationService,
  SemanticClassifierInput,
} from "./semantic-classifier.js";

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
  analyzer?: TextDecisionAnalyzer;
  now?: () => Date;
  timeoutMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 30_000;

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
  readonly #analyzer: TextDecisionAnalyzer;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  #closed = false;

  constructor(options: SemanticDecisionCoordinatorOptions) {
    this.#runtime = options.runtime;
    this.#audit = options.audit;
    this.#classifier = options.classifier;
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
  ): Promise<"processed"> {
    const started = performance.now();
    const pending = this.#analyzer.analyze({
      userText: pair.context?.taskBackground ?? null,
      assistantText: pair.assistantText,
    });
    const rule = pending === null
      ? null
      : this.#analyzer.complete(pending, pair.userText);
    const ruleBand: SemanticBand = rule?.band ?? "low";
    const ruleScore = rule?.score ?? 0;
    const model = await this.#classify(pair);
    const modelBand: SemanticModelBand =
      model?.band ?? "unavailable";
    const route = routeSemanticDecision({
      ruleBand,
      ruleScore,
      modelBand,
      answerRelation: model?.answerRelation ?? null,
      pairAgeMs: Math.max(
        0,
        this.#now().getTime() - Date.parse(pair.capturedAt),
      ),
    });
    await this.#record(pair, {
      stage: "classification_completed",
      ruleBand,
      modelBand,
      finalBand: route.finalBand,
      durationMs: Math.round(performance.now() - started),
    });

    try {
      if (route.finalBand !== "low") {
        const event = this.#event(
          pair,
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
        if (route.finalBand === "high") {
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
        finalBand: route.finalBand,
      });
      return "processed";
    } catch (error) {
      await this.#record(pair, {
        stage: "failed",
        ruleBand,
        modelBand,
        finalBand: route.finalBand,
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

  async #classify(pair: SemanticDecisionPair) {
    if (this.#classifier === undefined) {
      return null;
    }
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const input: SemanticClassifierInput = {
        pairId: pair.pairId,
        assistantText: pair.assistantText,
        userText: pair.userText,
        locale: /[\p{Script=Han}]/u.test(
          `${pair.assistantText}${pair.userText}`,
        )
          ? "zh-CN"
          : "en",
      };
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
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
      return validateSemanticClassification(pair, output);
    } catch (error) {
      const errorCode: CaptureAuditErrorCode =
        controller.signal.aborted
          ? "classification_timeout"
          : error instanceof Error &&
              error.name === "ZodError"
            ? "provider_invalid_output"
            : this.#providerErrorCode(error);
      await this.#record(pair, {
        stage: "failed",
        errorCode,
      });
      return null;
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
    rule: CompletedDecisionAnalysis | null,
    model: ReturnType<
      typeof validateSemanticClassification
    > | null,
    band: Exclude<SemanticBand, "low">,
    ruleScore: number,
    detectorVersion: string,
    signals: string[],
  ): CapturedDecisionEvent {
    const question =
      model?.question ??
      rule?.question ??
      fallbackQuestion(pair.assistantText);
    const options =
      (rule?.options.length ?? 0) > 0
        ? rule!.options
        : (model?.optionLabels ?? []).map((label) => ({ label }));
    const context = rule?.context ?? pair.context;
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
      project: basename(pair.cwd),
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
          answer: {
            kind: "custom",
            values: [pair.userText],
          },
          multiSelect: false,
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
