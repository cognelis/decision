import { randomUUID } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

import type { PromptInput, PromptItem, PromptUpdate } from "../shared/renderer-api.js";
import { PROMPT_EXAMPLES } from "../shared/prompt-examples.js";
import { atomicWrite } from "./atomic-write.js";

/**
 * The reader's own prompts: a title and a body each, nothing more. Kept in one file under the App's data folder and
 * never in the vault, so no search, recall or review ever reads one as a note, a decision or a principle.
 *
 * The three examples are written only when the file does not exist yet. Once it does, even with no prompts left in
 * it, nothing is put back: an example the reader edited or deleted stays that way across restarts and upgrades.
 */

export const PROMPT_LIMITS = { title: 120, body: 20_000, count: 500 } as const;
// Room for every prompt at its longest, three bytes a character.
const MAX_FILE_BYTES = 32 * 1024 * 1024;


const titleSchema = z
  .string()
  .trim()
  .min(1, "标题不能为空")
  .max(PROMPT_LIMITS.title, `标题不能超过 ${PROMPT_LIMITS.title} 字`)
  .refine((title) => !/[\r\n]/u.test(title), "标题只能是一行");
// The body is kept as written: only a body of nothing but blanks is refused.
const bodySchema = z
  .string()
  .max(PROMPT_LIMITS.body, `正文不能超过 ${PROMPT_LIMITS.body} 字`)
  .refine((body) => body.trim().length > 0, "正文不能为空");
const idSchema = z.string().uuid();
const dateSchema = z.string().datetime({ offset: true });

export const promptInputSchema = z.object({ title: titleSchema, body: bodySchema }).strict();
export const promptUpdateSchema = promptInputSchema.extend({ id: idSchema, expectedUpdatedAt: dateSchema }).strict();
export const promptIdSchema = idSchema;
export const promptItemSchema = z
  .object({ id: idSchema, title: titleSchema, body: bodySchema, createdAt: dateSchema, updatedAt: dateSchema })
  .strict();
const documentSchema = z
  .object({ version: z.literal(1), prompts: z.array(promptItemSchema).max(PROMPT_LIMITS.count) })
  .strict()
  .refine((document) => new Set(document.prompts.map((prompt) => prompt.id)).size === document.prompts.length);

interface StoredDocument {
  version: 1;
  prompts: PromptItem[];
}

const CORRUPT = "提示词文件损坏，已停止读写以保护现有内容。修复或移走 prompts.json 后重启 Paraself（移走后会重新放入三条示例）。";

/** The first problem found, said plainly: a ZodError's own message is its issues as JSON. */
const parseOrSay = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "提示词无效");
  return parsed.data;
};

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";

export class PromptLibraryStore {
  readonly #path: string;
  readonly #now: () => Date;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = resolve(path);
    this.#now = now;
  }

  list(): Promise<PromptItem[]> {
    // Under the same lock as the writes: two first reads at once must not both write the examples.
    return this.#exclusive(async () => structuredClone((await this.#loadOrSeed()).prompts));
  }

  async create(input: PromptInput): Promise<PromptItem> {
    const parsed = parseOrSay(promptInputSchema, input);
    return this.#exclusive(async () => {
      const document = await this.#loadOrSeed();
      if (document.prompts.length >= PROMPT_LIMITS.count) throw new Error(`提示词最多 ${PROMPT_LIMITS.count} 条`);
      const at = this.#now().toISOString();
      const prompt: PromptItem = { id: randomUUID(), title: parsed.title, body: parsed.body, createdAt: at, updatedAt: at };
      await this.#write({ version: 1, prompts: [prompt, ...document.prompts] });
      return structuredClone(prompt);
    });
  }

  /** Refused when the prompt changed since the edit began (another window saved it): nothing is written over. */
  async update(input: PromptUpdate): Promise<PromptItem> {
    const parsed = parseOrSay(promptUpdateSchema, input);
    return this.#exclusive(async () => {
      const document = await this.#loadOrSeed();
      const index = document.prompts.findIndex((prompt) => prompt.id === parsed.id);
      const current = document.prompts[index];
      if (current === undefined) throw new Error("这条提示词已被删除");
      if (current.updatedAt !== parsed.expectedUpdatedAt) throw new Error("这条提示词在别处被修改过");
      // Strictly later than before, so an edit that follows within the same millisecond is still told apart.
      const at = new Date(Math.max(this.#now().getTime(), Date.parse(current.updatedAt) + 1)).toISOString();
      const next: PromptItem = { ...current, title: parsed.title, body: parsed.body, updatedAt: at };
      const prompts = [...document.prompts];
      prompts[index] = next;
      await this.#write({ version: 1, prompts });
      return structuredClone(next);
    });
  }

  async delete(id: string): Promise<void> {
    const parsed = parseOrSay(promptIdSchema, id);
    return this.#exclusive(async () => {
      const document = await this.#loadOrSeed();
      const prompts = document.prompts.filter((prompt) => prompt.id !== parsed);
      if (prompts.length === document.prompts.length) return;
      await this.#write({ version: 1, prompts });
    });
  }

  async #loadOrSeed(): Promise<StoredDocument> {
    try {
      const fileStats = await lstat(this.#path);
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) throw new Error("提示词文件路径不安全，已停止读写");
      if ((await stat(this.#path)).size > MAX_FILE_BYTES) throw new Error("提示词文件超过安全大小限制，已停止读写");
      const raw = await readFile(this.#path, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(CORRUPT);
      }
      const document = documentSchema.safeParse(parsed);
      if (!document.success) throw new Error(CORRUPT);
      return document.data;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const at = this.#now().toISOString();
    const seeded: StoredDocument = {
      version: 1,
      prompts: PROMPT_EXAMPLES.map((example) => ({ id: randomUUID(), ...example, createdAt: at, updatedAt: at })),
    };
    await this.#write(seeded);
    return seeded;
  }

  async #write(document: StoredDocument): Promise<void> {
    const content = `${JSON.stringify(document, null, 2)}\n`;
    // Checked before writing as well as on reading: a file written past the limit could not be read back.
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("提示词总量超过安全大小限制，未保存");
    await atomicWrite(this.#path, content);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#mutationTail;
    let release = (): void => undefined;
    this.#mutationTail = new Promise<void>((resolveMutation) => {
      release = resolveMutation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
