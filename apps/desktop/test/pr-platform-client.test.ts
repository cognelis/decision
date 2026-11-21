import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedPrClient, ownsWebLink, prApiBase, PrPlatformError, prWebBase, type PrRead } from "../src/main/pr-platform-client.js";
import { parseReviewDiff } from "../src/main/pr-review-diff.js";
import { PR_REVIEW_MAX_FILES, prConnectionSchema, prDiscussionCommentSchema, prListQuerySchema, type PrConnection } from "@cognelis/decision-protocol";

const head = "a".repeat(40), base = "b".repeat(40);
const connection = (platform: PrConnection["platform"], baseUrl = "https://code.example"): PrConnection => ({ id: randomUUID(), label: platform, platform, baseUrl });
const fixture = (config: PrConnection, responses: Record<string, unknown>) => {
  const requests: string[] = [];
  const read: PrRead = async (path) => {
    requests.push(path);
    const value = responses[path];
    if (value === undefined) throw new Error(`Unexpected endpoint: ${path}`);
    return { text: typeof value === "string" ? value : JSON.stringify(value), next: false };
  };
  return { client: new HostedPrClient(config, read), requests };
};
/** Pages by path, each with what its Link header says (`next`, and the `last` page it names), or the error read instead. */
const paged = (config: PrConnection, pages: Record<string, { value: unknown; next?: boolean; last?: number } | Error>) => {
  const requests: string[] = [];
  const read: PrRead = async (path) => {
    requests.push(path);
    const page = pages[path];
    if (page === undefined) throw new Error(`Unexpected endpoint: ${path}`);
    if (page instanceof Error) throw page;
    return { text: JSON.stringify(page.value), next: page.next ?? false, last: page.last };
  };
  return { client: new HostedPrClient(config, read), requests };
};
const bbRepo = (key: string) => ({ slug: "app", project: { key } });
const bbPr = { id: 12, title: "修正请求", description: "检查", updatedDate: 1_790_000_000_000, author: { user: { displayName: "User" } }, fromRef: { latestCommit: head, repository: bbRepo("~author") }, toRef: { latestCommit: base, repository: bbRepo("AI") } };

