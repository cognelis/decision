// CL2-REVIEW-AS-5 (AS5-R01): the start's cleanup goes first in the probe's lane, and takes out nothing of this run's own.
// From the review's reproductions (rounds/CL2/review-as/r5: startup-order, spec/startup-overlap).
import { inIntegrationsTurn, installIntegrationsWithinTurn, removeIntegrationsWithinTurn, type ClientDescriptor } from "@cognelis/decision-integrations";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ClientOnboardingOptions } from "../src/main/client-onboarding-service.js";
import { BRIDGE, harness, PROBE_STEP } from "./support/onboarding-harness.js";

const FAST = { timing: { waitMs: 4_000, pollMs: 5, settleMs: 5 } };
type CheckTarget = Parameters<ClientOnboardingOptions["install"]>[2];
const options = (client: ClientDescriptor, path: string, checkTarget: CheckTarget) =>
  ({ mode: "apply" as const, bridgePath: BRIDGE, platform: "darwin" as const, clients: [client], paths: { [client.id]: path }, checkTarget });

/** What an earlier run left on the cleanup list: probes in the very hook file this run's probe goes in. */
const leftOver = async (probes: string, ids: string[]) => {
  await mkdir(join(probes, "cleanup"), { recursive: true });
  for (const id of ids) {
    await writeFile(join(probes, "cleanup", `${id}.json`), JSON.stringify({ id, hooks: { file: PROBE_STEP.file, format: PROBE_STEP.format }, events: PROBE_STEP.events }));
  }
};

describe("AS5-R01: the start's cleanup before any probe of this run", () => {
  it("makes a probe asked for while it runs wait, and leaves that probe's hooks in", async () => {
    let entered!: () => void;
    let release!: () => void;
    const cleaning = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let removals = 0;
    let installs = 0;
    const h = await harness([PROBE_STEP], {
      ...FAST,
      install: (client, path, checkTarget) => { installs += 1; return inIntegrationsTurn(() => installIntegrationsWithinTurn(options(client, path, checkTarget))); },
      remove: (client, path, checkTarget) => inIntegrationsTurn(async () => {
        removals += 1;
        if (removals === 1) { entered(); await gate; }
        return removeIntegrationsWithinTurn(options(client, path, checkTarget));
      }),
    });
    await leftOver(h.probes, ["probe-oldclean1234", "probe-oldclean5678"]);
    // The App's order: the cleanup first, then a conversation that asks for a probe.
    const cleanup = h.service.cleanupLeftovers();
    await cleaning;
    await h.send({ type: "message", text: "B" });
    const installing = h.send({ type: "probe", answer: "confirm" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Not in before the cleanup is done.
    expect(installs).toBe(0);
    release();
    const [cleaned, view] = await Promise.all([cleanup, installing]);
    expect(cleaned).toEqual({ removed: 2, failed: [] });
    expect(view.status).toBe("waiting");
    expect(await readFile(h.hookFile, "utf8")).toContain("hook probe");
    await h.service.shutdown();
    expect(await readdir(h.probes)).toEqual([]);
  });

  it("leaves a probe of this run's hooks in, whichever of the two starts first, twenty times over", async () => {
    for (let round = 0; round < 20; round += 1) {
      const h = await harness([PROBE_STEP], FAST);
      await leftOver(h.probes, ["probe-oldclean1234"]);
      await h.send({ type: "message", text: "B" });
      const [, view] = await Promise.all([h.service.cleanupLeftovers(), h.send({ type: "probe", answer: "confirm" })]);
      expect(view.status).toBe("waiting");
      expect(await readFile(h.hookFile, "utf8")).toContain("hook probe");
      await h.service.shutdown();
      expect(await readdir(h.probes)).toEqual([]);
    }
  });

  it("takes out nothing of this run's own, a cleanup asked for late included", async () => {
    const h = await harness([PROBE_STEP], FAST);
    await h.send({ type: "message", text: "B" });
    await h.send({ type: "probe", answer: "confirm" });
    const marker = await h.marker();
    // A leftover in the same file, met only now: left for the next start, the held probe's hooks with it.
    await leftOver(h.probes, ["probe-oldclean1234"]);
    expect(await h.service.cleanupLeftovers()).toEqual({ removed: 0, failed: [] });
    expect(await readFile(h.hookFile, "utf8")).toContain(`hook probe ${marker.id}`);
    expect(await readdir(h.probes)).toContain(`${marker.id}.json`);
    await h.service.shutdown();
    expect(await h.restart().cleanupLeftovers()).toEqual({ removed: 1, failed: [] });
    expect(await readdir(h.probes)).toEqual([]);
  });
});
