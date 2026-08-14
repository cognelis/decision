import {
  DECISION_CONSULTATION_METRICS_VERSION,
  decisionConsultationFeedbackRatingSchema,
  decisionConsultationMetricsSnapshotSchema,
  decisionConsultationResponseSchema,
  type DecisionConsultationMetricsPeriod,
  type DecisionConsultationMetricsSnapshot,
  type DecisionConsultationFeedbackRating,
  type DecisionConsultationResponse,
} from "@cognelis/decision-protocol";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MAX_FILE_BYTES = 128 * 1024;
const MAX_RECENT_DAYS = 30;

export interface DecisionConsultationMetricRecord {
  sourceClient: "claude-code" | "codex";
  response: DecisionConsultationResponse;
  durationMs: number;
  recordedAt: string;
}

export interface DecisionConsultationFeedbackMetricRecord {
  source: "claude-code" | "codex" | "preview";
  result: "strong" | "possible" | "noMatch";
  rating: DecisionConsultationFeedbackRating;
  recordedAt: string;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const emptyPeriod = (date: string): DecisionConsultationMetricsPeriod => ({
  date,
  requests: 0,
  matched: 0,
  noMatch: 0,
  matches: 0,
  strongMatches: 0,
  possibleMatches: 0,
  durationMs: 0,
  feedback: {
    total: 0,
    helpful: 0,
    notHelpful: 0,
    misleading: 0,
  },
});

const emptySnapshot = (): DecisionConsultationMetricsSnapshot => ({
  metricsVersion: DECISION_CONSULTATION_METRICS_VERSION,
  requests: 0,
  matched: 0,
  noMatch: 0,
  matches: 0,
  strongMatches: 0,
  possibleMatches: 0,
  durationMs: 0,
  byClient: { claudeCode: 0, codex: 0 },
  feedback: {
    total: 0,
    helpful: 0,
    notHelpful: 0,
    misleading: 0,
    bySource: { claudeCode: 0, codex: 0, preview: 0 },
    byResult: {
      strong: { total: 0, helpful: 0, notHelpful: 0, misleading: 0 },
      possible: { total: 0, helpful: 0, notHelpful: 0, misleading: 0 },
      noMatch: { total: 0, helpful: 0, notHelpful: 0, misleading: 0 },
    },
  },
  recent: [],
  lastConsultedAt: null,
  privacy: {
    storesQuestionText: false,
    storesOptionText: false,
    storesPrincipleIds: false,
    storesFeedbackTokens: false,
    storesIndividualEvents: false,
  },
});

const plus = (value: number, amount: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, value + amount);

const laterDate = (current: string | null, incoming: string): string =>
  current === null || incoming > current ? incoming : current;

export class DecisionConsultationMetricsStore {
  readonly #path: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async snapshot(): Promise<DecisionConsultationMetricsSnapshot> {
    return this.#load();
  }

