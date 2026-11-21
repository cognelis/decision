import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as storage from "../../packages/storage/src/index.js";
import { DecisionContextService } from "../../apps/desktop/src/main/decision-context-service.js";
import { decisionFixtureSchema, fixtureDecisions, fixtureRules } from "../replay-pr-review.mjs";

// Synthetic notes in the format the App's summarize source reads (the same `files` a context-run seed takes).
const note = (id: string, title: string, chosen: string, extra: string[] = []) => ({
  path: `Decision Journal/summarize/${id}-${title}.md`,
  content: ["---", `id: ${id}`, 'created: "2026-09-01"', 'status: "accepted"', `selected_option: "${chosen}"`, 'project: "repo"', 'tags: ["synthetic"]', "supersedes: []",
    ...(extra.some((line) => line.startsWith("superseded_by")) ? [] : ["superseded_by: null"]), ...extra, "---", `# ${title}`, "", "## 决策", chosen, ""].join("\n"),
});
const fixture = { version: 1, synthetic: true, files: [
  note("D-APPLY", "请求超时释放", "请求超时后必须取消底层调用并释放连接。", ['decision_scope: {"projects":["repo"],"paths":["src"]}']),
  note("D-OLD", "请求超时重试", "请求超时后立即重试三次。", ['superseded_by: "D-APPLY"', 'decision_scope: {"projects":["repo"],"paths":["src"]}']),
  { ...note("D-ELSE", "请求超时上报", "请求超时后上报埋点。"), content: note("D-ELSE", "请求超时上报", "请求超时后上报埋点。").content.replace('project: "repo"', 'project: "mobile"') },
  note("D-OPEN", "请求超时日志", "请求超时要记录日志。"),
] };
const query = { query: "请求超时", project: "repo", taskScope: { files: ["src/request.ts"] }, includeOutOfScope: true, limit: 20 };

it("searches a fixture's decisions with the App's own repository and context service", async () => {
  const decisions = await fixtureDecisions(fixture, { storage, DecisionContextService });
  try {
    const response = await decisions.search(query);
    expect(response.coverage).toBe("complete");
    const byId = Object.fromEntries(response.results.map((record) => [record.id, record]));
    expect(byId["D-APPLY"]?.applicability?.status).toBe("scope_match");
    expect(byId["D-OLD"]?.lifecycleState).toBe("superseded");
    expect(byId["D-ELSE"]?.applicability?.status).toBe("out_of_scope");
    expect(byId["D-OPEN"]?.applicability?.status).toBe("needs_review");
  } finally { await decisions.close(); }
});

it("takes only synthetic fixtures whose files stay in the decision journal", async () => {
  expect(decisionFixtureSchema.safeParse({ ...fixture, synthetic: false }).success).toBe(false);
  await expect(fixtureDecisions({ ...fixture, files: [{ path: "Decision Journal/../x.md", content: "" }] }, { storage, DecisionContextService })).rejects.toThrow("Decision Journal");
  await expect(fixtureDecisions({ ...fixture, files: [{ path: "notes/x.md", content: "" }] }, { storage, DecisionContextService })).rejects.toThrow("Decision Journal");
});

it("matches a rules directory as the App matches its own", async () => {
  const directory = await mkdtemp(join(tmpdir(), "decision-pr-replay-rules-"));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "money.md"), ["---", "applies_to:", '  repo: "^repo$"', "priority: 1", "---", "", "金额一律用整数分。", ""].join("\n"));
    await writeFile(join(directory, "other.md"), ["---", "applies_to:", '  repo: "^other$"', "---", "", "不适用。", ""].join("\n"));
    const matched = await fixtureRules(directory, storage)({ project: "org", repo: "repo", targetBranch: null });
    expect(matched.rules).toEqual([{ id: "money.md", source: "decision" }]);
    expect(matched.instructions).toContain("金额一律用整数分");
    expect(matched.instructions).not.toContain("不适用");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("hands a replay's reviewer the fixture's decisions through search_decisions and records the fixture", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFile } = await import("node:fs/promises");
  const exec = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "decision-pr-replay-decisions-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", directory, "-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args])).stdout.trim();
  try {
    await git("init", "-q");
    await mkdir(join(directory, "src"));
    await writeFile(join(directory, "src/request.ts"), "export const timeout = () => release();\n");
    await git("add", "."); await git("commit", "-qm", "Initial");
    const base = await git("rev-parse", "HEAD");
    await writeFile(join(directory, "src/request.ts"), "export const timeout = () => undefined;\n");
    await git("commit", "-qam", "Change");
    const head = await git("rev-parse", "HEAD");
    const sample = { version: 1, id: "sample", reference: "org/repo#1", repositoryDirectory: directory,
      pr: { title: "Change timeout", description: "", base, source: { repository: "org/repo", commit: head }, destination: { repository: "org/repo", commit: base } } };
    const caseFile = join(directory, "case.json"), fixtureFile = join(directory, "decisions.json"), output = join(directory, "result.json"), claude = join(directory, "fake-claude.cjs");
    await writeFile(caseFile, JSON.stringify(sample));
    await writeFile(fixtureFile, JSON.stringify(fixture));
    // Searches decisions until the search's answer is in what it is sent, then finishes.
    const answer = (actions: unknown) => JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ actions }), usage: { input_tokens: 10, output_tokens: 5 } });
    await writeFile(claude, `#!/usr/bin/env node\n(async () => { let text = ''; for await (const chunk of process.stdin) text += chunk;\nconsole.log(text.includes('D-APPLY') ? ${JSON.stringify(answer([{ action: "finish_review", summary: "已核对决策", findings: [], checked: [] }]))} : ${JSON.stringify(answer([{ action: "search_decisions", query: "请求超时" }]))}); })();\n`, { mode: 0o700 });
    await exec(process.execPath, ["scripts/replay-pr-review.mjs", "run", "--case", caseFile, "--provider", "claude-code", "--executable", claude, "--decisions", fixtureFile, "--output", output], { timeout: 30_000, env: { ...process.env, MODEL_PROXY_URL: "http://127.0.0.1:9" } });
    const result = JSON.parse(await readFile(output, "utf8"));
    expect(result.decisionsFixture.path).toBe(fixtureFile);
    expect(result.report.status).toBe("completed");
    expect(result.report.evidence.map((item: { record: { id: string } }) => item.record.id)).toContain("D-APPLY");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 40_000);
