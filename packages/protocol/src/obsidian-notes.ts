import { z } from "zod";

/**
 * The reader's ordinary Obsidian notes, read-only, for an agent: those the App's note index keeps (not the Decision
 * Journal folder, hidden folders, nor what the reader excluded in Obsidian). Paths are Vault-relative, `/`-separated.
 * Notes carry no recorded project scope: `projectScope` is always "none".
 */

export const OBSIDIAN_NOTE_MAX_QUERY = 200;
export const OBSIDIAN_NOTE_MAX_RESULTS = 10;
export const OBSIDIAN_NOTE_MAX_LINES = 400;
/** The most text one read returns, in UTF-16 code units. */
export const OBSIDIAN_NOTE_MAX_TEXT = 24_000;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
// As the vault repository checks it again: here only its shape, so a path that is plainly not one is refused early.
const notePathSchema = z.string().min(4).max(1_024).refine(
  (path) => path.toLowerCase().endsWith(".md") && !path.includes("\\") && !path.startsWith("/") && !/^[A-Za-z]:/u.test(path) &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  "a Vault-relative Markdown path",
);

export const obsidianNoteSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(OBSIDIAN_NOTE_MAX_QUERY),
  limit: z.number().int().min(1).max(OBSIDIAN_NOTE_MAX_RESULTS).default(5),
}).strict();

/**
 * ready: the whole index was searched. partial: searched, but the index is still being built or missed some notes, or
 * a hit could not be read back now and was left out. unavailable: nothing was searched; no results is then no answer.
 */
export const obsidianNoteAvailabilitySchema = z.enum(["ready", "partial", "unavailable"]);

export const obsidianNoteSearchResultSchema = z.object({
  path: notePathSchema,
  title: z.string().max(1_000),
  // As the note index bounds a section's heading path (markdown-chunker.ts: 600 code points, so up to 1,200 UTF-16
  // units for astral characters such as emoji). Narrower, one such note's hit failed the whole search.
  heading: z.string().max(1_200).nullable(),
  snippet: z.string().max(2_000),
  matchKind: z.enum(["keyword", "semantic", "hybrid"]),
  /** 1-based line of the match in the note as it reads now; null when it could not be placed. */
  line: z.number().int().min(1).nullable(),
  contentHash: hashSchema,
  /** The note changed after it was indexed: the snippet may be out of date; read it. */
  changedSinceIndexed: z.boolean(),
}).strict();

export const obsidianNoteSearchResponseSchema = z.object({
  availability: obsidianNoteAvailabilitySchema,
  semanticAvailable: z.boolean(),
  indexedNotes: z.number().int().min(0),
  discoveredNotes: z.number().int().min(0),
  projectScope: z.literal("none"),
  message: z.string().max(1_000),
  results: z.array(obsidianNoteSearchResultSchema).max(OBSIDIAN_NOTE_MAX_RESULTS),
}).strict();

export const obsidianNoteReadRequestSchema = z.object({
  path: notePathSchema,
  startLine: z.number().int().min(1).default(1),
  /** 0-based UTF-16 offset into startLine, to go on inside a line longer than one read holds. */
  startColumn: z.number().int().min(0).default(0),
  maxLines: z.number().int().min(1).max(OBSIDIAN_NOTE_MAX_LINES).default(200),
}).strict();

/**
 * ok: `text` is lines startLine…endLine of the note, from startColumn; `truncated` with nextStartLine/nextStartColumn
 * to go on from. not_available: not a note the index keeps (missing, excluded, hidden, a link, too large, not
 * indexed yet) — which of these is not said. unavailable: the note index is off.
 */
export const obsidianNoteReadResponseSchema = z.object({
  status: z.enum(["ok", "not_available", "unavailable"]),
  path: notePathSchema,
  projectScope: z.literal("none"),
  message: z.string().max(1_000),
  note: z.object({
    title: z.string().max(1_000),
    contentHash: hashSchema,
    changedSinceIndexed: z.boolean(),
    totalLines: z.number().int().min(0),
    startLine: z.number().int().min(1),
    startColumn: z.number().int().min(0),
    endLine: z.number().int().min(0),
    truncated: z.boolean(),
    nextStartLine: z.number().int().min(1).nullable(),
    nextStartColumn: z.number().int().min(0).nullable(),
    text: z.string().max(OBSIDIAN_NOTE_MAX_TEXT),
  }).strict().nullable(),
}).strict();

export type ObsidianNoteSearchRequest = z.input<typeof obsidianNoteSearchRequestSchema>;
export type ObsidianNoteSearchResponse = z.infer<typeof obsidianNoteSearchResponseSchema>;
export type ObsidianNoteSearchResult = z.infer<typeof obsidianNoteSearchResultSchema>;
export type ObsidianNoteReadRequest = z.input<typeof obsidianNoteReadRequestSchema>;
export type ObsidianNoteReadResponse = z.infer<typeof obsidianNoteReadResponseSchema>;
