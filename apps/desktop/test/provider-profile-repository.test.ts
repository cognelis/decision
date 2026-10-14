import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Writes beside the profiles can be made to fail (a full disk) for one test; every other write goes through.
const { failAddedWrites } = vi.hoisted(() => ({ failAddedWrites: { on: false } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: (async (path: unknown, ...rest: unknown[]) => {
      if (failAddedWrites.on && String(path).includes("-extra.json.")) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return (actual.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
    }) as typeof actual.writeFile,
  };
});

import {
  BUILT_IN_PROVIDER_IDS,
  ProviderProfileRepository,
} from "../src/main/model/provider-profile-repository.js";

describe("ProviderProfileRepository", () => {
  it("creates four deterministic private built-ins on first load", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-profiles-"));
    const path = join(root, "profiles.json");
    const repository = new ProviderProfileRepository(path);

    const profiles = await repository.load();

    expect(profiles.map((profile) => profile.profileId)).toEqual([
      BUILT_IN_PROVIDER_IDS.apple,
      BUILT_IN_PROVIDER_IDS.qwen,
      BUILT_IN_PROVIDER_IDS.codex,
      BUILT_IN_PROVIDER_IDS.claudeCode,
    ]);
    expect(profiles.map((profile) => profile.enabled)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves cache rates and the holiday calendar in the sidecar across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-peak-"));
    const path = join(root, "profiles.json");
    const repository = new ProviderProfileRepository(path);
    const pricing = { currency: "¥", inputPerMillion: 1, cachedInputPerMillion: 0.02, outputPerMillion: 4, peak: { inputPerMillion: 2, cachedInputPerMillion: 0.04, outputPerMillion: 8, holidayYear: 2026, holidays: ["2026-10-01"] } };
    await repository.save({ version: 1, profileId: "deepseek-price", kind: "openai-compatible", label: "DeepSeek", enabled: true, priority: 50, model: "deepseek-flash", timeoutMs: 30000, baseUrl: "https://api.deepseek.com", apiProtocol: "chat-completions", credentialRef: "deepseek-key", pricing });
    expect((await new ProviderProfileRepository(path).load()).find((profile) => profile.profileId === "deepseek-price")?.pricing).toEqual(pricing);
    expect(await readFile(path, "utf8")).not.toContain("cachedInputPerMillion");
    expect(await readFile(join(root, "profiles-extra.json"), "utf8")).toContain("holidayYear");
  });

  it("atomically saves, orders, and deletes remote profiles only", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-save-"));
    const path = join(root, "profiles.json");
    const repository = new ProviderProfileRepository(path);
    await repository.load();
    await repository.save({
      version: 1,
      profileId: "remote-openai",
      kind: "openai",
      label: "OpenAI",
      enabled: false,
      priority: 40,
      model: "gpt-5-mini",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com",
      apiProtocol: "responses",
      credentialRef: "credential-1",
    });

    const reordered = await repository.reorder([
      "remote-openai",
      BUILT_IN_PROVIDER_IDS.qwen,
      BUILT_IN_PROVIDER_IDS.apple,
      BUILT_IN_PROVIDER_IDS.codex,
      BUILT_IN_PROVIDER_IDS.claudeCode,
    ]);
    expect(
      reordered.map(({ profileId, priority }) => ({
        profileId,
        priority,
      })),
    ).toEqual([
      { profileId: "remote-openai", priority: 0 },
      { profileId: BUILT_IN_PROVIDER_IDS.qwen, priority: 10 },
      { profileId: BUILT_IN_PROVIDER_IDS.apple, priority: 20 },
      { profileId: BUILT_IN_PROVIDER_IDS.codex, priority: 30 },
      {
        profileId: BUILT_IN_PROVIDER_IDS.claudeCode,
        priority: 40,
      },
    ]);
    expect(
      (await readdir(root)).filter((entry) =>
        entry.includes(".tmp"),
      ),
    ).toEqual([]);
    expect(
      JSON.parse(await readFile(path, "utf8")).profiles,
    ).toHaveLength(5);

    await expect(
      repository.delete(BUILT_IN_PROVIDER_IDS.apple),
    ).resolves.toBe(false);
    await expect(
      repository.delete("remote-openai"),
    ).resolves.toBe(true);
    expect(await repository.load()).toHaveLength(4);
  });

  it("rejects incomplete reorder lists and sets corrupt duplicate documents aside", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-corrupt-"));
    const path = join(root, "profiles.json");
    const repository = new ProviderProfileRepository(path);
    const profiles = await repository.load();

    await expect(
      repository.reorder([BUILT_IN_PROVIDER_IDS.apple]),
    ).rejects.toThrow(/every profile/i);
    const duplicated = JSON.stringify({
      version: 1,
      profiles: [profiles[0], profiles[0]],
    });
    await writeFile(path, duplicated, "utf8");
    await expect(repository.load()).resolves.toEqual(profiles);
    expect(await readFile(repository.setAside!, "utf8")).toBe(duplicated);
  });

  it("starts from the built-ins when the file is cut short, keeping it aside", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-cut-"));
    const path = join(root, "profiles.json");
    await writeFile(path, "", "utf8");
    const repository = new ProviderProfileRepository(path);

    const profiles = await repository.load();

    expect(profiles.map((profile) => profile.profileId)).toEqual(Object.values(BUILT_IN_PROVIDER_IDS));
    expect(repository.setAside).toMatch(/profiles\.json\.unreadable-\d+$/u);
    expect(await readFile(repository.setAside!, "utf8")).toBe("");
    await expect(new ProviderProfileRepository(path).load()).resolves.toEqual(profiles);
  });

  it("reads a file a later build wrote, without the fields this one does not know", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-later-"));
    const path = join(root, "profiles.json");
    const [apple, ...rest] = await new ProviderProfileRepository(path).load();
    const remote = {
      version: 1,
      profileId: "remote-openai",
      kind: "openai",
      label: "OpenAI",
      enabled: true,
      priority: 40,
      model: "gpt-test",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com/v1",
      apiProtocol: "responses",
      credentialRef: "remote-openai-key",
      pricing: { currency: "$", inputPerMillion: 1, outputPerMillion: 2, futureWriteInputPerMillion: 0.1 },
    };
    await writeFile(path, JSON.stringify({
      version: 1,
      writtenBy: "a later build",
      profiles: [{ ...apple, reasoningEffort: "low" }, ...rest, remote],
    }), "utf8");
    const repository = new ProviderProfileRepository(path);

    const profiles = await repository.load();

    expect(repository.setAside).toBeNull();
    expect(profiles[0]).toEqual(apple);
    expect(profiles.at(-1)).toEqual({ ...remote, pricing: { currency: "$", inputPerMillion: 1, outputPerMillion: 2 } });
  });

  it("keeps the profile fields added since 1.1.0 beside the file 1.1.0 reads, moving those an earlier build wrote into it", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-added-"));
    const path = join(root, "profiles.json");
    const profiles = await new ProviderProfileRepository(path).load();
    const remote = {
      version: 1,
      profileId: "remote-openai",
      kind: "openai",
      label: "OpenAI",
      enabled: true,
      priority: 40,
      model: "gpt-test",
      timeoutMs: 30_000,
      baseUrl: "https://api.openai.com/v1",
      apiProtocol: "responses",
      credentialRef: "remote-openai-key",
      proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
      jsonMode: "object",
      fallbackOnFailure: true,
      pricing: { currency: "$", inputPerMillion: 1, outputPerMillion: 2 },
    } as const;
    // Written by an earlier build of this version, the newer fields in the profile: 1.1.0 refused the file and quit.
    await writeFile(path, JSON.stringify({ version: 1, profiles: [...profiles, remote] }), "utf8");
    const repository = new ProviderProfileRepository(path);
    expect((await repository.load()).at(-1)).toEqual(remote);

    await repository.save({ ...remote, label: "OpenAI 主账号" });

    // What 1.1.0's strict schema takes, and nothing more.
    const written = JSON.parse(await readFile(path, "utf8")) as { profiles: Array<Record<string, unknown>> };
    expect(written.profiles.at(-1)).toEqual({
      version: 1, profileId: "remote-openai", kind: "openai", label: "OpenAI 主账号", enabled: true, priority: 40, model: "gpt-test",
      timeoutMs: 30_000, baseUrl: "https://api.openai.com/v1", apiProtocol: "responses", credentialRef: "remote-openai-key",
    });
    expect((await repository.load()).at(-1)).toEqual({ ...remote, label: "OpenAI 主账号" });

    // Saved by 1.1.0, which writes its own fields only: the others are still there.
    written.profiles.at(-1)!.timeoutMs = 60_000;
    await writeFile(path, JSON.stringify(written), "utf8");
    expect((await repository.load()).at(-1)).toEqual({ ...remote, label: "OpenAI 主账号", timeoutMs: 60_000 });
  });

  it("keeps both of two changes made at once, and sets aside a file of added fields it cannot read", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-concurrent-"));
    const path = join(root, "profiles.json");
    const repository = new ProviderProfileRepository(path);
    await repository.load();
    const remote = (profileId: string, priority: number) => ({
      version: 1, profileId, kind: "openai", label: profileId, enabled: true, priority, model: "gpt-test",
      timeoutMs: 30_000, baseUrl: "https://api.openai.com/v1", apiProtocol: "responses", credentialRef: `${profileId}-key`,
      proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
    } as const);

    // Two at once (a save while the model page refreshes its clients): each wrote what it had read, one change lost.
    await Promise.all([repository.save(remote("first", 40)), repository.save(remote("second", 50))]);
    expect((await repository.load()).map((profile) => profile.profileId)).toEqual(expect.arrayContaining(["first", "second"]));

    // The file beside them cut short: kept aside, where the next save wrote over it, its proxies gone for good.
    await writeFile(join(root, "profiles-extra.json"), "{\"profiles\":", "utf8");
    await repository.save(remote("third", 60));
    expect((await readdir(root)).some((name) => name.startsWith("profiles-extra.json.unreadable-"))).toBe(true);
    // And said: set aside without a word, a backend set to connect directly went through the environment's proxy.
    expect(repository.addedSetAside).toMatch(/profiles-extra\.json\.unreadable-\d+$/u);
  });

  it("keeps a proxy an earlier build wrote into the profile when a save cannot write the file beside the profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-moved-"));
    const path = join(root, "profiles.json");
    const builtIns = await new ProviderProfileRepository(join(root, "scratch.json")).load();
    const remote = {
      version: 1, profileId: "remote", kind: "openai", label: "OpenAI", enabled: true, priority: 40, model: "gpt-test",
      timeoutMs: 30_000, baseUrl: "https://api.openai.com/v1", apiProtocol: "responses", credentialRef: "remote-key",
      proxy: { mode: "direct" },
    } as const;
    // As an earlier build of this version wrote it: the proxy in the profile itself.
    await writeFile(path, JSON.stringify({ version: 1, profiles: [...builtIns, remote] }));
    const repository = new ProviderProfileRepository(path);
    await repository.load();

    failAddedWrites.on = true;
    try {
      await expect(repository.save({ ...remote, label: "OpenAI 主账号" })).rejects.toThrow(/ENOSPC/u);
    } finally {
      failAddedWrites.on = false;
    }

    // The profiles written first, the failed save took the proxy out of them and it was nowhere: the backend set to
    // connect directly went through the environment's proxy from then on.
    expect((await new ProviderProfileRepository(path).load()).find((profile) => profile.profileId === "remote")?.proxy).toEqual({ mode: "direct" });
  });

  it("merges discovered CLI paths without enabling or reprioritizing clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-cli-"));
    const path = join(root, "profiles.json");
    const repository = new ProviderProfileRepository(path);
    const before = await repository.load();

    await repository.refreshLocalClients([
      {
        kind: "codex-cli",
        executablePath: "/opt/homebrew/bin/codex",
        version: "0.146.0",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
      {
        kind: "claude-code-cli",
        executablePath: "/Users/demo/.volta/bin/claude",
        version: "2.1.220",
        authenticated: true,
        supported: true,
        availability: "available",
        checkedAt: "2026-07-30T00:00:00.000Z",
      },
    ]);

    const after = await repository.load();
    expect(
      after.find(
        (profile) =>
          profile.profileId === BUILT_IN_PROVIDER_IDS.codex,
      ),
    ).toMatchObject({
      enabled: false,
      priority: 20,
      executablePath: "/opt/homebrew/bin/codex",
    });
    expect(
      after.find(
        (profile) =>
          profile.profileId ===
          BUILT_IN_PROVIDER_IDS.claudeCode,
      ),
    ).toMatchObject({
      enabled: false,
      priority: 30,
      executablePath: "/Users/demo/.volta/bin/claude",
    });
    expect(
      after.map(({ profileId, enabled, priority }) => ({
        profileId,
        enabled,
        priority,
      })),
    ).toEqual(
      before.map(({ profileId, enabled, priority }) => ({
        profileId,
        enabled,
        priority,
      })),
    );
  });
});
