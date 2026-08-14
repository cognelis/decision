import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import {
  semanticClassificationSchema,
  type SemanticClassification,
} from "@cognelis/decision-protocol";
import { z } from "zod";

import {
  buildSemanticUserPrompt,
  SEMANTIC_PROMPT_VERSION,
  semanticOutputJsonSchema,
  semanticSystemPrompt,
} from "../model/semantic-prompt.js";
import type {
  SemanticClassifier,
  SemanticClassifierInput,
  SemanticProviderAttempt,
  SemanticProviderStatus,
} from "./semantic-classifier.js";

const DEFAULT_MODEL_VERSION = "system-language-model";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 32 * 1024;
const MAX_CONSECUTIVE_CRASHES = 3;

const helperAvailabilitySchema = z.enum([
  "available",
  "device_not_eligible",
  "apple_intelligence_disabled",
  "assets_unavailable",
]);

const statusResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.literal(true),
    status: helperAvailabilitySchema,
    modelVersion: z.string().min(1).max(200).optional(),
  })
  .strict();

const helperClassificationSchema = z
  .object({
    decisionIntent: z.enum([
      "decision",
      "approval",
      "information_request",
      "self_resolved",
      "none",
    ]),
    answerRelation: z.enum([
      "answers",
      "mixed",
      "new_task",
      "uncertain",
    ]),
    question: z.string().trim().min(1).max(4_000).nullable(),
    optionLabels: z
      .array(z.string().trim().min(1).max(500))
      .max(8),
    answerExcerpt: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const classificationResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.literal(true),
    visibleOutput: z.string().trim().min(1).max(20_000),
    classification: helperClassificationSchema,
  })
  .strict();

const errorResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();

type HelperAvailability = z.infer<
  typeof helperAvailabilitySchema
>;

