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
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_MAXIMUM_ITEMS = 1_000;
const DEFAULT_MAXIMUM_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const TRACE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;

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
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await this.#listEntries();
    return trace;
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

  async deleteRequest(requestId: string): Promise<number> {
    const entries = (await this.#listEntries()).filter(
      (entry) => entry.trace.requestId === requestId,
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
    return entries.length;
  }

  async #listEntries(): Promise<TraceEntry[]> {
    await this.#secureDirectories();
    const entries: TraceEntry[] = [];
    for (const filename of await readdir(this.path)) {
      if (!TRACE_FILE_PATTERN.test(filename)) {
        continue;
      }
      const path = join(this.path, filename);
      try {
        const trace = modelInvocationTraceSchema.parse(
          JSON.parse(await readFile(path, "utf8")),
        );
        if (
          Date.parse(trace.expiresAt) <= this.#now().getTime()
        ) {
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
