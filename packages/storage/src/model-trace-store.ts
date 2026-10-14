import {
  MODEL_TRACE_VERSION,
  modelInvocationTraceSchema,
  modelTraceSummarySchema,
  type ModelInvocationTrace,
  type ModelTraceContentMode,
  type ModelTraceSummary,
} from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { renameReplacing } from "./replace-file.js";

const DEFAULT_MAXIMUM_ITEMS = 1_000;
const DEFAULT_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const TRACE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;
/**
 * Retention from `record` runs at most this often. Every trace is read and
 * parsed by it: a fifth of a second per call at a thousand traces, and an answer
 * makes up to eight calls. `list` and `summary` still apply it on every read.
 */
const RECORD_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const CLEANUP_MARKER = ".last-cleanup";

export interface ModelTraceStoreOptions {
  now?: () => Date;
  maximumItems?: number;
  maximumAgeMs?: number;
  idFactory?: () => string;
  contentMode?: () => ModelTraceContentMode;
}

export type ModelTraceRecordInput = Omit<
  ModelInvocationTrace,
  | "version"
  | "traceId"
  | "contentMode"
  | "createdAt"
  | "expiresAt"
>;

interface TraceEntry {
  trace: ModelInvocationTrace;
  path: string;
}

export class ModelTraceStore {
  readonly path: string;
  readonly #now: () => Date;
  readonly #maximumItems: number;
  readonly #maximumAgeMs: number;
  readonly #idFactory: () => string;
  readonly #contentMode: () => ModelTraceContentMode;