export interface AppleFoundationHelperProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(
    event: "error",
    listener: (error: NodeJS.ErrnoException) => void,
  ): this;
  on(
    event: "exit",
    listener: (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export class AppleFoundationProviderError extends Error {
  readonly code:
    | "helper_missing"
    | "helper_crashed"
    | "provider_invalid_output"
    | "provider_unavailable"
    | "runtime_unavailable";

  constructor(
    code: AppleFoundationProviderError["code"],
    message: string,
  ) {
    super(message);
    this.name = "AppleFoundationProviderError";
    this.code = code;
  }
}

interface PendingRequest {
  operation: "status" | "classify";
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

export interface AppleFoundationModelProviderOptions {
  helperPath?: string;
  resourcesPath?: string;
  spawnHelper?: (
    helperPath: string,
  ) => AppleFoundationHelperProcess;
  timeoutMs?: number;
}

const defaultHelperPath = (resourcesPath?: string): string =>
  join(
    resourcesPath ?? process.resourcesPath,
    "semantic",
    "decision-foundation-model-helper",
  );

const abortError = (): Error => {
  const error = new Error("Apple Foundation Models request aborted");
  error.name = "AbortError";
  return error;
};

const isMissingHelperError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export class AppleFoundationModelProvider
  implements SemanticClassifier
{
  readonly id = "apple" as const;

  readonly #helperPath: string;
  readonly #spawnHelper: (
    helperPath: string,
  ) => AppleFoundationHelperProcess;
  readonly #timeoutMs: number;
  readonly #pending = new Map<string, PendingRequest>();

  #child: AppleFoundationHelperProcess | undefined;
  #stdoutBuffer = Buffer.alloc(0);
  #requestSequence = 0;
  #consecutiveCrashes = 0;
  #circuitOpen = false;
  #closed = false;

  constructor(
    options: AppleFoundationModelProviderOptions = {},
  ) {
    this.#helperPath =
      options.helperPath ??
      defaultHelperPath(options.resourcesPath);
    this.#spawnHelper =
      options.spawnHelper ??
      ((helperPath) =>
        spawn(helperPath, [], {
          stdio: ["pipe", "pipe", "pipe"],
        }));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async status(): Promise<SemanticProviderStatus> {
    if (this.#closed || this.#circuitOpen) {
      return {
        id: this.id,
        availability: "runtime_unavailable",
        promptVersion: SEMANTIC_PROMPT_VERSION,
      };
    }

    try {
      const response = statusResponseSchema.parse(
        await this.#request("status", {}),
      );
      return {
        id: this.id,
        availability: response.status,
        modelVersion:
          response.modelVersion ?? DEFAULT_MODEL_VERSION,
        promptVersion: SEMANTIC_PROMPT_VERSION,
      };
    } catch (error) {
      return {
        id: this.id,
        availability: this.#availabilityForError(error),
        promptVersion: SEMANTIC_PROMPT_VERSION,
      };
    }
  }

  async classify(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticClassification> {
    return (await this.invoke(input, signal)).classification;
  }

  async invoke(
    input: SemanticClassifierInput,
    signal?: AbortSignal,
  ): Promise<SemanticProviderAttempt> {
    const userPrompt = buildSemanticUserPrompt(input);
    const providerStartedAt = Date.now();
    const response = classificationResponseSchema.parse(
      await this.#request(
        "classify",
        {
          systemPrompt: semanticSystemPrompt,
          userPrompt,
          locale: input.locale,
        },
        signal,
      ),
    );
    let visibleClassification: unknown;
    try {
      visibleClassification = helperClassificationSchema.parse(
        JSON.parse(response.visibleOutput),
      );
    } catch {
      throw new AppleFoundationProviderError(
        "provider_invalid_output",
        "Apple Foundation Models returned malformed visible output",
      );
    }
    if (
      !isDeepStrictEqual(
        visibleClassification,
        response.classification,
      )
    ) {
      throw new AppleFoundationProviderError(
        "provider_invalid_output",
        "Apple Foundation Models visible output did not match its classification",
      );
    }
    const classification = semanticClassificationSchema.parse({
      ...response.classification,
      provider: this.id,
      modelVersion: DEFAULT_MODEL_VERSION,
      promptVersion: SEMANTIC_PROMPT_VERSION,
    });
    return {
      classification,
      visibleOutput: response.visibleOutput,
      traceInput: {
        systemPrompt: semanticSystemPrompt,
        userPrompt,
        outputSchema: semanticOutputJsonSchema,
        clientSystemPromptVisibility: "visible",
      },
      usage: { source: "unavailable" },
      providerDurationMs: Math.max(
        0,
        Date.now() - providerStartedAt,
      ),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectAll(
      new AppleFoundationProviderError(
        "runtime_unavailable",
        "Apple Foundation Models provider closed",
      ),
    );
    const child = this.#child;
    this.#child = undefined;
    this.#stdoutBuffer = Buffer.alloc(0);
    child?.kill();
  }

  #request(
    operation: "status" | "classify",
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#closed || this.#circuitOpen) {
      return Promise.reject(
        new AppleFoundationProviderError(
          "runtime_unavailable",
          "Apple Foundation Models helper is unavailable",
        ),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }

    let child: AppleFoundationHelperProcess;
    try {
      child = this.#ensureChild();
    } catch (error) {
      return Promise.reject(
        new AppleFoundationProviderError(
          isMissingHelperError(error)
            ? "helper_missing"
            : "runtime_unavailable",
          "Unable to start Apple Foundation Models helper",
        ),
      );
    }

    const id = String(++this.#requestSequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#takePending(id);
        pending?.reject(
          new AppleFoundationProviderError(
            "runtime_unavailable",
            "Apple Foundation Models request timed out",
          ),
        );
      }, this.#timeoutMs);
      const pending: PendingRequest = {
        operation,
        resolve,
        reject,
        timer,
      };
      if (signal !== undefined) {
        const onAbort = () => {
          const aborted = this.#takePending(id);
          aborted?.reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, pending);

      const line = `${JSON.stringify({
        id,
        operation,
        ...payload,
      })}\n`;
      child.stdin.write(line, (error) => {
        if (error !== null && error !== undefined) {
          const failed = this.#takePending(id);
          failed?.reject(
            new AppleFoundationProviderError(
              "runtime_unavailable",
              "Unable to write to Apple Foundation Models helper",
            ),
          );
        }
      });
    });
  }

  #ensureChild(): AppleFoundationHelperProcess {
    if (this.#child !== undefined) {
      return this.#child;
    }

    const child = this.#spawnHelper(this.#helperPath);
    this.#child = child;
    this.#stdoutBuffer = Buffer.alloc(0);
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (this.#child === child) {
        this.#consumeStdout(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        );
      }
    });
    child.once("error", (error) => {
      if (this.#child !== child) {
        return;
      }
      this.#child = undefined;
      this.#stdoutBuffer = Buffer.alloc(0);
      this.#rejectAll(
        new AppleFoundationProviderError(
          isMissingHelperError(error)
            ? "helper_missing"
            : "helper_crashed",
          "Apple Foundation Models helper failed",
        ),
      );
    });
    child.on("exit", () => {
      if (this.#child !== child) {
        return;
      }
      this.#child = undefined;
      this.#stdoutBuffer = Buffer.alloc(0);
      this.#consecutiveCrashes += 1;
      if (
        this.#consecutiveCrashes >= MAX_CONSECUTIVE_CRASHES
      ) {
        this.#circuitOpen = true;
      }
      this.#rejectAll(
        new AppleFoundationProviderError(
          "helper_crashed",
          "Apple Foundation Models helper exited",
        ),
      );
    });
    return child;
  }

  #consumeStdout(chunk: Buffer): void {
    this.#stdoutBuffer = Buffer.concat([
      this.#stdoutBuffer,
      chunk,
    ]);
    if (this.#stdoutBuffer.byteLength > MAX_LINE_BYTES) {
      this.#invalidateOutput();
      return;
    }

    let newline = this.#stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(
        newline + 1,
      );
      if (line.byteLength > MAX_LINE_BYTES) {
        this.#invalidateOutput();
        return;
      }
      if (line.byteLength > 0) {
        this.#handleLine(line.toString("utf8"));
      }
      newline = this.#stdoutBuffer.indexOf(0x0a);
    }
  }

  #handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.#invalidateOutput();
      return;
    }

    const envelope = z
      .object({ id: z.string().min(1), ok: z.boolean() })
      .passthrough()
      .safeParse(value);
    if (!envelope.success) {
      this.#invalidateOutput();
      return;
    }
    const pending = this.#pending.get(envelope.data.id);
    if (pending === undefined) {
      return;
    }

    const parsed =
      envelope.data.ok === false
        ? errorResponseSchema.safeParse(value)
        : pending.operation === "status"
          ? statusResponseSchema.safeParse(value)
          : classificationResponseSchema.safeParse(value);
    if (!parsed.success) {
      this.#invalidateOutput();
      return;
    }

    this.#consecutiveCrashes = 0;
    const completed = this.#takePending(envelope.data.id);
    if (completed === undefined) {
      return;
    }
    if (parsed.data.ok === false) {
      completed.reject(
        new AppleFoundationProviderError(
          "provider_unavailable",
          `Apple Foundation Models request failed: ${parsed.data.error.code}`,
        ),
      );
      return;
    }
    completed.resolve(parsed.data);
  }

  #invalidateOutput(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#stdoutBuffer = Buffer.alloc(0);
    this.#rejectAll(
      new AppleFoundationProviderError(
        "provider_invalid_output",
        "Apple Foundation Models helper returned invalid output",
      ),
    );
    child?.kill();
  }

  #takePending(id: string): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return undefined;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();
    return pending;
  }

  #rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) {
      this.#takePending(id)?.reject(error);
    }
  }

  #availabilityForError(
    error: unknown,
  ): SemanticProviderStatus["availability"] {
    if (
      error instanceof AppleFoundationProviderError &&
      error.code === "helper_missing"
    ) {
      return "helper_missing";
    }
    return "runtime_unavailable";
  }
}

export const appleFoundationHelperAvailabilityValues =
  helperAvailabilitySchema.options satisfies readonly HelperAvailability[];
