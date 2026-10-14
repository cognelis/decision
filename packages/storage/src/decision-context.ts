import { clipText, decisionOutcomeStateSchema, decisionScopeSchema, type DecisionScope, type DecisionContextResult, type DecisionContextResponse, type DecisionContextSource } from "@cognelis/decision-protocol";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { parseDecision } from "./markdown.js";
import { parseMethodology } from "./methodology.js";
import { ObsidianVaultRepository, type ObsidianVaultNote } from "./obsidian-vault.js";
import { DecisionScopeRepository } from "./decision-scope.js";
import { DecisionRelationRepository } from "./decision-relation.js";
import type { DecisionRelationRecord } from "@cognelis/decision-protocol";

export interface DecisionContextDocument {
  source: DecisionContextSource;
  kind: DecisionContextResult["kind"];
  id: string;
  title: string;
  project: string | null;
  status: string;
  created: string;
  summary: string;
  appliesWhen: string | null;
  caution: string | null;
  tags: string[];
  supersedes: string[];
  supersededBy: string[];
  relativePath: string;
  client: string | null;
  sessionId: string | null;
  body: string;
  bodyStartLine: number;
  scope?: DecisionScope | null;
  contentHash?: string;
  scopeState?: "unrecorded" | "inline" | "current" | "stale" | "unavailable";
  scopeRevision?: number;
  outcomeState?: DecisionContextResult["outcomeState"];
}

export interface DecisionContextSnapshot {
  documents: DecisionContextDocument[];
  sources: DecisionContextResponse["sources"];
  relations?: DecisionRelationRecord[];
  relationsUnavailable?: boolean;
  relationPaths?: Map<string, string>;
  /**
   * What the notes a scan set aside could be, by source: the identifiers their
   * `id:` lines name, `#hash:` and the hash a decision note not read ends its
   * app-written name in, or "all" when one could not be read at all. A record not
   * among them is whole however many other notes were set aside.
   */
  setAside?: Map<DecisionContextSource, Set<string> | "all">;
}

/** Whether a note this snapshot set aside could be this record: a write about it waits until it is readable. */
export const mayBeSetAside = (snapshot: DecisionContextSnapshot, source: DecisionContextSource, id: string): boolean => {
  const doubt = snapshot.setAside?.get(source);
  return doubt === "all" || doubt?.has(id) === true || doubt?.has(`${HASH_DOUBT}${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8)}`) === true;
};
/**
 * A decision note not read (in iCloud, behind a link) is the record its file name ends in the hash of: only that one is
 * in doubt. Every record of the source was, and one old decision moved off this Mac refused every relation and feedback.
 */
const HASH_DOUBT = "#hash:";

const ID_LINE = /^id:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/gmu;

const identifier = z.string().trim().min(1).max(200);
const references = z.union([identifier, z.array(identifier).max(50), z.null()])
  .optional().transform((value) => value == null ? [] : typeof value === "string" ? [value] : [...new Set(value)]);
const legacySchema = z.object({
  id: identifier,
  created: z.string().min(1).max(100),
  status: z.enum(["accepted", "superseded"]),
  selected_option: z.string().min(1).max(16_000),
  project: z.string().max(500).nullable().optional(),
  source_client: z.string().max(100).nullable().optional(),
  session_id: z.string().max(200).nullable().optional(),
  // Emptied in Obsidian (null) or written as one value, as the decisions source reads them: refused, the note was set
  // aside and the decision left every search.
  tags: z.preprocess((value) => (value === null ? [] : typeof value === "string" ? [value] : value), z.array(z.string().max(100)).max(30).default([])),
  supersedes: references,
  superseded_by: references,
  applies_when: z.string().max(2_000).nullable().optional(),
  caution: z.string().max(2_000).nullable().optional(),
});

