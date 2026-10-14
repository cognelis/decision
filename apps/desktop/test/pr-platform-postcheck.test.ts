import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HostedPrClient } from "../src/main/pr-platform-client.js";
import type { PrConnection } from "@cognelis/decision-protocol";

/**
 * Bitbucket's inline comment names no commit, so after posting the client re-reads the PR to see whether it moved.
 * Any failure of that read (a 5xx, a timeout) was reported as "the PR has new commits" although nothing moved.
 */
const head = "a".repeat(40), base = "b".repeat(40);
afterEach(() => vi.unstubAllEnvs());

it("Bitbucket: a verification read that merely failed is not reported as the PR having moved", async () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) vi.stubEnv(name, "");
  const repo = (key: string) => ({ slug: "app", project: { key } });
  const pr = { id: 1, title: "PR", description: "", state: "OPEN", version: 3, updatedDate: 0, author: { user: { name: "author" } }, fromRef: { latestCommit: head, displayId: "feature", repository: repo("fork") }, toRef: { latestCommit: base, displayId: "main", repository: repo("org") } };
  let posted = false, gets = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json"); res.setHeader("x-ausername", "alice");
    if (req.method === "GET") {
      gets++;
      // The platform is fine before the post; the read right after it hits a gateway hiccup.
      if (posted && req.url?.endsWith("/pull-requests/1")) { res.writeHead(503); res.end(); return; }
      res.end(JSON.stringify(req.url?.includes("/users/") ? { slug: "alice" } : pr)); return;
    }
    for await (const _ of req) { /* drain */ }
    posted = true; res.statusCode = 201; res.end(JSON.stringify({ id: 9 }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
    const config: PrConnection = { id: randomUUID(), label: "bb", platform: "bitbucket-server", baseUrl: `http://127.0.0.1:${address.port}` };
    const client = HostedPrClient.create(config, "example-token");
    const result = await client.publishComment({ connectionId: config.id, reference: "org/app#1", sourceCommit: head, destinationCommit: base, path: "src/a.ts", side: "new", line: 1, body: "x" });
    expect(posted).toBe(true);
    expect(gets).toBeGreaterThan(2);
    // The comment went out; the PR did not move. The message must not say it did, only that it could not be checked.
    expect(result.message).not.toMatch(/随后有新的提交/u);
    expect(result.message).toContain("没能确认");
  } finally { server.close(); await once(server, "close"); }
});
