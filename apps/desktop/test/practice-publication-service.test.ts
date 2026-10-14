import type { PracticeAssetRecord } from "@cognelis/decision-core";
import { PracticeAssetRepository, parsePracticeAsset, publishedPracticeAsset } from "@cognelis/decision-storage";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
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

/**
 * A publication cut short (a quit) as its record was being written: the client's copy and the backup written, the
 * record not, and its note of what it was writing still there.
 */
const cutShort = async (root: string, target: "codex" | "claude-code", path: string): Promise<void> => {
  await rm(join(root, "publication-state", "manifest.json"));
  const stem = createHash("sha256").update(`${target}:skill-1`).digest("hex").slice(0, 24);
  await mkdir(join(root, "publication-state", "pending"), { recursive: true });
  await writeFile(join(root, "publication-state", "pending", `${stem}.json`), JSON.stringify({ version: 1, path }));
};

describe("PracticePublicationService", () => {
  it.runIf(process.getuid?.() !== 0)("says in words which client folder it may not write to", async () => {
    const { chmod } = await import("node:fs/promises");
    const { roots, service } = await makeService();
    // A client once run with sudo: its folder belongs to root, and Decision may not write in it.
    await mkdir(roots.codex, { recursive: true });
    await chmod(roots.codex, 0o500);
    try {
      await expect(service.publish("skill-1", "codex")).rejects.toThrow(/^没有权限写入 .*codex-skills/u);
    } finally {
      await chmod(roots.codex, 0o700);
    }
  });

  it("publishes where a client keeps its settings as known at the time, not at startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "practice-publication-"));
    let codexHome = join(root, "default-codex");
    const service = new PracticePublicationService({
      assets: { find: async () => acceptedAsset() },
      stateRoot: join(root, "publication-state"),
      // The login shell's CODEX_HOME arrives a moment after startup.
      targetRoots: { get codex() { return join(codexHome, "skills"); }, "claude-code": join(root, "claude-skills") },
      now: () => new Date(Date.UTC(2026, 7, 4, 10)),
    });
    codexHome = join(root, "moved-codex");

    await service.publish("skill-1", "codex");
    expect(await readFile(join(root, "moved-codex", "skills", acceptedAsset().slug, "SKILL.md"), "utf8")).toContain("publication_target: codex");
  });

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
    expect(parsePracticeAsset(content)).toEqual({ ...acceptedAsset(), summary: `${acceptedAsset().summary} 使用条件：${acceptedAsset().trigger}` });
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

  it("publishes the skill as the reader wrote it, with none of the vault note's escaping", async () => {
    const { service, targetPath, updateAsset } = await makeService();
    updateAsset({
      steps: ["运行 `git switch -c <branch>` 新建分支。", "完成后运行 `npm test`，输出里不能有 ## FAIL。"],
      checks: ["分支名形如 <type>/<topic>。"],
    });

    await service.publish("skill-1", "claude-code");

    // An agent reads SKILL.md as plain text: told `git switch -c \<branch>` and `\#\# FAIL`, it ran other commands.
    const content = await readFile(targetPath("claude-code"), "utf8");
    expect(content).toContain("1. 运行 `git switch -c <branch>` 新建分支。");
    expect(content).toContain("输出里不能有 ## FAIL。");
    expect(content).toContain("- 分支名形如 <type>/<topic>。");
    expect(content).not.toContain("\\");
    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({ target: "claude-code", state: "up_to_date" }));
  });

  it("publishes what the reader added to the note in Obsidian, and says the client copy is behind once they do", async () => {
    const root = await mkdtemp(join(tmpdir(), "practice-publication-note-"));
    const assets = new PracticeAssetRepository(join(root, "vault"));
    await assets.save(acceptedAsset({ steps: ["运行 `git switch -c <branch>` 新建分支。", "完成后运行 `npm test`。"] }));
    const service = new PracticePublicationService({
      assets,
      stateRoot: join(root, "publication-state"),
      targetRoots: { codex: join(root, "codex-skills"), "claude-code": join(root, "claude-skills") },
    });
    const published = join(root, "codex-skills", acceptedAsset().slug, "SKILL.md");
    await service.publish("skill-1", "codex");
    // Read from the note, as written in the vault: the copy stands as published, the note's escaping not in it.
    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({ target: "codex", state: "up_to_date" }));
    expect(await readFile(published, "utf8")).toContain("1. 运行 `git switch -c <branch>` 新建分支。");

    // In Obsidian the reader gives the skill its tools and an example of their own.
    const skills = join(root, "vault", "Decision Journal", "skills");
    const note = join(skills, (await readdir(skills))[0]!, "SKILL.md");
    const raw = await readFile(note, "utf8");
    await writeFile(note, `${raw.replace("---\n", "---\nallowed-tools: Bash(git status:*)\n")}\n## 示例\n\n先在分支上做一次可回退的改动，再看 CI。\n`);

    // Published from the record alone, neither reached the agent, and the card said 已是最新版本.
    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({ target: "codex", state: "update_available" }));
    await service.publish("skill-1", "codex");
    const content = await readFile(published, "utf8");
    expect(content).toContain("allowed-tools: Bash(git status:*)");
    expect(content).toContain("## 示例\n\n先在分支上做一次可回退的改动，再看 CI。");
    expect(content).toContain("publication_version: 2");
    expect(content).not.toContain("\\<branch>");
  });

  it("describes the skill to the agent by what it does and when to use it, within 1,024 characters", async () => {
    const { service, targetPath, updateAsset } = await makeService();
    // Written on one line (a plain scalar: no ASCII colon or quote in either text).
    const description = async (): Promise<string> =>
      /^description: (.*)$/mu.exec(await readFile(targetPath("codex"), "utf8"))?.[1] ?? "";
    await service.publish("skill-1", "codex");
    // Chosen by its description, the summary alone: the 使用条件 the reader wrote sat in the body, read only once chosen.
    expect(await description()).toBe(`${acceptedAsset().summary} 使用条件：${acceptedAsset().trigger}`);

    updateAsset({ summary: "摘".repeat(800), trigger: "用".repeat(1_500) });
    await service.publish("skill-1", "codex");
    expect(Array.from(await description())).toHaveLength(1_024);
  });

  it("finds a skill renamed in Obsidian where it was published, moves it on the next publish and puts it back on rollback", async () => {
    const { roots, service, targetPath, updateAsset } = await makeService();
    await service.publish("skill-1", "codex");
    const oldCopy = targetPath("codex");
    const versionOne = await readFile(oldCopy, "utf8");
    // Renamed in Obsidian's properties (`name:`): worked out from today's name, the copy read as gone.
    updateAsset({ slug: "decision-my-own-name" });

    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({
      target: "codex", state: "update_available", canRollback: true, message: expect.stringContaining("原位置"),
    }));
    // Published again, it stood twice in the agent's folder.
    await service.publish("skill-1", "codex");
    expect(await readdir(roots.codex)).toEqual(["decision-my-own-name"]);
    expect(await readFile(targetPath("codex"), "utf8")).toContain("publication_version: 2");

    // Rolled back, the first copy is where it was, as it was.
    await service.rollback("skill-1", "codex");
    expect(await readdir(roots.codex)).toEqual([acceptedAsset().slug]);
    expect(await readFile(oldCopy, "utf8")).toBe(versionOne);
    await service.rollback("skill-1", "codex");
    expect(await readdir(roots.codex)).toEqual([]);
  });

  it("takes the same client folder reached another way for the same place, and keeps the copy it writes there", async () => {
    const root = await mkdtemp(join(tmpdir(), "practice-publication-"));
    await mkdir(join(root, "real", "skills"), { recursive: true });
    // One folder by two spellings: a linked folder above it here, a case-only difference on APFS likewise.
    await symlink(join(root, "real"), join(root, "linked"));
    let codexRoot = join(root, "real", "skills");
    const service = new PracticePublicationService({
      assets: { find: async () => acceptedAsset() },
      stateRoot: join(root, "publication-state"),
      targetRoots: { get codex() { return codexRoot; }, "claude-code": join(root, "claude-skills") },
    });
    await service.publish("skill-1", "codex");
    codexRoot = join(root, "linked", "skills");

    // Taken for a move, the copy was published "to the new place" and then taken away as the old one, with no
    // rollback left.
    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({ target: "codex", state: "up_to_date" }));
    await service.publish("skill-1", "codex", { confirmOverwrite: true });
    expect(await readFile(join(root, "real", "skills", acceptedAsset().slug, "SKILL.md"), "utf8")).toContain("publication_version: 1");
  });

  it("restores the reader's own skill it replaced, after the skill was renamed or the client folder moved", async () => {
    const root = await mkdtemp(join(tmpdir(), "practice-publication-"));
    let claudeHome = join(root, "default-claude");
    const service = new PracticePublicationService({
      assets: { find: async () => acceptedAsset() },
      stateRoot: join(root, "publication-state"),
      targetRoots: { codex: join(root, "codex-skills"), get "claude-code"() { return join(claudeHome, "skills"); } },
    });
    const readersOwn = join(root, "default-claude", "skills", acceptedAsset().slug, "SKILL.md");
    await mkdir(dirname(readersOwn), { recursive: true });
    await writeFile(readersOwn, "# 我自己的技能\n");
    await service.publish("skill-1", "claude-code", { confirmOverwrite: true });
    // The login shell's CLAUDE_CONFIG_DIR arrives: the copy, and the reader's skill behind it, were out of reach.
    claudeHome = join(root, "configured-claude");

    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({
      target: "claude-code", state: "update_available", canRollback: true,
    }));
    await service.rollback("skill-1", "claude-code");
    expect(await readFile(readersOwn, "utf8")).toBe("# 我自己的技能\n");
  });

  it("says the note's name is what the agents will not take, rather than an unsafe identifier", async () => {
    const { service, updateAsset } = await makeService();
    // Taken by the vault, refused by Agent Skills' rule for a name.
    updateAsset({ slug: "decision--double" });
    await expect(service.publish("skill-1", "codex")).rejects.toThrow("笔记属性 name：decision--double");
  });

  it("knows its own publication cut short before it was recorded, and keeps the reader's skill it had backed up", async () => {
    const { root, service, targetPath } = await makeService();
    const target = targetPath("codex");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "# 我自己写的技能\n");
    await service.publish("skill-1", "codex", { confirmOverwrite: true });
    await cutShort(root, "codex", target);

    // Called a skill Decision does not manage and confirmed over, the backup was written over with Decision's own
    // text, and rollback brought that back.
    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({
      target: "codex", state: "update_available", requiresOverwriteConfirmation: false, message: expect.stringContaining("中断"),
    }));
    await service.publish("skill-1", "codex");
    await service.rollback("skill-1", "codex");
    expect(await readFile(target, "utf8")).toBe("# 我自己写的技能\n");
  });

  it("asks before replacing a copy that only claims to be its own, and keeps it to roll back to", async () => {
    const { root, service, targetPath } = await makeService();
    const target = targetPath("claude-code");
    await mkdir(dirname(target), { recursive: true });
    // Published by Decision on another Mac and synced here, or restored from a backup: its metadata says version 1
    // for this asset, with no publication of it under way on this Mac.
    const synced = publishedPracticeAsset(acceptedAsset({ steps: ["另一台机器上的第一步。", "另一台机器上的第二步。"] }), null, { target: "claude-code", version: 1 });
    await writeFile(target, synced);

    // Taken for a publication cut short by its metadata alone, it was written over with no confirmation and no
    // backup, and a rollback then deleted it.
    await expect(service.listStatuses("skill-1")).resolves.toContainEqual(expect.objectContaining({
      target: "claude-code", state: "occupied", requiresOverwriteConfirmation: true,
    }));
    await service.publish("skill-1", "claude-code", { confirmOverwrite: true });
    await service.rollback("skill-1", "claude-code");
    expect(await readFile(target, "utf8")).toBe(synced);
  });

  it("never writes over a backup it finds where the next one goes", async () => {
    const { root, service, targetPath } = await makeService();
    const target = targetPath("codex");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "# 我自己写的技能\n");
    await service.publish("skill-1", "codex", { confirmOverwrite: true });
    await rm(join(root, "publication-state", "manifest.json"));
    // The reader puts another skill of theirs in its place before the publication is completed.
    await writeFile(target, "# 后来写的另一个技能\n");

    await service.publish("skill-1", "codex", { confirmOverwrite: true });
    await service.rollback("skill-1", "codex");
    expect(await readFile(target, "utf8")).toBe("# 后来写的另一个技能\n");
    // The first one, backed up by the publication cut short, is kept beside it rather than written over.
    const backups = join(root, "publication-state", "backups");
    const [stem] = await readdir(backups);
    const kept = (await readdir(join(backups, stem!))).filter((name) => name.includes(".kept-"));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(backups, stem!, kept[0]!), "utf8")).toBe("# 我自己写的技能\n");
  });

  it("lets the copy of an asset no longer adopted be withdrawn, and publishes it no more", async () => {
    const { service, targetPath, updateAsset } = await makeService();
    await service.publish("skill-1", "codex");
    // Dismissed, or so set in Obsidian: refused as 只有已采纳的…可以发布, its status and rollback could not be
    // reached, and the client went on loading the skill.
    updateAsset({ status: "dismissed", acceptedAt: null });

    const [codex, claude] = await service.listStatuses("skill-1");
    expect(codex).toMatchObject({ canPublish: false, canRollback: true, message: expect.stringContaining("可以回滚撤下") });
    expect(claude).toMatchObject({ state: "not_published", canPublish: false });
    await expect(service.publish("skill-1", "codex")).rejects.toThrow("只有已采纳的技能或工作流可以发布");
    await service.rollback("skill-1", "codex");
    await expect(readFile(targetPath("codex"))).rejects.toMatchObject({ code: "ENOENT" });
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
