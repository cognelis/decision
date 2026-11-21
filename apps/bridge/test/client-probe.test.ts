import { detectIntegrationStatus, hookBridgeReference, installIntegrations, probeDescriptor, removeIntegrations } from "@cognelis/decision-integrations";
import { CLIENT_PROBE_LIMITS, supportedHookFormats, type ClientProbeMarker } from "@cognelis/decision-protocol";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { main, readHookInput } from "../src/cli.js";
import { runProbeHook } from "../src/client-probe.js";

const NOW = 1_800_000_000_000;

const harness = async (marker: Partial<ClientProbeMarker> = {}, write = true) => {
  const root = await mkdtemp(join(tmpdir(), "decision-probe-"));
  const probes = join(root, "client-probes");
  await mkdir(probes);
  const full: ClientProbeMarker = {
    version: 1,
    id: "probe-abcdefgh1234",
    secret: "DECISION-7F3K2Q",
    hooks: { file: "~/.fake/hooks.json", format: "claude" },
    events: ["UserPromptSubmit", "Stop"],
    createdAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...marker,
  };
  // The App makes the records folder with the marker; the bridge makes none.
  if (write) {
    await writeFile(join(probes, `${full.id}.json`), JSON.stringify(full));
    await mkdir(join(probes, full.id));
  }
  const environment = { PARASELF_CLIENT_PROBES: probes };
  const records = async () => (await readdir(join(probes, full.id)).catch(() => [] as string[])).filter((name) => name.endsWith(".json"));
  const fire = (event: string, input: unknown, id = full.id) =>
    runProbeHook(id, event, { environment, readInput: async () => input, now: () => NOW });
  return { root, probes, marker: full, environment, records, fire };
};

afterEach(() => vi.restoreAllMocks());

describe("hook probe <id> <event>", () => {
  it("records an event while its probe stands, and which transcript format holds the secret", async () => {
    const { root, probes, marker, records, fire } = await harness();
    const transcript = join(root, "t.jsonl");
    await writeFile(transcript, [
      { type: "user", message: { role: "user", content: "请原样回复：DECISION-7F3K2Q" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "`DECISION-7F3K2Q`" }] } },
    ].map((line) => JSON.stringify(line)).join("\n"));
    expect(await fire("Stop", { session_id: "s1", cwd: "/work", transcript_path: transcript })).toBe(0);
    const [name] = await records();
    const record = JSON.parse(await readFile(join(probes, marker.id, name!), "utf8"));
    expect(record).toMatchObject({ event: "Stop", receivedAt: NOW, input: { session_id: "s1" } });
    expect(record.transcripts).toContainEqual({ field: "transcript_path", format: "claude", matched: true });
    // A read that did not hold the secret is not kept.
    expect(record.transcripts.every((entry: { matched: boolean }) => entry.matched)).toBe(true);
    expect(record.transcripts).not.toContainEqual(expect.objectContaining({ format: "antigravity" }));
  });

  it("records nothing with no marker, an expired one, one that claims too long a life, or an event it does not listen on", async () => {
    const none = await harness({}, false);
    expect(await none.fire("Stop", { a: 1 })).toBe(0);
    expect(await none.records()).toEqual([]);
    const expired = await harness({ expiresAt: NOW });
    expect(await expired.fire("Stop", { a: 1 })).toBe(0);
    expect(await expired.records()).toEqual([]);
    const tooLong = await harness({ createdAt: NOW - 1_000, expiresAt: NOW - 1_000 + CLIENT_PROBE_LIMITS.lifetimeMs + 1 });
    expect(await tooLong.fire("Stop", { a: 1 })).toBe(0);
    expect(await tooLong.records()).toEqual([]);
    const other = await harness();
    expect(await other.fire("SessionStart", { a: 1 })).toBe(0);
    expect(await other.fire("Stop", { a: 1 }, "probe-zzzzzzzz9999")).toBe(0);
    expect(await other.fire("Stop", { a: 1 }, "../escape")).toBe(0);
    expect(await other.records()).toEqual([]);
  });

  it("holds every probe to the record count and the input size", async () => {
    const { records, fire } = await harness();
    for (let index = 0; index < CLIENT_PROBE_LIMITS.records + 3; index += 1) await fire("Stop", { index });
    expect(await records()).toHaveLength(CLIENT_PROBE_LIMITS.records);
    const big = await harness({ id: "probe-bigbigbig0001" });
    const input = JSON.stringify({ text: "x".repeat(CLIENT_PROBE_LIMITS.inputBytes) });
    expect(await runProbeHook("probe-bigbigbig0001", "Stop", {
      environment: big.environment,
      readInput: (maximum) => readHookInput(Readable.from([Buffer.from(input)]), maximum),
      now: () => NOW,
    })).toBe(0);
    expect(await big.records()).toEqual([]);
  });

  it("prints nothing, exits 0, and does nothing in a model call the App started", async () => {
    const { records, environment, marker } = await harness({ createdAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000 });
    const write = vi.spyOn(process.stdout, "write");
    const printJson = vi.fn();
    expect(await main(["hook", "probe", marker.id, "Stop"], { environment: { ...environment, PARASELF_PROVIDER_CHILD: "1" }, readStdin: async () => ({ a: 1 }), printJson })).toBe(0);
    expect(await records()).toEqual([]);
    expect(await main(["hook", "probe", marker.id, "Stop"], { environment, readStdin: async () => ({ a: 1 }), printJson })).toBe(0);
    expect(await records()).toHaveLength(1);
    expect(printJson).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("a probe's hooks", () => {
  it("go in and out through the installer, the reader's own hooks left as they were", async () => {
    const root = await mkdtemp(join(tmpdir(), "decision-probe-install-"));
    const path = join(root, "home", ".fake", "hooks.json");
    await mkdir(join(root, "home", ".fake"), { recursive: true });
    const theirs = { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }] }, theme: "dark" };
    await writeFile(path, JSON.stringify(theirs));
    const client = probeDescriptor({ id: "probe-abcdefgh1234", hooks: { file: "~/.fake/hooks.json", format: "claude" }, events: ["UserPromptSubmit", "Stop"] });
    const options = { bridgePath: "/opt/Paraself/paraself-bridge", platform: "darwin" as const, clients: [client], paths: { [client.id]: path }, runner: vi.fn() };
    await installIntegrations({ mode: "apply", ...options });
    const installed = await readFile(path, "utf8");
    expect(installed).toContain("PARASELF_HOOK=1 '/opt/Paraself/paraself-bridge' hook probe probe-abcdefgh1234 UserPromptSubmit");
    expect(installed).toContain("hook probe probe-abcdefgh1234 Stop");
    expect(options.runner).not.toHaveBeenCalled();
    await removeIntegrations({ mode: "apply", ...options });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(theirs);
  });
});

