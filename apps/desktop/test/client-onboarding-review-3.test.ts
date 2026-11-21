// CL2-REVIEW-AS-3 (AS3-R01): a probe taken out only in part is held, said so, and tried again; its authority goes first
// whatever else fails. From the review's reproduction (rounds/CL2/review-as/r3/cleanup-errors.test.ts), and the two
// failures it did not reach: a marker that will not go, and hooks that will not come out.
import { removeIntegrations, type InstallReport } from "@cognelis/decision-integrations";
import type { OnboardingView } from "@cognelis/decision-protocol";
import { chmod, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runProbeHook } from "../../bridge/src/client-probe.js";
import { BRIDGE, harness, PROBE_STEP } from "./support/onboarding-harness.js";

const REPLY = { action: "reply", message: "继续" };
const FAST = { timing: { waitMs: 4_000, pollMs: 5, settleMs: 5 } };
const tokenOf = (view: OnboardingView): string => (view.card !== null && "token" in view.card ? view.card.token : "");
const hooksIn = async (path: string) => (await readFile(path, "utf8")).includes("hook probe");

/** Two conversations, A's probe in and waiting; B's card shown. */
const twoConversations = async (overrides: Parameters<typeof harness>[1] = {}) => {
  const h = await harness([PROBE_STEP, PROBE_STEP, REPLY, REPLY, REPLY], { ...FAST, ...overrides });
  const a = await h.service.handle({ sessionId: null, event: { type: "message", text: "A" } });
  const b = await h.service.handle({ sessionId: null, event: { type: "message", text: "B" } });
  await h.service.handle({ sessionId: a.sessionId, event: { type: "probe", token: tokenOf(a), answer: "confirm" } });
  const marker = await h.marker();
  const cancelA = async () => {
    const waiting = h.service.handle({ sessionId: a.sessionId, event: { type: "await-probe" } });
    await h.service.handle({ sessionId: a.sessionId, event: { type: "cancel-probe" } });
    return waiting;
  };
  const probeB = () => h.service.handle({ sessionId: b.sessionId, event: { type: "probe", token: tokenOf(b), answer: "confirm" } });
  const sample = (now?: number) =>
    runProbeHook(marker.id, "Stop", { environment: { DECISION_CLIENT_PROBES: h.probes }, ...(now === undefined ? {} : { now: () => now }), readInput: async () => ({ private_sample: "AFTER-CANCEL" }) });
  return { ...h, marker, cancelA, probeB, sample };
};

describe("AS3-R01, as AS4 settled it: a cleanup list that cannot be written lets no probe in", () => {
  it("refuses the probe, says why, and leaves no marker, hook or record", async () => {
    const h = await harness([PROBE_STEP, PROBE_STEP], FAST);
    // The cleanup list's folder is a file: writing the list fails, for real.
    await mkdir(h.probes, { recursive: true });
    await writeFile(join(h.probes, "cleanup"), "synthetic-invalid-cleanup-path");
    await h.send({ type: "message", text: "接入" });
    const refused = await h.send({ type: "probe", answer: "confirm" });
    expect(refused.status).not.toBe("waiting");
    expect(refused.entries.map((entry) => entry.text)).toContainEqual(expect.stringContaining("清理记录写不进去"));
    expect(h.install).not.toHaveBeenCalled();
    expect(await readdir(h.probes)).toEqual(["cleanup"]);
    expect(await hooksIn(h.hookFile)).toBe(false);
    // The folder put right, the next probe goes in.
    await unlink(join(h.probes, "cleanup"));
    await h.send({ type: "message", text: "再试一次" });
    expect((await h.send({ type: "probe", answer: "confirm" })).status).toBe("waiting");
    await h.service.shutdown();
    expect(await readdir(h.probes)).toEqual([]);
  });
});

describe("AS3-R01: a probe taken out only in part", () => {
  it("whose marker will not go: said, held, nothing recorded past its end, and tried again at quit", async () => {
    const h = await twoConversations();
    // The probes folder read-only: the marker cannot be unlinked, and no cleanup list written beside it.
    await chmod(h.probes, 0o500);
    try {
      const cancelled = await h.cancelA();
      const said = cancelled.entries.at(-1)!.text;
      expect(said).toContain("采样授权没能撤销");
      expect(said).toContain("下次启动时再试");
      expect(said).not.toContain("探针已移除");
      // Its hooks came out all the same.
      expect(await hooksIn(h.hookFile)).toBe(false);
      // Held: no other probe while it stands.
      const refused = await h.probeB();
      expect(refused.status).not.toBe("waiting");
      expect(refused.entries.at(-1)!.text).toContain("上一个探针还没清理干净");
      expect(h.install).toHaveBeenCalledTimes(1);
      // Past its end, the marker still there records nothing.
      await h.sample(h.marker.expiresAt + 1);
      expect(await readdir(join(h.probes, h.marker.id)).catch(() => [])).toEqual([]);
    } finally {
      await chmod(h.probes, 0o700);
    }
    await h.service.shutdown();
    expect(await readdir(h.probes)).toEqual([]);
  });

  it("whose hooks will not come out: revoked, said, held, and tried again on the next probe and at quit", async () => {
    let failing = true;
    let removals = 0;
    const h = await twoConversations({
      remove: async (client, path, checkTarget): Promise<InstallReport> => {
        removals += 1;
        return failing
          ? { mode: "apply", targets: [{ client: client.id, path, changed: false, status: "failed", detail: "synthetic file locked" }], commands: [], restartRequired: false }
          : removeIntegrations({ mode: "apply", bridgePath: BRIDGE, platform: "darwin", clients: [client], paths: { [client.id]: path }, checkTarget });
      },
    });
    const cancelled = await h.cancelA();
    expect(cancelled.entries.at(-1)!.text).toContain("钩子没能移除（synthetic file locked）");
    // Revoked whatever else: the hook still in the file records nothing.
    expect(await readdir(h.probes)).not.toContain(`${h.marker.id}.json`);
    await h.sample();
    expect(await readdir(join(h.probes, h.marker.id)).catch(() => [])).toEqual([]);
    expect(await readdir(join(h.probes, "cleanup"))).toEqual([`${h.marker.id}.json`]);
    const refused = await h.probeB();
    expect(refused.entries.at(-1)!.text).toContain("上一个探针还没清理干净");
    expect(removals).toBe(2);
    failing = false;
    await h.service.shutdown();
    expect(removals).toBe(3);
    expect(await hooksIn(h.hookFile)).toBe(false);
    expect(await readdir(h.probes)).toEqual([]);
  });
});
