import {
  prListToolQuerySchema,
  prListToolResultSchema,
  prDescriptionDraftQuerySchema,
  prDescriptionDraftResultSchema,
  prReviewRunToolRequestSchema,
  prReviewRunToolResultSchema,
  type PrReviewRunToolRequest,
  type PrReviewRunToolResult,
  localReviewJobRecordSchema,
  localReviewJobRecordResultSchema,
  localReviewJobsQuerySchema,
  localReviewJobsResultSchema,
  localReviewJobRequestSchema,
  localReviewJobResultSchema,
  localReviewJobUpdateSchema,
  localReviewJobUpdateResultSchema,
  type LocalReviewJobRecord,
  type LocalReviewJobRecordResult,
  type LocalReviewJobsQuery,
  type LocalReviewJobsResult,
  type LocalReviewJobRequest,
  type LocalReviewJobResult,
  type LocalReviewJobUpdate,
  type LocalReviewJobUpdateResult,
  prReviewSettingsQuerySchema,
  prReviewSettingsResultSchema,
  reviewQualityQuerySchema,
  reviewQualityResultSchema,
  reviewEscapeRecordSchema,
  reviewEscapeRecordResultSchema,
  reviewBenchmarkRunRequestSchema,
  reviewBenchmarkRunStartSchema,
  reviewPromotionsQuerySchema,
  reviewPromotionsResultSchema,
  type ReviewPromotionsQuery,
  type ReviewPromotionsResult,
  reviewBenchmarkRunsQuerySchema,
  reviewBenchmarkRunsResultSchema,
  reviewBenchmarkRunQuerySchema,
  reviewBenchmarkRunResultSchema,
  type ReviewBenchmarkRunRequest,
  type ReviewBenchmarkRunStart,
  type ReviewBenchmarkRunsQuery,
  type ReviewBenchmarkRunsResult,
  type ReviewBenchmarkRunQuery,
  type ReviewBenchmarkRunResult,
  reviewEscapesQuerySchema,
  reviewEscapesResultSchema,
  reviewEscapeUpdateSchema,
  reviewEscapeUpdateResultSchema,
  type ReviewEscapeRecord,
  type ReviewEscapeRecordResult,
  type ReviewEscapesQuery,
  type ReviewEscapesResult,
  type ReviewEscapeUpdate,
  type ReviewEscapeUpdateResult,
  reviewRuleUpdateSchema,
  reviewRuleUpdateResultSchema,
  type ReviewQualityQuery,
  type ReviewQualityResult,
  type ReviewRuleUpdate,
  type ReviewRuleUpdateResult,
  prReviewSettingsUpdateSchema,
  prReviewSettingsUpdateResultSchema,
  type PrReviewSettingsQuery,
  type PrReviewSettingsResult,
  type PrReviewSettingsUpdate,
  type PrReviewSettingsUpdateResult,
  prCommentsToolQuerySchema,
  prCommentsToolResultSchema,
  prCommentUpdateToolSchema,
  prCommentUpdateToolResultSchema,
  type PrCommentsToolQuery,
  type PrCommentsToolResult,
  type PrCommentUpdateTool,
  type PrCommentUpdateToolResult,
  prUpdateRequestSchema,
  prUpdateResultSchema,
  type PrDescriptionDraftQuery,
  type PrDescriptionDraftResult,
  type PrUpdateRequest,
  type PrUpdateResult,
  prReviewCommentsRecordSchema,
  prReviewCommentsResultSchema,
  prReviewFindingUpdateSchema,
  prReviewFindingUpdateResultSchema,
  prReviewRecordRequestSchema,
  prReviewRecordResultSchema,
  prReviewRecordsQuerySchema,
  prReviewRecordsResultSchema,
  type PrListToolQuery,
  type PrListToolResult,
  type PrReviewCommentsRecord,
  type PrReviewCommentsResult,
  type PrReviewFindingUpdate,
  type PrReviewFindingUpdateResult,
  type PrReviewRecordRequest,
  type PrReviewRecordResult,
  type PrReviewRecordsQuery,
  type PrReviewRecordsResult,
  reviewBenchmarkGetRequestSchema,
  reviewBenchmarkGetResultSchema,
  reviewBenchmarkListRequestSchema,
  reviewBenchmarkListResultSchema,
  reviewBenchmarkRecordRequestSchema,
  reviewBenchmarkRecordResultSchema,
  reviewBenchmarkUpdateRequestSchema,
  reviewBenchmarkUpdateResultSchema,
  type ReviewBenchmarkGetRequest,
  type ReviewBenchmarkGetResult,
  type ReviewBenchmarkListRequest,
  type ReviewBenchmarkListResult,
  type ReviewBenchmarkRecordRequest,
  type ReviewBenchmarkRecordResult,
  type ReviewBenchmarkUpdateRequest,
  type ReviewBenchmarkUpdateResult,
} from "@cognelis/decision-protocol";
import { DecisionFeedbackUpdate, DecisionFeedbackUpdateResult, decisionFeedbackUpdateSchema, decisionFeedbackUpdateResultSchema, DecisionFeedbackQuery, DecisionFeedbackResponse, decisionFeedbackQuerySchema, decisionFeedbackResponseSchema } from "@cognelis/decision-protocol";
import {
  TODO_SHAPE_HEADER,
  decisionAmendmentRequestSchema,
  decisionAmendmentResultSchema,
  proactiveResultAsReleased,
  type DecisionAmendmentRequest,
  type DecisionAmendmentResult,
  contextShapeLevel,
  contextShapeNeeded,
  CONTEXT_SHAPE_HEADER,
  contextAsReleased,
  todoAnswerFor,
  todoItemUpdateRequestSchema,
  todoItemUpdateResultSchema,
  todoListQuerySchema,
  todoListResponseSchema,
  todoRecordRequestSchema,
  todoRecordResultSchema,
  type TodoItemUpdateRequest,
  type TodoItemUpdateResult,
  type TodoListQuery,
  type TodoListResponse,
  type TodoRecordRequest,
  type TodoRecordResult,
} from "@cognelis/decision-protocol";
import {
  getHistoricalDecisionRequestSchema,
  getHistoricalDecisionResultSchema,
  listHistoricalDecisionsRequestSchema,
  listHistoricalDecisionsResultSchema,
  recordHistoricalDecisionRequestSchema,
  recordHistoricalDecisionResultSchema,
  updateHistoricalDecisionRequestSchema,
  openHistoricalDecisionRequestSchema,
  openHistoricalDecisionResultSchema,
  type OpenHistoricalDecisionRequest,
  type OpenHistoricalDecisionResult,
  updateHistoricalDecisionResultSchema,
  type GetHistoricalDecisionRequest,
  type GetHistoricalDecisionResult,
  type ListHistoricalDecisionsRequest,
  type ListHistoricalDecisionsResult,
  type RecordHistoricalDecisionRequest,
  type RecordHistoricalDecisionResult,
  type UpdateHistoricalDecisionRequest,
  type UpdateHistoricalDecisionResult,
} from "@cognelis/decision-protocol";
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
  obsidianNoteReadRequestSchema,
  obsidianNoteReadResponseSchema,
  obsidianNoteSearchRequestSchema,
  obsidianNoteSearchResponseSchema,
  type ObsidianNoteReadRequest,
  type ObsidianNoteReadResponse,
  type ObsidianNoteSearchRequest,
  type ObsidianNoteSearchResponse,
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
/** How long record_pr_comments may take, its comments posted one after another: past the bridge's 55 seconds for it. */
const PR_COMMENTS_SOCKET_MS = 60_000;
/** A local review's worker is checked before comments are handed to it: up to a couple of minutes. */
const LOCAL_REVIEW_SOCKET_MS = 180_000;

