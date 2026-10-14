import { afterEach, expect, it } from "vitest";
import { bbPr, fakeBitbucket, head, json, tip } from "./bitbucket-fake.js";

/**
 * Bitbucket Server answers a merge its merge checks refuse (too few approvals, a failing build, conflicts) with
 * HTTP 409 and the reasons in `errors[].vetoes`. The client drops the body and maps every 409 to
 * "PR 版本或状态已变化（HTTP 409），请刷新后重新确认" — the reader refreshes, nothing changed, the same 409 comes back,
 * and the actual reason ("needs 2 approvals") is never shown.
 */
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

it("a vetoed Bitbucket merge says why, not that the PR version changed", async () => {
  const server = await fakeBitbucket(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/rest/api/1.0/users/")) return json(res, { slug: "alice", name: "alice" });
    if (req.method === "GET" && req.url === "/rest/api/1.0/projects/AI/repos/app/pull-requests/1") return json(res, bbPr());
    if (req.method === "POST" && req.url.startsWith("/rest/api/1.0/projects/AI/repos/app/pull-requests/1/merge")) {
      return json(res, { errors: [{ context: null, message: "Merging the pull request has been vetoed.", exceptionName: "com.atlassian.bitbucket.pull.PullRequestMergeVetoedException", conflicted: false,
        vetoes: [{ summaryMessage: "Not all required reviewers have approved yet", detailedMessage: "At least 2 approvals are needed before this pull request can be merged." }] }] }, 409);
    }
    return json(res, { errors: [{ message: `unexpected ${req.method} ${req.url}` }] }, 500);
  });
  close = server.close;
  const error = await server.client.performAction({ connectionId: server.config.id, reference: "AI/app#1", sourceCommit: head, destinationCommit: tip,
    sourceBranch: "feature", destinationBranch: "dev", action: "merge", body: "", mergeMethod: "merge" }).then(() => null, (cause: unknown) => cause as Error);
  expect(error).toBeInstanceOf(Error);
  // Current code: "PR 版本或状态已变化（HTTP 409），请刷新后重新确认。" — the version did not change (3 == 3).
  expect(error!.message).not.toContain("版本或状态已变化");
  expect(error!.message).toMatch(/approv|批准|合并检查|veto/iu);
});
