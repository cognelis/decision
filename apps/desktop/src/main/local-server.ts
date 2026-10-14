import { DecisionFeedbackUpdate, DecisionFeedbackUpdateResult, decisionFeedbackUpdateSchema, decisionFeedbackUpdateResultSchema, DecisionFeedbackQuery, DecisionFeedbackResponse, decisionFeedbackQuerySchema, decisionFeedbackResponseSchema } from "@cognelis/decision-protocol";
import { fileSystemRefusal, type RationaleQueue } from "@cognelis/decision-core";
import {
  PROTOCOL_VERSION,
  capturedDecisionCandidateSchema,
  capturedDecisionEventSchema,
  decisionConsultationFeedbackRequestSchema,
  decisionConsultationFeedbackResultSchema,
  decisionConsultationRequestSchema,
  decisionConsultationResponseSchema,
  CONSULTATION_SHAPE,
  CONSULTATION_SHAPE_HEADER,
  consultationAsReleased,
  semanticDecisionPairSchema,
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
  type DecisionConsultationRequest,
  type DecisionConsultationResponse,
  type DecisionConsultationFeedbackRequest,
  type DecisionConsultationFeedbackResult,
  type SemanticDecisionPair,
  type ProactiveRecordRequest,
  type ProactiveRecordResult,
} from "@cognelis/decision-protocol";
import { runtimeIdentityProof } from "@cognelis/decision-storage";
import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { homedir } from "node:os";
import { z } from "zod";

// What lies under the home folder, not a folder whose name only begins the same way (a home "al" beside "alice"),
// with either separator: on Windows a path comes with backslashes, or slashes as the reader typed it.
const withoutHome = (text: string): string => {
  const home = homedir();
  return home.length > 1 ? text.replaceAll(`${home}/`, "~/").replaceAll(`${home}\\`, "~\\") : text;
};

/**
 * The vault in use named as 仓库目录, wherever it is: on a disk outside the home folder (/Volumes/…) its whole location
 * went on to the agent and its provider. Under it with either separator, and on its own where punctuation, the end or
 * a word follows (没有访问 … 的权限, the vault itself refused); not where a name could go on (a folder beside it whose
 * name only begins the same way, "My Vault 2").
 */
const withoutVault = (text: string, vault: string | undefined): string => {
  // A disk's root is chosen with its separator (D:\): matched without it, as the paths under it are written.
  const root = vault?.replace(/[/\\]+$/u, "");
  if (root === undefined || root.length <= 1) return text;
  const alone = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}[/\\\\]?(?=$|\\s\\p{Script=Han}|[：:，,。；;）)'"」])`, "gu");
  return text
    .replace(alone, "仓库目录")
    .replaceAll(`${root}/`, "仓库目录/")
    .replaceAll(`${root}\\`, "仓库目录\\")
    .replaceAll("仓库目录 仓库目录", "仓库目录");
};