/** Compatibility is read-only: legacy accepted decisions are never promoted to principles. */
export const parseDecisionContextNote = (
  note: ObsidianVaultNote,
  source: DecisionContextSource,
): DecisionContextDocument | null => {
  const markdown = note.content.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(markdown);
  if (frontmatter === null) throw new Error("Missing frontmatter");
  const properties = z.record(z.string(), z.unknown()).parse(parseYaml(frontmatter[1]!, { maxAliasCount: 20 }));
  const common = {
    source,
    relativePath: note.relativePath,
    body: markdown.slice(frontmatter[0].length),
    bodyStartLine: frontmatter[0].split("\n").length,
    scope: properties.decision_scope === undefined ? null : decisionScopeSchema.parse(properties.decision_scope),
    contentHash: note.contentHash,
    scopeState: properties.decision_scope === undefined ? "unrecorded" as const : "inline" as const,
    scopeRevision: 0,
  };
  if (source === "summarize") {
    const value = legacySchema.parse(properties);
    const file = note.relativePath.split("/").at(-1)!.replace(/\.md$/iu, "");
    return {
      ...common,
      kind: "historical_decision",
      id: value.id,
      title: clipText(file, 500),
      project: value.project ?? null,
      status: value.status,
      created: value.created,
      summary: value.selected_option,
      appliesWhen: value.applies_when ?? null,
      caution: value.caution ?? null,
      tags: value.tags,
      supersedes: value.supersedes,
      supersededBy: value.superseded_by,
      client: value.source_client ?? null,
      sessionId: value.session_id ?? null,
    };
  }
  if (source === "decisions") {
    const value = parseDecision(markdown);
    // Within the response's bounds, as the legacy source's schema already is: a note edited past them
    // is one this scan sets aside and counts, not one that fails every search whose page it is on.
    if (value.id.length > 200 || (value.supersedes?.length ?? 0) > 200 || (value.project?.length ?? 0) > 500) {
      throw new Error("Decision note has an identifier or project past the context limits");
    }
    return {
      ...common,
      kind: "recorded_decision",
      id: value.id,
      // A 决策点 emptied in Obsidian, heading kept, is titled by its id rather than failing every search it is found in.
      title: clipText(value.question, 500) || value.id,
      project: value.project,
      status: value.status,
      created: value.created,
      summary: value.selectedAnswer.values.join("；"),
      appliesWhen: null,
      caution: null,
      // A tag only labels: an overlong one is shortened rather than the record set aside.
      tags: value.tags.slice(0, 30).map((tag) => clipText(tag, 100)),
      // An emptied `supersedes:` reads as "", which no id is: none, not a record named "" that failed every search.
      supersedes: value.supersedes ? [value.supersedes] : [],
      supersededBy: [],
      client: value.sourceClient,
      sessionId: null,
      outcomeState: decisionOutcomeStateSchema.parse({ expectedOutcome: value.expectedOutcome ?? null, outcome: value.outcome, review: value.outcomeReview, reviewDueDate: value.reviewDueDate }),
    };
  }
  const value = parseMethodology(markdown);
  if (value.status !== "accepted" && value.status !== "retired") return null;
  return {
    ...common,
    kind: "adopted_principle",
    id: value.id,
    title: clipText(value.title, 500),
    project: null,
    status: value.status,
    created: value.createdAt,
    summary: value.principle,
    appliesWhen: value.appliesWhen,
    caution: value.caution,
    tags: [],
    supersedes: [],
    supersededBy: value.supersededById === undefined ? [] : [value.supersededById],
    client: null,
    sessionId: null,
  };
};

/**
 * Each scan rebuilds a bounded in-memory projection of the three fact sources. A note unchanged since the
 * last scan is neither read (the vault keeps it) nor parsed again (kept here, by the note read): every
 * search paid both for every note, seconds at ten thousand decisions, and stopped at a quarter of them.
 */
export class DecisionContextRepository {
  readonly #vault: ObsidianVaultRepository;
  readonly #scopes: DecisionScopeRepository;
  readonly #relations: DecisionRelationRepository;
  readonly #parsed = new WeakMap<ObsidianVaultNote, DecisionContextDocument | null | "unreadable">();
  // A record with its scope, the same object while the scope is: a copy made each scan was a new record to
  // every search, and what searching worked out for it once was worked out again each time.
  readonly #withScope = new WeakMap<DecisionContextDocument, { key: string; document: DecisionContextDocument }>();
  #scan: Promise<DecisionContextSnapshot> | null = null;

  /** `vault`: the app's one, shared with the decisions' repository, so their folder's notes are kept in memory once. */
  constructor(
    vaultPath: string,
    scopes = new DecisionScopeRepository(vaultPath),
    relations = new DecisionRelationRepository(vaultPath),
    vault = new ObsidianVaultRepository(vaultPath),
  ) {
    this.#vault = vault;
    this.#scopes = scopes;
    this.#relations = relations;
  }

