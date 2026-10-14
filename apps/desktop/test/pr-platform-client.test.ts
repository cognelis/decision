import { createServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedPrClient, ownsWebLink, prApiBase, PrPlatformError, prWebBase, type PrRead } from "../src/main/pr-platform-client.js";
import { parseReviewDiff } from "../src/main/pr-review-diff.js";
import { PR_REVIEW_MAX_FILES, prConnectionSchema, prListQuerySchema, type PrConnection } from "@cognelis/decision-protocol";

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
const bbRepo = (key: string) => ({ slug: "app", project: { key } });
const bbPr = { id: 12, title: "修正请求", description: "检查", updatedDate: 1_790_000_000_000, author: { user: { displayName: "User" } }, fromRef: { latestCommit: head, repository: bbRepo("~author") }, toRef: { latestCommit: base, repository: bbRepo("AI") } };

describe("existing PR comments", () => {
  it("reads the newest review comments on each platform, links each to its page, and skips what it cannot place", async () => {
    const github = fixture(connection("github", "https://github.com"), {
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc": [
        { id: 7, body: "这里超时后没有取消请求。", created_at: "2026-09-27T08:00:00Z", path: "src/a.ts", line: null, original_line: 3, user: { login: "bob" } },
        { unexpected: true },
      ],
    });
    expect(await github.client.comments("org/app#12")).toEqual([{ id: "7", url: "https://github.com/org/app/pull/12#discussion_r7", author: "bob", path: "src/a.ts", line: 3, body: "这里超时后没有取消请求。", createdAt: "2026-09-27T08:00:00Z" }]);

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
    const paged = (config: PrConnection, pages: Record<string, { value: unknown; next?: boolean }>) => {
      const read: PrRead = async (path) => {
        const page = pages[path];
        if (page === undefined) throw new Error(`Unexpected endpoint: ${path}`);
        return { text: JSON.stringify(page.value), next: page.next ?? false };
      };
      return new HostedPrClient(config, read);
    };
    const comment = (id: number) => ({ id, body: `第 ${id} 条`, created_at: "2026-09-01T00:00:00Z", user: { login: "bob" } });
    const github = paged(connection("github", "https://github.com"), {
      [`/search/issues?q=${encodeURIComponent("is:pr is:merged reviewed-by:@me")}&sort=updated&order=desc&per_page=30&page=1`]: { value: { incomplete_results: false, total_count: 1, items: [{ number: 12, title: "已合并", repository_url: "https://api.github.com/repos/org/app", user: { login: "author" }, updated_at: "2026-09-01T00:00:00Z" }] } },
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc": { value: [comment(3)], next: true },
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc&page=2": { value: [comment(2)], next: true },
      "/repos/org/app/pulls/12/comments?per_page=50&sort=created&direction=desc&page=3": { value: [comment(1)] },
    });
    expect((await github.list({ connectionId: randomUUID(), filter: "review-requested", state: "merged", page: 1 })).items[0]?.reference).toBe("org/app#12");
    expect(await github.commentPages("org/app#12", 10)).toMatchObject({ more: false, comments: [{ id: "3" }, { id: "2" }, { id: "1" }] });
    // A cap leaves older pages unread and says so; the review still reads only the newest page.
    expect(await github.commentPages("org/app#12", 2)).toMatchObject({ more: true, comments: [{ id: "3" }, { id: "2" }] });
    expect((await github.comments("org/app#12")).map((item) => item.id)).toEqual(["3"]);

    const gitlab = paged(connection("gitlab", "https://git.example/team"), {
      "/user": { value: { id: 5 } },
      "/merge_requests?scope=all&state=merged&author_id=5&order_by=updated_at&per_page=30&page=1": { value: [] },
    });
    expect((await gitlab.list({ connectionId: randomUUID(), filter: "created", state: "merged", page: 1 })).items).toEqual([]);

    const bitbucket = paged(connection("bitbucket-server"), {
      "/rest/api/1.0/dashboard/pull-requests?role=REVIEWER&state=MERGED&limit=30&start=0": { value: { values: [bbPr], isLastPage: true } },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50": { value: { values: [{ action: "COMMENTED", comment: { id: 9, text: "后来", createdDate: 2, author: { displayName: "Eve" } } }], isLastPage: false, nextPageStart: 50 } },
      "/rest/api/1.0/projects/AI/repos/app/pull-requests/12/activities?limit=50&start=50": { value: { values: [{ action: "COMMENTED", comment: { id: 4, text: "最早", createdDate: 1, author: { displayName: "Eve" } } }], isLastPage: true } },
    });
    expect((await bitbucket.list({ connectionId: randomUUID(), filter: "review-requested", state: "merged", page: 1 })).items[0]?.reference).toBe("AI/app#12");
    expect(await bitbucket.commentPages("AI/app#12", 10)).toMatchObject({ more: false, comments: [{ id: "9", body: "后来" }, { id: "4", body: "最早" }] });
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
