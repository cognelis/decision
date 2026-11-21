import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { PrReviewFinding, PrReviewReport, PrReviewSnapshot, ReviewBenchmarkStoredCase } from "@cognelis/decision-protocol";

import { ReviewBenchmarkRuns } from "../src/main/review-benchmark-runs.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const git = async (directory: string, ...args: string[]) => (await exec("git", ["-C", directory, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();

/** A repository with a base, a head that brings the problem in at line 5, and a fix that takes it out. */
const repository = async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-benchmark-runs-"));
  roots.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "lab@example.invalid"); await git(root, "config", "user.name", "Lab");
  const lines = (fifth: string) => Array.from({ length: 10 }, (_, index) => (index === 4 ? fifth : `const line${index + 1} = ${index + 1};`)).join("\n") + "\n";
  await writeFile(join(root, "a.ts"), lines("const window = config.window;"));
  await git(root, "add", "."); await git(root, "commit", "-q", "-m", "base");
  const base = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "a.ts"), lines("const window = 30;"));
  await git(root, "commit", "-q", "-am", "head");
  const head = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "a.ts"), lines("const window = config.window ?? 30;"));
  await git(root, "commit", "-q", "-am", "fix");
  const fix = await git(root, "rev-parse", "HEAD");
  return { root, base, head, fix };
};
const stored = (id: string, set: "defect" | "clean", commits: { base: string; head: string; fix: string }): ReviewBenchmarkStoredCase => ({
  id, set, status: "confirmed", split: "holdout", title: set === "defect" ? "续期窗口写死" : "只读字典表", pr: { repository: "org/app", number: set === "defect" ? 7 : 8 },
  headSha: commits.head, targetSha: commits.base, baseSha: commits.base, scope: [], mergedAt: set === "clean" ? "2026-09-01" : null, provenance: [], history: [],
  issues: set === "defect" ? [{ title: "窗口写死", priority: "P2", evidence: "改配置不生效。", fixShas: [commits.fix], tradeoff: false, locations: [{ path: "a.ts", side: "new", startLine: 5, endLine: 5 }] }] : null,
  cleanEvidence: set === "clean" ? "合并超过 60 天。" : null,
  knownFalsePositives: set === "clean" ? [{ finding: "列表要分页", why: "只读小表", location: { path: "a.ts", side: "new", startLine: 2, endLine: 2 } }] : null,
}) as unknown as ReviewBenchmarkStoredCase;
const finding = (line: number, title: string): PrReviewFinding => ({ priority: "P2", title, body: `${title}。`, path: "a.ts", side: "new", line, decisionIndexes: [] }) as PrReviewFinding;

