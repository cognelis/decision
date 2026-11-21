// Acceptance of paraself-review / paraself-memory on a built candidate. Two gated entries, neither run by default:
//  PARASELF_REVIEW_PREFLIGHT=1  no model, no client: the isolated App, the guard, and every tool called once as the skill calls it.
//  PARASELF_LIVE_REVIEW_SKILLS=1  the real Claude Code / Codex sessions (only after the driver review lets them run).
// Inputs (all required, none has a default that could reach the user's real data):
//  PARASELF_REVIEW_APP / PARASELF_REVIEW_BRIDGE  the built candidate (never /Applications)   PARASELF_REVIEW_HOLDOUT  the frozen set
//  PARASELF_REVIEW_OUT  an empty-to-be directory outside /tmp and /var      PARASELF_REVIEW_TOOLS_PIN  digest of the reviewed definitions
//  live only: MODEL_PROXY_URL (existing proxy, never written to a file)  PARASELF_REVIEW_SKILLS (dir with claude/ and agents/ copies)
//  PARASELF_REVIEW_MODELS=claude:<model>,codex:<model>  PARASELF_REVIEW_CASES=nl,explicit  PARASELF_CLAUDE_EXECUTABLE / PARASELF_CODEX_EXECUTABLE
// Contract with the lab modules (review-skills-lab.mjs, review-skills-guard.mjs): docs/review-skills-lab.md, runner section
// (R1–R7 here, L1–L5 there). A helper of L1–L4 not there yet stops the run; nothing falls back to a weaker check.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { SKILL_FINGERPRINTS, bundledSkillFingerprints } from "@cognelis/decision-integrations";
import { ManagedChildProcessRunner, ManagedProcessError } from "../../apps/desktop/src/main/model/cli/managed-child-process.js";
import { minimalClientEnvironment } from "../../apps/desktop/src/main/model/cli/cli-adapter-support.js";
// @ts-expect-error Lab modules are executable ESM.
import { startIsolatedApp, connectMcp, ISOLATION_KEYS, CODEX_TOOLS_OFF, writeCodexCatalog } from "./isolated-app.mjs";
// @ts-expect-error Lab modules are executable ESM.
import * as lab from "./review-skills-lab.mjs";
// @ts-expect-error Lab modules are executable ESM.
import { guardArgs } from "./review-skills-guard.mjs";

const need = (name: string): string => { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; };
const NOTE = "Notes/评审纪要/订单队列 2026Q3 总结.md";
const FORBIDDEN_APP = /^(?:\/Applications\/|.*\/Library\/Application Support\/)/u;
const SKILL = "paraself-review";
// S1: the product takes a repository's project from its folder name, and the frozen scenario's decisions are filed under this one.
const PROJECT = "orbit-queue";
// Two of the frozen decisions (named in the runner contract, not read here): the current lease rule and the one it superseded.
const CURRENT_ID = "OQ-LEASE-NEW", SUPERSEDED_ID = "OQ-LEASE-OLD";
const home = homedir();
// R4: what an ordinary client session does not touch, so a change is ours: the user's skills and the integration config
// Paraself would edit. Session logs and state (~/.claude.json, ~/.codex/sessions, …) are rewritten by any session: not compared.
const STRICT = [".agents/skills", ".claude/skills", ".codex/skills", ".codex/config.toml", ".codex/hooks.json", ".claude/settings.json"].map((path) => join(home, path));
// Each stop marker the guard may leave: LEAK (a result it would not pass), GUARD_FAULT (its own), REFUSED (a call's arguments, L4).
const MARKERS = ["LEAK", "GUARD_FAULT", "REFUSED"];
const flags = (root: string) => MARKERS.filter((file) => existsSync(join(root, file)));
const flagText = (root: string) => flags(root).map((file) => `${file}: ${readFileSync(join(root, file), "utf8").trim()}`);

/** A lab helper the contract names (L1–L4): there, or the run stops here saying which. */
const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`lab helper missing (${what}); see docs/review-skills-lab.md`);
  return value;
};

