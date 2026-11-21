import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, delimiter, isAbsolute, relative, sep } from "node:path";
import { ReviewToolLibraries, type ReviewLibraryReads } from "./local-review-tool-libraries.js";
import { loginShellPath } from "./login-shell-path.js";
import type { ReviewCopy } from "./local-review-git.js";
import type { ManagedChildProcessRunner } from "./model/cli/managed-child-process.js";

export const REVIEW_TOOL_NAMES = ["node", "npm", "npx", "pnpm", "yarn", "python3", "go", "cargo"] as const;
export interface ReviewTool { name: string; executable: string; prefix: string; libraries?: ReviewLibraryReads }
export const reviewToolReadDirectories = (tools: readonly ReviewTool[]) => [...new Set(tools.flatMap(tool => [...(tool.prefix !== tool.executable ? [tool.prefix] : []), ...(tool.libraries?.directories ?? [])]))];
export const reviewToolReadFiles = (tools: readonly ReviewTool[], links = true) => [...new Set(tools.flatMap(tool => [...(tool.prefix === tool.executable ? [tool.executable] : []), ...(tool.libraries?.files ?? []), ...(links ? tool.libraries?.links ?? [] : [])]))];
// Native clients get canonical version directories/files only. If their own
// sandbox rejects link metadata, their existing admission check must fail closed.
export const reviewToolReadPaths = (tools: readonly ReviewTool[]) => [...reviewToolReadDirectories(tools), ...reviewToolReadFiles(tools, false)];
const containsPath = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};
/** Unknown layouts get a file grant, never an inferred directory grant. */
export async function reviewToolReadRoot(program: string, candidate: string, homePath?: string): Promise<string> {
  const executable = await realpath(program);
  const [prefix, home] = await Promise.all([realpath(candidate).catch(() => null), homePath ? realpath(homePath).catch(() => null) : null]);
  if (!prefix || !home || containsPath(prefix, home) || !containsPath(prefix, executable)) return executable;
  const version = "v?\\d+\\.\\d+(?:\\.\\d+)?[a-zA-Z0-9._+-]*";
  const homeLayout = relative(home, prefix).split(sep).join("/");
  const known = new RegExp(`^(?:\\.volta/tools/image/node/${version}|\\.nvm/versions/node/${version}|\\.rustup/toolchains/${version}-[a-zA-Z0-9-]+)$`, "u").test(homeLayout)
    || new RegExp(`^/(?:opt/homebrew|usr/local)/Cellar/[^/]+/${version}(?:/.*)?$`, "u").test(prefix)
    // Homebrew keeps npm itself outside the node keg. This is the exact trusted
    // npm runtime package, never its global node_modules parent or other packages.
    || /^\/(?:opt\/homebrew|usr\/local)\/lib\/node_modules\/npm$/u.test(prefix) && /^bin\/(?:npm|npx)-cli\.js$/u.test(relative(prefix, executable))
    || new RegExp(`^/Library/(?:Developer/CommandLineTools/Library/)?Frameworks/Python3?\\.framework/Versions/${version}$`, "u").test(prefix);
  return known ? prefix : executable;
}
export const REVIEW_SYSTEM_CA_FILES = process.platform === "darwin" ? ["/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"] : [];
/** One explicit App-startup CA file, never its directory or a repo-relative path. */
export async function reviewExtraCAFiles(environment: NodeJS.ProcessEnv): Promise<string[]> {
  const path = environment.NODE_EXTRA_CA_CERTS;
  if (!path) return [];
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) throw new Error("NODE_EXTRA_CA_CERTS 必须是绝对文件路径。");
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isFile()) throw new Error("NODE_EXTRA_CA_CERTS 必须指向普通证书文件。");
  return [...new Set([path, canonical])];
}
// npm otherwise spawns bare "sh" through PATH, whose protected entries make
// native Codex return EPERM/255. Keep its default shell, using an absolute path.
export const reviewToolEnvironment = (copy: ReviewCopy, bins: string[] = [], source: NodeJS.ProcessEnv = process.env) => ({ PATH: [...new Set([join(copy.directory, "tool-bin"), ...bins, "/usr/bin", "/bin"])].join(delimiter), HOME: join(copy.directory, "scratch"), TMPDIR: join(copy.directory, "scratch"), XDG_CACHE_HOME: join(copy.directory, "scratch", "cache"), XDG_CONFIG_HOME: join(copy.directory, "scratch", "config"), XDG_DATA_HOME: join(copy.directory, "scratch", "data"), XDG_STATE_HOME: join(copy.directory, "scratch", "state"), OPENSSL_CONF: "/dev/null", ...(process.platform === "darwin" ? { SSL_CERT_FILE: "/etc/ssl/cert.pem" } : {}), ...(source.NODE_EXTRA_CA_CERTS !== undefined ? { NODE_EXTRA_CA_CERTS: source.NODE_EXTRA_CA_CERTS } : {}), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...(process.platform === "darwin" ? { npm_config_script_shell: "/bin/sh" } : {}) });
export async function resolveReviewTools(cwd: string, environment: NodeJS.ProcessEnv, runner: ManagedChildProcessRunner, clientEnvironment: NodeJS.ProcessEnv, signal?: AbortSignal, unavailable?: (name: string, reason: string) => void): Promise<ReviewTool[]> {
    const path = await loginShellPath(environment), directories = path.split(delimiter).filter(isAbsolute);
    const find = async (name: string) => { for (const directory of directories) { const candidate = join(directory, name); if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate; } return null; };
    const query = async (executable: string, args: string[]) => (await runner.run({ executable, args, cwd, stdin: "", timeoutMs: 10_000, maximumStdoutBytes: 16_000, maximumStderrBytes: 16_000, ...(signal ? { signal } : {}), environment: { ...clientEnvironment, PATH: path, OPENSSL_CONF: "/dev/null", PYTHONDONTWRITEBYTECODE: "1" } })).stdout.trim();
    const found: ReviewTool[] = [], libraries = new ReviewToolLibraries(runner, cwd, environment.HOME, clientEnvironment.MODEL_PROXY_URL);
    for (const name of REVIEW_TOOL_NAMES) {
      signal?.throwIfAborted();
      const candidate = await find(name); if (!candidate) continue;
      try {
        let executable = await realpath(candidate), prefix: string | undefined;
        if (basename(executable) === "volta-shim") { const manager = await find("volta"); if (!manager) continue; executable = await realpath(await query(manager, ["which", name])); }
        if (name === "cargo" && basename(executable).startsWith("rustup")) executable = await realpath(await query(executable, ["which", "cargo"]));
        if (name === "node") executable = await realpath(await query(executable, ["-p", "process.execPath"]));
        if (name === "python3") { const info = JSON.parse(await query(executable, ["-c", "import sys,json; print(json.dumps([sys.executable,sys.prefix]))"])); executable = await realpath(info[0]); prefix = await realpath(info[1]); }
        const npm = executable.indexOf("/lib/node_modules/");
        const homebrewNpm = /^(\/(?:opt\/homebrew|usr\/local)\/lib\/node_modules\/npm)\/bin\/(?:npm|npx)-cli\.js$/u.exec(executable)?.[1];
        prefix ??= homebrewNpm ?? (npm >= 0 ? executable.slice(0, npm) : basename(dirname(executable)) === "bin" ? dirname(dirname(executable)) : dirname(executable));
        prefix = await reviewToolReadRoot(executable, prefix, environment.HOME);
        found.push({ name, executable, prefix, libraries: await libraries.resolve(executable, signal) });
      } catch (error) {
        signal?.throwIfAborted();
        const reason = error instanceof Error ? error.message.slice(0, 2000) : "工具链解析失败。";
        unavailable?.(name, reason); console.info("local-review-tool-unavailable", JSON.stringify({ name, reason }));
      }
    }
    return found;
  }