describe("existing PR comments", () => {
  it("reads the newest comments on each platform, links each to its page, and skips what it cannot place", async () => {
    const github = fixture(connection("github", "https://github.com"), {
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc": [
        { id: 7, body: "这里超时后没有取消请求。", created_at: "2026-09-27T08:00:00Z", path: "src/a.ts", line: null, original_line: 3, user: { login: "bob" } },
        { unexpected: true },
      ],
      // The conversation numbers its comments apart from the lines': 7 again is another comment, on no line.
      "/repos/org/app/issues/12/comments?per_page=50": [
        { id: 7, body: "超时统一放在请求层，按这个合并。", created_at: "2026-09-27T09:00:00Z", user: { login: "carol" } },
        { id: 8, created_at: "2026-09-27T09:30:00Z", user: null },
      ],
    });
    expect(await github.client.comments("org/app#12")).toEqual([
      { id: "issuecomment-7", url: "https://github.com/org/app/pull/12#issuecomment-7", author: "carol", path: null, line: null, body: "超时统一放在请求层，按这个合并。", createdAt: "2026-09-27T09:00:00Z" },
      { id: "7", url: "https://github.com/org/app/pull/12#discussion_r7", author: "bob", path: "src/a.ts", line: 3, body: "这里超时后没有取消请求。", createdAt: "2026-09-27T08:00:00Z" },
    ]);

    const gitlab = fixture(connection("gitlab", "https://git.example/team"), {
      "/projects/group%2Fsub%2Fapp/merge_requests/7/notes?per_page=50&sort=desc&order_by=created_at": [
        { id: 1, body: "added 1 commit", created_at: "2026-09-27T09:00:00Z", system: true },
        { id: 2, body: "请补测试。", created_at: "2026-09-27T08:00:00Z", system: false, author: { username: "carol" }, position: { new_path: "src/a.ts", new_line: 5 } },
        { id: 3, body: "整体没问题。", created_at: "2026-09-27T07:00:00Z", author: { name: "Dan" } },
      ],
    });
    expect(await gitlab.client.comments("group/sub/app#7")).toEqual([
      { id: "2", url: "https://git.example/team/group/sub/app/-/merge_requests/7#note_2", author: "carol", path: "src/a.ts", line: 5, body: "请补测试。", createdAt: "2026-09-27T08:00:00Z" },
      { id: "3", url: "https://git.example/team/group/sub/app/-/merge_requests/7#note_3", author: "Dan", path: null, line: null, body: "整体没问题。", createdAt: "2026-09-27T07:00:00Z" },
    ]);

    // Newest first: an edit repeats the comment with its current text, a deletion hides every older entry.
    const bitbucket = fixture(connection("bitbucket-server"), {
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50": { values: [
        { action: "APPROVED" },
        { action: "COMMENTED", commentAction: "EDITED", comment: { id: 5, text: "命名再斟酌。", createdDate: Date.UTC(2026, 8, 27), author: { displayName: "Eve" } }, commentAnchor: { path: "a.ts", line: 2 } },
        { action: "COMMENTED", commentAction: "DELETED", comment: { id: 6, text: "说错了。", createdDate: Date.UTC(2026, 8, 26), author: { displayName: "Eve" } } },
        { action: "COMMENTED", commentAction: "ADDED", comment: { id: 6, text: "说错了。", createdDate: Date.UTC(2026, 8, 26), author: { displayName: "Eve" } } },
        { action: "COMMENTED", commentAction: "ADDED", comment: { id: 5, text: "命名斟酌。", createdDate: Date.UTC(2026, 8, 27), author: { displayName: "Eve" } }, commentAnchor: { path: "a.ts", line: 2 } },
      ] },
    });
    expect(await bitbucket.client.comments("AI/app#12")).toEqual([{ id: "5", url: "https://code.example/projects/AI/repos/app/pull-requests/12/overview?commentId=5", author: "Eve", path: "a.ts", line: 2, body: "命名再斟酌。", createdAt: "2026-09-27T00:00:00.000Z" }]);
  });

  it("lists merged PRs as history and reads a long discussion page by page up to a cap", async () => {
    // Pages of 50, as GitHub fills them: 101 line comments, newest first.
    const comment = (id: number) => ({ id, body: `第 ${id} 条`, created_at: new Date(Date.UTC(2026, 8, 1, 0, id)).toISOString(), user: { login: "bob" } });
    const down = (from: number, count: number) => Array.from({ length: count }, (_, index) => from - index);
    const { client: github } = paged(connection("github", "https://github.com"), {
      [`/search/issues?q=${encodeURIComponent("is:pr is:merged reviewed-by:@me")}&sort=updated&order=desc&per_page=30&page=1`]: { value: { incomplete_results: false, total_count: 1, items: [{ number: 12, title: "已合并", repository_url: "https://api.github.com/repos/org/app", user: { login: "author" }, updated_at: "2026-09-01T00:00:00Z" }] } },
      "/repos/org/app/issues/12/comments?per_page=50": { value: [] },
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc": { value: down(101, 50).map(comment), next: true },
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc&page=2": { value: down(51, 50).map(comment), next: true },
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc&page=3": { value: [comment(1)] },
    });
    const ids = (read: { comments: Array<{ id: string }> }) => read.comments.map((item) => Number(item.id));
    expect((await github.list({ connectionId: randomUUID(), filter: "review-requested", state: "merged", page: 1 })).items[0]?.reference).toBe("org/app#12");
    const all = await github.commentPages("org/app#12", 10);
    expect([ids(all), all.more]).toEqual([down(101, 101), false]);
    // A cap leaves older pages unread and says so; the review still reads only the newest page.
    const capped = await github.commentPages("org/app#12", 2);
    expect([ids(capped), capped.more]).toEqual([down(101, 100), true]);
    expect(ids({ comments: await github.comments("org/app#12") })).toEqual(down(101, 50));

    const { client: gitlab } = paged(connection("gitlab", "https://git.example/team"), {
      "/user": { value: { id: 5 } },
      "/merge_requests?scope=all&state=merged&author_id=5&order_by=updated_at&per_page=30&page=1": { value: [] },
    });
    expect((await gitlab.list({ connectionId: randomUUID(), filter: "created", state: "merged", page: 1 })).items).toEqual([]);

    const { client: bitbucket } = paged(connection("bitbucket-server"), {
      "/rest/api/1.0/dashboard/pull-requests?role=REVIEWER&state=MERGED&limit=30&start=0": { value: { values: [bbPr], isLastPage: true } },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50": { value: { values: [{ action: "COMMENTED", comment: { id: 9, text: "后来", createdDate: 2, author: { displayName: "Eve" } } }], isLastPage: false, nextPageStart: 50 } },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50&start=50": { value: { values: [{ action: "COMMENTED", comment: { id: 4, text: "最早", createdDate: 1, author: { displayName: "Eve" } } }], isLastPage: true } },
    });
    expect((await bitbucket.list({ connectionId: randomUUID(), filter: "review-requested", state: "merged", page: 1 })).items[0]?.reference).toBe("AI/app#12");
    expect(await bitbucket.commentPages("AI/app#12", 10)).toMatchObject({ more: false, comments: [{ id: "9", body: "后来" }, { id: "4", body: "最早" }] });
  });

  it("lists Bitbucket replies after the comment opening their thread, and says which comment a GitHub reply answers", async () => {
    const bitbucket = fixture(connection("bitbucket-server"), {
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50": { values: [
        // Replies have no activity of their own: they are inside the comment they answer, nested as they were made.
        { action: "COMMENTED", commentAction: "ADDED", comment: { id: 5, text: "这里为什么不用 bulkWrite？", createdDate: Date.UTC(2026, 9, 1), author: { displayName: "Eve" }, comments: [
          { id: 6, text: "数据量小，逐条更好排查。", createdDate: Date.UTC(2026, 9, 2), author: { displayName: "Dan" }, comments: [{ id: 7, text: "那就保留。", createdDate: Date.UTC(2026, 9, 3), author: { displayName: "Eve" } }] },
          { unexpected: true },
        ] }, commentAnchor: { path: "fix.js", line: 34, fileType: "TO" } },
        { action: "COMMENTED", commentAction: "ADDED", comment: { id: 4, text: "删掉的这行还有调用方。", createdDate: Date.UTC(2026, 8, 30), author: { displayName: "Eve" } }, commentAnchor: { path: "fix.js", line: 3, fileType: "FROM" } },
        { action: "COMMENTED", commentAction: "ADDED", comment: { id: 3, text: "整体可以。", createdDate: Date.UTC(2026, 8, 29), author: { displayName: "Eve" } } },
      ] },
    });
    const placed = (comments: Array<{ id: string; replyTo: string | null; line: number | null; side: string | null }>) => comments.map(({ id, replyTo, line, side }) => ({ id, replyTo, line, side }));
    expect(placed((await bitbucket.client.commentPages("AI/app#12", 10)).comments)).toEqual([
      { id: "5", replyTo: null, line: 34, side: "new" }, { id: "6", replyTo: "5", line: 34, side: "new" }, { id: "7", replyTo: "5", line: 34, side: "new" },
      { id: "4", replyTo: null, line: 3, side: "old" }, { id: "3", replyTo: null, line: null, side: null },
    ]);
    // The review is told of the replies too, in just the fields its snapshot cache keeps.
    expect((await bitbucket.client.comments("AI/app#12"))[1]).toEqual({ id: "6", url: "https://code.example/projects/AI/repos/app/pull-requests/12/overview?commentId=6", author: "Dan", path: "fix.js", line: 34, body: "数据量小，逐条更好排查。", createdAt: "2026-10-02T00:00:00.000Z" });

    const { client } = paged(connection("github", "https://github.com"), {
      "/repos/org/app/issues/12/comments?per_page=50": { value: [] },
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc": { value: [
        { id: 9, body: "好，按这个改。", created_at: "2026-10-02T00:00:00Z", path: "a.ts", line: 4, side: "LEFT", in_reply_to_id: 8, user: { login: "dan" } },
        { id: 8, body: "删掉的这行还有调用方。", created_at: "2026-10-01T00:00:00Z", path: "a.ts", line: 4, side: "LEFT", user: { login: "eve" } },
        // Outdated: no line in the PR as it stands, so none to read code from.
        { id: 7, body: "命名再斟酌。", created_at: "2026-09-30T00:00:00Z", path: "a.ts", line: null, original_line: 2, side: "RIGHT", user: { login: "eve" } },
      ] },
    });
    expect(placed((await client.commentPages("org/app#12", 10)).comments)).toEqual([
      { id: "9", replyTo: "8", line: 4, side: "old" }, { id: "8", replyTo: null, line: 4, side: "old" }, { id: "7", replyTo: null, line: 2, side: null },
    ]);
  });

  it("gives each line comment of a discussion the lines around it, reading the PR once and each file once", async () => {
    const test = fixture(connection("bitbucket-server"), {
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50": { values: [
        { action: "COMMENTED", comment: { id: 3, text: "用 bulkWrite。", createdDate: 3, author: { displayName: "Eve" }, comments: [{ id: 4, text: "好。", createdDate: 4, author: { displayName: "Dan" } }] }, commentAnchor: { path: "fix.js", line: 5, fileType: "TO" } },
        { action: "COMMENTED", comment: { id: 2, text: "第一行。", createdDate: 2, author: { displayName: "Eve" } }, commentAnchor: { path: "fix.js", line: 1, fileType: "TO" } },
        { action: "COMMENTED", comment: { id: 1, text: "删掉的。", createdDate: 1, author: { displayName: "Eve" } }, commentAnchor: { path: "old.js", line: 2, fileType: "FROM" } },
        // A file that cannot be read, a line past the end of the file, a comment on no line, one whose line the PR no
        // longer has (Bitbucket's orphaned anchor): none has code.
        { action: "COMMENTED", comment: { id: 9, text: "文件读不到。", createdDate: 0, author: { displayName: "Eve" } }, commentAnchor: { path: "gone.js", line: 1, fileType: "TO" } },
        { action: "COMMENTED", comment: { id: 8, text: "行号越界。", createdDate: 0, author: { displayName: "Eve" } }, commentAnchor: { path: "old.js", line: 9, fileType: "FROM" } },
        { action: "COMMENTED", comment: { id: 7, text: "整体可以。", createdDate: 0, author: { displayName: "Eve" } } },
        { action: "COMMENTED", comment: { id: 6, text: "这行后来改掉了。", createdDate: 0, author: { displayName: "Eve" } }, commentAnchor: { path: "fix.js", line: 2, fileType: "TO", orphaned: true } },
      ] },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12": bbPr,
      [`/rest/api/1.0/projects/AI/repos/app/raw/fix.js?at=${head}`]: `l1\nl2\nl3\nl4\n${"长".repeat(400)}\nl6\n`,
      [`/rest/api/1.0/projects/AI/repos/app/raw/old.js?at=${base}`]: "o1\no2",
    });
    const { comments } = await test.client.discussion("AI/app#12", 10);
    // The file's last line break ends its last line: no empty line after it is shown.
    const fix = `l1\nl2\nl3\nl4\n${"长".repeat(299)}…\nl6`;
    expect(comments.map(({ id, code }) => [id, code])).toEqual([
      ["3", { kind: "file", side: "new", from: 1, text: fix }], ["4", { kind: "file", side: "new", from: 1, text: fix }],
      ["2", { kind: "file", side: "new", from: 1, text: fix }], ["1", { kind: "file", side: "old", from: 1, text: "o1\no2" }],
      ["9", null], ["8", null], ["7", null], ["6", null],
    ]);
    expect(test.requests.filter((path) => path.includes("/raw/")).sort()).toEqual([
      `/rest/api/1.0/projects/AI/repos/app/raw/fix.js?at=${head}`, `/rest/api/1.0/projects/AI/repos/app/raw/gone.js?at=${head}`, `/rest/api/1.0/projects/AI/repos/app/raw/old.js?at=${base}`,
    ]);
    expect(test.requests.filter((path) => path.endsWith("/pull-requests/12"))).toHaveLength(1);
  });

  // Line n of a file, short or 150 characters wide: 13 of the wide ones fit in about 2,000 characters.
  const numbered = (from: number, to: number, line = (n: number) => `l${n}`) => Array.from({ length: to - from + 1 }, (_, index) => line(from + index)).join("\n");
  const wide = (n: number) => `${String(n).padStart(3, "0")}${"x".repeat(147)}`;
  const wideAdded = (from: number, to: number) => numbered(from, to, (n) => `+${wide(n)}`);

  it("reads the file around a comment no diff came with: ten lines above the first it is on, five below its last, about 2,000 characters in all", async () => {
    const test = fixture(connection("github", "https://github.com"), {
      "/repos/org/app/issues/12/comments?per_page=50": [],
      // GitHub can send a line comment with an empty diff_hunk: its code is read from the file as the PR has it now.
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc": [
        { id: 4, body: "这三行合并。", created_at: "2026-10-04T00:00:00Z", path: "src/a.ts", start_line: 20, original_start_line: 20, start_side: "RIGHT", line: 22, original_line: 22, side: "RIGHT", diff_hunk: "", user: { login: "eve" } },
        { id: 3, body: "文件末尾。", created_at: "2026-10-03T00:00:00Z", path: "src/a.ts", line: 58, original_line: 58, side: "RIGHT", diff_hunk: "", user: { login: "eve" } },
        // Wide lines: one above and one below in turn, while they fit.
        { id: 2, body: "这一行。", created_at: "2026-10-02T00:00:00Z", path: "src/wide.ts", line: 50, original_line: 50, side: "RIGHT", diff_hunk: "", user: { login: "eve" } },
        // A range that alone runs past the room keeps its last lines.
        { id: 1, body: "这一段。", created_at: "2026-10-01T00:00:00Z", path: "src/wide.ts", start_line: 10, original_start_line: 10, start_side: "RIGHT", line: 40, original_line: 40, side: "RIGHT", diff_hunk: "", user: { login: "eve" } },
      ],
      "/repos/org/app/pulls/12": { title: "修正", body: "", head: { sha: head, repo: { full_name: "org/app" } }, base: { sha: base, repo: { full_name: "org/app" } } },
      [`/repos/org/app/contents/src/a.ts?ref=${head}`]: `${numbered(1, 60)}\n`,
      [`/repos/org/app/contents/src/wide.ts?ref=${head}`]: numbered(1, 60, wide),
    });
    expect((await test.client.discussion("org/app#12", 10)).comments.map(({ id, code }) => [id, code])).toEqual([
      ["4", { kind: "file", side: "new", from: 10, text: numbered(10, 27) }],
      ["3", { kind: "file", side: "new", from: 48, text: numbered(48, 60) }],
      ["2", { kind: "file", side: "new", from: 43, text: numbered(43, 55, wide) }],
      ["1", { kind: "file", side: "new", from: 28, text: numbered(28, 40, wide) }],
    ]);

    // Bitbucket says where a comment over several lines starts on each side, or (9.2 and before) only where it starts, on
    // the side of that line's type: a start on the other side (from a removed line to an added one) is no line of this one.
    const bitbucket = fixture(connection("bitbucket-server"), {
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50": { values: [
        { action: "COMMENTED", comment: { id: 3, text: "从删掉的那行起。", createdDate: 3, author: { displayName: "Eve" } }, commentAnchor: { path: "a.js", line: 100, fileType: "TO", multilineMarker: { startLine: 40, startLineType: "REMOVED" } } },
        { action: "COMMENTED", comment: { id: 2, text: "这几行。", createdDate: 2, author: { displayName: "Eve" } }, commentAnchor: { path: "a.js", line: 30, fileType: "FROM", multilineSpan: { srcSpanStart: 26, srcSpanEnd: 30, dstSpanStart: 0, dstSpanEnd: 0 } } },
        { action: "COMMENTED", comment: { id: 1, text: "那几行。", createdDate: 1, author: { displayName: "Eve" } }, commentAnchor: { path: "a.js", line: 22, fileType: "TO", multilineMarker: { startLine: 18, startLineType: "ADDED" } } },
      ] },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12": bbPr,
      [`/rest/api/1.0/projects/AI/repos/app/raw/a.js?at=${head}`]: numbered(1, 120),
      [`/rest/api/1.0/projects/AI/repos/app/raw/a.js?at=${base}`]: numbered(1, 60),
    });
    expect((await bitbucket.client.discussion("AI/app#12", 10)).comments.map(({ id, code }) => [id, code])).toEqual([
      ["3", { kind: "file", side: "new", from: 90, text: numbered(90, 105) }],
      ["2", { kind: "file", side: "old", from: 16, text: numbered(16, 35) }],
      ["1", { kind: "file", side: "new", from: 8, text: numbered(8, 27) }],
    ]);
  });

  // The change a reviewer saw, as unified diff: new lines 10–14 against old 10–12.
  const change = ["@@ -10,6 +10,8 @@ export function run() {", " const a = 1;", "-const b = 2;", "+const b = 3;", "+const c = 4;", " const d = 5;", "+const e = 6;"];

  it("gives a GitHub line comment the diff it was made on: around its line, over the whole of a range, an outdated one's too, without reading files", async () => {
    // 30 wide lines added from line 1: 13 of them fit in about 2,000 characters.
    const added = ["@@ -0,0 +1,30 @@", ...Array.from({ length: 30 }, (_, index) => `+${wide(index + 1)}`)];
    const comment = (id: number, extra: Record<string, unknown>) => ({ id, body: `评论 ${id}`, created_at: `2026-10-0${id}T00:00:00Z`, path: "src/a.ts", side: "RIGHT", user: { login: "eve" }, ...extra });
    const test = fixture(connection("github", "https://github.com"), {
      "/repos/org/app/issues/12/comments?per_page=50": [],
      // GitHub's diff_hunk stops at the comment's last line.
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc": [
        // Moved down six lines by later commits: placed as the change shown with it numbers it.
        comment(7, { line: 20, original_line: 14, diff_hunk: change.join("\n") }),
        comment(6, { line: 14, original_line: 14, diff_hunk: change.join("\n") }),
        comment(5, { start_line: 11, original_start_line: 11, start_side: "RIGHT", line: 13, original_line: 13, diff_hunk: change.slice(0, 6).join("\n") }),
        // Outdated: no line in the PR as it stands, the diff it was made on all the same.
        comment(4, { line: null, original_line: 14, diff_hunk: change.join("\n") }),
        comment(3, { line: 11, original_line: 11, side: "LEFT", diff_hunk: change.slice(0, 3).join("\n") }),
        // A long change keeps what fits nearest the comment's line: above it, all GitHub gives.
        comment(2, { path: "src/b.ts", line: 15, original_line: 15, diff_hunk: added.slice(0, 16).join("\n") }),
      ],
    });
    const { comments: read } = await test.client.discussion("org/app#12", 10);
    expect(read.map(({ id, line }) => [id, line])).toEqual([["7", 14], ["6", 14], ["5", 13], ["4", 14], ["3", 11], ["2", 15]]);
    expect(read.map(({ id, side, code }) => [id, side, code])).toEqual([
      ["7", "new", { kind: "hunk", side: "new", from: 10, text: ["@@ -10,3 +10,5 @@", ...change.slice(1)].join("\n") }],
      ["6", "new", { kind: "hunk", side: "new", from: 10, text: ["@@ -10,3 +10,5 @@", ...change.slice(1)].join("\n") }],
      ["5", "new", { kind: "hunk", side: "new", from: 10, text: ["@@ -10,3 +10,4 @@", ...change.slice(1, 6)].join("\n") }],
      ["4", null, { kind: "hunk", side: "new", from: 10, text: ["@@ -10,3 +10,5 @@", ...change.slice(1)].join("\n") }],
      ["3", "old", { kind: "hunk", side: "old", from: 10, text: ["@@ -10,2 +10,1 @@", ...change.slice(1, 3)].join("\n") }],
      ["2", "new", { kind: "hunk", side: "new", from: 3, text: `@@ -0,0 +3,13 @@\n${wideAdded(3, 15)}` }],
    ]);
    // Every comment had its diff: neither the PR nor a file was read for code.
    expect(test.requests).toEqual(["/repos/org/app/issues/12/comments?per_page=50", "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc"]);
    // What the dialog is sent, through a schema that refuses any key it does not know.
    const { comments } = await test.client.discussion("org/app#12", 10);
    expect(comments.map(({ code }) => prDiscussionCommentSchema.shape.code.safeParse(code).success)).toEqual(comments.map(() => true));
  });

  it("takes a Bitbucket comment's diff from its activity, its replies with it, and reads the file for one whose activity has none to use", async () => {
    // Bitbucket's diff of a comment's file around it: hunks of segments, each of added, removed or context lines.
    const diff = { source: { toString: "a.js" }, destination: { toString: "a.js" }, truncated: false, hunks: [{ sourceLine: 18, sourceSpan: 4, destinationLine: 18, destinationSpan: 5, truncated: false, segments: [
      { type: "CONTEXT", truncated: false, lines: [{ source: 18, destination: 18, line: "function f() {", truncated: false }, { source: 19, destination: 19, line: "  const a = 1;", truncated: false }] },
      { type: "REMOVED", truncated: false, lines: [{ source: 20, destination: 20, line: "  return a;", truncated: false }] },
      { type: "ADDED", truncated: false, lines: [{ source: 21, destination: 20, line: "  const b = 2;", truncated: false }, { source: 21, destination: 21, line: "  return a + b;", truncated: false }] },
      { type: "CONTEXT", truncated: false, lines: [{ source: 21, destination: 22, line: "}", truncated: false }] },
    ] }] };
    const hunk = "@@ -18,4 +18,5 @@\n function f() {\n   const a = 1;\n-  return a;\n+  const b = 2;\n+  return a + b;\n }";
    // 30 wide lines added: a comment on one in the middle keeps it there; one over lines 5 to 15 keeps all of them.
    const widened = { hunks: [{ sourceLine: 0, sourceSpan: 0, destinationLine: 1, destinationSpan: 30, segments: [{ type: "ADDED", lines: Array.from({ length: 30 }, (_, index) => ({ source: 1, destination: index + 1, line: wide(index + 1) })) }] }] };
    // Cut to the lines around the comment, a hunk can keep the whole hunk's header: each line says where it is itself.
    const cut = { hunks: [{ sourceLine: 1, sourceSpan: 60, destinationLine: 1, destinationSpan: 62, segments: [
      { type: "CONTEXT", lines: [{ source: 50, destination: 52, line: "a" }, { source: 51, destination: 53, line: "b" }] },
      { type: "ADDED", lines: [{ source: 52, destination: 54, line: "c" }] },
      { type: "CONTEXT", lines: [{ source: 52, destination: 55, line: "d" }] },
    ] }] };
    const test = fixture(connection("bitbucket-server"), {
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50": { values: [
        { action: "COMMENTED", comment: { id: 9, text: "加的这行。", createdDate: 9, author: { displayName: "Eve" } }, commentAnchor: { path: "d.js", line: 54, lineType: "ADDED", fileType: "TO" }, diff: cut },
        { action: "COMMENTED", comment: { id: 8, text: "这一行。", createdDate: 8, author: { displayName: "Eve" } }, commentAnchor: { path: "c.js", line: 15, lineType: "ADDED", fileType: "TO" }, diff: widened },
        { action: "COMMENTED", comment: { id: 7, text: "这一段。", createdDate: 7, author: { displayName: "Eve" } }, commentAnchor: { path: "c.js", line: 15, lineType: "ADDED", fileType: "TO", multilineSpan: { srcSpanStart: 0, srcSpanEnd: 0, dstSpanStart: 5, dstSpanEnd: 15 } }, diff: widened },
        { action: "COMMENTED", comment: { id: 5, text: "这里用常量。", createdDate: 5, author: { displayName: "Eve" }, comments: [{ id: 6, text: "好。", createdDate: 6, author: { displayName: "Dan" } }] },
          commentAnchor: { path: "a.js", line: 21, lineType: "ADDED", fileType: "TO" }, diff },
        // Orphaned, its line gone from the PR as it stands: the diff it was made on still shows it.
        { action: "COMMENTED", comment: { id: 4, text: "删掉的那行。", createdDate: 4, author: { displayName: "Eve" } }, commentAnchor: { path: "a.js", line: 20, lineType: "REMOVED", fileType: "FROM", orphaned: true }, diff },
        // No diff with it, one of a shape not understood, one without the comment's line: read from the file.
        { action: "COMMENTED", comment: { id: 3, text: "没有 diff。", createdDate: 3, author: { displayName: "Eve" } }, commentAnchor: { path: "b.js", line: 2, fileType: "TO" } },
        { action: "COMMENTED", comment: { id: 2, text: "看不懂的 diff。", createdDate: 2, author: { displayName: "Eve" } }, commentAnchor: { path: "b.js", line: 1, fileType: "TO" }, diff: { hunks: "unexpected" } },
        { action: "COMMENTED", comment: { id: 1, text: "别处的 diff。", createdDate: 1, author: { displayName: "Eve" } }, commentAnchor: { path: "b.js", line: 3, fileType: "TO" }, diff },
      ] },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12": bbPr,
      [`/rest/api/1.0/projects/AI/repos/app/raw/b.js?at=${head}`]: "b1\nb2\nb3",
    });
    expect((await test.client.discussion("AI/app#12", 10)).comments.map(({ id, code }) => [id, code])).toEqual([
      ["9", { kind: "hunk", side: "new", from: 52, text: "@@ -50,3 +52,4 @@\n a\n b\n+c\n d" }],
      ["8", { kind: "hunk", side: "new", from: 9, text: `@@ -0,0 +9,13 @@\n${wideAdded(9, 21)}` }],
      ["7", { kind: "hunk", side: "new", from: 4, text: `@@ -0,0 +4,13 @@\n${wideAdded(4, 16)}` }],
      ["5", { kind: "hunk", side: "new", from: 18, text: hunk }], ["6", { kind: "hunk", side: "new", from: 18, text: hunk }],
      ["4", { kind: "hunk", side: "old", from: 18, text: hunk }],
      ["3", { kind: "file", side: "new", from: 1, text: "b1\nb2\nb3" }], ["2", { kind: "file", side: "new", from: 1, text: "b1\nb2\nb3" }], ["1", { kind: "file", side: "new", from: 1, text: "b1\nb2\nb3" }],
    ]);
    expect(test.requests.filter((path) => path.includes("/raw/"))).toEqual([`/rest/api/1.0/projects/AI/repos/app/raw/b.js?at=${head}`]);
  });

  it("reads each GitLab note's diff from the MR version it was made on, and the file only for a note on the version as it is now", async () => {
    const older = "c".repeat(40);
    const endpoint = "/projects/group%2Fapp/merge_requests/7";
    const at = (head_sha: string, extra: Record<string, unknown>) => ({ base_sha: base, start_sha: base, head_sha, position_type: "text", old_path: "a.js", new_path: "a.js", ...extra });
    const gitlab = connection("gitlab", "https://git.example");
    const responses = {
      [`${endpoint}/notes?per_page=50&sort=desc&order_by=created_at`]: [
        // Over lines 13 and 14 of the version as it is now.
        { id: 5, body: "这两行合并。", created_at: "2026-10-05T00:00:00Z", author: { username: "carol" }, position: at(head, { new_line: 14, old_line: null, line_range: { start: { line_code: "x_0_13", type: "new", old_line: null, new_line: 13 }, end: { line_code: "x_0_14", type: "new", old_line: null, new_line: 14 } } }) },
        // On an earlier push: that version's diff.
        { id: 4, body: "改大写。", created_at: "2026-10-04T00:00:00Z", author: { username: "carol" }, position: at(older, { new_line: 2, old_line: null }) },
        // GitLab gives no diff for a file too large: the file as it is now, the note made on that very version.
        { id: 3, body: "大文件。", created_at: "2026-10-03T00:00:00Z", author: { username: "carol" }, position: at(head, { old_path: "big.js", new_path: "big.js", new_line: 2, old_line: 2 }) },
        // On a version past those read, and without a diff to read, nothing is guessed from the file as it is now.
        { id: 2, body: "很早的版本。", created_at: "2026-10-02T00:00:00Z", author: { username: "carol" }, position: at("d".repeat(40), { old_path: "big.js", new_path: "big.js", new_line: 2, old_line: 2 }) },
        { id: 1, body: "整体可以。", created_at: "2026-10-01T00:00:00Z", author: { username: "carol" } },
      ],
      [`${endpoint}/versions?per_page=100`]: [
        { id: 12, head_commit_sha: head, base_commit_sha: base, start_commit_sha: base, created_at: "2026-10-04T00:00:00Z", merge_request_id: 1, state: "collected", real_size: "2" },
        { id: 11, head_commit_sha: older, base_commit_sha: base, start_commit_sha: base, created_at: "2026-10-01T00:00:00Z", merge_request_id: 1, state: "collected", real_size: "1" },
      ],
      [`${endpoint}/versions/12`]: { id: 12, diffs: [{ old_path: "a.js", new_path: "a.js", diff: `${change.join("\n")}\n`, new_file: false }, { old_path: "big.js", new_path: "big.js", diff: "", too_large: true }] },
      [`${endpoint}/versions/11`]: { id: 11, diffs: [{ old_path: "a.js", new_path: "a.js", diff: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n" }] },
      [endpoint]: { title: "修正", description: "", source_project_id: 5, target_project_id: 4, diff_refs: { head_sha: head, start_sha: base, base_sha: base } },
      [`/projects/5/repository/files/big.js/raw?ref=${head}`]: "g1\ng2\ng3",
    };
    const test = fixture(gitlab, responses);
    const read = async (client: HostedPrClient) => (await client.discussion("group/app#7", 10)).comments.map(({ id, side, code }) => [id, side, code]);
    const expected = [
      ["5", null, { kind: "hunk", side: "new", from: 10, text: ["@@ -10,3 +10,5 @@", ...change.slice(1)].join("\n") }],
      ["4", null, { kind: "hunk", side: "new", from: 1, text: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c" }],
      ["3", null, { kind: "file", side: "new", from: 1, text: "g1\ng2\ng3" }],
      ["2", null, null], ["1", null, null],
    ];
    expect(await read(test.client)).toEqual(expected);
    // The version list once, each version a note was made on once, the file once.
    expect(test.requests.filter((path) => path.includes("/versions") || path.includes("/raw"))).toEqual([
      `${endpoint}/versions?per_page=100`, `${endpoint}/versions/12`, `${endpoint}/versions/11`, `/projects/5/repository/files/big.js/raw?ref=${head}`,
    ]);
    // A version's diff never changes: opened again (each open with a client of its own), none is read a second time.
    const again = fixture(gitlab, responses);
    expect(await read(again.client)).toEqual(expected);
    expect(again.requests.filter((path) => /\/versions\/\d+$/u.test(path))).toEqual([]);
  });

  const github = connection("github", "https://github.com");
  const lines = "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc";
  const talk = "/repos/org/app/issues/12/comments?per_page=50";
  const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 0, minute)).toISOString();
  const said = (id: number) => ({ id, body: `对话 ${id}`, created_at: at(2 * id), user: { login: "carol" } });

  it("reads GitHub's conversation from the last page its Link header names back, and merges it with the line comments newest first", async () => {
    // 120 conversation comments, oldest first 50 a page (the newest 20 on page 3), one every 2 minutes; 30 line comments,
    // newest first, one every 8 minutes in between.
    const conversation = Array.from({ length: 120 }, (_, index) => said(index + 1));
    const line = Array.from({ length: 30 }, (_, index) => ({ id: 30 - index, body: `行内 ${30 - index}`, created_at: at(8 * (30 - index) - 3), path: "src/a.ts", line: 1, user: { login: "bob" } }));
    const { client, requests } = paged(github, {
      [talk]: { value: conversation.slice(0, 50), next: true, last: 3 },
      [`${talk}&page=2`]: { value: conversation.slice(50, 100), next: true, last: 3 },
      [`${talk}&page=3`]: { value: conversation.slice(100) },
      [lines]: { value: line },
    });
    const newestFirst = [...conversation.map((item) => [`issuecomment-${item.id}`, item.created_at]), ...line.map((item) => [String(item.id), item.created_at])]
      .sort((a, b) => b[1]!.localeCompare(a[1]!)).map(([id]) => id);
    const all = await client.commentPages("org/app#12", 10);
    expect([all.comments.map((item) => item.id), all.more]).toEqual([newestFirst, false]);
    expect(all.comments[0]).toEqual({ id: "issuecomment-120", url: "https://github.com/org/app/pull/12#issuecomment-120", author: "carol", path: null, line: null, body: "对话 120", createdAt: at(240), replyTo: null, side: null });
    // The last page, then back; the first, read for its Link header, is not read again.
    expect(requests).toEqual([talk, lines, `${talk}&page=3`, `${talk}&page=2`]);
    // The review's page: the newest 50 of both, which reach into the conversation's page 2, older ones said to be left.
    requests.length = 0;
    const review = await client.commentPages("org/app#12", 1);
    expect([review.comments.map((item) => item.id), review.more]).toEqual([newestFirst.slice(0, 50), true]);
    expect(requests).toEqual([talk, lines, `${talk}&page=3`, `${talk}&page=2`]);
  });

  it("takes a GitHub conversation with no Link header as one page and an empty one as none, and refuses pages it cannot place", async () => {
    // Nothing said in the conversation: the line comments alone.
    const quiet = paged(github, { [talk]: { value: [] }, [lines]: { value: [{ id: 1, body: "行内", created_at: at(1), path: "a.ts", line: 1, user: { login: "bob" } }] } });
    expect(await quiet.client.commentPages("org/app#12", 10)).toMatchObject({ more: false, comments: [{ id: "1", path: "a.ts" }] });
    expect(quiet.requests).toEqual([talk, lines]);
    // GitHub sends no Link header when everything fits on one page: a full page is all there is.
    const full = paged(github, { [talk]: { value: Array.from({ length: 50 }, (_, index) => said(index + 1)) }, [lines]: { value: [] } });
    const read = await full.client.commentPages("org/app#12", 10);
    expect([read.comments.map((item) => item.id), read.more]).toEqual([Array.from({ length: 50 }, (_, index) => `issuecomment-${50 - index}`), false]);
    expect(full.requests).toEqual([talk, lines]);
    // More to follow and no last page named: which comments are the newest cannot be told.
    const unplaced = paged(github, { [talk]: { value: [said(1)], next: true }, [lines]: { value: [] } });
    await expect(unplaced.client.commentPages("org/app#12", 10)).rejects.toThrow(/分页信息缺失/u);
    // Empty pages that keep saying there is more are read no further than the pages asked for and one, and said to be left.
    const endless = paged(github, { [talk]: { value: [] }, ...Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`${lines}${index ? `&page=${index + 1}` : ""}`, { value: [], next: true }])) });
    expect(await endless.client.commentPages("org/app#12", 2)).toEqual({ comments: [], more: true, unparsed: 0 });
    expect(endless.requests).toHaveLength(1 + 3);
  });

  it("fails a GitHub discussion either half of which is refused, and reads no further once cancelled", async () => {
    // A list that looked whole would have been half of it.
    await expect(paged(github, { [talk]: new PrPlatformError(401), [lines]: { value: [] } }).client.commentPages("org/app#12", 10)).rejects.toMatchObject({ status: 401 });
    await expect(paged(github, { [talk]: { value: [] }, [lines]: new PrPlatformError(403) }).client.comments("org/app#12")).rejects.toMatchObject({ status: 403 });
    // Cancelled while the conversation's last page is read: the page before it is never asked for.
    const controller = new AbortController();
    const requests: string[] = [];
    const client = new HostedPrClient(github, async (path) => {
      requests.push(path);
      if (path === `${talk}&page=3`) controller.abort();
      return path === talk ? { text: JSON.stringify([said(1)]), next: true, last: 3 } : { text: JSON.stringify(path === lines ? [] : [said(path.endsWith("3") ? 101 : 51)]), next: false };
    });
    await expect(client.commentPages("org/app#12", 10, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toEqual([talk, lines, `${talk}&page=3`]);
  });

  it("treats a link as the platform's only under that connection's web address", () => {
    expect(prWebBase(connection("github", "https://api.github.com"))).toBe("https://github.com");
    expect(prWebBase(connection("github", "https://git.example/context/api/v3"))).toBe("https://git.example/context");
    expect(prWebBase(connection("gitlab", "https://git.example/team/api/v4/"))).toBe("https://git.example/team");
    expect(prWebBase(connection("bitbucket-server", "https://code.example/rest/api/1.0"))).toBe("https://code.example");
    const gitlab = connection("gitlab", "https://git.example/team");
    expect(ownsWebLink(gitlab, "https://git.example/team/group/app/-/merge_requests/7#note_2")).toBe(true);
    expect(ownsWebLink(gitlab, "https://git.example/teams/app/-/merge_requests/7")).toBe(false);
    expect(ownsWebLink(gitlab, "https://git.example.evil/team/app")).toBe(false);
    expect(ownsWebLink(gitlab, "http://git.example/team/app")).toBe(false);
    // A conversation comment's link opens as a line comment's does.
    expect(ownsWebLink(connection("github", "https://git.example/context/api/v3"), "https://git.example/context/org/app/pull/12#issuecomment-7")).toBe(true);
  });
});

