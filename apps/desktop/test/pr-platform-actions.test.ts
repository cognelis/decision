import { expect, it, vi } from "vitest";
import { HostedPrClient, PrPlatformError, type PrRead, type PrWrite } from "../src/main/pr-platform-client.js";
import { PrConnections } from "../src/main/pr-connections.js";
import type { PrActionRequest, PrConnection } from "@cognelis/decision-protocol";

const head = "a".repeat(40), base = "b".repeat(40);
const request: PrActionRequest = { connectionId: "00000000-0000-4000-8000-000000000001", reference: "org/app#1", sourceCommit: head, destinationCommit: base, sourceBranch: "feature", destinationBranch: "main", action: "approve", body: "", mergeMethod: "merge" };
const raw = {
  github: { title: "PR", state: "open", merged: false, head: { sha: head, ref: "feature", repo: { full_name: "fork/app" } }, base: { sha: base, ref: "main", repo: { full_name: "org/app" } } },
  gitlab: { title: "MR", state: "opened", source_branch: "feature", target_branch: "main", source_project_id: 1, target_project_id: 2, diff_refs: { head_sha: head, start_sha: base, base_sha: base } },
  "bitbucket-server": { id: 1, title: "PR", state: "OPEN", version: 7, updatedDate: 0, author: { user: { name: "author" } }, fromRef: { latestCommit: head, displayId: "feature", repository: { slug: "app", project: { key: "fork" } } }, toRef: { latestCommit: base, displayId: "main", repository: { slug: "app", project: { key: "org" } } } },
};
const setup = (platform: PrConnection["platform"]) => {
  const read = vi.fn<PrRead>(async path => ({ text: JSON.stringify(path.startsWith("/rest/api/1.0/users/") ? { slug: "alice" } : raw[platform]), next: false, username: "Alice" }));
  const write = vi.fn<PrWrite>(async (_path, _method, body) => ({ text: JSON.stringify(platform === "github" ? body.event ? { state: body.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED", commit_id: head } : { merged: true } : platform === "gitlab" ? { state: "merged", approved_by: [{ user: { id: 1 } }], data: { mergeRequestRequestChanges: { errors: [], mergeRequest: { iid: "1" } } } } : body.status ? { status: body.status, lastReviewedCommit: head } : { state: "MERGED" }), next: false }));
  return { read, write, client: new HostedPrClient({ id: request.connectionId, label: platform, platform, baseUrl: "https://code.example" }, read, write) };
};

it.each(["github", "gitlab", "bitbucket-server"] as const)("submits platform-specific review and merge actions on %s", async platform => {
  const { client, write } = setup(platform);
  const expected = { connectionId: request.connectionId, reference: request.reference, sourceCommit: head, destinationCommit: base };
  expect(await client.actionContext(expected)).toMatchObject({ sourceBranch: "feature", destinationBranch: "main", state: "open", canReview: true });
  for (const action of ["approve", "need-work", "merge"] as const) {
    expect(await client.performAction({ ...request, action, body: platform === "github" && action === "need-work" ? "请处理超时" : "" })).toMatchObject({ action });
  }
  expect(write).toHaveBeenCalledTimes(3);
  if (platform === "github") {
    expect(write.mock.calls[0]).toEqual(["/repos/org/app/pulls/1/reviews", "POST", { commit_id: head, event: "APPROVE" }]);
    expect(write.mock.calls[1]![2]).toEqual({ commit_id: head, event: "REQUEST_CHANGES", body: "请处理超时" });
    expect(write.mock.calls[2]![2]).toEqual({ sha: head, merge_method: "merge" });
  } else if (platform === "gitlab") {
    expect(write.mock.calls[0]![2]).toEqual({ sha: head });
    expect(write.mock.calls[1]![0]).toBe("/graphql");
    expect(write.mock.calls[1]![2]).toMatchObject({ variables: { projectPath: "org/app", iid: "1" } });
    expect(write.mock.calls[2]![2]).toEqual({ sha: head });
  } else {
    expect(write.mock.calls[0]).toEqual(["/rest/api/1.0/projects/org/repos/app/pull-requests/1/participants/alice?version=7", "PUT", { status: "APPROVED", lastReviewedCommit: head }]);
    expect(write.mock.calls[1]![2]).toEqual({ status: "NEEDS_WORK", lastReviewedCommit: head });
    expect(write.mock.calls[2]![2]).toEqual({ version: 7 });
    expect(write.mock.calls.some(([path]) => path.endsWith("/review") || path.includes("/comments"))).toBe(false);
  }
});

const comment = { connectionId: request.connectionId, reference: request.reference, sourceCommit: head, destinationCommit: base, path: "src/app.ts", side: "new" as const, line: 12, body: "P1 · 超时未取消" };

it.each(["github", "gitlab", "bitbucket-server"] as const)("publishes a confirmed inline comment on the reviewed line on %s", async platform => {
  const { client, write } = setup(platform);
  write.mockResolvedValue({ text: JSON.stringify(platform === "gitlab" ? { id: "discussion-1" } : { id: 9 }), next: false });
  await expect(client.publishComment(comment)).resolves.toEqual({ message: "评论已发布到 src/app.ts:12。" });
  await client.publishComment({ ...comment, side: "old", line: 8 });
  if (platform === "github") {
    expect(write.mock.calls[0]).toEqual(["/repos/org/app/pulls/1/comments", "POST", { body: "P1 · 超时未取消", commit_id: head, path: "src/app.ts", line: 12, side: "RIGHT" }]);
    expect(write.mock.calls[1]![2]).toMatchObject({ line: 8, side: "LEFT" });
  } else if (platform === "gitlab") {
    expect(write.mock.calls[0]).toEqual(["/projects/org%2Fapp/merge_requests/1/discussions", "POST", { body: "P1 · 超时未取消", position: { position_type: "text", base_sha: base, start_sha: base, head_sha: head, old_path: "src/app.ts", new_path: "src/app.ts", new_line: 12 } }]);
    expect(write.mock.calls[1]![2]).toMatchObject({ position: { old_line: 8 } });
    expect(write.mock.calls[1]![2].position).not.toHaveProperty("new_line");
  } else {
    expect(write.mock.calls[0]).toEqual(["/rest/api/1.0/projects/org/repos/app/pull-requests/1/comments", "POST", { text: "P1 · 超时未取消", anchor: { path: "src/app.ts", line: 12, lineType: "ADDED", fileType: "TO", diffType: "EFFECTIVE" } }]);
    expect(write.mock.calls[1]![2]).toMatchObject({ anchor: { line: 8, lineType: "REMOVED", fileType: "FROM" } });
  }
});

it.each(["github", "gitlab", "bitbucket-server"] as const)("posts a confirmed comment on the PR as a whole on %s", async platform => {
  const { client, write } = setup(platform);
  write.mockResolvedValue({ text: JSON.stringify({ id: 9 }), next: false });
  const general = { connectionId: request.connectionId, reference: request.reference, sourceCommit: head, destinationCommit: base, body: "## PR 概览\n\n修复超时。" };
  await expect(client.publishGeneralComment(general)).resolves.toEqual({ message: "评论已发布到 PR。" });
  expect(write.mock.calls[0]).toEqual(platform === "github" ? ["/repos/org/app/issues/1/comments", "POST", { body: general.body }]
    : platform === "gitlab" ? ["/projects/org%2Fapp/merge_requests/1/notes", "POST", { body: general.body }]
      : ["/rest/api/1.0/projects/org/repos/app/pull-requests/1/comments", "POST", { text: general.body }]);
});

it.each([
  ["github", "https://code.example/org/app/pull/1"],
  ["gitlab", "https://code.example/org/app/-/merge_requests/1"],
  ["bitbucket-server", "https://code.example/projects/org/repos/app/pull-requests/1/overview"],
] as const)("knows where a %s PR is read in a browser", (platform, expected) => {
  expect(setup(platform).client.webUrl(request.reference)).toBe(expected);
});

it("asks for a retry only where one can help", () => {
  expect(new PrPlatformError(400).message).not.toMatch(/重试/u);
  expect(new PrPlatformError(502).message).toMatch(/稍后重试/u);
});

it("does not post a PR-wide comment written for other commits or on a closed PR, and says when a post cannot be confirmed", async () => {
  const { client, write, read } = setup("github");
  const general = { connectionId: request.connectionId, reference: request.reference, sourceCommit: head, destinationCommit: base, body: "概览" };
  await expect(client.publishGeneralComment({ ...general, sourceCommit: "c".repeat(40) })).rejects.toThrow(/提交已变化/);
  read.mockResolvedValueOnce({ text: JSON.stringify({ ...raw.github, state: "closed" }), next: false });
  await expect(client.publishGeneralComment(general)).rejects.toThrow(/已关闭/);
  expect(write).not.toHaveBeenCalled();
  write.mockResolvedValueOnce({ text: "{}", next: false });
  await expect(client.publishGeneralComment(general)).rejects.toThrow(/无法确认评论已发布/);
});

it("says so when a Bitbucket PR moves while its comment, anchored to no commit, is being posted", async () => {
  const { client, write, read } = setup("bitbucket-server");
  let posted = false;
  write.mockImplementation(async () => { posted = true; return { text: JSON.stringify({ id: 9 }), next: false }; });
  const moved = { ...raw["bitbucket-server"], fromRef: { ...raw["bitbucket-server"].fromRef, latestCommit: "c".repeat(40) } };
  read.mockImplementation(async path => ({ text: JSON.stringify(path.startsWith("/rest/api/1.0/users/") ? { slug: "alice" } : posted ? moved : raw["bitbucket-server"]), next: false, username: "Alice" }));
  await expect(client.publishComment(comment)).resolves.toEqual({ message: "评论已发布，但 PR 随后有新的提交；请到平台核对评论是否仍在原来的行上。" });
  expect(write).toHaveBeenCalledTimes(1);
});

it("does not publish comments on stale commits or closed PRs, and says why a line was rejected", async () => {
  const { client, write, read } = setup("github");
  await expect(client.publishComment({ ...comment, sourceCommit: "c".repeat(40) })).rejects.toThrow(/提交已变化/);
  read.mockResolvedValueOnce({ text: JSON.stringify({ ...raw.github, state: "closed" }), next: false });
  await expect(client.publishComment(comment)).rejects.toThrow(/已关闭/);
  expect(write).not.toHaveBeenCalled();
  write.mockRejectedValueOnce(new PrPlatformError(422));
  await expect(client.publishComment(comment)).rejects.toThrow(/不在 PR 的 diff 中/);
  write.mockResolvedValueOnce({ text: "{}", next: false });
  await expect(client.publishComment(comment)).rejects.toThrow(/无法确认评论已发布/);
});

it("does not write stale commits, retargeted branches, closed PRs or empty change requests", async () => {
  const { client, write, read } = setup("github");
  await expect(client.performAction({ ...request, sourceCommit: "c".repeat(40) })).rejects.toThrow(/提交已变化/);
  await expect(client.performAction({ ...request, destinationBranch: "release" })).rejects.toThrow(/分支已变化/);
  await expect(client.performAction({ ...request, action: "need-work" })).rejects.toThrow(/填写修改意见/);
  read.mockResolvedValueOnce({ text: JSON.stringify({ ...raw.github, state: "closed" }), next: false });
  await expect(client.performAction(request)).rejects.toThrow(/已关闭/);
  expect(write).not.toHaveBeenCalled();
});

it("does not report a merge or GraphQL request as successful without confirmation", async () => {
  const github = setup("github");
  github.write.mockResolvedValueOnce({ text: JSON.stringify({ merged: false }), next: false });
  await expect(github.client.performAction({ ...request, action: "merge" })).rejects.toThrow(/未合并/);
  const gitlab = setup("gitlab");
  gitlab.write.mockResolvedValueOnce({ text: JSON.stringify({ errors: [{ message: "unsupported mutation" }] }), next: false });
  await expect(gitlab.client.performAction({ ...request, action: "need-work" })).rejects.toThrow(/GitLab 未确认/);
});

it("keeps Bitbucket merge available when the response does not identify the reviewer", async () => {
  const { client, read, write } = setup("bitbucket-server");
  read.mockResolvedValue({ text: JSON.stringify(raw["bitbucket-server"]), next: false });
  await expect(client.performAction(request)).rejects.toThrow(/无法确认评审人/);
  expect(write).not.toHaveBeenCalled();
  await expect(client.performAction({ ...request, action: "merge" })).resolves.toMatchObject({ action: "merge" });
});

it("blocks concurrent platform mutations instead of queuing duplicate approvals", async () => {
  const connections = new PrConnections("/unused", { get: vi.fn(), set: vi.fn(), delete: vi.fn() });
  const { client } = setup("github");
  vi.spyOn(connections, "client").mockResolvedValue(client);
  let finish!: (value: { action: "approve"; message: string }) => void;
  vi.spyOn(client, "performAction").mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = connections.performAction(request);
  await expect(connections.performAction(request)).rejects.toThrow(/已有平台操作/);
  finish({ action: "approve", message: "已通过" });
  await pending;
  expect(client.performAction).toHaveBeenCalledTimes(1);
});

it.each([
  ["github", "/user", { login: "octo" }, undefined, "octo"],
  ["gitlab", "/user", { id: 1, username: "gl-user" }, undefined, "gl-user"],
  ["bitbucket-server", "/rest/api/1.0/application-properties", { version: "8.9.0" }, "alice", "alice"],
] as const)("names the account a %s token signs in as", async (platform, path, data, username, account) => {
  const read = vi.fn<PrRead>(async () => ({ text: JSON.stringify(data), next: false, username }));
  const client = new HostedPrClient({ id: request.connectionId, label: platform, platform, baseUrl: "https://code.example" }, read);
  expect(await client.account()).toBe(account);
  expect(read).toHaveBeenCalledWith(path, "application/json", undefined, undefined);
});

it("does not take an anonymous or unnamed answer as a working token", async () => {
  const reply = (username?: string) => vi.fn<PrRead>(async () => ({ text: "{}", next: false, username }));
  const connection = (platform: PrConnection["platform"]) => ({ id: request.connectionId, label: platform, platform, baseUrl: "https://code.example" });
  await expect(new HostedPrClient(connection("bitbucket-server"), reply("anonymous")).account()).rejects.toThrow("没有认出令牌对应的账号");
  await expect(new HostedPrClient(connection("github"), reply()).account()).rejects.toThrow("没有认出令牌对应的账号");
});
