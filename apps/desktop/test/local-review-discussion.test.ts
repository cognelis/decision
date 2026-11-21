import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { localReviewJobSchema, type LocalReviewJob, type ModelProviderProfile, type StructuredGenerationRequest } from "@cognelis/decision-protocol";
import type { AssistantGatewayLike } from "../src/main/decision-assistant-service.js";
import { LocalReviewGit } from "../src/main/local-review-git.js";
import { PiReviewWorker } from "../src/main/local-review-pi-worker.js";
import { LocalReviewAgent, reviewPermissionSettings } from "../src/main/local-review-agent.js";
import { ClaudeReviewWorker } from "../src/main/local-review-claude-worker.js";
import { claudeReviewSettings, type ClaudeReviewRuntime } from "../src/main/local-review-claude-runtime.js";
import { ReviewCommandSandbox } from "../src/main/local-review-command-sandbox.js";
import { buildDiscussionRequest, discussionBudget, discussionOverhead, DiscussionBudgetError, DISCUSSION_BUDGET, validatePlan } from "../src/main/local-review-conversation.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const piProfile: ModelProviderProfile = { version: 1, profileId: "claude", kind: "claude-code-cli", label: "Claude model", enabled: true, priority: 0, timeoutMs: 1000, model: "sonnet", executablePath: "/synthetic/claude" };
const reply = { reply: "只读回答", plan: null };

async function view() {
  const root = await mkdtemp(join(tmpdir(), "discuss-")); roots.push(root);
  for (const name of ["tree", "git"]) await mkdir(join(root, name));
  await mkdir(join(root, "tree/base")); await writeFile(join(root, "tree/base/source.js"), "before\n");
  return { root, copy: { directory: root, tree: join(root, "tree"), git: join(root, "git") } };
}
const request = { system: "SYS", input: "INPUT", viewNotes: "NOTES" };

it("Pi discussion offers only read tools: a write attempt is rejected, nothing changes and no command tool exists", async () => {
  vi.spyOn(ReviewCommandSandbox.prototype, "probe").mockImplementation(async function (this: ReviewCommandSandbox) { this.reason = "unused"; });
  const f = await view(), requests: StructuredGenerationRequest[] = [];
  const values = [{ actions: [{ action: "edit_file", path: "base/source.js", oldText: "before", newText: "after" }] }, { actions: [{ action: "read_file", path: "base/source.js" }] }, { actions: [{ action: "submit_result", result: reply }] }];
  const gateway: AssistantGatewayLike = { listGenerationProfiles: async () => [piProfile], async generate<T>(req: StructuredGenerationRequest, parse: (value: unknown) => T) {
    requests.push(req); const value = values.shift(); if (!value) throw new Error("no fixture"); const parsedOutput = parse(value);
    return { requestId: req.requestId, attemptId: randomUUID(), profileId: "claude", backend: "claude-code-cli", model: "actual", usage: {}, parsedOutput } as never;
  } } as never;
  const answer = await new PiReviewWorker(piProfile, gateway).discuss(f.copy, request).catch((error: Error) => error);
  expect(await readFile(join(f.copy.tree, "base/source.js"), "utf8")).toBe("before\n");
  const schemaText = JSON.stringify(requests[0]!.outputSchema); expect(schemaText).not.toContain('"edit_file"'); expect(schemaText).not.toContain('"write_file"'); expect(schemaText).not.toContain('"run_command"'); expect(schemaText).toContain('"read_file"');
  expect(answer instanceof Error || (answer as { reply: string }).reply === "只读回答").toBe(true);
});
it("Pi discussion answers through submit_result with the shared discussion schema", async () => {
  const f = await view(), values = [{ actions: [{ action: "list_files" }] }, { actions: [{ action: "submit_result", result: { reply: "好的", plan: { targetKind: "new", groupId: null, title: "标题", annotationIds: [], requirements: "要求", expectedChanges: "改动", reason: "理由" } } }] }];
  const gateway = { async generate<T>(req: StructuredGenerationRequest, parse: (value: unknown) => T) { const parsedOutput = parse(values.shift()); return { requestId: req.requestId, attemptId: randomUUID(), profileId: "claude", backend: "claude-code-cli", model: "actual", usage: {}, parsedOutput } as never; } } as unknown as AssistantGatewayLike;
  const answer = await new PiReviewWorker(piProfile, gateway).discuss(f.copy, request);
  expect(answer).toMatchObject({ reply: "好的", plan: { target: { kind: "new", title: "标题" }, requirements: "要求" }, actualModel: "actual" });
});
it("Codex discussion goes through the same invoke path as evaluation with write=false and the read-only permission profile", async () => {
  const agent = new LocalReviewAgent({ ...piProfile, kind: "codex-cli", executablePath: "/synthetic/codex" }), invoke = vi.spyOn(agent as unknown as { invoke(...args: unknown[]): Promise<{ stdout: string }> }, "invoke");
  invoke.mockResolvedValue({ stdout: [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(reply) } }), JSON.stringify({ type: "turn.completed" })].join("\n") });
  const f = await view(); expect(await agent.discuss(f.copy, request)).toMatchObject({ reply: "只读回答", plan: null });
  expect(invoke.mock.calls[0]![3]).toBe(false);
  const settings = reviewPermissionSettings(f.copy, "/synthetic/codex", false).join("\n"); expect(settings).toContain('":workspace_roots"="read"'); expect(settings).toContain("network.enabled=false");
});
it("Claude discussion runs with write=false: Edit/Write denied and the tree not writable", async () => {
  const worker = new ClaudeReviewWorker(piProfile, {}), internals = worker as unknown as { ready(...args: unknown[]): Promise<unknown>; raw(...args: unknown[]): Promise<unknown> };
  vi.spyOn(internals, "ready").mockResolvedValue({}); const raw = vi.spyOn(internals, "raw").mockResolvedValue({ result: reply, model: "actual-sonnet", stdout: "" });
  const f = await view(); expect(await worker.discuss(f.copy, request)).toMatchObject({ reply: "只读回答" });
  expect(raw.mock.calls[0]![3]).toBe(false);
  const runtime = { executable: "/runtime/claude", git: "/runtime/git", home: "/user", configs: [], fingerprint: "x", tools: [] } as unknown as ClaudeReviewRuntime;
  const settings = claudeReviewSettings(f.copy, runtime, "/private/tmp/alias", false); expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Edit", "Write"])); expect(settings.sandbox.filesystem.denyWrite).toContain(f.copy.tree);
});

