import { describe, expect, it, vi } from "vitest";

import {
  configureElectronUserDataPath,
  resolveDefaultDecisionVaultPath,
  resolveDecisionUserData,
  resolveObsidianConfigurationPath,
  type UserDataFileSystem,
} from "../src/main/application-paths.js";

const currentPath = "/home/Library/Application Support/Decision";
const legacyPath = "/home/Library/Application Support/Decision Island";

const fileSystem = (
  initialPaths: readonly string[],
  renameError?: Error,
): UserDataFileSystem & { paths: Set<string> } => {
  const paths = new Set(initialPaths);
  return {
    paths,
    existsSync: vi.fn((path: string) => paths.has(path)),
    renameSync: vi.fn((source: string, destination: string) => {
      if (renameError !== undefined) {
        throw renameError;
      }
      paths.delete(source);
      paths.add(destination);
    }),
    writeFileSync: vi.fn(),
  };
};

const configure = (
  initialPaths: readonly string[],
  environment: NodeJS.ProcessEnv = {},
  renameError?: Error,
) => {
  const setPath = vi.fn();
  const fs = fileSystem(initialPaths, renameError);
  const result = configureElectronUserDataPath(
    { setPath },
    environment,
    {
      fileSystem: fs,
      homeDirectory: "/home",
      platform: "darwin",
      now: () => "2026-08-15T00:00:00.000Z",
    },
  );
  return { fs, result, setPath };
};

describe("Electron application paths", () => {
  it("uses the roaming profile for Windows data and Obsidian discovery", () => {
    const fs = fileSystem([]);
    const result = resolveDecisionUserData(
      { APPDATA: "D:\\Profiles\\Ada\\Roaming" },
      {
        fileSystem: fs,
        homeDirectory: "C:\\Users\\Ada",
        platform: "win32",
      },
    );

    expect(result.path).toBe("D:\\Profiles\\Ada\\Roaming\\Decision");
    expect(
      resolveObsidianConfigurationPath({
        platform: "win32",
        homeDirectory: "C:\\Users\\Ada",
        appData: "D:\\Profiles\\Ada\\Roaming",
      }),
    ).toBe("D:\\Profiles\\Ada\\Roaming\\obsidian\\obsidian.json");
  });

  it("uses native macOS and XDG Obsidian configuration paths", () => {
    expect(
      resolveObsidianConfigurationPath({
        platform: "darwin",
        homeDirectory: "/Users/ada",
      }),
    ).toBe(
      "/Users/ada/Library/Application Support/obsidian/obsidian.json",
    );
    expect(
      resolveObsidianConfigurationPath({
        platform: "linux",
        homeDirectory: "/home/ada",
        xdgConfigHome: "/mnt/config",
      }),
    ).toBe("/mnt/config/obsidian/obsidian.json");
  });

  it("uses the legacy default vault only when it is the existing history", () => {
    const currentVault = "/home/Documents/Decision Vault";
    const legacyVault = "/home/Documents/Decision Island Vault";

    expect(
      resolveDefaultDecisionVaultPath(
        "/home",
        (path) => path === legacyVault,
      ),
    ).toBe(legacyVault);
    expect(
      resolveDefaultDecisionVaultPath(
        "/home",
        (path) => path === currentVault || path === legacyVault,
      ),
    ).toBe(currentVault);
    expect(resolveDefaultDecisionVaultPath("/home", () => false)).toBe(
      currentVault,
    );
  });

  it("prefers a current explicit user-data override", () => {
    const { fs, result, setPath } = configure([], {
      DECISION_USER_DATA: "/current/override",
      DECISION_ISLAND_USER_DATA: "/legacy/override",
    });

    expect(result).toEqual({
      environmentSource: "current",
      path: "/current/override",
      state: "explicit",
    });
    expect(setPath).toHaveBeenCalledWith("userData", "/current/override");
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it("keeps a legacy explicit override usable throughout 1.x", () => {
    const { fs, result, setPath } = configure([], {
      DECISION_ISLAND_USER_DATA: "/legacy/override",
    });

    expect(result).toEqual({
      environmentSource: "legacy",
      path: "/legacy/override",
      state: "explicit",
    });
    expect(setPath).toHaveBeenCalledWith("userData", "/legacy/override");
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it("atomically migrates the legacy default before taking the lock", () => {
    const { fs, result, setPath } = configure([legacyPath]);

    expect(result).toEqual({
      environmentSource: "default",
      path: currentPath,
      state: "migrated",
    });
    expect(fs.renameSync).toHaveBeenCalledWith(legacyPath, currentPath);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${currentPath}/.cognelis-migration-v1.json`,
      expect.stringContaining('"sourceDirectory":"Decision Island"'),
      { encoding: "utf8", mode: 0o600 },
    );
    expect(setPath).toHaveBeenCalledWith("userData", currentPath);
  });

  it("uses the current directory without touching the legacy directory", () => {
    const { fs, result } = configure([currentPath]);

    expect(result).toEqual({
      environmentSource: "default",
      path: currentPath,
      state: "current",
    });
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it("uses the current directory and reports a conflict when both exist", () => {
    const { fs, result } = configure([legacyPath, currentPath]);

    expect(result).toEqual({
      environmentSource: "default",
      path: currentPath,
      state: "conflict",
    });
    expect(fs.renameSync).not.toHaveBeenCalled();
  });

  it("falls back to the intact legacy directory when the rename fails", () => {
    const { fs, result, setPath } = configure(
      [legacyPath],
      {},
      new Error("read-only parent"),
    );

    expect(result).toEqual({
      environmentSource: "default",
      migrationError: "read-only parent",
      path: legacyPath,
      state: "legacy-fallback",
    });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(setPath).toHaveBeenCalledWith("userData", legacyPath);
  });

  it("is idempotent after a successful migration", () => {
    const fs = fileSystem([legacyPath]);
    const firstSetPath = vi.fn();
    const options = {
      fileSystem: fs,
      homeDirectory: "/home",
      platform: "darwin" as const,
      now: () => "2026-08-15T00:00:00.000Z",
    };

    const first = configureElectronUserDataPath(
      { setPath: firstSetPath },
      {},
      options,
    );
    const second = configureElectronUserDataPath(
      { setPath: vi.fn() },
      {},
      options,
    );

    expect(first.state).toBe("migrated");
    expect(second.state).toBe("current");
    expect(fs.renameSync).toHaveBeenCalledTimes(1);
  });
});
