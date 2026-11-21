import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { REVIEW_BENCHMARK_VERSION, reviewBenchmarkRecordRequestSchema, reviewBenchmarkUpdateRequestSchema, type ReviewBenchmarkStoredCase } from "@cognelis/decision-protocol";
import { expect, it } from "vitest";

import { ReviewBenchmarkService } from "../../apps/desktop/src/main/review-benchmark-service.js";
import { BENCHMARK_RATE_MINIMUM, benchmarkReplayFiles, replayCaseSchema, scoreBenchmark, scoreReplay } from "../replay-pr-review.mjs";

const exec = promisify(execFile);
const sha = (digit: string) => digit.repeat(40);

it("turns a case into what the replay reads: the answer apart, a tradeoff not scored", () => {
  const item = {
    id: "case-0123456789ab", set: "defect", status: "confirmed", split: "dev", title: "Change the API", pr: null,
    headSha: sha("a"), targetSha: sha("b"), baseSha: sha("c"), scope: ["api.ts"], mergedAt: null,
    provenance: [{ kind: "fix_commit", reference: sha("d") }],
    issues: [
      { title: "返回 null", priority: "P1", evidence: "修复提交改回返回值。", fixShas: [sha("d")], tradeoff: false, locations: [{ path: "api.ts", side: "new", startLine: 1, endLine: 2 }] },
      { title: "没有分页", priority: "P3", evidence: "作者说表很小。", fixShas: [], tradeoff: true, locations: [{ path: "api.ts", side: "new", startLine: 3, endLine: 3 }] },
    ],
    cleanEvidence: null, knownFalsePositives: null, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z", history: [],
  } satisfies ReviewBenchmarkStoredCase;
  const files = benchmarkReplayFiles(item, { repositoryDirectory: "/work/repo", project: "my repo", index: 2 });
  expect(files.sample).toEqual({
    version: 1, id: item.id, reference: "benchmark/my-repo#3", repositoryDirectory: "/work/repo", paths: ["api.ts"],
    pr: { title: "Change the API", description: "", source: { repository: "benchmark/my-repo", commit: sha("a") }, destination: { repository: "benchmark/my-repo", commit: sha("b") }, base: sha("c") },
  });
  expect(files.labels).toEqual({ issues: [{ id: "I1", priority: "P1", evidence: "返回 null（api.ts:1-2）：修复提交改回返回值。" }] });
  expect(files.tradeoffs).toEqual([item.issues[1]]);
  expect(files.manifest).toEqual({ id: item.id, set: "defect", reference: "benchmark/my-repo#3", issues: [{ id: "I1", locations: item.issues[0]!.locations, fixShas: [sha("d")] }] });
  expect(JSON.stringify(files.sample)).not.toContain("返回 null");
});

