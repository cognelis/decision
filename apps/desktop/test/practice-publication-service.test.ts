import type { PracticeAssetRecord } from "@cognelis/decision-core";
import { parsePracticeAsset } from "@cognelis/decision-storage";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { PracticePublicationService } from "../src/main/practice-publication-service.js";

const acceptedAsset = (
  overrides: Partial<PracticeAssetRecord> = {},
): PracticeAssetRecord => ({
  id: "skill-1",
  slug: "decision-reversible-change",
  kind: "skill",
  status: "accepted",
  createdAt: "2026-08-02T08:00:00.000Z",
  updatedAt: "2026-08-03T08:00:00.000Z",
  acceptedAt: "2026-08-03T08:00:00.000Z",
  title: "可逆改动验证",
  summary: "用可回退的小步改动验证仍有未知项的实现方向。",
  trigger: "需求边界或实际效果仍需通过运行反馈确认时。",
  steps: [
    "明确本轮需要验证的一个关键假设。",
    "实施可独立回退的最小改动。",
    "记录结果后再决定是否扩大范围。",
  ],
  checks: ["改动能够独立回退。", "实际结果已经记录。"],
  fallback: "验证失败时回退本轮改动，并重新界定假设。",
  sourcePrincipleIds: ["principle-1"],
  generation: {
    requestId: "skill:request-1",
    profileId: "builtin-qwen",
    provider: "Qwen 本地模型",
    model: "qwen3.5-2b-q4-k-m",
  },
  ...overrides,
});

const makeService = async (
  validateBeforePublish?: (asset: PracticeAssetRecord) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "practice-publication-"));
  const roots = {
    codex: join(root, "codex-skills"),
    claudeCode: join(root, "claude-skills"),
  };
  let asset = acceptedAsset();
  let clock = 0;
  const service = new PracticePublicationService({
    assets: {
      find: async (id) => (id === asset.id ? asset : null),
    },
    stateRoot: join(root, "publication-state"),
    targetRoots: {
      codex: roots.codex,
      "claude-code": roots.claudeCode,
    },
    now: () => new Date(Date.UTC(2026, 7, 4, 10, clock++)),
    ...(validateBeforePublish === undefined ? {} : { validateBeforePublish }),
  });
  return {
    root,
    roots,
    service,
    targetPath: (target: "codex" | "claude-code") =>
      join(
        target === "codex" ? roots.codex : roots.claudeCode,
        asset.slug,
        "SKILL.md",
      ),
    updateAsset: (overrides: Partial<PracticeAssetRecord>) => {
      asset = { ...asset, ...overrides };
    },
  };
};

