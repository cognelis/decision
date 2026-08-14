import type {
  MethodologyHistoryEntry,
  MethodologyHistoryReason,
  MethodologyRecord,
} from "@cognelis/decision-core";
import {
  parseMethodology,
  serializeMethodology,
} from "@cognelis/decision-storage";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const HISTORY_LIMIT = 20;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const reasons: MethodologyHistoryReason[] = [
  "revision_applied",
  "restore_checkpoint",
];

interface StoredEntry {
  version: number;
  capturedAt: string;
  reason: MethodologyHistoryReason;
  markdown: string;
}

interface StoredHistory {
  version: 1;
  methodologyId: string;
  nextVersion: number;
  entries: StoredEntry[];
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireDate = (value: unknown): string => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("原则版本历史损坏：时间无效");
  }
  return value;
};

const parseHistory = (
  methodologyId: string,
  value: unknown,
): StoredHistory => {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    value.methodologyId !== methodologyId ||
    !Number.isSafeInteger(value.nextVersion) ||
    (value.nextVersion as number) < 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > HISTORY_LIMIT
  ) {
    throw new Error("原则版本历史损坏，已停止写入以保护现有版本");
  }
  const entries = value.entries.map((raw): StoredEntry => {
    if (
      !isObject(raw) ||
      !Number.isSafeInteger(raw.version) ||
      (raw.version as number) < 1 ||
      !reasons.includes(raw.reason as MethodologyHistoryReason) ||
      typeof raw.markdown !== "string" ||
      raw.markdown.length === 0 ||
      raw.markdown.length > 200_000
    ) {
      throw new Error("原则版本历史损坏：版本字段无效");
    }
    const snapshot = parseMethodology(raw.markdown);
    if (snapshot.id !== methodologyId) {
      throw new Error("原则版本历史损坏：原则编号不一致");
    }
    return {
      version: raw.version as number,
      capturedAt: requireDate(raw.capturedAt),
      reason: raw.reason as MethodologyHistoryReason,
      markdown: raw.markdown,
    };
  });
  if (
    entries.some(
      (entry, index) =>
        index > 0 && entry.version <= (entries[index - 1]?.version ?? 0),
    ) ||
    entries.some((entry) => entry.version >= (value.nextVersion as number))
  ) {
    throw new Error("原则版本历史损坏：版本顺序无效");
  }
  return {
    version: 1,
    methodologyId,
    nextVersion: value.nextVersion as number,
    entries,
  };
};

const emptyHistory = (methodologyId: string): StoredHistory => ({
  version: 1,
  methodologyId,
  nextVersion: 1,
  entries: [],
});

const atomicWrite = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export class MethodologyHistoryStore {
  readonly #root: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async list(methodologyId: string): Promise<MethodologyHistoryEntry[]> {
    const history = await this.#load(methodologyId);
    return history.entries
      .map((entry) => ({
        version: entry.version,
        capturedAt: entry.capturedAt,
        reason: entry.reason,
        snapshot: parseMethodology(entry.markdown),
      }))
      .reverse();
  }

  async find(
    methodologyId: string,
    version: number,
  ): Promise<MethodologyHistoryEntry | null> {
    return (
      (await this.list(methodologyId)).find(
        (entry) => entry.version === version,
      ) ?? null
    );
  }

  async capture(
    methodology: MethodologyRecord,
    reason: MethodologyHistoryReason,
    capturedAt: string,
  ): Promise<MethodologyHistoryEntry> {
    return this.#exclusive(async () => {
      await this.#ensureSafeDirectories();
      const history = await this.#load(methodology.id);
      const markdown = serializeMethodology(methodology);
      const latest = history.entries.at(-1);
      if (latest?.markdown === markdown) {
        return {
          version: latest.version,
          capturedAt: latest.capturedAt,
          reason: latest.reason,
          snapshot: methodology,
        };
      }
      const stored: StoredEntry = {
        version: history.nextVersion,
        capturedAt: requireDate(capturedAt),
        reason,
        markdown,
      };
      history.nextVersion += 1;
      history.entries.push(stored);
      history.entries = history.entries.slice(-HISTORY_LIMIT);
      await atomicWrite(
        this.#path(methodology.id),
        `${JSON.stringify(history, null, 2)}\n`,
      );
      return { ...stored, snapshot: methodology };
    });
  }

  async #load(methodologyId: string): Promise<StoredHistory> {
    await this.#assertExistingDirectoriesSafe();
    const path = this.#path(methodologyId);
    try {
      const fileStats = await lstat(path);
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        throw new Error("原则版本历史路径不安全");
      }
      if ((await stat(path)).size > MAX_HISTORY_BYTES) {
        throw new Error("原则版本历史超过安全大小限制");
      }
      return parseHistory(
        methodologyId,
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
    } catch (error) {
      if (isMissing(error)) return emptyHistory(methodologyId);
      if (error instanceof SyntaxError) {
        throw new Error("原则版本历史损坏，已停止写入以保护现有版本");
      }
      throw error;
    }
  }

  #path(methodologyId: string): string {
    const digest = createHash("sha256")
      .update(methodologyId, "utf8")
      .digest("hex");
    const path = join(this.#root, "principles", `${digest}.json`);
    if (!path.startsWith(`${this.#root}${sep}`)) {
      throw new Error("原则版本历史路径越界");
    }
    return path;
  }

  async #assertExistingDirectoriesSafe(): Promise<void> {
    for (const path of [this.#root, join(this.#root, "principles")]) {
      try {
        const pathStats = await lstat(path);
        if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
          throw new Error("原则版本历史目录不安全");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }

  async #ensureSafeDirectories(): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const principlesRoot = join(this.#root, "principles");
    await mkdir(principlesRoot, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      ) {
        throw error;
      }
    });
    await this.#assertExistingDirectoriesSafe();
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
