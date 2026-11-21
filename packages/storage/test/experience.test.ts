import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ExperienceRepository, experienceNoteHash, parseExperience, serializeExperience, type ExperienceRecord } from "../src/experience.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const vault = async () => {
  const root = await mkdtemp(join(tmpdir(), "experience-"));
  roots.push(root);
  return root;
};

const record = (overrides: Partial<ExperienceRecord> = {}): ExperienceRecord => ({
  id: "exp-1",
  revision: 1,
  status: "pending",
  project: "消息服务",
  createdAt: "2026-11-11T02:00:00.000Z",
  updatedAt: "2026-11-11T02:00:00.000Z",
  reporter: "agent",
  verification: "agent_reported_unverified",
  outcome: "effective",
  adoptedFrom: "sug-1@r1",
  generator: { model: "示例模型", promptVersion: "organization-v1" },
  body: {
    title: "修复重复发送后，在指定重试场景下验证",
    scene: "弱网自动重试，<!-- decision:experience-scene-end --> 写在正文里也不截断",
    action: "带上幂等键",
    observation: "Agent 报告：重试 50 次未再重复。",
    inference: "对自动重试路径有效",
    exceptions: "手动重发未验证",
  },
  sources: [{ key: "todo_item:L 1#12", label: "清单「消息」#12", excerpt: "重试 50 次未再重复", hash: "a".repeat(64), at: "2026-11-10T00:00:00.000Z" }],
  ...overrides,
});

describe("ExperienceRepository", () => {
  it("reads a note back as written, markers in the text included", () => {
    expect(parseExperience(serializeExperience(record()))).toEqual(record());
  });
  it("keeps model inputs separate from cited sources and validates their bounds", () => {
    const original = record({ inputKeys: ["todo_item:L 1#12", "pending_confirmation:context"], directInputKeys: ["todo_item:L 1#12"] });
    const parsed = parseExperience(serializeExperience(original));
    expect(parsed).toEqual(original);
    expect(parsed.sources).toHaveLength(1);
    expect(() => parseExperience(serializeExperience(record({ inputKeys: ["invalid"] })))).toThrow();
    expect(() => parseExperience(serializeExperience(record({ inputKeys: Array.from({ length: 2049 }, () => "decision:x") })))).toThrow();
  });

  it("creates once per id and answers a retry with the note already there", async () => {
    const repository = new ExperienceRepository(await vault());
    const first = await repository.create(record());
    expect(first.status).toBe("saved");
    expect((await repository.create(record())).status).toBe("unchanged");
    expect((await repository.create(record({ body: { ...record().body, action: "别的" } }))).status).toBe("conflict");
    expect((await repository.scan()).experiences).toHaveLength(1);
  });

  it("changes properties only on the note it read, keeping the reader's own lines", async () => {
    const repository = new ExperienceRepository(await vault());
    const created = await repository.create(record());
    if (created.status !== "saved") throw new Error("not saved");
    const raw = await readFile(created.stored.path, "utf8");
    const edited = `${raw}\n读者自己加的一行\n`;
    await writeFile(created.stored.path, edited);
    // Read before the reader's edit: refused, nothing written.
    expect((await repository.reviseProperties("exp-1", created.stored.noteHash, (current) => ({ status: "active", sources: current.sources }))).status).toBe("conflict");
    const activated = await repository.reviseProperties("exp-1", experienceNoteHash(edited), (current) => ({ status: "active", sources: current.sources }));
    expect(activated.status).toBe("saved");
    const after = await readFile(created.stored.path, "utf8");
    expect(after).toContain("读者自己加的一行");
    expect(parseExperience(after)).toMatchObject({ status: "active", revision: 2 });
  });

  it("tells an unread note apart from one that is gone", async () => {
    const root = await vault();
    const repository = new ExperienceRepository(root);
    const created = await repository.create(record());
    if (created.status !== "saved") throw new Error("not saved");
    await writeFile(created.stored.path, "---\nbroken: [\n---\n");
    await expect(repository.find("exp-1", { sure: true })).rejects.toThrow("不能确定");
    expect((await repository.trash("exp-1", null, async () => undefined)).status).toBe("unavailable");
  });

  it("trashes only the note as it was read", async () => {
    const repository = new ExperienceRepository(await vault());
    const created = await repository.create(record());
    if (created.status !== "saved") throw new Error("not saved");
    const trashed: string[] = [];
    expect((await repository.trash("exp-1", "0".repeat(64), async (path) => { trashed.push(path); })).status).toBe("conflict");
    expect((await repository.trash("exp-1", created.stored.noteHash, async (path) => { trashed.push(path); })).status).toBe("saved");
    expect(trashed).toEqual([created.stored.path]);
  });
});


it("来源时间可以保留原写法，记忆自身时间和来源长度仍严格校验", () => {
  const source = record().sources[0]!;
  for (const at of ["2026-09-01", "2026-09-01T09:00:00+08:00", "日期待核实", "2026-02-30"]) {
    expect(parseExperience(serializeExperience(record({ sources: [{ ...source, at }] }))).sources[0]?.at).toBe(at);
  }
  expect(() => parseExperience(serializeExperience(record({ createdAt: "2026-09-01" })))).toThrow();
  expect(() => parseExperience(serializeExperience(record({ sources: [{ ...source, at: "x".repeat(101) }] })))).toThrow();
});
