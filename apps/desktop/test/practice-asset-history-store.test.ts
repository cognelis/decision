import type { PracticeAssetRecord } from "@cognelis/decision-core";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { PracticeAssetHistoryStore } from "../src/main/practice-asset-history-store.js";

const asset = (
  overrides: Partial<PracticeAssetRecord> = {},
): PracticeAssetRecord => ({
  id: "skill-1",
  slug: "decision-reversible-change",
  kind: "skill",
  status: "accepted",
  createdAt: "2026-08-03T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
  acceptedAt: "2026-08-03T08:00:00.000Z",
  title: "可逆改动验证",
  summary: "第一版。",
  trigger: "仍有未知项时。",
  steps: ["明确假设。", "实施最小改动。"],
  checks: ["结果已记录。"],
  fallback: "失败时回退。",
  sourcePrincipleIds: ["principle-1"],
  generation: {
    requestId: "skill:1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

describe("PracticeAssetHistoryStore", () => {
  it("stores ordered snapshots, deduplicates retries, and reloads them", async () => {
    const root = await mkdtemp(join(tmpdir(), "practice-history-"));
    const store = new PracticeAssetHistoryStore(root);
    const first = asset();
    const second = asset({
      updatedAt: "2026-08-04T08:00:00.000Z",
      summary: "第二版。",
    });

    await store.capture(first, "manual_edit", "2026-08-04T08:00:00.000Z");
    await store.capture(first, "manual_edit", "2026-08-04T08:00:01.000Z");
    await store.capture(
      second,
      "replacement_applied",
      "2026-08-05T08:00:00.000Z",
    );

    const reloaded = new PracticeAssetHistoryStore(root);
    await expect(reloaded.list(first.id)).resolves.toMatchObject([
      { version: 2, reason: "replacement_applied", snapshot: second },
      { version: 1, reason: "manual_edit", snapshot: first },
    ]);
    await expect(reloaded.find(first.id, 1)).resolves.toMatchObject({
      snapshot: first,
    });
  });

  it("rejects a symbolic-link history file instead of following it", async () => {
    const root = await mkdtemp(join(tmpdir(), "practice-history-link-"));
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}", "utf8");
    const digest = createHash("sha256")
      .update("skill-1", "utf8")
      .digest("hex");
    const target = join(root, "assets", `${digest}.json`);
    await mkdir(dirname(target), { recursive: true });
    await symlink(outside, target);

    await expect(new PracticeAssetHistoryStore(root).list("skill-1")).rejects.toThrow(
      "路径不安全",
    );
  });

  it("rejects a symbolic-link history directory before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "practice-history-root-link-"));
    const outside = await mkdtemp(join(tmpdir(), "practice-history-outside-"));
    await symlink(outside, join(root, "assets"));

    await expect(
      new PracticeAssetHistoryStore(root).capture(
        asset(),
        "manual_edit",
        "2026-08-04T08:00:00.000Z",
      ),
    ).rejects.toThrow("目录不安全");
  });
});