/** A file of each format with a hook of the reader's own in it; none for a format whose whole file is this app's. */
const THEIRS: Record<string, unknown> = {
  claude: { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }] }, theme: "dark" },
  antigravity: { mine: { Stop: [{ type: "command", command: "~/bin/notify.sh" }] } },
  flat: { version: 1, hooks: { Stop: [{ type: "command", command: "~/bin/notify.sh" }] } },
};

describe("a probe in every hook format", () => {
  it.each(supportedHookFormats())("goes in, reads as this app's, and comes out again: %s", async (format) => {
    const root = await mkdtemp(join(tmpdir(), "decision-probe-format-"));
    const path = join(root, "home", ".tool", "hooks.json");
    await mkdir(join(root, "home", ".tool"), { recursive: true });
    const theirs = THEIRS[format];
    if (theirs !== undefined) await writeFile(path, JSON.stringify(theirs));
    const client = probeDescriptor({ id: "probe-abcdefgh1234", hooks: { file: "~/.tool/hooks.json", format: format as never }, events: ["UserPromptSubmit", "Stop"] });
    const options = { bridgePath: "/opt/Paraself/paraself-bridge", platform: "darwin" as const, clients: [client], paths: { [client.id]: path } };
    await installIntegrations({ mode: "apply", ...options });
    // Twice: the first one's handlers read as this app's, and replaced, not doubled.
    await installIntegrations({ mode: "apply", ...options });
    const installed = await readFile(path, "utf8");
    expect(installed.match(/hook probe probe-abcdefgh1234 Stop/gu)).toHaveLength(1);
    expect(installed).toContain("hook probe probe-abcdefgh1234 UserPromptSubmit");
    const reference = hookBridgeReference(options.bridgePath, "darwin");
    expect(await detectIntegrationStatus(options.paths, reference, "darwin", [client])).toEqual({ [client.id]: "installed" });
    await removeIntegrations({ mode: "apply", ...options });
    if (theirs === undefined) await expect(readFile(path, "utf8")).rejects.toThrow();
    else expect(JSON.parse(await readFile(path, "utf8"))).toEqual(theirs);
    expect(await detectIntegrationStatus(options.paths, reference, "darwin", [client])).toEqual({ [client.id]: "not-installed" });
  });
});

describe("a transcript of every format the engine reads", () => {
  const SECRET = "DECISION-7F3K2Q";
  const TRANSCRIPTS: Record<string, unknown[]> = {
    // Copilot CLI's events.jsonl.
    copilot: [{ type: "user.message", data: { content: `请原样回复：${SECRET}` } }, { type: "assistant.message", data: { content: SECRET } }],
    // CodeBuddy Code's Responses-style items.
    codebuddy: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `请原样回复：${SECRET}` }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: SECRET }] },
    ],
    // Factory Droid's message lines.
    droid: [
      { type: "message", message: { role: "user", content: [{ type: "text", text: `请原样回复：${SECRET}` }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: SECRET }] } },
    ],
  };

  it.each(Object.keys(TRANSCRIPTS))("says the secret was read in it as %s", async (format) => {
    const { root, probes, marker, records, fire } = await harness();
    const transcript = join(root, `${format}.jsonl`);
    await writeFile(transcript, TRANSCRIPTS[format]!.map((line) => JSON.stringify(line)).join("\n"));
    await fire("Stop", { session_id: "s1", cwd: "/work", transcript_path: transcript });
    const [name] = await records();
    const record = JSON.parse(await readFile(join(probes, marker.id, name!), "utf8"));
    expect(record.transcripts).toContainEqual({ field: "transcript_path", format, matched: true });
  });
});
