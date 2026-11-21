import { installIntegrations, probeDescriptor } from "@cognelis/decision-integrations";
import type { ClientProbeMarker } from "@cognelis/decision-protocol";
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { commandEnvironment, listHomeDirectory, runCommandCheck } from "../src/main/client-onboarding-service.js";
import { probePhrase } from "../src/main/client-probe-inference.js";
import { ProfiledModelGatewayError } from "../src/main/model/profiled-model-gateway.js";
import { BRIDGE, CLIENT, harness, PROBE_STEP, VALUES } from "./support/onboarding-harness.js";

describe("the 接入新工具 conversation", () => {
  it("walks command, checks, probe and plan, connects what the reader confirmed, and tells the model no value the tool sent", async () => {
    const h = await harness([
      { action: "confirm_command", command: "kimi", message: "是 kimi 吗？" },
      { action: "check_command", args: ["--help"] },
      { action: "check_command", args: ["hooks", "--help"] },
      PROBE_STEP,
      // Its own part wrong (an id no client may have): refused, and why said back. Its fields, wrong too, are overridden.
      { action: "propose", client: { ...CLIENT, id: "Kimi CLI", fields: { sessionId: "sid", cwd: "cwd" } } },
      { action: "propose", client: CLIENT, message: "请确认" },
    ]);
    let view = await h.send({ type: "message", text: "我想接入 Kimi CLI" });
    expect(view.card).toMatchObject({ kind: "command", command: "kimi" });
    expect(view.weakModel).toBe(false);
    view = await h.send({ type: "command", answer: "confirm" });
    expect(h.runCommand.mock.calls.map(([path, args]) => [path.endsWith("/bin/kimi"), args.join(" ")])).toEqual([[true, "--help"], [true, "hooks --help"]]);
    expect(view.card).toMatchObject({ kind: "probe", file: "~/.fake/hooks.json" });
    expect(await readFile(h.hookFile, "utf8")).not.toContain("hook probe");

    view = await h.send({ type: "probe", answer: "confirm" });
    expect(view.status).toBe("waiting");
    const probe = await h.marker();
    expect(view.card).toMatchObject({ kind: "waiting", phrase: probePhrase(probe.secret) });
    expect(await readFile(h.hookFile, "utf8")).toContain(`hook probe ${probe.id} Stop`);
    const waited = h.send({ type: "await-probe" });
    await h.catchTurn(probe);
    view = await waited;

    // Taken out, its marker and what it caught gone; the reader's own hook as it was.
    expect(JSON.parse(await readFile(h.hookFile, "utf8"))).toEqual(h.theirs);
    expect(await readdir(h.probes)).toEqual([]);
    expect(view.entries.map((entry) => entry.text)).toContainEqual(expect.stringContaining("探针已移除"));
    expect(view.card).toMatchObject({ kind: "plan", client: { id: "kimi", complete: { field: "reason", values: ["end_turn"] } }, preview: { sessionId: VALUES.session, cwd: VALUES.cwd } });
    // The first proposal, refused, went back with why.
    expect(h.requests.at(-1)!.userPrompt).toContain("方案没有通过");

    view = await h.send({ type: "plan", answer: "confirm" });
    expect(h.connect).toHaveBeenCalledWith(expect.objectContaining({ id: "kimi", fields: { sessionId: "session_id", cwd: "cwd" } }));
    expect(view.status).toBe("ended");

    const told = h.requests.map((request) => `${request.systemPrompt}\n${request.userPrompt}`).join("\n");
    for (const value of [...Object.values(VALUES), probe.secret]) expect(told).not.toContain(value);
    expect(told).toContain("last_assistant_message: 文本（含暗号）");
    expect(h.requests.every((request) => request.purpose === "client-onboarding")).toBe(true);
  });

  it("checks only the command confirmed, only with the listed arguments", async () => {
    const h = await harness([
      { action: "check_command", args: ["--help"] },
      { action: "reply", message: "先确认命令" },
    ]);
    await h.send({ type: "message", text: "接入 kimi" });
    expect(h.runCommand).not.toHaveBeenCalled();
    expect(h.requests[1]!.userPrompt).toContain("还没有确认过的命令名");
    h.queue.push(
      { action: "confirm_command", command: "kimi; rm -rf ~" },
      { action: "confirm_command", command: "kimi" },
    );
    const view = await h.send({ type: "message", text: "是 kimi" });
    expect(view.card).toMatchObject({ kind: "command", command: "kimi" });
    h.queue.push(
      { action: "check_command", command: "claude", args: ["--help"] },
      { action: "check_command", args: ["mcp", "add", "decision", "--", "x"] },
      { action: "check_command", args: ["login"] },
      { action: "confirm_command", command: "claude" },
      { action: "check_command", args: ["--version"] },
      { action: "reply", message: "好了" },
    );
    await h.send({ type: "command", answer: "confirm" });
    expect(h.runCommand.mock.calls.map(([, args]) => args.join(" "))).toEqual(["--version"]);
    const told = h.requests.at(-1)!.userPrompt;
    expect(told).toContain("只能检查确认过的 kimi");
    expect(told).toContain("args 只能是");
    expect(told).toContain("命令名已经确认为 kimi，不能换");
  });

  it("runs a check without a shell, its credentials left out, marked as the App's own, stopped at five seconds", async () => {
    expect(commandEnvironment({ PATH: "/bin", OPENAI_API_KEY: "sk", GITHUB_TOKEN: "t", db_password: "p", AWS_SECRET_ACCESS_KEY: "s", MY_CREDENTIALS: "c", HOME: "/h" }))
      .toEqual({ PATH: "/bin", HOME: "/h", PARASELF_PROVIDER_CHILD: "1", DECISION_PROVIDER_CHILD: "1", NO_COLOR: "1" });
    const root = await mkdtemp(join(tmpdir(), "paraself-check-"));
    const tool = join(root, "tool");
    await writeFile(tool, '#!/bin/sh\necho "child=$PARASELF_PROVIDER_CHILD key=$OPENAI_API_KEY args=$*"\n[ "$1" = "--version" ] && exit 0\nsleep 30\n');
    await chmod(tool, 0o755);
    const run = await runCommandCheck(tool, ["--version"], { PATH: "/bin:/usr/bin", OPENAI_API_KEY: "sk-live" });
    expect(run).toEqual({ exitCode: 0, output: "child=1 key= args=--version\n", timedOut: false });
    const started = Date.now();
    const stuck = await runCommandCheck(tool, ["--help"], { PATH: "/bin:/usr/bin" });
    expect(stuck.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(9_000);
  }, 15_000);

  it("lists names under the home folder only, follows no link, and leaves Paraself's own data out", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-list-"));
    const home = join(root, "home");
    const data = join(home, "Library", "Paraself");
    await mkdir(join(home, ".fake", "sessions", "deep", "deeper"), { recursive: true });
    await mkdir(data, { recursive: true });
    await writeFile(join(home, ".fake", "hooks.json"), "{\"secret\":\"not read\"}");
    await writeFile(join(data, "settings.json"), "{}");
    await symlink(join(root), join(home, ".fake", "out"));
    await symlink(join(root), join(home, "linked"));
    const options = { home, protectedDirectories: [data] };
    const listed = await listHomeDirectory("~/.fake", options);
    expect(listed.split("\n")).toEqual(["hooks.json", "out@（符号链接，不跟随）", "sessions/", "sessions/deep/"]);
    expect(listed).not.toContain("not read");
    expect(await listHomeDirectory("~/Library", options)).toBe("Paraself/（Paraself 自己的数据，不列出）");
    for (const path of ["~/../x", "/etc", "~/.fake/../..", "~//x", "~/./x", "~\\x"]) await expect(listHomeDirectory(path, options)).rejects.toThrow();
    await expect(listHomeDirectory("~/linked", options)).rejects.toThrow("符号链接");
    await expect(listHomeDirectory("~/Library/Paraself", options)).rejects.toThrow("Paraself 自己的数据");
    await expect(listHomeDirectory("~/.fake/hooks.json", options)).rejects.toThrow("不是目录");
  });

  it("takes the probe out when the reader cancels it, and again when the model fails afterwards", async () => {
    const h = await harness([{ action: "confirm_command", command: "kimi" }, PROBE_STEP]);
    await h.send({ type: "message", text: "接入 kimi" });
    h.queue.length = 0;
    h.queue.push(PROBE_STEP);
    await h.send({ type: "command", answer: "none" });
    await h.send({ type: "probe", answer: "confirm" });
    const waited = h.send({ type: "await-probe" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.send({ type: "cancel-probe" });
    const view = await waited;
    expect(view.status).toBe("idle");
    expect(view.entries.at(-1)!.text).toContain("用户取消），收到 0 个事件");
    expect(JSON.parse(await readFile(h.hookFile, "utf8"))).toEqual(h.theirs);
    expect(await readdir(h.probes)).toEqual([]);

    // A model that cannot go on once the probe is in: the conversation hands back, and nothing is left in.
    h.queue.push(PROBE_STEP);
    await h.send({ type: "message", text: "再来一次" });
    await h.send({ type: "probe", answer: "confirm" });
    h.queue.push(new ProfiledModelGatewayError("坏了", "invalid_output"), new ProfiledModelGatewayError("坏了", "invalid_output"));
    const failing = h.send({ type: "await-probe" });
    await h.catchTurn(await h.marker());
    const after = await failing;
    expect(after.status).toBe("idle");
    expect(after.entries.at(-1)!.text).toContain("模型这次没有给出可用的一步");
    expect(JSON.parse(await readFile(h.hookFile, "utf8"))).toEqual(h.theirs);
    expect(await readdir(h.probes)).toEqual([]);
  });

  it("ends the wait only when both secrets are in, on 结束等待, the limit or the time, and reads what 结束等待 kept", async () => {
    const h = await harness([{ action: "confirm_command", command: "kimi" }, PROBE_STEP]);
    await h.send({ type: "message", text: "接入 kimi" });
    h.queue.length = 0;
    h.queue.push(PROBE_STEP);
    await h.send({ type: "command", answer: "none" });
    await h.send({ type: "probe", answer: "confirm" });
    const probe = await h.marker();
    let settled = false;
    const waited = h.send({ type: "await-probe" }).finally(() => { settled = true; });
    // The prompt alone, and then nothing: no going quiet ends it.
    await mkdir(join(h.probes, probe.id), { recursive: true });
    await writeFile(join(h.probes, probe.id, "1-a.json"), JSON.stringify({ event: "UserPromptSubmit", receivedAt: 1, input: { session_id: VALUES.session, cwd: VALUES.cwd, prompt: probePhrase(probe.secret) }, transcripts: [] }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(settled).toBe(false);
    h.queue.push({ action: "reply", message: "只收到了提问" });
    await h.send({ type: "finish-probe" });
    const view = await waited;
    expect(view.entries.map((entry) => entry.text)).toContainEqual(expect.stringContaining("用户结束等待），收到 1 个事件。探针已移除"));
    // Read, not dropped: the model is told what came, and why the fields could not all be worked out.
    expect(h.requests.at(-1)!.userPrompt).toContain("prompt: 文本（含整句暗号）");
    expect(h.requests.at(-1)!.userPrompt).toContain("没能从探针样本推断出映射");
    expect(JSON.parse(await readFile(h.hookFile, "utf8"))).toEqual(h.theirs);
    expect(await readdir(h.probes)).toEqual([]);

    // A reply read off a transcript counts as the second secret.
    h.queue.push(PROBE_STEP);
    await h.send({ type: "message", text: "再来" });
    await h.send({ type: "probe", answer: "confirm" });
    const second = await h.marker();
    const again = h.send({ type: "await-probe" });
    await mkdir(join(h.probes, second.id), { recursive: true });
    const common = { session_id: VALUES.session, cwd: VALUES.cwd, transcript_path: "/x/t.jsonl" };
    await writeFile(join(h.probes, second.id, "1-a.json"), JSON.stringify({ event: "UserPromptSubmit", receivedAt: 1, input: { ...common, prompt: probePhrase(second.secret) }, transcripts: [] }));
    await writeFile(join(h.probes, second.id, "2-b.json"), JSON.stringify({ event: "Stop", receivedAt: 2, input: common, transcripts: [{ field: "transcript_path", format: "claude", matched: true }] }));
    h.queue.push({ action: "reply", message: "收齐了" });
    expect((await again).entries.map((entry) => entry.text)).toContainEqual(expect.stringContaining("（收到事件），收到 2 个事件"));
  });

  it("takes out what a failed install left, refuses a probe in Paraself's own data, and is not stuck by a model that fails", async () => {
    const h = await harness([{ action: "confirm_command", command: "kimi" }], {
      install: vi.fn(async () => { throw new Error("写不进去"); }),
    });
    await h.send({ type: "message", text: "接入 kimi" });
    h.queue.push(PROBE_STEP, { action: "reply", message: "没装上，换个办法" });
    await h.send({ type: "command", answer: "none" });
    const view = await h.send({ type: "probe", answer: "confirm" });
    expect(view.status).toBe("idle");
    expect(view.entries.map((entry) => entry.text)).toContainEqual(expect.stringContaining("探针没装上：写不进去"));
    expect(h.remove).toHaveBeenCalled();
    expect(await readdir(h.probes)).toEqual([]);

    h.queue.push({ ...PROBE_STEP, file: "~/../user-data/x.json" }, { ...PROBE_STEP, file: "~/.claude/hooks.json" }, { action: "reply", message: "换个文件" });
    const refused = await h.send({ type: "message", text: "装在别处" });
    expect(refused.card).toBeNull();
    expect(h.requests.at(-1)!.userPrompt).toContain("file 不对");
    expect(h.requests.at(-1)!.userPrompt).toContain("这是 Claude Code 的钩子配置文件");

    h.queue.push(new Error("not a model error"));
    const broken = await h.send({ type: "message", text: "继续" });
    expect(broken.status).toBe("idle");
    expect(broken.entries.at(-1)!.text).toContain("这一步出错了");
  });

  it("takes out at start a probe a quit or a crash left in, and drops records with no marker", async () => {
    const h = await harness([]);
    const left: ClientProbeMarker = {
      version: 1, id: "probe-leftover0001", secret: "DECISION-AAAA22",
      hooks: { file: "~/.fake/hooks.json", format: "claude" }, events: ["Stop"], createdAt: 1, expiresAt: 2,
    };
    await mkdir(join(h.probes, left.id), { recursive: true });
    await writeFile(join(h.probes, `${left.id}.json`), JSON.stringify(left));
    await writeFile(join(h.probes, left.id, "1.json"), "{}");
    await mkdir(join(h.probes, "probe-orphan000001"));
    await writeFile(join(h.probes, "probe-junk00000001.json"), "not json");
    await installIntegrations({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [probeDescriptor(left)], paths: { [left.id]: h.hookFile } });
    expect(await readFile(h.hookFile, "utf8")).toContain("hook probe probe-leftover0001 Stop");
    expect(await h.service.cleanupLeftovers()).toEqual({ removed: 1, failed: [] });
    expect(JSON.parse(await readFile(h.hookFile, "utf8"))).toEqual(h.theirs);
    expect(await readdir(h.probes)).toEqual([]);
  });

  it("says a small local model may not do well, refuses a session it no longer knows, and lets one go on close", async () => {
    const h = await harness([{ action: "reply", message: "你好" }]);
    const view = await h.service.handle({ sessionId: null, profileId: "qwen", event: { type: "message", text: "接入" } });
    expect(view.weakModel).toBe(true);
    await expect(h.service.handle({ sessionId: "onb-gone00", event: { type: "message", text: "x" } })).rejects.toThrow("已经结束");
    expect((await h.service.handle({ sessionId: view.sessionId, event: { type: "close" } })).status).toBe("ended");
    await expect(h.service.handle({ sessionId: view.sessionId, event: { type: "message", text: "x" } })).rejects.toThrow("已经结束");
  });
});
