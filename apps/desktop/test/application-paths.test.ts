import { readFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applicationSupportPaths, configureElectronUserDataPath, resolveDefaultVaultPath, resolveObsidianConfigurationPath } from "../src/main/application-paths.js";

describe("Electron application paths", () => {
  it("uses a dedicated absolute Obsidian search database", () => {
    const data = join(process.cwd(), "test-user-data");
    expect(applicationSupportPaths(data, {})).toMatchObject({ index: join(data, "index.sqlite"), obsidianSearchRoot: join(data, "obsidian-search") });
    expect(isAbsolute(applicationSupportPaths(data, {}).obsidianSearchRoot)).toBe(true);
  });
  it("resolves current platform defaults without modifying the filesystem", () => {
    const fileSystem = { existsSync: () => false, renameSync: () => { throw new Error("nothing is moved"); } };
    const setPath = vi.fn();
    expect(configureElectronUserDataPath({ setPath }, {}, { platform: "darwin", homeDirectory: "/home/demo", fileSystem })).toMatchObject({ path: "/home/demo/Library/Application Support/Paraself", state: "current" });
    expect(configureElectronUserDataPath({ setPath }, { APPDATA: "D:\\Profiles\\Roaming" }, { platform: "win32", homeDirectory: "C:\\Users\\demo", fileSystem }).path).toBe("D:\\Profiles\\Roaming\\Paraself");
    expect(configureElectronUserDataPath({ setPath }, { XDG_CONFIG_HOME: "/mnt/config" }, { platform: "linux", homeDirectory: "/home/demo", fileSystem }).path).toBe("/mnt/config/paraself");
  });
  it("applies an explicit data directory before Electron initialization, by its name now or as Decision's", () => {
    const setPath = vi.fn();
    expect(configureElectronUserDataPath({ setPath }, { PARASELF_USER_DATA: "/custom/data" })).toEqual({ path: "/custom/data", state: "explicit", environmentSource: "current" });
    expect(setPath).toHaveBeenCalledWith("userData", "/custom/data");
    expect(configureElectronUserDataPath({ setPath }, { DECISION_USER_DATA: "/older/data" })).toEqual({ path: "/older/data", state: "explicit", environmentSource: "legacy" });
    expect(setPath).toHaveBeenLastCalledWith("userData", "/older/data");
  });
  it("starts a first run's vault as Paraself's, keeping one Decision made there", () => {
    const documents = "C:\\Users\\demo\\OneDrive\\Documents";
    expect(resolveDefaultVaultPath(documents, () => false)).toBe(join(documents, "Paraself Vault"));
    expect(resolveDefaultVaultPath(documents, (path) => path === join(documents, "Decision Vault"))).toBe(join(documents, "Decision Vault"));
    expect(resolveDefaultVaultPath(documents, () => true)).toBe(join(documents, "Paraself Vault"));
  });
  it("uses native Obsidian configuration paths", () => {
    expect(resolveObsidianConfigurationPath({ platform: "darwin", homeDirectory: "/Users/demo" })).toBe("/Users/demo/Library/Application Support/obsidian/obsidian.json");
    expect(resolveObsidianConfigurationPath({ platform: "win32", homeDirectory: "C:\\Users\\demo", appData: "D:\\Roaming" })).toBe("D:\\Roaming\\obsidian\\obsidian.json");
    expect(resolveObsidianConfigurationPath({ platform: "linux", homeDirectory: "/home/demo", xdgConfigHome: "/mnt/config" })).toBe("/mnt/config/obsidian/obsidian.json");
  });
  // Where each README says what in the data folder can be deleted and rebuilt from the notes, every database is named:
  // it once called them all rebuildable, and local-decisions.sqlite, the only copy of what is kept on this Mac alone,
  // read as one more cache to clear.
  it("names every database in the data folder where each README says which can be rebuilt", () => {
    const databases = Object.values(applicationSupportPaths("/data", {})).filter((path) => path.endsWith(".sqlite")).map((path) => basename(path));
    expect(databases).toContain("local-decisions.sqlite");
    for (const [file, heading, notRebuildable] of [
      ["README.md", "## Data and privacy", /`local-decisions\.sqlite`[^\n]*cannot be rebuilt/u],
      ["README.zh-CN.md", "## 数据与隐私", /`local-decisions\.sqlite`[^\n]*不能[^\n]*重建/u],
    ] as const) {
      const readme = readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");
      const start = readme.indexOf(heading);
      expect(start, file).toBeGreaterThan(-1);
      const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
      expect(databases.filter((name) => !section.includes(`\`${name}\``)), file).toEqual([]);
      expect(section).toMatch(notRebuildable);
    }
  });
});
