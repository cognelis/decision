import type { MethodologyRecord } from "@cognelis/decision-core";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MethodologyHistoryStore } from "../src/main/methodology-history-store.js";

const methodology = (
  overrides: Partial<MethodologyRecord> = {},
): MethodologyRecord => ({
  id: "principle-stable",
  createdAt: "2026-08-01T08:00:00.000Z",
  updatedAt: "2026-08-02T08:00:00.000Z",
  origin: "decision_evidence",
  status: "accepted",
  confirmedAt: "2026-08-02T08:00:00.000Z",
  title: "先验证，再扩大",
  principle: "先验证可回退路径，再扩大不可逆投入。",
  appliesWhen: "结果仍有关键未知项时。",
  caution: "双轨成本过高时重新评估。",
  evidenceSummary: "证据支持先验证边界。",
  sourceDecisionIds: ["decision-1"],
  confidence: "low",
  generation: {
    requestId: "methodology:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5",
  },
  ...overrides,
});

describe("MethodologyHistoryStore", () => {
  it("keeps the latest twenty complete recoverable principle versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "methodology-history-"));
    const store = new MethodologyHistoryStore(root);
    for (let version = 1; version <= 22; version += 1) {
      await store.capture(
        methodology({
          updatedAt: `2026-08-${String(version).padStart(2, "0")}T08:00:00.000Z`,
          title: `原则版本 ${version}`,
        }),
        version % 2 === 0 ? "restore_checkpoint" : "revision_applied",
        `2026-08-${String(version).padStart(2, "0")}T09:00:00.000Z`,
      );
    }

    const entries = await store.list("principle-stable");
    expect(entries).toHaveLength(20);
    expect(entries[0]).toMatchObject({
      version: 22,
      snapshot: { title: "原则版本 22" },
    });
    expect(entries.at(-1)).toMatchObject({
      version: 3,
      snapshot: { title: "原则版本 3" },
    });
    await expect(store.find("principle-stable", 22)).resolves.toMatchObject({
      snapshot: { title: "原则版本 22" },
    });
    const [file] = await readdir(join(root, "principles"));
    expect(file).toBeDefined();
    expect((await stat(join(root, "principles", file!))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("keeps an evidence change as a reason 1.1.0 knows, read back here as what it was", async () => {
    const root = await mkdtemp(join(tmpdir(), "methodology-history-"));
    const store = new MethodologyHistoryStore(root);
    // Written by an earlier build of this version: a reason 1.1.0 calls corrupt, the principle's history refused.
    const earlier = await store.capture(methodology(), "revision_applied", "2026-08-03T08:00:00.000Z");
    const [file] = await readdir(join(root, "principles"));
    const path = join(root, "principles", file!);
    const history = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ reason: string }> };
    history.entries[0]!.reason = "evidence_changed";
    await writeFile(path, JSON.stringify(history), "utf8");

    await expect(store.capture(methodology({ evidenceSummary: "补充了第二条证据。" }), "evidence_changed", "2026-08-04T08:00:00.000Z"))
      .resolves.toMatchObject({ version: earlier.version + 1, reason: "evidence_changed" });

    const written = JSON.parse(await readFile(path, "utf8")) as { entries: Array<{ reason: string; detail?: string }> };
    expect(written.entries.map(({ reason, detail }) => [reason, detail])).toEqual([
      ["revision_applied", "evidence_changed"],
      ["revision_applied", "evidence_changed"],
    ]);
    expect((await store.list("principle-stable")).map((entry) => entry.reason)).toEqual(["evidence_changed", "evidence_changed"]);
  });

  it("stops instead of overwriting a corrupted version history", async () => {
    const root = await mkdtemp(join(tmpdir(), "methodology-history-"));
    const store = new MethodologyHistoryStore(root);
    await store.capture(
      methodology(),
      "revision_applied",
      "2026-08-03T08:00:00.000Z",
    );
    const [file] = await readdir(join(root, "principles"));
    await writeFile(join(root, "principles", file!), "not json", "utf8");

    await expect(store.list("principle-stable")).rejects.toThrow(
      "版本历史损坏",
    );
    await expect(
      store.capture(
        methodology({ title: "不应覆盖" }),
        "restore_checkpoint",
        "2026-08-04T08:00:00.000Z",
      ),
    ).rejects.toThrow("版本历史损坏");
  });
});