describe("hosting-neutral PR API", () => {
  it("normalizes hosted and enterprise connection bases without accepting embedded credentials", () => {
    expect(prApiBase(connection("github", "https://github.com"))).toBe("https://api.github.com");
    expect(prApiBase(connection("github", "https://git.example/context"))).toBe("https://git.example/context/api/v3");
    expect(prApiBase(connection("gitlab", "https://git.example/context/api/v4/"))).toBe("https://git.example/context/api/v4");
    expect(prConnectionSchema.safeParse(connection("github", "https://" + "user:pass" + "@host")).success).toBe(false);
    expect(prConnectionSchema.safeParse(connection("github", "http://host")).success).toBe(false);
  });

  it("discovers GitHub PRs and reads files from a fork's immutable head", async () => {
    const config = connection("github", "https://github.com");
    const listPath = `/search/issues?q=${encodeURIComponent("is:pr is:open review-requested:@me")}&sort=updated&order=desc&per_page=30&page=1`;
    const test = fixture(config, {
      [listPath]: { incomplete_results: false, total_count: 31, items: [{ number: 12, title: "PR", repository_url: "https://api.github.com/repos/org/app", user: { login: "author" }, updated_at: "2026-09-21T00:00:00Z" }] },
      "/repos/org/app/pulls/12": { title: "PR", body: "description", head: { sha: head, repo: { full_name: "fork/app" } }, base: { sha: base, ref: "main", repo: { full_name: "org/app" } } },
      "/repos/org/app/pulls/12/files?per_page=100": [{ filename: "src/a.ts", status: "modified" }],
      [`/repos/fork/app/contents/src/a.ts?ref=${head}`]: "one\ntwo\nthree",
    });
    expect(await test.client.list({ connectionId: config.id, filter: "review-requested", page: 1 })).toMatchObject({ items: [{ reference: "org/app#12", author: "author" }], nextPage: 2 });
    // The target branch name only scopes review rules.
    expect(await test.client.get("org/app#12")).toMatchObject({ source: { repository: "fork/app", commit: head }, destinationBranch: "main" });
    expect(await test.client.files("org/app#12")).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(await test.client.readFile(await test.client.get("org/app#12"), "src/a.ts", 2)).toBe("two\nthree");
  });

  it("supports GitLab nested groups and source project IDs for forks", async () => {
    const config = connection("gitlab", "https://git.example/team");
    const test = fixture(config, {
      "/user": { id: 5 },
      "/merge_requests?scope=all&state=opened&reviewer_id=5&order_by=updated_at&per_page=30&page=1": [{ iid: 7, web_url: "https://git.example/team/group/sub/app/-/merge_requests/7", title: "MR", author: { name: "User" }, updated_at: "2026-09-21T00:00:00Z" }],
      "/projects/group%2Fsub%2Fapp/merge_requests/7": { title: "MR", description: null, source_project_id: 123, target_project_id: 456, target_branch: "release/1.2", diff_refs: { head_sha: head, start_sha: base, base_sha: base } },
      "/projects/group%2Fsub%2Fapp/merge_requests/7/diffs?per_page=100": [{ new_path: "src/a.ts", deleted_file: false, new_file: true }],
      "/projects/group%2Fsub%2Fapp/merge_requests/7/raw_diffs": "diff text",
      [`/projects/123/repository/files/src%2Fa.ts/raw?ref=${head}`]: "code",
    });
    expect((await test.client.list({ connectionId: config.id, filter: "review-requested", page: 1 })).items[0]?.reference).toBe("group/sub/app#7");
    expect(await test.client.get("group/sub/app#7")).toMatchObject({ source: { repository: "123", commit: head }, destination: { repository: "group/sub/app", commit: base }, destinationBranch: "release/1.2" });
    expect(await test.client.files("group/sub/app#7")).toEqual([{ path: "src/a.ts", status: "added" }]);
    expect(await test.client.diff("group/sub/app#7")).toBe("diff text");
    expect(await test.client.readFile(await test.client.get("group/sub/app#7"), "src/a.ts", 1)).toBe("code");
  });

  it("uses Bitbucket dashboard cursors and preserves personal fork repositories", async () => {
    const config = connection("bitbucket-server");
    const test = fixture(config, {
      "/rest/api/1.0/dashboard/pull-requests?role=AUTHOR&state=OPEN&limit=30&start=30": { values: [bbPr], isLastPage: false, nextPageStart: 60 },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12": bbPr,
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/changes?limit=500": { values: [{ path: { toString: "a.ts" }, type: "MODIFY" }], isLastPage: true },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/diff": "patch",
      [`/rest/api/1.0/projects/AI/repos/app/raw/a.ts?at=${head}`]: "code",
    });
    expect(await test.client.list({ connectionId: config.id, filter: "created", page: 31 })).toMatchObject({ nextPage: 61, items: [{ reference: "AI/app#12" }] });
    // A response without the branch name still reads; only branch-scoped review rules miss it.
    expect(await test.client.get("AI/app#12")).toMatchObject({ source: { repository: "~author/app", commit: head } });
    expect((await test.client.get("AI/app#12")).destinationBranch).toBeUndefined();
    expect(await test.client.files("AI/app#12")).toEqual([{ path: "a.ts", status: "MODIFY" }]);
    expect(await test.client.diff("AI/app#12")).toBe("patch");
    expect(await test.client.readFile(await test.client.get("AI/app#12"), "a.ts", 1)).toBe("code");
  });

  it("counts a Bitbucket PR's comments from the dashboard, none where its properties leave the count out", async () => {
    const config = connection("bitbucket-server");
    const test = fixture(config, {
      "/rest/api/1.0/dashboard/pull-requests?role=REVIEWER&state=OPEN&limit=30&start=0": { values: [
        { ...bbPr, properties: { commentCount: 3 } }, { ...bbPr, id: 13, properties: { openTaskCount: 0 } }, { ...bbPr, id: 14 },
      ], isLastPage: true },
    });
    // Without properties at all nothing is counted, and only the update time tells a PR moved.
    expect((await test.client.list({ connectionId: config.id, filter: "review-requested", page: 1 })).items.map((item) => item.comments)).toEqual([3, 0, undefined]);
  });

  it("reads a Bitbucket PR head from the authorized target repository instead of requiring fork access", async () => {
    const config = connection("bitbucket-server");
    const test = fixture(config, {
      [`/rest/api/1.0/projects/AI/repos/app/raw/a.ts?at=${head}`]: "source at PR head",
    });
    const pr = { title: "PR", source: { repository: "~author/app", commit: head }, destination: { repository: "AI/app", commit: base } };
    expect(await test.client.readFile(pr, "a.ts", 1)).toBe("source at PR head");
    expect(test.requests[0]).toContain(`/projects/AI/repos/app/raw/a.ts?at=${head}`);
  });

  it.each(["github", "gitlab", "bitbucket-server"] as const)("reads complete old and new files at immutable commits on %s", async platform => {
    const config = connection(platform);
    const content = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const oldPath = platform === "github" ? `/repos/AI/app/contents/old.ts?ref=${base}` : platform === "gitlab" ? `/projects/AI%2Fapp/repository/files/old.ts/raw?ref=${base}` : `/rest/api/1.0/projects/AI/repos/app/raw/old.ts?at=${base}`;
    const newPath = platform === "github" ? `/repos/fork/app/contents/new.ts?ref=${head}` : platform === "gitlab" ? `/projects/fork%2Fapp/repository/files/new.ts/raw?ref=${head}` : `/rest/api/1.0/projects/AI/repos/app/raw/new.ts?at=${head}`;
    const test = fixture(config, { [oldPath]: "old file", [newPath]: content });
    const pr = { title: "PR", source: { repository: "fork/app", commit: head }, destination: { repository: "AI/app", commit: base } };
    expect(await test.client.readFileContent(pr, "old.ts", "old")).toBe("old file");
    expect(await test.client.readFileContent(pr, "new.ts", "new")).toBe(content);
    expect((await test.client.readFile(pr, "new.ts", 1)).split("\n")).toHaveLength(80);
    // The page read reuses the file already fetched at that commit.
    expect(test.requests).toEqual([oldPath, newPath]);
    await expect(test.client.readFileContent(pr, "../secret", "new")).rejects.toThrow();
  });

  // The diff's "-" lines are the merge base's: read at the target's tip, which moved on after the PR branched, an old-side
  // line showed other code, and a file the target later deleted could not be read at all.
  it.each(["github", "gitlab", "bitbucket-server"] as const)("reads the old side at the merge base the diff starts from on %s, asked once per commit pair", async platform => {
    const fork = "c".repeat(40);
    const config = connection(platform);
    const responses: Record<string, Record<string, unknown>> = {
      github: {
        "/repos/AI/app/pulls/12": { title: "PR", body: "", head: { sha: head, repo: { full_name: "fork/app" } }, base: { sha: base, ref: "main", repo: { full_name: "AI/app" } } },
        [`/repos/AI/app/compare/${base}...${head}?per_page=1`]: { merge_base_commit: { sha: fork } },
        [`/repos/AI/app/contents/old.ts?ref=${fork}`]: "old at fork point",
      },
      gitlab: {
        "/projects/AI%2Fapp/merge_requests/12": { title: "MR", description: null, source_project_id: 123, target_project_id: 456, diff_refs: { head_sha: head, start_sha: base, base_sha: fork } },
        [`/projects/AI%2Fapp/repository/files/old.ts/raw?ref=${fork}`]: "old at fork point",
      },
      "bitbucket-server": {
        "/rest/api/1.0/projects/AI/repos/app/pull-requests/12": bbPr,
        "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/merge-base": { id: fork, displayId: "ccccccc" },
        [`/rest/api/1.0/projects/AI/repos/app/raw/old.ts?at=${fork}`]: "old at fork point",
      },
    };
    const test = fixture(config, responses[platform]!);
    const pr = await test.client.get("AI/app#12");
    // Pinned to the target's tip as before: the base does not make it another version.
    expect(pr).toMatchObject({ destination: { commit: base }, base: fork });
    expect(await test.client.readFileContent(pr, "old.ts", "old")).toBe("old at fork point");
    await test.client.get("AI/app#12");
    expect(test.requests.filter(path => path.includes("/compare/") || path.endsWith("/merge-base")).length).toBe(platform === "gitlab" ? 0 : 1);
  });

  it("reads the old side at the target's tip where a Bitbucket server has no merge-base endpoint", async () => {
    const test = fixture(connection("bitbucket-server"), {
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12": bbPr,
      [`/rest/api/1.0/projects/AI/repos/app/raw/old.ts?at=${base}`]: "old at tip",
    });
    const pr = await test.client.get("AI/app#12");
    expect(pr.base).toBeUndefined();
    expect(await test.client.readFileContent(pr, "old.ts", "old")).toBe("old at tip");
  });

  it("fetches a file once per commit and forgets a read that failed", async () => {
    let fail = true;
    const read = vi.fn<PrRead>(async () => {
      if (fail) { fail = false; throw new Error("network"); }
      return { text: "content", next: false };
    });
    const client = new HostedPrClient(connection("github"), read);
    const pr = { title: "PR", source: { repository: "fork/app", commit: head }, destination: { repository: "AI/app", commit: base } };
    await expect(client.readFileContent(pr, "a.ts", "new")).rejects.toThrow("network");
    expect(await client.readFileContent(pr, "a.ts", "new")).toBe("content");
    expect(await client.readFile(pr, "a.ts", 1)).toBe("content");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("marks a changed file whose name a review path cannot carry, instead of failing the whole PR", async () => {
    const config = connection("github", "https://github.com");
    const test = fixture(config, {
      "/repos/org/app/pulls/12/files?per_page=100": [
        { filename: "src/a.ts", status: "modified" },
        { filename: "test/fixtures/url?query.txt", status: "added" },
        // Trimmed, it would name another file.
        { filename: " notes.md", status: "added" },
      ],
    });
    expect(await test.client.files("org/app#12")).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "test/fixtures/url?query.txt", status: "added", unsupported: true },
      { path: " notes.md", status: "added", unsupported: true },
    ]);
  });

  it("reads a large PR's files page by page on each platform, up to the 3,000 GitHub itself lists", async () => {
    const paged = (config: PrConnection, pages: Record<string, { value: unknown; next?: boolean }>) => new HostedPrClient(config, async (path) => {
      const page = pages[path];
      if (page === undefined) throw new Error(`Unexpected endpoint: ${path}`);
      return { text: JSON.stringify(page.value), next: page.next ?? false };
    });
    const named = (from: number, count: number) => Array.from({ length: count }, (_, index) => `src/f${from + index}.ts`);
    const github = paged(connection("github", "https://github.com"), {
      "/repos/org/app/pulls/12/files?per_page=100": { value: named(0, 100).map((filename) => ({ filename, status: "modified" })), next: true },
      "/repos/org/app/pulls/12/files?per_page=100&page=2": { value: named(100, 50).map((filename) => ({ filename, status: "added" })) },
    });
    expect((await github.files("org/app#12")).map((file) => file.path)).toEqual(named(0, 150));
    // A file whose diff GitLab cut is listed still; the review names it as not reviewed when the diff has none for it.
    const gitlab = paged(connection("gitlab", "https://git.example"), {
      "/projects/org%2Fapp/merge_requests/7/diffs?per_page=100": { value: named(0, 100).map((new_path) => ({ new_path, deleted_file: false, new_file: false })), next: true },
      "/projects/org%2Fapp/merge_requests/7/diffs?per_page=100&page=2": { value: [{ new_path: "data/big.json", deleted_file: false, new_file: false, too_large: true, collapsed: true }] },
    });
    expect(await gitlab.files("org/app#7")).toHaveLength(101);
    expect((await gitlab.files("org/app#7")).at(-1)).toEqual({ path: "data/big.json", status: "modified" });
    const bitbucket = paged(connection("bitbucket-server"), {
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/changes?limit=500": { value: { values: named(0, 500).map((toString) => ({ path: { toString }, type: "MODIFY" })), isLastPage: false, nextPageStart: 500 } },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/changes?limit=500&start=500": { value: { values: named(500, 20).map((toString) => ({ path: { toString }, type: "ADD" })), isLastPage: true } },
    });
    expect((await bitbucket.files("AI/app#12")).map((file) => file.path)).toEqual(named(0, 520));
    // A cursor that does not move is refused, not read forever; a list that never ends stops at the cap.
    const stuck = paged(connection("bitbucket-server"), { "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/changes?limit=500": { value: { values: [], isLastPage: false, nextPageStart: 0 } } });
    await expect(stuck.files("AI/app#12")).rejects.toThrow(/分页/u);
    const endless = new HostedPrClient(connection("github"), async (path) => ({ next: true,
      text: JSON.stringify(named(Number(/&page=(\d+)/u.exec(path)?.[1] ?? 1) * 100, 100).map((filename) => ({ filename, status: "modified" }))) }));
    expect(await endless.files("org/app#12")).toHaveLength(PR_REVIEW_MAX_FILES);
  });

  it("cuts a diff past its read cap back to whole files, and builds GitHub's from the file list when GitHub gives none", async () => {
    const whole = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
    const asked: unknown[] = [];
    const clipped = new HostedPrClient(connection("bitbucket-server"), async (_path, _accept, _signal, cap) => {
      asked.push(cap);
      return { text: `${whole("a.ts")}${whole("b.ts")}diff --git a/c.ts b/c.ts\n--- a/c.ts\n+++ b/c`, next: false, clipped: true };
    });
    expect(await clipped.diff("AI/app#12")).toBe(`${whole("a.ts")}${whole("b.ts")}`);
    expect(asked).toEqual([{ clip: true }]);
    // Past 300 files or 20,000 lines GitHub answers its diff with 406.
    const requested: string[] = [];
    const github = new HostedPrClient(connection("github", "https://github.com"), async (path) => {
      requested.push(path);
      if (path === "/repos/org/app/pulls/12") throw new PrPlatformError(406);
      if (path !== "/repos/org/app/pulls/12/files?per_page=100") throw new Error(`Unexpected endpoint: ${path}`);
      return { next: false, text: JSON.stringify([
        { filename: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
        { filename: "src/created.ts", status: "added", patch: "@@ -0,0 +1 @@\n+created" },
        { filename: "src/b.ts", status: "renamed", previous_filename: "src/old-b.ts", patch: "@@ -1 +1 @@\n-x\n+y" },
        { filename: "src/gone.ts", status: "removed", patch: "@@ -1 +0,0 @@\n-gone" },
        // Binary, or too large for GitHub to give a patch: no diff, named as not reviewed.
        { filename: "logo.png", status: "added" },
      ]) };
    });
    const built = await github.diff("org/app#12");
    const patches = parseReviewDiff(built);
    expect([...patches.keys()]).toEqual(["src/a.ts", "src/created.ts", "src/b.ts", "src/gone.ts"]);
    expect(patches.get("src/created.ts")).toEqual([{ text: "+created", old: null, new: 1, changed: true }]);
    expect(patches.get("src/gone.ts")).toEqual([{ text: "-gone", old: 1, new: null, changed: true }]);
    // Opened as a review opens it, the file list just read gives the diff: it is not read again.
    requested.length = 0;
    expect(await github.files("org/app#12")).toHaveLength(5);
    expect(await github.diff("org/app#12")).toBe(built);
    expect(requested.filter((path) => path.includes("/files"))).toHaveLength(1);
    // Any other refusal is still the platform's to report.
    const refused = new HostedPrClient(connection("gitlab"), async () => { throw new PrPlatformError(406); });
    await expect(refused.diff("org/app#7")).rejects.toThrow(/406/u);
  });

  it("rejects foreign repository links", async () => {
    const config = connection("github");
    const foreign = new HostedPrClient(config, async () => ({ text: JSON.stringify({ incomplete_results: false, total_count: 1, items: [{ title: "PR", number: 1, repository_url: "https://other.example/repos/org/repo", user: {}, updated_at: "now" }] }), next: false }));
    await expect(foreign.list({ connectionId: config.id, filter: "created", page: 1 })).rejects.toThrow(/不属于/);
  });
});