  constructor(
    path: string,
    options: ModelTraceStoreOptions = {},
  ) {
    this.path = path;
    this.#now = options.now ?? (() => new Date());
    this.#maximumItems =
      options.maximumItems ?? DEFAULT_MAXIMUM_ITEMS;
    this.#maximumAgeMs =
      options.maximumAgeMs ?? DEFAULT_MAXIMUM_AGE_MS;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#contentMode = options.contentMode ?? (() => "full");
    if (
      !Number.isInteger(this.#maximumItems) ||
      this.#maximumItems < 1
    ) {
      throw new Error(
        "Model trace maximum items must be a positive integer",
      );
    }
    if (
      !Number.isInteger(this.#maximumAgeMs) ||
      this.#maximumAgeMs < 1
    ) {
      throw new Error(
        "Model trace maximum age must be a positive integer",
      );
    }
  }

  async record(
    input: ModelTraceRecordInput,
  ): Promise<ModelInvocationTrace> {
    await this.#secureDirectories();
    const now = this.#now();
    const contentMode = this.#contentMode();
    const trace = modelInvocationTraceSchema.parse({
      version: MODEL_TRACE_VERSION,
      traceId: this.#idFactory(),
      requestId: input.requestId,
      attemptId: input.attemptId,
      attemptIndex: input.attemptIndex,
      purpose: input.purpose,
      ...(input.correlationFingerprint === undefined
        ? {}
        : {
            correlationFingerprint:
              input.correlationFingerprint,
          }),
      contentMode,
      profile: input.profile,
      ...(contentMode === "full" && input.input !== undefined
        ? { input: input.input }
        : {}),
      ...(contentMode === "full" && input.output !== undefined
        ? { output: input.output }
        : {}),
      usage: input.usage,
      timing: input.timing,
      status: input.status,
      ...(input.errorCode === undefined
        ? {}
        : { errorCode: input.errorCode }),
      ...(input.providerRequestId === undefined
        ? {}
        : { providerRequestId: input.providerRequestId }),
      ...(input.processExitCode === undefined
        ? {}
        : { processExitCode: input.processExitCode }),
      ...(input.request === undefined ? {} : { request: input.request }),
      ...(input.diagnosticExcerpt === undefined
        ? {}
        : { diagnosticExcerpt: input.diagnosticExcerpt }),
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.#maximumAgeMs,
      ).toISOString(),
    });
    const target = join(this.path, this.#filename(trace.traceId));
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(trace), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await renameReplacing(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await this.#pruneIfDue().catch(() => undefined);
    return trace;
  }

  async #pruneIfDue(): Promise<void> {
    const marker = join(this.path, CLEANUP_MARKER);
    const now = this.#now().getTime();
    const last = Number(await readFile(marker, "utf8").catch(() => ""));
    // A marker from the future (a clock set back) is not trusted to skip anything.
    if (last > 0 && now >= last && now - last < RECORD_CLEANUP_INTERVAL_MS) return;
    await this.#listEntries();
    await writeFile(marker, String(now), { encoding: "utf8", mode: 0o600 });
  }

  async list(): Promise<ModelInvocationTrace[]> {
    return (await this.#listEntries()).map(
      (entry) => entry.trace,
    );
  }

  async summary(): Promise<ModelTraceSummary> {
    const traces = await this.list();
    const requestIds = new Set(
      traces.map((trace) => trace.requestId),
    );
    return modelTraceSummarySchema.parse({
      total: traces.length,
      requests: requestIds.size,
      succeeded: traces.filter(
        (trace) => trace.status === "succeeded",
      ).length,
      failed: traces.filter(
        (trace) => trace.status !== "succeeded",
      ).length,
      contentMode: this.#contentMode(),
      ...(traces[0] === undefined
        ? {}
        : { oldestCreatedAt: traces[0].createdAt }),
      ...(traces.at(-1) === undefined
        ? {}
        : { newestCreatedAt: traces.at(-1)!.createdAt }),
    });
  }

  async deleteTrace(traceId: string): Promise<boolean> {
    const entry = (await this.#listEntries()).find(
      (candidate) => candidate.trace.traceId === traceId,
    );
    if (entry === undefined) {
      return false;
    }
    await unlink(entry.path);
    return true;
  }

  /** Every trace of these requests, the folder listed once however many are named. */
  async deleteRequest(requestId: string | readonly string[]): Promise<number> {
    const requests = new Set(typeof requestId === "string" ? [requestId] : requestId);
    const entries = (await this.#listEntries()).filter(
      (entry) => requests.has(entry.trace.requestId),
    );
    await Promise.all(
      entries.map((entry) =>
        unlink(entry.path).catch(() => undefined),
      ),
    );
    return entries.length;
  }

  async clear(): Promise<number> {
    const entries = await this.#listEntries();
    await Promise.all(
      entries.map((entry) =>
        unlink(entry.path).catch(() => undefined),
      ),
    );
    // All means all: a trace set aside as unreadable can still hold a prompt.
    await rm(this.#quarantinePath(), { recursive: true, force: true });
    return entries.length;
  }

  async #listEntries(): Promise<TraceEntry[]> {
    await this.#secureDirectories();
    const now = this.#now().getTime();
    const entries: TraceEntry[] = [];
    for (const filename of await readdir(this.path)) {
      if (!TRACE_FILE_PATTERN.test(filename)) {
        continue;
      }
      const path = join(this.path, filename);
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        // Unreadable just now, or gone: left for the next scan, not set aside as corrupt.
        continue;
      }
      try {
        const trace = modelInvocationTraceSchema.parse(
          JSON.parse(raw),
        );
        // Or set to expire later than any written now could: written under a clock that ran ahead, the prompt and
        // reply said to go after 7 days stayed until that clock's date came round.
        const expiresAt = Date.parse(trace.expiresAt);
        if (expiresAt <= now || expiresAt - now > this.#maximumAgeMs) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        entries.push({ trace, path });
      } catch {
        const quarantined = join(
          this.#quarantinePath(),
          `${filename}.corrupt-${this.#now().getTime()}-${randomUUID()}`,
        );
        await rename(path, quarantined).catch(() => undefined);
        await chmod(quarantined, 0o600).catch(() => undefined);
      }
    }
    // Set aside, not kept: what is quarantined ages out with everything else, as it can hold a prompt
    // as well as any trace. Its name carries when it was set aside; stamped by a clock run ahead past its
    // lifetime, it goes now rather than on that day.
    for (const name of await readdir(this.#quarantinePath()).catch(() => [])) {
      const setAside = Number(/\.corrupt-(\d+)-/u.exec(name)?.[1]);
      if (!(Math.abs(now - setAside) < this.#maximumAgeMs)) {
        await unlink(join(this.#quarantinePath(), name)).catch(() => undefined);
      }
    }
    entries.sort(
      (left, right) =>
        left.trace.createdAt.localeCompare(
          right.trace.createdAt,
        ) ||
        left.trace.traceId.localeCompare(right.trace.traceId),
    );
    const overflow = Math.max(
      0,
      entries.length - this.#maximumItems,
    );
    for (const entry of entries.slice(0, overflow)) {
      await unlink(entry.path).catch(() => undefined);
    }
    return entries.slice(overflow);
  }

  #filename(traceId: string): string {
    return `${createHash("sha256")
      .update(traceId, "utf8")
      .digest("hex")}.json`;
  }

  #quarantinePath(): string {
    return join(this.path, "quarantine");
  }

  async #secureDirectories(): Promise<void> {
    for (const path of [this.path, this.#quarantinePath()]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
  }
}
