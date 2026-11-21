// CL2-REVIEW-AS: each finding's correct behaviour, from the review's reproductions (rounds/CL2/review-as), as the
// App now takes its answers (a card's token) and waits on a probe itself.
import { installIntegrations, removeIntegrations, type InstallReport } from "@cognelis/decision-integrations";
import type { ClientProbeRecord, OnboardingView } from "@cognelis/decision-protocol";
import { chmod, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runProbeHook } from "../../bridge/src/client-probe.js";
import { forModel, isLauncher, runCommandCheck } from "../src/main/client-onboarding-service.js";
import { checkPlan, inferMapping, probePhrase } from "../src/main/client-probe-inference.js";
import { BRIDGE, CLIENT, harness, PROBE_STEP, VALUES } from "./support/onboarding-harness.js";

const REPLY = { action: "reply", message: "继续" };
const FAST = { timing: { pollMs: 5, settleMs: 5, waitMs: 4_000 } };
const hooksIn = async (path: string) => (await readFile(path, "utf8")).includes("hook probe");
const tokenOf = (view: OnboardingView): string => (view.card !== null && "token" in view.card ? view.card.token : "");

describe("AS-R01: an answer is to the one card it was shown", () => {
  it("does not install a probe card replaced since, and keeps the card on show", async () => {
    const h = await harness([PROBE_STEP, { ...PROBE_STEP, file: "~/.other/hooks.json" }]);
    const stale = tokenOf(await h.send({ type: "message", text: "接入" }));
    const second = await h.send({ type: "message", text: "再考虑一下" });
    expect(second.card).toMatchObject({ kind: "probe", file: "~/.other/hooks.json" });
    const view = await h.send({ type: "probe", token: stale, answer: "confirm" });
    expect(h.install).not.toHaveBeenCalled();
    expect(view.entries.at(-1)!.text).toContain("过期");
    expect(view.card).toMatchObject({ kind: "probe", file: "~/.other/hooks.json", token: tokenOf(second) });
  });

  it("does not connect a plan replaced since, and takes a token once", async () => {
    const h = await harness([PROBE_STEP, { action: "propose", client: CLIENT }, { action: "propose", client: { ...CLIENT, id: "other", name: "另一个" } }], FAST);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    await h.catchTurn(await h.marker());
    const first = await h.send({ type: "await-probe" });
    expect(first.card).toMatchObject({ kind: "plan", client: { id: "kimi" } });
    const stale = tokenOf(first);
    const second = await h.send({ type: "message", text: "重出方案" });
    expect(second.card).toMatchObject({ kind: "plan", client: { id: "other" } });
    await h.send({ type: "plan", token: stale, answer: "confirm" });
    expect(h.connect).not.toHaveBeenCalled();
    await h.send({ type: "plan", token: tokenOf(second), answer: "confirm" });
    expect(h.connect).toHaveBeenCalledTimes(1);
    await expect(h.send({ type: "plan", token: tokenOf(second), answer: "confirm" })).rejects.toThrow("已经结束");
    expect(h.connect).toHaveBeenCalledTimes(1);
  });
});

