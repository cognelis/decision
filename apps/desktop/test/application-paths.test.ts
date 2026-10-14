import { isAbsolute, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applicationSupportPaths, configureElectronUserDataPath, resolveDefaultDecisionVaultPath, resolveDecisionUserData, resolveObsidianConfigurationPath } from "../src/main/application-paths.js";

describe("Electron application paths", () => {
  it("uses a dedicated absolute Obsidian search database", () => {
    const data = join(process.cwd(), "test-user-data");
    expect(applicationSupportPaths(data, {})).toMatchObject({ index: join(data, "index.sqlite"), obsidianSearchRoot: join(data, "obsidian-search") });
    expect(isAbsolute(applicationSupportPaths(data, {}).obsidianSearchRoot)).toBe(true);
  });
  it("resolves current platform defaults without modifying the filesystem", () => {
    expect(resolveDecisionUserData({}, { platform: "darwin", homeDirectory: "/home/demo" })).toMatchObject({ path: "/home/demo/Library/Application Support/Decision", state: "current" });
    expect(resolveDecisionUserData({ APPDATA: "D:\\Profiles\\Roaming" }, { platform: "win32", homeDirectory: "C:\\Users\\demo" }).path).toBe("D:\\Profiles\\Roaming\\Decision");
    expect(resolveDecisionUserData({ XDG_CONFIG_HOME: "/mnt/config" }, { platform: "linux", homeDirectory: "/home/demo" }).path).toBe("/mnt/config/decision");
  });
  it("applies a current explicit data directory before Electron initialization", () => {
    const setPath = vi.fn();
    expect(configureElectronUserDataPath({ setPath }, { DECISION_USER_DATA: "/custom/data" })).toEqual({ path: "/custom/data", state: "explicit", environmentSource: "current" });
    expect(setPath).toHaveBeenCalledWith("userData", "/custom/data");
  });
  it("uses a current default vault and native Obsidian configuration paths", () => {
    expect(resolveDefaultDecisionVaultPath("C:\\Users\\demo\\OneDrive\\Documents")).toBe(join("C:\\Users\\demo\\OneDrive\\Documents", "Decision Vault"));
    expect(resolveObsidianConfigurationPath({ platform: "darwin", homeDirectory: "/Users/demo" })).toBe("/Users/demo/Library/Application Support/obsidian/obsidian.json");
    expect(resolveObsidianConfigurationPath({ platform: "win32", homeDirectory: "C:\\Users\\demo", appData: "D:\\Roaming" })).toBe("D:\\Roaming\\obsidian\\obsidian.json");
    expect(resolveObsidianConfigurationPath({ platform: "linux", homeDirectory: "/home/demo", xdgConfigHome: "/mnt/config" })).toBe("/mnt/config/obsidian/obsidian.json");
  });
});