it("replays each confirmed case from the repository, scores it against its answers, and gates the change on the runs before and after", async () => {
  const commits = await repository();
  // As Git names it: the temporary directory's real path.
  const top = await realpath(commits.root);
  const directory = await mkdtemp(join(tmpdir(), "paraself-benchmark-store-"));
  roots.push(directory);
  // The reviewer as the App's: here it finds the window on the head version (near line 5), drops a guess, and on the clean case repeats a known false positive.
  let misses = false;
  const reviewed: string[] = [];
  const runs = new ReviewBenchmarkRuns({
    directory,
    cases: async (path, split) => (path === top && split === "holdout" ? { repository: { id: "repo", project: "org/app" }, cases: [stored("case-defect", "defect", commits), stored("case-clean", "clean", commits)] } : { repository: { id: "repo", project: "org/app" }, cases: [] }),
    models: async () => [{ profileId: "local", label: "本机", kind: "qwen", model: "qwen3", leavesDevice: false }],
    reviewer: (client, onCandidates) => {
      let version = "", title = "";
      return {
        load: async () => { const pr = await client.get(""); version = pr.source.commit; title = pr.title; expect(await client.diff("")).toContain("a.ts"); return { snapshotId: `s-${version}`, risk: null } as unknown as PrReviewSnapshot; },
        run: async () => {
          reviewed.push(`${title}@${version.slice(0, 7)}`);
          if (title === "只读字典表") return { status: "completed", findings: [finding(2, "列表要分页")] } as unknown as PrReviewReport;
          if (version === commits.fix) return { status: "completed", findings: [] } as unknown as PrReviewReport;
          onCandidates([finding(30, "也许要重试")]);
          return { status: "completed", findings: misses ? [] : [finding(6, "窗口写死")] } as unknown as PrReviewReport;
        },
        cancel: () => undefined,
      };
    },
  });
  const until = async (id: string) => { for (let tries = 0; tries < 100; tries++) { const run = await runs.get(id); if (run && run.state !== "running") return run; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error("run did not end"); };

  expect((await runs.start({ repositoryPath: commits.root, label: "基线", split: "dev", fixControl: false })).status).toBe("no_cases");
  // Any directory in the repository names it.
  const first = await runs.start({ repositoryPath: commits.root, label: "基线", split: "holdout", fixControl: true });
  expect(first).toMatchObject({ status: "started", run: { label: "基线", project: "org/app", model: "本机 · qwen3", totals: { total: 2 } } });
  expect((await runs.start({ repositoryPath: commits.root, label: "又一次", split: "holdout", fixControl: false })).status).toBe("busy");
  const baseline = await until(first.run!.id);
  expect(reviewed).toEqual([`续期窗口写死@${commits.head.slice(0, 7)}`, `续期窗口写死@${commits.fix.slice(0, 7)}`, `只读字典表@${commits.head.slice(0, 7)}`]);
  expect(baseline.state).toBe("finished");
  const [defect, clean] = baseline.cases;
  expect(defect).toMatchObject({ state: "done", issues: 1, hit: 1, lost: 0, fixReported: 0 });
  expect(defect!.findings.map((item) => [item.line, item.kept])).toEqual([[6, true], [30, false]]);
  expect(clean).toMatchObject({ state: "done", knownRepeats: 1, findings: [expect.objectContaining({ line: 2, kept: true })] });

  // A holdout's cases stay back, but for its clean findings, which the user judges.
  expect((await runs.result(baseline.id)).cases).toBeNull();
  expect((await runs.result(baseline.id, undefined, true)).cases!.map((item) => item.caseId)).toEqual(["case-clean"]);
  expect(await runs.judge(baseline.id, "case-defect", 0, "harmful")).toBeNull();
  await runs.judge(baseline.id, "case-clean", 0, "harmful");
  expect((await runs.result(baseline.id)).run!.totals.clean).toMatchObject({ findings: 1, harmful: 1, unjudged: 0 });

  // After a change that misses the window: recall down, not to be taken.
  misses = true;
  const second = await runs.start({ repositoryPath: join(commits.root, "."), label: "改了提示", split: "holdout", fixControl: false });
  // A judgment made while the run goes on is kept: the run's own progress does not write over it.
  for (let tries = 0; tries < 100 && !(await runs.get(second.run!.id))?.cases.some((item) => item.caseId === "case-clean" && item.state === "done"); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  await runs.judge(second.run!.id, "case-clean", 0, "noise");
  const after = await until(second.run!.id);
  expect(after.state).toBe("finished");
  expect(after.cases.find((item) => item.caseId === "case-clean")!.judgments).toEqual([{ finding: 0, verdict: "noise" }]);
  const compared = (await runs.result(after.id)).comparison!;
  expect(compared).toMatchObject({ before: baseline.id, after: after.id, sameCases: true, verdict: "reject_recall", said: "召回降了：不要采用。样本少于 20 个，只看计数。" });
  expect(compared.rows.map((row) => [row.metric, row.before, row.after, row.change])).toEqual([["hit", 1, 0, "down"], ["harmful", 1, 0, "down"], ["commentsPerCase", 1, 1, "same"], ["fixReported", 0, null, "unknown"]]);
  expect(await runs.adopt(after.id, "")).toMatchObject({ adopted: { note: "" } });
  expect((await runs.summaries(commits.root)).runs.map((run) => run.label)).toEqual(["改了提示", "基线"]);
});