it("exports the confirmed dev cases from the App's data, and the holdout split only when asked", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-benchmark-export-"));
  try {
    const repository = join(root, "repo");
    const environment = {
      ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    };
    const git = async (...args: string[]) => (await exec("git", ["-C", repository, ...args], { env: environment })).stdout.trim();
    await exec("git", ["init", "-q", "-b", "main", repository], { env: environment });
    await git("remote", "add", "origin", "https://example.test/demo/export.git");
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    for (const file of [...files, "api.ts"]) await writeFile(join(repository, file), "one\n");
    await git("add", ".");
    await git("commit", "-qm", "Initial");
    const target = await git("rev-parse", "HEAD");
    for (const file of [...files, "api.ts"]) await writeFile(join(repository, file), "one\ntwo\n");
    await git("commit", "-qam", "Change");
    const head = await git("rev-parse", "HEAD");
    await writeFile(join(repository, "api.ts"), "one\nthree\n");
    await git("commit", "-qam", "Fix");
    const fix = await git("rev-parse", "HEAD");

    // Recorded and confirmed as an agent would, through the App's own service, into a data folder of the test's own.
    const userData = join(root, "user-data");
    const service = new ReviewBenchmarkService(join(userData, "review-benchmark"));
    const recorded = await service.record(reviewBenchmarkRecordRequestSchema.parse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "codex", repositoryPath: repository, cases: [
      { set: "defect", title: "Change", headSha: head, targetSha: target, provenance: [{ kind: "fix_commit", reference: fix }],
        issues: [{ title: "第二行写错", priority: "P2", evidence: "修复提交改了这一行。", fixShas: [fix], locations: [{ path: "api.ts", startLine: 2, endLine: 2 }] }] },
      ...files.map((file) => ({ set: "clean", title: "Change", headSha: head, targetSha: target, scope: [file], provenance: [{ kind: "sampling", reference: file }], mergedAt: "2026-02-01", cleanEvidence: "没有回滚。",
        knownFalsePositives: [{ finding: "缺少测试", why: "这是配置改动" }] })),
    ] }));
    for (const item of recorded.cases) {
      await service.update(reviewBenchmarkUpdateRequestSchema.parse({ reviewBenchmarkVersion: REVIEW_BENCHMARK_VERSION, sourceClient: "codex", repositoryPath: repository, caseId: item.caseId, expectedStatus: "candidate", status: "confirmed", userConfirmation: "都核对过了。" }));
    }
    const ids = (split: string) => recorded.cases.filter((item) => item.split === split).map((item) => item.caseId).sort();
    expect(ids("dev").length).toBeGreaterThan(0);
    expect(ids("holdout").length).toBeGreaterThan(0);

    const run = (...args: string[]) => exec(process.execPath, ["scripts/replay-pr-review.mjs", "export-benchmark", "--repository", repository, ...args], { timeout: 60_000, env: { ...process.env, PARASELF_USER_DATA: userData } });
    const output = join(root, "export");
    await run("--output", output);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, split: "dev", set: null, repository: { project: "repo" } });
    expect(manifest.cases.map((item: { id: string }) => item.id).sort()).toEqual(ids("dev"));
    for (const item of manifest.cases) {
      const sample = replayCaseSchema.parse(JSON.parse(await readFile(join(output, item.id, "case.json"), "utf8")));
      expect(sample.pr.source.commit).toBe(head);
      const labels = JSON.parse(await readFile(join(output, item.id, "labels.json"), "utf8"));
      expect(labels.issues).toHaveLength(item.set === "defect" ? 1 : 0);
      expect((await readdir(join(output, item.id))).sort()).toEqual(item.set === "defect" ? ["case.json", "labels.json"] : ["case.json", "known-false-positives.json", "labels.json"]);
    }
    await expect(run("--output", output)).rejects.toThrow("Output already exists");

    const held = join(root, "holdout");
    await run("--output", held, "--split", "holdout");
    expect(JSON.parse(await readFile(join(held, "manifest.json"), "utf8")).cases.map((item: { id: string }) => item.id).sort()).toEqual(ids("holdout"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

const finding = (title: string) => ({ path: "api.ts", side: "new", line: 1, title, body: title });
const replayRun = (candidates: string[], final: string[]) => ({
  candidates: candidates.map(finding), report: { status: "completed", findings: final.map(finding), usage: null }, wallMs: 1,
});

it("scores each set as the design reads it: issues caught in the defect set, what comments would do in the clean set", () => {
  const defect = scoreReplay(replayRun(["a", "b"], ["a"]), { issues: [{ id: "I1", priority: "P1", evidence: "x" }] },
    [{ candidate: 0, verdict: "true_positive", issueIds: ["I1"] }, { candidate: 1, verdict: "false_positive", issueIds: [], impact: "noise" }]);
  const clean = scoreReplay(replayRun(["c", "d"], ["c", "d"]), { issues: [] },
    [{ candidate: 0, verdict: "false_positive", issueIds: [], impact: "harmful", knownFalsePositive: 1 }, { candidate: 1, verdict: "true_positive", issueIds: [] }]);
  expect(clean).toMatchObject({ finalComments: 2, finalHarmful: 1, finalNoise: 0, finalValid: 1, knownFalsePositiveRepeats: [1] });
  expect(() => scoreReplay(replayRun(["c"], ["c"]), { issues: [] }, [{ candidate: 0, verdict: "true_positive", issueIds: [], impact: "harmful" }])).toThrow("Only a false positive");

  // Few cases: counts, never rates.
  const few = scoreBenchmark([{ set: "defect", score: defect }, { set: "clean", score: clean }]);
  expect(few.defect).toMatchObject({ scored: 1, knownIssues: 1, candidateCaught: 1, finalCaught: 1, finalRecall: null });
  expect(few.clean).toMatchObject({ scored: 1, finalComments: 2, harmful: 1, valid: 1, harmfulPer10: null, knownFalsePositiveRepeats: 1 });
  const many = scoreBenchmark(Array.from({ length: BENCHMARK_RATE_MINIMUM }, () => ({ set: "clean", score: clean })));
  expect(many.clean).toMatchObject({ scored: 20, harmful: 20, harmfulPer10: 10, commentsPerCase: 2 });
});

it("sums an exported benchmark's runs and judgments by set, and says which cases are not run or judged yet", async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-benchmark-score-"));
  try {
    const write = async (path: string, value: unknown) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), JSON.stringify(value));
    };
    await write("manifest.json", { version: 1, split: "dev", repository: { id: `repo:${"1".repeat(64)}`, project: "demo" }, cases: [{ id: "case-a", set: "defect" }, { id: "case-b", set: "clean" }, { id: "case-c", set: "clean" }] });
    await write("case-a/labels.json", { issues: [{ id: "I1", priority: "P1", evidence: "x" }] });
    await write("case-a/run.json", replayRun(["a"], ["a"]));
    await write("case-a/judgments.json", [{ candidate: 0, verdict: "true_positive", issueIds: ["I1"] }]);
    await write("case-b/labels.json", { issues: [] });
    await write("case-b/run.json", replayRun(["c"], ["c"]));
    await write("case-b/judgments.json", [{ candidate: 0, verdict: "false_positive", issueIds: [], impact: "harmful" }]);
    await write("case-c/labels.json", { issues: [] });
    await write("case-c/run.json", replayRun([], []));
    const { stdout } = await exec(process.execPath, ["scripts/replay-pr-review.mjs", "score-benchmark", "--directory", root, "--output", join(root, "summary.json")], { timeout: 30_000 });
    const printed = JSON.parse(stdout);
    expect(printed.defect).toMatchObject({ scored: 1, finalCaught: 1 });
    expect(printed.clean).toMatchObject({ scored: 1, harmful: 1 });
    expect(printed.missing).toEqual([{ id: "case-c", run: true, judgments: false }]);
    expect(JSON.parse(await readFile(join(root, "summary.json"), "utf8")).cases.map((item: { id: string }) => item.id)).toEqual(["case-a", "case-b"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
