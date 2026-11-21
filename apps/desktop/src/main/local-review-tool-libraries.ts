import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ManagedChildProcessRunner } from "./model/cli/managed-child-process.js";

export interface ReviewLibraryReads { directories: string[]; files: string[]; links: string[] }
export const REVIEW_LIBRARY_LIMIT = 200;
const system = (path: string) => path === "/usr/lib" || path.startsWith("/usr/lib/") || path === "/System" || path.startsWith("/System/");
const inside = (parent: string, path: string) => { const value = relative(parent, path); return !value || !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`); };
const dependencyCommands = new Set(["LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LAZY_LOAD_DYLIB", "LC_LOAD_UPWARD_DYLIB"]);

/** -l exposes the same dependency names as -L, plus LC_RPATH and load-command kinds. */
export function reviewMachOLoads(output: string) {
  const blocks = output.split(/\nLoad command \d+\r?\n/u);
  if (blocks.length < 2) throw new Error("无法解析 Mach-O load commands。");
  const dependencies: string[] = [], rpaths: string[] = [];
  for (const block of blocks.slice(1)) {
    const command = /^\s*cmd (LC_[A-Z0-9_]+)\s*$/mu.exec(block)?.[1];
    if (!command || command === "LC_DYLD_ENVIRONMENT") throw new Error("不支持或不完整的 Mach-O load command。");
    if (!dependencyCommands.has(command) && command !== "LC_RPATH") continue;
    const field = command === "LC_RPATH" ? "path" : "name";
    const value = new RegExp(`^\\s*${field} (.+) \\(offset \\d+\\)\\s*$`, "mu").exec(block)?.[1];
    if (!value || /[\0\r\n]/u.test(value)) throw new Error("动态库加载路径无效。");
    (field === "path" ? rpaths : dependencies).push(value);
  }
  if (rpaths.length > 64 || dependencies.length > REVIEW_LIBRARY_LIMIT) throw new Error("动态库加载项超限。");
  return { dependencies, rpaths };
}

/** Record links themselves, including chains; never turn an opt alias into a subtree grant. */
async function canonicalLibrary(path: string) {
  const links = new Set<string>(); let pending = path.split("/").filter(Boolean), current = "/", hops = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") { current = dirname(current); continue; }
    const next = join(current, part), info = await lstat(next);
    if (!info.isSymbolicLink()) { current = next; continue; }
    if (++hops > 40) throw new Error("动态库符号链接超限。");
    links.add(next); const target = await readlink(next);
    if (isAbsolute(target)) current = "/";
    pending = [...target.split("/").filter(Boolean), ...pending];
  }
  if (await realpath(path) !== current || !(await lstat(current)).isFile()) throw new Error("动态库路径不是稳定的普通文件。");
  return { path: current, links: [...links] };
}

export function reviewLibraryDirectory(path: string, home?: string) {
  const version = "v?\\d+\\.\\d+(?:\\.\\d+)?[a-zA-Z0-9._+-]*";
  const root = new RegExp(`^((?:/opt/homebrew|/usr/local)/Cellar/[^/]+/${version})/`, "u").exec(path)?.[1];
  return root && (!home || !inside(root, home)) ? root : undefined;
}

/** One discovery has a bounded parser cache, never a persistent permission cache across upgrades. */
export class ReviewToolLibraries {
  private readonly images = new Map<string, Promise<ReturnType<typeof reviewMachOLoads> | null>>();
  constructor(private readonly runner: ManagedChildProcessRunner, private readonly cwd: string, private readonly home?: string, private readonly modelProxyUrl?: string) {}
  private image(path: string, signal?: AbortSignal) {
    let image = this.images.get(path);
    if (!image) {
      image = (async () => {
        const file = await open(path, "r"); let magic: string, script: boolean;
        try { const buffer = Buffer.alloc(4); await file.read(buffer, 0, 4, 0); magic = buffer.toString("hex"); script = buffer.subarray(0, 2).toString() === "#!"; }
        finally { await file.close(); }
        if (script) return null; // Scripts have no Mach-O loads; their selected interpreter is a separate tool.
        if (!["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic)) throw new Error("工具不是可解析的 Mach-O 或 shebang 脚本。");
        const result = await this.runner.run({ executable: "/usr/bin/otool", args: ["-arch", process.arch === "arm64" ? "arm64" : "x86_64", "-l", path], cwd: this.cwd, stdin: "", environment: { PATH: "/usr/bin:/bin", LANG: "C", ...(this.modelProxyUrl ? { MODEL_PROXY_URL: this.modelProxyUrl } : {}) }, timeoutMs: 5000, maximumStdoutBytes: 2 * 1024 * 1024, maximumStderrBytes: 16000, ...(signal ? { signal } : {}) });
        return reviewMachOLoads(result.stdout);
      })();
      this.images.set(path, image);
    }
    return image;
  }
  async resolve(executable: string, signal?: AbortSignal): Promise<ReviewLibraryReads> {
    if (process.platform !== "darwin") return { directories: [], files: [], links: [] };
    const main = await realpath(executable), executableDirectory = dirname(main), home = this.home ? await realpath(this.home) : undefined;
    const directories = new Set<string>(), files = new Set<string>(), links = new Set<string>(), visited = new Set<string>();
    const deadline = Date.now() + 30000; let edges = 0;
    const expand = (value: string, loader: string) => {
      if (value === "@loader_path" || value.startsWith("@loader_path/")) return resolve(dirname(loader), value.slice("@loader_path".length).replace(/^\//u, ""));
      if (value === "@executable_path" || value.startsWith("@executable_path/")) return resolve(executableDirectory, value.slice("@executable_path".length).replace(/^\//u, ""));
      if (isAbsolute(value)) return resolve(value);
      throw new Error(`无法解析动态库相对路径：${value.slice(0, 300)}`);
    };
    const visit = async (path: string, inherited: string[], depth: number) => {
      signal?.throwIfAborted();
      if (Date.now() > deadline || depth > 64) throw new Error("动态库闭包解析超时或过深。");
      if (system(path) || visited.has(path)) return;
      if (visited.size >= REVIEW_LIBRARY_LIMIT) throw new Error(`动态库闭包超过 ${REVIEW_LIBRARY_LIMIT} 个镜像。`);
      visited.add(path);
      const image = await this.image(path, signal);
      if (!image) { if (path !== main) throw new Error("动态库不是 Mach-O 文件。"); return; }
      const rpaths = [...new Set([...image.rpaths.map(value => expand(value, path)), ...inherited])];
      if (rpaths.length > 256) throw new Error("动态库搜索路径超限。");
      for (const dependency of image.dependencies) {
        if (++edges > 4000) throw new Error("动态库闭包边数超限。");
        const candidates = dependency.startsWith("@rpath/") ? rpaths.map(root => join(root, dependency.slice(7))) : [expand(dependency, path)];
        let resolved: Awaited<ReturnType<typeof canonicalLibrary>> | undefined, inSystem = false;
        for (const candidate of candidates) {
          if (system(candidate)) { inSystem = true; break; } // dyld's shared-cache images need not exist on disk.
          try { resolved = await canonicalLibrary(candidate); break; }
          catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
        }
        if (inSystem) continue;
        if (!resolved) throw new Error(`动态库无法定位：${dependency.slice(0, 300)}`);
        for (const link of resolved.links) links.add(link);
        if (!system(resolved.path)) {
          const directory = reviewLibraryDirectory(resolved.path, home);
          if (directory) directories.add(directory); else files.add(resolved.path);
        }
        await visit(resolved.path, rpaths, depth + 1);
      }
    };
    await visit(main, [], 0);
    // ponytail: package upgrades after discovery can invalidate paths; execution still
    // has to pass the real sandbox probe. No ancestor grant or fallback on failure.
    return { directories: [...directories].sort(), files: [...files].sort(), links: [...links].sort() };
  }
}
