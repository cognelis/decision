import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
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
    steps: z.array(z.string().max(500)).max(12),
    checks: z.array(z.string().max(500)).max(8),
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
  readonly #now: () => Date;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = resolve(path);
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
      return structuredClone(draft);
    });
  }

  async delete(key: ManualFormDraftKey): Promise<void> {
    const parsedKey = draftKeySchema.parse(key);
    await this.#exclusive(async () => {
      const document = await this.#load();
      const remaining = document.drafts.filter(
        (draft) => draft.key !== parsedKey,
      );
      if (remaining.length === document.drafts.length) return;
      document.drafts = remaining;
      await this.#write(document);
    });
  }

  async #load(): Promise<StoredDocument> {
    try {
      const fileStats = await lstat(this.#path);
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        throw new Error("未完成表单草稿路径不安全");
      }
      if ((await stat(this.#path)).size > MAX_FILE_BYTES) {
        throw new Error("未完成表单草稿超过安全大小限制");
      }
      const parsed = storedDocumentSchema.parse(
        JSON.parse(await readFile(this.#path, "utf8")) as unknown,
      );
      return parsed as StoredDocument;
    } catch (error) {
      if (isMissing(error)) return emptyDocument();
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new Error("未完成表单草稿损坏，已停止写入以保护现有内容");
      }
      throw error;
    }
  }

  async #write(document: StoredDocument): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error("未完成表单草稿目录不安全");
    }
    await chmod(directory, 0o700);
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
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
