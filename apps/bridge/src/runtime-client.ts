import { DecisionFeedbackUpdate, DecisionFeedbackUpdateResult, decisionFeedbackUpdateSchema, decisionFeedbackUpdateResultSchema, DecisionFeedbackQuery, DecisionFeedbackResponse, decisionFeedbackQuerySchema, decisionFeedbackResponseSchema } from "@cognelis/decision-protocol";
import {
  CONSULTATION_SHAPE,
  CONSULTATION_SHAPE_HEADER,
  PROTOCOL_VERSION,
  captureReceiptSchema,
  capturedDecisionCandidateSchema,
  capturedDecisionEventSchema,
  decisionConsultationFeedbackRequestSchema,
  decisionConsultationFeedbackResultSchema,
  decisionConsultationRequestSchema,
  decisionConsultationResponseSchema,
  runtimeDescriptorSchema,
  semanticDecisionPairSchema,
  semanticPairDeliveryReceiptSchema,
  proactiveRecordRequestSchema,
  proactiveRecordResultSchema,
  decisionContextQuerySchema,
  decisionContextResponseSchema,
  type DecisionContextQuery,
  type DecisionContextResponse,
  decisionScopeUpdateSchema,
  decisionScopeUpdateResultSchema,
  type DecisionScopeUpdate,
  type DecisionScopeUpdateResult,
  decisionSourceReferenceSchema,
  decisionSourceOpenResultSchema,
  decisionHandoffRequestSchema,
  decisionHandoffResponseSchema,
  type DecisionSourceReference,
  type DecisionSourceOpenResult,
  type DecisionHandoffRequest,
  type DecisionHandoffResponse,
  decisionOutcomeUpdateSchema,
  decisionOutcomeUpdateResultSchema,
  type DecisionOutcomeUpdate,
  type DecisionOutcomeUpdateResult,
  decisionRelationUpdateSchema,
  decisionRelationUpdateResultSchema,
  type DecisionRelationUpdate,
  type DecisionRelationUpdateResult,
  type CaptureReceipt,
  type CapturedDecisionCandidate,
  type CapturedDecisionEvent,
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
  type DecisionConsultationFeedbackRequest,
  type DecisionConsultationFeedbackResult,
  type RuntimeDescriptor,
  type SemanticDecisionPair,
  type ProactiveRecordRequest,
  type ProactiveRecordResult,
} from "@cognelis/decision-protocol";
import { runtimeIdentityProof } from "@cognelis/decision-storage";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

import { readDecisionEnvironment } from "../../../config/decision-environment.mjs";

type Fetcher = typeof fetch;

export type RuntimeClientErrorCode = "invalid_runtime";

export class RuntimeClientError extends Error {
  readonly code: RuntimeClientErrorCode;

  constructor(code: RuntimeClientErrorCode, message: string) {
    super(message);
    this.name = "RuntimeClientError";
    this.code = code;
  }
}

export interface DoctorReport {
  runtimeFile: string;
  /**
   * outdated: a Decision App answers, from before this bridge's identity challenge: restart or update it. busy: its
   * process is alive, and it did not answer that challenge in time.
   */
  appStatus: "healthy" | "unavailable" | "busy" | "outdated" | "invalid_runtime";
  /** What to do about it, for a reader at a terminal. */
  message?: string;
  protocolVersion?: number;
  port?: number;
}

/** Why the App gave nothing back: what an agent is told, and what doctor says, depend on it. */
export type RuntimeFailure =
  /** Nothing sent: no App's runtime file names a live process, or what answers on its port is not that App. */
  | { reason: "not_running" }
  /** Nothing sent: a Decision App answers, from before this bridge's identity challenge. */
  | { reason: "outdated" }
  /** Nothing sent: the App is there, and did not answer its challenge in time. */
  | { reason: "busy" }
  /** Sent, and nothing it could read came back: whether it was done is not known. */
  | { reason: "no_answer" }
  /** Sent, and the App answered that it was not done, with its own reason when it gave one. */
  | { reason: "refused"; message: string | null };

export type RuntimeFailureReport = (failure: RuntimeFailure) => void;

