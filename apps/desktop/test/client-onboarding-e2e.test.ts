import {
  BUILT_IN_CLIENTS,
  clientHookPaths,
  customHookPath,
  installIntegrationsWithinTurn,
  inIntegrationsTurn,
  removeIntegrationsWithinTurn,
} from "@cognelis/decision-integrations";
import type { ModelProviderProfile, OnboardingView, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { beforeAll, describe, expect, it, vi } from "vitest";

// @ts-expect-error: a lab script, plain JavaScript
import { isolationEnvironment } from "../../../scripts/lab/isolated-app.mjs";
import { ClientOnboardingService } from "../src/main/client-onboarding-service.js";
import { CustomClientService } from "../src/main/custom-client-service.js";

const repository = new URL("../../../", import.meta.url).pathname;
const source = (path: string) => join(repository, path);

/**
 * An agent CLI that reads its hooks from ~/.fakeagent/hooks.json (Claude Code's format) and runs each through a shell,
 * the hook input on stdin, as such tools do: a turn's prompt on UserPromptSubmit, its reply on Stop.
 */
const FAKE_AGENT = `
const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("fakeagent 0.3.1"); process.exit(0); }
if (argv[0] === "--help") { console.log("Usage: fakeagent --prompt <text> --reply <text>\\nCommands:\\n  hooks  Run commands on events; see fakeagent hooks --help"); process.exit(0); }
if (argv[0] === "hooks") { console.log("Hooks are read from ~/.fakeagent/hooks.json, in Claude Code's settings format: {hooks:{UserPromptSubmit:[...],Stop:[...]}}. Events: UserPromptSubmit, Stop."); process.exit(0); }
const option = (name) => argv[argv.indexOf(name) + 1];
let config = {};
try { config = JSON.parse(readFileSync(join(process.env.HOME, ".fakeagent", "hooks.json"), "utf8")); } catch {}
// Claude Code's grouped hooks, or (FAKE_STYLE=copilot) a flat file of handlers and the reply in Copilot's events.jsonl.
const copilot = process.env.FAKE_STYLE === "copilot";
const fire = (event, input) => {
  for (const entry of (config.hooks && config.hooks[event]) || []) for (const handler of entry.hooks || [entry]) {
    spawnSync("/bin/sh", ["-c", handler.command], { input: JSON.stringify(input), env: process.env, stdio: ["pipe", "ignore", "inherit"] });
  }
};
const common = { session_id: option("--session"), cwd: process.cwd(), turn_id: option("--turn") };
const transcript = join(process.env.HOME, ".fakeagent", "events.jsonl");
// FAKE_STYLE=single: one event at a turn's end, the prompt and the reply both in it.
if (process.env.FAKE_STYLE === "single") {
  fire("TurnFinished", { ...common, hook_event_name: "TurnFinished", stop_reason: "end_turn", prompt: option("--prompt"), last_assistant_message: option("--reply") });
  process.exit(0);
}
fire("UserPromptSubmit", { ...common, hook_event_name: "UserPromptSubmit", prompt: option("--prompt") });
if (copilot) {
  require("node:fs").appendFileSync(transcript, [
    { type: "user.message", data: { content: option("--prompt") } },
    { type: "assistant.message", data: { content: option("--reply") } },
  ].map((line) => JSON.stringify(line) + "\\n").join(""));
  fire("Stop", { ...common, hook_event_name: "Stop", stop_reason: "end_turn", transcript_path: transcript });
} else {
  fire("Stop", { ...common, hook_event_name: "Stop", stop_reason: "end_turn", last_assistant_message: option("--reply") });
}
`;

const PROFILE = { profileId: "scripted", label: "脚本模型", kind: "openai", enabled: true, priority: 1 } as unknown as ModelProviderProfile;

let bridge = "";

beforeAll(async () => {
  // The bridge as it ships, built from this checkout's sources into a folder of its own.
  const out = await mkdtemp(join(tmpdir(), "decision-e2e-bridge-"));
  await build({
    configFile: false,
    logLevel: "silent",
    root: repository,
    resolve: {
      conditions: ["node"],
      alias: {
        "@cognelis/decision-core/journal-entry": source("packages/core/src/journal-entry.ts"),
        "@cognelis/decision-core/todo": source("packages/core/src/todo.ts"),
        "@cognelis/decision-core/recommendation": source("packages/core/src/recommendation.ts"),
        "@cognelis/decision-core/rationale-factors": source("packages/core/src/rationale-factors.ts"),
        "@cognelis/decision-protocol": source("packages/protocol/src/index.ts"),
        "@cognelis/decision-core": source("packages/core/src/index.ts"),
        "@cognelis/decision-storage": source("packages/storage/src/index.ts"),
        "@cognelis/decision-integrations": source("packages/integrations/src/index.ts"),
      },
    },
    build: {
      target: "node20",
      outDir: out,
      emptyOutDir: true,
      minify: false,
      lib: { entry: source("apps/bridge/src/cli.ts"), formats: ["es"], fileName: () => "decision-bridge.mjs" },
      rollupOptions: { external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), "node:sqlite"] },
    },
  });
  bridge = join(out, "decision-bridge");
  await writeFile(bridge, `#!/bin/sh\nexec '${process.execPath}' '${join(out, "decision-bridge.mjs")}' "$@"\n`);
  await chmod(bridge, 0o755);
}, 120_000);

