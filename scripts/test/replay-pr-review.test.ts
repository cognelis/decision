import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createReplayClient, replayCaseSchema, scoreReplay } from "../replay-pr-review.mjs";

const exec = promisify(execFile);
it("replays immutable Git objects without using dirty files or exposing labels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision-pr-replay-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
  try {
    await git("init", "-q");
    await writeFile(join(directory, "api.ts"), "throw error;\n");
    await writeFile(join(directory, "caller.ts"), "return loadAccount().name;\n");
    await git("add", "."); await git("commit", "-qm", "Initial");
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "api.ts"), "return null;\n");
    await git("commit", "-qam", "Change");
    const head = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "api.ts"), "DIRTY WORK MUST NOT BE READ\n");
    const sample = { version: 1, id: "sample", reference: "org/repo#12", repositoryDirectory: directory,
      pr: { title: "Change API", description: "", base, source: { repository: "org/repo", commit: head }, destination: { repository: "org/repo", commit: base } } };
    const client = await createReplayClient(sample);
    expect(await client.diff()).toContain("+return null;");
    expect(await client.readFileContent(sample.pr, "api.ts", "new")).toBe("return null;\n");
    expect(await client.readFileContent(sample.pr, "api.ts", "old")).toBe("throw error;\n");
    expect(await client.repositoryFiles(sample.pr, "new")).toEqual({ paths: ["api.ts", "caller.ts"], complete: true });
    expect(await client.comments()).toEqual([]);
    expect(replayCaseSchema.safeParse({ ...sample, labels: [{ answer: "null dereference" }] }).success).toBe(false);
    await expect(client.readFileContent(sample.pr, "../api.ts", "new")).rejects.toThrow();
    expect(await git("status", "--porcelain")).toContain("M api.ts");
    // Exercise the real CLI adapter and gateway without sending fixture code to any model service.
    const executable = join(directory, "fake-codex.cjs"), caseFile = join(directory, "case.json"), output = join(directory, "result.json");
    await writeFile(executable, `#!/usr/bin/env node\n(async () => { for await (const chunk of process.stdin) {}\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({actions:[{action:'finish_review',summary:'已检查',findings:[]}]})}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}})); })();\n`, { mode: 0o700 });
    await writeFile(caseFile, JSON.stringify(sample));
    await exec(process.execPath, ["scripts/replay-pr-review.mjs", "run", "--case", caseFile, "--executable", executable, "--output", output], { timeout: 30_000 });
    const result = JSON.parse(await readFile(output, "utf8"));
    expect(result).toMatchObject({ sourceCommit: head, baseCommit: base, candidateObservation: "before-verification", candidates: [], report: { status: "completed", findings: [] } });
    expect(result.implementationFiles).toHaveProperty("apps/desktop/src/main/pr-review-service.ts");
    expect(result.report.warnings.some((warning: string) => warning.includes("仓库规范"))).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 40_000);

it("scores distinct known bugs before and after verification without counting unjudged findings as false positives", () => {
  const a = { path: "api.ts", side: "new", line: 1, title: "a", body: "a" };
  const b = { ...a, title: "b", body: "b" };
  const c = { ...a, title: "c", body: "c" };
  const run = { candidates: [a, b, c], report: { findings: [a, c], status: "completed", usage: { input: 20, output: 5 } }, wallMs: 50 };
  const labels = { issues: [{ id: "one", priority: "P1", evidence: "caller" }, { id: "two", priority: "P2", evidence: "old code" }] };
  const judgments = [{ candidate: 0, verdict: "true_positive", issueIds: ["one"] }, { candidate: 1, verdict: "true_positive", issueIds: ["two"] }];
  expect(scoreReplay(run, labels, judgments)).toMatchObject({ candidateRecall: 1, finalRecall: 0.5, verificationLossRate: 0.5, finalPrecision: 1, unjudgedFindings: 1, missedIssueIds: ["two"] });
  expect(() => scoreReplay(run, labels, [...judgments, judgments[0]])).toThrow("Duplicate");
  expect(() => scoreReplay(run, labels, [{ candidate: 0, verdict: "true_positive", issueIds: ["missing"] }])).toThrow("Invalid");
  expect(scoreReplay({ ...run, candidates: [], report: { ...run.report, findings: [] } }, { issues: [] }, [])).toMatchObject({ candidateRecall: null, finalPrecision: null });
});
