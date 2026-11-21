// CL2-REVIEW-AS-4: who holds the probe changes in one lane alone, and a cleanup entry is written before a probe goes in.
// From the review's reproductions (rounds/CL2/review-as/r4: natural-race, standards/retry-race, spec/invariant-errors),
// scenario B's expectation as the lead settled it: a probe out whole is no failure for an entry that will not go.
import {
  inIntegrationsTurn,
  installIntegrationsWithinTurn,
  removeIntegrations,
  removeIntegrationsWithinTurn,
  type ClientDescriptor,
  type InstallReport,
} from "@cognelis/decision-integrations";
import type { OnboardingView } from "@cognelis/decision-protocol";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runProbeHook } from "../../bridge/src/client-probe.js";
import type { ClientOnboardingOptions } from "../src/main/client-onboarding-service.js";
import { BRIDGE, harness, PROBE_STEP } from "./support/onboarding-harness.js";

const REPLY = { action: "reply", message: "继续" };
type CheckTarget = Parameters<ClientOnboardingOptions["install"]>[2];
const tokenOf = (view: OnboardingView): string => (view.card !== null && "token" in view.card ? view.card.token : "");
const options = (client: ClientDescriptor, path: string, checkTarget: CheckTarget) =>
  ({ mode: "apply" as const, bridgePath: BRIDGE, platform: "darwin" as const, clients: [client], paths: { [client.id]: path }, checkTarget });
const failedOnce = (client: { id: string }, path: string): InstallReport =>
  ({ mode: "apply", targets: [{ client: client.id, path, changed: false, status: "failed", detail: "synthetic first removal failure" }], commands: [], restartRequired: false });

/** A's probe in, its hooks' first removal failing: held pending, B's and C's cards shown. */
const pendingThenTwo = async (remove: (call: number) => Promise<void> | void = () => undefined) => {
  let removals = 0;
  let installs = 0;
  const h = await harness([PROBE_STEP, PROBE_STEP, PROBE_STEP, REPLY, REPLY, REPLY], {
    timing: { waitMs: 600, pollMs: 5, settleMs: 5 },
    install: (client, path, checkTarget) => inIntegrationsTurn(async () => { installs += 1; return installIntegrationsWithinTurn(options(client, path, checkTarget)); }),
    remove: (client, path, checkTarget) => inIntegrationsTurn(async () => {
      removals += 1;
      if (removals === 1) return failedOnce(client, path);
      await remove(removals);
      return removeIntegrationsWithinTurn(options(client, path, checkTarget));
    }),
  });
  const views: OnboardingView[] = [];
  for (const text of ["A", "B", "C"]) views.push(await h.service.handle({ sessionId: null, event: { type: "message", text } }));
  const confirm = (view: OnboardingView) => h.service.handle({ sessionId: view.sessionId, event: { type: "probe", token: tokenOf(view), answer: "confirm" } });
  await confirm(views[0]!);
  await h.service.handle({ sessionId: views[0]!.sessionId, event: { type: "cancel-probe" } });
  const pending = await h.service.handle({ sessionId: views[0]!.sessionId, event: { type: "await-probe" } });
  expect(pending.entries.at(-1)!.text).toContain("没能清理干净");
  return { ...h, views, confirm, counts: () => ({ installs, removals }) };
};

