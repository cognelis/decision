import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrConnection } from "@cognelis/decision-protocol";
import { HostedPrClient, type PrCreation, type PrRead, type PrWrite } from "../src/main/pr-platform-client.js";
const input: PrCreation = { sourceRepository: "author/app", destinationRepository: "org/app", sourceBranch: "paraself/review-job-1", destinationBranch: "main", title: "修复😀", description: "说明🧪\n验证未运行", reviewers: ["Tomorrow", "Yuan.Wang"] };
describe("local review platform creation", () => {
  it.each(["github", "gitlab", "bitbucket-server"] as const)("creates %s with the required request and AbortSignal", async platform => {
    const config: PrConnection = { id: randomUUID(), platform, label: platform, baseUrl: "https://code.example" };
    const write = vi.fn<PrWrite>(async () => ({ text: JSON.stringify({ id: 12, number: 12, iid: 12 }), next: false }));
    const client = new HostedPrClient(config, vi.fn(), write), signal = new AbortController().signal;
    const request = { ...input, ...(platform === "gitlab" ? { sourceRepository: input.destinationRepository } : {}) };
    const result = await client.createPullRequest(request, signal);
    expect(result.id).toBe("12");
    const [path, method, body, passedSignal] = write.mock.calls[0]!;
    expect(path).not.toMatch(/\/1$/u); expect(method).toBe("POST"); expect(passedSignal).toBe(signal);
    if (platform === "github") expect(body).toMatchObject({ draft: true, head: `author:${input.sourceBranch}`, base: "main" });
    if (platform === "gitlab") expect(body).toMatchObject({ title: "Draft: 修复😀", source_branch: input.sourceBranch, target_branch: "main" });
    if (platform === "bitbucket-server") expect(body).toMatchObject({ title: "修复", description: "说明\n验证未运行", fromRef: { repository: { project: { key: "author" }, slug: "app" } }, reviewers: [{ user: { name: "Tomorrow" } }, { user: { name: "Yuan.Wang" } }] });
  });
  it("uses a fixed title when removing four-byte characters leaves it empty", async () => {
    const write = vi.fn<PrWrite>(async () => ({ text: '{"id":1}', next: false }));
    const client = new HostedPrClient({ id: randomUUID(), platform: "bitbucket-server", label: "bb", baseUrl: "https://code.example" }, vi.fn(), write);
    await client.createPullRequest({ ...input, title: "😀" });
    expect(write.mock.calls[0]![2].title).toBe("本地审阅修复");
  });
  it.each(["github", "gitlab", "bitbucket-server"] as const)("finds even a closed %s PR by all identities", async platform => {
    const request = { ...input, ...(platform === "gitlab" ? { sourceRepository: input.destinationRepository } : {}) };
    const matching = platform === "github" ? { number: 7, state: "closed", head: { ref: input.sourceBranch, repo: { full_name: input.sourceRepository } }, base: { ref: "main", repo: { full_name: input.destinationRepository } } }
      : platform === "gitlab" ? { iid: 7, state: "merged", source_branch: input.sourceBranch, target_branch: "main", source_project_id: 1, target_project_id: 1 }
      : { id: 7, state: "DECLINED", fromRef: { id: `refs/heads/${input.sourceBranch}`, repository: { project: { key: "author" }, slug: "app" } }, toRef: { id: "refs/heads/main", repository: { project: { key: "org" }, slug: "app" } } };
    const read = vi.fn<PrRead>(async () => ({ text: JSON.stringify(platform === "bitbucket-server" ? { values: [matching], isLastPage: true } : [matching]), next: false }));
    const client = new HostedPrClient({ id: randomUUID(), platform, label: platform, baseUrl: "https://code.example" }, read);
    expect((await client.findPullRequest(request))?.id).toBe("7");
    expect(read.mock.calls[0]![0]).toContain(platform === "bitbucket-server" ? "state=ALL" : "state=all");
  });
  it("rejects unsupported GitLab forks and does not create after an aborted call", async () => {
    const write = vi.fn<PrWrite>();
    const client = new HostedPrClient({ id: randomUUID(), platform: "gitlab", label: "gl", baseUrl: "https://code.example" }, vi.fn(), write);
    await expect(client.createPullRequest(input)).rejects.toThrow("跨 fork");
    const control = new AbortController(); control.abort();
    await expect(client.createPullRequest({ ...input, sourceRepository: input.destinationRepository }, control.signal)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});
