import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readSync, realpathSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewPath } from "./local-review-git.js";

export interface ReviewNativeFs {
  openAt(fd: number, entry: string, flags: number, mode: number): number;
  mkdirAt(fd: number, entry: string): void;
  unlinkAt(fd: number, entry: string): void;
  entries(fd: number): string[];
  machLookup(service: string): number;
  sandboxProcesses?(names: string[], allowed: boolean[]): ReviewSandboxProcess[];
  killSandboxProcess?(pid: number, seconds: number, microseconds: number, names: string[], allowed: boolean[]): boolean;
}
export interface ReviewSandboxProcess { pid: number; seconds: number; microseconds: number }
let loaded: ReviewNativeFs | undefined;
let loadedPath: string | undefined;
export function reviewNativeModulePath(): string { reviewNativeFs(); return loadedPath!; }
export function reviewNativeFs(): ReviewNativeFs {
  if (loaded) return loaded;
  const load = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
  const host = process as NodeJS.Process & { resourcesPath?: string; defaultApp?: boolean };
  const source = import.meta.url?.startsWith("file:") ? fileURLToPath(new URL("../../../../dist/native/review-fs.node", import.meta.url)) : "";
  const bundled = typeof __filename === "string" ? join(dirname(__filename), "../../dist/native/review-fs.node") : "";
  const candidates = process.versions.electron && host.resourcesPath && !host.defaultApp ? [join(host.resourcesPath, "native/review-fs.node")] : [source, bundled].filter(Boolean);
  for (const candidate of candidates) { try { loaded = load(candidate) as ReviewNativeFs; loadedPath = candidate; return loaded; } catch { /* Try the development or packaged location. */ } }
  throw new Error("安全文件工具尚未构建或当前平台不支持目录句柄操作，不能执行 Pi worker。");
}
export const REVIEW_FILE_BYTES = 2 * 1024 * 1024;
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const TEXT = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const sameFile = (a: ReturnType<typeof fstatSync>, b: ReturnType<typeof fstatSync>) => a.dev === b.dev && a.ino === b.ino;

