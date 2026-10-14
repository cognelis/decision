import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
    });
    await repository.save({
      version: 3,
      vaultPath: "/Users/example/Vault",
      theme: "dark",
      modelTraceContentEnabled: false,
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
    });

    // The fields 1.1.0 does not know are left out at their defaults: written, 1.1.0 quit at once on the file.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 3,
      vaultPath: "/Users/example/Vault",
      theme: "dark",
      modelTraceContentEnabled: false,
    });
    await expect(repository.load()).resolves.toMatchObject({
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules",
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
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
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
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
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
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
      };

      await repository.save(settings);

      await expect(repository.load()).resolves.toEqual(settings);
    },
  );

  it("defaults old v3 files to system encryption and persists local mode", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: null, theme: "auto", modelTraceContentEnabled: true }));
    const repository = new SettingsRepository(path);
    const settings = await repository.load();
    expect(settings.localCredentialsEnabled).toBe(false);
    await repository.save({ ...settings, localCredentialsEnabled: true });
    expect((await repository.load()).localCredentialsEnabled).toBe(true);
  });

  it("keeps the settings added since 1.1.0 beside the file 1.1.0 reads, moving those an earlier build wrote into it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    // Changed in an earlier build of this version, written into the file itself: 1.1.0 refused it and quit.
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault", theme: "dark", modelTraceContentEnabled: true, captureClassifier: "models", localCredentialsEnabled: true }));
    const repository = new SettingsRepository(path);
    const settings = await repository.load();
    expect(settings).toMatchObject({ captureClassifier: "models", localCredentialsEnabled: true, reviewRemindersEnabled: true });

    await repository.save({ ...settings, reviewRemindersEnabled: false });

    // What 1.1.0's strict settings take, and nothing more.
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 3, vaultPath: "/vault", theme: "dark", modelTraceContentEnabled: true });
    await expect(repository.load()).resolves.toMatchObject({ captureClassifier: "models", localCredentialsEnabled: true, reviewRemindersEnabled: false });

    // Saved by 1.1.0, which writes its own fields only: the others are still there.
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault 2", theme: "light", modelTraceContentEnabled: false }));
    await expect(repository.load()).resolves.toEqual({
      version: 3,
      vaultPath: "/vault 2",
      theme: "light",
      modelTraceContentEnabled: false,
      reviewRemindersEnabled: false,
      localCredentialsEnabled: true,
      captureClassifier: "models",
    });

    // Changed since in an earlier build, which writes into the file: that is the later word.
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault 2", theme: "light", modelTraceContentEnabled: false, captureClassifier: "rules" }));
    await expect(repository.load()).resolves.toMatchObject({ captureClassifier: "rules", reviewRemindersEnabled: false });
  });

  it("keeps aside a file of added settings it cannot read, rather than writing over it at the next save", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault", theme: "dark", modelTraceContentEnabled: true }));
    // Cut short beside the settings (a sync conflict, a disk error).
    await writeFile(join(directory, "settings-extra.json"), "{\"captureClassifier\": \"mod");
    const repository = new SettingsRepository(path);

    await repository.save(await repository.load());

    // Read as nothing and left in place, the save wrote over it for good.
    expect((await readdir(directory)).some((name) => name.startsWith("settings-extra.json.unreadable-"))).toBe(true);
    // And said, as the settings file is: set aside without a word, the settings it held went to their defaults.
    expect(repository.addedSetAside).toMatch(/settings-extra\.json\.unreadable-\d+$/u);
  });

  it("keeps a setting an earlier build wrote into the file when a save cannot write the file beside it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault", theme: "dark", modelTraceContentEnabled: true, localCredentialsEnabled: true }));
    const repository = new SettingsRepository(path);
    const settings = await repository.load();

    // Something in the way of the file beside the settings for this one save (a full disk does the same).
    await mkdir(join(directory, "settings-extra.json"));
    await expect(repository.save({ ...settings, theme: "light" })).rejects.toThrow();
    await rm(join(directory, "settings-extra.json"), { recursive: true });

    // The file written first, the failed save took the setting out of it, and it was nowhere.
    await expect(new SettingsRepository(path).load()).resolves.toMatchObject({ localCredentialsEnabled: true });
  });

  it("still starts on a v3 file a later build added a setting to", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault", theme: "dark", modelTraceContentEnabled: true, someLaterSetting: true }));

    await expect(new SettingsRepository(path).load()).resolves.toMatchObject({ vaultPath: "/vault", theme: "dark" });
  });

  it("reads a theme it does not know, from a later build, as the default rather than refusing to start", async () => {
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

    await expect(new SettingsRepository(path).load()).resolves.toMatchObject({
      vaultPath: "/vault",
      theme: "auto",
    });
  });

  it("refuses a file a later version wrote, without moving it", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    const later = JSON.stringify({ version: 4, vaultPath: "/vault" });
    await writeFile(path, later, "utf8");

    await expect(new SettingsRepository(path).load()).rejects.toThrow(/更新版本的 Decision/u);
    expect(await readFile(path, "utf8")).toBe(later);
  });

  it("preserves theme when updating the vault", () => {
    expect(
      withVaultPath(
        {
          version: 3,
          vaultPath: "/old",
          theme: "dark",
          modelTraceContentEnabled: false,
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
        },
        "/new",
      ),
    ).toEqual({
      version: 3,
      vaultPath: "/new",
      theme: "dark",
      modelTraceContentEnabled: false,
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
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
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
        },
        false,
      ),
    ).toEqual({
      version: 3,
      vaultPath: "/vault",
      theme: "dark",
      modelTraceContentEnabled: false,
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
    });
  });

  it("starts from the defaults with a corrupted file kept aside, not written over", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    await writeFile(path, "{broken", "utf8");
    const repository = new SettingsRepository(path);

    // Cut short when the power went during a save: no way in at all was the alternative.
    await expect(repository.load()).resolves.toMatchObject({ version: 3, vaultPath: null, theme: "auto" });
    expect(repository.setAside).toMatch(/settings\.json\.unreadable-\d+$/u);
    expect(await readFile(repository.setAside!, "utf8")).toBe("{broken");
  });
});

describe("discoverObsidianVaults", () => {
  it("orders the last-open vault before other configured vaults", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "obsidian.json");
    const archive = join(directory, "archive");
    const current = join(directory, "current");
    await mkdir(archive);
    await mkdir(current);
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: {
          a: { path: archive, ts: 1 },
          b: { path: current, ts: 2, open: true },
        },
      }),
      "utf8",
    );

    await expect(discoverObsidianVaults(configPath)).resolves.toEqual([current, archive]);
  });

  it("passes over a vault Obsidian still lists after it was moved or deleted", async () => {
    const directory = await temporaryDirectory();
    const configPath = join(directory, "obsidian.json");
    const present = join(directory, "present");
    await mkdir(present);
    await writeFile(
      configPath,
      JSON.stringify({
        vaults: {
          // Moved away since, still marked open: chosen, an empty folder was made in its place for the decisions.
          gone: { path: join(directory, "moved-away"), ts: 9, open: true },
          here: { path: present, ts: 1 },
        },
      }),
      "utf8",
    );

    await expect(discoverObsidianVaults(configPath)).resolves.toEqual([present]);
  });
});