/**
 * What an agent is told when the App gave nothing back. Every case read "Decision 可能没有运行": an App too old for
 * this bridge, one too busy to answer, one refusing for a missing vault, all sent the reader to start it.
 */
export const runtimeFailureText = (failure: RuntimeFailure): string => {
  switch (failure.reason) {
    case "outdated":
      return "Decision 正在运行，但版本比这次调用的 bridge 旧，无法安全连接，这次没有发出；请用户重启或更新 Decision。";
    case "busy":
      return "Decision 正在运行，但没有及时回应，这次没有发出；稍后可以再试。";
    case "no_answer":
      return "请求已经发给 Decision，但没有收到能读懂的回应，结果未知。";
    case "refused":
      // Ended as a sentence: Node's own words end with none, and the tool's next sentence ran straight on from them.
      return failure.message === null
        ? "Decision 没有完成这次请求。"
        : `Decision 没有完成这次请求：${failure.message}${/[。！？.!?]$/u.test(failure.message) ? "" : "。"}`;
    case "not_running":
      return "Decision 没有运行或连不上，这次没有发出。";
  }
};

/**
 * A write that came back with nothing: not saved, and why; or, sent with nothing back, what the tool says to check
 * before trying again (`unknown`), as it may have been saved after all.
 */
export const unsavedText = (failure: RuntimeFailure, what: string, unknown: string): string =>
  failure.reason === "no_answer" ? `${runtimeFailureText(failure)}${unknown}` : `${what}没有保存：${runtimeFailureText(failure)}`;

interface RuntimeClientOptions {
  runtimeFile?: string;
  environment?: NodeJS.ProcessEnv;
  fetcher?: Fetcher;
  deliveryTimeoutMs?: number;
  healthTimeoutMs?: number;
  contextTimeoutMs?: number;
}

const platformRuntimeFile = (
  directoryName: string,
  linuxDirectoryName: string,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
  appData: string | undefined = process.env.APPDATA,
): string => {
  if (platform === "win32") {
    return win32.join(
      appData ?? win32.join(userHome, "AppData", "Roaming"),
      directoryName,
      "runtime.json",
    );
  }
  if (platform === "darwin") {
    return posix.join(
      userHome,
      "Library",
      "Application Support",
      directoryName,
      "runtime.json",
    );
  }
  return posix.join(
    xdgConfigHome ?? posix.join(userHome, ".config"),
    linuxDirectoryName,
    "runtime.json",
  );
};

export const defaultRuntimeFile = (
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
  xdgConfigHome: string | undefined = process.env.XDG_CONFIG_HOME,
  appData: string | undefined = process.env.APPDATA,
): string =>
  platformRuntimeFile(
    "Decision",
    "decision",
    platform,
    userHome,
    xdgConfigHome,
    appData,
  );

export const defaultBridgeDataDirectory = (): string => dirname(defaultRuntimeFile());

/**
 * Whether the process that wrote a runtime file is still there (signal 0 only asks; it sends nothing). One the
 * bridge may not signal (EPERM) belongs to another user: never this user's App, whose pid it took after a restart.
 */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const timedOut = (error: unknown): boolean =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

/** The App's own reason for not doing it, when it gave one. */
const appMessage = async (response: Response): Promise<string | null> => {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === "string" && body.message.trim() !== "" ? body.message.trim().slice(0, 500) : null;
  } catch {
    return null;
  }
};

type Found = { runtime: RuntimeDescriptor } | { failure: RuntimeFailure };

export class RuntimeClient {
  #runtimeFile: string;
  readonly #runtimeFiles: string[];
  readonly #fetch: Fetcher;
  readonly #deliveryTimeoutMs: number;
  readonly #healthTimeoutMs: number;
  readonly #contextTimeoutMs: number;

  constructor(options: RuntimeClientOptions = {}) {
    const configuredRuntimeFile =
      options.runtimeFile ??
      readDecisionEnvironment(
        options.environment ?? process.env,
        "RUNTIME_FILE",
      );
    this.#runtimeFiles = [configuredRuntimeFile ?? defaultRuntimeFile()];
    this.#runtimeFile = this.#runtimeFiles[0]!;
    this.#fetch = options.fetcher ?? fetch;
    this.#deliveryTimeoutMs = options.deliveryTimeoutMs ?? 750;
    this.#healthTimeoutMs = options.healthTimeoutMs ?? 1_000;
    this.#contextTimeoutMs = options.contextTimeoutMs ?? 5_000;
  }