const prepare = async (live: boolean) => {
  const app = resolve(need("PARASELF_REVIEW_APP")), bridge = resolve(need("PARASELF_REVIEW_BRIDGE"));
  if (FORBIDDEN_APP.test(app) || FORBIDDEN_APP.test(bridge)) throw new Error("The lab runs a built candidate, never the installed App");
  const holdout = resolve(need("PARASELF_REVIEW_HOLDOUT")), out = resolve(need("PARASELF_REVIEW_OUT"));
  if (/^\/(?:private\/)?(?:tmp|var)\b/u.test(out)) throw new Error("PARASELF_REVIEW_OUT must be outside the directories the Codex read profile denies");
  if (existsSync(out)) throw new Error("PARASELF_REVIEW_OUT must not exist");
  lab.verifyFrozen(holdout);
  const version = JSON.parse(readFileSync(resolve("apps/bridge/package.json"), "utf8")).version as string;
  const pin = process.env.PARASELF_REVIEW_TOOLS_PIN;
  if (live && !pin) throw new Error("PARASELF_REVIEW_TOOLS_PIN is required");
  mkdirSync(out, { recursive: true });
  // Everything the guard is given lies under root (L1): the vault, the frozen seed and the task's work folder.
  const root = join(out, "root"), vault = join(root, "vault"), seedDir = join(root, "seed"), work = join(root, "work"), tempHome = join(out, "home");
  for (const dir of [root, work, tempHome]) mkdirSync(dir, { recursive: true });
  // R7/L1: the seed the guard trusts is a frozen copy of its own, checked against HASHES before each use; the vault is the
  // App's, writable, and never a source of trust.
  cpSync(holdout, seedDir, { recursive: true });
  lab.verifyFrozen(seedDir);
  cpSync(join(holdout, "vault"), vault, { recursive: true });
  lab.verifyVaultCopy(vault, join(seedDir, "vault"));
  // S1: the task is a real (local) Git repository whose folder bears the project's name, the frozen task/ inside it; the client
  // works from its root. Its remote is configured only, never fetched: the project comes from the folder name, not the remote.
  const repo = join(work, PROJECT);
  mkdirSync(repo, { recursive: true });
  cpSync(join(holdout, "task"), join(repo, "task"), { recursive: true });
  const git = (...args: string[]) => {
    const done = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tempHome, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr.trim()}`);
  };
  git("init", "-q");
  git("remote", "add", "origin", `https://example.invalid/acme/${PROJECT}.git`);
  const taskRepo = realpathSync(repo);
  // The repositoryPath a call may name (L4): the task repository, as the guard is given it.
  const seed = Object.assign(lab.loadSeed(join(seedDir, "vault")), { taskRepo });
  return { app, bridge, holdout, out, root, vault, seedDir, work, tempHome, version, pin, taskRepo, seed };
};
type Context = Awaited<ReturnType<typeof prepare>>;

/** guardArgs with the frozen seed (L1); refused while the guard does not take it. */
const guardFor = (ctx: Context, client: string, extra: { pin?: string; record?: boolean } = {}) => {
  const args: string[] = guardArgs({ root: ctx.root, bridge: ctx.bridge, client, seed: ctx.seedDir, pin: extra.pin, version: extra.record ? undefined : ctx.version, taskRepo: ctx.taskRepo });
  if (!args.includes("--seed")) throw new Error("lab helper missing (L1: guardArgs --seed); see docs/review-skills-lab.md");
  return { command: process.execPath, args: extra.record ? [...args, "--record-digest"] : args };
};

/** The App's listing of the seeded decisions, each record checked against the seed's own Markdown (L2): the guard's catalog. */
const catalogOf = async (records: { call: (name: string, args: object) => Promise<any> }, ctx: Context) => {
  const listed: any[] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const response = await records.call("search_decision_context", { query: "", limit: 20, offset, includeOutOfScope: true, source: ["summarize", "decisions", "principles", "preferences", "ideas", "experiences"], includeWithdrawn: true });
    const context = response.result?.structuredContent?.context;
    if (!context) throw new Error("Cannot read the seed catalog");
    listed.push(...context.results);
    offset = context.nextOffset;
  }
  const allow = required(lab.catalogFromSeed as ((listed: any[], seed: any) => any[]) | undefined, "L2: catalogFromSeed")(listed, ctx.seed);
  writeFileSync(join(ctx.root, "agent-allowlist.json"), JSON.stringify(allow));
  return allow;
};

