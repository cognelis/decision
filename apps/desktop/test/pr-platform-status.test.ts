import { expect, it, vi } from "vitest";
import type { PrConnection } from "@cognelis/decision-protocol";
import { HostedPrClient, PrPlatformError, type PrQuery, type PrRead } from "../src/main/pr-platform-client.js";

const head = "a".repeat(40), base = "b".repeat(40);
/** Each response by its path, the query string aside; an error is thrown as the platform's answer. */
const client = (platform: PrConnection["platform"], responses: Record<string, unknown>, query?: PrQuery) => {
  const read = vi.fn<PrRead>(async (path) => {
    const value = responses[path.split("?")[0]!];
    if (value === undefined) throw new Error(`Unexpected endpoint ${path}`);
    if (value instanceof Error) throw value;
    return { text: JSON.stringify(value), next: false };
  });
  return { read, client: new HostedPrClient({ id: "00000000-0000-4000-8000-000000000001", label: platform, platform, baseUrl: "https://code.example" }, read, undefined, query) };
};

const bitbucket = "/rest/api/1.0/projects/org/repos/app/pull-requests/1";
const person = (name: string, approved: boolean, type = "NORMAL", lastReviewedCommit?: string) => ({ user: { name, displayName: name.toUpperCase(), type }, approved, ...(lastReviewedCommit ? { lastReviewedCommit } : {}) });
const hook = "/rest/api/1.0/projects/org/repos/app/settings/hooks/com.atlassian.bitbucket.server.bitbucket-bundled-hooks%3Aincomplete-tasks-merge-check";

it("reads Bitbucket's approvals by people, open tasks and the head commit's builds", async () => {
  const { client: bb } = client("bitbucket-server", {
    [bitbucket]: { fromRef: { latestCommit: head }, reviewers: [person("alice", true, "NORMAL", head), person("ci-bot", true, "SERVICE"), person("bob", false), person("dave", true, "NORMAL", base)], participants: [person("carol", true)], properties: { openTaskCount: 2 } },
    [`/rest/build-status/1.0/commits/stats/${head}`]: { successful: 1, inProgress: 0, failed: 1 },
    [hook]: { enabled: true },
  });
  // Dave approved an earlier commit and has not looked again: said, not counted.
  expect(await bb.status("org/app#1")).toEqual({ sourceCommit: head, build: "failed", approvals: { count: 2, users: ["ALICE", "CAROL"], logins: ["alice", "carol"], stale: ["DAVE"] }, blockers: 2, blocking: "tasks", blockersHold: true, sections: { verification: false, risk: false, rollback: false }, problems: [] });

  // A server that does not count tasks on the PR is asked for its open blocker comments; builds it will not give are unknown, and said.
  const { client: older } = client("bitbucket-server", {
    [bitbucket]: { fromRef: { latestCommit: head }, reviewers: [] },
    [`${bitbucket}/blocker-comments`]: { size: 1, isLastPage: true, values: [{}] },
    [`/rest/build-status/1.0/commits/stats/${head}`]: new PrPlatformError(404),
  });
  const status = await older.status("org/app#1");
  // Its merge checks unread (an administrator's settings): unknown, never said as off.
  expect(status).toMatchObject({ build: "unknown", approvals: { count: 0, users: [] }, blockers: 1, blockersHold: null });
  expect(status.problems).toEqual([expect.stringMatching(/^构建状态读不到：.*HTTP 404/u)]);
});

