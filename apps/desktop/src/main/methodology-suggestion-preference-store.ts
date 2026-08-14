import { createHash, randomUUID } from "node:crypto";
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

const MAX_DEFERRED_SUGGESTIONS = 200;
const MAX_FILE_BYTES = 256 * 1024;

interface DeferredSuggestion {
  key: string;
  deferredAt: string;
}

interface StoredPreferences {
  version: 1;
  deferred: DeferredSuggestion[];
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const keyFor = (suggestionId: string): string =>
  createHash("sha256").update(suggestionId, "utf8").digest("hex");

const parsePreferences = (value: unknown): StoredPreferences => {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.deferred) ||
    value.deferred.length > MAX_DEFERRED_SUGGESTIONS
  ) {
    throw new Error("复盘素材搁置状态损坏，已停止写入以保护现有设置");
  }
  const keys = new Set<string>();
  const deferred = value.deferred.map((raw): DeferredSuggestion => {
    if (
      !isObject(raw) ||
      typeof raw.key !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.key) ||
      typeof raw.deferredAt !== "string" ||
      Number.isNaN(Date.parse(raw.deferredAt)) ||
      keys.has(raw.key)
    ) {
      throw new Error("复盘素材搁置状态损坏：记录字段无效");
    }
    keys.add(raw.key);
    return { key: raw.key, deferredAt: raw.deferredAt };
  });
  return { version: 1, deferred };
};

const emptyPreferences = (): StoredPreferences => ({
  version: 1,
  deferred: [],
});

export class MethodologySuggestionPreferenceStore {
  readonly #path: string;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async isDeferred(suggestionId: string): Promise<boolean> {
    const preferences = await this.#load();
    const key = keyFor(suggestionId);
    return preferences.deferred.some((item) => item.key === key);
  }

  async partition<T extends { id: string }>(
    suggestions: T[],
  ): Promise<{ active: T[]; deferred: T[] }> {
    const preferences = await this.#load();
    const deferredKeys = new Set(
      preferences.deferred.map((item) => item.key),
    );
    const active: T[] = [];
    const deferred: T[] = [];
    for (const suggestion of suggestions) {
      (deferredKeys.has(keyFor(suggestion.id)) ? deferred : active).push(
        suggestion,
      );
    }
    return { active, deferred };
  }

  async defer(suggestionId: string, deferredAt: string): Promise<void> {
    await this.#exclusive(async () => {
      const preferences = await this.#load();
      const key = keyFor(suggestionId);
      const next = preferences.deferred.filter((item) => item.key !== key);
      next.push({ key, deferredAt: this.#requireDate(deferredAt) });
      preferences.deferred = next.slice(-MAX_DEFERRED_SUGGESTIONS);
      await this.#write(preferences);
    });
  }

  async restore(suggestionId: string): Promise<boolean> {
    return this.#exclusive(async () => {
      const preferences = await this.#load();
      const key = keyFor(suggestionId);
      const remaining = preferences.deferred.filter(
        (item) => item.key !== key,
      );
      if (remaining.length === preferences.deferred.length) return false;
      preferences.deferred = remaining;
      await this.#write(preferences);
      return true;
    });
  }

  async #load(): Promise<StoredPreferences> {
    try {
      const fileStats = await lstat(this.#path);
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        throw new Error("复盘素材搁置状态路径不安全");
      }
      if ((await stat(this.#path)).size > MAX_FILE_BYTES) {
        throw new Error("复盘素材搁置状态超过安全大小限制");
      }
      return parsePreferences(
        JSON.parse(await readFile(this.#path, "utf8")) as unknown,
      );
    } catch (error) {
      if (isMissing(error)) return emptyPreferences();
      if (error instanceof SyntaxError) {
        throw new Error("复盘素材搁置状态损坏，已停止写入以保护现有设置");
      }
      throw error;
    }
  }

  async #write(preferences: StoredPreferences): Promise<void> {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryStats = await lstat(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new Error("复盘素材搁置状态目录不安全");
    }
    await chmod(directory, 0o700);
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify(preferences, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  #requireDate(value: string): string {
    if (Number.isNaN(Date.parse(value))) {
      throw new Error("复盘素材搁置时间无效");
    }
    return value;
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
