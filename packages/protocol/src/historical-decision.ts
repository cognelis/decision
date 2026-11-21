import { z } from "zod";

import { sourceClientSchema } from "./capture.js";

/**
 * 历史决定：一次已经作出的选择的事实留档，只为日后追踪。每条是仓库里的一篇笔记，本机另有索引和变更历史；
 * 这里是 App、bridge 与页面之间传递它的形状。它不要求理由，不进入复盘，也不进入 search_decision_context。
 */
export const HISTORICAL_DECISION_VERSION = 1 as const;

/** What each part may hold: the bridge tells an agent these, and the App and the note keep to them. */
export const HISTORICAL_DECISION_LIMITS = {
  title: 500,
  decision: 8_000,
  context: 8_000,
  notes: 8_000,
  project: 500,
  scope: 500,
  option: 500,
  options: 8,
  participant: 100,
  participants: 12,
  referenceLabel: 200,
  references: 8,
  relatedNote: 300,
  relatedNotes: 8,
  tag: 100,
  tags: 12,
  statusNote: 1_000,
  revisitCondition: 500,
  /** Records one page of a query returns. */
  page: 100,
  /** Changes one read of a record returns, newest first. */
  history: 50,
} as const;

const LIMITS = HISTORICAL_DECISION_LIMITS;
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
// Each a line of its own in the note: the title is its heading, an option a list item, a tag a property value.
const line = (maximum: number) => text(maximum).regex(/^[^\r\n]*$/u, "must be a single line");

export const historicalDecisionStatusSchema = z.enum(["active", "superseded", "ended", "withdrawn"]);
export const historicalDecisionReversibilitySchema = z.enum(["easy", "costly", "irreversible"]);
export const historicalDecisionSourceKindSchema = z.enum([
  "app_manual",
  "meeting",
  "offline_conversation",
  "pr_comment",
  "agent_capture",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A link a reader opens from the note: HTTPS, or HTTP on this machine, carrying no sign-in of its own. */
export const isHistoricalDecisionLink = (value: string): boolean => {
  if (/\s/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)))
      && url.username === "" && url.password === "";
  } catch {
    return false;
  }
};

export const historicalDecisionReferenceSchema = z
  .object({
    url: z.string().trim().max(2_000).refine(isHistoricalDecisionLink, "links are HTTPS (or HTTP on loopback) without credentials"),
    label: line(LIMITS.referenceLabel).optional(),
  })
  .strict();

const idSchema = text(200);
const dateSchema = z.string().date();

/** The fields a person or an agent writes, as each is given when it is given at all. */
const written = {
  title: line(LIMITS.title),
  decision: text(LIMITS.decision),
  decidedOn: dateSchema,
  options: z.array(line(LIMITS.option)).max(LIMITS.options),
  context: text(LIMITS.context),
  project: line(LIMITS.project),
  scope: line(LIMITS.scope),
  participants: z.array(line(LIMITS.participant)).max(LIMITS.participants),
  sourceKind: historicalDecisionSourceKindSchema,
  reversibility: historicalDecisionReversibilitySchema,
  references: z.array(historicalDecisionReferenceSchema).max(LIMITS.references),
  relatedNotes: z.array(line(LIMITS.relatedNote)).max(LIMITS.relatedNotes),
  tags: z.array(line(LIMITS.tag)).max(LIMITS.tags),
  notes: text(LIMITS.notes),
  revisitCondition: line(LIMITS.revisitCondition),
  statusNote: text(LIMITS.statusNote),
};

export const historicalDecisionSchema = z
  .object({
    id: idSchema,
    title: written.title,
    decision: written.decision,
    decidedOn: written.decidedOn,
    options: written.options,
    context: written.context.nullable(),
    project: written.project.nullable(),
    scope: written.scope.nullable(),
    participants: written.participants,
    sourceKind: written.sourceKind,
    /** The tool an agent wrote it from; null for one written in the App. */
    sourceClient: sourceClientSchema.nullable(),
    reversibility: written.reversibility.nullable(),
    references: written.references,
    relatedNotes: written.relatedNotes,
    tags: written.tags,
    notes: written.notes.nullable(),
    status: historicalDecisionStatusSchema,
    /** The earlier record this one took the place of. */
    supersedesId: idSchema.nullable(),
    statusNote: written.statusNote.nullable(),
    /** A reminder to oneself, shown as written: nothing is scheduled from it. */
    revisitCondition: written.revisitCondition.nullable(),
    /** The decision record made from this one, once. */
    promotedDecisionId: idSchema.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    revision: z.number().int().positive(),
  })
  .strict();

export const recordHistoricalDecisionRequestSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    /** Null for the App itself. */
    sourceClient: sourceClientSchema.nullable(),
    title: written.title,
    decision: written.decision,
    /** Left out: today, on this machine's calendar. */
    decidedOn: written.decidedOn.optional(),
    options: written.options.optional(),
    context: written.context.optional(),
    project: written.project.optional(),
    scope: written.scope.optional(),
    participants: written.participants.optional(),
    sourceKind: written.sourceKind.optional(),
    reversibility: written.reversibility.optional(),
    references: written.references.optional(),
    relatedNotes: written.relatedNotes.optional(),
    tags: written.tags.optional(),
    notes: written.notes.optional(),
    revisitCondition: written.revisitCondition.optional(),
    /** The record this one takes the place of: that one is marked 已替代. */
    supersedesId: idSchema.optional(),
  })
  .strict();

/** A field a change rewrote, as a person reads it before and after ("" for nothing written). */
export const historicalDecisionChangeSchema = z
  .object({
    field: z.string().min(1).max(40),
    before: z.string().max(1_000),
    after: z.string().max(1_000),
  })
  .strict();

export const historicalDecisionEventSchema = z
  .object({
    at: z.string().datetime(),
    /** Who made the change: 「app」, or the tool an agent made it from. */
    actor: z.string().min(1).max(60),
    kind: z.enum(["created", "updated", "status", "superseded", "released", "promoted"]),
    summary: z.string().min(1).max(1_000),
    /** What the fields it rewrote read before and after; none for a change of status or link alone, or one kept before these were. */
    changes: z.array(historicalDecisionChangeSchema).max(20).optional(),
  })
  .strict();

export const recordHistoricalDecisionResultSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    /** duplicate: the same matter, decision, project and date is already kept; that record is returned. */
    status: z.enum(["created", "duplicate"]),
    record: historicalDecisionSchema,
    /** The earlier record marked 已替代 by this one. */
    supersededId: idSchema.nullable(),
  })
  .strict();

export const listHistoricalDecisionsRequestSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    query: z.string().max(500).optional(),
    project: written.project.optional(),
    /** One status; left out, every status but 已撤回. */
    status: historicalDecisionStatusSchema.optional(),
    /** With no status named: 已撤回 as well. */
    includeWithdrawn: z.boolean().optional(),
    tag: line(LIMITS.tag).optional(),
    reversibility: historicalDecisionReversibilitySchema.optional(),
    fromDate: dateSchema.optional(),
    toDate: dateSchema.optional(),
    /** The record a decision record was made from, by that decision's id. */
    promotedDecisionId: idSchema.optional(),
    limit: z.number().int().min(1).max(LIMITS.page).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();

export const historicalDecisionDiagnosticSchema = z
  .object({ path: z.string().max(2_000), message: z.string().max(1_000) })
  .strict();

/** ready: the index holds what the vault holds. unavailable: it could not be read or brought up to date. */
export const historicalDecisionIndexStateSchema = z
  .object({
    state: z.enum(["ready", "unavailable"]),
    message: z.string().max(1_000).nullable(),
    /** Records in the index, and notes read from the vault, when each could be counted. */
    indexed: z.number().int().min(0).nullable(),
    found: z.number().int().min(0).nullable(),
    syncedAt: z.string().datetime().nullable(),
  })
  .strict();

export const listHistoricalDecisionsResultSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    records: z.array(historicalDecisionSchema).max(LIMITS.page),
    /** Every record that matches, of which `records` is one page, newest decision first. */
    total: z.number().int().min(0),
    /** Every record kept, whatever was asked for. */
    kept: z.number().int().min(0),
    projects: z.array(written.project).max(500),
    tags: z.array(written.tags.element).max(500),
    /** Notes under the history folder that could not be read as a record. */
    diagnostics: z.array(historicalDecisionDiagnosticSchema).max(200),
    index: historicalDecisionIndexStateSchema,
  })
  .strict();

export const getHistoricalDecisionRequestSchema = z
  .object({ version: z.literal(HISTORICAL_DECISION_VERSION), id: idSchema })
  .strict();

/** A record as its neighbours in a chain show it. */
export const historicalDecisionLinkSchema = z
  .object({
    id: idSchema,
    title: written.title,
    decision: written.decision,
    decidedOn: written.decidedOn,
    status: historicalDecisionStatusSchema,
  })
  .strict();

export const getHistoricalDecisionResultSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    record: historicalDecisionSchema,
    /** The record this one took the place of; null when it names none, or names one no longer there. */
    predecessor: historicalDecisionLinkSchema.nullable(),
    /** Records that took this one's place. */
    successors: z.array(historicalDecisionLinkSchema).max(20),
    /** The note, relative to the vault with "/" separators. */
    notePath: z.string().max(2_000),
    /** Changes kept on this machine, newest first. */
    history: z.array(historicalDecisionEventSchema).max(LIMITS.history),
  })
  .strict();

export const updateHistoricalDecisionRequestSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    sourceClient: sourceClientSchema.nullable(),
    id: idSchema,
    /** The revision the change was made from: another change since, and this one is refused. */
    expectedRevision: z.number().int().positive(),
    /** Required with `status`: the status the caller saw. */
    expectedStatus: historicalDecisionStatusSchema.optional(),
    // Left out: unchanged. Null, where it is allowed: cleared.
    title: written.title.optional(),
    decision: written.decision.optional(),
    decidedOn: written.decidedOn.optional(),
    options: written.options.optional(),
    context: written.context.nullable().optional(),
    project: written.project.nullable().optional(),
    scope: written.scope.nullable().optional(),
    participants: written.participants.optional(),
    sourceKind: written.sourceKind.optional(),
    reversibility: written.reversibility.nullable().optional(),
    references: written.references.optional(),
    relatedNotes: written.relatedNotes.optional(),
    tags: written.tags.optional(),
    notes: written.notes.nullable().optional(),
    revisitCondition: written.revisitCondition.nullable().optional(),
    supersedesId: idSchema.nullable().optional(),
    status: historicalDecisionStatusSchema.optional(),
    statusNote: written.statusNote.nullable().optional(),
    /** Makes a decision record from this one, once: it then takes part in search, review and methodology. */
    promote: z.literal(true).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== undefined && value.expectedStatus === undefined) {
      context.addIssue({ code: "custom", message: "a status change carries expectedStatus" });
    }
    const { version: _version, sourceClient: _client, id: _id, expectedRevision: _revision, expectedStatus: _status, ...changes } = value;
    if (Object.values(changes).every((change) => change === undefined)) {
      context.addIssue({ code: "custom", message: "nothing to change" });
    }
  });

export const updateHistoricalDecisionResultSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    record: historicalDecisionSchema,
    /** The earlier record this change marked 已替代. */
    supersededId: idSchema.nullable(),
    /** Records whose 替代 link to this one was taken off, because it is 有效 again. */
    releasedIds: z.array(idSchema).max(20),
    /** The decision record made by `promote`. */
    promotedDecisionId: idSchema.nullable(),
  })
  .strict();

export const rebuildHistoricalDecisionIndexResultSchema = z
  .object({ version: z.literal(HISTORICAL_DECISION_VERSION), index: historicalDecisionIndexStateSchema })
  .strict();

export type HistoricalDecision = z.infer<typeof historicalDecisionSchema>;
export type HistoricalDecisionStatus = z.infer<typeof historicalDecisionStatusSchema>;
export type HistoricalDecisionReversibility = z.infer<typeof historicalDecisionReversibilitySchema>;
export type HistoricalDecisionSourceKind = z.infer<typeof historicalDecisionSourceKindSchema>;
export type HistoricalDecisionReference = z.infer<typeof historicalDecisionReferenceSchema>;
export type HistoricalDecisionEvent = z.infer<typeof historicalDecisionEventSchema>;
export type HistoricalDecisionChange = z.infer<typeof historicalDecisionChangeSchema>;
export type HistoricalDecisionLink = z.infer<typeof historicalDecisionLinkSchema>;
export type HistoricalDecisionDiagnostic = z.infer<typeof historicalDecisionDiagnosticSchema>;
export type HistoricalDecisionIndexState = z.infer<typeof historicalDecisionIndexStateSchema>;
export type RecordHistoricalDecisionRequest = z.infer<typeof recordHistoricalDecisionRequestSchema>;
export type RecordHistoricalDecisionResult = z.infer<typeof recordHistoricalDecisionResultSchema>;
export type ListHistoricalDecisionsRequest = z.infer<typeof listHistoricalDecisionsRequestSchema>;
export type ListHistoricalDecisionsResult = z.infer<typeof listHistoricalDecisionsResultSchema>;
export type GetHistoricalDecisionRequest = z.infer<typeof getHistoricalDecisionRequestSchema>;
export type GetHistoricalDecisionResult = z.infer<typeof getHistoricalDecisionResultSchema>;
export type UpdateHistoricalDecisionRequest = z.infer<typeof updateHistoricalDecisionRequestSchema>;
export type UpdateHistoricalDecisionResult = z.infer<typeof updateHistoricalDecisionResultSchema>;
export type RebuildHistoricalDecisionIndexResult = z.infer<typeof rebuildHistoricalDecisionIndexResultSchema>;

/**
 * Opens a record on this machine: its note in Obsidian, or one of its own links (in the browser) or related notes
 * (in Obsidian). Only what the record names is opened, never an address or note the caller makes up.
 */
export const openHistoricalDecisionRequestSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    id: idSchema,
    link: z.string().min(1).max(2_000).optional(),
    relatedNote: z.string().min(1).max(LIMITS.relatedNote + 4).optional(),
  })
  .strict()
  .refine((request) => request.link === undefined || request.relatedNote === undefined, "open the note, one link or one related note: not two at once");

export const openHistoricalDecisionResultSchema = z
  .object({
    version: z.literal(HISTORICAL_DECISION_VERSION),
    opened: z.enum(["note", "link", "relatedNote"]),
    /** The note's vault path, the link, or the related note as the record names it. */
    target: z.string().min(1).max(2_000),
  })
  .strict();

export type OpenHistoricalDecisionRequest = z.infer<typeof openHistoricalDecisionRequestSchema>;
export type OpenHistoricalDecisionResult = z.infer<typeof openHistoricalDecisionResultSchema>;