/** Every operation below the pinned tree uses *at, never a reconstructed absolute path. */
export class ReviewFileTree {
  private readonly rootFd: number;
  readonly root: string;
  readonly changedFiles = new Set<string>();
  constructor(root: string, private readonly native: ReviewNativeFs = reviewNativeFs()) {
    if (lstatSync(root).isSymbolicLink()) throw new Error("拒绝符号链接工作树。");
    this.root = realpathSync(root);
    const expected = lstatSync(this.root, { bigint: true });
    this.rootFd = openSync(this.root, DIRECTORY);
    if (!sameFile(expected, fstatSync(this.rootFd, { bigint: true }))) { closeSync(this.rootFd); throw new Error("工作树在打开前已被替换。"); }
  }
  close() { closeSync(this.rootFd); }
  private components(path: string): string[] {
    const parts = reviewPath(path).split("/");
    if (parts.length > 64) throw new Error("路径超过 64 层目录上限。");
    return parts;
  }
  private parent<T>(path: string, create: boolean, work: (fd: number, leaf: string, verify: () => void) => T): T {
    const parts = this.components(path), held: number[] = [], identities: ReturnType<typeof fstatSync>[] = [];
    let fd = this.rootFd;
    try {
      for (const part of parts.slice(0, -1)) {
        if (create) this.native.mkdirAt(fd, part);
        fd = this.native.openAt(fd, part, DIRECTORY, 0); held.push(fd); identities.push(fstatSync(fd, { bigint: true }));
      }
      const verify = () => {
        let current = this.rootFd; const checked: number[] = [];
        try { for (const [index, part] of parts.slice(0, -1).entries()) { current = this.native.openAt(current, part, DIRECTORY, 0); checked.push(current); if (!sameFile(identities[index]!, fstatSync(current, { bigint: true }))) throw new Error("父目录在检查后已被替换。"); } }
        finally { for (const file of checked.reverse()) closeSync(file); }
      };
      return work(fd, parts.at(-1)!, verify);
    } finally { for (const file of held.reverse()) closeSync(file); }
  }
  private text(fd: number): string {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(REVIEW_FILE_BYTES)) throw new Error("只支持不超过 2 MiB 的普通文本文件。");
    const bytes = Buffer.alloc(Number(stat.size) + 1); let used = 0;
    while (used < bytes.length) { const read = readSync(fd, bytes, used, bytes.length - used, used); if (!read) break; used += read; }
    if (used > REVIEW_FILE_BYTES || used > Number(stat.size)) throw new Error("文件在读取中增长，或超过 2 MiB。");
    const text = bytes.subarray(0, used).toString("utf8");
    if (text.includes("\0")) throw new Error("不支持二进制文件。");
    return text;
  }
  read(path: string): string {
    return this.parent(path, false, (parent, leaf, verify) => { const fd = this.native.openAt(parent, leaf, constants.O_RDONLY | TEXT, 0); try { verify(); return this.text(fd); } finally { closeSync(fd); } });
  }
  private put(fd: number, content: string) {
    if (Buffer.byteLength(content) > REVIEW_FILE_BYTES || content.includes("\0")) throw new Error("写入内容必须是不超过 2 MiB 的文本。");
    if (!fstatSync(fd).isFile()) throw new Error("只允许写入普通文件。");
    const buffer = Buffer.from(content); ftruncateSync(fd, 0); let written = 0;
    while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written, written);
  }
  write(path: string, content: string) {
    if (Buffer.byteLength(content) > REVIEW_FILE_BYTES || content.includes("\0")) throw new Error("写入内容必须是不超过 2 MiB 的文本。");
    this.parent(path, true, (parent, leaf, verify) => {
      verify(); let fd: number;
      try { fd = this.native.openAt(parent, leaf, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | TEXT, 0o644); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; fd = this.native.openAt(parent, leaf, constants.O_WRONLY | TEXT, 0); }
      try { verify(); this.put(fd, content); } finally { closeSync(fd); }
    });
    this.changedFiles.add(path);
  }
  edit(path: string, oldText: string, newText: string) {
    if (!oldText) throw new Error("旧串不能为空。");
    this.parent(path, false, (parent, leaf, verify) => {
      const fd = this.native.openAt(parent, leaf, constants.O_RDWR | TEXT, 0);
      try { verify(); const text = this.text(fd), at = text.indexOf(oldText); if (at < 0 || at !== text.lastIndexOf(oldText)) throw new Error("旧串必须在文件中恰好出现一次。"); verify(); this.put(fd, text.slice(0, at) + newText + text.slice(at + oldText.length)); }
      finally { closeSync(fd); }
    });
    this.changedFiles.add(path);
  }
  delete(path: string) {
    this.parent(path, false, (parent, leaf, verify) => { const fd = this.native.openAt(parent, leaf, constants.O_RDONLY | TEXT, 0); try { if (!fstatSync(fd).isFile()) throw new Error("只允许删除普通文件。"); verify(); this.native.unlinkAt(parent, leaf); } finally { closeSync(fd); } });
    this.changedFiles.add(path);
  }
  list(prefix = ""): { files: string[]; skipped: string[]; truncated: boolean } {
    if (prefix === "/") throw new Error("文件路径无效。");
    if (prefix.endsWith("/")) prefix = prefix.slice(0, -1); // one trailing slash names the same directory; "a//" stays invalid below
    const files: string[] = [], skipped: string[] = []; let visited = 0, truncated = false;
    const includeDependencies = prefix.split("/").includes("node_modules");
    const walk = (fd: number, at: string, depth: number) => {
      for (const entry of this.native.entries(fd).sort()) {
        if (entry.toLowerCase() === ".git" || (!includeDependencies && entry === "node_modules")) continue;
        if (++visited > 5000 || depth > 64) { truncated = true; return; }
        const path = at ? `${at}/${entry}` : entry; let next: number | undefined;
        try { this.components(path); next = this.native.openAt(fd, entry, constants.O_RDONLY | TEXT, 0); const stat = fstatSync(next); if (stat.isDirectory()) walk(next, path, depth + 1); else if (stat.isFile()) files.push(path); else skipped.push(path); }
        catch { skipped.push(path); }
        finally { if (next !== undefined) closeSync(next); }
      }
    };
    if (!prefix) walk(this.rootFd, "", 0);
    else this.parent(prefix, false, (parent, leaf, verify) => { const fd = this.native.openAt(parent, leaf, DIRECTORY, 0); try { verify(); walk(fd, prefix, 0); } finally { closeSync(fd); } });
    return { files, skipped, truncated };
  }
}