  async record(input: DecisionConsultationMetricRecord): Promise<void> {
    const response = decisionConsultationResponseSchema.parse(input.response);
    const recordedAt = new Date(input.recordedAt);
    if (
      Number.isNaN(recordedAt.getTime()) ||
      !Number.isInteger(input.durationMs) ||
      input.durationMs < 0 ||
      input.durationMs > 60_000
    ) {
      throw new Error("事前核对聚合指标输入无效");
    }
    const date = recordedAt.toISOString().slice(0, 10);
    const durationMs = input.durationMs;
    const strongMatches = response.matches.filter(
      (match) => match.relevance === "strong",
    ).length;
    const possibleMatches = response.matches.length - strongMatches;

    await this.#exclusive(async () => {
      const snapshot = await this.#load();
      const existing = snapshot.recent.find((period) => period.date === date);
      const period = existing ?? emptyPeriod(date);
      period.requests = plus(period.requests, 1);
      period[response.status === "matched" ? "matched" : "noMatch"] = plus(
        period[response.status === "matched" ? "matched" : "noMatch"],
        1,
      );
      period.matches = plus(period.matches, response.matches.length);
      period.strongMatches = plus(period.strongMatches, strongMatches);
      period.possibleMatches = plus(period.possibleMatches, possibleMatches);
      period.durationMs = plus(period.durationMs, durationMs);

      snapshot.requests = plus(snapshot.requests, 1);
      snapshot[response.status === "matched" ? "matched" : "noMatch"] = plus(
        snapshot[response.status === "matched" ? "matched" : "noMatch"],
        1,
      );
      snapshot.matches = plus(snapshot.matches, response.matches.length);
      snapshot.strongMatches = plus(snapshot.strongMatches, strongMatches);
      snapshot.possibleMatches = plus(snapshot.possibleMatches, possibleMatches);
      snapshot.durationMs = plus(snapshot.durationMs, durationMs);
      snapshot.byClient[
        input.sourceClient === "claude-code" ? "claudeCode" : "codex"
      ] = plus(
        snapshot.byClient[
          input.sourceClient === "claude-code" ? "claudeCode" : "codex"
        ],
        1,
      );
      snapshot.lastConsultedAt = laterDate(
        snapshot.lastConsultedAt,
        recordedAt.toISOString(),
      );
      snapshot.recent = [
        ...snapshot.recent.filter((item) => item.date !== date),
        period,
      ]
        .sort((left, right) => left.date.localeCompare(right.date))
        .slice(-MAX_RECENT_DAYS);
      await this.#write(
        decisionConsultationMetricsSnapshotSchema.parse(snapshot),
      );
    });
  }

  async recordFeedback(
    input: DecisionConsultationFeedbackMetricRecord,
  ): Promise<void> {
    const rating = decisionConsultationFeedbackRatingSchema.parse(input.rating);
    if (!["claude-code", "codex", "preview"].includes(input.source)) {
      throw new Error("事前核对反馈来源无效");
    }
    if (!["strong", "possible", "noMatch"].includes(input.result)) {
      throw new Error("事前核对反馈结果类型无效");
    }
    const recordedAt = new Date(input.recordedAt);
    if (Number.isNaN(recordedAt.getTime())) {
      throw new Error("事前核对反馈时间无效");
    }
    const date = recordedAt.toISOString().slice(0, 10);
    const ratingKey =
      rating === "helpful"
        ? "helpful"
        : rating === "not_helpful"
          ? "notHelpful"
          : "misleading";
    const sourceKey =
      input.source === "claude-code" ? "claudeCode" : input.source;

    await this.#exclusive(async () => {
      const snapshot = await this.#load();
      const existing = snapshot.recent.find((period) => period.date === date);
      const period = existing ?? emptyPeriod(date);
      period.feedback.total = plus(period.feedback.total, 1);
      period.feedback[ratingKey] = plus(period.feedback[ratingKey], 1);
      snapshot.feedback.total = plus(snapshot.feedback.total, 1);
      snapshot.feedback[ratingKey] = plus(snapshot.feedback[ratingKey], 1);
      snapshot.feedback.bySource[sourceKey] = plus(
        snapshot.feedback.bySource[sourceKey],
        1,
      );
      snapshot.feedback.byResult[input.result].total = plus(
        snapshot.feedback.byResult[input.result].total,
        1,
      );
      snapshot.feedback.byResult[input.result][ratingKey] = plus(
        snapshot.feedback.byResult[input.result][ratingKey],
        1,
      );
      snapshot.recent = [
        ...snapshot.recent.filter((item) => item.date !== date),
        period,
      ]
        .sort((left, right) => left.date.localeCompare(right.date))
        .slice(-MAX_RECENT_DAYS);
      await this.#write(
        decisionConsultationMetricsSnapshotSchema.parse(snapshot),
      );
    });
  }

  async #load(): Promise<DecisionConsultationMetricsSnapshot> {
    try {
      const fileStats = await lstat(this.#path);
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        throw new Error("事前核对聚合指标路径不安全");
      }
      if ((await stat(this.#path)).size > MAX_FILE_BYTES) {
        throw new Error("事前核对聚合指标超过安全大小限制");
      }
      return decisionConsultationMetricsSnapshotSchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")) as unknown,
      );
    } catch (error) {
      if (isMissing(error)) return emptySnapshot();
      if (error instanceof SyntaxError) {
        throw new Error("事前核对聚合指标损坏，已停止写入以保护现有数据");
      }
      throw error;
    }
  }

  async #write(snapshot: DecisionConsultationMetricsSnapshot): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error("事前核对聚合指标目录不安全");
    }
    await chmod(directory, 0o700);
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release = (): void => undefined;
    this.#mutationTail = new Promise<void>((resolveMutation) => {
      release = resolveMutation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