/** The isolated App and a direct connection to its bridge, always stopped, whatever happens in `use`. */
const withApp = async <T>(ctx: Context, use: (app: any, records: any) => Promise<T>): Promise<T> => {
  const app = await startIsolatedApp({ root: ctx.root, executable: ctx.app, base: { ...process.env, HOME: ctx.tempHome } });
  let records: any;
  try {
    records = await connectMcp({ env: app.env, bridge: ctx.bridge });
    return await use(app, records);
  } finally {
    try { records?.close(); } finally { await app.stop(); }
  }
};

/**
 * R3: the copies a client will load are byte for byte the skills packaged in this very candidate (its Resources/skills), and
 * that is the newest release registered for each skill: an older release, though Paraself's own, does not pass.
 */
const verifyCopies = async (dirs: string[], candidateApp: string) => {
  const packaged = resolve(candidateApp, "..", "..", "Resources", "skills");
  const candidate = JSON.stringify(await bundledSkillFingerprints(packaged));
  const prints = await Promise.all(dirs.map((dir) => bundledSkillFingerprints(dir)));
  for (const [index, print] of prints.entries()) if (JSON.stringify(print) !== candidate) throw new Error(`${dirs[index]} is not the candidate's packaged skills (${packaged})`);
  for (const [index, print] of prints.entries()) {
    for (const name of ["paraself-memory", "paraself-review"]) {
      const latest = SKILL_FINGERPRINTS[name]?.at(-1);
      if (latest === undefined || JSON.stringify(print[name]) !== JSON.stringify(latest)) throw new Error(`${dirs[index]}/${name} is not the registered release of ${name}`);
    }
    if (Object.keys(print).sort().join() !== "paraself-memory,paraself-review") throw new Error(`${dirs[index]} holds other skills: ${Object.keys(print).join(", ")}`);
  }
};

it.runIf(process.env.PARASELF_REVIEW_PREFLIGHT === "1")("preflight, no model: definitions, handshake and every tool through the guard on the built candidate", async () => {
  const ctx = await prepare(false);
  const steps: unknown[] = [];
  await withApp(ctx, async (app, records) => {
    await catalogOf(records, ctx);
    // Step 1: the definitions the guard would pin, for a human to compare with source (record mode serves no client).
    const recorder = await connectMcp({ env: { ...app.env }, ...guardFor(ctx, "claude-code", { record: true }) }).catch(() => null);
    try { await recorder?.listTools().catch(() => undefined); } finally { recorder?.close(); }
    const digest = existsSync(join(ctx.root, "TOOLS_DIGEST")) ? readFileSync(join(ctx.root, "TOOLS_DIGEST"), "utf8").trim() : null;
    writeFileSync(join(ctx.out, "preflight-definitions.json"), JSON.stringify({ digest, definitions: existsSync(join(ctx.root, "TOOLS_DEFINITIONS.json")) ? JSON.parse(readFileSync(join(ctx.root, "TOOLS_DEFINITIONS.json"), "utf8")) : null }, null, 1));
    expect(digest, "the guard recorded no definitions: see preflight-definitions.json and the guard's markers").not.toBeNull();
    // Step 2: every tool once, as the skill calls it (its full sources and modes), through the guard pinned to the digest.
    const guarded = await connectMcp({ env: app.env, ...guardFor(ctx, "claude-code", { pin: ctx.pin ?? digest! }) });
    const calls: [string, object][] = [
      ["search_decision_context", { query: "任务租约", repositoryPath: ctx.taskRepo, mode: "hybrid" }],
      ["search_decision_context", { query: "任务租约", repositoryPath: ctx.taskRepo, mode: "hybrid", source: ["experiences", "preferences", "ideas"] }],
      ["search_decision_context", { query: "任务租约", project: "orbit-queue", relation: "superseded" }],
      ["search_decision_context", { query: "任务租约", mode: "semantic" }],
      ["consult_decision_principles", { question: "任务租约应该多长？", project: "orbit-queue" }],
      ["search_obsidian_notes", { query: "死信 ack 顺序" }],
      ["get_obsidian_note", { path: NOTE }],
      ["get_obsidian_note", { path: NOTE, startLine: 3, maxLines: 2 }],
    ];
    try {
      for (const [name, args] of calls) {
        const response = await guarded.call(name, args);
        steps.push({ name, args, ok: flags(ctx.root).length === 0, isError: response.result?.isError === true, response });
        if (flags(ctx.root).length > 0) break;
      }
    } finally { guarded.close(); }
  });
  writeFileSync(join(ctx.out, "preflight-steps.json"), JSON.stringify(steps, null, 1));
  // S1: the first call, scoped to the task repository as the skill sends it, reaches the project's decisions: the current rule
  // and the one it superseded, each said so by the returned fields (not merely "no marker").
  const first = (steps[0] as any)?.response?.result?.structuredContent?.context;
  const byId = (id: string) => (first?.results ?? []).find((record: any) => record.id === id);
  expect(first?.status ?? first?.coverage, "step 1 returned no context").toBeDefined();
  expect(byId(CURRENT_ID), `step 1 lacks ${CURRENT_ID}`).toMatchObject({ project: PROJECT, current: true });
  expect(byId(SUPERSEDED_ID), `step 1 lacks ${SUPERSEDED_ID}`).toMatchObject({ project: PROJECT, current: false });
  expect(byId(SUPERSEDED_ID).supersededBy ?? [], `${SUPERSEDED_ID} is not said to be superseded by ${CURRENT_ID}`).toContain(CURRENT_ID);
  expect(flagText(ctx.root), "the guard stopped a real call or result: the reason names the field to adapt (source cited), never to loosen").toEqual([]);
  expect(steps).toHaveLength(8);
}, 600_000);

