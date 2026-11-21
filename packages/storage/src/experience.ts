import {
  EXPERIENCE_LIMITS,
  experienceBodySchema,
  experienceReporterSchema,
  experienceSourceSchema,
  experienceStatusSchema,
  experienceVerificationSchema,
  organizationSourceKeySchema,
  type ExperienceBody,
  type ExperienceReporter,
  type ExperienceSource,
  type ExperienceStatus,
  type ExperienceVerification,
} from "@cognelis/decision-protocol";
import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { assertVaultPresent, collectMarkdown, inFormOf, normalizedNote, withProperties } from "./markdown.js";
import { escapeNoteText, notePropertiesYaml, unescapeNoteText } from "./markdown-markers.js";
import { canonical, existingNote, replaceNote } from "./note-rewrite.js";
import { NoteCache } from "./note-cache.js";

/**
 * 执行经验的笔记（IMP-191）：`Decision Journal/experiences/<年>/<月>/<slug>-<hash>.md`。正文五节只在采纳时写一次；之后
 * App 只改属性（状态、来源摘录），并且只在笔记仍是它读到的样子时才写，所以读者在 Obsidian 里的改动不会被覆盖。
 * 来源的原文摘录只放在属性里，正文不抄来源原文。
 */
const DEFAULT_FOLDER = "Decision Journal";
export const EXPERIENCE_FOLDER = "experiences";
const NOTE_TYPE = "decision-experience";
const NOTE_VERSION = 1;
const SECTIONS = [
  ["scene", "场景"],
  ["action", "行动"],
  ["observation", "观察与验证"],
  ["inference", "启示（归纳，与观察分开）"],
  ["exceptions", "例外与未覆盖"],
] as const;
const marker = (name: string, edge: "start" | "end") => `<!-- decision:experience-${name}-${edge} -->`;

export interface ExperienceRecord {
  id: string;
  revision: number;
  status: ExperienceStatus;
  project: string | null;
  createdAt: string;
  updatedAt: string;
  reporter: ExperienceReporter;
  verification: ExperienceVerification;
  outcome: "effective" | "partial" | "failed" | "mixed" | "unknown";
  /** `<suggestion id>@r<revision>`. */
  adoptedFrom: string | null;
  userChoice?: true;
  generator: { model: string; promptVersion: string } | null;
  body: ExperienceBody;
  sources: ExperienceSource[];
  /** 全部生成输入，仅用于追踪遗忘；不代表被引用或提供独立证据。 */
  inputKeys?: string[];
  /** 直接参与生成的输入；省略代表旧记录，不能从展开后的祖先倒推。 */
  directInputKeys?: string[];
}

export interface StoredExperience {
  record: ExperienceRecord;
  path: string;
  relativePath: string;
  /** sha256 of the note as read: what a write is made against. */
  noteHash: string;
}

export interface ExperienceScan {
  experiences: StoredExperience[];
  /** Notes that could not be read: not deleted, only not read this time. */
  diagnostics: Array<{ path: string; message: string }>;
}

const propertiesSchema = z.object({
  type: z.literal(NOTE_TYPE),
  version: z.literal(NOTE_VERSION),
  id: z.string().trim().min(1).max(200),
  title: z.string().min(1).max(EXPERIENCE_LIMITS.title * 2),
  revision: z.number().int().positive(),
  status: experienceStatusSchema,
  project: z.string().max(500).nullable(),
  created: z.iso.datetime(),
  updated: z.iso.datetime(),
  reporter: experienceReporterSchema,
  verification: experienceVerificationSchema,
  outcome: z.enum(["effective", "partial", "failed", "mixed", "unknown"]),
  adopted_from: z.string().max(260).nullable(),
  user_choice: z.literal(true).optional(),
  generator_model: z.string().max(200).nullable(),
  prompt_version: z.string().max(100).nullable(),
  sources: z.array(experienceSourceSchema).max(EXPERIENCE_LIMITS.sources),
  input_keys: z.array(organizationSourceKeySchema).max(2048).optional(),
  direct_input_keys: z.array(organizationSourceKeySchema).max(2048).optional(),
}).passthrough();