export interface LocalCaptureServerOptions {
  queue: RationaleQueue;
  /** Each request but a health check: an agent at work, which a background organization run gives way to (IMP-191). */
  onRequest?: (path: string) => void;
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
  updateDecisionAmendment?: (input: DecisionAmendmentRequest) => Promise<DecisionAmendmentResult>;
  prepareDecisionHandoff?: (input: DecisionHandoffRequest) => Promise<DecisionHandoffResponse>;
  openDecisionSource?: (input: DecisionSourceReference) => Promise<DecisionSourceOpenResult>;
  /** The reader's ordinary notes the note index keeps, read-only (obsidian-note-tools.ts). */
  searchObsidianNotes?: (input: ObsidianNoteSearchRequest) => Promise<ObsidianNoteSearchResponse>;
  readObsidianNote?: (input: ObsidianNoteReadRequest) => Promise<ObsidianNoteReadResponse>;
  saveDecisionContextFeedback?: (input: DecisionFeedbackUpdate) => Promise<DecisionFeedbackUpdateResult>;
  getDecisionContextFeedback?: (input: DecisionFeedbackQuery) => Promise<DecisionFeedbackResponse>;
  updateDecisionOutcome?: (input: DecisionOutcomeUpdate) => Promise<DecisionOutcomeUpdateResult>;
  updateContextRelation?: (input: DecisionRelationUpdate) => Promise<DecisionRelationUpdateResult>;
  /** 待办清单: an agent reads them, saves its findings as one, and records progress on an item. */
  /** 历史决定: an agent records one, lists them, reads one, and changes one, each only when the user asks. */
  recordHistoricalDecision?: (input: RecordHistoricalDecisionRequest) => Promise<RecordHistoricalDecisionResult>;
  listHistoricalDecisions?: (input: ListHistoricalDecisionsRequest) => Promise<ListHistoricalDecisionsResult>;
  getHistoricalDecision?: (input: GetHistoricalDecisionRequest) => Promise<GetHistoricalDecisionResult>;
  updateHistoricalDecision?: (input: UpdateHistoricalDecisionRequest) => Promise<UpdateHistoricalDecisionResult>;
  /** Opens a record's note, or a link or related note it names, on this machine: only when the user asks. */
  openHistoricalDecision?: (input: OpenHistoricalDecisionRequest) => Promise<OpenHistoricalDecisionResult>;
  listTodos?: (input: TodoListQuery) => Promise<TodoListResponse>;
  recordTodos?: (input: TodoRecordRequest) => Promise<TodoRecordResult>;
  /**
   * `oldHigh`: the request came from a bridge from before P0–P3 (shape below 4) and said 「high」, which that bridge was
   * told for P0 and P1 alike: on an item that is P0 it changes nothing.
   */
  updateTodoItem?: (input: TodoItemUpdateRequest, context?: { oldHigh: boolean }) => Promise<TodoItemUpdateResult>;
  /** 评审评测集: an agent records candidate cases, lists and reads them, and changes one (review-benchmark-service.ts). */
  recordReviewBenchmarkCases?: (input: ReviewBenchmarkRecordRequest) => Promise<ReviewBenchmarkRecordResult>;
  listReviewBenchmarkCases?: (input: ReviewBenchmarkListRequest) => Promise<ReviewBenchmarkListResult>;
  getReviewBenchmarkCase?: (input: ReviewBenchmarkGetRequest) => Promise<ReviewBenchmarkGetResult>;
  updateReviewBenchmarkCase?: (input: ReviewBenchmarkUpdateRequest) => Promise<ReviewBenchmarkUpdateResult>;
  /** PR 评审, read-only for an agent: the platform's PR lists, and the review records the App keeps (pr-review-records.ts). */
  listPrsForAgent?: (input: PrListToolQuery) => Promise<PrListToolResult>;
  listPrReviewRecords?: (input: PrReviewRecordsQuery) => Promise<PrReviewRecordsResult>;
  getPrReviewRecord?: (input: PrReviewRecordRequest) => Promise<PrReviewRecordResult>;
  /** And what an agent writes, as the review page does: 不采纳 or 撤回 a finding, and post findings to the PR. */
  updatePrReviewFinding?: (input: PrReviewFindingUpdate) => Promise<PrReviewFindingUpdateResult>;
  recordPrComments?: (input: PrReviewCommentsRecord) => Promise<PrReviewCommentsResult>;
  /** PR 描述三段: drafted where the description lacks them, and written back as the user confirmed it. */
  prDescriptionDraft?: (input: PrDescriptionDraftQuery) => Promise<PrDescriptionDraftResult>;
  updatePr?: (input: PrUpdateRequest) => Promise<PrUpdateResult>;
  /** A review an agent starts: answered once it is running, its record the way back to the result. */
  runPrReview?: (input: PrReviewRunToolRequest) => Promise<PrReviewRunToolResult>;
  /** 作者回应: the comments on the user's own PR, and one answered with a standard reply. */
  listPrComments?: (input: PrCommentsToolQuery) => Promise<PrCommentsToolResult>;
  updatePrComment?: (input: PrCommentUpdateTool) => Promise<PrCommentUpdateToolResult>;
  /** 自动预评审's settings for agents: read, and turned on or off when the user says so. */
  getPrReviewSettings?: (input: PrReviewSettingsQuery) => Promise<PrReviewSettingsResult>;
  updatePrReviewSettings?: (input: PrReviewSettingsUpdate) => Promise<PrReviewSettingsUpdateResult>;
  /** 评审质量 for agents: read one link's, and one of Paraself's own rules turned off or on when the user says so. */
  getReviewQuality?: (input: ReviewQualityQuery) => Promise<ReviewQualityResult>;
  updateReviewRule?: (input: ReviewRuleUpdate) => Promise<ReviewRuleUpdateResult>;
  /** 漏网复盘 for agents: one the user names recorded, the list read, its four lines written or settled when the user says so. */
  recordReviewEscape?: (input: ReviewEscapeRecord) => Promise<ReviewEscapeRecordResult>;
  listReviewEscapes?: (input: ReviewEscapesQuery) => Promise<ReviewEscapesResult>;
  updateReviewEscape?: (input: ReviewEscapeUpdate) => Promise<ReviewEscapeUpdateResult>;
  /** 评测运行 for agents: started when the user asks, runs listed, one read with its comparison. */
  runReviewBenchmark?: (input: ReviewBenchmarkRunRequest) => Promise<ReviewBenchmarkRunStart>;
  listReviewBenchmarkRuns?: (input: ReviewBenchmarkRunsQuery) => Promise<ReviewBenchmarkRunsResult>;
  getReviewBenchmarkRun?: (input: ReviewBenchmarkRunQuery) => Promise<ReviewBenchmarkRunResult>;
  /** 晋升提议 for agents, read-only. */
  listRulePromotionCandidates?: (input: ReviewPromotionsQuery) => Promise<ReviewPromotionsResult>;
  /** 本地审阅 for agents: a batch of comments handed over, and its tasks read, cancelled or retried. */
  recordLocalReviewJob?: (input: LocalReviewJobRecord) => Promise<LocalReviewJobRecordResult>;
  listLocalReviewJobs?: (input: LocalReviewJobsQuery) => Promise<LocalReviewJobsResult>;
  getLocalReviewJob?: (input: LocalReviewJobRequest) => Promise<LocalReviewJobResult>;
  updateLocalReviewJob?: (input: LocalReviewJobUpdate) => Promise<LocalReviewJobUpdateResult>;
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

/** The todo answer shape a bridge asked for (see TODO_SHAPE_HEADER); none: IMP-183's. */
const shapeOf = (request: IncomingMessage): string | undefined => {
  const header = request.headers[TODO_SHAPE_HEADER];
  return Array.isArray(header) ? header[0] : header;
};

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
  readonly #onRequest: LocalCaptureServerOptions["onRequest"];
  readonly #updateContextScope: LocalCaptureServerOptions["updateContextScope"];
  readonly #updateDecisionAmendment: LocalCaptureServerOptions["updateDecisionAmendment"];
  readonly #prepareDecisionHandoff: LocalCaptureServerOptions["prepareDecisionHandoff"];
  readonly #openDecisionSource: LocalCaptureServerOptions["openDecisionSource"];
  readonly #searchObsidianNotes: LocalCaptureServerOptions["searchObsidianNotes"];
  readonly #readObsidianNote: LocalCaptureServerOptions["readObsidianNote"];
  readonly #saveDecisionContextFeedback: LocalCaptureServerOptions["saveDecisionContextFeedback"];
  readonly #getDecisionContextFeedback: LocalCaptureServerOptions["getDecisionContextFeedback"];
  readonly #updateDecisionOutcome: LocalCaptureServerOptions["updateDecisionOutcome"];
  readonly #updateContextRelation: LocalCaptureServerOptions["updateContextRelation"];
  readonly #recordHistoricalDecision: LocalCaptureServerOptions["recordHistoricalDecision"];
  readonly #listHistoricalDecisions: LocalCaptureServerOptions["listHistoricalDecisions"];
  readonly #getHistoricalDecision: LocalCaptureServerOptions["getHistoricalDecision"];
  readonly #updateHistoricalDecision: LocalCaptureServerOptions["updateHistoricalDecision"];
  readonly #openHistoricalDecision: LocalCaptureServerOptions["openHistoricalDecision"];
  readonly #listTodos: LocalCaptureServerOptions["listTodos"];
  readonly #recordTodos: LocalCaptureServerOptions["recordTodos"];
  readonly #updateTodoItem: LocalCaptureServerOptions["updateTodoItem"];
  readonly #recordReviewBenchmarkCases: LocalCaptureServerOptions["recordReviewBenchmarkCases"];
  readonly #listReviewBenchmarkCases: LocalCaptureServerOptions["listReviewBenchmarkCases"];
  readonly #getReviewBenchmarkCase: LocalCaptureServerOptions["getReviewBenchmarkCase"];
  readonly #updateReviewBenchmarkCase: LocalCaptureServerOptions["updateReviewBenchmarkCase"];
  readonly #listPrsForAgent: LocalCaptureServerOptions["listPrsForAgent"];
  readonly #listPrReviewRecords: LocalCaptureServerOptions["listPrReviewRecords"];
  readonly #getPrReviewRecord: LocalCaptureServerOptions["getPrReviewRecord"];
  readonly #updatePrReviewFinding: LocalCaptureServerOptions["updatePrReviewFinding"];
  readonly #recordPrComments: LocalCaptureServerOptions["recordPrComments"];
  readonly #prDescriptionDraft: LocalCaptureServerOptions["prDescriptionDraft"];
  readonly #updatePr: LocalCaptureServerOptions["updatePr"];
  readonly #runPrReview: LocalCaptureServerOptions["runPrReview"];
  readonly #listPrComments: LocalCaptureServerOptions["listPrComments"];
  readonly #updatePrComment: LocalCaptureServerOptions["updatePrComment"];
  readonly #localReviewTools: { [K in "recordLocalReviewJob" | "listLocalReviewJobs" | "getLocalReviewJob" | "updateLocalReviewJob" | "getPrReviewSettings" | "updatePrReviewSettings" | "getReviewQuality" | "updateReviewRule" | "recordReviewEscape" | "listReviewEscapes" | "updateReviewEscape" | "runReviewBenchmark" | "listReviewBenchmarkRuns" | "getReviewBenchmarkRun" | "listRulePromotionCandidates"]: LocalCaptureServerOptions[K] };
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
    this.#onRequest = options.onRequest;
    this.#updateContextScope = options.updateContextScope;
    this.#updateDecisionAmendment = options.updateDecisionAmendment;
    this.#prepareDecisionHandoff = options.prepareDecisionHandoff;
    this.#openDecisionSource = options.openDecisionSource;
    this.#searchObsidianNotes = options.searchObsidianNotes;
    this.#readObsidianNote = options.readObsidianNote;
    this.#saveDecisionContextFeedback = options.saveDecisionContextFeedback;
    this.#getDecisionContextFeedback = options.getDecisionContextFeedback;
    this.#updateDecisionOutcome = options.updateDecisionOutcome;
    this.#updateContextRelation = options.updateContextRelation;
    this.#recordHistoricalDecision = options.recordHistoricalDecision;
    this.#listHistoricalDecisions = options.listHistoricalDecisions;
    this.#getHistoricalDecision = options.getHistoricalDecision;
    this.#updateHistoricalDecision = options.updateHistoricalDecision;
    this.#openHistoricalDecision = options.openHistoricalDecision;
    this.#listTodos = options.listTodos;
    this.#recordTodos = options.recordTodos;
    this.#updateTodoItem = options.updateTodoItem;
    this.#recordReviewBenchmarkCases = options.recordReviewBenchmarkCases;
    this.#listReviewBenchmarkCases = options.listReviewBenchmarkCases;
    this.#getReviewBenchmarkCase = options.getReviewBenchmarkCase;
    this.#updateReviewBenchmarkCase = options.updateReviewBenchmarkCase;
    this.#listPrsForAgent = options.listPrsForAgent;
    this.#listPrReviewRecords = options.listPrReviewRecords;
    this.#getPrReviewRecord = options.getPrReviewRecord;
    this.#updatePrReviewFinding = options.updatePrReviewFinding;
    this.#recordPrComments = options.recordPrComments;
    this.#prDescriptionDraft = options.prDescriptionDraft;
    this.#updatePr = options.updatePr;
    this.#runPrReview = options.runPrReview;
    this.#listPrComments = options.listPrComments;
    this.#updatePrComment = options.updatePrComment;
    this.#localReviewTools = { recordLocalReviewJob: options.recordLocalReviewJob, listLocalReviewJobs: options.listLocalReviewJobs, getLocalReviewJob: options.getLocalReviewJob, updateLocalReviewJob: options.updateLocalReviewJob,
      getPrReviewSettings: options.getPrReviewSettings, updatePrReviewSettings: options.updatePrReviewSettings, getReviewQuality: options.getReviewQuality, updateReviewRule: options.updateReviewRule,
      recordReviewEscape: options.recordReviewEscape, listReviewEscapes: options.listReviewEscapes, updateReviewEscape: options.updateReviewEscape,
      runReviewBenchmark: options.runReviewBenchmark, listReviewBenchmarkRuns: options.listReviewBenchmarkRuns, getReviewBenchmarkRun: options.getReviewBenchmarkRun,
      listRulePromotionCandidates: options.listRulePromotionCandidates };
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
        console.error(`[paraself] ${request.method ?? "?"} ${route} failed: ${reason}`);
        // Why, to the bridge that holds the token: told nothing, it told an agent Paraself might not be running,
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
      // Checked after the loop's next read, not as the timer fires: held by a long synchronous stretch (the first
      // getLlama builds Metal kernels for seconds), the timer ran before the read of a request that had arrived
      // meanwhile, and a bridge's identity was cut unanswered: told Paraself was not running (IMP-134). One that has
      // sent something gets the same time again to finish, then goes as one that has sent nothing.
      const expire = (graced: boolean) => setImmediate(() => {
        if (!untrusted.has(socket)) return;
        if (!graced && socket.bytesRead > 0) {
          untrusted.set(socket, setTimeout(() => expire(true), UNTRUSTED_DEADLINE_MS).unref());
          return;
        }
        letGo(socket);
        socket.destroy();
      });
      const deadline = setTimeout(() => expire(false), UNTRUSTED_DEADLINE_MS);
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
    if (url.pathname !== "/health") this.#onRequest?.(url.pathname);
    // Neither asks for the token, so the connection they came on is closed after them: kept alive, a client sent its
    // next request, with the token, on a socket the 2 s deadline for those that have not shown it then cut (IMP-134).
    if (request.method === "GET" && url.pathname === "/health") {
      response.setHeader("connection", "close");
      sendJson(response, 200, {
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
      });
      return;
    }

    // Asked by a bridge before it sends the token: proof that this server holds it, and nothing else.
    if (request.method === "GET" && url.pathname === "/v1/identity") {
      response.setHeader("connection", "close");
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
      // Asked without the header by a bridge from before it, still running in an open session: it cannot have asked for
      // what only the new shape sends, and is answered in the shape it reads.
      // By level: a shape-2 bridge still gets signals; only a shape-3 one may name experiences (IMP-191).
      const level = contextShapeLevel(request.headers[CONTEXT_SHAPE_HEADER]);
      if (parsed.data.mode === "semantic" && (parsed.data.query === "" || parsed.data.recordId !== undefined)) { sendJson(response, 400, { error: "semantic_needs_query" }); return; }
      if (contextShapeNeeded(parsed.data) > level) { sendJson(response, 400, { error: "context_shape_required" }); return; }
      const answer = decisionContextResponseSchema.parse(await this.#searchContext(parsed.data));
      sendJson(response, 200, contextAsReleased(answer, level));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/decision-context/amend" && this.#updateDecisionAmendment !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = decisionAmendmentRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, decisionAmendmentResultSchema.parse(await this.#updateDecisionAmendment(parsed.data)));
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

    if (request.method === "POST" && url.pathname === "/v1/obsidian-notes/search" && this.#searchObsidianNotes !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = obsidianNoteSearchRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, obsidianNoteSearchResponseSchema.parse(await this.#searchObsidianNotes(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/obsidian-notes/read" && this.#readObsidianNote !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = obsidianNoteReadRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, obsidianNoteReadResponseSchema.parse(await this.#readObsidianNote(parsed.data)));
      return;
    }

    // 历史决定: its own five routes. No decision-context or consultation route reads them.
    const historical = (
      [
        ["/v1/historical-decisions", recordHistoricalDecisionRequestSchema, recordHistoricalDecisionResultSchema, this.#recordHistoricalDecision],
        ["/v1/historical-decisions/query", listHistoricalDecisionsRequestSchema, listHistoricalDecisionsResultSchema, this.#listHistoricalDecisions],
        ["/v1/historical-decisions/get", getHistoricalDecisionRequestSchema, getHistoricalDecisionResultSchema, this.#getHistoricalDecision],
        ["/v1/historical-decisions/update", updateHistoricalDecisionRequestSchema, updateHistoricalDecisionResultSchema, this.#updateHistoricalDecision],
        ["/v1/historical-decisions/open", openHistoricalDecisionRequestSchema, openHistoricalDecisionResultSchema, this.#openHistoricalDecision],
      ] as const
    ).find(([path, , , handle]) => request.method === "POST" && url.pathname === path && handle !== undefined);
    if (historical !== undefined) {
      const [, requestSchema, resultSchema, handle] = historical;
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      // Each handler takes what its own schema read: paired above, told apart here only by the route.
      sendJson(response, 200, resultSchema.parse(await (handle as (value: unknown) => Promise<unknown>)(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/todos/query" && this.#listTodos !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = todoListQuerySchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      const answer = todoListResponseSchema.parse(await this.#listTodos(parsed.data));
      // Asked without the header by a bridge from IMP-183, still running in an open session.
      sendJson(response, 200, todoAnswerFor(shapeOf(request)).list(answer));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/todos" && this.#recordTodos !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = todoRecordRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      const answer = todoRecordResultSchema.parse(await this.#recordTodos(parsed.data));
      sendJson(response, 200, todoAnswerFor(shapeOf(request)).record(answer));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/todos/item" && this.#updateTodoItem !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = todoItemUpdateRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      const shape = shapeOf(request);
      const oldHigh = shape !== "4" && shape !== "5" && (input as { priority?: unknown }).priority === "high";
      const answer = todoItemUpdateResultSchema.parse(await this.#updateTodoItem(parsed.data, { oldHigh }));
      sendJson(response, 200, todoAnswerFor(shapeOf(request)).item(answer));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/prs/query" && this.#listPrsForAgent !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prListToolQuerySchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, prListToolResultSchema.parse(await this.#listPrsForAgent(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/pr-reviews/query" && this.#listPrReviewRecords !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prReviewRecordsQuerySchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, prReviewRecordsResultSchema.parse(await this.#listPrReviewRecords(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/pr-reviews/record" && this.#getPrReviewRecord !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prReviewRecordRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, prReviewRecordResultSchema.parse(await this.#getPrReviewRecord(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/pr-reviews/finding" && this.#updatePrReviewFinding !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prReviewFindingUpdateSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, prReviewFindingUpdateResultSchema.parse(await this.#updatePrReviewFinding(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/prs/description/draft" && this.#prDescriptionDraft !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prDescriptionDraftQuerySchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, prDescriptionDraftResultSchema.parse(await this.#prDescriptionDraft(parsed.data)));
      return;
    }

    const localReviewRoutes = {
      "/v1/local-review/jobs/record": [this.#localReviewTools.recordLocalReviewJob, localReviewJobRecordSchema, localReviewJobRecordResultSchema],
      "/v1/local-review/jobs/list": [this.#localReviewTools.listLocalReviewJobs, localReviewJobsQuerySchema, localReviewJobsResultSchema],
      "/v1/local-review/jobs/get": [this.#localReviewTools.getLocalReviewJob, localReviewJobRequestSchema, localReviewJobResultSchema],
      "/v1/local-review/jobs/update": [this.#localReviewTools.updateLocalReviewJob, localReviewJobUpdateSchema, localReviewJobUpdateResultSchema],
      "/v1/pr-reviews/settings": [this.#localReviewTools.getPrReviewSettings, prReviewSettingsQuerySchema, prReviewSettingsResultSchema],
      "/v1/pr-reviews/settings/update": [this.#localReviewTools.updatePrReviewSettings, prReviewSettingsUpdateSchema, prReviewSettingsUpdateResultSchema],
      "/v1/review-quality": [this.#localReviewTools.getReviewQuality, reviewQualityQuerySchema, reviewQualityResultSchema],
      "/v1/review-rules/update": [this.#localReviewTools.updateReviewRule, reviewRuleUpdateSchema, reviewRuleUpdateResultSchema],
      "/v1/review-escapes/record": [this.#localReviewTools.recordReviewEscape, reviewEscapeRecordSchema, reviewEscapeRecordResultSchema],
      "/v1/review-escapes": [this.#localReviewTools.listReviewEscapes, reviewEscapesQuerySchema, reviewEscapesResultSchema],
      "/v1/review-escapes/update": [this.#localReviewTools.updateReviewEscape, reviewEscapeUpdateSchema, reviewEscapeUpdateResultSchema],
      "/v1/review-benchmark/runs/start": [this.#localReviewTools.runReviewBenchmark, reviewBenchmarkRunRequestSchema, reviewBenchmarkRunStartSchema],
      "/v1/review-benchmark/runs": [this.#localReviewTools.listReviewBenchmarkRuns, reviewBenchmarkRunsQuerySchema, reviewBenchmarkRunsResultSchema],
      "/v1/review-benchmark/runs/get": [this.#localReviewTools.getReviewBenchmarkRun, reviewBenchmarkRunQuerySchema, reviewBenchmarkRunResultSchema],
      "/v1/review-promotions": [this.#localReviewTools.listRulePromotionCandidates, reviewPromotionsQuerySchema, reviewPromotionsResultSchema],
    } as const;
    const localReviewRoute = request.method === "POST" ? localReviewRoutes[url.pathname as keyof typeof localReviewRoutes] : undefined;
    if (localReviewRoute?.[0] !== undefined) {
      const [handle, input, output] = localReviewRoute as unknown as [(value: unknown) => Promise<unknown>, { safeParse(value: unknown): { success: boolean; data?: unknown } }, { parse(value: unknown): unknown }];
      const body = await this.#readJson(request, response);
      if (body === undefined) return;
      const parsed = input.safeParse(body);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      // Handing comments over checks the worker first, which may take a couple of minutes.
      request.socket.setTimeout(LOCAL_REVIEW_SOCKET_MS);
      sendJson(response, 200, output.parse(await handle(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/prs/comments/list" && this.#listPrComments !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prCommentsToolQuerySchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      // Ten pages of a busy PR's comments: the connection is kept open for them.
      request.socket.setTimeout(PR_COMMENTS_SOCKET_MS);
      sendJson(response, 200, prCommentsToolResultSchema.parse(await this.#listPrComments(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/prs/comments/respond" && this.#updatePrComment !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prCommentUpdateToolSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      request.socket.setTimeout(PR_COMMENTS_SOCKET_MS);
      sendJson(response, 200, prCommentUpdateToolResultSchema.parse(await this.#updatePrComment(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/pr-reviews/run" && this.#runPrReview !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prReviewRunToolRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      // Reading a large PR fresh takes a while before the review can start: the connection is kept open for it.
      request.socket.setTimeout(PR_COMMENTS_SOCKET_MS);
      sendJson(response, 200, prReviewRunToolResultSchema.parse(await this.#runPrReview(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/prs/description/update" && this.#updatePr !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prUpdateRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, prUpdateResultSchema.parse(await this.#updatePr(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/pr-reviews/comments" && this.#recordPrComments !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = prReviewCommentsRecordSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      // Each comment is a few platform calls: the connection is kept open past the idle limit while they go out.
      request.socket.setTimeout(PR_COMMENTS_SOCKET_MS);
      sendJson(response, 200, prReviewCommentsResultSchema.parse(await this.#recordPrComments(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/review-benchmark/cases" && this.#recordReviewBenchmarkCases !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = reviewBenchmarkRecordRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, reviewBenchmarkRecordResultSchema.parse(await this.#recordReviewBenchmarkCases(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/review-benchmark/cases/query" && this.#listReviewBenchmarkCases !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = reviewBenchmarkListRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, reviewBenchmarkListResultSchema.parse(await this.#listReviewBenchmarkCases(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/review-benchmark/case" && this.#getReviewBenchmarkCase !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = reviewBenchmarkGetRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, reviewBenchmarkGetResultSchema.parse(await this.#getReviewBenchmarkCase(parsed.data)));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/review-benchmark/case/update" && this.#updateReviewBenchmarkCase !== undefined) {
      const input = await this.#readJson(request, response);
      if (input === undefined) return;
      const parsed = reviewBenchmarkUpdateRequestSchema.safeParse(input);
      if (!parsed.success) { sendJson(response, 400, { error: "invalid_request" }); return; }
      sendJson(response, 200, reviewBenchmarkUpdateResultSchema.parse(await this.#updateReviewBenchmarkCase(parsed.data)));
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
    const answer = proactiveRecordResultSchema.parse(result);
    // Asked without the header by a bridge from before it: told nothing its strict schema refuses.
    sendJson(response, 200, contextShapeLevel(request.headers[CONTEXT_SHAPE_HEADER]) >= 2 ? answer : proactiveResultAsReleased(answer));
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
