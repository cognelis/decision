import type { PendingDecisionAnalysis } from "@cognelis/decision-core";
import {
  capturedDecisionContextSchema,
  capturedOptionSchema,
  type CapturedDecisionContext,
} from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export type TextCaptureClient = "claude-code" | "codex";

export interface LegacyPendingTextQuestion {
  version: 1;
  sourceClient: TextCaptureClient;
  sessionId: string;
  turnId?: string;
  cwd: string;
  question: string;
  capturedAt: string;
}

export interface LegacyPendingTextDecision {
  version: 2;
  sourceClient: TextCaptureClient;
  sessionId: string;
  turnId?: string;
  cwd: string;
  analysis: PendingDecisionAnalysis;
  capturedAt: string;
}

export interface PendingAssistantTurn {
  version: 3;
  sourceClient: TextCaptureClient;
  sessionId: string;
  turnId?: string;
  cwd: string;
  assistantText: string;
  context?: CapturedDecisionContext;
  capturedAt: string;
}

export type PendingTextCapture =
  | LegacyPendingTextQuestion
  | LegacyPendingTextDecision
  | PendingAssistantTurn;

interface TextCaptureStoreOptions {
  now?: () => Date;
  cleanupIntervalMs?: number;
}

const MAXIMUM_PENDING_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const CLEANUP_MARKER = ".last-cleanup";

const pendingKey = (
  client: TextCaptureClient,
  sessionId: string,
): string =>
  createHash("sha256")
    .update(`${client}:${sessionId}`, "utf8")
    .digest("hex");

const parseAnalysis = (value: unknown): PendingDecisionAnalysis => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Pending text analysis must be an object");
  }
  const input = value as Record<string, unknown>;
  const options = Array.isArray(input.options)
    ? input.options.map((option) => capturedOptionSchema.parse(option))
    : null;
  const context =
    input.context === undefined
      ? undefined
      : capturedDecisionContextSchema.parse(input.context);
  if (
    typeof input.question !== "string" ||
    input.question.trim().length === 0 ||
    input.question.length > 4_000 ||
    options === null ||
    options.length > 8 ||
    !Number.isInteger(input.preScore) ||
    (input.preScore as number) < 0 ||
    (input.preScore as number) > 100 ||
    !Array.isArray(input.signals) ||
    !input.signals.every(
      (signal) =>
        typeof signal === "string" &&
        signal.length > 0 &&
        signal.length <= 100,
    ) ||
    input.signals.length > 32 ||
    input.detectorVersion !== "rules-v1"
  ) {
    throw new Error("Pending text analysis is invalid");
  }
  return {
    question: input.question,
    options,
    ...(context === undefined ? {} : { context }),
    preScore: input.preScore as number,
    signals: [...input.signals] as string[],
    detectorVersion: "rules-v1",
  };
};

const normalizePending = (value: unknown): PendingAssistantTurn => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("Pending assistant turn must be an object");
  }
  const input = value as Record<string, unknown>;
  if (
    (input.version !== 1 &&
      input.version !== 2 &&
      input.version !== 3) ||
    (input.sourceClient !== "claude-code" &&
      input.sourceClient !== "codex") ||
    typeof input.sessionId !== "string" ||
    input.sessionId.length === 0 ||
    input.sessionId.length > 500 ||
    typeof input.cwd !== "string" ||
    input.cwd.length === 0 ||
    input.cwd.length > 2_000 ||
    typeof input.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(input.capturedAt)) ||
    (input.turnId !== undefined &&
      (typeof input.turnId !== "string" ||
        input.turnId.length === 0 ||
        input.turnId.length > 500))
  ) {
    throw new Error("Pending assistant turn is invalid");
  }
  let assistantText: string;
  let context: CapturedDecisionContext | undefined;
  if (input.version === 1) {
    if (
      typeof input.question !== "string" ||
      input.question.trim().length === 0 ||
      input.question.length > 4_000
    ) {
      throw new Error("Legacy pending question is invalid");
    }
    assistantText = input.question.trim();
  } else if (input.version === 2) {
    const analysis = parseAnalysis(input.analysis);
    assistantText = analysis.question;
    context = analysis.context;
  } else {
    if (
      typeof input.assistantText !== "string" ||
      input.assistantText.trim().length === 0 ||
      input.assistantText.length > 8_000
    ) {
      throw new Error("Pending assistant text is invalid");
    }
    assistantText = input.assistantText.trim();
    context =
      input.context === undefined
        ? undefined
        : capturedDecisionContextSchema.parse(input.context);
  }
  return {
    version: 3,
    sourceClient: input.sourceClient,
    sessionId: input.sessionId,
    ...(input.turnId === undefined
      ? {}
      : { turnId: input.turnId }),
    cwd: input.cwd,
    assistantText,
    ...(context === undefined ? {} : { context }),
    capturedAt: input.capturedAt,
  };
};

export class TextCaptureStore {
  readonly path: string;
  readonly #now: () => Date;
  readonly #cleanupIntervalMs: number;

  constructor(
    path: string,
    options: TextCaptureStoreOptions = {},
  ) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    this.#cleanupIntervalMs =
      options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  }

  async save(input: PendingTextCapture): Promise<void> {
    const pending = normalizePending(input);
    await this.#secureDirectory();
    await this.#pruneExpiredIfDue();
    const path = this.#pathFor(
      pending.sourceClient,
      pending.sessionId,
    );
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(pending), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async consume(
    client: TextCaptureClient,
    sessionId: string,
  ): Promise<PendingAssistantTurn | null> {
    await this.#secureDirectory();
    await this.#pruneExpiredIfDue();
    const path = this.#pathFor(client, sessionId);
    const consuming = `${path}.consuming-${randomUUID()}`;
    try {
      await rename(path, consuming);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      const pending = normalizePending(
        JSON.parse(await readFile(consuming, "utf8")),
      );
      return this.#now().getTime() -
        Date.parse(pending.capturedAt) >
        MAXIMUM_PENDING_AGE_MS
        ? null
        : pending;
    } catch {
      return null;
    } finally {
      await unlink(consuming).catch(() => undefined);
    }
  }

  #pathFor(
    client: TextCaptureClient,
    sessionId: string,
  ): string {
    return join(this.path, `${pendingKey(client, sessionId)}.json`);
  }

  async pruneExpired(): Promise<number> {
    await this.#secureDirectory();
    const now = this.#now().getTime();
    let removed = 0;
    const entries = await readdir(this.path, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile() || !entry.name.endsWith(".json")) return;
        const path = join(this.path, entry.name);
        let expired = false;
        try {
          const pending = normalizePending(
            JSON.parse(await readFile(path, "utf8")),
          );
          expired = now - Date.parse(pending.capturedAt) > MAXIMUM_PENDING_AGE_MS;
        } catch {
          expired = true;
        }
        if (!expired) return;
        try {
          await unlink(path);
          removed += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
    );
    return removed;
  }

  async #pruneExpiredIfDue(): Promise<void> {
    const marker = join(this.path, CLEANUP_MARKER);
    const now = this.#now().getTime();
    try {
      const lastCleanup = Number(await readFile(marker, "utf8"));
      if (
        Number.isFinite(lastCleanup) &&
        now - lastCleanup < this.#cleanupIntervalMs
      ) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await unlink(marker).catch(() => undefined);
      }
    }
    await this.pruneExpired();
    await writeFile(marker, String(now), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(marker, 0o600);
  }

  async #secureDirectory(): Promise<void> {
    await mkdir(this.path, { recursive: true, mode: 0o700 });
    await chmod(this.path, 0o700);
  }
}
