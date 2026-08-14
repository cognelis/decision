import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("rejects incomplete reorder lists and corrupt duplicate documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-corrupt-"));
    const path = join(root, "profiles.json");
    const repository = new ProviderProfileRepository(path);
    const profiles = await repository.load();

    await expect(
      repository.reorder([BUILT_IN_PROVIDER_IDS.apple]),
    ).rejects.toThrow(/every profile/i);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        profiles: [profiles[0], profiles[0]],
      }),
      "utf8",
    );
    await expect(repository.load()).rejects.toThrow(/duplicate/i);
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