const hash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const split = (markdown: string): { properties: unknown; body: string; boundary: number } => {
  if (!markdown.startsWith("---\n")) throw new Error("经验笔记缺少属性区");
  const boundary = markdown.indexOf("\n---\n", 4);
  if (boundary < 0) throw new Error("经验笔记的属性区没有结束");
  return { properties: parseYaml(markdown.slice(4, boundary)) as unknown, body: markdown.slice(boundary + 5), boundary };
};

const lineMarker = (text: string): RegExp => new RegExp(`\\n[ \\t]*${text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");

const section = (body: string, name: string): string => {
  const start = lineMarker(marker(name, "start")).exec(body);
  const rest = start === null ? "" : body.slice(start.index + start[0].length);
  const end = start === null ? null : lineMarker(marker(name, "end")).exec(rest);
  if (end === null) throw new Error(`经验笔记缺少「${name}」分节`);
  return unescapeNoteText(rest.slice(0, end.index)).trim();
};

export const parseExperience = (note: string): ExperienceRecord => {
  const markdown = normalizedNote(note);
  const { properties, body } = split(markdown);
  const read = propertiesSchema.parse(properties);
  const parsedBody = experienceBodySchema.parse({
    title: unescapeNoteText(read.title),
    ...Object.fromEntries(SECTIONS.map(([name]) => [name, section(`\n${body}`, name)])),
  });
  return {
    id: read.id,
    revision: read.revision,
    status: read.status,
    project: read.project,
    createdAt: read.created,
    updatedAt: read.updated,
    reporter: read.reporter,
    verification: read.verification,
    outcome: read.outcome,
    adoptedFrom: read.adopted_from,
    ...(read.user_choice ? { userChoice: true as const } : {}),
    generator: read.generator_model === null ? null : { model: read.generator_model, promptVersion: read.prompt_version ?? "" },
    body: parsedBody,
    sources: read.sources,
    ...(read.input_keys === undefined ? {} : { inputKeys: read.input_keys }),
    ...(read.direct_input_keys === undefined ? {} : { directInputKeys: read.direct_input_keys }),
  };
};

const propertiesOf = (record: ExperienceRecord) => ({
  type: NOTE_TYPE,
  version: NOTE_VERSION,
  id: record.id,
  title: escapeNoteText(record.body.title),
  revision: record.revision,
  status: record.status,
  project: record.project,
  created: record.createdAt,
  updated: record.updatedAt,
  reporter: record.reporter,
  verification: record.verification,
  outcome: record.outcome,
  adopted_from: record.adoptedFrom,
  ...(record.userChoice ? { user_choice: true } : {}),
  generator_model: record.generator?.model ?? null,
  prompt_version: record.generator?.promptVersion ?? null,
  sources: record.sources,
  ...(record.inputKeys === undefined ? {} : { input_keys: record.inputKeys }),
  ...(record.directInputKeys === undefined ? {} : { direct_input_keys: record.directInputKeys }),
});

const VERIFICATION_WORDS: Record<ExperienceVerification, string> = {
  agent_reported_unverified: "Agent 报告，未独立核验",
  user_reported: "用户报告",
  machine_synthesis: "机器整理，推断与原话分开，未独立核验",
};

export const serializeExperience = (record: ExperienceRecord): string => {
  const frontmatter = notePropertiesYaml(propertiesOf(record), { lineWidth: 0 }).trimEnd();
  const sections = SECTIONS.map(([name, label]) =>
    `## ${label}\n\n${marker(name, "start")}\n${escapeNoteText(record.body[name])}\n${marker(name, "end")}`).join("\n\n");
  return `---\n${frontmatter}\n---\n\n# ${escapeNoteText(record.body.title)}\n\n> 有来源的记忆：不是用户采纳的原则，不证明因果。${VERIFICATION_WORDS[record.verification]}。来源见属性 sources。\n\n${sections}\n`;
};

const safeSlug = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "") || "experience";