afterEach(() => vi.unstubAllEnvs());
it("performs authenticated read-only HTTP and refuses redirects before credentials can leave the origin", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const received: Array<{ method: string | undefined; auth: string | undefined }> = [];
  let redirect = false;
  const server = createServer((req, res) => {
    received.push({ method: req.method, auth: req.headers.authorization });
    if (redirect) { res.writeHead(302, { location: "https://other.example/private" }); res.end(); return; }
    // A server before 8.16, without the merge-base endpoint.
    if (req.url?.endsWith("/merge-base")) { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(bbPr));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const client = HostedPrClient.create(connection("bitbucket-server", `http://127.0.0.1:${address.port}`), "example-value");
    await expect(client.get("AI/app#12")).resolves.toMatchObject({ source: { commit: head } });
    redirect = true;
    await expect(client.get("AI/app#12")).rejects.toThrow(/连接失败/);
    // The PR, its merge base, then the PR again: the merge base is asked once per commit pair.
    expect(received).toEqual(Array.from({ length: 3 }, () => ({ method: "GET", auth: "Bearer example-value" })));
  } finally { server.close(); await once(server, "close"); }
});

it("keeps a diff's first 2 MiB, cut back to whole files, and still refuses any other response that large", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const file = (index: number) => `diff --git src://f${index}.ts dst://f${index}.ts\n--- src://f${index}.ts\n+++ dst://f${index}.ts\n@@ -1 +1 @@\n-${"旧".repeat(300)}\n+${"新".repeat(300)}\n`;
  const diff = Array.from({ length: 1_500 }, (_, index) => file(index)).join("");
  expect(Buffer.byteLength(diff)).toBeGreaterThan(2 * 1024 * 1024);
  const server = createServer((req, res) => res.end(req.url?.endsWith("/diff") ? diff : JSON.stringify({ ...bbPr, filler: "x".repeat(3 * 1024 * 1024) })));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const client = HostedPrClient.create(connection("bitbucket-server", `http://127.0.0.1:${(server.address() as AddressInfo).port}`), "example-value");
    const read = await client.diff("AI/app#12");
    expect(Buffer.byteLength(read)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(diff.startsWith(read)).toBe(true);
    // Every file it holds reads whole; those after it are left out, not refused.
    const files = parseReviewDiff(read);
    expect(files.size).toBeGreaterThan(1_000);
    expect(files.size).toBeLessThan(1_500);
    await expect(client.get("AI/app#12")).rejects.toThrow(/2 MiB/u);
  } finally { server.close(); await once(server, "close"); }
});