  /**
   * null: nothing reached an App (none running to take it, which the spool is for, or one that quit since its
   * challenge refused the connection); false: it reached one with no receipt back (an App too busy to answer within a
   * hook's time, or one that answered with an error, may well have taken it).
   */
  async deliver(
    input: CapturedDecisionEvent,
  ): Promise<CaptureReceipt | false | null> {
    const event = capturedDecisionEventSchema.parse(input);
    const found = await this.#readRuntime(this.#healthTimeoutMs).catch(() => null);
    if (found === null || "failure" in found) {
      return null;
    }

    let response: Response;
    try {
      response = await this.#fetch(
        `http://127.0.0.1:${found.runtime.port}/v1/captures`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${found.runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
    } catch (error) {
      return timedOut(error) ? false : null;
    }
    // Refused before it was taken in (4xx: a capture an older App's schema does not read, a body too large) is not
    // taken: read as maybe taken, a capture neither the spool nor the App held went unsaid. A 5xx came after the App
    // had it in hand.
    if (!response.ok) return response.status >= 500 ? false : null;
    try {
      return captureReceiptSchema.parse(await response.json());
    } catch {
      return false;
    }
  }

  async deliverCandidate(
    input: CapturedDecisionCandidate,
  ): Promise<boolean> {
    const candidate =
      capturedDecisionCandidateSchema.parse(input);
    const found = await this.#readRuntime(this.#healthTimeoutMs).catch(() => null);
    if (found === null || "failure" in found) {
      return false;
    }
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${found.runtime.port}/v1/candidates`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${found.runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(candidate),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /** null: no App running to take it, which the spool is for; false: one was, and did not. */
  async deliverSemanticPair(
    input: SemanticDecisionPair,
  ): Promise<boolean | null> {
    const pair = semanticDecisionPairSchema.parse(input);
    const found = await this.#readRuntime(this.#healthTimeoutMs).catch(() => null);
    if (found === null || "failure" in found) {
      return null;
    }
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${found.runtime.port}/v1/semantic-pairs`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${found.runtime.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(pair),
          signal: AbortSignal.timeout(this.#deliveryTimeoutMs),
        },
      );
      if (!response.ok) {
        return false;
      }
      return semanticPairDeliveryReceiptSchema.parse(
        await response.json(),
      ).accepted;
    } catch {
      return false;
    }
  }