function job(annotations: number, groups: number, long = 4000): LocalReviewJob {
  const snapshot = { path: "/p", headSha: "a".repeat(40), baseSha: "b".repeat(40), branch: "main", dirty: false, author: { name: "n", email: "e" } };
  const notes = Array.from({ length: annotations }, (_, i) => ({ id: randomUUID(), path: `src/f${i}.ts`, startLine: 1, endLine: 1, side: "new" as const, lineText: "x".repeat(300), body: "意".repeat(long) }));
  return localReviewJobSchema.parse({ worker: "pi", id: randomUUID(), repositoryId: randomUUID(), sessionId: randomUUID(), snapshot, annotations: notes, settings: { worker: "pi", pushRemote: "origin", baseBranch: "main", reviewers: [] }, profile: piProfile, state: "finished", createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", pushUrl: "https://x/y.git", connection: null, prUnavailable: null,
    verdicts: notes.map(a => ({ id: a.id, verdict: "accept", reason: "理".repeat(long) })), originalGroups: null, fallback: null, planVersion: 1, rejectedPrGroupId: null, error: null,
    groups: Array.from({ length: groups }, (_, i) => ({ id: randomUUID(), ordinal: i + 1, title: `组 ${i + 1}`, reason: "因".repeat(long), annotationIds: [notes[i % notes.length]!.id], branch: `b${i}`, state: "pr_opened", retryable: true, attemptId: randomUUID(), intent: null, artifact: { commitOid: "c".repeat(40), changes: [], diff: "", risks: [] }, excludedFiles: [], fix: { changedFiles: [], outcomes: [{ id: notes[i % notes.length]!.id, outcome: "fixed", summary: "总".repeat(long) }], commitTitle: "t", verification: "验".repeat(16000) }, pushObservedSha: "c".repeat(40), pr: { id: "1", url: "https://x/pr/1" }, authorization: null, error: null, cleanupError: null, origin: "evaluation", requirements: "", commits: [] })) });
}
function withMessage(j: LocalReviewJob, body: string, refs: Array<{ kind: "annotation" | "group"; id: string }> = []) {
  j.conversation.messages.push({ id: randomUUID(), seq: j.conversation.nextSeq++, role: "user", createdAt: "2026-11-09T00:00:00.000Z", body, references: refs, turnId: null });
  return j.conversation.messages.at(-1)!.id;
}
const views = [{ name: "base", groupId: null, ordinal: null, commitOid: "a".repeat(40), available: true }];

