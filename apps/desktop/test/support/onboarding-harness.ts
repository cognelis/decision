/** The 接入新工具 service in a home of its own, with a scripted model, the real installer and a fake command. */
import { installIntegrations, probeDescriptor, removeIntegrations } from "@cognelis/decision-integrations";
import type { ClientProbeMarker, ModelProviderProfile, OnboardingView, StructuredGenerationRequest } from "@cognelis/decision-protocol";
import { chmod, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import {
  ClientOnboardingService,
  commandEnvironment,
  listHomeDirectory,
  runCommandCheck,
  type ClientOnboardingOptions,
} from "../../src/main/client-onboarding-service.js";
import { probePhrase } from "../../src/main/client-probe-inference.js";
import { ProfiledModelGatewayError } from "../../src/main/model/profiled-model-gateway.js";

export const PROFILE = { profileId: "remote", label: "远端", kind: "openai", enabled: true, priority: 1 } as unknown as ModelProviderProfile;
export const LOCAL = { profileId: "qwen", label: "Qwen", kind: "qwen", enabled: true, priority: 2 } as unknown as ModelProviderProfile;

export const BRIDGE = "/opt/Decision/decision-bridge";
const HELP: Record<string, string> = {
  "--help": "Usage: kimi [prompt]\nCommands: hooks, mcp",
  "hooks --help": "Hooks live in ~/.fake/hooks.json, in Claude Code's format.",
};

/** Values a probe catches: none of them may reach a prompt. */
export const VALUES = { session: "sess-PRIVATE-4f1c", cwd: "/private/work/zz-secret", note: "VALUE-ONLY-IN-SAMPLE", reason: "end_turn" };

type Step = Record<string, unknown> | Error;

export const harness = async (steps: Step[], overrides: Partial<ClientOnboardingOptions> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "decision-onboarding-"));
  const home = join(root, "home");
  const userData = join(root, "user-data");
  const probes = join(userData, "client-probes");
  const bin = join(root, "bin");
  await mkdir(join(home, ".fake"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "kimi"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "kimi"), 0o755);
  let path = bin;
  const hookFile = join(home, ".fake", "hooks.json");
  const theirs = { hooks: { Stop: [{ hooks: [{ type: "command", command: "~/bin/notify.sh" }] }] } };
  await writeFile(hookFile, JSON.stringify(theirs));
  const requests: StructuredGenerationRequest[] = [];
  const queue = [...steps];
  const gateway = {
    listGenerationProfiles: vi.fn(async () => [PROFILE, LOCAL]),
    generate: vi.fn(async (request: StructuredGenerationRequest, parse: (value: unknown) => unknown) => {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) throw new ProfiledModelGatewayError("脚本用完了");
      if (next instanceof Error) throw next;
      return { parsedOutput: parse(next) } as never;
    }),
  };
  const runCommand = vi.fn(async (_path: string, args: readonly string[]) => ({ exitCode: 0, output: HELP[args.join(" ")] ?? "", timedOut: false }));
  const connect = vi.fn(async () => ({ connected: true, detail: "以后会自动记录。" }));
  const install = vi.fn<ClientOnboardingOptions["install"]>((client, path, checkTarget) =>
    installIntegrations({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget }));
  const remove = vi.fn<ClientOnboardingOptions["remove"]>((client, path, checkTarget) =>
    removeIntegrations({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget }));
  const options: ClientOnboardingOptions = {
    gateway,
    probesDirectory: probes,
    home,
    platform: "darwin",
    environment: () => ({ PATH: path }),
    protectedDirectories: () => [userData],
    customClients: () => [],
    install,
    remove,
    connect,
    runCommand,
    timing: { pollMs: 10, settleMs: 30, waitMs: 4_000 },
    ...overrides,
  };
  const service = new ClientOnboardingService(options);
  let sessionId: string | null = null;
  let shown: OnboardingView["card"] = null;
  /** An answer to the card on show carries its token, as the renderer's does; one given explicitly is sent as it is. */
  const send = async (event: { type: string } & Record<string, unknown>): Promise<OnboardingView> => {
    const answer = ["command", "probe", "plan"].includes(event.type) && !("token" in event)
      ? { ...event, token: shown !== null && "token" in shown ? shown.token : "nocardshown00000000" }
      : event;
    const view = await service.handle({ sessionId, profileId: "remote", event: answer as never });
    sessionId = view.sessionId;
    shown = view.card;
    return view;
  };
  const marker = async (): Promise<ClientProbeMarker> => {
    const name = (await readdir(probes)).find((entry) => entry.endsWith(".json"))!;
    return JSON.parse(await readFile(join(probes, name), "utf8")) as ClientProbeMarker;
  };
  /** What the bridge would write for the tool's two events. */
  const catchTurn = async (probe: ClientProbeMarker) => {
    await mkdir(join(probes, probe.id), { recursive: true });
    const common = { session_id: VALUES.session, cwd: VALUES.cwd, note: VALUES.note };
    await writeFile(join(probes, probe.id, "1-a.json"), JSON.stringify({ event: "UserPromptSubmit", receivedAt: 1, input: { ...common, prompt: probePhrase(probe.secret) }, transcripts: [] }));
    await writeFile(join(probes, probe.id, "2-b.json"), JSON.stringify({ event: "Stop", receivedAt: 2, input: { ...common, reason: VALUES.reason, last_assistant_message: probe.secret }, transcripts: [] }));
  };
  /** The PATH a terminal now has. */
  const setPath = (next: string) => { path = next; };
  /** The next start: another service on the same disk, its own run's probes none of these. */
  const restart = () => new ClientOnboardingService(options);
  return { root, home, probes, hookFile, theirs, service, send, marker, catchTurn, requests, gateway, runCommand, connect, install, remove, queue, setPath, restart };
};

export const PROBE_STEP = { action: "probe", file: "~/.fake/hooks.json", format: "claude", events: ["UserPromptSubmit", "Stop"], message: "装个探针看看" };
export const CLIENT = {
  id: "kimi", name: "Kimi CLI", shortName: "KM", command: "kimi",
  hooks: { file: "~/.fake/hooks.json", format: "claude" },
  prompt: { event: "UserPromptSubmit", field: "prompt" },
  reply: { event: "Stop", source: "field", field: "last_assistant_message" },
  fields: { sessionId: "session_id", cwd: "cwd" },
  mcp: { mode: "none" },
};