describe("AS-R02: a check runs the tool's own program, never one it starts", () => {
  it("refuses a launcher as the command, by its name or by the file a name really is", async () => {
    const h = await harness([{ action: "confirm_command", command: "env" }, REPLY], { runCommand: runCommandCheck });
    const bin = join(h.root, "bin");
    await symlink("/usr/bin/env", join(bin, "envish"));
    h.setPath(`${bin}:/usr/bin:/bin`);
    const view = await h.send({ type: "message", text: "检查命令" });
    expect(view.card).toBeNull();
    expect(h.requests[1]!.userPrompt).toContain("env 是用来启动别的程序的");
    h.queue.push({ action: "confirm_command", command: "envish" }, REPLY);
    await h.send({ type: "message", text: "那换个名字" });
    expect(h.requests.at(-1)!.userPrompt).toContain("envish 是用来启动别的程序的");
    for (const name of ["sh", "python3", "python3.12", "npx", "sudo", "pwsh.exe", "osascript", "env"]) expect(isLauncher(name)).toBe(true);
    for (const name of ["kimi", "claude", "codex", "grok", "pythonic"]) expect(isLauncher(name)).toBe(false);
  });

  it("shows the program the name runs on the card, and confirms only that program", async () => {
    const h = await harness([{ action: "confirm_command", command: "kimi" }, REPLY]);
    const view = await h.send({ type: "message", text: "接入 kimi" });
    expect(view.card).toMatchObject({ kind: "command", command: "kimi", path: expect.stringMatching(/\/bin\/kimi$/u) });
    // Another kimi earlier on the PATH since: not what the reader saw, not confirmed.
    const earlier = join(h.root, "earlier");
    await mkdir(earlier);
    await writeFile(join(earlier, "kimi"), "#!/bin/sh\n");
    await chmod(join(earlier, "kimi"), 0o755);
    h.setPath(`${earlier}:${join(h.root, "bin")}`);
    const after = await h.send({ type: "command", answer: "confirm" });
    expect(after.entries.at(-1)!.text).toContain("和卡上显示的不一样");
    expect(h.runCommand).not.toHaveBeenCalled();
  });
});

describe("AS-R03: the App waits on a probe itself, and takes it out however it ends", () => {
  it.each(["cancel-probe", "close", "shutdown", "timeout"] as const)("with no await-probe sent: %s", async (operation) => {
    // A clock of its own: only the timeout case moves it, so each ending is what takes the probe out, none by running out.
    let clock = 0;
    const h = await harness([PROBE_STEP], { now: () => clock, timing: { waitMs: 60, pollMs: 5, settleMs: 5 } });
    try {
      await h.send({ type: "message", text: "接入" });
      await h.send({ type: "probe", answer: "confirm" });
      expect(await hooksIn(h.hookFile)).toBe(true);
      if (operation === "shutdown") await h.service.shutdown();
      else if (operation === "close") await h.send({ type: "close" });
      else if (operation === "cancel-probe") await h.send({ type: "cancel-probe" });
      else clock = 61;
      // The App's wait takes it out on its own once it ends: wait for that, hooks out and folder empty both.
      await expect.poll(async () => (await hooksIn(h.hookFile)) || (await readdir(h.probes)).length > 0, { timeout: 4_000, interval: 10 }).toBe(false);
    } finally {
      await h.service.shutdown();
    }
  });

  it("takes out a probe the conversation was closed on while it went in, and never waits on it", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness([PROBE_STEP], {
      install: async (client, path, checkTarget) => {
        entered();
        await gate;
        return installIntegrations({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget });
      },
    });
    await h.send({ type: "message", text: "接入" });
    const installing = h.send({ type: "probe", answer: "confirm" });
    await started;
    await h.send({ type: "close" });
    release();
    const view = await installing;
    expect(view.status).toBe("ended");
    expect(await hooksIn(h.hookFile)).toBe(false);
    expect(await readdir(h.probes)).toEqual([]);
  });
});

describe("AS-R04: a probe's authority goes first, and nothing is recorded after", () => {
  it("records nothing from a hook in flight when the probe is taken out", async () => {
    const h = await harness([PROBE_STEP]);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    let entered!: () => void;
    let release!: (value: unknown) => void;
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    const input = new Promise((resolve) => { release = resolve; });
    const running = runProbeHook(marker.id, "Stop", { environment: { PARASELF_CLIENT_PROBES: h.probes }, readInput: async () => { entered(); return input; } });
    await reading;
    await h.send({ type: "close" });
    expect(await readdir(h.probes)).toEqual([]);
    release({ private_sample: "SYNTHETIC-SECRET-RETAINED" });
    await running;
    expect(await readdir(h.probes)).toEqual([]);
  });

  it("revokes a probe whose hooks could not be taken out, keeps them on the cleanup list, and takes them out at start", async () => {
    let failing = true;
    const h = await harness([PROBE_STEP], {
      ...FAST,
      remove: async (client, path, checkTarget): Promise<InstallReport> => failing
        ? { mode: "apply", targets: [{ client: client.id, path, changed: false, status: "failed", detail: "synthetic file changed" }], commands: [], restartRequired: false }
        : removeIntegrations({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget }),
    });
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    await h.send({ type: "cancel-probe" });
    const view = await h.send({ type: "await-probe" });
    expect(view.entries.at(-1)!.text).toContain("钩子没能移除");
    expect(await hooksIn(h.hookFile)).toBe(true);
    // No marker left: the hook still in the file records nothing.
    expect(await readdir(h.probes)).toEqual(["cleanup"]);
    await runProbeHook(marker.id, "Stop", { environment: { PARASELF_CLIENT_PROBES: h.probes }, readInput: async () => ({ private_sample: "AFTER-CLEANUP-FAILURE" }) });
    expect(await readdir(h.probes)).toEqual(["cleanup"]);
    failing = false;
    expect(await h.restart().cleanupLeftovers()).toEqual({ removed: 1, failed: [] });
    expect(await hooksIn(h.hookFile)).toBe(false);
    expect(await readdir(h.probes)).toEqual([]);
  });
});