it("reads a page of PRs past 2 MiB, each with long release notes, and takes Bitbucket's cursor past a thousand", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const page = Array.from({ length: 30 }, (_, index) => ({ iid: index + 1, web_url: `http://127.0.0.1/group/app/-/merge_requests/${index + 1}`, title: `依赖更新 ${index + 1}`, author: { name: "bot" }, updated_at: "2026-10-01T00:00:00Z", description: "说明".repeat(40_000) }));
  let base = "";
  const server = createServer((req, res) => res.end(JSON.stringify(req.url?.startsWith("/api/v4/user") ? { id: 5 } : page.map((item) => ({ ...item, web_url: `${base}${new URL(item.web_url).pathname}` })))));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    expect(JSON.stringify(page).length).toBeGreaterThan(2 * 1024 * 1024);
    const config = connection("gitlab", base);
    // Refused whole as "平台响应超过 2 MiB，请缩小变更范围", the list did not open.
    expect((await HostedPrClient.create(config, "example-value").list({ connectionId: config.id, filter: "review-requested", page: 1 })).items).toHaveLength(30);
  } finally { server.close(); await once(server, "close"); }
  // Bitbucket's cursor is an item offset: the page after the 1,020th merged PR is 1021, refused as a page past 1,000.
  const bitbucket = fixture(connection("bitbucket-server"), {
    "/rest/api/1.0/dashboard/pull-requests?role=REVIEWER&state=MERGED&limit=30&start=1020": { values: [bbPr], isLastPage: false, nextPageStart: 1_050 },
  });
  const further = await bitbucket.client.list(prListQuerySchema.parse({ connectionId: randomUUID(), filter: "review-requested", state: "merged", page: 1_021 }));
  expect(further.nextPage).toBe(1_051);
  expect(prListQuerySchema.parse({ connectionId: randomUUID(), filter: "review-requested", state: "merged", page: further.nextPage }).page).toBe(1_051);
});

