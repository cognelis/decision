import type { PendingDecisionAnalysis } from "@cognelis/decision-core";
import {
  capturedDecisionContextSchema,
  capturedOptionSchema,
  type CapturedDecisionContext,
} from "@cognelis/decision-protocol";
import { renameReplacing } from "@cognelis/decision-storage";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
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
  /** Kept through the reply to a prompt the client wrote itself (see hold), and gone when the question goes. */
  held?: true;
}

export type PendingTextCapture =
  | LegacyPendingTextQuestion
  | LegacyPendingTextDecision
  | PendingAssistantTurn;

/**
 * Why a consume came back empty. `absent` is the ordinary case — the first
 * prompt of a session has no assistant turn waiting for it — while the other
 * two mean a captured turn was taken and lost.
 */
export type PendingMissReason =
  | "absent"
  | "expired"
  | "unreadable";

export type PendingConsumeResult =
  | { readonly pending: PendingAssistantTurn }
  | {
      readonly pending: null;
      readonly reason: PendingMissReason;
    };

/**
 * An assistant turn nobody answered within the window. Carries no text: it
 * exists to be counted in the audit, which never holds captured content.
 */
export interface ExpiredPendingTurn {
  readonly sourceClient: TextCaptureClient;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly capturedAt: string;
}

interface TextCaptureStoreOptions {
  now?: () => Date;
  cleanupIntervalMs?: number;
  /**
   * Called once per pending turn the cleanup drops. Most of these are the last
   * turn of a session nobody answered, which is how conversations end rather
   * than a failure — the audit counts them so the pairing rate is visible.
   */
  onExpired?(turn: ExpiredPendingTurn): Promise<void> | void;
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
    ...(input.held === true ? { held: true as const } : {}),
  };
};

export class TextCaptureStore {
  readonly path: string;
  readonly #now: () => Date;
  readonly #cleanupIntervalMs: number;
  readonly #onExpired: TextCaptureStoreOptions["onExpired"];

  constructor(
    path: string,
    options: TextCaptureStoreOptions = {},
  ) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    this.#cleanupIntervalMs =
      options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.#onExpired = options.onExpired;
  }

  /**
   * The turn's text, waiting for the reader's answer. A question held through a notice's reply (see hold) gives
   * way only to a reply that `asks` something itself; otherwise it stays, and the hold is spent.
   */
  async save(input: PendingTextCapture, options: { asks?: boolean } = {}): Promise<void> {
    const pending = normalizePending(input);
    await this.#secureDirectory();
    await this.#pruneExpiredIfDue();
    const path = this.#pathFor(
      pending.sourceClient,
      pending.sessionId,
    );
    const held = await this.#read(path).then((current) => (current.held === true ? current : null), () => null);
    if (held === null || options.asks !== false) {
      await this.#write(path, pending);
      return;
    }
    const { held: _spent, ...kept } = held;
    await this.#write(path, kept);
  }

  /**
   * Keeps the session's question through the turn that answers a prompt the client wrote itself (a background
   * task's notice): that answer took the question's place, and the reader's real answer after it was paired
   * with the notice's reply instead and set aside as no decision. Held in the question itself, the hold goes
   * when the question does: a marker beside it outlived it, and ate a resumed session's first question.
   */
  async hold(client: TextCaptureClient, sessionId: string): Promise<void> {
    await this.#secureDirectory();
    const path = this.#pathFor(client, sessionId);
    let pending: PendingAssistantTurn;
    try {
      pending = await this.#read(path);
    } catch {
      return;
    }
    await this.#write(path, { ...pending, held: true });
  }

  async #read(path: string): Promise<PendingAssistantTurn> {
    return normalizePending(JSON.parse(await readFile(path, "utf8")));
  }

  async #write(path: string, pending: PendingAssistantTurn): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(pending), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await renameReplacing(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async consume(
    client: TextCaptureClient,
    sessionId: string,
  ): Promise<PendingConsumeResult> {
    await this.#secureDirectory();
    await this.#pruneExpiredIfDue();
    const path = this.#pathFor(client, sessionId);
    const consuming = `${path}.consuming-${randomUUID()}`;
    try {
      await rename(path, consuming);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { pending: null, reason: "absent" };
      }
      throw error;
    }
    try {
      const pending = normalizePending(
        JSON.parse(await readFile(consuming, "utf8")),
      );
      // Either way past a day: one captured under a clock that ran ahead is no fresher for it.
      return Math.abs(this.#now().getTime() - Date.parse(pending.capturedAt)) > MAXIMUM_PENDING_AGE_MS
        ? { pending: null, reason: "expired" }
        : { pending };
    } catch {
      return { pending: null, reason: "unreadable" };
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
        // A hold marker an earlier build left beside its question: the hold now travels in the question.
        if (entry.isFile() && entry.name.endsWith(".json.held")) {
          await unlink(join(this.path, entry.name)).catch(() => undefined);
          return;
        }
        // Left by a hook cut short while it took a turn or wrote one (it has five seconds): the assistant's text in
        // it goes once a pending turn would have, where it stayed for good. Dated by a clock run ahead past that,
        // it goes now rather than on that day.
        if (entry.isFile() && (entry.name.includes(".json.consuming-") || entry.name.endsWith(".tmp"))) {
          const leftover = join(this.path, entry.name);
          const written = await stat(leftover).then((status) => status.mtimeMs, () => now);
          if (Math.abs(now - written) > MAXIMUM_PENDING_AGE_MS) await unlink(leftover).catch(() => undefined);
          return;
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) return;
        const path = join(this.path, entry.name);
        let expired = false;
        let lost: ExpiredPendingTurn | null = null;
        try {
          const pending = normalizePending(
            JSON.parse(await readFile(path, "utf8")),
          );
          // Either way past a day: captured under a clock that ran ahead, it stayed until the clock caught up.
          expired = Math.abs(now - Date.parse(pending.capturedAt)) > MAXIMUM_PENDING_AGE_MS;
          if (expired) {
            lost = {
              sourceClient: pending.sourceClient,
              sessionId: pending.sessionId,
              ...(pending.turnId === undefined
                ? {}
                : { turnId: pending.turnId }),
              capturedAt: pending.capturedAt,
            };
          }
        } catch {
          expired = true;
        }
        if (!expired) return;
        try {
          await unlink(path);
          removed += 1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return;
        }
        if (lost !== null && this.#onExpired !== undefined) {
          // A hook is an observer. Reporting the loss must never be able to
          // fail the cleanup, which would fail the capture that triggered it.
          try {
            await this.#onExpired(lost);
          } catch {
            // Nothing to report it to.
          }
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
      // A marker from the future (written under a clock that ran ahead) skips nothing: trusted, no cleanup ran until
      // the wall clock caught up, a year for a date typed wrong (as the trace and audit stores already guard).
      if (
        Number.isFinite(lastCleanup) &&
        now >= lastCleanup &&
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