export type ExperienceWrite =
  | { status: "saved"; stored: StoredExperience }
  | { status: "unchanged"; stored: StoredExperience }
  | { status: "conflict"; stored: StoredExperience | null }
  | { status: "not_found" }
  | { status: "unavailable"; message: string };

const duplicateId = (id: string) => `有不止一篇经验笔记使用同一个编号（${id}），常见于同步冲突留下的副本；请在 Obsidian 里删掉多余的那篇。`;

export class ExperienceRepository {
  readonly #vaultPath: string;
  readonly #folder: string;
  readonly #rename: typeof rename;
  readonly #existingVault: boolean;
  readonly #notes = new NoteCache<{ record: ExperienceRecord; noteHash: string } | { message: string }>(undefined, (read) => "record" in read);
  #tail: Promise<unknown> = Promise.resolve();

  constructor(vaultPath: string, options: { folder?: string; rename?: typeof rename; existingVault?: boolean } = {}) {
    this.#vaultPath = vaultPath;
    this.#folder = options.folder ?? DEFAULT_FOLDER;
    this.#rename = options.rename ?? rename;
    this.#existingVault = options.existingVault ?? false;
  }

  async scan(): Promise<ExperienceScan> {
    if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
    const diagnostics: Array<{ path: string; message: string }> = [];
    const paths = await collectMarkdown(join(this.#vaultPath, this.#folder, EXPERIENCE_FOLDER), diagnostics);
    const found: StoredExperience[] = [];
    for (const path of paths) {
      const read = await this.#notes.read(path, async () => {
        try {
          const note = await readFile(path, "utf8");
          return { record: parseExperience(note), noteHash: hash(note) };
        } catch (error) {
          return { message: error instanceof Error ? error.message : String(error) };
        }
      });
      if ("record" in read) found.push({ record: read.record, noteHash: read.noteHash, path, relativePath: this.relativePath(path) });
      else diagnostics.push({ path, message: read.message });
    }
    this.#notes.sweep();
    const seen = new Set<string>();
    const experiences = found.filter((stored) => {
      if (!seen.has(stored.record.id)) return seen.add(stored.record.id);
      diagnostics.push({ path: stored.path, message: duplicateId(stored.record.id) });
      return false;
    });
    return { experiences, diagnostics };
  }

