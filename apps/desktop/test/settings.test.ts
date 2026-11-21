import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

// A write to be refused, by the file it is for: the settings are saved through three, each failing on its own.
const refused = vi.hoisted(() => ({ file: undefined as string | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const writeFile = (async (path: Parameters<typeof fs.writeFile>[0], ...rest: unknown[]) => {
    // The temporary file a save writes first: `<file>.<pid>.<uuid>.tmp`.
    if (refused.file !== undefined && typeof path === "string" && path.includes(`/${refused.file}.`) && path.endsWith(".tmp")) {
      throw Object.assign(new Error(`EIO: i/o error, write ${refused.file}`), { code: "EIO" });
    }
    return (fs.writeFile as (...args: unknown[]) => Promise<void>)(path, ...rest);
  }) as typeof fs.writeFile;
  return { ...fs, writeFile, default: { ...fs, writeFile } };
});

import {
  SettingsRepository,
  discoverObsidianVaults,
  serializeSettingsChanges,
  withAccent,
  withCaptureClassifier,
  captureClassifierMoveFailedMessage,
  withModelTraceContentEnabled,
  withTheme,
  type AppSettings,
  withVaultPath,
} from "../src/main/settings.js";
// The build before IMP-153, frozen from 5409f3c8 (fixtures/settings-5409f3c8/README.md).
import {
  SettingsRepository as SettingsRepositoryBeforeImp153,
  withTheme as withThemeBeforeImp153,
} from "./fixtures/settings-5409f3c8/main/settings.js";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "decision-settings-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  refused.file = undefined;
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
      captureClassifier: "local" as const,
      accent: "blue" as const,
    });
    await repository.save({
      version: 3,
      vaultPath: "/Users/example/Vault",
      theme: "dark",
      modelTraceContentEnabled: false,
      reviewRemindersEnabled: true,
      localCredentialsEnabled: false,
      captureClassifier: "rules" as const,
      accent: "blue" as const,
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
      accent: "blue" as const,
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
      accent: "blue" as const,
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
      accent: "blue" as const,
    });
  });

  // A start as main/index.ts makes it: loaded, then moved off the old default once (IMP-154).
  const start = async (path: string) => {
    const repository = new SettingsRepository(path);
    const settings = await repository.moveCaptureClassifier(await repository.load());
    return { repository, settings };
  };
  /** As a build before IMP-153 saved every settings file: `rules` beside it, written whether chosen or not. */
  const savedBeforeImp153 = async (directory: string, captureClassifier = "rules") => {
    const path = join(directory, "settings.json");
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault", theme: "auto", modelTraceContentEnabled: true }));
    await writeFile(join(directory, "settings-extra.json"), JSON.stringify({ captureClassifier, reviewRemindersEnabled: true }));
    return path;
  };

  it("starts a new install on the rules plus this machine's model, and keeps `rules` chosen there (IMP-153)", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    const first = await start(path);
    expect(first.settings.captureClassifier).toBe("local");
    await first.repository.save(withCaptureClassifier(first.settings, "rules"));

    await expect(start(path)).resolves.toMatchObject({ settings: { captureClassifier: "rules" } });
  });

  it("moves the old default `rules` once, recorded in a file of its own, and keeps `rules` chosen after it (IMP-154)", async () => {
    const directory = await temporaryDirectory();
    const path = await savedBeforeImp153(directory);

    const moved = await start(path);
    expect(moved.settings.captureClassifier).toBe("local");
    expect(moved.repository.captureClassifierMoveFailed).toBeNull();
    // Saved before it is used, with its record beside the settings.
    expect(JSON.parse(await readFile(join(directory, "settings-extra.json"), "utf8"))).toMatchObject({ captureClassifier: "local" });
    expect(JSON.parse(await readFile(join(directory, "settings-migrations.json"), "utf8"))).toEqual({ captureClassifier: "decided" });

    await moved.repository.save(withCaptureClassifier(moved.settings, "rules"));
    for (let restart = 0; restart < 2; restart += 1) {
      await expect(start(path)).resolves.toMatchObject({ settings: { captureClassifier: "rules" } });
    }
  });

  it("leaves `models` where it was when it moves the old default (IMP-154)", async () => {
    const directory = await temporaryDirectory();
    await expect(start(await savedBeforeImp153(directory, "models"))).resolves.toMatchObject({ settings: { captureClassifier: "models" } });
  });

  it("keeps `rules` chosen after the move through a build before IMP-153 saving another setting (IMP-154)", async () => {
    const directory = await temporaryDirectory();
    const path = await savedBeforeImp153(directory);
    const upgraded = await start(path);
    await upgraded.repository.save(withCaptureClassifier(upgraded.settings, "rules"));

    // Back on the build before: the theme changed and saved, which writes every field it knows and no other.
    const before = new SettingsRepositoryBeforeImp153(path);
    await before.save(withThemeBeforeImp153(await before.load(), "dark"));

    await expect(start(path)).resolves.toMatchObject({ settings: { captureClassifier: "rules", theme: "dark" } });
  });

  it("keeps the old classifier, saying why, rather than use the new default it could not save (IMP-154)", async () => {
    const directory = await temporaryDirectory();
    const path = await savedBeforeImp153(directory);
    await chmod(directory, 0o500);
    try {
      const failed = await start(path);
      expect(failed.settings.captureClassifier).toBe("rules");
      expect(failed.repository.captureClassifierMoveFailed).toMatchObject({ reason: expect.stringMatching(/EACCES|permission/iu), retried: true });
      // Nothing written, and a later save at this start does not record a move it never made.
      await expect(failed.repository.save(withTheme(failed.settings, "dark"))).rejects.toThrow();
    } finally {
      await chmod(directory, 0o700);
    }
    expect(JSON.parse(await readFile(join(directory, "settings-extra.json"), "utf8"))).toMatchObject({ captureClassifier: "rules" });
    await expect(readFile(join(directory, "settings-migrations.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Tried again at the next start, the folder writable again.
    const retried = await start(path);
    expect(retried.settings.captureClassifier).toBe("local");
    expect(retried.repository.captureClassifierMoveFailed).toBeNull();
  });

  it.each([
    // The record is written first: refused, nothing changes and the next start tries again.
    ["settings-migrations.json", "rules", true, "local"],
    // Recorded, then the classifier beside the settings refused: kept as it was, and not moved again.
    ["settings-extra.json", "rules", false, "rules"],
    // Recorded, the classifier written beside the settings, then the settings refused: the move stands, recorded.
    ["settings.json", "rules", false, "local"],
  ] as const)("never uses the new default without its record when the write of %s is refused (IMP-154)", async (file, kept, retried, next) => {
    const directory = await temporaryDirectory();
    const path = await savedBeforeImp153(directory);
    refused.file = file;
    const failed = await start(path);
    expect(failed.settings.captureClassifier).toBe(kept);
    expect(failed.repository.captureClassifierMoveFailed).toMatchObject({ reason: expect.stringContaining("EIO"), retried });
    refused.file = undefined;

    const restarted = await start(path);
    expect(restarted.settings.captureClassifier).toBe(next);
    expect(restarted.repository.captureClassifierMoveFailed).toBeNull();
    const recorded = await readFile(join(directory, "settings-migrations.json"), "utf8").then(() => true, () => false);
    // The one thing never seen: the new default with no record of the move.
    expect(recorded || restarted.settings.captureClassifier !== "local").toBe(true);
    expect(recorded).toBe(next === "local" || !retried);
  });

  it("keeps `rules` chosen by the reader after a move that failed (IMP-154)", async () => {
    const directory = await temporaryDirectory();
    const path = await savedBeforeImp153(directory);
    refused.file = "settings-migrations.json";
    const failed = await start(path);
    expect(failed.settings.captureClassifier).toBe("rules");
    refused.file = undefined;

    // As main/index.ts saves a classifier chosen in the models page.
    await failed.repository.recordCaptureClassifierDecided();
    await failed.repository.save(withCaptureClassifier(failed.settings, "rules"));

    for (let restart = 0; restart < 2; restart += 1) {
      await expect(start(path)).resolves.toMatchObject({ settings: { captureClassifier: "rules" } });
    }
  });

  it("saves no classifier the reader chose when its decision cannot be recorded", async () => {
    const directory = await temporaryDirectory();
    const repository = new SettingsRepository(await savedBeforeImp153(directory));
    refused.file = "settings-migrations.json";
    await expect(repository.recordCaptureClassifierDecided()).rejects.toThrow("EIO");
  });

  it("names the classifier a failed move kept, and what the reader's turns go to on 规则加模型 (IMP-154)", () => {
    const retried = { reason: "EACCES: permission denied", retried: true };
    expect(captureClassifierMoveFailedMessage("rules", retried)).toBe(
      "设置保存不了（EACCES: permission denied），采集分类这次仍按「只用规则」。请检查设置所在文件夹的写入权限，下次启动会再试一次；也可以在模型页手动选择。",
    );
    expect(captureClassifierMoveFailedMessage("local", retried)).toContain("这次仍按「规则加本机模型」。");
    expect(captureClassifierMoveFailedMessage("models", retried)).toContain(
      "这次仍按「规则加模型」：每一轮对话都会按模型页的后端顺序发给所选后端，可能是命令行或远程服务。",
    );
    expect(captureClassifierMoveFailedMessage("rules", { ...retried, retried: false })).toContain("之后不会再自动更改");
    for (const kept of ["rules", "local"] as const) {
      expect(captureClassifierMoveFailedMessage(kept, retried)).not.toContain("远程");
    }
  });

  it.each(["local", "models"] as const)("keeps %s through a move whose record cannot be written, saying so", async (stored) => {
    const directory = await temporaryDirectory();
    refused.file = "settings-migrations.json";
    const failed = await start(await savedBeforeImp153(directory, stored));
    expect(failed.settings.captureClassifier).toBe(stored);
    expect(failed.repository.captureClassifierMoveFailed).toMatchObject({ retried: true });
  });

  it("records no move at a start that made none, for a later start to make it", async () => {
    const directory = await temporaryDirectory();
    const path = await savedBeforeImp153(directory);
    const repository = new SettingsRepository(path);
    // Loaded and saved without the move (what a failed move leaves): `rules` stays the old default, not a choice.
    await repository.save(withTheme(await repository.load(), "dark"));
    await expect(readFile(join(directory, "settings-migrations.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(start(path)).resolves.toMatchObject({ settings: { captureClassifier: "local", theme: "dark" } });
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
      accent: "blue" as const,
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
      accent: "blue" as const,
    });

    // Changed since in an earlier build, which writes into the file: that is the later word.
    await writeFile(path, JSON.stringify({ version: 3, vaultPath: "/vault 2", theme: "light", modelTraceContentEnabled: false, captureClassifier: "rules" }));
    await expect(repository.load()).resolves.toMatchObject({ captureClassifier: "rules", reviewRemindersEnabled: false });
  });

  it("keeps the theme colour beside the settings, and reads one it cannot use as the default (IMP-140)", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "settings.json");
    const repository = new SettingsRepository(path);
    await repository.save(withAccent(await repository.load(), "#4D7C0F"));

    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("accent");
    expect(JSON.parse(await readFile(join(directory, "settings-extra.json"), "utf8"))).toMatchObject({ accent: "#4d7c0f" });
    await expect(repository.load()).resolves.toMatchObject({ accent: "#4d7c0f" });

    await writeFile(join(directory, "settings-extra.json"), JSON.stringify({ accent: "chartreuse" }));
    await expect(repository.load()).resolves.toMatchObject({ accent: "blue" });
  });

  it("makes each settings change to what the one before left, one at a time (IMP-140)", async () => {
    const directory = await temporaryDirectory();
    let settings = await new SettingsRepository(join(directory, "settings.json")).load();
    const saved: AppSettings[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const change = serializeSettingsChanges(() => settings, async (next) => {
      if (saved.length === 0) await firstHeld;
      saved.push(next);
      settings = next;
    });

    // The theme still saving when the colour is chosen: built from the settings then, the colour put the theme back.
    const theme = change((current) => withTheme(current, "dark"));
    const accent = change((current) => withAccent(current, "purple"));
    releaseFirst();
    await Promise.all([theme, accent]);

    expect(saved.map((next) => [next.theme, next.accent])).toEqual([["dark", "blue"], ["dark", "purple"]]);
    expect(settings).toMatchObject({ theme: "dark", accent: "purple" });
    // A change that failed leaves the next one to run.
    await expect(change(() => { throw new Error("refused"); })).rejects.toThrow("refused");
    await expect(change((current) => withTheme(current, "light"))).resolves.toMatchObject({ theme: "light", accent: "purple" });
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

    await expect(new SettingsRepository(path).load()).rejects.toThrow(/更新版本的 Paraself/u);
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
      accent: "blue" as const,
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
      accent: "blue" as const,
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
      accent: "blue" as const,
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
      accent: "blue" as const,
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

it("persists and clears the global model proxy beside existing settings, rejecting credential URLs", async () => {
  const directory = await temporaryDirectory(); const path = join(directory, "settings.json");
  const repository = new SettingsRepository(path); const settings = await repository.load();
  await repository.save({ ...settings, modelProxyUrl: "http://127.0.0.1:7890" });
  expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("modelProxyUrl");
  expect(JSON.parse(await readFile(join(directory, "settings-extra.json"), "utf8"))).toMatchObject({ modelProxyUrl: "http://127.0.0.1:7890" });
  expect((await new SettingsRepository(path).load()).modelProxyUrl).toBe("http://127.0.0.1:7890");
  const credential = new URL("http://proxy.test:8080"); credential.username = "synthetic"; credential.password = "synthetic";
  for (const url of [credential.href, "socks5://proxy.test:1080", "http://proxy.test/path", "http://proxy.test/?token=x"]) await expect(repository.save({ ...settings, modelProxyUrl: url })).rejects.toThrow();
  expect((await repository.load()).modelProxyUrl).toBe("http://127.0.0.1:7890");
  await repository.save({ ...settings, modelProxyUrl: null });
  expect((await new SettingsRepository(path).load()).modelProxyUrl).toBeNull();
});
