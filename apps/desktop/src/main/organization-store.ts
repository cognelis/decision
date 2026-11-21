import {
  organizationRunViewSchema,
  organizationSettingsSchema,
  organizationSourceKeySchema,
  sourceRoleSchema,
  suggestionContentSchema,
  suggestionDraftSchema,
  suggestionStaleReasonSchema,
  suggestionStateSchema,
  suggestionTypeSchema,
  organizationSourceKindSchema,
} from "@cognelis/decision-protocol";
import { renameReplacing } from "@cognelis/decision-storage";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gzip, gunzip } from "node:zlib";
import { z } from "zod";

/**
 * 整理与记忆在本机的全部状态（IMP-191）：建议与回执、游标与变更队列、阅读层注记、运行记录、设置。一个 JSON 文件，
 * 每次写都是「读 → 校验 → 改 → 临时文件改名替换」，一次一个。读不出的文件不覆盖：它可能还有不能从 Markdown 重建的
 * 拒绝回执与游标。大状态无损压缩在同一文件中，旧版不能读取时停止写入，不能回落为空记录。
 */

export const ORGANIZATION_DAMAGED = "整理记录读不出来，已停止写入以保护现有记录。";
const MAX_BYTES = 8 * 1024 * 1024;
// shortcut: 仍需整份解压与校验；超过当前有界容量或内存预算时再拆分状态。
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
const compress = promisify(gzip);
const decompress = promisify(gunzip);
const compressedStateSchema = z.object({ version: z.literal(2), compression: z.literal("gzip"), data: z.string().max(MAX_BYTES) }).strict();

const key = organizationSourceKeySchema;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const iso = z.iso.datetime();

export const storedSourceSchema = z.object({
  key,
  kind: organizationSourceKindSchema,
  role: sourceRoleSchema,
  label: z.string().max(500),
  rootKeys: z.array(key).min(1).max(20),
  lineage: z.enum(["self", "traced"]),
  fingerprint: sha,
  evidenceFingerprint: sha,
  /** 判断时实际用到的原文摘录；来源删除或被遗忘后为 null。 */
  basis: z.object({ excerpt: z.string().max(600), excerptHash: sha }).nullable(),
  project: z.string().max(500).nullable(),
  relativePath: z.string().max(2_000).nullable(),
  at: z.string().max(100).nullable(),
}).strict();

const receiptSchema = z.object({
  action: z.enum(["adopt", "defer", "reject", "reopen", "undo", "hold", "reopened_by_evidence", "invalidated", "forgotten"]),
  at: iso,
  revision: z.number().int().positive(),
  /** 不采纳时各来源的实质证据指纹：只存哈希，不存正文。 */
  evidence: z.record(z.string(), sha).optional(),
  note: z.string().max(1_000).optional(),
}).strict();

export const applyStepSchema = z.object({
  stepId: z.string().max(200),
  kind: z.enum(["todo_detail", "amendment_revise", "relation_save", "experience_create", "experience_activate", "experience_archive", "annotation_put"]),
  target: z.string().max(300),
  /** 写入时的版本条件。 */
  expected: z.object({
    itemHash: sha.optional(), contentHash: sha.optional(), revision: z.number().int().nonnegative().optional(), noteHash: sha.nullable().optional(),
    /** The whole note a property write will leave (experience_archive), its hash: written down before the write is made. */
    afterHash: sha.optional(),
  }).strict(),
  /** 撤销与恢复用的原值、预期写入值；受遗忘清除约束。 */
  before: z.unknown(),
  after: z.unknown(),
  state: z.enum(["planned", "writing", "written", "failed", "conflict"]),
  result: z.object({ revision: z.number().int().nonnegative().optional(), hash: sha.optional(), message: z.string().max(500).optional(), relativePath: z.string().max(2_000).optional() }).strict().optional(),
}).strict();

export const applyPlanSchema = z.object({
  opId: z.string().max(100),
  action: z.enum(["adopt", "undo"]),
  dependencies: z.array(z.object({ key, fingerprint: sha }).strict()).max(40),
  steps: z.array(applyStepSchema).max(10),
  phase: z.enum(["planned", "writing", "verifying", "done", "partial"]),
  startedAt: iso,
}).strict();

