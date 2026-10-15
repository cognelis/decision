import { describe, expect, it, vi } from "vitest";
import { HostedPrClient, PrPlatformError, type PrDetails, type PrReviewClient } from "../src/main/pr-platform-client.js";
import { readReviewSource, sourceEvidenceContext } from "../src/main/pr-review-source.js";
import { harness, pr } from "./pr-review-run-fakes.js";

const base = "c".repeat(40);
const pinned: PrDetails = { ...pr, base };
const signal = () => new AbortController().signal;
const client = (paths: string[], content = "useAccount();"): PrReviewClient => ({
  get: vi.fn(), files: vi.fn(), diff: vi.fn(), readFile: vi.fn().mockResolvedValue(content),
  readFileContent: vi.fn().mockResolvedValue(content), repositoryFiles: vi.fn().mockResolvedValue({ paths, complete: true }),
});

describe("fixed-revision repository inventory", () => {
  it.each(["github", "gitlab", "bitbucket-server"] as const)("lists %s at the PR source and merge base, including files outside the diff", async (platform) => {
    const calls: string[] = [];
    const hosted = new HostedPrClient({ id: "00000000-0000-4000-8000-000000000001", label: "test", platform, baseUrl: "https://code.example" }, async (path) => {
      calls.push(path);
      const file = { path: "src/caller.ts", type: "blob", mode: "100644" };
      return { text: JSON.stringify(platform === "github" ? { tree: [file, { ...file, path: "link", mode: "120000" }], truncated: false }
        : platform === "gitlab" ? [file] : { values: [file.path], isLastPage: true }), next: false };
    });
    expect(await hosted.repositoryFiles(pinned, "new")).toEqual({ paths: ["src/caller.ts"], complete: true });
    expect(await hosted.repositoryFiles(pinned, "old")).toEqual({ paths: ["src/caller.ts"], complete: true });
    await hosted.repositoryFiles(pinned, "new");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain(pr.source.commit);
    expect(calls[1]).toContain(base);
    expect(calls[1]).not.toContain(pr.destination.commit);
    if (platform === "bitbucket-server") expect(calls.every((path) => path.startsWith("/rest/api/1.0/projects/AI/repos/app/files?"))).toBe(true);
    else expect(calls[0]).toContain(platform === "github" ? "/repos/~author/app/" : "/projects/~author%2Fapp/");
  });

  it("follows server pagination and does not call a truncated inventory complete", async () => {
    const calls: string[] = [];
    const hosted = new HostedPrClient({ id: "00000000-0000-4000-8000-000000000001", label: "test", platform: "bitbucket-server", baseUrl: "https://code.example" }, async (path) => {
      calls.push(path);
      return { text: JSON.stringify(path.endsWith("start=0") ? { values: ["a.ts"], isLastPage: false, nextPageStart: 7 }
        : { values: ["b.ts", "../invalid"], isLastPage: true }), next: false };
    });
    expect(await hosted.repositoryFiles(pinned, "new")).toEqual({ paths: ["a.ts", "b.ts"], complete: false });
    expect(calls[1]).toContain("start=7");
  });
});

