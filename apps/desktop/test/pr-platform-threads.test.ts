import { expect, it, vi } from "vitest";
import type { PrConnection } from "@cognelis/decision-protocol";
import { HostedPrClient, type PrQuery, type PrRead, type PrWrite } from "../src/main/pr-platform-client.js";

/** Each response by its path, the query string aside; the client reads the threads (作者回应) from them. */
const client = (platform: PrConnection["platform"], responses: Record<string, unknown>, query?: PrQuery) => {
  const read = vi.fn<PrRead>(async (path) => {
    const value = responses[path.split("?")[0]!];
    if (value === undefined) throw new Error(`Unexpected endpoint ${path}`);
    return { text: JSON.stringify(value), next: false };
  });
  const write = vi.fn<PrWrite>(async () => ({ text: JSON.stringify({ id: 77 }), next: false }));
  return { read, write, client: new HostedPrClient({ id: "00000000-0000-4000-8000-000000000001", label: platform, platform, baseUrl: "https://code.example" }, read, write, query) };
};

it("reads Bitbucket's comments with their nested replies and tasks, an edited one once and a deleted one not at all", async () => {
  const comment = (id: number, text: string, name: string, extra: Record<string, unknown> = {}) => ({ id, text, createdDate: Date.parse("2026-11-12T10:00:00Z") + id, author: { name, displayName: name.toUpperCase() }, ...extra });
  const { client: bb, write } = client("bitbucket-server", { "/rest/api/1.0/projects/org/repos/app/pull-requests/1/activities": { isLastPage: true, values: [
    // Newest first: the edit of 11 is its current state; its older entry is not read again.
    { action: "COMMENTED", commentAction: "EDITED", comment: comment(11, "**P1 · 续期没查吊销**\n\n…\n\n— Paraself 预评审 · 依据 REVIEW.md · P1", "bob", { severity: "BLOCKER", state: "OPEN",
      comments: [comment(12, "**有意为之**：网关查过了。\n\n— Paraself 作者回应", "alice", { comments: [comment(13, "好的", "bob")] })] }), commentAnchor: { path: "src/a.ts", line: 8 } },
    { action: "COMMENTED", commentAction: "ADDED", comment: comment(11, "旧的文字", "bob") },
    { action: "COMMENTED", commentAction: "DELETED", comment: comment(14, "删掉的", "carol") },
    { action: "COMMENTED", comment: comment(15, "整体看着不错", "carol", { severity: "BLOCKER", state: "RESOLVED", threadResolved: true }) },
    { action: "APPROVED" },
  ] } });
  const { threads, more } = await bb.threads("org/app#1");
  expect(more).toBe(false);
  expect(threads).toEqual([
    expect.objectContaining({ id: "11", author: "BOB", login: "bob", path: "src/a.ts", line: 8, task: "open", resolved: null, url: "https://code.example/projects/org/repos/app/pull-requests/1/overview?commentId=11",
      replies: [expect.objectContaining({ id: "12", login: "alice" }), expect.objectContaining({ id: "13", login: "bob", body: "好的" })] }),
    expect.objectContaining({ id: "15", path: null, task: "resolved", resolved: true, replies: [] }),
  ]);
  // A reply goes under the comment it answers.
  expect(await bb.reply("org/app#1", threads[0]!, "**误报**：……")).toBe("77");
  expect(write).toHaveBeenCalledWith("/rest/api/1.0/projects/org/repos/app/pull-requests/1/comments", "POST", { text: "**误报**：……", parent: { id: 11 } });
});

it("threads GitHub's line comments by the one they answer, keeps its conversation's comments each on its own, and reads resolution by GraphQL", async () => {
  const query = vi.fn<PrQuery>(async () => ({ text: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{ databaseId: 21 }] } }] } } } } }), next: false }));
  const { client: gh, write } = client("github", {
    "/repos/org/app/pulls/1/comments": [
      { id: 21, body: "边界没处理", created_at: "2026-11-12T10:00:00Z", path: "src/a.ts", line: 9, user: { login: "bob" } },
      { id: 22, body: "**已修**：加了判断。\n\n— Paraself 作者回应", created_at: "2026-11-12T11:00:00Z", path: "src/a.ts", line: 9, in_reply_to_id: 21, user: { login: "alice" } },
    ],
    "/repos/org/app/issues/1/comments": [{ id: 31, body: "能不能拆小一点？", created_at: "2026-11-12T12:00:00Z", user: { login: "carol" } }],
  }, query);
  const { threads } = await gh.threads("org/app#1");
  expect(threads).toEqual([
    expect.objectContaining({ id: "21", login: "bob", path: "src/a.ts", line: 9, resolved: true, url: "https://code.example/org/app/pull/1#discussion_r21", replies: [expect.objectContaining({ id: "22", login: "alice" })] }),
    expect.objectContaining({ id: "issuecomment-31", path: null, resolved: null, replies: [] }),
  ]);
  // A line comment's thread takes a reply; the conversation has none, so the reply quotes the comment it answers.
  await gh.reply("org/app#1", threads[0]!, "**不处理**：……");
  await gh.reply("org/app#1", threads[1]!, "**转后续**：……");
  expect(write.mock.calls).toEqual([
    ["/repos/org/app/pulls/1/comments/21/replies", "POST", { body: "**不处理**：……" }],
    ["/repos/org/app/issues/1/comments", "POST", { body: "> carol：能不能拆小一点？\n\n**转后续**：……" }],
  ]);
});

