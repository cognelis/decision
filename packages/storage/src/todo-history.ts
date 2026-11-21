import type { TodoEvent, TodoItemStatus, TodoPriority } from "@cognelis/decision-protocol";
import { TODO_LIMITS, todoDependencyIdsSchema, todoDueSchema, todoEventSchema, todoItemStatusSchema, todoPrioritySchema, todoTagsSchema } from "@cognelis/decision-protocol";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { noteChangedMeanwhile } from "./note-rewrite.js";
import { renameReplacing } from "./replace-file.js";

/** What the App keeps of one todo list on this machine, outside its note (IMP-185). */
export interface TodoHistory {
  /** The status the App last wrote for each item, by its number. */
  recorded: Record<string, TodoItemStatus>;
  /** The 优先级 and 截止日期 the App last wrote for each item; absent in a file from before they were kept. */
  recordedFields: Record<string, { priority: TodoPriority | null; due: string | null; tags?: string[]; dependsOn?: string[] | undefined; legacyHigh?: true }>;
  /** Every change, oldest first, with who made it, when, and what was said. */
  events: TodoEvent[];
}

const MAX_BYTES = 4 * 1024 * 1024;
// Only the unfinished write holds two individually bounded snapshots.
const MAX_PENDING_BYTES = 2 * MAX_BYTES + 1024;
const HASH = /^[a-f0-9]{64}$/u;

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Said where the list is shown and where a write to it is refused: written over, what it still held would be gone.
const DAMAGED = "这份清单的变更记录读不出来，已停止写入以保护现有记录";

const parsed = (listId: string, value: unknown): TodoHistory => {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.listId !== listId ||
    !isObject(value.recorded) ||
    !Array.isArray(value.events) ||
    value.events.length > TODO_LIMITS.history
  ) {
    throw new Error(DAMAGED);
  }
  const recorded: Record<string, TodoItemStatus> = {};
  for (const [number, status] of Object.entries(value.recorded)) {
    const checked = todoItemStatusSchema.safeParse(status);
    if (!/^[1-9]\d{0,5}$/u.test(number) || !checked.success) throw new Error(DAMAGED);
    recorded[number] = checked.data;
  }
  const recordedFields: TodoHistory["recordedFields"] = {};
  if (value.recordedFields !== undefined) {
    if (!isObject(value.recordedFields)) throw new Error(DAMAGED);
    for (const [number, fields] of Object.entries(value.recordedFields)) {
      const priority = isObject(fields) ? todoPrioritySchema.nullable().safeParse(fields.priority) : null;
      const due = isObject(fields) ? todoDueSchema.nullable().safeParse(fields.due) : null;
      // Absent in a file from before tags were kept: those are then taken as they stand.
      const tags = isObject(fields) && fields.tags !== undefined ? todoTagsSchema.safeParse(fields.tags) : null;
      const dependencies = isObject(fields) && fields.dependsOn !== undefined ? todoDependencyIdsSchema.safeParse(fields.dependsOn) : null;
      if (dependencies !== null && !dependencies.success) throw new Error(DAMAGED);
      if (!/^[1-9]\d{0,5}$/u.test(number) || !priority?.success || !due?.success || (tags !== null && !tags.success)) throw new Error(DAMAGED);
      // 「high」 was written for P1 and for 🔺 alike (before P0–P3): read as P1, but not proof that the note had ⏫.
      const legacyHigh = isObject(fields) && fields.priority === "high";
      recordedFields[number] = { priority: priority.data, due: due.data, ...(tags === null ? {} : { tags: tags.data }), ...(dependencies === null ? {} : { dependsOn: dependencies.data }), ...(legacyHigh ? { legacyHigh: true as const } : {}) };
    }
  }
  const events = value.events.map((event) => {
    const checked = todoEventSchema.safeParse(event);
    if (!checked.success) throw new Error(DAMAGED);
    return checked.data;
  });
  return { recorded, recordedFields, events };
};

/**
 * 待办清单' change history and the status the App last wrote for each item, one JSON file per list under the App's own
 * data folder, never in the vault: the user keeps the note for the list itself (IMP-185). Written whole, by a temporary
 * file renamed over the old one; one that cannot be read is not written over, so what it holds is not lost.
 */
export class TodoHistoryStore {
  readonly #root: string;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /** A pending write is resolved only against a fresh note identity, after earlier writes finish. */
  read(listId: string, noteHash?: () => Promise<string | null>): Promise<TodoHistory | null> {
    return this.#enqueue(() => this.#read(listId, noteHash));
  }