describe("source investigation", () => {
  it("searches unmodified callers literally and preserves scope, revision and continuation", async () => {
    const paths = Array.from({ length: 65 }, (_, i) => `src/module/${String(i).padStart(2, "0")}.ts`);
    const source = client([...paths, "src/module2/no.ts", "src/module/package-lock.json"]);
    vi.mocked(source.readFileContent).mockImplementation(async (_pr, path) => path.endsWith("64.ts") ? "// caller\nloadAccount(id).name;\nreturn true;" : "no match");
    const first = await readReviewSource(source, pinned, { action: "search_code", query: "loadAccount(", path: "src/module" }, signal());
    expect(first.result).toMatchObject({ complete: false, nextOffset: 60, totalFiles: 65, matches: [] });
    const second = await readReviewSource(source, pinned, { action: "search_code", query: "loadAccount(", path: "src/module", offset: 60 }, signal());
    expect(second.result).toMatchObject({ complete: true, nextOffset: null });
    expect(second.evidence).toEqual([{ path: paths[64], side: "new", commit: pr.source.commit, startLine: 1, text: "// caller\nloadAccount(id).name;\nreturn true;", truncated: false }]);
    expect(vi.mocked(source.readFileContent).mock.calls.every((call) => call[1].startsWith("src/module/") && call[1].endsWith(".ts"))).toBe(true);
  });

  it("reads old code and larger ranges, rejects traversal and propagates authorization failures", async () => {
    const source = client(["a.ts"], "one\ntwo\nthree\nfour");
    const read = await readReviewSource(source, pinned, { action: "read_file", path: "a.ts", side: "old", startLine: 2, endLine: 3 }, signal());
    expect(read.evidence[0]).toMatchObject({ side: "old", commit: base, startLine: 2, text: "two\nthree" });
    expect(source.readFileContent).toHaveBeenCalledWith(pinned, "a.ts", "old", expect.any(AbortSignal));
    await expect(readReviewSource(source, pinned, { action: "read_file", path: "../a.ts" }, signal())).rejects.toThrow();
    await expect(readReviewSource(source, pinned, { action: "read_file", path: "a.ts", startLine: 2, endLine: 402 }, signal())).rejects.toThrow();
    vi.mocked(source.readFileContent).mockRejectedValue(new PrPlatformError(403));
    await expect(readReviewSource(source, pinned, { action: "search_code", query: "one" }, signal())).rejects.toThrow("权限");
  });

  it("distinguishes unavailable search and unread files from no matches, and bounds escaped evidence", async () => {
    const source = client(["a.ts"]);
    delete source.repositoryFiles;
    expect((await readReviewSource(source, pinned, { action: "search_code", query: "q" }, signal())).result).toMatchObject({ available: false, complete: false });
    source.repositoryFiles = async () => ({ paths: ["a.ts"], complete: true });
    vi.mocked(source.readFileContent).mockRejectedValue(new Error("offline"));
    expect((await readReviewSource(source, pinned, { action: "search_code", query: "q" }, signal())).result).toMatchObject({ complete: false, unread: [{ path: "a.ts", reason: "offline" }] });
    const context = sourceEvidenceContext([{ path: "a.ts", side: "new", commit: pr.source.commit, startLine: 1, text: '"\\'.repeat(10_000), truncated: false }], 800);
    expect(JSON.stringify(context.sourceEvidence).length).toBeLessThanOrEqual(800);
    expect(context.sourceEvidence[0]?.truncated).toBe(true);
  });
});

it("carries actual caller evidence into verification and lets the verifier read the old behavior", async () => {
  const finding = { path: "src/account.ts", side: "new", line: 1, title: "返回 null 让调用方崩溃", body: "loadAccount 失败时返回 null，caller 未检查就取 name。", priority: "P2", decisionIndexes: [] };
  const diff = "diff --git a/src/account.ts b/src/account.ts\n--- a/src/account.ts\n+++ b/src/account.ts\n@@ -1 +1 @@\n-throw error;\n+return null;\n";
  let review = 0, verify = 0;
  const observed: unknown[] = [];
  const test = harness(["src/account.ts"], diff, (request) => {
    if (!request.promptVersion.startsWith("pr-review-verify")) return [
      { action: "search_code", query: "loadAccount", path: "src" },
      { action: "read_file", path: "src/caller.ts", startLine: 1 },
      { action: "finish_review", summary: "调用方没有空值保护", findings: [finding] },
    ][review++];
    const prompt = JSON.parse(request.userPrompt);
    expect(prompt.sourceEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/caller.ts", commit: pr.source.commit, text: expect.stringContaining("account.name") })]));
    if (!verify++) return { verdicts: [], reads: null, sourceReads: [{ action: "read_file", path: "src/account.ts", side: "old", startLine: 1, endLine: 3, query: null, offset: null }] };
    expect(prompt.sourceEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/account.ts", side: "old", text: "throw error;" })]));
    return { verdicts: [{ id: 1, score: 95, reason: "旧版抛异常，新版返回空值，调用方没有防护。" }] };
  }, { onCandidates: (items) => observed.push(items) });
  test.client.repositoryFiles = async () => ({ paths: ["src/account.ts", "src/caller.ts"], complete: true });
  vi.mocked(test.client.readFile).mockResolvedValue("const account = loadAccount(id);\nreturn account.name;");
  vi.mocked(test.client.readFileContent).mockImplementation(async (_pr, path, side) => {
    if (/AGENTS|CLAUDE/u.test(path)) throw new PrPlatformError(404);
    return path === "src/caller.ts" ? "const account = loadAccount(id);\nreturn account.name;" : side === "old" ? "throw error;" : "return null;";
  });
  const report = await test.run({ profileId: "remote" });
  expect(observed).toEqual([[finding]]);
  expect(report.findings).toEqual([finding]);
  expect(report.warnings.some((warning) => warning.includes("没能完成核验"))).toBe(false);
});