  #scoped(
    document: DecisionContextDocument,
    scope: Pick<DecisionContextDocument, "scope" | "scopeState" | "scopeRevision">,
  ): DecisionContextDocument {
    const key = JSON.stringify(scope);
    const kept = this.#withScope.get(document);
    if (kept?.key === key) return kept.document;
    const scoped = { ...document, ...scope };
    this.#withScope.set(document, { key, document: scoped });
    return scoped;
  }

  /**
   * A note it could not read (saved in another encoding, too large) can still name its own records: its `id:`
   * lines, read leniently from its first 64 KiB. Doubted whole for want of them, one note an editor saved in GBK
   * left every record of its source "maybe set aside", their feedback and relations refused.
   */
  async #leniently(relativePath: string): Promise<string | null> {
    try {
      const handle = await open(await this.#vault.resolveNotePath(relativePath), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(64 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return new TextDecoder("utf-8").decode(buffer.subarray(0, bytesRead));
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  scan(fresh = false): Promise<DecisionContextSnapshot> {
    if (fresh) return this.#read();
    if (this.#scan !== null) return this.#scan;
    const scan = this.#read().finally(() => { this.#scan = null; });
    this.#scan = scan;
    return scan;
  }

  async #read(): Promise<DecisionContextSnapshot> {
    const signal = AbortSignal.timeout(4_000);
    const scopeRead = this.#scopes.scan();
    const relationRead = this.#relations.scan();
    const sources: DecisionContextSource[] = ["summarize", "decisions", "principles"];
    const scans = await Promise.all(sources.map(async (source) => {
      const documents: DecisionContextDocument[] = [];
      let skipped = 0;
      let visited = 0;
      let bytes = 0;
      // A note set aside could still be any record its `id:` lines name; one never read, any record at all.
      const doubts = new Set<string>();
      let doubtAll = false;
      const setAside = (content: string): void => {
        skipped += 1;
        for (const match of content.matchAll(ID_LINE)) doubts.add(match[1]!.trim());
      };
      try {
        for await (const entry of this.#vault.iterateFolder(`Decision Journal/${source}`, signal)) {
          if (++visited > 50_000) { skipped += 1; doubtAll = true; break; }
          if (entry.kind === "diagnostic") {
            const note = entry.diagnostic.relativePath === null || entry.diagnostic.reason === "Unable to read directory"
              ? null : await this.#leniently(entry.diagnostic.relativePath);
            if (note !== null && [...note.matchAll(ID_LINE)].length > 0) setAside(note);
            else {
              skipped += 1;
              // Only a name the app wrote ("<created>-<question>-<id>-<hash>.md"): one renamed in Obsidian may end in a date.
              const hash = source === "decisions" && entry.diagnostic.relativePath !== null ? /(?:^|\/)\d{8}T\d+Z-[^/]*-([0-9a-f]{8})\.md$/u.exec(entry.diagnostic.relativePath)?.[1] : undefined;
              if (hash) doubts.add(`${HASH_DOUBT}${hash}`); else doubtAll = true;
            }
            continue;
          }
          bytes += entry.note.size;
          if (bytes > 256 * 1024 * 1024) { skipped += 1; doubtAll = true; break; }
          if (entry.note.size > 512 * 1024 || entry.note.relativePath.length > 2_000) { setAside(entry.note.content); continue; }
          let document = this.#parsed.get(entry.note);
          if (document === undefined) {
            try { document = parseDecisionContextNote(entry.note, source); } catch { document = "unreadable"; }
            this.#parsed.set(entry.note, document);
          }
          if (document === "unreadable") setAside(entry.note.content);
          else if (document !== null) documents.push(document);
        }
      } catch { skipped += 1; doubtAll = true; }
      // Duplicate IDs cannot be resolved by directory enumeration order.
      const counts = new Map<string, number>();
      for (const document of documents) counts.set(document.id, (counts.get(document.id) ?? 0) + 1);
      const unique = documents.filter((document) => counts.get(document.id) === 1);
      for (const document of documents) if (counts.get(document.id) !== 1) doubts.add(document.id);
      skipped += documents.length - unique.length;
      const status: DecisionContextResponse["sources"][number]["status"] = skipped > 0 ? unique.length > 0 ? "partial" : "unavailable" : unique.length > 0 ? "ready" : "empty";
      return { documents: unique, summary: { source, status, records: unique.length, skipped }, doubt: doubtAll ? "all" as const : doubts };
    }));
    const scopeSnapshot = await scopeRead;
    const relationSnapshot = await relationRead;
    const documents = scans.flatMap((scan) => scan.documents).map((document) => {
      const key = `${document.source}:${document.id}`;
      const recorded = scopeSnapshot.records.get(key);
      // Only the record whose scope is in doubt (a sync client's copy of it beside the note) goes unscoped.
      if (scopeSnapshot.inDoubt(key)) return this.#scoped(document, { scope: null, scopeState: "unavailable", scopeRevision: recorded?.revision ?? 0 });
      if (recorded === undefined) return document;
      const current = recorded.contentHash === document.contentHash;
      // Keep the prior scope visible for reconciliation; the applicability
      // evaluator ignores stale constraints when deciding exclusions.
      return this.#scoped(document, { scope: recorded.scope, scopeState: current ? "current" : "stale", scopeRevision: recorded.revision });
    });
    return {
      documents, relations: [...relationSnapshot.records.values()], relationsUnavailable: relationSnapshot.unavailable,
      relationPaths: new Map([...relationSnapshot.records].map(([key, record]) => [key, this.#relations.relativePath(record)])),
      setAside: new Map(scans.map((scan) => [scan.summary.source, scan.doubt])),
      sources: scans.map((scan) => ({ ...scan.summary,
        // A scope in doubt leaves its own source short, not every one.
        ...(documents.some((document) => document.source === scan.summary.source && document.scopeState === "unavailable") ||
          (relationSnapshot.unavailable && scan.summary.source !== "principles")
          ? { status: scan.summary.records > 0 ? "partial" as const : "unavailable" as const, skipped: scan.summary.skipped + 1 } : {}),
      })),
    };
  }
}
