import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  SettingsRepository,
  discoverObsidianVaults,
  withModelTraceContentEnabled,
  withVaultPath,
} from "../src/main/settings.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "decision-settings-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("SettingsRepository", () => {
  it("uses safe defaults and atomically saves validated settings", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    const repository = new SettingsRepository(path);

    await expect(repository.load()).resolves.toEqual({
      version: 3,
      vaultPath: null,
      theme: "auto",
      modelTraceContentEnabled: true,
    });
    await repository.save({
      version: 3,
      vaultPath: "/Users/example/Vault",
      theme: "dark",
      modelTraceContentEnabled: false,
    });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 3,
      vaultPath: "/Users/example/Vault",
      theme: "dark",
      modelTraceContentEnabled: false,
    });
  });

  it("migrates v1 settings without changing the vault", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, vaultPath: "/vault/existing" }),
      "utf8",
    );

    await expect(new SettingsRepository(path).load()).resolves.toEqual({
      version: 3,
      vaultPath: "/vault/existing",
      theme: "auto",
      modelTraceContentEnabled: true,
    });
  });

  it("migrates v2 settings with model trace content enabled", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        vaultPath: "/vault/existing",
        theme: "light",
      }),
      "utf8",
    );

    await expect(new SettingsRepository(path).load()).resolves.toEqual({
      version: 3,
      vaultPath: "/vault/existing",
      theme: "light",
      modelTraceContentEnabled: true,
    });
  });

  it.each(["auto", "light", "dark"] as const)(
    "round trips the %s theme",
    async (theme) => {
      const directory = await temporaryDirectory();
      const path = join(directory, "settings.json");
      const repository = new SettingsRepository(path);
      const settings = {
        version: 3 as const,
        vaultPath: "/vault",
        theme,
        modelTraceContentEnabled: true,
      };

      await repository.save(settings);

      await expect(repository.load()).resolves.toEqual(settings);
    },
  );

  it("rejects an unsupported theme", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        vaultPath: "/vault",
        theme: "sepia",
      }),
      "utf8",
    );

    await expect(new SettingsRepository(path).load()).rejects.toThrow(
      /settings/i,
    );
  });

  it("preserves theme when updating the vault", () => {
    expect(
      withVaultPath(
        {
          version: 3,
          vaultPath: "/old",
          theme: "dark",
          modelTraceContentEnabled: false,
        },
        "/new",
      ),
    ).toEqual({
      version: 3,
      vaultPath: "/new",
      theme: "dark",
      modelTraceContentEnabled: false,
    });
  });

  it("preserves other settings when toggling trace content", () => {
    expect(
      withModelTraceContentEnabled(
        {
          version: 3,
          vaultPath: "/vault",
          theme: "dark",
          modelTraceContentEnabled: true,
        },
        false,
      ),
    ).toEqual({
      version: 3,
      vaultPath: "/vault",
      theme: "dark",
      modelTraceContentEnabled: false,
    });
  });

  it("rejects corrupted settings instead of silently overwriting them", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, "{broken", "utf8");

    await expect(new SettingsRepository(path).load()).rejects.toThrow(
      /settings/i,
    );
  });
});

describe("discoverObsidianVaults", () => {
  it("orders the last-open vault before other configured vaults", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "obsidian.json");
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: {
          a: { path: "/vault/archive", ts: 1 },
          b: { path: "/vault/current", ts: 2, open: true },
        },
      }),
      "utf8",
    );

    await expect(discoverObsidianVaults(configPath)).resolves.toEqual([
      "/vault/current",
      "/vault/archive",
    ]);
  });
});
