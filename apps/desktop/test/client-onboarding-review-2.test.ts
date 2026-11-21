// CL2-REVIEW-AS-2: each finding's correct behaviour, from the review's reproductions (rounds/CL2/review-as/r2).
import {
  CATALOG_CLIENTS,
  clientHookPaths,
  inIntegrationsTurn,
  installIntegrations,
  installIntegrationsWithinTurn,
  removeIntegrationsWithinTurn,
  type ClientDescriptor,
} from "@cognelis/decision-integrations";
import { CLIENT_CATALOG, clientProbeRecordSchema, type ClientProbeRecord, type OnboardingView } from "@cognelis/decision-protocol";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runProbeHook } from "../../bridge/src/client-probe.js";
import { ClientOnboardingService, type ClientOnboardingOptions } from "../src/main/client-onboarding-service.js";
import { checkPlan, inferMapping, isDynamicSegment, probePhrase, secretsSeen } from "../src/main/client-probe-inference.js";
import { BRIDGE, harness, PROBE_STEP } from "./support/onboarding-harness.js";

const REPLY = { action: "reply", message: "继续" };
const FAST = { timing: { pollMs: 5, settleMs: 5, waitMs: 4_000 } };
const tokenOf = (view: OnboardingView): string => (view.card !== null && "token" in view.card ? view.card.token : "");
const queued = (): Pick<ClientOnboardingOptions, "install" | "remove"> => ({
  install: (client, path, checkTarget) => inIntegrationsTurn(() => installIntegrationsWithinTurn({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget })),
  remove: (client, path, checkTarget) => inIntegrationsTurn(() => removeIntegrationsWithinTurn({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget })),
});

describe("AS2-R01: a probe never goes in a tool Decision ships", () => {
  it.each(["gemini-cli", "copilot", "auggie"])("refuses %s's hook file before any card, its own hooks as they were", async (id) => {
    const shipped = CATALOG_CLIENTS.find((client) => client.id === id)!;
    const { mcp: _mcp, ...hooksOnly } = shipped;
    const catalog = CLIENT_CATALOG.find((entry) => entry.client.id === id)!.client;
    const h = await harness([{ action: "probe", file: catalog.hooks.file, format: catalog.hooks.format, events: ["Stop"] }, REPLY]);
    const paths = clientHookPaths([hooksOnly as ClientDescriptor], {}, h.home);
    await installIntegrations({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [hooksOnly as ClientDescriptor], paths });
    const before = await readFile(paths[id]!, "utf8");
    const view = await h.send({ type: "message", text: "接入一个不知道名字的工具" });
    expect(view.card).toBeNull();
    expect(h.install).not.toHaveBeenCalled();
    expect(h.requests.at(-1)!.userPrompt).toContain(`这是 ${shipped.name} 的钩子配置文件`);
    expect(h.requests.at(-1)!.userPrompt).toContain("打开「接入」页");
    await h.service.shutdown();
    expect(await readFile(paths[id]!, "utf8")).toBe(before);
  });
});

describe("AS2-R02: the probe is held, and waited on, apart from its conversation", () => {
  it("keeps a probe closed while it goes in, refusing another meanwhile, and takes it out after", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let installs = 0;
    const { install, remove } = queued();
    const h = await harness([PROBE_STEP, PROBE_STEP, REPLY], {
      install: async (client, path, checkTarget) => {
        installs += 1;
        if (installs === 1) { entered(); await gate; }
        return install(client, path, checkTarget);
      },
      remove,
    });
    const a = await h.service.handle({ sessionId: null, event: { type: "message", text: "A" } });
    const b = await h.service.handle({ sessionId: null, event: { type: "message", text: "B" } });
    const installingA = h.service.handle({ sessionId: a.sessionId, event: { type: "probe", token: tokenOf(a), answer: "confirm" } });
    await started;
    await h.service.handle({ sessionId: a.sessionId, event: { type: "close" } });
    const viewB = await h.service.handle({ sessionId: b.sessionId, event: { type: "probe", token: tokenOf(b), answer: "confirm" } });
    expect(viewB.status).not.toBe("waiting");
    expect(viewB.entries.at(-1)!.text).toContain("另一个接入对话的探针还在等待");
    release();
    expect((await installingA).status).toBe("ended");
    expect(installs).toBe(1);
    expect(await readFile(h.hookFile, "utf8")).not.toContain("hook probe");
    expect(await readdir(h.probes)).toEqual([]);
  });

  it("has the quit wait for a probe whose conversation was closed while it went in", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { install } = queued();
    const h = await harness([PROBE_STEP], { install: async (...args) => { entered(); await gate; return install(...args); } });
    const a = await h.send({ type: "message", text: "A" });
    const installing = h.send({ type: "probe", answer: "confirm" });
    await started;
    await h.service.handle({ sessionId: a.sessionId, event: { type: "close" } });
    let returned = false;
    const quitting = h.service.shutdown().then(() => { returned = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);
    release();
    await installing;
    await quitting;
    expect(await readFile(h.hookFile, "utf8")).not.toContain("hook probe");
    expect(await readdir(h.probes)).toEqual([]);
  });
});