it("keeps the newest user message whole and compresses the summary level by level within the real budget", () => {
  const small = job(2, 1, 100), id1 = withMessage(small, "最新问题".repeat(500));
  const level0 = buildDiscussionRequest(small, id1, views, 60000, discussionOverhead("codex"));
  expect(level0.stats.summaryLevel).toBe(0); expect(level0.request.input).toContain("最新问题".repeat(500));
  const big = job(50, 16, 600), id2 = withMessage(big, "最新要求".repeat(300), [{ kind: "annotation", id: big.annotations[0]!.id }, { kind: "group", id: big.groups[0]!.id }]);
  const built = buildDiscussionRequest(big, id2, views, 60000, discussionOverhead("codex"));
  expect(built.stats.summaryLevel).toBeGreaterThan(0); expect(built.request.input).toContain("摘要已压缩"); expect(built.request.input).toContain("最新要求".repeat(300)); expect(built.stats.chars).toBeLessThanOrEqual(60000);
  expect(built.stats.excerpts).toBeGreaterThan(0);
});
it("omits old rounds with a marker, at most 12 kept", () => {
  const j = job(1, 1, 50); for (let i = 0; i < 20; i++) { withMessage(j, `问题 ${i}`); j.conversation.messages.push({ id: randomUUID(), seq: j.conversation.nextSeq++, role: "worker", createdAt: "2026-11-09T00:00:00.000Z", body: `回答 ${i}`, references: [], turnId: null }); }
  const built = buildDiscussionRequest(j, withMessage(j, "现在"), views, 60000, discussionOverhead("codex"));
  expect(built.stats.omittedTurns).toBe(8); expect(built.request.input).toContain("已省略较早的 8 轮对话（共 20 轮）"); expect(built.request.input).toContain("回答 19"); expect(built.request.input).not.toContain("回答 0\n");
});
it("fails before any model call when a Pi local profile cannot hold the minimum context, and never trims the latest message", () => {
  const j = job(50, 16, 600), id = withMessage(j, "不能丢的最新要求".repeat(900));
  expect(discussionBudget("pi", piProfile)).toBe(DISCUSSION_BUDGET.default);
  expect(() => buildDiscussionRequest(j, id, views, DISCUSSION_BUDGET.piLocal, discussionOverhead("pi"))).toThrow(DiscussionBudgetError);
});
it("redacts groups that hit the secret scan and never serializes network or credential data", () => {
  const j = job(1, 1, 50); j.groups[0]!.artifact!.secretFindings = [{ path: "a.ts", line: 3 }]; j.groups[0]!.fix!.verification = "SECRET-VERIFY";
  (j as unknown as { network: unknown }).network = { url: "u", credentialHelpers: ["helper-secret"], sshCommand: null, directory: "/d" };
  const built = buildDiscussionRequest(j, withMessage(j, "q", [{ kind: "group", id: j.groups[0]!.id }]), views, 60000, 0);
  expect(built.request.input).not.toContain("SECRET-VERIFY"); expect(built.request.input).not.toContain("helper-secret"); expect(built.request.input).toContain("已隐藏");
});
it("validates plans: unknown group or annotation, empty plan and the 17th group are not executable", () => {
  const j = job(1, 1, 50), plan = { target: { kind: "existing" as const, groupId: j.groups[0]!.id }, annotationIds: [j.annotations[0]!.id], requirements: "", expectedChanges: "x", reason: "y" };
  expect(validatePlan(j, plan)).toMatchObject({ executable: true, planBaseOid: "c".repeat(40) });
  expect(validatePlan(j, { ...plan, annotationIds: [randomUUID()] }).executable).toBe(false);
  expect(validatePlan(j, { ...plan, annotationIds: [] }).invalidReason).toContain("没有意见也没有要求");
  expect(validatePlan(j, { ...plan, target: { kind: "existing", groupId: randomUUID() } }).invalidReason).toContain("不存在");
  const full = job(1, 16, 50); expect(validatePlan(full, { ...plan, target: { kind: "new", title: "新" } }).executable).toBe(false);
  j.groups[0]!.state = "failed"; expect(validatePlan(j, plan).executable).toBe(false);
});

it("writes read views from raw object bytes: no smudge filter, eol conversion or driver runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "view-raw-")); roots.push(root);
  const environment = { HOME: root, PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, repo = join(root, "repo"), marker = join(root, "driver-ran");
  const git = (...args: string[]) => execFileSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: environment, encoding: "utf8" }).trim();
  await mkdir(repo); git("init", "-b", "main", "--template="); git("config", "user.name", "T"); git("config", "user.email", "t@example.invalid");
  git("config", "filter.test.smudge", `sh -c 'touch ${marker}; echo PLAINTEXT-SECRET'`); git("config", "filter.test.clean", "cat"); git("config", "core.autocrlf", "true");
  await writeFile(join(repo, ".gitattributes"), "secret.bin filter=test\ntext.txt text eol=crlf\n*.sub export-subst\n"); await writeFile(join(repo, "secret.bin"), "CIPHERTEXT\n"); await writeFile(join(repo, "text.txt"), "line\n"); await writeFile(join(repo, "bin.dat"), Buffer.from([0, 255, 10, 13, 10, 1]));
  await mkdir(join(repo, "dir")); await writeFile(join(repo, "dir/x.sub"), "$Format:%H$\n");
  git("-c", "filter.test.smudge=cat", "add", "."); git("commit", "-m", "fixture"); await rm(marker, { force: true });
  const head = git("rev-parse", "HEAD"), view = join(root, "view");
  await new LocalReviewGit("/usr/bin/git", environment).checkoutView(join(repo, ".git"), head, view);
  expect(await readFile(join(view, "secret.bin"), "utf8")).toBe("CIPHERTEXT\n"); expect(await readFile(join(view, "text.txt"), "utf8")).toBe("line\n");
  expect([...await readFile(join(view, "bin.dat"))]).toEqual([0, 255, 10, 13, 10, 1]); expect(await readFile(join(view, "dir/x.sub"), "utf8")).toBe("$Format:%H$\n");
  await expect(readFile(marker)).rejects.toThrow();
});
