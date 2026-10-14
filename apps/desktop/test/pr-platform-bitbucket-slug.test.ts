import { afterEach, expect, it } from "vitest";
import { bbPr, fakeBitbucket, head, json, tip } from "./bitbucket-fake.js";

/**
 * actionContext() turns the X-AUSERNAME header (a *username*) into a reviewer slug with GET /rest/api/1.0/users/{name},
 * an endpoint keyed by *slug*. Bitbucket's slug is "a URL-friendly variant of the name" (ApplicationUser#getSlug): for an
 * SSO/LDAP e-mail-style username `zhang.san@corp.example` it is `zhang.san_corp.example`, and the lookup by name 404s.
 * Every write goes through actionContext(), so that 404 fails not only approve / needs-work (which need the slug) but
 * also the general comment, every inline comment and merge, none of which use it — the account cannot post anything.
 */
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const name = "zhang.san@corp.example", slug = "zhang.san_corp.example";

async function serve() {
  const server = await fakeBitbucket(async (req, res) => {
    res.setHeader("x-ausername", name);
    if (req.method === "GET" && req.url.startsWith("/rest/api/1.0/users/")) {
      // Keyed by slug, as Bitbucket's UserResource is; a name that is not a slug is no such user.
      return decodeURIComponent(req.url.slice("/rest/api/1.0/users/".length)) === slug
        ? json(res, { name, slug })
        : json(res, { errors: [{ message: `User ${req.url} does not exist.`, exceptionName: "com.atlassian.bitbucket.user.NoSuchUserException" }] }, 404);
    }
    if (req.method === "GET" && req.url === "/rest/api/1.0/projects/AI/repos/app/pull-requests/1") return json(res, bbPr());
    if (req.method === "POST" && req.url === "/rest/api/1.0/projects/AI/repos/app/pull-requests/1/comments") return json(res, { id: 42, text: "x" }, 201);
    if (req.method === "POST" && req.url === "/rest/api/1.0/projects/AI/repos/app/pull-requests/1/merge") return json(res, { ...bbPr(), state: "MERGED" });
    return json(res, { errors: [{ message: `unexpected ${req.method} ${req.url}` }] }, 500);
  });
  close = server.close;
  return server;
}

it("a Bitbucket account whose username is not its slug can still post a PR comment", async () => {
  const { client, config, seen } = await serve();
  await expect(client.publishGeneralComment({ connectionId: config.id, reference: "AI/app#1", sourceCommit: head, destinationCommit: tip, body: "总结" }))
    .resolves.toMatchObject({ message: expect.any(String) });
  expect(seen.some((entry) => entry.method === "POST")).toBe(true);
});

it("a rate-limited account lookup leaves comments working and only approving out, said as a lookup that did not answer", async () => {
  const server = await fakeBitbucket(async (req, res) => {
    res.setHeader("x-ausername", name);
    if (req.method === "GET" && req.url.startsWith("/rest/api/1.0/users")) return json(res, { errors: [{ message: "Rate limit exceeded" }] }, 429);
    if (req.method === "GET" && req.url === "/rest/api/1.0/projects/AI/repos/app/pull-requests/1") return json(res, bbPr());
    if (req.method === "POST" && req.url === "/rest/api/1.0/projects/AI/repos/app/pull-requests/1/comments") return json(res, { id: 42, text: "x" }, 201);
    return json(res, { errors: [{ message: `unexpected ${req.method} ${req.url}` }] }, 500);
  });
  close = server.close;
  const pinned = { connectionId: server.config.id, reference: "AI/app#1", sourceCommit: head, destinationCommit: tip };
  // Thrown on, a 429 on /users failed the comment, which needs no slug.
  await expect(server.client.publishGeneralComment({ ...pinned, body: "总结" })).resolves.toMatchObject({ message: expect.any(String) });
  await expect(server.client.performAction({ ...pinned, sourceBranch: "feature", destinationBranch: "dev", action: "approve", body: "", mergeMethod: "merge" }))
    .rejects.toThrow(/读取失败或被限流.*无法确认评审人/u);
});

it("a Bitbucket account whose username is not its slug can still merge", async () => {
  const { client, config } = await serve();
  await expect(client.performAction({ connectionId: config.id, reference: "AI/app#1", sourceCommit: head, destinationCommit: tip,
    sourceBranch: "feature", destinationBranch: "dev", action: "merge", body: "", mergeMethod: "merge" })).resolves.toMatchObject({ action: "merge" });
});
