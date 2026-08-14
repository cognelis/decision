import {
  DECISION_CONSULTATION_FEEDBACK_VERSION,
  decisionConsultationFeedbackRequestSchema,
  decisionConsultationFeedbackResultSchema,
  decisionConsultationResponseSchema,
  type DecisionConsultationFeedbackRequest,
  type DecisionConsultationFeedbackResult,
  type DecisionConsultationResponse,
} from "@cognelis/decision-protocol";
import { randomUUID } from "node:crypto";

import type {
  DecisionConsultationFeedbackMetricRecord,
  DecisionConsultationMetricsStore,
} from "./decision-consultation-metrics-store.js";

const DEFAULT_RECEIPT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_PENDING_RECEIPTS = 256;

export type DecisionConsultationFeedbackSource =
  | "claude-code"
  | "codex"
  | "preview";

interface PendingFeedbackReceipt {
  source: DecisionConsultationFeedbackSource;
  result: DecisionConsultationFeedbackMetricRecord["result"];
  expiresAtMs: number;
}

interface FeedbackMetricsRecorder {
  recordFeedback(input: DecisionConsultationFeedbackMetricRecord): Promise<void>;
}

interface DecisionConsultationFeedbackServiceOptions {
  metrics: FeedbackMetricsRecorder | DecisionConsultationMetricsStore;
  now?: () => Date;
  tokenFactory?: () => string;
  receiptTtlMs?: number;
  maxPendingReceipts?: number;
}

export class DecisionConsultationFeedbackService {
  readonly #metrics: FeedbackMetricsRecorder;
  readonly #now: () => Date;
  readonly #tokenFactory: () => string;
  readonly #receiptTtlMs: number;
  readonly #maxPendingReceipts: number;
  readonly #pending = new Map<string, PendingFeedbackReceipt>();

  constructor(options: DecisionConsultationFeedbackServiceOptions) {
    this.#metrics = options.metrics;
    this.#now = options.now ?? (() => new Date());
    this.#tokenFactory = options.tokenFactory ?? randomUUID;
    this.#receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.#maxPendingReceipts =
      options.maxPendingReceipts ?? DEFAULT_MAX_PENDING_RECEIPTS;
    if (
      !Number.isInteger(this.#receiptTtlMs) ||
      this.#receiptTtlMs < 1_000 ||
      !Number.isInteger(this.#maxPendingReceipts) ||
      this.#maxPendingReceipts < 1
    ) {
      throw new Error("事前核对匿名反馈配置无效");
    }
  }

  issue(
    input: DecisionConsultationResponse,
    source: DecisionConsultationFeedbackSource,
  ): DecisionConsultationResponse {
    const response = decisionConsultationResponseSchema.parse(input);
    const now = this.#now();
    this.#pruneExpired(now.getTime());
    while (this.#pending.size >= this.#maxPendingReceipts) {
      const oldest = this.#pending.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    const token = this.#tokenFactory();
    if (this.#pending.has(token)) {
      throw new Error("事前核对匿名反馈回执冲突");
    }
    const expiresAtMs = now.getTime() + this.#receiptTtlMs;
    const result =
      response.status === "no_match"
        ? "noMatch"
        : response.matches.some((match) => match.relevance === "strong")
          ? "strong"
          : "possible";
    this.#pending.set(token, { source, result, expiresAtMs });
    return decisionConsultationResponseSchema.parse({
      ...response,
      feedback: {
        token,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    });
  }

  async submit(
    input: DecisionConsultationFeedbackRequest,
  ): Promise<DecisionConsultationFeedbackResult> {
    const request = decisionConsultationFeedbackRequestSchema.parse(input);
    const now = this.#now();
    const pending = this.#pending.get(request.token);
    if (pending === undefined) {
      return this.#result("not_found");
    }
    if (pending.expiresAtMs <= now.getTime()) {
      this.#pending.delete(request.token);
      return this.#result("expired");
    }

    this.#pending.delete(request.token);
    try {
      await this.#metrics.recordFeedback({
        source: pending.source,
        result: pending.result,
        rating: request.rating,
        recordedAt: now.toISOString(),
      });
    } catch (error) {
      if (pending.expiresAtMs > this.#now().getTime()) {
        this.#pending.set(request.token, pending);
      }
      throw error;
    }
    return this.#result("accepted");
  }

  #result(
    status: DecisionConsultationFeedbackResult["status"],
  ): DecisionConsultationFeedbackResult {
    return decisionConsultationFeedbackResultSchema.parse({
      feedbackVersion: DECISION_CONSULTATION_FEEDBACK_VERSION,
      status,
    });
  }

  #pruneExpired(nowMs: number): void {
    for (const [token, pending] of this.#pending) {
      if (pending.expiresAtMs <= nowMs) this.#pending.delete(token);
    }
  }
}