it("reads GitHub's latest deciding review per person, statuses with check runs, and unresolved threads by GraphQL", async () => {
  const query = vi.fn<PrQuery>(async () => ({ text: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 3, nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] } } } } }), next: false }));
  const responses = {
    "/repos/org/app/pulls/1": { title: "PR", body: "", head: { sha: head, repo: { full_name: "org/app" } }, base: { sha: base, ref: "main", repo: { full_name: "org/app" } } },
    "/repos/org/app/pulls/1/reviews": [
      { user: { login: "alice", type: "User" }, state: "APPROVED", commit_id: head }, { user: { login: "alice", type: "User" }, state: "COMMENTED" },
      { user: { login: "erin", type: "User" }, state: "APPROVED", commit_id: base },
      { user: { login: "bob", type: "User" }, state: "CHANGES_REQUESTED" }, { user: { login: "deps[bot]", type: "Bot" }, state: "APPROVED" },
      { user: { login: "carol", type: "User" }, state: "APPROVED" }, { user: { login: "carol", type: "User" }, state: "DISMISSED" }, { user: null, state: "APPROVED" },
    ],
    // No statuses at all reads "pending": nothing to wait for, not a build running.
    [`/repos/org/app/commits/${head}/status`]: { state: "pending", total_count: 0 },
    [`/repos/org/app/commits/${head}/check-runs`]: { total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }, { status: "completed", conclusion: "skipped" }] },
    // A ruleset says discussions must be resolved, which classic protection (an administrator's) need not be read for.
    "/repos/org/app/rules/branches/main": [{ type: "pull_request", parameters: { required_review_thread_resolution: true } }],
  };
  const { client: gh } = client("github", responses, query);
  expect(await gh.status("org/app#1")).toEqual({ sourceCommit: head, build: "passed", approvals: { count: 1, users: ["alice"], logins: ["alice"], stale: ["erin"] }, blockers: 2, blocking: "discussions", blockersHold: true, sections: { verification: false, risk: false, rollback: false }, problems: [] });
  expect(query).toHaveBeenCalledWith("/graphql", expect.objectContaining({ variables: { owner: "org", name: "app", number: 1 } }), undefined);

  // A failure anywhere fails the build; a source not read leaves passing unknown, never passed.
  const { client: failing } = client("github", { ...responses, [`/repos/org/app/commits/${head}/status`]: { state: "failure", total_count: 1 },
    [`/repos/org/app/commits/${head}/check-runs`]: { total_count: 1, check_runs: [{ status: "in_progress", conclusion: null }] } }, query);
  expect((await failing.status("org/app#1")).build).toBe("failed");
  const { client: unread } = client("github", { ...responses, [`/repos/org/app/commits/${head}/check-runs`]: new PrPlatformError(403), "/repos/org/app/rules/branches/main": [],
    "/repos/org/app/branches/main/protection": new PrPlatformError(404) });
  const partial = await unread.status("org/app#1");
  expect(partial).toMatchObject({ build: "unknown", blockers: null, blockersHold: null });
  expect(partial.problems).toEqual([expect.stringMatching(/^检查读不到/u), expect.stringMatching(/^未解决的讨论读不到/u)]);
});

it("reads GitLab's head pipeline, approvals and unresolved discussions", async () => {
  const endpoint = "/projects/org%2Fapp/merge_requests/1";
  const responses = {
    [endpoint]: { diff_refs: { head_sha: head, start_sha: base, base_sha: base }, head_pipeline: { sha: head, status: "running" } },
    [`${endpoint}/approvals`]: { approved_by: [{ user: { username: "alice", name: "Alice" } }] },
    [`${endpoint}/discussions`]: [{ notes: [{ resolvable: true, resolved: false }] }, { notes: [{ resolvable: true, resolved: true }] }, { notes: [{ resolvable: false }] }],
    "/projects/org%2Fapp": { only_allow_merge_if_all_discussions_are_resolved: false },
  };
  const { client: gl } = client("gitlab", responses);
  // Not set to hold the merge on them: said as off, so blocking there stops nothing.
  expect(await gl.status("org/app#1")).toEqual({ sourceCommit: head, build: "running", approvals: { count: 1, users: ["Alice"], logins: ["alice"], stale: [] }, blockers: 1, blocking: "discussions", blockersHold: false, sections: { verification: false, risk: false, rollback: false }, problems: [] });
  // The pipeline of an earlier commit says nothing about this one.
  const { client: behind } = client("gitlab", { ...responses, [endpoint]: { ...responses[endpoint], head_pipeline: { sha: base, status: "success" } } });
  expect(await behind.status("org/app#1")).toMatchObject({ build: "unknown", problems: ["最新提交的流水线还没有结果。"] });
});
