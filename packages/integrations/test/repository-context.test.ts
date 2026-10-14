import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionProjectFor, normalizeRepositoryRemote, resolveDecisionRepository } from "../src/repository-context.js";

const run = promisify(execFile);
const roots: string[] = [];
// Construct synthetic auth at runtime; no credential-bearing URL is stored in the repository.
const syntheticAuthenticatedRemote = (address: string) => {
  const url = new URL(address);
  url.username = "test-user";
  url.password = "synthetic-value";
  url.searchParams.set("access_token", "fixture");
  return url.href;
};
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const makeRepo = async () => {
  const root = await mkdtemp(join(tmpdir(), "decision-repository-")); roots.push(root);
  const repo = join(root, "project");
  await mkdir(repo);
  await writeFile(join(root, "empty-config"), "");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, "empty-config"), GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (...args: string[]) => run("git", ["-C", repo, ...args], { env });
  await git("init", "-q");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`, "commit", "--allow-empty", "-qm", "initial");
  return { root, repo, git };
};

describe("repository identity", () => {
  it("normalizes SSH and HTTPS without credentials, preserving nonstandard server ports", () => {
    expect(normalizeRepositoryRemote(syntheticAuthenticatedRemote("https://example.com/team/repo.git"))).toBe("example.com/team/repo");
    expect(normalizeRepositoryRemote("git@example.com:team/repo.git")).toBe("example.com/team/repo");
    expect(normalizeRepositoryRemote("ssh://git@example.com:22/team/repo.git")).toBe("example.com/team/repo");
    expect(normalizeRepositoryRemote("ssh://git@example.com:2222/team/repo.git")).toBe("example.com:2222/team/repo");
    expect(normalizeRepositoryRemote("/local/repository")).toBeNull();
  });

  it("resolves linked worktrees and nested paths to the original checkout project", async () => {
    const { root, repo, git } = await makeRepo();
    const worktree = join(root, "arbitrary-worktree-name");
    await git("-c", `core.hooksPath=${join(root, "no-hooks")}`, "worktree", "add", "--detach", worktree);
    await mkdir(join(worktree, "server/src"), { recursive: true });
    const original = await resolveDecisionRepository(repo);
    const linked = await resolveDecisionRepository(join(worktree, "server/src"));
    expect(linked).toMatchObject({ id: original?.id, project: basename(repo), relativeDirectory: "server/src", identitySource: "git_common_directory" });
    expect(JSON.stringify(linked)).not.toContain(root);
    vi.stubEnv("GIT_DIR", join(root, "unrelated.git"));
    expect(await resolveDecisionRepository(repo)).toEqual(original);
  });

  it("names a decision's project as search resolves it: from a worktree, the repository; elsewhere, the folder", async () => {
    const { root, repo, git } = await makeRepo();
    const worktree = join(root, "change-size");
    await git("-c", `core.hooksPath=${join(root, "no-hooks")}`, "worktree", "add", "--detach", worktree);
    await mkdir(join(worktree, "server"), { recursive: true });
    // Recorded in a worktree, a decision is found again from it rather than set aside as another project's.
    expect(await decisionProjectFor(join(worktree, "server"))).toBe(basename(repo));
    expect(await decisionProjectFor(join(root, "not-a-repository"))).toBe("not-a-repository");
  });

  it("names a Claude Code worktree removed before its capture was read after the repository it was made in", async () => {
    const { root, repo, git } = await makeRepo();
    const worktree = join(repo, ".claude", "worktrees", "change-size");
    await git("-c", `core.hooksPath=${join(root, "no-hooks")}`, "worktree", "add", "--detach", worktree);
    await git("worktree", "remove", "--force", worktree);

    expect(await decisionProjectFor(worktree)).toBe(basename(repo));
    expect(await decisionProjectFor(join(worktree, "server"))).toBe(basename(repo));
    // Any other folder that is gone keeps its own name.
    expect(await decisionProjectFor(join(root, "gone", "change-size"))).toBe("change-size");
  });

  it("uses a stable remote identity while retaining the recorded checkout name", async () => {
    const { repo, git } = await makeRepo();
    await git("remote", "add", "origin", syntheticAuthenticatedRemote("https://example.com/team/renamed.git"));
    const first = await resolveDecisionRepository(repo);
    await git("remote", "set-url", "origin", "git@example.com:team/renamed.git");
    expect(await resolveDecisionRepository(repo)).toEqual(first);
    expect(first).toMatchObject({ project: "project", identitySource: "remote" });
    expect(JSON.stringify(first)).not.toMatch(/synthetic-value|test-user|example\.com|team\/renamed/u);
  });

  it("does not replace invalid task paths with the MCP process directory", async () => {
    expect(await resolveDecisionRepository("relative/path")).toBeNull();
    expect(await resolveDecisionRepository(join(tmpdir(), "missing-decision-repository"))).toBeNull();
  });
});