/**
 * What a stream proves (L3): the skill loaded from the task's own copy (the Skill call answered, naming that copy, and the copy's
 * own opening and closing text arrived; for Codex, its read of the copy printed them), and each guarded call checked.
 */
const evidenceOf = (client: "claude" | "codex", parsed: any, ctx: Context, allow: any[]) => {
  const copy = join(ctx.taskRepo, client === "claude" ? ".claude" : ".agents", "skills", SKILL);
  return lab.evidence(client, parsed, { skillName: SKILL, skillPath: join(copy, "SKILL.md"), skillDir: copy, skillMarkers: lab.skillMarkers(join(copy, "SKILL.md")), notePath: NOTE, seed: ctx.seed, allow });
};

/** Problems a stream shows while it runs: violations, and checked tool results; a call still waiting for its result is not one. */
const liveProblems = (client: "claude" | "codex", stdout: string, ctx: Context, roots: string[], allow: any[]): string[] =>
  (evidenceOf(client, lab.parseRun(client, stdout, { roots, cwd: ctx.taskRepo }), ctx, allow).problems as string[]).filter((problem) => !/: no result to verify$/u.test(problem));

it.runIf(process.env.PARASELF_LIVE_REVIEW_SKILLS === "1")("paraself-review: each client loads the task's copy of the skill and uses the guarded tools", async () => {
  const proxy = need("MODEL_PROXY_URL"); new URL(proxy);
  const claudeExecutable = need("PARASELF_CLAUDE_EXECUTABLE"), codexExecutable = need("PARASELF_CODEX_EXECUTABLE");
  const ctx = await prepare(true);
  const skills = resolve(need("PARASELF_REVIEW_SKILLS"));
  // Read here, at run time, from the frozen set: the cases are not known to whoever wrote this runner.
  const scenarios = JSON.parse(readFileSync(join(ctx.seedDir, "scenarios.json"), "utf8"));
  const cases = (process.env.PARASELF_REVIEW_CASES ?? "nl,explicit").split(",").map((id) => scenarios.cases.find((c: { id: string }) => c.id === id) ?? (() => { throw new Error(`no case ${id}`); })());
  const models = need("PARASELF_REVIEW_MODELS").split(",").map((entry) => { const [client, ...rest] = entry.split(":"); if (!["claude", "codex"].includes(client!) || rest.length === 0) throw new Error(`bad model ${entry}`); return { client: client as "claude" | "codex", model: rest.join(":") }; });
  const planned = models.flatMap((m) => cases.map((c: { id: string }) => ({ ...m, caseId: c.id })));

  const before = lab.metadataSnapshot(STRICT);
  const spools = ["capture-spool/events", "semantic-pair-spool/receipts", "candidate-spool/items"].map((path) => join(home, "Library", "Application Support", "Paraself", path));
  const spoolCount = () => Object.fromEntries(spools.map((dir) => [dir.split("Paraself/")[1], existsSync(dir) ? readdirSync(dir).length : null]));
  const spoolBefore = spoolCount(), started = Date.now();

  // Project-level copies: the only skill contents a client may read (R6). User-level skills it lists are a disclosure boundary.
  const claudeSkills = join(ctx.taskRepo, ".claude", "skills"), agentsSkills = join(ctx.taskRepo, ".agents", "skills");
  cpSync(join(skills, "claude"), claudeSkills, { recursive: true });
  cpSync(join(skills, "agents"), agentsSkills, { recursive: true });
  await verifyCopies([claudeSkills, agentsSkills], ctx.app);

  const results: any[] = [];
  let stopped: string | null = null;
  try {
    await withApp(ctx, async (app, records) => {
      const allow = await catalogOf(records, ctx);
      const codexRoots = lab.allowedReadRoots({ skillDirs: [agentsSkills], taskDir: join(ctx.taskRepo, "task") });
      const claudeRoots = lab.allowedReadRoots({ skillDirs: [claudeSkills], taskDir: join(ctx.taskRepo, "task") });
      // The shell stays for Codex to read a skill natively; its snapshot of the user's real shell stays off, so no prefix of it reaches a command.
      const off = CODEX_TOOLS_OFF.filter((setting: string) => !/^features\.shell_tool=/u.test(setting));
      const catalog = await writeCodexCatalog(ctx.root);
      const config = join(ctx.root, "claude-mcp.json");
      const guard = (client: string) => guardFor(ctx, client, { pin: ctx.pin });
      writeFileSync(config, JSON.stringify({ mcpServers: { paraself: { type: "stdio", ...guard("claude-code"), env: { ...Object.fromEntries(ISOLATION_KEYS.map((n: string) => [n, app.env[n]])), PARASELF_PROVIDER_CHILD: "0", DECISION_PROVIDER_CHILD: "0" } } } }));

      for (const { client, model, caseId } of planned) {
        // R2: one stop ends everything after it, every later case and the other client alike.
        lab.verifyFrozen(ctx.seedDir);
        const scenario = cases.find((c: { id: string }) => c.id === caseId);
        const roots = client === "claude" ? claudeRoots : codexRoots;
        const spec = client === "claude"
          ? lab.claudeCommand({ model, prompt: `${scenario.prompt}\n`, roots, mcpConfig: config })
          : lab.codexCommand({ model, prompt: `${scenario.prompt}\n`, work: ctx.taskRepo, roots, guard: guard("codex"), isolationKeys: ISOLATION_KEYS, off, catalog });
        // Signed in as the real HOME's client (Claude: keychain; Codex: its own auth, read by the client itself, never copied).
        const environment = lab.assertClientEnvironment(minimalClientEnvironment({ ...process.env, ...app.env, HOME: home, PARASELF_PROVIDER_CHILD: "1", DECISION_PROVIDER_CHILD: "1" },
          [...ISOLATION_KEYS, "PARASELF_PROVIDER_CHILD", "DECISION_PROVIDER_CHILD"]), ISOLATION_KEYS);
        // R1: every complete line of the stream is checked as it arrives, with the guard's markers; the first problem aborts the
        // run, and the managed runner ends the client's whole process group. Polled too, for a marker written with no output.
        const abort = new AbortController();
        let streamed = "", liveStop: string | null = null;
        const stop = (why: string) => { if (liveStop === null) { liveStop = why; abort.abort(); } };
        const check = () => {
          const marked = flagText(ctx.root);
          if (marked.length > 0) return stop(marked.join("; "));
          const problems = liveProblems(client, streamed, ctx, roots, allow);
          if (problems.length > 0) stop(problems.join("; "));
        };
        const runner = new ManagedChildProcessRunner({
          modelNetworkPolicy: "required",
          spawnProcess: ((command: string, args: string[], options: any) => {
            const child = spawn(command, args, options);
            let pending = "";
            child.stdout.on("data", (chunk: Buffer) => {
              pending += chunk.toString("utf8");
              const end = pending.lastIndexOf("\n");
              if (end === -1) return;
              streamed += pending.slice(0, end + 1);
              pending = pending.slice(end + 1);
              check();
            });
            return child;
          }) as any,
        });
        const watch = setInterval(() => { if (flags(ctx.root).length > 0) stop(flagText(ctx.root).join("; ")); }, 250);
        const t0 = Date.now();
        let run: { stdout: string; stderr: string; code: number | string };
        try {
          const done = await runner.run({ provider: client === "claude" ? "claude-code-cli" : "codex-cli", model, executable: client === "claude" ? claudeExecutable : codexExecutable, args: spec.args, environment, cwd: ctx.taskRepo, stdin: spec.stdin,
            timeoutMs: 240_000, maximumStdoutBytes: 8 * 1024 * 1024, maximumStderrBytes: 1024 * 1024, signal: abort.signal });
          run = { stdout: done.stdout, stderr: done.stderr, code: done.exitCode };
        } catch (error) {
          if (!(error instanceof ManagedProcessError)) throw error;
          run = { stdout: streamed, stderr: error.diagnosticExcerpt, code: error.code };
        } finally { clearInterval(watch); }
        const parsed = lab.parseRun(client, run.stdout, { roots, cwd: ctx.taskRepo });
        const evidence = evidenceOf(client, parsed, ctx, allow);
        const flagged = flagText(ctx.root);
        const passed = evidence.ok === true && run.code === 0 && flagged.length === 0 && liveStop === null;
        results.push({ client, model, case: caseId, elapsedMs: Date.now() - t0, code: run.code, passed, liveStop, evidence, flagged, listedSkills: parsed.skills, answer: parsed.text, stderrTail: run.stderr.slice(-800) });
        writeFileSync(join(ctx.out, `${client}-${caseId}.jsonl`), run.stdout);
        writeFileSync(join(ctx.out, "results.json"), JSON.stringify(results, null, 2));
        if (!passed) { stopped = `${client}/${caseId}: ${liveStop ?? (flagged.join("; ") || (run.code !== 0 ? `exit ${run.code}` : `evidence not ok: ${JSON.stringify({ ...evidence, problems: evidence.problems.slice(0, 5) })}`))}`; break; }
      }
    });
  } finally {
    const after = lab.metadataSnapshot(STRICT);
    writeFileSync(join(ctx.out, "real-config.json"), JSON.stringify({ strict: { before, after, unchanged: before.digest === after.digest }, stopped,
      spools: { window: [new Date(started).toISOString(), new Date().toISOString()], before: spoolBefore, after: spoolCount(), note: "counts only; the lab sessions run with PARASELF_PROVIDER_CHILD=1 so none should be theirs" },
      codexVersion: spawnSync(codexExecutable, ["--version"], { encoding: "utf8" }).stdout.trim(), claudeVersion: spawnSync(claudeExecutable, ["--version"], { encoding: "utf8" }).stdout.trim() }, null, 1));
  }
  expect(JSON.parse(readFileSync(join(ctx.out, "real-config.json"), "utf8")).strict.unchanged, "the user's skills or integration config changed during the run").toBe(true);
  expect(stopped, "a case stopped the run: see results.json").toBeNull();
  // Every planned (client, case) ran and passed: all four hard conditions, the task's own skill copy, exit 0, no marker.
  expect(lab.coverage(planned, results)).toMatchObject({ ok: true });
  expect(results.map((row) => row.passed)).toEqual(planned.map(() => true));
}, 3_600_000);