it("reads a page of a file list past 2 MiB, as a hundred files' patches run", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const page = Array.from({ length: 100 }, (_, index) => ({ filename: `src/f${index}.ts`, status: "modified", patch: `@@ -1 +1 @@\n-${"o".repeat(15_000)}\n+${"n".repeat(15_000)}` }));
  const server = createServer((_req, res) => res.end(JSON.stringify(page)));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    expect(JSON.stringify(page).length).toBeGreaterThan(2 * 1024 * 1024);
    const client = HostedPrClient.create(connection("github", `http://127.0.0.1:${(server.address() as AddressInfo).port}`), "example-value");
    expect(await client.files("org/app#12")).toHaveLength(100);
  } finally { server.close(); await once(server, "close"); }
});

it("reaches a code platform on this Mac directly, never through the environment's proxy with its token", async () => {
  // A proxy that keeps whatever it is sent: through it, it was handed the platform token in clear text.
  let proxied = "";
  const proxy = createNetServer((socket) => socket.on("data", (chunk) => { proxied += chunk.toString("latin1"); socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); }));
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  for (const name of ["HTTPS_PROXY", "ALL_PROXY", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"]) vi.stubEnv(name, "");
  for (const name of ["HTTP_PROXY", "http_proxy"]) vi.stubEnv(name, `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
  const received: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    received.push(req.headers.authorization);
    if (req.url?.endsWith("/merge-base")) { res.writeHead(404); res.end(); return; }
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify(bbPr));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const client = HostedPrClient.create(connection("bitbucket-server", `http://127.0.0.1:${(server.address() as AddressInfo).port}`), "example-value");
    await expect(client.get("AI/app#12")).resolves.toMatchObject({ source: { commit: head } });
    expect(received).toEqual(["Bearer example-value", "Bearer example-value"]);
    expect(proxied).toBe("");
  } finally {
    server.close(); await once(server, "close");
    proxy.close(); await once(proxy, "close");
  }
});

it("writes only the explicit action to the configured origin and never follows write redirects", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const writes: Array<{ path: string | undefined; auth: string | undefined; body: unknown }> = [];
  let redirect = false;
  let gatewayDown = false;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") { res.end(JSON.stringify({ title: "PR", state: "open", merged: false, head: { sha: head, ref: "feature", repo: { full_name: "fork/app" } }, base: { sha: base, ref: "main", repo: { full_name: "org/app" } } })); return; }
    let body = ""; for await (const part of req) body += part;
    writes.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    if (gatewayDown) { res.writeHead(502); res.end(); return; }
    if (redirect) { res.writeHead(302, { location: "https://other.example/reviews" }); res.end(); return; }
    res.end(JSON.stringify({ state: "APPROVED", commit_id: head }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const config = connection("github", `http://127.0.0.1:${address.port}`);
    const client = HostedPrClient.create(config, "example-write-token");
    const input = { connectionId: config.id, reference: "org/app#1", sourceCommit: head, destinationCommit: base, sourceBranch: "feature", destinationBranch: "main", action: "approve" as const, body: "", mergeMethod: "merge" as const };
    await expect(client.performAction(input)).resolves.toMatchObject({ action: "approve" });
    expect(writes[0]).toEqual({ path: "/api/v3/repos/org/app/pulls/1/reviews", auth: "Bearer example-write-token", body: { commit_id: head, event: "APPROVE" } });
    redirect = true;
    await expect(client.performAction(input)).rejects.toThrow(/操作结果未确认/);
    expect(writes).toHaveLength(2);
    // A gateway's 502 says nothing of whether the platform behind it carried the write out: "retry" could post it twice.
    redirect = false; gatewayDown = true;
    await expect(client.performAction(input)).rejects.toThrow(/操作结果未确认/);
  } finally { server.close(); await once(server, "close"); }
});

it("takes GitHub's 403 for the limit it is when its body says so, and says how long to wait", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  let answer: { headers: Record<string, string>; body: string } = { headers: {}, body: "" };
  const server = createServer((_req, res) => {
    res.writeHead(403, { "content-type": "application/json", ...answer.headers });
    res.end(answer.body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const client = HostedPrClient.create(connection("github", `http://127.0.0.1:${address.port}`), "example-value");
    const refusal = () => client.get("org/app#1").then(() => null, (cause: unknown) => cause as PrPlatformError);
    const exceeded = JSON.stringify({ message: "API rate limit exceeded for user ID 1." });
    // Read by its status alone, it sent the reader to check the account and the token's permissions; told to wait,
    // it kept the platform's seconds to itself.
    answer = { headers: { "x-ratelimit-remaining": "0", "retry-after": "60" }, body: exceeded };
    let error = await refusal();
    expect(error).toBeInstanceOf(PrPlatformError);
    expect(error?.status).toBe(429);
    expect(error?.message).toMatch(/限流.*约 60 秒后重试/u);
    // The primary limit says no retry-after: the wait is read from the reset time.
    answer = { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 120) }, body: exceeded };
    error = await refusal();
    expect(error?.status).toBe(429);
    expect(error?.message).toMatch(/约 1(19|20|21) 秒后重试/u);
    // The window's last request, refused for the token: its remaining count reads 0 too, and it was sent to wait.
    answer = { headers: { "x-ratelimit-remaining": "0" }, body: JSON.stringify({ message: "Resource not accessible by personal access token" }) };
    error = await refusal();
    expect(error?.status).toBe(403);
    expect(error?.message).toMatch(/令牌授权/u);
  } finally { server.close(); await once(server, "close"); }
});