describe("AS-R05: one probe at a time", () => {
  it("refuses a second conversation's probe while one waits, and leaves the first's hooks alone", async () => {
    const h = await harness([PROBE_STEP, PROBE_STEP, REPLY]);
    const a = await h.service.handle({ sessionId: null, event: { type: "message", text: "A" } });
    await h.service.handle({ sessionId: a.sessionId, event: { type: "probe", token: tokenOf(a), answer: "confirm" } });
    const first = await h.marker();
    const b = await h.service.handle({ sessionId: null, event: { type: "message", text: "B" } });
    const refused = await h.service.handle({ sessionId: b.sessionId, event: { type: "probe", token: tokenOf(b), answer: "confirm" } });
    expect(refused.entries.at(-1)!.text).toContain("另一个接入对话的探针还在等待");
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(await readFile(h.hookFile, "utf8")).toContain(first.id);
    await h.service.handle({ sessionId: a.sessionId, event: { type: "cancel-probe" } });
    await h.service.handle({ sessionId: a.sessionId, event: { type: "await-probe" } });
    expect(await hooksIn(h.hookFile)).toBe(false);
  });
});

describe("AS-R06, AS-R07: the probes folder at start, and the record limit", () => {
  it("clears a corrupt marker's records in the same pass", async () => {
    const h = await harness([]);
    await mkdir(join(h.probes, "probe-abcdefgh1234"), { recursive: true });
    await writeFile(join(h.probes, "probe-abcdefgh1234", "00.json"), JSON.stringify({ private_sample: "SYNTHETIC-SECRET" }));
    await writeFile(join(h.probes, "probe-abcdefgh1234.json"), "not json");
    await h.service.cleanupLeftovers();
    expect(await readdir(h.probes)).toEqual([]);
  });

  it("writes no more than the limit, 64 hooks at once", async () => {
    const h = await harness([PROBE_STEP]);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    let ready!: () => void;
    const all = new Promise<void>((resolve) => { ready = resolve; });
    const calls = Array.from({ length: 64 }, (_, index) => runProbeHook(marker.id, "Stop", {
      environment: { PARASELF_CLIENT_PROBES: h.probes },
      readInput: async () => { if (++entered === 64) ready(); await gate; return { index }; },
    }));
    await all;
    release();
    await Promise.all(calls);
    expect((await readdir(join(h.probes, marker.id))).length).toBe(20);
    await h.service.shutdown();
  });
});

