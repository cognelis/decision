import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LocalReviewGit } from "../src/main/local-review-git.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-view-safety-")); roots.push(root);
  const gitDir = join(root, "objects.git"), outside = join(root, "outside"), target = join(root, "view");
  await mkdir(outside);
  const env = { HOME: root, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (args: string[], input = "") => execFileSync("/usr/bin/git", args, { cwd: root, env, input, encoding: "utf8" }).trim();
  git(["init", "--bare", "--template=", gitDir]);
  const object = (text: string) => git(["--git-dir", gitDir, "hash-object", "-w", "--stdin"], text);
  const tree = (entries: string[]) => git(["--git-dir", gitDir, "mktree"], entries.length ? entries.join("\n") + "\n" : "");
  const commit = (entries: string[]) => git(["--git-dir", gitDir, "commit-tree", tree(entries), "-m", "synthetic view"]);
  return { root, gitDir, outside, target, object, tree, commit, runner: new LocalReviewGit("/usr/bin/git", env, true) };
}

it("rejects an APFS case collision before A -> outside plus a/escaped.txt can escape the view", async () => {
  const f = await fixture(), nested = f.tree([`100644 blob ${f.object("escaped\n")}\tescaped.txt`]);
  const commit = f.commit([`120000 blob ${f.object(f.outside)}\tA`, `040000 tree ${nested}\ta`]);
  const result = await f.runner.checkoutView(f.gitDir, commit, f.target).catch(error => error);
  expect(await readdir(f.outside)).toEqual([]);
  expect(result).toBeInstanceOf(Error); expect(String(result)).toMatch(/大小写|重名/u);
});
it("rejects case-folded directory aliases even if the leaves have different names", async () => {
  const f = await fixture(), blob = f.object("text\n");
  const commit = f.commit([`040000 tree ${f.tree([`100644 blob ${blob}\tone.txt`])}\tA`, `040000 tree ${f.tree([`100644 blob ${blob}\ttwo.txt`])}\ta`]);
  await expect(f.runner.checkoutView(f.gitDir, commit, f.target)).rejects.toThrow(/大小写|重名/u);
  expect(await readdir(f.outside)).toEqual([]);
});
it("materializes an external symbolic link as ordinary target text and skips gitlinks", async () => {
  const f = await fixture(), secret = join(f.outside, "secret.txt"); await writeFile(secret, "OUTSIDE-CANARY");
  const emptyCommit = f.commit([]), commit = f.commit([`120000 blob ${f.object(secret)}\tlink`, `160000 commit ${emptyCommit}\tmodule`]);
  await f.runner.checkoutView(f.gitDir, commit, f.target);
  expect((await lstat(join(f.target, "link"))).isSymbolicLink()).toBe(false);
  expect(await readFile(join(f.target, "link"), "utf8")).toBe(secret);
  expect(await readFile(secret, "utf8")).toBe("OUTSIDE-CANARY");
  expect(await readdir(f.target)).toEqual(["link"]);
});
it("refuses a deep pre-existing symbolic-link parent without writing into its external directory", async () => {
  const f = await fixture(); await mkdir(join(f.target, "deep"), { recursive: true }); await symlink(f.outside, join(f.target, "deep/link"));
  const leaf = f.tree([`100644 blob ${f.object("escaped\n")}\tescaped.txt`]), deep = f.tree([`040000 tree ${leaf}\tlink`]);
  const result = await f.runner.checkoutView(f.gitDir, f.commit([`040000 tree ${deep}\tdeep`]), f.target).catch(error => error);
  expect(await readdir(f.outside)).toEqual([]); expect(result).toBeInstanceOf(Error);
});
it("refuses a symbolic-link view root and never replaces a pre-existing leaf", async () => {
  const f = await fixture(), commit = f.commit([`100644 blob ${f.object("new\n")}\tfile.txt`]);
  await symlink(f.outside, f.target);
  await expect(f.runner.checkoutView(f.gitDir, commit, f.target)).rejects.toThrow();
  expect(await readdir(f.outside)).toEqual([]);
  await rm(f.target); await mkdir(f.target); await writeFile(join(f.target, "file.txt"), "keep\n");
  await expect(f.runner.checkoutView(f.gitDir, commit, f.target)).rejects.toThrow();
  expect(await readFile(join(f.target, "file.txt"), "utf8")).toBe("keep\n");
});