export const storedSuggestionSchema = z.object({
  id: z.string().max(200),
  type: suggestionTypeSchema,
  project: z.string().max(500).nullable(),
  anchor: z.array(key).min(1).max(10),
  revision: z.number().int().positive(),
  evidence: z.object({
    version: z.number().int().positive(),
    inputFingerprint: sha,
    sources: z.array(storedSourceSchema).max(20),
    counter: z.array(storedSourceSchema).max(10),
  }).strict(),
  content: suggestionContentSchema.nullable(),
  title: z.string().max(500),
  why: z.string().max(1_000),
  effect: z.string().max(1_000),
  unchanged: z.string().max(1_000),
  model: z.object({ profileId: z.string().max(200), model: z.string().max(200), promptVersion: z.string().max(100), requestIds: z.array(z.string().max(300)).max(50) }).strict().nullable(),
  /** 实际模型输入，用于遗忘；不是额外的支持证据。旧记录从尚存的调用账本补回。 */
  inputKeys: z.array(key).max(2048).optional(),
  /** 直接输入与保留旧草稿的依赖；旧格式只保守沿用已知祖先，不推测哪些曾被直接读取。 */
  directInputKeys: z.array(key).max(2048).optional(),
  state: suggestionStateSchema,
  mergedInto: z.string().max(200).nullable(),
  revises: z.string().max(200).optional(),
  stale: z.object({ reason: suggestionStaleReasonSchema, at: iso, keys: z.array(key).max(50) }).strict().nullable(),
  deferUntil: z.string().max(100).nullable(),
  draft: suggestionDraftSchema.nullable(),
  reopenReason: z.string().max(1_000).nullable(),
  receipts: z.array(receiptSchema).max(100),
  apply: applyPlanSchema.nullable(),
  appliedAt: iso.nullable(),
  automatic: z.boolean().optional(),
  redacted: z.boolean(),
  createdAt: iso,
  updatedAt: iso,
}).strict();

const contextLinkSchema = z.object({
  key, title: z.string().max(500), whyRelevant: z.string().max(600), scopeNote: z.string().max(600).nullable(),
}).strict();

export const organizationStateSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  settings: organizationSettingsSchema,
  ledger: z.object({
    seen: z.record(z.string(), z.object({ fingerprint: sha, evidenceFingerprint: sha }).strict()),
    queue: z.array(z.object({ key, reason: z.enum(["new", "changed"]), at: iso }).strict()).max(20_000),
    /** 处理过的分组：组键 → 输入指纹（不含模型、提示词）。 */
    processed: z.record(z.string(), sha),
    /**
     * 每次模型调用发出之前记下：requestId 与它读了哪些来源。遗忘按它删调用记录，无论那次调用产出了建议、被校验拒绝
     * 还是失败。只存 key，不存正文。
     */
    calls: z.array(z.object({ requestId: z.string().max(300), keys: z.array(key).max(2048), directKeys: z.array(key).max(40).optional(), at: iso }).strict()).max(5_000).default([]),
    /** 尚未完成的调用留痕清理；调用结束并确实删除后移除，来源遗忘回执不受影响。 */
    pendingTraceDeletes: z.array(z.string().max(300)).max(5_000).optional(),
    /** 被遗忘或确认删除的来源与时间：在那之前开始的运行与采纳，凡用到它的一律不写回。 */
    forgotten: z.record(z.string(), iso).default({}),
    forgottenEvidence: z.record(z.string(), sha).default({}),
  }).strict(),
  suggestions: z.record(z.string(), storedSuggestionSchema),
  annotations: z.object({
    groups: z.record(z.string(), z.object({ revision: z.number().int().positive(), title: z.string().max(300), members: z.array(key).max(10) }).strict()),
    beforeStart: z.record(z.string(), z.array(z.object({ suggestionId: z.string().max(200), revision: z.number().int().positive(), link: contextLinkSchema }).strict()).max(5)),
  }).strict(),
  runs: z.array(organizationRunViewSchema).max(300),
  activeRun: organizationRunViewSchema.nullable(),
  lastBackgroundAt: iso.nullable(),
}).strict();

export type OrganizationState = z.infer<typeof organizationStateSchema>;
export type StoredSuggestion = z.infer<typeof storedSuggestionSchema>;
export const modelInputKeys = (state: OrganizationState, requestIds: readonly string[]): string[] => {
  const ids = new Set(requestIds);
  return [...new Set(state.ledger.calls.filter((call) => ids.has(call.requestId)).flatMap((call) => call.keys))];
};
export const modelDirectInputKeys = (state: OrganizationState, requestIds: readonly string[]): string[] | undefined => {
  const calls = new Map(state.ledger.calls.map((call) => [call.requestId, call]));
  if (requestIds.some((id) => calls.get(id)?.directKeys === undefined)) return undefined;
  return [...new Set(requestIds.flatMap((id) => calls.get(id)!.directKeys!))];
};
export type StoredSource = z.infer<typeof storedSourceSchema>;
export type ApplyPlan = z.infer<typeof applyPlanSchema>;
export type ApplyStep = z.infer<typeof applyStepSchema>;

export const emptyOrganizationState = (): OrganizationState => ({
  version: 1,
  revision: 0,
  settings: { background: false, backgroundProfileId: null },
  ledger: { seen: {}, queue: [], processed: {}, calls: [], forgotten: {}, forgottenEvidence: {} },
  suggestions: {},
  annotations: { groups: {}, beforeStart: {} },
  runs: [],
  activeRun: null,
  lastBackgroundAt: null,
});