const filesUnder = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)])));
  return nested.flat();
};

describe("接入新工具, end to end", () => {
  it.each([
    { style: "claude", format: "claude", reply: { source: "field", field: "last_assistant_message" } },
    { style: "copilot", format: "flat", reply: { source: "transcript", format: "copilot", field: "transcript_path" } },
    { style: "single", format: "claude", reply: { source: "field", field: "last_assistant_message" } },
  ] as const)("connects a fake agent CLI ($style hooks) by probe and plan, then the real bridge pairs its next turns", async ({ style, format, reply }) => {
    const root = await mkdtemp(join(tmpdir(), "decision-e2e-"));
    const home = join(root, "home");
    const work = join(root, "work");
    const bin = join(root, "bin");
    await mkdir(join(home, ".fakeagent"), { recursive: true });
    await mkdir(work, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "fakeagent"), `#!${process.execPath}\n${FAKE_AGENT}`);
    await chmod(join(bin, "fakeagent"), 0o755);
    const environment: NodeJS.ProcessEnv = { ...isolationEnvironment(root), HOME: home, PATH: `${bin}:/usr/bin:/bin`, FAKE_STYLE: style };
    const userData = environment.PARASELF_USER_DATA!;
    await mkdir(userData, { recursive: true });
    const agent = (prompt: string, reply: string, turn: string) => {
      const run = spawnSync(join(bin, "fakeagent"), ["--session", "sess-e2e-1", "--turn", turn, "--prompt", prompt, "--reply", reply], { cwd: work, env: environment, encoding: "utf8" });
      expect(run.status).toBe(0);
    };

    const checkTarget = (client: string, path: string, stage: "check" | "write") => customClients.checkTarget(client, path, stage);
    const customClients: CustomClientService = new CustomClientService({
      path: environment.PARASELF_CUSTOM_CLIENTS!,
      home,
      platform: "darwin",
      builtInPaths: () => clientHookPaths(BUILT_IN_CLIENTS, {}, home),
      protectedDirectories: () => [userData],
      serialize: inIntegrationsTurn,
      disconnect: (client) => removeIntegrationsWithinTurn({ mode: "apply", bridgePath: bridge, platform: "darwin", clients: [client], paths: clientHookPaths([client], {}, home), checkTarget }),
    });
    await customClients.load();

    // The model's steps, scripted: it decides nothing the program does not check.
    const steps: Record<string, unknown>[] = [
      { action: "confirm_command", command: "fakeagent", message: "命令是 fakeagent 吗？" },
      { action: "check_command", args: ["--help"] },
      { action: "check_command", args: ["hooks", "--help"] },
      { action: "list_directory", path: "~/.fakeagent" },
      { action: "probe", file: "~/.fakeagent/hooks.json", format, events: style === "single" ? ["TurnFinished"] : ["UserPromptSubmit", "Stop"], message: "装个探针" },
      {
        action: "propose",
        message: "请确认",
        client: {
          id: "fakeagent", name: "Fake Agent", shortName: "FA", command: "fakeagent",
          hooks: { file: "~/.fakeagent/hooks.json", format: "claude" },
          prompt: { event: "UserPromptSubmit", field: "prompt" },
          reply: { event: "Stop", source: "field", field: "last_assistant_message" },
          fields: { sessionId: "session_id", cwd: "cwd", turnId: "turn_id" },
          mcp: { mode: "none" },
        },
      },
    ];
    const requests: StructuredGenerationRequest[] = [];
    const onboarding = new ClientOnboardingService({
      gateway: {
        listGenerationProfiles: async () => [PROFILE],
        generate: vi.fn(async (request: StructuredGenerationRequest, parse: (value: unknown) => unknown) => {
          requests.push(request);
          const next = steps.shift();
          if (next === undefined) throw new Error("no more steps");
          return { parsedOutput: parse(next) } as never;
        }),
      },
      probesDirectory: environment.PARASELF_CLIENT_PROBES!,
      home,
      platform: "darwin",
      environment: () => environment,
      protectedDirectories: () => [userData],
      customClients: () => customClients.list(),
      install: (client, path, target) => inIntegrationsTurn(() => installIntegrationsWithinTurn({ mode: "apply", bridgePath: bridge, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget: target })),
      remove: (client, path, target) => inIntegrationsTurn(() => removeIntegrationsWithinTurn({ mode: "apply", bridgePath: bridge, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget: target })),
      connect: async (client) => {
        await customClients.save(client);
        const added = customClients.descriptors().filter((descriptor) => descriptor.id === client.id);
        const report = await customClients.inTurn(() => installIntegrationsWithinTurn({ mode: "apply", bridgePath: bridge, platform: "darwin", clients: added, paths: clientHookPaths(added, {}, home), checkTarget }));
        const target = report.targets.find((entry) => entry.client === client.id);
        return { connected: target?.status === "installed", detail: target?.detail ?? "" };
      },
      timing: { pollMs: 50, settleMs: 200, waitMs: 60_000 },
    });

    let sessionId: string | null = null;
    let shown: OnboardingView["card"] = null;
    const send = async (event: { type: string } & Record<string, unknown>): Promise<OnboardingView> => {
      const answer = ["command", "probe", "plan"].includes(event.type) ? { ...event, token: shown !== null && "token" in shown ? shown.token : "" } : event;
      const view = await onboarding.handle({ sessionId, profileId: "scripted", event: answer as never });
      sessionId = view.sessionId;
      shown = view.card;
      return view;
    };

    expect((await send({ type: "message", text: "我想接入 fakeagent" })).card).toMatchObject({ kind: "command", command: "fakeagent" });
    let view = await send({ type: "command", answer: "confirm" });
    expect(view.card).toMatchObject({ kind: "probe" });
    expect(requests.at(-1)!.userPrompt).toContain("~/.fakeagent/hooks.json");
    expect(requests.at(-1)!.userPrompt).toContain("Events: UserPromptSubmit, Stop");

    view = await send({ type: "probe", answer: "confirm" });
    expect(view.card?.kind).toBe("waiting");
    const phrase = view.card?.kind === "waiting" ? view.card.phrase : "";
    const secret = phrase.replace(/^.*：/u, "");
    const waited = send({ type: "await-probe" });
    // The reader sends the line in the tool; its model answers with the secret, formatted.
    agent(phrase, `好的：\`${secret}\``, "turn-probe");
    view = await waited;
    expect(view.card).toMatchObject({
      kind: "plan",
      client: {
        id: "fakeagent",
        hooks: { format },
        prompt: { event: style === "single" ? "TurnFinished" : "UserPromptSubmit" },
        reply: { event: style === "single" ? "TurnFinished" : "Stop", ...reply },
        complete: { field: "stop_reason", values: ["end_turn"] },
      },
      preview: { prompt: phrase, sessionId: "sess-e2e-1", turnId: "turn-probe" },
    });
    const hookFile = customHookPath("~/.fakeagent/hooks.json", home);
    expect(await readFile(hookFile, "utf8").catch(() => "")).not.toContain("hook probe");
    expect(await readdir(environment.PARASELF_CLIENT_PROBES!)).toEqual([]);

    view = await send({ type: "plan", answer: "confirm" });
    expect(view.status).toBe("ended");
    expect(await readFile(hookFile, "utf8")).toContain("hook stop fakeagent");

    // A real turn now: a question in the reply, the reader's answer in the next prompt, paired by the real bridge.
    agent("帮我选一种存储", "方案 A 用 SQLite 数据库，方案 B 用 JSON 文件，你选哪个？", "turn-a");
    agent("就用方案 A。", "好，按方案 A 来。", "turn-b");
    const spooled = await Promise.all((await filesUnder(environment.PARASELF_SEMANTIC_PAIR_SPOOL!)).map((file) => readFile(file, "utf8")));
    const pairs = spooled.filter((text) => text.includes("就用方案 A"));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toContain("\"sourceClient\":\"fakeagent\"");
    expect(pairs[0]).toContain("turn-a");

    const told = requests.map((request) => request.userPrompt).join("\n");
    for (const value of ["sess-e2e-1", work, secret, "turn-probe"]) expect(told).not.toContain(value);
  }, 120_000);
});