it("takes the last page from GitHub's Link header, and reads a long conversation from there back with its own paths", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const asked: string[] = [];
  let origin = "";
  const server = createServer((req, res) => {
    asked.push(req.url ?? "");
    const url = new URL(req.url ?? "/", origin);
    res.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/pulls/12/comments")) { res.end("[]"); return; }
    // As GitHub answers: every page but the last names the next and the last one, by the repository's number.
    const page = Number(url.searchParams.get("page") ?? 1);
    if (page < 3) res.setHeader("link", `<${origin}/api/v3/repositories/9/issues/12/comments?per_page=50&page=${page + 1}>; rel="next", <${origin}/api/v3/repositories/9/issues/12/comments?per_page=50&page=3>; rel="last"`);
    res.end(JSON.stringify([{ id: page, body: `第 ${page} 页`, created_at: `2026-09-0${page}T00:00:00Z`, user: { login: "carol" } }]));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = HostedPrClient.create(connection("github", origin), "example-value");
    expect((await client.commentPages("org/app#12", 10)).comments.map((item) => item.body)).toEqual(["第 3 页", "第 2 页", "第 1 页"]);
    expect(asked.filter((path) => path.includes("/issues/"))).toEqual(["/api/v3/repos/org/app/issues/12/comments?per_page=50", "/api/v3/repos/org/app/issues/12/comments?per_page=50&page=3", "/api/v3/repos/org/app/issues/12/comments?per_page=50&page=2"]);
  } finally { server.close(); await once(server, "close"); }
});