const isMissing = (error: unknown): boolean => error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

export class OrganizationDamagedError extends Error {
  constructor(cause?: unknown) {
    super(ORGANIZATION_DAMAGED, { cause });
    this.name = "OrganizationDamagedError";
  }
}

export class OrganizationStore {
  readonly #path: string;
  readonly #onWritten: (state: OrganizationState) => void;
  #tail: Promise<unknown> = Promise.resolve();
  #decoded: { hash: string; json: string } | null = null;
  #loading: { hash: string; value: Promise<string> } | null = null;

  constructor(path: string, onWritten: (state: OrganizationState) => void = () => undefined) {
    this.#path = resolve(path);
    this.#onWritten = onWritten;
  }

  /** The state as the file holds it; none yet is the empty state. Damaged: OrganizationDamagedError, never the empty one. */
  async read(): Promise<OrganizationState> {
    let hash: string | undefined;
    try {
      const status = await lstat(this.#path);
      if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_BYTES) throw new OrganizationDamagedError();
      const bytes = await readFile(this.#path);
      if (bytes.length > MAX_BYTES) throw new OrganizationDamagedError();
      hash = createHash("sha256").update(bytes).digest("hex");
      const cached = this.#decoded?.hash === hash ? this.#decoded.json : null;
      if (cached === null) this.#decoded = null;
      const json = cached ?? await this.#load(hash, bytes);
      const decoded: unknown = JSON.parse(json);
      const parsed = organizationStateSchema.safeParse(decoded);
      if (!parsed.success) throw new OrganizationDamagedError(parsed.error);
      // shortcut: 旧调用账本已丢失的输入无法还原，历史产物需另行审定。
      const inputs = new Map(parsed.data.ledger.calls.map((call) => [call.requestId, call.keys]));
      for (const suggestion of Object.values(parsed.data.suggestions)) {
        suggestion.inputKeys ??= [...new Set([...suggestion.anchor, ...suggestion.evidence.sources.map((source) => source.key), ...suggestion.evidence.counter.map((source) => source.key), ...(suggestion.model?.requestIds ?? []).flatMap((id) => inputs.get(id) ?? [])])];
      }
      // Only immutable text is reused; every caller still gets a newly parsed, validated object.
      if (cached === null) this.#decoded = { hash, json };
      return parsed.data;
    } catch (error) {
      this.#decoded = null;
      if (isMissing(error)) return emptyOrganizationState();
      if (error instanceof OrganizationDamagedError) throw error;
      if (error instanceof SyntaxError) throw new OrganizationDamagedError(error);
      throw error;
    } finally {
      if (this.#loading?.hash === hash) this.#loading = null;
    }
  }

  #load(hash: string, bytes: Buffer): Promise<string> {
    if (this.#loading?.hash === hash) return this.#loading.value;
    const value = (async () => {
      const json = bytes.toString("utf8");
      const decoded: unknown = JSON.parse(json);
      if (decoded === null || typeof decoded !== "object" || !("version" in decoded) || decoded.version !== 2) return json;
      try {
        const envelope = compressedStateSchema.parse(decoded);
        const compressed = Buffer.from(envelope.data, "base64");
        if (compressed.toString("base64") !== envelope.data) throw new Error("Invalid compressed state encoding");
        return (await decompress(compressed, { maxOutputLength: MAX_EXPANDED_BYTES })).toString("utf8");
      } catch (error) { throw new OrganizationDamagedError(error); }
    })();
    this.#loading = { hash, value };
    return value;
  }

  /**
   * One change, in turn with every other: `change` gets the state as the file holds it now and answers with the state to
   * write (null: nothing to write) and what to tell the caller. The revision moves by one with each write.
   */
  update<T>(change: (state: OrganizationState) => { state: OrganizationState | null; value: T }): Promise<T> {
    const run = this.#tail.then(async () => {
      const current = await this.read();
      // read() already owns this snapshot; it is never shared with another reader or cached.
      const { state, value } = change(current);
      if (state === null) return value;
      const next = organizationStateSchema.parse({ ...state, revision: current.revision + 1 });
      let content = `${JSON.stringify(next)}\n`;
      if (Buffer.byteLength(content) > MAX_EXPANDED_BYTES) throw new Error("整理记录内容超过了大小上限，这次没有写入");
      if (Buffer.byteLength(content) > MAX_BYTES) {
        content = `${JSON.stringify({ version: 2, compression: "gzip", data: (await compress(content)).toString("base64") })}\n`;
      }
      if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("整理记录超过了大小上限，这次没有写入");
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await renameReplacing(temporary, this.#path);
        this.#decoded = null;
        this.#loading = null;
      } catch (error) {
        this.#decoded = null;
        this.#loading = null;
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      this.#onWritten(next);
      return value;
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Waits for the writes queued so far (the app's quit). */
  async idle(): Promise<void> {
    await this.#tail;
  }
}