  relativePath(path: string): string {
    return relative(this.#vaultPath, path).split(sep).join("/");
  }

  /**
   * `sure`: null only when every note was read; with one unread, throws rather than say an experience is gone.
   */
  async find(id: string, { sure = false }: { sure?: boolean } = {}): Promise<StoredExperience | null> {
    const scan = await this.scan();
    if (scan.diagnostics.some((diagnostic) => diagnostic.message === duplicateId(id))) throw new Error(duplicateId(id));
    const found = scan.experiences.find((stored) => stored.record.id === id) ?? null;
    if (found === null && sure && scan.diagnostics.length > 0) throw new Error("部分经验笔记这次没能读取，不能确定这条已不在。");
    return found;
  }

  /** Written once for its id: asked again with the same record (a retried adoption), the note there is the answer. */
  create(record: ExperienceRecord): Promise<ExperienceWrite> {
    return this.#serial(async () => {
      let existing: StoredExperience | null;
      try {
        existing = await this.find(record.id, { sure: true });
      } catch (error) {
        return { status: "unavailable", message: error instanceof Error ? error.message : String(error) };
      }
      if (existing !== null) {
        const same = canonical({ ...existing.record, updatedAt: "", status: "", revision: 0 }) === canonical({ ...record, updatedAt: "", status: "", revision: 0 });
        return same ? { status: "unchanged", stored: existing } : { status: "conflict", stored: existing };
      }
      const note = serializeExperience(record);
      if (canonical(parseExperience(note)) !== canonical(record)) throw new Error("经验笔记写出后读回不一致，没有写入");
      const [year, month] = record.createdAt.slice(0, 10).split("-");
      const path = join(this.#vaultPath, this.#folder, EXPERIENCE_FOLDER, year!, month!, `${safeSlug(record.body.title)}-${hash(record.id).slice(0, 12)}.md`);
      if (this.#existingVault) await assertVaultPresent(this.#vaultPath);
      await replaceNote(path, null, note, this.#rename);
      return { status: "saved", stored: { record, path, relativePath: this.relativePath(path), noteHash: hash(note) } };
    });
  }

  /**
   * The note's properties changed (status, sources), on the note as it was read (`expectedNoteHash`): changed since,
   * nothing is written (conflict). The body stays as it is, the reader's edits in it included. `at` is the time written
   * as updatedAt (now, by default); with the same `at`, the note written is the one `previewProperties` answered.
   */
  reviseProperties(id: string, expectedNoteHash: string, change: (record: ExperienceRecord) => Pick<ExperienceRecord, "status" | "sources">, at?: string): Promise<ExperienceWrite> {
    return this.#serial(async () => {
      const revised = await this.#revised(id, expectedNoteHash, change, at ?? new Date().toISOString());
      if (!("written" in revised)) return revised;
      await replaceNote(revised.stored.path, revised.raw, revised.written, this.#rename);
      return { status: "saved", stored: { record: revised.next, path: revised.stored.path, relativePath: revised.stored.relativePath, noteHash: hash(revised.written) } };
    });
  }

  /** What `reviseProperties` with the same arguments would write, its hash, nothing written. */
  previewProperties(id: string, expectedNoteHash: string, change: (record: ExperienceRecord) => Pick<ExperienceRecord, "status" | "sources">, at: string): Promise<ExperienceWrite | { status: "preview"; noteHash: string }> {
    return this.#serial(async () => {
      const revised = await this.#revised(id, expectedNoteHash, change, at);
      return "written" in revised ? { status: "preview", noteHash: hash(revised.written) } : revised;
    });
  }

  async #revised(id: string, expectedNoteHash: string, change: (record: ExperienceRecord) => Pick<ExperienceRecord, "status" | "sources">, at: string):
    Promise<Exclude<ExperienceWrite, { status: "saved" }> | { stored: StoredExperience; raw: string; next: ExperienceRecord; written: string }> {
    let stored: StoredExperience | null;
    try {
      stored = await this.find(id, { sure: true });
    } catch (error) {
      return { status: "unavailable", message: error instanceof Error ? error.message : String(error) };
    }
    if (stored === null) return { status: "not_found" };
    const raw = await existingNote(stored.path);
    if (raw === null) return { status: "not_found" };
    if (hash(raw) !== expectedNoteHash) return { status: "conflict", stored };
    const current = parseExperience(raw);
    const changed = change(current);
    if (changed.status === current.status && canonical(changed.sources) === canonical(current.sources)) return { status: "unchanged", stored };
    const next: ExperienceRecord = { ...current, ...changed, revision: current.revision + 1, updatedAt: at };
    const markdown = normalizedNote(raw);
    const { boundary, body } = split(markdown);
    const properties = withProperties(markdown.slice(4, boundary), propertiesOf(next));
    const written = inFormOf(raw, `---\n${properties}\n---\n${body}`);
    if (canonical(parseExperience(written)) !== canonical(next)) throw new Error("经验笔记改动后读回不一致，没有写入");
    return { stored, raw, next, written };
  }

  /** The note to the wastebasket, only as it was read: changed since, it stays (conflict). Never unlinked here. */
  trash(id: string, expectedNoteHash: string | null, trash: (path: string) => Promise<void>): Promise<ExperienceWrite> {
    return this.#serial(async () => {
      let stored: StoredExperience | null;
      try {
        stored = await this.find(id, { sure: true });
      } catch (error) {
        return { status: "unavailable", message: error instanceof Error ? error.message : String(error) };
      }
      if (stored === null) return { status: "not_found" };
      const raw = await existingNote(stored.path);
      if (raw === null) return { status: "not_found" };
      if (expectedNoteHash !== null && hash(raw) !== expectedNoteHash) return { status: "conflict", stored };
      await trash(stored.path);
      return { status: "saved", stored };
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

export const experienceNoteHash = hash;