describe("AS-R08, AS-R09: nothing of the machine or the sample reaches the model", () => {
  it("leaves a help's paths out, and runs the check from an empty folder of its own", async () => {
    const home = "/Users/SYNTHETIC-PRIVATE-PERSON";
    const output = `Usage kimi\nConfig: ${home}/projects/SECRET-PROJECT/settings.json\nalso /home/someone/x and SYNTHETIC-PRIVATE-PERSON's id 0f8e7d6c-1234-4abc-9def-001122334455`;
    expect(forModel(output, home)).toBe("Usage kimi\nConfig: ~/projects/SECRET-PROJECT/settings.json\nalso /home/‹用户›/x and ‹用户›'s id ‹值›");
    const h = await harness([{ action: "confirm_command", command: "kimi" }, { action: "check_command", args: ["--help"] }, REPLY], {
      runCommand: async () => ({ exitCode: 0, output: "Usage kimi\nConfig: /Users/SYNTHETIC-PRIVATE-PERSON/projects/SECRET-PROJECT/settings.json", timedOut: false }),
    });
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "command", answer: "confirm" });
    expect(h.requests.at(-1)!.userPrompt).not.toContain("SYNTHETIC-PRIVATE-PERSON");
    const tool = join(h.root, "pwd-tool");
    await writeFile(tool, "#!/bin/sh\npwd\nls -A\n");
    await chmod(tool, 0o755);
    const run = await runCommandCheck(tool, ["--help"], { PATH: "/bin:/usr/bin" });
    const lines = run.output.trim().split("\n");
    expect(lines).toEqual([expect.stringMatching(/paraself-check-/u)]);
    await expect(readdir(lines[0]!)).rejects.toThrow();
  });

  it("refuses a mapping under a key that changes with each session, and says no such key", async () => {
    const uuid = "0f8e7d6c-1234-4abc-9def-001122334455";
    const h = await harness([PROBE_STEP, REPLY], FAST);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    const caught = [
      { event: "UserPromptSubmit", receivedAt: 1, transcripts: [], input: { session_id: "s", cwd: "/w", sessions: { [uuid]: { prompt: probePhrase(marker.secret) } } } },
      { event: "Stop", receivedAt: 2, transcripts: [], input: { session_id: "s", cwd: "/w", sessions: { [uuid]: { reply: marker.secret } } } },
    ];
    for (const [index, record] of caught.entries()) await writeFile(join(h.probes, marker.id, `0${index}.json`), JSON.stringify(record));
    await h.send({ type: "await-probe" });
    const told = h.requests.at(-1)!.userPrompt;
    expect(told).toContain("随会话变化的键");
    expect(told).not.toContain("0f8e7d6c");
  });
});

const SECRET = "DECISION-ABCDEF";
const probe = { hooks: { file: "~/.fake/hooks.json", format: "claude" as const }, events: ["Prompt", "Stop"], secret: SECRET };
const records: ClientProbeRecord[] = [
  { event: "Prompt", receivedAt: 1, transcripts: [], input: { session_id: "session-one", cwd: "/synthetic/work", prompt: probePhrase(SECRET) } },
  { event: "Stop", receivedAt: 2, transcripts: [], input: { session_id: "session-one", cwd: "/synthetic/work", prompt: probePhrase(SECRET), reply: SECRET } },
];
const plan = {
  id: "fake", name: "Fake", shortName: "F", hooks: probe.hooks,
  prompt: { event: "Prompt", field: "prompt" }, reply: { event: "Stop", source: "field" as const, field: "reply" },
  fields: { sessionId: "session_id", cwd: "cwd" }, mcp: { mode: "none" as const },
};

describe("AS-R10: the fields are the program's, checked as they were found", () => {
  const context = { command: null, mcpAddSeen: false };

  it("passes the mapping found", () => {
    expect(checkPlan(plan, records, probe, context).problems).toEqual([]);
  });

  it("refuses the prompt repeated at the turn's end as the reply", () => {
    expect(checkPlan({ ...plan, reply: { event: "Stop", source: "field", field: "prompt" } }, records, probe, context).problems.join()).toContain("回复");
  });

  it("refuses a session or turn field whose value differs between the prompt and the reply", () => {
    const mismatched = records.map((record) => ({ ...record, input: { ...(record.input as object), request_id: record.event === "Prompt" ? "one" : "two" } }));
    expect(checkPlan({ ...plan, fields: { sessionId: "request_id", cwd: "cwd" } }, mismatched, probe, context).problems.join()).toContain("不是会话 id");
    expect(checkPlan({ ...plan, fields: { sessionId: "session_id", cwd: "cwd", turnId: "request_id" } }, mismatched, probe, context).problems.join()).toContain("不是轮次 id");
  });

  it("fills the fields itself, whatever the model wrote for them", async () => {
    const wrong = { ...CLIENT, command: undefined, prompt: { event: "Stop", field: "prompt" }, reply: { event: "Stop", source: "field", field: "prompt" }, fields: { sessionId: "note", cwd: "note" } };
    const h = await harness([PROBE_STEP, { action: "propose", client: wrong }], FAST);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    await h.catchTurn(await h.marker());
    const view = await h.send({ type: "await-probe" });
    expect(view.card).toMatchObject({
      kind: "plan",
      client: {
        prompt: { event: "UserPromptSubmit", field: "prompt" },
        reply: { event: "Stop", source: "field", field: "last_assistant_message" },
        fields: { sessionId: "session_id", cwd: "cwd" },
      },
      preview: { sessionId: VALUES.session },
    });
  });
});