  async consult(input: DecisionConsultationRequest, report?: RuntimeFailureReport): Promise<DecisionConsultationResponse | null> {
    return this.#post("/v1/consultations", decisionConsultationRequestSchema.parse(input), decisionConsultationResponseSchema, report, {
      [CONSULTATION_SHAPE_HEADER]: CONSULTATION_SHAPE,
    });
  }

  async searchContext(input: DecisionContextQuery, report?: RuntimeFailureReport): Promise<DecisionContextResponse | null> {
    return this.#post("/v1/decision-context", decisionContextQuerySchema.parse(input), decisionContextResponseSchema, report);
  }

  async updateContextScope(input: DecisionScopeUpdate, report?: RuntimeFailureReport): Promise<DecisionScopeUpdateResult | null> {
    return this.#post("/v1/decision-context/scope", decisionScopeUpdateSchema.parse(input), decisionScopeUpdateResultSchema, report);
  }

  async updateContextRelation(input: DecisionRelationUpdate, report?: RuntimeFailureReport): Promise<DecisionRelationUpdateResult | null> {
    return this.#post("/v1/decision-context/relation", decisionRelationUpdateSchema.parse(input), decisionRelationUpdateResultSchema, report);
  }

  async updateDecisionOutcome(input: DecisionOutcomeUpdate, report?: RuntimeFailureReport): Promise<DecisionOutcomeUpdateResult | null> {
    return this.#post("/v1/decision-context/outcome", decisionOutcomeUpdateSchema.parse(input), decisionOutcomeUpdateResultSchema, report);
  }

  async prepareDecisionHandoff(input: DecisionHandoffRequest, report?: RuntimeFailureReport): Promise<DecisionHandoffResponse | null> {
    return this.#post("/v1/decision-context/handoff", decisionHandoffRequestSchema.parse(input), decisionHandoffResponseSchema, report);
  }

  async openDecisionSource(input: DecisionSourceReference, report?: RuntimeFailureReport): Promise<DecisionSourceOpenResult | null> {
    return this.#post("/v1/decision-context/open-source", decisionSourceReferenceSchema.parse(input), decisionSourceOpenResultSchema, report);
  }

  async saveDecisionContextFeedback(input: DecisionFeedbackUpdate, report?: RuntimeFailureReport): Promise<DecisionFeedbackUpdateResult | null> {
    return this.#post("/v1/decision-context/feedback", decisionFeedbackUpdateSchema.parse(input), decisionFeedbackUpdateResultSchema, report);
  }

  async getDecisionContextFeedback(input: DecisionFeedbackQuery, report?: RuntimeFailureReport): Promise<DecisionFeedbackResponse | null> {
    return this.#post("/v1/decision-context/feedback/query", decisionFeedbackQuerySchema.parse(input), decisionFeedbackResponseSchema, report);
  }

  async record(input: ProactiveRecordRequest, report?: RuntimeFailureReport): Promise<ProactiveRecordResult | null> {
    return this.#post("/v1/journal-entries", proactiveRecordRequestSchema.parse(input), proactiveRecordResultSchema, report);
  }

  async submitConsultationFeedback(
    input: DecisionConsultationFeedbackRequest,
    report?: RuntimeFailureReport,
  ): Promise<DecisionConsultationFeedbackResult | null> {
    return this.#post("/v1/consultations/feedback", decisionConsultationFeedbackRequestSchema.parse(input), decisionConsultationFeedbackResultSchema, report);
  }

  async doctor(): Promise<DoctorReport> {
    let found: Found;
    try {
      found = await this.#readRuntime(this.#healthTimeoutMs);
    } catch (error) {
      if (
        error instanceof RuntimeClientError &&
        error.code === "invalid_runtime"
      ) {
        return {
          runtimeFile: this.#runtimeFile,
          appStatus: "invalid_runtime",
          message: "Decision 的运行信息文件读不出来：请重启 Decision，它启动时会重写这个文件。在那之前的捕获留在本地队列里，App 重启后会收进来。",
        };
      }
      throw error;
    }
    if ("failure" in found && found.failure.reason === "outdated") {
      return {
        runtimeFile: this.#runtimeFile,
        appStatus: "outdated",
        message: "Decision 正在运行，但版本比这个 bridge 旧：请重启或更新 Decision。在那之前的捕获留在本地队列里，App 重启后会收进来。",
      };
    }
    // Read as not running, an App busy for a moment sent the reader to start one that was running.
    if ("failure" in found && found.failure.reason === "busy") {
      return {
        runtimeFile: this.#runtimeFile,
        appStatus: "busy",
        message: "Decision 正在运行，但没有及时回应：稍后再试；一直如此时请重启 Decision。在那之前的捕获留在本地队列里，App 会定时收进来。",
      };
    }
    if ("failure" in found || !(await this.#healthy(found.runtime))) {
      return {
        runtimeFile: this.#runtimeFile,
        appStatus: "unavailable",
        message: "Decision 没有运行或连不上：请启动 Decision。在那之前的捕获留在本地队列里，App 启动后会收进来。",
      };
    }
    return {
      runtimeFile: this.#runtimeFile,
      appStatus: "healthy",
      protocolVersion: found.runtime.protocolVersion,
      port: found.runtime.port,
    };
  }

  /**
   * The App's answer to one request, or null and why (to `report`). Nothing is sent to what cannot prove it is the
   * App, and an answer that is not a success is the App refusing, not a sign it is not running.
   */
  async #post<T>(
    path: string,
    body: unknown,
    schema: { parse(value: unknown): T },
    report: RuntimeFailureReport | undefined,
    headers: Record<string, string> = {},
  ): Promise<T | null> {
    const failed = (failure: RuntimeFailure): null => {
      report?.(failure);
      return null;
    };
    // One budget for proving the App and asking it: each given the whole of it, an App stalled on both kept an agent
    // waiting twice as long, past what its own tool call allowed, before it was told anything. Kept on the monotonic
    // clock: on the wall clock, one stepped forward meanwhile left the answer a millisecond, one stepped back an hour.
    const deadline = performance.now() + this.#contextTimeoutMs;
    const found = await this.#readRuntime(this.#contextTimeoutMs).catch((): Found => ({ failure: { reason: "not_running" } }));
    if ("failure" in found) return failed(found.failure);
    let response: Response;
    try {
      response = await this.#fetch(`http://127.0.0.1:${found.runtime.port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${found.runtime.token}`, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now()))),
      });
    } catch {
      return failed({ reason: "no_answer" });
    }
    if (!response.ok) return failed({ reason: "refused", message: await appMessage(response) });
    try {
      return schema.parse(await response.json());
    } catch {
      return failed({ reason: "no_answer" });
    }
  }

  async #readRuntime(timeoutMs: number): Promise<Found> {
    this.#runtimeFile = this.#runtimeFiles[0]!;
    let failure: RuntimeFailure = { reason: "not_running" };
    for (const runtimeFile of this.#runtimeFiles) {
      let raw: string;
      try {
        raw = await readFile(runtimeFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }
      this.#runtimeFile = runtimeFile;
      let runtime: RuntimeDescriptor;
      try {
        // Read, never removed: the file is the App's (a reader deleting it cut the App off for the rest of
        // its run), and a newer App may say more in it than this bridge knows.
        runtime = runtimeDescriptorSchema.strip().parse(JSON.parse(raw));
      } catch {
        throw new RuntimeClientError(
          "invalid_runtime",
          "Decision runtime descriptor is invalid",
        );
      }
      // Left by an App that crashed: whatever listens on its port now is not Decision, and is sent
      // neither the token nor a capture.
      if (!processAlive(runtime.pid)) continue;
      const refused = await this.#identify(runtime, timeoutMs);
      if (refused === null) return { runtime };
      failure = refused;
    }
    return { failure };
  }

  /**
   * Null when what listens on the runtime's port proves it holds the token, without being sent it; else why not.
   * Asked each time, never remembered: an MCP server's client lives as long as the agent's session, and went on
   * sending the token to whatever took the port after the App crashed. Given the operation's own time: an App
   * busy for a second was taken for none, and an agent was told it was not running.
   */
  async #identify(runtime: RuntimeDescriptor, timeoutMs: number): Promise<RuntimeFailure | null> {
    const nonce = randomBytes(32).toString("base64url");
    let response: Response;
    try {
      response = await this.#fetch(`http://127.0.0.1:${runtime.port}/v1/identity`, {
        headers: { "x-decision-challenge": nonce, "cache-control": "no-store" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Its pid alive, and no answer in time: busy, not gone.
      return { reason: timedOut(error) ? "busy" : "not_running" };
    }
    // An App from before the challenge knows no such route, and refuses it as it refuses any without the token.
    if (response.status === 401 || response.status === 404) {
      return (await this.#healthy(runtime)) ? { reason: "outdated" } : { reason: "not_running" };
    }
    try {
      if (!response.ok) return { reason: "not_running" };
      const { proof } = (await response.json()) as { proof?: unknown };
      const expected = Buffer.from(runtimeIdentityProof(runtime.token, nonce), "utf8");
      const received = Buffer.from(typeof proof === "string" ? proof : "", "utf8");
      return received.length === expected.length && timingSafeEqual(received, expected) ? null : { reason: "not_running" };
    } catch {
      return { reason: "not_running" };
    }
  }

  async #healthy(runtime: RuntimeDescriptor): Promise<boolean> {
    try {
      const response = await this.#fetch(
        `http://127.0.0.1:${runtime.port}/health`,
        {
          headers: { "cache-control": "no-store" },
          signal: AbortSignal.timeout(this.#healthTimeoutMs),
        },
      );
      if (!response.ok) {
        return false;
      }
      const body = (await response.json()) as {
        ok?: unknown;
        protocolVersion?: unknown;
      };
      return (
        body.ok === true && body.protocolVersion === PROTOCOL_VERSION
      );
    } catch {
      return false;
    }
  }
}