describe("PracticePublicationService", () => {
  it("publishes an accepted asset as a traceable Skill package", async () => {
    const { service, targetPath } = await makeService();

    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({
        target: "codex",
        state: "not_published",
        canPublish: true,
        canRollback: false,
      }),
      expect.objectContaining({
        target: "claude-code",
        state: "not_published",
      }),
    ]);
    await expect(service.publish("skill-1", "codex")).resolves.toMatchObject({
      target: "codex",
      action: "published",
      version: 1,
    });

    const content = await readFile(targetPath("codex"), "utf8");
    expect(content).toContain("publication_target: codex");
    expect(content).toContain("publication_version: 1");
    expect(parsePracticeAsset(content)).toEqual(acceptedAsset());
    expect((await lstat(targetPath("codex"))).mode & 0o777).toBe(0o600);
    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({
        target: "codex",
        state: "up_to_date",
        version: 1,
        canPublish: false,
        canRollback: true,
      }),
      expect.objectContaining({ target: "claude-code" }),
    ]);
  });

  it("serializes simultaneous publications so neither client history is lost", async () => {
    const { service } = await makeService();

    await Promise.all([
      service.publish("skill-1", "codex"),
      service.publish("skill-1", "claude-code"),
    ]);

    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({ target: "codex", state: "up_to_date" }),
      expect.objectContaining({
        target: "claude-code",
        state: "up_to_date",
      }),
    ]);
  });

  it("validates source freshness before performing any client write", async () => {
    const validateBeforePublish = async (): Promise<void> => {
      throw new Error("来源原则已更新");
    };
    const { service, targetPath } = await makeService(validateBeforePublish);

    await expect(service.publish("skill-1", "codex")).rejects.toThrow(
      "来源原则已更新",
    );
    await expect(readFile(targetPath("codex"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("updates a published asset and rolls back one version at a time", async () => {
    const { service, targetPath, updateAsset } = await makeService();
    await service.publish("skill-1", "codex");
    const versionOne = await readFile(targetPath("codex"), "utf8");
    updateAsset({
      title: "可逆改动验证（改进版）",
      updatedAt: "2026-08-04T08:00:00.000Z",
    });

    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({
        target: "codex",
        state: "update_available",
      }),
      expect.anything(),
    ]);
    await expect(service.publish("skill-1", "codex")).resolves.toMatchObject({
      action: "published",
      version: 2,
    });
    expect(await readFile(targetPath("codex"), "utf8")).toContain(
      "publication_version: 2",
    );

    await expect(service.rollback("skill-1", "codex")).resolves.toMatchObject({
      action: "rolled_back",
      version: 1,
      restoredPreviousContent: true,
    });
    expect(await readFile(targetPath("codex"), "utf8")).toBe(versionOne);
    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({
        target: "codex",
        state: "update_available",
        version: 1,
      }),
      expect.anything(),
    ]);

    await expect(service.rollback("skill-1", "codex")).resolves.toMatchObject({
      version: null,
      restoredPreviousContent: false,
    });
    await expect(readFile(targetPath("codex"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires confirmation before replacing an existing same-name skill", async () => {
    const { service, targetPath } = await makeService();
    const target = targetPath("codex");
    await mkdir(dirname(target), { recursive: true });
    const original = "# User skill\n\nKeep this exact content.\n";
    await writeFile(target, original);

    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({
        target: "codex",
        state: "occupied",
        requiresOverwriteConfirmation: true,
      }),
      expect.anything(),
    ]);
    await expect(service.publish("skill-1", "codex")).rejects.toThrow(
      "请确认覆盖",
    );
    expect(await readFile(target, "utf8")).toBe(original);

    await service.publish("skill-1", "codex", { confirmOverwrite: true });
    await expect(service.rollback("skill-1", "codex")).resolves.toMatchObject({
      restoredPreviousContent: true,
    });
    expect(await readFile(target, "utf8")).toBe(original);
    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({ target: "codex", state: "occupied" }),
      expect.anything(),
    ]);
  });

  it("protects externally modified targets and can preserve them as a new backup", async () => {
    const { service, targetPath } = await makeService();
    const target = targetPath("codex");
    await service.publish("skill-1", "codex");
    const external = "# Externally edited\n";
    await writeFile(target, external);

    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({
        target: "codex",
        state: "target_modified",
        canRollback: false,
      }),
      expect.anything(),
    ]);
    await expect(service.rollback("skill-1", "codex")).rejects.toThrow(
      "已被修改",
    );
    await service.publish("skill-1", "codex", { confirmOverwrite: true });
    await service.rollback("skill-1", "codex");
    expect(await readFile(target, "utf8")).toBe(external);
  });

  it("refuses symbolic-link targets", async () => {
    const { root, roots, service, targetPath } = await makeService();
    const outside = join(root, "outside.md");
    await writeFile(outside, "outside");
    await mkdir(join(roots.codex, "decision-reversible-change"), {
      recursive: true,
    });
    await symlink(outside, targetPath("codex"));

    await expect(service.listStatuses("skill-1")).resolves.toEqual([
      expect.objectContaining({
        target: "codex",
        state: "unsafe_target",
        canPublish: false,
      }),
      expect.anything(),
    ]);
    await expect(service.publish("skill-1", "codex")).rejects.toThrow(
      "普通文件",
    );
    expect(await readFile(outside, "utf8")).toBe("outside");
  });
});
