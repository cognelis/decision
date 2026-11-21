import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalReviewGit, reviewRisks } from "../src/main/local-review-git.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lr-git-")); roots.push(root);
  const repo = join(root, "repo"), home = join(root, "home");
  await mkdir(repo); await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "sample.txt"), "before\n"); await writeFile(join(repo, ":(exclude)victim.txt"), "literal\n");
  await symlink(join(root, "canary"), join(repo, "link")); await writeFile(join(root, "canary"), "PRIVATE_CANARY");
  git("add", "."); git("commit", "-m", "fixture");
  const runner = new LocalReviewGit("/usr/bin/git", env, true);
  return { root, repo, git, runner, repository: await runner.inspect(repo) };
}
async function snapshot(path: string): Promise<Record<string, string>> {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const result: Record<string, string> = {};
  for (const e of entries) if (e.isFile()) result[join(e.parentPath, e.name).slice(path.length)] = (await readFile(join(e.parentPath, e.name))).toString("base64");
  return result;
}
describe("LocalReviewGit", () => {
  it("replaces a file with declared directory leaves without recursively staging its cache", async () => {
    const f = await fixture(), copy = await f.runner.prepare(f.repository, join(f.root, "job/group"));
    await rm(join(copy.tree, "sample.txt")); await mkdir(join(copy.tree, "sample.txt"));
    await writeFile(join(copy.tree, "sample.txt/declared.txt"), "wanted"); await writeFile(join(copy.tree, "sample.txt/cache.bin"), "unwanted");
    const artifact = await f.runner.commit(copy, f.repository, "改为目录", ["sample.txt", "sample.txt/declared.txt"]);
    expect(artifact!.changes.map(change => change.path).sort()).toEqual(["sample.txt", "sample.txt/declared.txt"]);
    expect(await f.runner.changedPaths(copy)).toEqual(["sample.txt/cache.bin"]);
  });
  it.each([false, true])("checks actual staged paths when a directory becomes a file (declare deletions=%s)", async complete => {
    const f = await fixture(); await mkdir(join(f.repo, "folder")); await writeFile(join(f.repo, "folder/child.txt"), "original");
    f.git("add", "."); f.git("commit", "-m", "目录基线"); const repository = await f.runner.inspect(f.repo);
    const copy = await f.runner.prepare(repository, join(f.root, "job/group"));
    await rm(join(copy.tree, "folder"), { recursive: true }); await writeFile(join(copy.tree, "folder"), "replacement");
    if (complete) {
      const artifact = await f.runner.commit(copy, repository, "改为文件", ["folder", "folder/child.txt"]);
      expect(artifact!.changes.map(change => change.path).sort()).toEqual(["folder", "folder/child.txt"]);
    } else {
      await expect(f.runner.commit(copy, repository, "缺少删除声明", ["folder"])).rejects.toThrow("重建索引");
      expect(await f.runner.recoverCommit(copy, repository)).toBeNull();
      expect(execFileSync("/usr/bin/git", [`--git-dir=${copy.git}`, "diff", "--cached", "--name-only"], { encoding: "utf8" })).toBe("");
    }
  });

  it("commits only declared actual paths, including literal pathspec names", async () => {
    const f = await fixture(), copy = await f.runner.prepare(f.repository, join(f.root, "job/group"));
    await writeFile(join(copy.tree, "sample.txt"), "unapproved\n"); await writeFile(join(copy.tree, ":(exclude)victim.txt"), "approved\n");
    await writeFile(join(copy.tree, "cache.bin"), "unapproved cache");
    execFileSync("/usr/bin/git", [`--git-dir=${copy.git}`, `--work-tree=${copy.tree}`, "add", "--", "cache.bin"], { env: { HOME: join(f.root, "home"), GIT_CONFIG_GLOBAL: "/dev/null" } });
    const artifact = await f.runner.commit(copy, f.repository, "仅提交声明文件", [":(exclude)victim.txt", "not-changed.txt"]);
    expect(artifact!.changes.map(c => c.path)).toEqual([":(exclude)victim.txt"]);
    expect(await f.runner.changedPaths(copy)).toEqual(expect.arrayContaining(["sample.txt", "cache.bin"]));
  });
  it.each(["delete", "rename"])("stages a declared %s without including unrelated files", async operation => {
    const f = await fixture(), copy = await f.runner.prepare(f.repository, join(f.root, "job/group"));
    if (operation === "delete") await rm(join(copy.tree, "sample.txt"));
    else await rename(join(copy.tree, "sample.txt"), join(copy.tree, "renamed.txt"));
    await writeFile(join(copy.tree, "cache.bin"), "unapproved");
    const artifact = await f.runner.commit(copy, f.repository, "声明删除或重命名", operation === "rename" ? ["sample.txt", "renamed.txt"] : ["sample.txt"]);
    expect(artifact!.changes).toHaveLength(1);
    expect(artifact!.changes[0]).toMatchObject(operation === "delete" ? { path: "sample.txt", status: "D" } : { path: "renamed.txt", oldPath: "sample.txt", status: "R100" });
  });
  it("returns no_changes when the declared/actual intersection is empty", async () => {
    const f = await fixture(), copy = await f.runner.prepare(f.repository, join(f.root, "job/group"));
    await writeFile(join(copy.tree, "cache.bin"), "unapproved");
    expect(await f.runner.commit(copy, f.repository, "无声明改动", ["sample.txt"])).toBeNull();
  });
  it("reads literal blob paths without following links and never reads dirty worktree content", async () => {
    const f = await fixture();
    await writeFile(join(f.repo, "sample.txt"), "dirty\n");
    expect(await f.runner.readFile(f.repository, "sample.txt", "new")).toBe("before\n");
    expect(await f.runner.readFile(f.repository, ":(exclude)victim.txt", "new")).toBe("literal\n");
    expect(await f.runner.readFile(f.repository, "link", "new")).toBe(join(f.root, "canary"));
    expect((await f.runner.files(f.repository, "new")).map(f => f.path)).toContain(":(exclude)victim.txt");
  });
  it("ignores filter, fsmonitor, textconv, includeIf, signing and hooks, with source bytes unchanged", async () => {
    const f = await fixture(), marker = join(f.root, "executed"), command = `echo executed >> '${marker}'; cat`;
    await writeFile(join(f.repo, ".gitattributes"), "*.txt filter=evil diff=evil\n");
    f.git("add", ".gitattributes"); f.git("commit", "-m", "attributes");
    f.git("config", "filter.evil.clean", command); f.git("config", "filter.evil.smudge", command);
    f.git("config", "filter.evil.process", command); f.git("config", "diff.evil.textconv", command); f.git("config", "diff.external", command);
    f.git("config", "core.fsmonitor", command); f.git("config", "commit.gpgsign", "true"); f.git("config", "gpg.program", command);
    const include = join(f.repo, "tracked-config"); await writeFile(include, `[core]\nfsmonitor = "${command}"\n`);
    f.git("config", `includeIf.gitdir:${f.repo}/.git.path`, include);
    await writeFile(join(f.repo, ".git/hooks/post-checkout"), `#!/bin/sh\n${command}`, { mode: 0o755 });
    await writeFile(join(f.repo, ".git/hooks/pre-commit"), `#!/bin/sh\n${command}`, { mode: 0o755 });
    await rm(marker, { force: true });
    const before = await snapshot(f.repo), repository = await f.runner.inspect(f.repo);
    expect(await readFile(marker, "utf8").catch(() => null), "inspect").toBeNull();
    await f.runner.diff(repository);
    expect(await readFile(marker, "utf8").catch(() => null), "diff").toBeNull();
    const copy = await f.runner.prepare(repository, join(f.root, "job/group"));
    expect(await readFile(marker, "utf8").catch(() => null), "prepare").toBeNull();
    await writeFile(join(copy.tree, "sample.txt"), "after\n");
    // A forged .git pointer must not redirect any main-process operation.
    await writeFile(join(copy.tree, ".git"), `gitdir: ${f.repo}/.git\n`);
    const artifact = await f.runner.commit(copy, repository, "修复示例", ["sample.txt"]);
    expect(artifact?.changes.map(c => c.path)).toEqual(["sample.txt"]);
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    expect(await snapshot(f.repo)).toEqual(before);
  });
  it("rejects multiple push URLs and ext helpers and creates remote branches only if absent", async () => {
    const f = await fixture(), bare = join(f.root, "remote.git");
    f.git("init", "--bare", bare); f.git("remote", "add", "origin", bare);
    expect(await f.runner.pushUrl(f.repository, "origin")).toBe(bare);
    f.git("config", "--add", "remote.origin.pushurl", bare); f.git("config", "--add", "remote.origin.pushurl", bare + "2");
    await expect(f.runner.pushUrl(f.repository, "origin")).rejects.toThrow("一个");
    expect(() => f.runner.validateUrl("ext::sh -c bad")).toThrow();
    expect(() => new LocalReviewGit().validateUrl(bare)).toThrow();
    const copy = await f.runner.prepare(f.repository, join(f.root, "job/group"));
    await f.runner.push(copy, { url: bare, directory: f.repo, credentialHelpers: [], sshCommand: null }, f.repository.headSha, "paraself/review-fixture");
    await writeFile(join(copy.tree, "sample.txt"), "after\n");
    const artifact = (await f.runner.commit(copy, f.repository, "修复示例", ["sample.txt"]))!;
    await expect(f.runner.push(copy, { url: bare, directory: f.repo, credentialHelpers: [], sshCommand: null }, artifact.commitOid, "paraself/review-fixture")).rejects.toThrow();
    expect(await f.runner.branchOid({ url: bare, directory: f.repo, credentialHelpers: [], sshCommand: null }, "paraself/review-fixture")).toBe(f.repository.headSha);
  });
  it("finds both rename paths, existing symlink changes, gitlinks and new executable bits", () => {
    expect(reviewRisks([{ path: "ordinary", oldPath: ".github/workflows/ci.yml", oldMode: "100644", newMode: "100644", status: "R100" }, { path: "link", oldMode: "120000", newMode: "120000", status: "M" }, { path: "module", oldMode: "160000", newMode: "000000", status: "D" }, { path: "bin", oldMode: "100644", newMode: "100755", status: "M" }])).toEqual([".github/workflows/ci.yml", "bin", "link", "module", "ordinary"]);
  });
  it.each([".gitattributes", ".gitmodules", ".gitconfig"])("gates nested %s additions, edits, deletions and both rename directions", name => {
    for (const status of ["A", "M", "D"]) expect(reviewRisks([{ path: `packages/nested/${name}`, oldMode: status === "A" ? "000000" : "100644", newMode: status === "D" ? "000000" : "100644", status }])).toEqual([`packages/nested/${name}`]);
    expect(reviewRisks([{ path: "ordinary.txt", oldPath: `nested/${name}`, oldMode: "100644", newMode: "100644", status: "R100" }])).toEqual([`nested/${name}`, "ordinary.txt"].sort());
    expect(reviewRisks([{ path: `nested/${name}`, oldPath: "ordinary.txt", oldMode: "100644", newMode: "100644", status: "R100" }])).toEqual([`nested/${name}`, "ordinary.txt"].sort());
  });
  it("gates the rules files every review and agent reads, wherever they sit, and not other Markdown", () => {
    const change = (path: string) => ({ path, oldMode: "100644", newMode: "100644", status: "M" });
    expect(reviewRisks([change("REVIEW.md"), change("docs/AGENTS.md"), change("pkg/CLAUDE.md"), change("README.md"), change("docs/review-notes.md")])).toEqual(["REVIEW.md", "docs/AGENTS.md", "pkg/CLAUDE.md"]);
  });
  it("keeps CI matching at platform roots and does not gate nested .gitignore", () => {
    const change = (path: string) => ({ path, oldMode: "100644", newMode: "100644", status: "M" });
    expect(reviewRisks([change("nested/.github/workflows/test.yml"), change("nested/.gitlab-ci.yml"), change("nested/.gitignore")])).toEqual([]);
    expect(reviewRisks([change(".github/workflows/test.yml"), change(".gitlab-ci.yml")])).toHaveLength(2);
  });
  it("includes a real nested attributes change even when no LFS content path changed", async () => {
    const f = await fixture(), copy = await f.runner.prepare(f.repository, join(f.root, "job/group"));
    await mkdir(join(copy.tree, "nested")); await writeFile(join(copy.tree, "nested/.gitattributes"), "*.txt filter=lfs\n");
    expect((await f.runner.commit(copy, f.repository, "增加嵌套属性", ["nested/.gitattributes"]))!.risks).toContain("nested/.gitattributes");
  });
  it.each(["file", "ext"])("does not re-evaluate model-tree includeIf rewrites to %s", async protocol => {
    const f = await fixture(), approved = "https://approved.invalid/org/app.git", bare = join(f.root, "redirected.git"), marker = join(f.root, "executed");
    f.git("init", "--bare", bare); f.git("remote", "add", "origin", approved);
    const runner = new LocalReviewGit("/usr/bin/git", { HOME: join(f.root, "home"), PATH: process.env.PATH });
    const network = await runner.captureNetwork(f.repository, "origin");
    const copy = await runner.prepare(f.repository, join(f.root, "job/group"));
    const include = join(copy.tree, "git-network.conf"), executable = join(copy.tree, "receive.sh");
    await writeFile(executable, `#!/bin/sh\necho unsafe > '${marker}'\nexec /usr/bin/git-receive-pack '${bare}'\n`, { mode: 0o755 });
    await writeFile(include, `[protocol "${protocol}"]\nallow = always\n[url "${protocol === "file" ? bare : `ext::/bin/sh ${executable}`} "]\ninsteadOf = ${approved}\n`);
    await writeFile(join(f.root, "home/.gitconfig"), `[includeIf "gitdir:${copy.git}"]\npath = ${include}\n`);
    await expect(runner.push(copy, network, f.repository.headSha, "review/unsafe", AbortSignal.timeout(1500))).rejects.toThrow();
    expect(await readFile(marker, "utf8").catch(() => null)).toBeNull();
    expect(() => f.git("--git-dir", bare, "rev-parse", "refs/heads/review/unsafe")).toThrow();
  });
  it("uses frozen credential helpers and relative SSH commands from the original repository", async () => {
    const f = await fixture(), bare = join(f.root, "remote.git"), credentialMarker = join(f.root, "credential-used"), unsafe = join(f.root, "unsafe");
    f.git("init", "--bare", bare);
    const helper = join(f.root, "credential-helper");
    await writeFile(helper, `#!/bin/sh\necho helper >> '${credentialMarker}'\nprintf 'username=fixture\\npassword=synthetic\\n'\n`, { mode: 0o755 });
    await writeFile(join(f.repo, "ssh-fixture"), `#!/bin/sh\ncase "$*" in *git-receive-pack*) exec /usr/bin/git-receive-pack '${bare}';; *) exec /usr/bin/git-upload-pack '${bare}';; esac\n`, { mode: 0o755 });
    f.git("config", "credential.helper", helper); f.git("config", "core.sshCommand", "./ssh-fixture"); f.git("remote", "add", "origin", "ssh://fixture.invalid/org/app.git");
    const wrapper = join(f.root, "git-with-credential-exercise");
    await writeFile(wrapper, `#!${process.execPath}
const cp=require('node:child_process'),args=process.argv.slice(2),at=args.findIndex(a=>a==='push'||a==='ls-remote');
if(at>=0)cp.execFileSync('/usr/bin/git',[...args.slice(0,at),'credential','fill'],{env:process.env,input:'protocol=https\\nhost=fixture.invalid\\n\\n',stdio:['pipe','pipe','pipe']});
const result=cp.spawnSync('/usr/bin/git',args,{env:process.env,stdio:'inherit'});process.exit(result.status??1);`, { mode: 0o755 });
    const runner = new LocalReviewGit(wrapper, { HOME: join(f.root, "home"), PATH: process.env.PATH });
    const network = await runner.captureNetwork(f.repository, "origin"), copy = await runner.prepare(f.repository, join(f.root, "job/group"));
    f.git("config", "core.sshCommand", "unusable-after-snapshot"); f.git("config", "credential.helper", "unusable-after-snapshot");
    await writeFile(join(copy.tree, "ssh-fixture"), `#!/bin/sh\necho unsafe > '${unsafe}'\nexit 1\n`, { mode: 0o755 });
    await runner.push(copy, network, f.repository.headSha, "review/frozen");
    expect(await runner.branchOid(network, "review/frozen")).toBe(f.repository.headSha);
    expect(await readFile(credentialMarker, "utf8")).toContain("helper");
    expect(await readFile(unsafe, "utf8").catch(() => null)).toBeNull();
  });
});