const HOST = "127.0.0.1";
const DEFAULT_BODY_LIMIT = 256 * 1024;
// Connections that have not shown the token yet (the bridge's identity challenge, /health, a stranger's) have a few
// slots of their own, the oldest let go for each newcomer, and a short while to show it. Sharing all the slots with
// the bridge, 64 silent sockets from any local account took every one, and the bridge's own calls were reset.
// ponytail: a program opening connections faster than the bridge sends its first request can still crowd it out of
// these slots; a Unix socket in the App's own folder, which no other account can reach, is the way past that.
const UNTRUSTED_SLOTS = 16;
const UNTRUSTED_DEADLINE_MS = 2_000;

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
  recordJournalEntry?: (
    request: ProactiveRecordRequest,
  ) => ProactiveRecordResult | Promise<ProactiveRecordResult>;
  searchContext?: (input: DecisionContextQuery) => DecisionContextResponse | Promise<DecisionContextResponse>;
  updateContextScope?: (input: DecisionScopeUpdate) => Promise<DecisionScopeUpdateResult>;
  prepareDecisionHandoff?: (input: DecisionHandoffRequest) => Promise<DecisionHandoffResponse>;
  openDecisionSource?: (input: DecisionSourceReference) => Promise<DecisionSourceOpenResult>;
  saveDecisionContextFeedback?: (input: DecisionFeedbackUpdate) => Promise<DecisionFeedbackUpdateResult>;
  getDecisionContextFeedback?: (input: DecisionFeedbackQuery) => Promise<DecisionFeedbackResponse>;
  updateDecisionOutcome?: (input: DecisionOutcomeUpdate) => Promise<DecisionOutcomeUpdateResult>;
  updateContextRelation?: (input: DecisionRelationUpdate) => Promise<DecisionRelationUpdateResult>;
  token: string;
  /** The vault in use, named only as 仓库目录 in what a refusal tells the bridge. */
  vaultPath?: string;
  bodyLimit?: number;
  /** How long a connection may stay silent before it is closed. */
  idleTimeoutMs?: number;
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
  readonly #vaultPath: string | undefined;
  readonly #ingestCandidate:
    | LocalCaptureServerOptions["ingestCandidate"]
    | undefined;
  readonly #ingestSemanticPair:
    | LocalCaptureServerOptions["ingestSemanticPair"]
    | undefined;
  readonly #consult: LocalCaptureServerOptions["consult"];
  readonly #submitConsultationFeedback: LocalCaptureServerOptions["submitConsultationFeedback"];
  readonly #recordJournalEntry: LocalCaptureServerOptions["recordJournalEntry"];
  readonly #searchContext: LocalCaptureServerOptions["searchContext"];
  readonly #updateContextScope: LocalCaptureServerOptions["updateContextScope"];
  readonly #prepareDecisionHandoff: LocalCaptureServerOptions["prepareDecisionHandoff"];
  readonly #openDecisionSource: LocalCaptureServerOptions["openDecisionSource"];
  readonly #saveDecisionContextFeedback: LocalCaptureServerOptions["saveDecisionContextFeedback"];
  readonly #getDecisionContextFeedback: LocalCaptureServerOptions["getDecisionContextFeedback"];
  readonly #updateDecisionOutcome: LocalCaptureServerOptions["updateDecisionOutcome"];
  readonly #updateContextRelation: LocalCaptureServerOptions["updateContextRelation"];
  readonly #bodyLimit: number;
  readonly #idleTimeoutMs: number;
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
    this.#vaultPath = options.vaultPath;
    this.#ingestCandidate = options.ingestCandidate;
    this.#ingestSemanticPair = options.ingestSemanticPair;
    this.#consult = options.consult;
    this.#submitConsultationFeedback = options.submitConsultationFeedback;
    this.#recordJournalEntry = options.recordJournalEntry;
    this.#searchContext = options.searchContext;
    this.#updateContextScope = options.updateContextScope;
    this.#prepareDecisionHandoff = options.prepareDecisionHandoff;
    this.#openDecisionSource = options.openDecisionSource;
    this.#saveDecisionContextFeedback = options.saveDecisionContextFeedback;
    this.#getDecisionContextFeedback = options.getDecisionContextFeedback;
    this.#updateDecisionOutcome = options.updateDecisionOutcome;
    this.#updateContextRelation = options.updateContextRelation;
    this.#bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
    this.#smokeMode = options.smokeMode ?? false;
    this.#smokeShutdown = options.smokeShutdown;
  }

  async start(): Promise<LocalServerAddress> {
    if (this.#server !== null && this.#address !== null) {
      return this.#address;
    }
    // Any local program may connect, token or not: connections are capped and one that sends nothing is closed
    // within seconds. Uncapped, a few hundred idle sockets took every file descriptor the App had (256 when opened
    // from Finder), and it could no longer open a note, the index or the capture spool.
    const untrusted = new Map<Socket, NodeJS.Timeout>();
    const letGo = (socket: Socket): void => {
      clearTimeout(untrusted.get(socket));
      untrusted.delete(socket);
    };
    const server = createServer({ headersTimeout: 15_000, requestTimeout: 20_000, connectionsCheckingInterval: 1_000 }, (request, response) => {
      // Shown the token: one of the bridge's, out of the few slots kept for those that have not, and of their deadline.
      if (untrusted.has(request.socket) && bearerMatches(request.headers.authorization, this.#token)) letGo(request.socket);
      void this.#handle(request, response).catch((error: unknown) => {
        // Which route failed and how, never what was sent: enough to find it, nothing of the reader's.
        const route = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const reason = (error as NodeJS.ErrnoException | undefined)?.code ?? (error instanceof Error ? error.name : "error");
        console.error(`[decision] ${request.method ?? "?"} ${route} failed: ${reason}`);
        // Why, to the bridge that holds the token: told nothing, it told an agent Decision might not be running,
        // and the reader went to start an App that was running and refused (a vault it could not find). Without the
        // reader's home folder: a vault's path, the account's name in it, went on to the agent and its provider.
        sendJson(response, 500, {
          error: "internal_error",
          // A disk full or a folder refused said in words (fileSystemRefusal), as the page says it, not Node's own line.
          ...(error instanceof Error && error.message !== ""
            ? { message: withoutHome(withoutVault(fileSystemRefusal(error) ?? error.message, this.#vaultPath)).slice(0, 500) }
            : {}),
        });
      });
    });
    server.maxConnections = 64;
    server.on("connection", (socket: Socket) => {
      if (untrusted.size >= UNTRUSTED_SLOTS) {
        const [oldest] = untrusted.keys();
        if (oldest !== undefined) {
          letGo(oldest);
          oldest.destroy();
        }
      }
      const deadline = setTimeout(() => {
        letGo(socket);
        socket.destroy();
      }, UNTRUSTED_DEADLINE_MS);
      deadline.unref();
      untrusted.set(socket, deadline);
      socket.once("close", () => letGo(socket));
    });
    // A socket that sends nothing is no request yet, and no request timeout reaches it: closed once idle this long.
    // Shorter than headersTimeout, or Node never closes a silent one (measured on Node 22: 6 s idle against 4 s of
    // headers, still open after 9 s).
    server.timeout = this.#idleTimeoutMs;
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

    // Asked by a bridge before it sends the token: proof that this server holds it, and nothing else.
    if (request.method === "GET" && url.pathname === "/v1/identity") {
      const nonce = request.headers["x-decision-challenge"];
      if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(nonce)) {
        sendJson(response, 400, { error: "invalid_challenge" });
        return;
      }
      sendJson(response, 200, { proof: runtimeIdentityProof(this.#token, nonce) });
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

    if (request.method === "POST" && url.pathname === "/v1/decision-context" && this.#searchContext !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionContextQuerySchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionContextResponseSchema.parse(await this.#searchContext(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/scope" && this.#updateContextScope !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionScopeUpdateSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionScopeUpdateResultSchema.parse(await this.#updateContextScope(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/relation" && this.#updateContextRelation !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionRelationUpdateSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionRelationUpdateResultSchema.parse(await this.#updateContextRelation(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/handoff" && this.#prepareDecisionHandoff !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionHandoffRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionHandoffResponseSchema.parse(await this.#prepareDecisionHandoff(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/open-source" && this.#openDecisionSource !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionSourceReferenceSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionSourceOpenResultSchema.parse(await this.#openDecisionSource(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/feedback" && this.#saveDecisionContextFeedback !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionFeedbackUpdateSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionFeedbackUpdateResultSchema.parse(await this.#saveDecisionContextFeedback(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/feedback/query" && this.#getDecisionContextFeedback !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionFeedbackQuerySchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionFeedbackResponseSchema.parse(await this.#getDecisionContextFeedback(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/outcome" && this.#updateDecisionOutcome !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionOutcomeUpdateSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionOutcomeUpdateResultSchema.parse(await this.#updateDecisionOutcome(parsed.data)));
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
      url.pathname === "/v1/journal-entries" &&
      this.#recordJournalEntry !== undefined
    ) {
      await this.#handleJournalEntry(request, response);
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
    const answer = decisionConsultationResponseSchema.parse(result);
    // Asked without the header by a bridge from 1.1.0 or soon after, still running in an open session.
    sendJson(
      response,
      200,
      request.headers[CONSULTATION_SHAPE_HEADER] === CONSULTATION_SHAPE ? answer : consultationAsReleased(answer),
    );
  }

  async #handleJournalEntry(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const input = await this.#readJson(request, response);
    if (input === undefined) return;
    const parsed = proactiveRecordRequestSchema.safeParse(input);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const result = await this.#recordJournalEntry?.(parsed.data);
    if (result === undefined) {
      sendJson(response, 503, { error: "recording_unavailable" });
      return;
    }
    sendJson(response, 200, proactiveRecordResultSchema.parse(result));
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