  async #read(listId: string, noteHash?: () => Promise<string | null>): Promise<TodoHistory | null> {
    await this.#assertSafe();
    const path = this.#path(listId);
    let value: unknown;
    try {
      const status = await lstat(path);
      if (status.isSymbolicLink() || !status.isFile() || status.size > MAX_PENDING_BYTES) throw new Error(DAMAGED);
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw) > MAX_PENDING_BYTES) throw new Error(DAMAGED);
      value = JSON.parse(raw) as unknown;
      if (!isObject(value) || value.version !== 2) {
        if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error(DAMAGED);
        return parsed(listId, value);
      }
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof SyntaxError) throw new Error(DAMAGED, { cause: error });
      throw error;
    }
    if (Object.keys(value).some(key => !["version", "listId", "beforeHash", "afterHash", "before", "after"].includes(key)) || value.listId !== listId || !(value.beforeHash === null || (typeof value.beforeHash === "string" && HASH.test(value.beforeHash))) || typeof value.afterHash !== "string" || !HASH.test(value.afterHash)) throw new Error(DAMAGED);
    const before = value.before === null ? null : parsed(listId, value.before);
    const after = parsed(listId, value.after);
    const beforeText = before === null ? null : this.#serialized(listId, value.before);
    const afterText = this.#serialized(listId, value.after);
    if (!noteHash) throw new Error("这份清单有未完成的写入，需先核对笔记后恢复，现有记录保持不变");
    const current = await noteHash();
    const recovered = current === value.afterHash ? after : value.beforeHash !== null && current === value.beforeHash ? before : undefined;
    if (recovered === undefined) throw new Error("待办笔记在写入中断后又被修改，已保留前后两份变更记录并停止覆盖，请先核对");
    if (recovered === null) await unlink(path);
    else await this.#replace(listId, current === value.afterHash ? afterText : beforeText!);
    return recovered;
  }

  /** Writes local history alone (legacy migration and callers with no Markdown change). */
  write(listId: string, history: TodoHistory): Promise<void> {
    return this.#enqueue(async () => {
      await this.#read(listId);
      await this.#replace(listId, this.#encoded(listId, history));
    });
  }

  /** The note and its non-rebuildable history share a recoverable, bounded intent. */
  writeWithNote(listId: string, history: TodoHistory, hashes: { before: string | null; after: string }, writeNote: () => Promise<void>, noteHash: () => Promise<string | null>): Promise<void> {
    return this.#enqueue(async () => {
      const before = await this.#read(listId, noteHash);
      if (!(hashes.before === null || HASH.test(hashes.before)) || !HASH.test(hashes.after)) throw new Error(DAMAGED);
      const beforeText = before === null ? null : this.#serialized(listId, JSON.parse(await readFile(this.#path(listId), "utf8")));
      const after = this.#encoded(listId, history);
      const pending = `${JSON.stringify({ version: 2, listId, beforeHash: hashes.before, afterHash: hashes.after, before: beforeText === null ? null : JSON.parse(beforeText), after: JSON.parse(after) })}\n`;
      if (Buffer.byteLength(pending) > MAX_PENDING_BYTES) throw new Error("这份清单的恢复记录超过了大小上限，这次没有写入");
      await this.#replace(listId, pending);
      try { await writeNote(); }
      catch (error) {
        // A version-check refusal proves the note was not written; other I/O failures keep the intent.
        if (noteChangedMeanwhile(error)) {
          if (before === null) await unlink(this.#path(listId));
          else await this.#replace(listId, beforeText!);
        }
        throw error;
      }
      await this.#replace(listId, after);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation); this.#tail = next.catch(() => undefined); return next;
  }

  #encoded(listId: string, history: TodoHistory): string {
    return this.#serialized(listId, { version: 1, listId, recorded: history.recorded, recordedFields: history.recordedFields, events: history.events });
  }

  #serialized(listId: string, value: unknown): string {
    parsed(listId, value);
    const content = `${JSON.stringify(value, null, 1)}\n`;
    if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("这份清单的变更记录超过了大小上限，这次没有写入");
    return content;
  }

  async #replace(listId: string, content: string): Promise<void> {
    await this.#assertSafe();
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await this.#assertSafe();
    const path = this.#path(listId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await renameReplacing(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  #path(listId: string): string {
    const path = join(this.#root, `${createHash("sha256").update(listId, "utf8").digest("hex")}.json`);
    if (!path.startsWith(`${this.#root}${sep}`)) throw new Error("待办变更记录的路径越界");
    return path;
  }

  /** The folder, when it is there, is a folder of its own: not a link that leads somewhere else. */
  async #assertSafe(): Promise<void> {
    try {
      const status = await lstat(this.#root);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("待办变更记录的目录不安全");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}
