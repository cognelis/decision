import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewToolLibraries, reviewLibraryDirectory, reviewMachOLoads } from "../src/main/local-review-tool-libraries.js";
import { ManagedChildProcessRunner } from "../src/main/model/cli/managed-child-process.js";
import { reviewCommandPolicy } from "../src/main/local-review-command-sandbox.js";
import { reviewToolReadPaths } from "../src/main/local-review-tools.js";
import { reviewPermissionSettings } from "../src/main/local-review-agent.js";
import { claudeReviewSettings } from "../src/main/local-review-claude-runtime.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
const loads = (dependencies: string[], rpaths: string[] = []) => "image:\n" + [...rpaths.map(value => ["LC_RPATH", "path", value]), ...dependencies.map(value => ["LC_LOAD_DYLIB", "name", value]), ["LC_ID_DYLIB", "name", "/ignored/self-id"]].map(([command, field, value], i) => `Load command ${i}\n cmd ${command}\n cmdsize 64\n ${field} ${value} (offset 24)\n`).join("");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lr-libraries-"))); roots.push(root);
  const binary = async (path: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, Buffer.from("cffaedfe00000000", "hex")); return path; };
  const main = await binary(join(root, "bin/main")), descriptions = new Map<string, string>();
  const runner = new ManagedChildProcessRunner();
  const run = vi.spyOn(runner, "run").mockImplementation(async request => { const output = descriptions.get(request.args.at(-1)!); if (!output) throw new Error("otool synthetic failure"); return { exitCode: 0, stdout: output, stderr: "", durationMs: 0 }; });
  return { root, binary, main, descriptions, runner, run };
}
it("parses only dependencies and rpaths, and rejects incomplete load commands", () => {
  expect(reviewMachOLoads(loads(["@rpath/lib.dylib", "/usr/lib/libSystem.B.dylib"], ["@loader_path/../lib"]))).toEqual({ dependencies: ["@rpath/lib.dylib", "/usr/lib/libSystem.B.dylib"], rpaths: ["@loader_path/../lib"] });
  for (const value of ["", "image:\nLoad command 0\n cmd LC_LOAD_DYLIB\n", "image:\nLoad command 0\n cmd LC_DYLD_ENVIRONMENT\n"]) expect(() => reviewMachOLoads(value)).toThrow();
});
it.skipIf(process.platform !== "darwin")("resolves inherited rpaths, loader/executable paths, cycles and link chains without directory grants", async () => {
  const f = await fixture(), a = await f.binary(join(f.root, "lib/a.dylib")), b = await f.binary(join(f.root, "lib/b.dylib")), c = await f.binary(join(f.root, "extra/c.dylib"));
  const alias = join(f.root, "alias"); await symlink("lib", join(f.root, "middle")); await symlink("middle", alias);
  f.descriptions.set(f.main, loads(["@rpath/a.dylib", "/usr/lib/not-on-disk.dylib"], [alias]));
  f.descriptions.set(a, loads(["@loader_path/b.dylib", "@executable_path/../extra/c.dylib"]));
  f.descriptions.set(b, loads(["@rpath/a.dylib"])); f.descriptions.set(c, loads([]));
  const grants = await new ReviewToolLibraries(f.runner, f.root).resolve(f.main);
  expect(grants).toEqual({ directories: [], files: [c, a, b].sort(), links: [alias, join(f.root, "middle")].sort() });
  expect(f.run).toHaveBeenCalledTimes(4);
  expect(f.run.mock.calls.every(([request]) => request.executable === "/usr/bin/otool" && request.args.includes("-l") && request.environment.PATH === "/usr/bin:/bin")).toBe(true);
  const tools = [{ name: "node", executable: f.main, prefix: f.main, libraries: grants }];
  const policy = reviewCommandPolicy({ directory: "/job", tree: "/job/tree", git: "/job/git" }, tools);
  for (const path of grants.links) { expect(policy).toContain(`(literal ${JSON.stringify(path)})`); expect(policy).not.toContain(`(subpath ${JSON.stringify(path)})`); }
  expect(reviewToolReadPaths(tools)).not.toContain(alias); expect(reviewToolReadPaths(tools)).toContain(a);
  const copy = { directory: "/job", tree: "/job/tree", git: "/job/git" };
  const codex = reviewPermissionSettings(copy, "/client/codex", true, [], reviewToolReadPaths(tools));
  expect(codex.join("\n")).toContain(a); expect(codex.join("\n")).not.toContain(alias);
  const claude = claudeReviewSettings(copy, { executable: "/client/claude", tools, git: "/usr/bin/git", home: "/synthetic/home", configs: [], fingerprint: "" }, "/alias", true);
  expect(claude.sandbox.filesystem.allowRead).toContain(a); expect(claude.sandbox.filesystem.allowRead).not.toContain(alias);
});
it.skipIf(process.platform !== "darwin")("fails closed for unresolved paths, parser failures and a 201-image closure", async () => {
  const f = await fixture(), resolver = () => new ReviewToolLibraries(f.runner, f.root);
  f.descriptions.set(f.main, loads(["@rpath/missing.dylib"])); await expect(resolver().resolve(f.main)).rejects.toThrow("无法定位");
  f.descriptions.set(f.main, "invalid otool output"); await expect(resolver().resolve(f.main)).rejects.toThrow("无法解析");
  const paths: string[] = []; for (let i = 0; i < 200; i++) { const path = await f.binary(join(f.root, `lib/${i}.dylib`)); paths.push(path); f.descriptions.set(path, loads([])); }
  f.descriptions.set(f.main, loads(paths)); await expect(resolver().resolve(f.main)).rejects.toThrow("200");
});
it("grants only the versioned Cellar root and refuses a HOME/ancestor or unknown layout", () => {
  expect(reviewLibraryDirectory("/opt/homebrew/Cellar/icu4c@78/78.3_1/lib/icu.dylib", "/synthetic/home")).toBe("/opt/homebrew/Cellar/icu4c@78/78.3_1");
  expect(reviewLibraryDirectory("/usr/local/Cellar/foo/1.2.3/lib/foo.dylib")).toBe("/usr/local/Cellar/foo/1.2.3");
  for (const path of ["/opt/homebrew/lib/foo.dylib", "/opt/homebrew/opt/foo/lib/foo.dylib", "/usr/local/Cellar/foo/current/lib/foo.dylib", "/synthetic/home/private.dylib"]) expect(reviewLibraryDirectory(path)).toBeUndefined();
  expect(reviewLibraryDirectory("/opt/homebrew/Cellar/foo/1.2/lib/foo.dylib", "/opt/homebrew/Cellar/foo/1.2/home")).toBeUndefined();
});
