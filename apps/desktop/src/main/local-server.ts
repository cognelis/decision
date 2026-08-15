import type { RationaleQueue } from "@cognelis/decision-core";
import {
  PROTOCOL_VERSION,
  capturedDecisionCandidateSchema,
  capturedDecisionEventSchema,
  decisionConsultationFeedbackRequestSchema,
  decisionConsultationFeedbackResultSchema,
  decisionConsultationRequestSchema,
  decisionConsultationResponseSchema,
  semanticDecisionPairSchema,
  type CaptureReceipt,
  type CapturedDecisionCandidate,
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
  type DecisionConsultationFeedbackRequest,
  type DecisionConsultationFeedbackResult,
  type SemanticDecisionPair,
} from "@cognelis/decision-protocol";
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";

const HOST = "127.0.0.1";
const DEFAULT_BODY_LIMIT = 256 * 1024;

export interface LocalCaptureServerOptions {
  queue: RationaleQueue;
  ingest?: (
    event: z.infer<typeof capturedDecisionEventSchema>,
  ) => CaptureReceipt | Promise<CaptureReceipt>;
  ingestCandidate?: (
    candidate: CapturedDecisionCandidate,
  ) => void | Promise<void>;
  ingestSemanticPair?: (
    pair: SemanticDecisionPair,
  ) => void | Promise<void>;
  consult?: (
    request: DecisionConsultationRequest,
  ) => DecisionConsultationResponse | Promise<DecisionConsultationResponse>;
  submitConsultationFeedback?: (
    feedback: DecisionConsultationFeedbackRequest,
  ) =>
    | DecisionConsultationFeedbackResult
    | Promise<DecisionConsultationFeedbackResult>;
  token: string;
  bodyLimit?: number;
  smokeMode?: boolean;
  smokeShutdown?: () => void;
}

export interface LocalServerAddress {
  host: string;
  port: number;
}

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}

const smokeCompletionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("captured"),
      rationale: z
        .string()
        .max(8_000)
        .refine((value) => value.trim().length > 0),
      reasonFactors: z.array(z.string().min(1).max(64)).max(8).optional(),
    })
    .strict(),
  z
    .object({
      status: z.enum(["deferred", "skipped", "not_recorded"]),
    })
    .strict(),
]);

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
};

const sendEmpty = (response: ServerResponse, status: number): void => {
  if (response.writableEnded || response.destroyed) {
    return;
  }
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
};

const bearerMatches = (
  authorization: string | undefined,
  token: string,
): boolean => {
  if (authorization === undefined) {
    return false;
  }
  const received = Buffer.from(authorization, "utf8");
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
};

const readBody = (
  request: IncomingMessage,
  maximumBytes: number,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (operation: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      operation();
    };
    const timer = setTimeout(() => {
      settle(() => reject(new BodyTimeoutError("Request body timed out")));
      request.resume();
    }, 10_000);
    timer.unref();

    request.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > maximumBytes) {
        clearTimeout(timer);
        settle(() =>
          reject(new BodyTooLargeError("Request body is too large")),
        );
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      clearTimeout(timer);
      settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      settle(() => reject(error));
    });
  });