describe("AS2-R03: what taking a probe out needs is kept until it is out", () => {
  it("leaves the next start what to take out when the App stops between revoking and removing", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { remove } = queued();
    const h = await harness([PROBE_STEP], { remove: async (...args) => { entered(); await gate; return remove(...args); } });
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const quitting = h.service.shutdown();
    await started;
    // The old process frozen mid-removal: the next start sees only what is on disk.
    let removals = 0;
    const restarted = new ClientOnboardingService({
      gateway: { listGenerationProfiles: async () => [], generate: async () => { throw new Error("unused"); } },
      home: h.home,
      probesDirectory: h.probes,
      environment: () => ({ PATH: "" }),
      protectedDirectories: () => [],
      customClients: () => [],
      install: async () => { throw new Error("unused"); },
      remove: async (...args) => { removals += 1; return remove(...args); },
      connect: async () => ({ connected: false, detail: "" }),
    });
    expect(await readdir(h.probes)).toContain("cleanup");
    expect(await restarted.cleanupLeftovers()).toEqual({ removed: 1, failed: [] });
    expect(removals).toBe(1);
    expect(await readFile(h.hookFile, "utf8")).not.toContain("hook probe");
    release();
    await quitting;
    expect(await readdir(h.probes)).toEqual([]);
  });
});

describe("AS2-R04: the bridge's second look is at the time of the write", () => {
  it("records nothing from an input whose reading ran past the probe's end", async () => {
    const h = await harness([PROBE_STEP]);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    let clock = marker.createdAt + 1;
    let entered!: () => void;
    let release!: (value: unknown) => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const input = new Promise((resolve) => { release = resolve; });
    const running = runProbeHook(marker.id, "Stop", { environment: { DECISION_CLIENT_PROBES: h.probes }, now: () => clock, readInput: async () => { entered(); return input; } });
    await reading;
    clock = marker.expiresAt + 1;
    release({ private_sample: "PAST-EXPIRY" });
    await running;
    expect(await readdir(join(h.probes, marker.id))).toEqual([]);
    await h.service.shutdown();
  });
});

describe("AS2-R05: no dynamic key reaches the model, an ambiguity's reason included", () => {
  it.each(["123456", "abcdefabcdef"])("refuses a session id under the key %s, and says no such key", async (key) => {
    expect(isDynamicSegment(key)).toBe(true);
    const h = await harness([PROBE_STEP, REPLY], FAST);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    const common = { cwd: "/synthetic/work", sessions: { [key]: { session_id: "private-one" } }, thread_id: "private-two" };
    const caught = [
      { event: "UserPromptSubmit", receivedAt: 1, transcripts: [], input: { ...common, prompt: probePhrase(marker.secret) } },
      { event: "Stop", receivedAt: 2, transcripts: [], input: { ...common, reply: marker.secret } },
    ];
    for (const [index, record] of caught.entries()) await writeFile(join(h.probes, marker.id, `0${index}.json`), JSON.stringify(record));
    await h.send({ type: "await-probe" });
    const told = h.requests.at(-1)!.userPrompt;
    expect(told).toContain("随会话变化的键");
    expect(told).not.toContain(key);
  });
});

describe("AS2-R06: a prompt and its reply in one event", () => {
  it("are worked out and checked as two fields of the one record", () => {
    const secret = "DECISION-ABCDEF";
    const probe = { hooks: { file: "~/.fake/hooks.json", format: "flat" as const }, events: ["TurnFinished"], secret };
    const records: ClientProbeRecord[] = [{ event: "TurnFinished", receivedAt: 1, transcripts: [], input: { session_id: "s1", cwd: "/synthetic/work", prompt: probePhrase(secret), reply: secret } }];
    expect(secretsSeen(records, secret)).toBe(true);
    expect(inferMapping(records, probe)).toMatchObject({
      ok: true,
      mapping: { prompt: { event: "TurnFinished", field: "prompt" }, reply: { event: "TurnFinished", source: "field", field: "reply" } },
    });
    const client = {
      id: "fake", name: "Fake", shortName: "F", hooks: probe.hooks,
      prompt: { event: "TurnFinished", field: "prompt" }, reply: { event: "TurnFinished", source: "field" as const, field: "reply" },
      fields: { sessionId: "session_id", cwd: "cwd" }, mcp: { mode: "none" as const },
    };
    expect(checkPlan(client, records, probe, { command: null, mcpAddSeen: false }).problems).toEqual([]);
    // Still the prompt itself is no reply.
    expect(checkPlan({ ...client, reply: { ...client.reply, field: "prompt" } }, records, probe, { command: null, mcpAddSeen: false }).problems.join()).toContain("回复");
  });
});

describe("AS2-R07: a record of a turn's end with many transcript paths", () => {
  it("stays within the schema, seven paths read in six formats, and reaches the model", async () => {
    const h = await harness([PROBE_STEP, REPLY], FAST);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    const transcript = join(h.root, "events.jsonl");
    await writeFile(transcript, [{ type: "user.message", data: { content: probePhrase(marker.secret) } }, { type: "assistant.message", data: { content: marker.secret } }].map((line) => JSON.stringify(line)).join("\n"));
    const environment = { DECISION_CLIENT_PROBES: h.probes };
    await runProbeHook(marker.id, "UserPromptSubmit", { environment, readInput: async () => ({ session_id: "s1", cwd: h.home, prompt: probePhrase(marker.secret) }) });
    const paths = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`file${index + 1}`, transcript]));
    await runProbeHook(marker.id, "Stop", { environment, readInput: async () => ({ session_id: "s1", cwd: h.home, transcript_path: transcript, ...paths }) });
    const records = await Promise.all((await readdir(join(h.probes, marker.id))).map(async (name) => JSON.parse(await readFile(join(h.probes, marker.id, name), "utf8")) as unknown));
    const stop = records.find((record) => (record as { event: string }).event === "Stop");
    expect(clientProbeRecordSchema.safeParse(stop).success).toBe(true);
    await h.send({ type: "finish-probe" });
    await h.send({ type: "await-probe" });
    expect(h.requests.at(-1)!.userPrompt).toContain("事件 2：Stop");
  });
});
