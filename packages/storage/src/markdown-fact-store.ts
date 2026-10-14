import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, opendir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { notePropertiesYaml } from "./markdown-markers.js";
import { ObsidianVaultRepository } from "./obsidian-vault.js";
import { renameReplacing } from "./replace-file.js";

interface FactCodec<T> {
  parse(value: unknown): T;
  key(value: T): string;
  heading: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Shared filesystem rules for independently versioned scope and relation facts. */
export class MarkdownFactStore<T> {
  readonly #root: string;
  readonly #vault: ObsidianVaultRepository;
  readonly #folder: string;
  readonly #codec: FactCodec<T>;
  #writeTail: Promise<unknown> = Promise.resolve();

  constructor(vaultPath: string, folder: string, codec: FactCodec<T>) {
    if (!/^[a-z][a-z0-9-]*$/u.test(folder)) throw new Error("Invalid fact folder");
    this.#root = resolve(vaultPath);
    this.#vault = new ObsidianVaultRepository(vaultPath);
    this.#folder = folder;
    this.#codec = codec;
  }

  relativePath(key: string): string { return `Decision Journal/${this.#folder}/${hash(key)}.md`; }
  encode(record: T): string { return `---\n${notePropertiesYaml(record, { lineWidth: 0 })}---\n# ${this.#codec.heading}\n\n此记录是独立的版本化元数据，不改写来源决策。\n`; }

  /**
   * The facts as read. `inDoubt(key)`: whether that fact cannot be relied on, the whole folder unread or a note
   * named for that one fact not read as it (a sync client's conflict copy, `<hash> 2.md`). One such copy made
   * every scope, relation and feedback unavailable; one named for no fact still does.
   */
  async scan(): Promise<{ records: Map<string, T>; hashes: Map<string, string>; unavailable: boolean; doubted: boolean; inDoubt(key: string): boolean }> {
    const records = new Map<string, T>();
    const hashes = new Map<string, string>();
    let unavailable = false;
    const doubtful = new Set<string>();
    const doubt = (relativePath: string | null): void => {
      const named = relativePath === null ? undefined : /^([0-9a-f]{64})(?![0-9a-f])/u.exec(basename(relativePath))?.[1];
      if (named === undefined) unavailable = true;
      else doubtful.add(named);
    };
    const result = () => ({ records, hashes, unavailable, doubted: doubtful.size > 0, inDoubt: (key: string) => unavailable || doubtful.has(hash(key)) });
    let count = 0;
    let bytes = 0;
    const signal = AbortSignal.timeout(2_000);
    try {
      const directory = await this.#directory(false);
      if (directory === null) return result();
      const entries = await opendir(directory);
      let inspected = 0;
      try {
        for await (const entry of entries) {
          if (signal.aborted || ++inspected > 5_000) throw new Error("Metadata scan limit exceeded");
          if (entry.isSymbolicLink() || entry.isDirectory()) unavailable = true;
        }
      } finally { await entries.close().catch(() => undefined); }
      for await (const entry of this.#vault.iterateFolder(`Decision Journal/${this.#folder}`, signal)) {
        if (++count > 5_000) { unavailable = true; break; }
        if (entry.kind === "diagnostic") { doubt(entry.diagnostic.relativePath); continue; }
        bytes += entry.note.size;
        if (bytes > 16 * 1024 * 1024) { unavailable = true; break; }
        if (entry.note.size > 512 * 1024) { doubt(entry.note.relativePath); continue; }
        try {
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(entry.note.content);
          const record = this.#codec.parse(parse(match?.[1] ?? "", { maxAliasCount: 20 }));
          const key = this.#codec.key(record);
          if (entry.note.relativePath !== this.relativePath(key) || records.has(key)) throw new Error("Invalid fact identity");
          records.set(key, record); hashes.set(key, entry.note.contentHash);
        } catch { doubt(entry.note.relativePath); }
      }
    } catch { unavailable = true; }
    return result();
  }

  replace(record: T, expectedHash: string | null): Promise<"saved" | "conflict"> {
    const write = this.#writeTail.then(() => this.#replace(record, expectedHash));
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  async #directory(create = true): Promise<string | null> {
    const root = await realpath(this.#root);
    const rootStat = await lstat(this.#root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Fact directory unavailable");
    let directory = this.#root;
    for (const part of ["Decision Journal", this.#folder]) {
      directory = join(directory, part);
      if (create) {
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      let stat;
      try { stat = await lstat(directory); }
      catch (error) { if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
      const inside = relative(root, await realpath(directory));
      if (!stat.isDirectory() || stat.isSymbolicLink() || !inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Fact directory unavailable");
    }
    return directory;
  }

  async #replace(input: T, expectedHash: string | null): Promise<"saved" | "conflict"> {
    const record = this.#codec.parse(input);
    const key = this.#codec.key(record);
    const content = this.encode(record);
    if (Buffer.byteLength(content) > 512 * 1024) throw new Error("Fact exceeds storage limit");
    const directory = await this.#directory();
    if (directory === null) throw new Error("Fact directory unavailable");
    const target = join(this.#root, this.relativePath(key));
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const unchanged = async () => {
      if (expectedHash === null) {
        try { await lstat(target); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
      }
      try { return hash(await readFile(await this.#vault.resolveNotePath(this.relativePath(key)), "utf8")) === expectedHash; }
      catch { return false; }
    };
    if (!await unchanged()) return "conflict";
    // Waiting on a file held open, what was confirmed unchanged is confirmed again before each retry.
    const changedMeanwhile = new Error("Fact changed while waiting to replace it");
    const stillUnchanged = async () => { if (!await unchanged()) throw changedMeanwhile; };
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await this.#directory();
      if (!await unchanged()) return "conflict";
      if (expectedHash === null) {
        try { await link(temporary, target); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return "conflict";
          // A volume without hard links (exFAT, most SMB shares): a rename, which a reader only ever sees whole
          // (a copy into place could be read half written), once the name is confirmed still free.
          // ponytail: exclusive only against this app's own writes, which are serialized; an exclusive
          // rename (renamex_np) is not available from Node.
          if (!await unchanged()) return "conflict";
          await renameReplacing(temporary, target, { beforeRetry: stillUnchanged });
        }
      } else await renameReplacing(temporary, target, { beforeRetry: stillUnchanged });
      return "saved";
    } catch (error) {
      if (error === changedMeanwhile) return "conflict";
      throw error;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}
