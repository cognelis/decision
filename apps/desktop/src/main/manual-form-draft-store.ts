import { renameReplacing } from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import type {
  ManualFormDraft,
  ManualFormDraftInput,
  ManualFormDraftKey,
} from "../shared/renderer-api.js";

const MAX_FILE_BYTES = 512 * 1024;

const draftKeySchema = z.enum([
  "methodology_manual",
  "methodology_evidence_manual",
  "methodology_merge",
  "methodology_revision",
  "practice_asset_manual",
]);
const sourceIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "草稿来源不能重复",
  });
const methodologyInputSchema = z
  .object({
    title: z.string().max(120),
    principle: z.string().max(2_000),
    appliesWhen: z.string().max(2_000),
    caution: z.string().max(2_000),
  })
  .strict();
const methodologyEvidenceInputSchema = methodologyInputSchema
  .extend({
    evidenceSummary: z.string().max(3_000),
    sourceDecisionIds: sourceIdsSchema,
  })
  .strict();
const mergeSourcePrincipleIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .min(2)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "合并草稿来源不能重复",
  });
const mergeEvidenceIdsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "合并草稿证据不能重复",
  });
const methodologyMergeInputSchema = methodologyInputSchema
  .extend({
    evidenceSummary: z.string().max(3_000),
    sourceDecisionIds: mergeEvidenceIdsSchema,
  })
  .strict();
const practiceInputSchema = z
  .object({
    title: z.string().max(120),
    summary: z.string().max(800),
    trigger: z.string().max(1_500),
    // Looser than a saved asset (2–12 steps, 1–8 checks, 500 a line): a draft is what is still being
    // written, and the lines field takes any number of lines. At the asset's limits a thirteenth line
    // pasted in made every save fail, and closing the form lost all that was written since.
    steps: z.array(z.string().max(600)).max(30),
    checks: z.array(z.string().max(600)).max(20),
    fallback: z.string().max(1_500),
  })
  .strict();

export const manualFormDraftInputSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("methodology_manual"),
      input: methodologyInputSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("methodology_evidence_manual"),
      input: methodologyEvidenceInputSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("methodology_merge"),
      sourcePrincipleIds: mergeSourcePrincipleIdsSchema,
      input: methodologyMergeInputSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("methodology_revision"),
      sourcePrincipleId: z.string().trim().min(1).max(200),
      sourceUpdatedAt: z.string().datetime({ offset: true }),
      sourceSnapshot: methodologyMergeInputSchema.optional(),
      input: methodologyMergeInputSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("practice_asset_manual"),
      practiceKind: z.enum(["skill", "workflow"]),
      sourcePrincipleIds: sourceIdsSchema,
      input: practiceInputSchema,
    })
    .strict(),
]);

const updatedAtSchema = z.string().datetime({ offset: true });
const storedDraftSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("methodology_manual"),
      input: methodologyInputSchema,
      updatedAt: updatedAtSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("methodology_evidence_manual"),
      input: methodologyEvidenceInputSchema,
      updatedAt: updatedAtSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("methodology_merge"),
      sourcePrincipleIds: mergeSourcePrincipleIdsSchema,
      input: methodologyMergeInputSchema,
      updatedAt: updatedAtSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("methodology_revision"),
      sourcePrincipleId: z.string().trim().min(1).max(200),
      sourceUpdatedAt: updatedAtSchema,
      sourceSnapshot: methodologyMergeInputSchema.optional(),
      input: methodologyMergeInputSchema,
      updatedAt: updatedAtSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal("practice_asset_manual"),
      practiceKind: z.enum(["skill", "workflow"]),
      sourcePrincipleIds: sourceIdsSchema,
      input: practiceInputSchema,
      updatedAt: updatedAtSchema,
    })
    .strict(),
]);
const storedDocumentSchema = z
  .object({
    version: z.literal(1),
    drafts: z.array(storedDraftSchema).max(5),
  })
  .strict()
  .superRefine((document, context) => {
    const keys = document.drafts.map((draft) => draft.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "草稿类型不能重复",
        path: ["drafts"],
      });
    }
  });

interface StoredDocument {
  version: 1;
  drafts: ManualFormDraft[];
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const emptyDocument = (): StoredDocument => ({ version: 1, drafts: [] });

export class ManualFormDraftStore {
  readonly #path: string;
  /** 1.1.0's file: read until this build first writes its own, and only ever has drafts taken out of it since. */
  readonly #earlierPath: string;
  readonly #now: () => Date;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(path: string, now: () => Date = () => new Date()) {
    // Kept apart from 1.1.0's: a draft with more steps or checks than 1.1.0 takes made it call the whole file
    // corrupt, and every form's draft with it. ponytail: drafts 1.1.0 writes after this file exists are not read.
    this.#earlierPath = resolve(path);
    this.#path = this.#earlierPath.replace(/(\.json)?$/u, ".v2.json");
    this.#now = now;
  }

  async list(): Promise<ManualFormDraft[]> {
    const document = await this.#load();
    return structuredClone(document.drafts);
  }

  async save(input: ManualFormDraftInput): Promise<ManualFormDraft> {
    const parsed = manualFormDraftInputSchema.parse(
      input,
    ) as ManualFormDraftInput;
    return this.#exclusive(async () => {
      const document = await this.#load();
      const draft = {
        ...parsed,
        updatedAt: this.#now().toISOString(),
      } as ManualFormDraft;
      document.drafts = [
        ...document.drafts.filter((item) => item.key !== parsed.key),
        draft,
      ];
      await this.#write(document);
      await this.#forgetEarlier(parsed.key);
      return structuredClone(draft);
    });
  }

  async delete(key: ManualFormDraftKey): Promise<void> {
    const parsedKey = draftKeySchema.parse(key);
    await this.#exclusive(async () => {
      await this.#forgetEarlier(parsedKey);
      const document = await this.#load();
      const remaining = document.drafts.filter(
        (draft) => draft.key !== parsedKey,
      );
      if (remaining.length === document.drafts.length) return;
      document.drafts = remaining;
      await this.#write(document);
    });
  }

  /**
   * The same form's draft taken out of 1.1.0's file as this one replaces or ends it. Left there, its text (a
   * decision's private context, the ids it cites) stayed on disk for good, and 1.1.0 run again put a submitted
   * draft back in the form. Best effort: a file it cannot read or write is left as it was, the save or delete holds.
   */
  async #forgetEarlier(key: ManualFormDraftKey): Promise<void> {
    try {
      const earlier = await this.#read(this.#earlierPath);
      if (earlier === null || !earlier.drafts.some((draft) => draft.key === key)) return;
      await this.#write({ ...earlier, drafts: earlier.drafts.filter((draft) => draft.key !== key) }, this.#earlierPath);
    } catch {
      // Left as it was.
    }
  }

  async #load(): Promise<StoredDocument> {
    return (await this.#read(this.#path)) ?? (await this.#read(this.#earlierPath)) ?? emptyDocument();
  }

  async #read(path: string): Promise<StoredDocument | null> {
    try {
      const fileStats = await lstat(path);
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        throw new Error("未完成表单草稿路径不安全");
      }
      if ((await stat(path)).size > MAX_FILE_BYTES) {
        throw new Error("未完成表单草稿超过安全大小限制");
      }
      const parsed = storedDocumentSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
      return parsed as StoredDocument;
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new Error("未完成表单草稿损坏，已停止写入以保护现有内容");
      }
      throw error;
    }
  }

  async #write(document: StoredDocument, path = this.#path): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error("未完成表单草稿目录不安全");
    }
    await chmod(directory, 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await renameReplacing(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
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
