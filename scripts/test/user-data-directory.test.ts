import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveUserData, userDataDirectories } from "../../config/user-data-directory.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A home of its own: XDG_CONFIG_HOME in a temporary folder, nothing of the reader's looked at. */
const configHome = async () => {
  const root = await mkdtemp(join(tmpdir(), "paraself-user-data-"));
  roots.push(root);
  const environment = { XDG_CONFIG_HOME: root };
  return { environment, ...userDataDirectories("linux", root, environment) };
};
const at = (environment: NodeJS.ProcessEnv, options: { migrate?: boolean } = {}) =>
  resolveUserData(environment, { platform: "linux", homeDirectory: "/nowhere", ...options });

describe("the App's data folder", () => {
  it("is named Paraself on every platform, with Decision's beside it", () => {
    expect(userDataDirectories("darwin", "/home/demo", {})).toEqual({
      current: "/home/demo/Library/Application Support/Paraself",
      legacy: "/home/demo/Library/Application Support/Decision",
    });
    expect(userDataDirectories("win32", "C:\\Users\\demo", { APPDATA: "D:\\Profiles\\Roaming" })).toEqual({
      current: "D:\\Profiles\\Roaming\\Paraself",
      legacy: "D:\\Profiles\\Roaming\\Decision",
    });
    expect(userDataDirectories("linux", "/home/demo", {})).toEqual({ current: "/home/demo/.config/paraself", legacy: "/home/demo/.config/decision" });
  });

  it("starts a first install in the new folder, made by nothing here", async () => {
    const { environment, current } = await configHome();
    expect(at(environment)).toEqual({ path: current, state: "current", environmentSource: "default" });
    expect(existsSync(current)).toBe(false);
  });

  it("moves Decision's folder whole, once", async () => {
    const { environment, current, legacy } = await configHome();
    await mkdir(join(legacy, "capture-spool"), { recursive: true });
    await writeFile(join(legacy, "settings.json"), "{\"vaultPath\":\"/vault\"}\n");

    expect(at(environment)).toMatchObject({ path: current, state: "migrated" });
    expect(existsSync(legacy)).toBe(false);
    expect(await readFile(join(current, "settings.json"), "utf8")).toBe("{\"vaultPath\":\"/vault\"}\n");
    expect(existsSync(join(current, "capture-spool"))).toBe(true);
    expect(at(environment)).toMatchObject({ path: current, state: "current" });
  });

  it("uses the new folder where both are there, and leaves Decision's as it is", async () => {
    const { environment, current, legacy } = await configHome();
    await mkdir(current, { recursive: true });
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "settings.json"), "old\n");

    expect(at(environment)).toMatchObject({ path: current, state: "current" });
    expect(await readFile(join(legacy, "settings.json"), "utf8")).toBe("old\n");
    expect(existsSync(join(current, "settings.json"))).toBe(false);
  });

  it("moves nothing where the folder is named outright, by either name", async () => {
    const { environment, legacy } = await configHome();
    await mkdir(legacy, { recursive: true });

    expect(at({ ...environment, PARASELF_USER_DATA: "/isolated" })).toEqual({ path: "/isolated", state: "explicit", environmentSource: "current" });
    expect(at({ ...environment, DECISION_USER_DATA: "/isolated" })).toEqual({ path: "/isolated", state: "explicit", environmentSource: "legacy" });
    expect(existsSync(legacy)).toBe(true);
  });

  it("only finds the folder that holds the data when asked not to move it", async () => {
    const { environment, current, legacy } = await configHome();
    await mkdir(legacy, { recursive: true });

    expect(at(environment, { migrate: false })).toMatchObject({ path: legacy, state: "legacy" });
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(current)).toBe(false);
  });

  it("takes the new folder when another process moved the old one first", () => {
    const { current, legacy } = userDataDirectories("linux", "/home/demo", {});
    const there = new Set([legacy]);
    const fileSystem = {
      existsSync: (path: string) => there.has(path),
      renameSync: () => {
        // The App started at the same moment as a hook, and renamed it a moment before.
        there.delete(legacy);
        there.add(current);
        throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${legacy}'`), { code: "ENOENT" });
      },
    };

    expect(resolveUserData({}, { platform: "linux", homeDirectory: "/home/demo", fileSystem })).toMatchObject({ path: current, state: "current" });
  });

  it("keeps to Decision's folder, saying why, when it cannot be moved", () => {
    const { legacy } = userDataDirectories("win32", "C:\\Users\\demo", {});
    const fileSystem = {
      existsSync: (path: string) => path === legacy,
      renameSync: () => {
        // On Windows, while the older App still holds a file in it open.
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${legacy}'`), { code: "EPERM" });
      },
    };

    expect(resolveUserData({}, { platform: "win32", homeDirectory: "C:\\Users\\demo", fileSystem })).toEqual({
      path: legacy,
      state: "legacy",
      environmentSource: "default",
      migrationError: `EPERM: operation not permitted, rename '${legacy}'`,
    });
  });
});