describe("AS-R11: a session id is an id field", () => {
  it("takes session_id over a shorter kind field, and refuses two id fields that disagree", () => {
    const withKind = records.map((record) => ({ ...record, input: { ...(record.input as object), chat_type: "interactive" } }));
    expect(inferMapping(withKind, probe)).toMatchObject({ ok: true, mapping: { fields: { sessionId: "session_id" } } });
    const twoIds = records.map((record) => ({ ...record, input: { ...(record.input as object), thread_id: "thread-9" } }));
    expect(inferMapping(twoIds, probe)).toMatchObject({ ok: false, reasons: [expect.stringContaining("分不清")] });
  });
});

describe("AS-R12: each step is the selected model's", () => {
  it("uses the model selected since, and says so of a small local one", async () => {
    const h = await harness([REPLY, REPLY, REPLY]);
    const first = await h.service.handle({ sessionId: null, profileId: "remote", event: { type: "message", text: "开始" } });
    expect(first.weakModel).toBe(false);
    const second = await h.service.handle({ sessionId: first.sessionId, profileId: "qwen", event: { type: "message", text: "换成本地" } });
    expect(second.weakModel).toBe(true);
    await h.service.handle({ sessionId: first.sessionId, profileId: "remote", event: { type: "message", text: "再换回去" } });
    expect(h.gateway.generate.mock.calls.map((call) => (call as unknown[])[3])).toEqual(["remote", "qwen", "remote"]);
  });
});

describe("integration: a tool Paraself ships, and MCP by configuration file", () => {
  it("says a tool already built in is to be connected on the 接入 page, and refuses its command and id", async () => {
    const h = await harness([{ action: "confirm_command", command: "qwen" }, { action: "reply", message: "Qwen Code 已经内置", end: true }]);
    const view = await h.send({ type: "message", text: "我想接入 Qwen Code" });
    expect(view.card).toBeNull();
    const told = h.requests.map((request) => request.userPrompt).join("\n");
    expect(told).toContain("用户提到的 Qwen Code 已经内置在 Paraself 里");
    expect(h.requests[1]!.userPrompt).toContain("上一步（confirm_command）没有执行：Qwen Code 已经内置");
    expect(h.requests[0]!.systemPrompt).toContain("Qoder CLI（qodercli）");
    expect(view.status).toBe("ended");
  });

  it("refuses a plan whose id, name or command is a shipped tool's", async () => {
    const h = await harness([PROBE_STEP, { action: "propose", client: { ...CLIENT, id: "qwen-code" } }, { action: "propose", client: { ...CLIENT, id: "my-tool", name: "Codex" } }, REPLY], FAST);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    await h.catchTurn(await h.marker());
    const view = await h.send({ type: "await-probe" });
    expect(view.card).toBeNull();
    const told = h.requests.at(-1)!.userPrompt;
    expect(told).toContain("和内置的 Qwen Code 重复了");
    expect(told).toContain("和内置的 Codex 重复了");
  });

  it("proposes MCP by the client's own configuration file without mcp add in its help, and shows it on the card", async () => {
    const mcp = { mode: "file", file: "~/.fake/settings.json" };
    const h = await harness([PROBE_STEP, { action: "propose", client: { ...CLIENT, mcp } }], FAST);
    await h.send({ type: "message", text: "接入" });
    await h.send({ type: "probe", answer: "confirm" });
    await h.catchTurn(await h.marker());
    const view = await h.send({ type: "await-probe" });
    expect(view.card).toMatchObject({ kind: "plan", client: { mcp } });
  });
});