export class LocalCaptureServer {
  readonly #queue: RationaleQueue;
  readonly #ingest: (
    event: z.infer<typeof capturedDecisionEventSchema>,
  ) => CaptureReceipt | Promise<CaptureReceipt>;
  readonly #token: string;
  readonly #ingestCandidate:
    | LocalCaptureServerOptions["ingestCandidate"]
    | undefined;
  readonly #ingestSemanticPair:
    | LocalCaptureServerOptions["ingestSemanticPair"]
    | undefined;
  readonly #consult: LocalCaptureServerOptions["consult"];
  readonly #submitConsultationFeedback: LocalCaptureServerOptions["submitConsultationFeedback"];
  readonly #bodyLimit: number;
  readonly #smokeMode: boolean;
  readonly #smokeShutdown: (() => void) | undefined;
  #server: Server | null = null;
  #address: LocalServerAddress | null = null;

  constructor(options: LocalCaptureServerOptions) {
    this.#queue = options.queue;
    this.#ingest =
      options.ingest ??
      ((event) => this.#queue.ingest(event));
    this.#token = options.token;
    this.#ingestCandidate = options.ingestCandidate;
    this.#ingestSemanticPair = options.ingestSemanticPair;
    this.#consult = options.consult;
    this.#submitConsultationFeedback = options.submitConsultationFeedback;
    this.#bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
    this.#smokeMode = options.smokeMode ?? false;
    this.#smokeShutdown = options.smokeShutdown;
  }

  async start(): Promise<LocalServerAddress> {
    if (this.#server !== null && this.#address !== null) {
      return this.#address;
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        sendJson(response, 500, { error: "internal_error" });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, HOST, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Local capture server did not bind a TCP address");
    }
    this.#server = server;
    this.#address = { host: HOST, port: address.port };
    return this.#address;
  }

  address(): LocalServerAddress {
    if (this.#address === null) {
      throw new Error("Local capture server is not running");
    }
    return this.#address;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#address = null;
    if (server === null) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
      server.closeAllConnections();
    });
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
      });
      return;
    }

    if (!bearerMatches(request.headers.authorization, this.#token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/captures") {
      await this.#handleCapture(request, response);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/candidates" &&
      this.#ingestCandidate !== undefined
    ) {
      await this.#handleCandidate(request, response);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/semantic-pairs" &&
      this.#ingestSemanticPair !== undefined
    ) {
      await this.#handleSemanticPair(request, response);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/consultations" &&
      this.#consult !== undefined
    ) {
      await this.#handleConsultation(request, response);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/consultations/feedback" &&
      this.#submitConsultationFeedback !== undefined
    ) {
      await this.#handleConsultationFeedback(request, response);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/smoke/complete" &&
      this.#smokeMode
    ) {
      await this.#handleSmokeCompletion(request, response);
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/smoke/shutdown" &&
      this.#smokeMode &&
      this.#smokeShutdown !== undefined
    ) {
      sendEmpty(response, 204);
      queueMicrotask(this.#smokeShutdown);
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  }

  async #readJson(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<unknown | undefined> {
    let rawBody: string;
    try {
      rawBody = await readBody(request, this.#bodyLimit);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        sendJson(response, 413, { error: "body_too_large" });
        return undefined;
      }
      if (error instanceof BodyTimeoutError) {
        sendJson(response, 408, { error: "body_timeout" });
        return undefined;
      }
      throw error;
    }
    try {
      return JSON.parse(rawBody) as unknown;
    } catch {
      sendJson(response, 400, { error: "invalid_json" });
      return undefined;
    }
  }

  async #handleCapture(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await this.#readJson(request, response);
    if (input === undefined) {
      return;
    }
    const parsed = capturedDecisionEventSchema.safeParse(input);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const receipt = await this.#ingest(parsed.data);
    sendJson(response, 202, receipt);
  }

  async #handleCandidate(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await this.#readJson(request, response);
    if (input === undefined) {
      return;
    }
    const parsed =
      capturedDecisionCandidateSchema.safeParse(input);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    await this.#ingestCandidate?.(parsed.data);
    sendEmpty(response, 202);
  }

  async #handleSemanticPair(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await this.#readJson(request, response);
    if (input === undefined) {
      return;
    }
    const parsed = semanticDecisionPairSchema.safeParse(input);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    await this.#ingestSemanticPair?.(parsed.data);
    sendJson(response, 202, { accepted: true });
  }

  async #handleConsultation(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await this.#readJson(request, response);
    if (input === undefined) {
      return;
    }
    const parsed = decisionConsultationRequestSchema.safeParse(input);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const result = await this.#consult?.(parsed.data);
    if (result === undefined) {
      sendJson(response, 503, { error: "consultation_unavailable" });
      return;
    }
    sendJson(
      response,
      200,
      decisionConsultationResponseSchema.parse(result),
    );
  }

  async #handleConsultationFeedback(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await this.#readJson(request, response);
    if (input === undefined) return;
    const parsed = decisionConsultationFeedbackRequestSchema.safeParse(input);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const result = await this.#submitConsultationFeedback?.(parsed.data);
    if (result === undefined) {
      sendJson(response, 503, { error: "feedback_unavailable" });
      return;
    }
    sendJson(
      response,
      200,
      decisionConsultationFeedbackResultSchema.parse(result),
    );
  }

  async #handleSmokeCompletion(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await this.#readJson(request, response);
    if (input === undefined) {
      return;
    }
    const parsed = smokeCompletionSchema.safeParse(input);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    if (this.#queue.snapshot().current?.status !== "awaiting_rationale") {
      sendJson(response, 409, { error: "rationale_not_ready" });
      return;
    }
    await this.#queue.submit(
      parsed.data.status === "captured"
        ? {
            status: "captured",
            rationale: parsed.data.rationale,
            ...(parsed.data.reasonFactors === undefined
              ? {}
              : { reasonFactors: parsed.data.reasonFactors }),
          }
        : { status: parsed.data.status },
    );
    sendEmpty(response, 204);
  }
}