describe("AS4-R01: one claim at a time, and only its holder lets the probe go", () => {
  it("lets one of two at once in after the pending one is out, and leaves nothing standing after the quit, ten times over", async () => {
    for (let round = 0; round < 10; round += 1) {
      const h = await pendingThenTwo();
      const [viewB, viewC] = await Promise.all([h.confirm(h.views[1]!), h.confirm(h.views[2]!)]);
      expect(h.counts().installs).toBe(2);
      expect([viewB.status, viewC.status].filter((status) => status === "waiting")).toHaveLength(1);
      await h.service.shutdown();
      expect(await readdir(h.probes)).toEqual([]);
      // Nothing left for a hook to record under.
      await runProbeHook("probe-abcdefgh1234", "Stop", { environment: { DECISION_CLIENT_PROBES: h.probes }, readInput: async () => ({ private_sample: "NATURAL-RACE-AFTER-SHUTDOWN" }) });
      expect(await readdir(h.probes)).toEqual([]);
    }
  }, 20_000);

  it("retries the pending one once for both, whatever they meet, and refuses the second", async () => {
    let entered!: () => void;
    let release!: () => void;
    const retrying = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await pendingThenTwo(async (call) => { if (call === 2) { entered(); await gate; } });
    const installB = h.confirm(h.views[1]!);
    await retrying;
    const installC = h.confirm(h.views[2]!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // C waits its turn behind B's claim: no second retry of A meanwhile.
    expect(h.counts().removals).toBe(2);
    release();
    const [viewB, viewC] = await Promise.all([installB, installC]);
    expect(viewB.status).toBe("waiting");
    expect(viewC.status).not.toBe("waiting");
    expect(viewC.entries.at(-1)!.text).toContain("另一个接入对话的探针还在等待");
    expect(h.counts()).toEqual({ installs: 2, removals: 2 });
    await h.service.shutdown();
    expect(await readdir(h.probes)).toEqual([]);
  });
});

describe("AS4-R02: the cleanup entry first, and what counts as pending", () => {
  it("A: an entry that cannot be written lets no probe in, said why", async () => {
    const h = await harness([PROBE_STEP, PROBE_STEP]);
    await mkdir(h.probes, { recursive: true });
    await writeFile(join(h.probes, "cleanup"), "synthetic-invalid-path");
    await h.send({ type: "message", text: "A" });
    const refused = await h.send({ type: "probe", answer: "confirm" });
    expect(refused.entries.some((entry) => entry.text.includes("清理记录") && entry.text.includes("写不进去"))).toBe(true);
    expect(refused.status).not.toBe("waiting");
    expect(h.install).not.toHaveBeenCalled();
    expect((await readdir(h.probes)).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(await readFile(h.hookFile, "utf8")).not.toContain("hook probe");
  });

  it("B: an entry that will not go once the probe is out whole is noted, not a failure, and the next start takes it", async () => {
    const diagnose = vi.fn();
    let removals = 0;
    let probes = "";
    const h = await harness([PROBE_STEP, PROBE_STEP], {
      diagnose,
      timing: { waitMs: 4_000, pollMs: 5, settleMs: 5 },
      remove: async (client, path, checkTarget) => {
        removals += 1;
        const report = await removeIntegrations(options(client, path, checkTarget));
        if (removals === 1) await chmod(join(probes, "cleanup"), 0o500);
        return report;
      },
    });
    probes = h.probes;
    await h.send({ type: "message", text: "A" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    const waited = h.send({ type: "await-probe" });
    await h.send({ type: "cancel-probe" });
    const after = await waited;
    await chmod(join(h.probes, "cleanup"), 0o700);
    // Its marker, hooks and catch are gone: done, said so, and nothing held.
    expect(after.entries.at(-1)!.text).toContain("探针已移除");
    expect(await readdir(h.probes)).not.toContain(`${marker.id}.json`);
    expect(await readFile(h.hookFile, "utf8")).not.toContain("hook probe");
    expect(diagnose).toHaveBeenCalledWith(expect.stringContaining("cleanup entry not removed"));
    expect(await readdir(join(h.probes, "cleanup"))).toEqual([`${marker.id}.json`]);
    // Not pending: the next probe goes in, and the quit has nothing of the first to try again.
    await h.send({ type: "message", text: "B" });
    expect((await h.send({ type: "probe", answer: "confirm" })).status).toBe("waiting");
    await h.service.shutdown();
    expect(removals).toBe(2);
    // The next start takes the entry away.
    expect(await h.restart().cleanupLeftovers()).toMatchObject({ failed: [] });
    expect(await readdir(h.probes)).toEqual([]);
  });
});
