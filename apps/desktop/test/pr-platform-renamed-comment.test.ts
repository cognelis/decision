import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HostedPrClient } from "../src/main/pr-platform-client.js";
import { parseReviewDiff } from "../src/main/pr-review-diff.js";
import type { PrConnection } from "@cognelis/decision-protocol";

/**
 * A finding on a renamed file carries the file's NEW name (parseReviewDiff keys files by `+++ b/<new>`).
 * GitLab's diff position contract: `old_path` = "File path before change", `new_path` = "File path after change".
 * Bitbucket Server's anchor: `path` = the file's path, `srcPath` = its path before a move/rename.
 * The client already reads the old name (GitLab `/diffs` `old_path`, the `--- a/<old>` header of every diff) and drops it.
 */
const head = "a".repeat(40), base = "b".repeat(40), mergeBase = "c".repeat(40);
const connection = (platform: PrConnection["platform"], baseUrl: string): PrConnection => ({ id: randomUUID(), label: platform, platform, baseUrl });
afterEach(() => vi.unstubAllEnvs());
const noProxy = () => { for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, ""); };
const renameDiff = "diff --git a/src/old.ts b/src/new.ts\nsimilarity index 90%\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n const b = 1;\n";

const serve = async (platform: PrConnection["platform"], onGet: (url: string) => { type?: string; body: string }) => {
  noProxy();
  const writes: Array<{ url: string | undefined; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      const reply = onGet(req.url ?? "");
      res.setHeader("content-type", reply.type ?? "application/json");
      if (platform === "bitbucket-server") res.setHeader("x-ausername", "alice");
      res.end(reply.body); return;
    }
    let body = ""; for await (const part of req) body += part;
    writes.push({ url: req.url, body: JSON.parse(body) });
    res.setHeader("content-type", "application/json"); res.statusCode = 201;
    res.end(JSON.stringify({ id: platform === "gitlab" ? "d".repeat(40) : 9 }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  const config = connection(platform, `http://127.0.0.1:${address.port}`);
  return { config, writes, client: HostedPrClient.create(config, "example-token"), close: async () => { server.close(); await once(server, "close"); } };
};

it("GitLab: a comment on a renamed file names the file's path before the change as old_path", async () => {
  const mr = { title: "MR", state: "opened", source_branch: "feature", target_branch: "main", source_project_id: 1, target_project_id: 2, diff_refs: { head_sha: head, start_sha: base, base_sha: mergeBase } };
  let listReads = 0;
  const { config, writes, client, close } = await serve("gitlab", (url) =>
    url.endsWith("/raw_diffs") ? { type: "text/plain", body: renameDiff }
      : url.includes("/diffs") ? (listReads++, { body: JSON.stringify([{ old_path: "src/old.ts", new_path: "src/new.ts", renamed_file: true, new_file: false, deleted_file: false }]) })
        : { body: JSON.stringify(mr) });
  try {
    // The review reads the file list and the diff: the rename is in both.
    expect(await client.files("org/app#1")).toEqual([{ path: "src/new.ts", status: "modified" }]);
    const patches = parseReviewDiff(await client.diff("org/app#1"));
    expect([...patches.keys()]).toEqual(["src/new.ts"]);
    // The review's findings land on the new name, on either side.
    const pinned = { connectionId: config.id, reference: "org/app#1", sourceCommit: head, destinationCommit: base };
    await client.publishComment({ ...pinned, path: "src/new.ts", side: "old", line: 1, body: "旧行" });
    await client.publishComment({ ...pinned, path: "src/new.ts", side: "new", line: 1, body: "新行" });
    expect(writes.map((write) => write.body.position)).toEqual([
      expect.objectContaining({ old_path: "src/old.ts", new_path: "src/new.ts", old_line: 1 }),
      expect.objectContaining({ old_path: "src/old.ts", new_path: "src/new.ts", new_line: 1 }),
    ]);
    // The review's own read, then one for both comments: every file's diff is in each page of it.
    expect(listReads).toBe(2);
  } finally { await close(); }
});

it("Bitbucket Server: a comment on a moved file names where it came from as srcPath", async () => {
  const repo = (key: string) => ({ slug: "app", project: { key } });
  const pr = { id: 1, title: "PR", description: "", state: "OPEN", version: 3, updatedDate: 0, author: { user: { name: "author" } }, fromRef: { latestCommit: head, displayId: "feature", repository: repo("fork") }, toRef: { latestCommit: base, displayId: "main", repository: repo("org") } };
  const { config, writes, client, close } = await serve("bitbucket-server", (url) =>
    url.endsWith("/diff") ? { type: "text/plain", body: renameDiff }
      : url.includes("/changes") ? { body: JSON.stringify({ isLastPage: true, values: [{ path: { toString: "src/new.ts" }, srcPath: { toString: "src/old.ts" }, type: "MOVE" }] }) }
        : url.includes("/users/") ? { body: JSON.stringify({ slug: "alice" }) }
          : { body: JSON.stringify(pr) });
  try {
    expect(await client.files("org/app#1")).toEqual([{ path: "src/new.ts", status: "MOVE" }]);
    const pinned = { connectionId: config.id, reference: "org/app#1", sourceCommit: head, destinationCommit: base };
    await client.publishComment({ ...pinned, path: "src/new.ts", side: "old", line: 1, body: "旧行" });
    expect(writes[0]!.body.anchor).toEqual(expect.objectContaining({ path: "src/new.ts", srcPath: "src/old.ts", line: 1, lineType: "REMOVED", fileType: "FROM" }));
  } finally { await close(); }
});