it("reads GitLab's discussions without system notes, and replies into the discussion a comment opens", async () => {
  const { client: gl, write } = client("gitlab", { "/projects/org%2Fapp/merge_requests/1/discussions": [
    { id: "d1", notes: [
      { id: 41, body: "这里会空指针", created_at: "2026-11-12T10:00:00Z", author: { username: "bob", name: "Bob" }, position: { new_path: "src/a.ts", new_line: 3 }, resolvable: true, resolved: false },
      { id: 42, body: "changed this line", created_at: "2026-11-12T10:30:00Z", system: true, author: { username: "alice" } },
      { id: 43, body: "看一下", created_at: "2026-11-12T11:00:00Z", author: { username: "alice", name: "Alice" } },
    ] },
    { id: "d2", notes: [{ id: 44, body: "assigned to @alice", created_at: "2026-11-12T09:00:00Z", system: true }] },
  ] });
  const { threads } = await gl.threads("org/app#1");
  expect(threads).toEqual([expect.objectContaining({ id: "41", author: "Bob", login: "bob", path: "src/a.ts", line: 3, resolved: false, discussion: "d1", replies: [expect.objectContaining({ id: "43", login: "alice" })] })]);
  await gl.reply("org/app#1", threads[0]!, "**误报**：……");
  expect(write).toHaveBeenCalledWith("/projects/org%2Fapp/merge_requests/1/discussions/d1/notes", "POST", { body: "**误报**：……" });
});

it("reads a merged PR's team figures on each platform: people's approvals with their times, people's comments, not Paraself's or bots'", async () => {
  const at = (iso: string) => Date.parse(iso);
  const said = (id: number, text: string, name: string) => ({ id, text, createdDate: at("2026-11-12T10:00:00Z") + id, author: { name } });
  const bb = client("bitbucket-server", {
    "/rest/api/1.0/projects/org/repos/app/pull-requests/1": { title: "会话续期", description: "续期改为滑动过期。", createdDate: at("2026-11-10T08:00:00Z"), closedDate: at("2026-11-12T08:00:00Z"), state: "MERGED" },
    "/rest/api/1.0/projects/org/repos/app/pull-requests/1/activities": { isLastPage: true, values: [
      { action: "APPROVED", createdDate: at("2026-11-11T10:00:00Z"), user: { name: "bob" } },
      { action: "APPROVED", createdDate: at("2026-11-10T13:00:00Z"), user: { name: "ci", type: "SERVICE" } },
      { action: "COMMENTED", comment: said(11, "**P2 · 超时写死**\n\n…\n\n— Paraself 预评审 · P2", "bob") },
      { action: "COMMENTED", comment: { ...said(12, "这里为什么要重试？", "carol"), comments: [said(13, "**有意为之**：幂等。\n\n— Paraself 作者回应", "alice"), said(14, "明白了", "carol")] } },
    ] },
  }).client;
  expect(await bb.teamFacts("org/app#1")).toEqual({ title: "会话续期", description: "续期改为滑动过期。", createdAt: "2026-11-10T08:00:00.000Z", mergedAt: "2026-11-12T08:00:00.000Z",
    approvals: [{ login: "bob", at: "2026-11-11T10:00:00.000Z" }], humanComments: 2 });

  const gh = client("github", {
    "/repos/org/app/pulls/2": { title: "Revert \"会话续期\"", body: "Reverts org/app#1", created_at: "2026-11-13T08:00:00Z", merged_at: "2026-11-13T09:00:00Z" },
    "/repos/org/app/pulls/2/reviews": [{ state: "APPROVED", submitted_at: "2026-11-13T08:30:00Z", user: { login: "bob", type: "User" } }, { state: "APPROVED", submitted_at: "2026-11-13T08:10:00Z", user: { login: "helper[bot]", type: "Bot" } }, { state: "COMMENTED", submitted_at: "2026-11-13T08:20:00Z", user: { login: "carol" } }],
    "/repos/org/app/pulls/2/comments": [{ id: 21, body: "回滚原因？", created_at: "2026-11-13T08:05:00Z", user: { login: "carol" } }],
    "/repos/org/app/issues/2/comments": [{ id: 22, body: "CI passed", created_at: "2026-11-13T08:06:00Z", user: { login: "helper[bot]" } }],
  }).client;
  expect(await gh.teamFacts("org/app#2")).toEqual({ title: "Revert \"会话续期\"", description: "Reverts org/app#1", createdAt: "2026-11-13T08:00:00Z", mergedAt: "2026-11-13T09:00:00Z", approvals: [{ login: "bob", at: "2026-11-13T08:30:00Z" }], humanComments: 1 });

  const gl = client("gitlab", {
    "/projects/org%2Fapp/merge_requests/3": { title: "导出时区", created_at: "2026-11-14T08:00:00Z", merged_at: null },
    "/projects/org%2Fapp/merge_requests/3/notes": [{ system: true, body: "approved this merge request", created_at: "2026-11-14T09:00:00Z", author: { username: "bob" } }, { system: true, body: "added 1 commit", created_at: "2026-11-14T08:30:00Z", author: { username: "alice" } }],
    "/projects/org%2Fapp/merge_requests/3/discussions": [{ id: "d1", notes: [{ id: 31, body: "时区要用用户的", created_at: "2026-11-14T08:40:00Z", author: { username: "carol" } }] }],
  }).client;
  expect(await gl.teamFacts("org/app#3")).toEqual({ title: "导出时区", description: "", createdAt: "2026-11-14T08:00:00Z", mergedAt: null, approvals: [{ login: "bob", at: "2026-11-14T09:00:00Z" }], humanComments: 1 });
});
