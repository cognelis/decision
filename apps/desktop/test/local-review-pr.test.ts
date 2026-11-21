import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prDescriptionVersion, type ModelProviderProfile } from "@cognelis/decision-protocol";

import { LocalReviewDependencies } from "../src/main/local-review-dependencies.js";
import { LocalReviewGit, type ReviewCopy, type ReviewNetworkSnapshot } from "../src/main/local-review-git.js";
import { LocalReviewService } from "../src/main/local-review-service.js";
import * as reviewWorkers from "../src/main/local-review-workers.js";
import { reviewEvaluation, reviewFix } from "../src/main/local-review-worker.js";
import type { PrConnections } from "../src/main/pr-connections.js";
import type { PrThread } from "../src/main/pr-platform-client.js";

vi.mock("../src/main/login-shell-path.js", () => ({ loginShellPath: async (environment: NodeJS.ProcessEnv) => environment.PATH ?? "" }));

const dispose: Array<() => Promise<unknown>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of dispose.splice(0).reverse()) await close(); });

/**
 * 修 end to end inside the App's main process: a real repository whose feature branch is the user's PR, a bare one as its
 * remote, the platform's client and the coding agent stand-ins. The fix waits for the author's word, goes onto the PR's
 * branch only while it is still at the head it was made on, then the comments fixed are answered and 本轮变化 written.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lr-pr-")); dispose.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), bare = join(root, "remote.git"), home = join(root, "home");
  await mkdir(repo); await mkdir(home);
  const environment = { HOME: home, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (...args: string[]) => execFileSync("/usr/bin/git", args, { cwd: repo, env: environment, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(repo, "file0.txt"), "before\n"); git("add", "."); git("commit", "-m", "base");
  git("init", "--bare", bare); git("remote", "add", "origin", bare); git("push", "origin", "main");
  // The PR: the feature branch, pushed, its head fetched here as the author has it.
  git("checkout", "-b", "feature"); await writeFile(join(repo, "file1.txt"), "feature\n"); git("add", "."); git("commit", "-m", "feature"); git("push", "origin", "feature");
  const head = git("rev-parse", "HEAD"), main = git("rev-parse", "main");
  git("checkout", "main");
  const remoteHead = () => execFileSync("/usr/bin/git", ["--git-dir", bare, "rev-parse", "refs/heads/feature"], { encoding: "utf8" }).trim();
  class FixtureGit extends LocalReviewGit {
    override pushUrl() { return Promise.resolve("https://code.example/org/app.git"); }
    override originUrl() { return Promise.resolve("https://code.example/org/app.git"); }
    override branchOid(snapshot: ReviewNetworkSnapshot, branch: string, signal?: AbortSignal) { return super.branchOid({ ...snapshot, url: bare }, branch, signal); }
    override push(copy: ReviewCopy, snapshot: ReviewNetworkSnapshot, commit: string, branch: string, signal?: AbortSignal, expected = "") { return super.push(copy, { ...snapshot, url: bare }, commit, branch, signal, expected); }
  }
  const thread = (id: string, body: string, extra: Partial<PrThread> = {}): PrThread => ({ id, url: `https://code.example/org/app/pull/7#discussion_r${id}`, author: "bob", login: "bob", path: "file0.txt", line: 1, side: "new",
    body, createdAt: "2026-11-12T10:00:00.000Z", task: null, resolved: null, replies: [], ...extra });
  const threads: PrThread[] = [
    thread("21", "**P1 · 失败时没有清理**\n\n要清理。\n\n— Paraself 预评审 · 依据 REVIEW.md · P1"),
    thread("22", "这里的命名不清楚"),
    thread("23", "整体看能不能拆小？", { path: null, line: null, side: null }),
    thread("24", "上限能不能可配置？", { replies: [{ id: "r0", author: "alice", login: "alice", createdAt: "2026-11-12T11:00:00.000Z", body: "**转后续**：已建待办「上限可配置」。\n\n— Paraself 作者回应" }] }),
  ];
  const replies: Array<[string, string]> = [];
  let description = "## 验证\n单测。", failReplies = 0;
  const client = {
    get: async () => ({ title: "PR", description, source: { repository: "org/app", commit: remoteHead() }, destination: { repository: "org/app", commit: main } }),
    threads: async () => ({ threads: structuredClone(threads), more: false }),
    webUrl: () => "https://code.example/org/app/pull/7",
    actionContext: async () => ({ sourceBranch: "feature", destinationBranch: "main", state: "open" }),
    account: async () => "alice",
    reply: async (_reference: string, answered: PrThread, body: string) => {
      if (failReplies) { failReplies--; throw new Error("平台暂时不可用"); }
      replies.push([answered.id, body]);
      threads.find((item) => item.id === answered.id)!.replies.push({ id: `r${replies.length}`, author: "alice", login: "alice", body, createdAt: new Date().toISOString() });
      return `r${replies.length}`;
    },
    readDescription: async () => ({ title: "PR", description, version: prDescriptionVersion(description) }),
    updateDescription: async (input: { description: string; baseVersion: string }) => {
      if (input.baseVersion !== prDescriptionVersion(description)) throw new Error("moved");
      description = input.description; return { message: "PR 描述已更新。" };
    },
  };
  const connection = { id: "00000000-0000-4000-8000-0000000000c7", label: "fixture", platform: "github" as const, baseUrl: "https://code.example" };
  const connections = { list: async () => [connection], client: async () => client, exclusive: <T>(operation: () => Promise<T>) => operation() } as unknown as PrConnections;
  const profile: ModelProviderProfile = { version: 1, profileId: "fixture", kind: "codex-cli", label: "fixture", enabled: true, priority: 0, timeoutMs: 1000, model: "fixture", executablePath: "/usr/bin/false" };
  vi.spyOn(LocalReviewDependencies.prototype, "prepare").mockResolvedValue({ summary: "未准备依赖。", log: "" });
  // Two groups from the evaluation, each fixing its comment in file0.txt: a PR's task puts them back into one commit.
  const fixes: string[][] = [];
  vi.spyOn(reviewWorkers, "createLocalReviewWorker").mockImplementation(() => ({
    capability: async () => undefined,
    discuss: async () => { throw new Error("not used"); },
    evaluate: async (_copy, annotations) => reviewEvaluation({ verdicts: annotations.map((a) => ({ id: a.id, verdict: "accept", reason: "成立" })), groups: annotations.map((a, index) => ({ title: `组 ${index + 1}`, annotationIds: [a.id], reason: "独立" })) }, annotations.map((a) => a.id)),
    fix: async (copy, annotations) => {
      fixes.push(annotations.map((a) => a.body));
      await writeFile(join(copy.tree, "file0.txt"), "after\n");
      return reviewFix({ changedFiles: ["file0.txt"], outcomes: annotations.map((a, index) => ({ id: a.id, outcome: index ? "partial" : "fixed", summary: index ? "改了一半" : "失败时清理" })), commitTitle: "fix: 回应 PR 意见", verification: "跑了单测，通过" }, annotations.map((a) => a.id));
    },
  }));
  const service = new LocalReviewService(join(root, "local-review"), new FixtureGit("/usr/bin/git", environment, true), connections, async () => [profile], environment, () => undefined);
  await service.start(); dispose.push(() => service.close());
  await service.register(repo);
  const repositoryId = service.state().repositories[0]!.id;
  return { service, repositoryId, head, remoteHead, replies, fixes, git, repo, bare, environment, description: () => description, failReply: () => { failReplies = 1; } };
}

it("fixes the chosen comments of a PR in one commit, waits for the author, then pushes onto its branch and answers them", async () => {
  const f = await fixture();
  // A comment on the PR as a whole has no line: not handed over.
  await expect(f.service.submitFromPr({ connectionId: "00000000-0000-4000-8000-0000000000c7", reference: "org/app#7", commentIds: ["23"], profileId: "fixture" })).rejects.toThrow("是整体评论，没有位置");
  const jobId = await f.service.submitFromPr({ connectionId: "00000000-0000-4000-8000-0000000000c7", reference: "org/app#7", commentIds: ["21", "22"], profileId: "fixture" });
  await f.service.idle();
  let job = f.service.state().jobs.find((item) => item.id === jobId)!;
  expect(job.pr).toMatchObject({ reference: "org/app#7", sourceBranch: "feature", headSha: f.head, comments: [{ commentId: "21", title: "失败时没有清理", author: "bob" }, { commentId: "22", title: "这里的命名不清楚" }] });
  expect(job.snapshot.headSha).toBe(f.head);
  expect(job.annotations[0]).toMatchObject({ path: "file0.txt", startLine: 1, lineText: "before", body: expect.stringContaining("bob 在 PR 上的意见") });
  // One group, one commit on the PR's branch; nothing pushed until the author says so.
  expect(f.fixes).toHaveLength(1);
  expect(job.groups).toEqual([expect.objectContaining({ title: "回应 PR 上的意见", branch: "feature", state: "blocked" })]);
  const group = job.groups[0]!;
  expect(f.remoteHead()).toBe(f.head);

  await f.service.action({ repositoryId: f.repositoryId, jobId, groupId: group.id, action: "approve", authorization: { groupId: group.id, commitOid: group.artifact!.commitOid, risks: group.artifact!.risks, pushUrl: job.pushUrl } });
  await f.service.idle();
  job = f.service.state().jobs.find((item) => item.id === jobId)!;
  expect(f.remoteHead()).toBe(group.artifact!.commitOid);
  expect(execFileSync("/usr/bin/git", ["--git-dir", f.bare, "rev-parse", `${group.artifact!.commitOid}^`], { encoding: "utf8" }).trim()).toBe(f.head);
  expect(job.groups[0]).toMatchObject({ state: "pr_opened", pr: { id: "7", url: "https://code.example/org/app/pull/7" } });
  const short = group.artifact!.commitOid.slice(0, 12);
  expect(f.replies).toEqual([
    ["21", `**已修**：已修复，见提交 ${short}。失败时清理\n\n— Paraself 作者回应`],
    ["22", `**已修**：部分修复，见提交 ${short}。改了一半\n\n— Paraself 作者回应`],
  ]);
  expect(f.description()).toBe(`## 验证\n单测。\n\n## 本轮变化\n\n提交 \`${short}\` 修复 2 条意见（其中 1 条部分修复）：\n- 失败时没有清理（回应 bob）\n- 这里的命名不清楚（回应 bob）\n另 1 条已回复：转后续 1 条。`);
  expect(job.pr).toMatchObject({ replied: ["21", "22"], described: true, followUpError: null });
});

it("stops before the push when the PR's branch moved, overwriting nothing, and sends answers that did not go out again", async () => {
  const f = await fixture();
  const jobId = await f.service.submitFromPr({ connectionId: "00000000-0000-4000-8000-0000000000c7", reference: "org/app#7", commentIds: ["21"], profileId: "fixture" });
  await f.service.idle();
  const job = f.service.state().jobs.find((item) => item.id === jobId)!, group = job.groups[0]!;
  // A co-author pushes onto the PR's branch meanwhile.
  f.git("checkout", "feature"); await writeFile(join(f.repo, "file2.txt"), "co-author\n"); f.git("add", "."); f.git("commit", "-m", "co-author"); f.git("push", "origin", "feature"); f.git("checkout", "main");
  const theirs = f.remoteHead();
  await f.service.action({ repositoryId: f.repositoryId, jobId, groupId: group.id, action: "approve", authorization: { groupId: group.id, commitOid: group.artifact!.commitOid, risks: group.artifact!.risks, pushUrl: job.pushUrl } });
  await f.service.idle();
  const moved = f.service.state().jobs.find((item) => item.id === jobId)!.groups[0]!;
  expect(moved).toMatchObject({ state: "failed", retryable: false, error: expect.stringMatching(/^推送前远端分支头变了：feature 现在是 [0-9a-f]{12}，不是修复时的 [0-9a-f]{12}。已停止推送，没有覆盖/u) });
  expect(f.remoteHead()).toBe(theirs);
  expect(f.replies).toEqual([]);

  // Redone on the new head: pushed, its answer refused once by the platform, then sent again on follow_up.
  const redo = await f.service.submitFromPr({ connectionId: "00000000-0000-4000-8000-0000000000c7", reference: "org/app#7", commentIds: ["21"], profileId: "fixture" });
  await f.service.idle();
  const again = f.service.state().jobs.find((item) => item.id === redo)!;
  expect(again.pr!.headSha).toBe(theirs);
  f.failReply();
  await f.service.action({ repositoryId: f.repositoryId, jobId: redo, groupId: again.groups[0]!.id, action: "approve", authorization: { groupId: again.groups[0]!.id, commitOid: again.groups[0]!.artifact!.commitOid, risks: [], pushUrl: again.pushUrl } });
  await f.service.idle();
  expect(f.service.state().jobs.find((item) => item.id === redo)!.pr).toMatchObject({ replied: [], described: true, followUpError: "「失败时没有清理」的回复没有发出：平台暂时不可用" });
  await f.service.action({ repositoryId: f.repositoryId, jobId: redo, action: "follow_up" });
  expect(f.service.state().jobs.find((item) => item.id === redo)!.pr).toMatchObject({ replied: ["21"], followUpError: null });
  expect(f.replies).toHaveLength(1);
});
