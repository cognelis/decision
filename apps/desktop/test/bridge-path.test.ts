import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { isTranslocated, prepareBridgeLauncher, resolveBridgeExecutablePath, squirrelBridgeLauncher } from "../src/main/bridge-path.js";

describe("bridge executable path", () => {
  it("knows a bridge macOS put somewhere for this launch only, not to give to the clients", () => {
    const resourcesPath = "/private/var/folders/xy/T/AppTranslocation/0A1B2C3D/d/Decision.app/Contents/Resources";
    expect(isTranslocated(resolveBridgeExecutablePath({ packaged: true, platform: "darwin", resourcesPath, appPath: "/unused" }))).toBe(true);
    expect(isTranslocated("/Applications/Decision.app/Contents/Resources/bridge/decision-bridge")).toBe(false);
  });

  it("selects a cmd wrapper in a packaged Windows application", () => {
    expect(
      resolveBridgeExecutablePath({
        packaged: true,
        platform: "win32",
        resourcesPath:
          "C:\\Users\\Ada\\AppData\\Local\\Decision\\resources",
        appPath: "C:\\source\\decision",
      }),
    ).toBe(
      "C:\\Users\\Ada\\AppData\\Local\\Decision\\resources\\bridge\\decision-bridge.cmd",
    );
  });

  it("keeps the extensionless packaged macOS wrapper", () => {
    expect(
      resolveBridgeExecutablePath({
        packaged: true,
        platform: "darwin",
        resourcesPath: "/Applications/Decision.app/Contents/Resources",
        appPath: "/source/decision",
      }),
    ).toBe(
      "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge",
    );
  });

  it("uses the TypeScript entry when running from source", () => {
    expect(
      resolveBridgeExecutablePath({
        packaged: false,
        platform: "win32",
        resourcesPath: "C:\\unused",
        appPath: "C:\\source\\decision",
      }),
    ).toBe("C:\\source\\decision\\apps\\bridge\\src\\cli.ts");
  });
});

describe("Windows install launcher", () => {
  const install = "C:\\Users\\Ada\\AppData\\Local\\Decision";
  const running = (version: string) => ({
    platform: "win32" as const,
    execPath: `${install}\\app-${version}\\Decision.exe`,
    resourcesPath: `${install}\\app-${version}\\resources`,
    exists: (path: string) => path === `${install}\\Update.exe`,
  });

  it("keeps a launcher at the install root that hands on to the version now running", () => {
    // Squirrel removes the old app-<version> folder after an update: a hook naming its bridge failed every turn.
    expect(squirrelBridgeLauncher(running("1.2.0"))).toEqual({
      path: `${install}\\decision-bridge.cmd`,
      content: '@echo off\r\n"%~dp0app-1.2.0\\resources\\bridge\\decision-bridge.cmd" %*\r\n',
    });
    // A portable copy (no Update.exe beside it), a run from another folder, or not Windows: none.
    expect(squirrelBridgeLauncher({ ...running("1.2.0"), exists: () => false })).toBeNull();
    expect(squirrelBridgeLauncher({ ...running("1.2.0"), execPath: "C:\\Tools\\Decision\\Decision.exe", resourcesPath: "C:\\Tools\\Decision\\resources" })).toBeNull();
    expect(squirrelBridgeLauncher({ ...running("1.2.0"), platform: "darwin" })).toBeNull();
  });

  it("is rewritten only when the running version changed it, and left to the version's own bridge when it cannot be", async () => {
    const files = new Map<string, string>();
    const written: string[] = [];
    const io = {
      read: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return content;
      },
      write: async (path: string, content: string) => {
        written.push(content);
        files.set(path, content);
      },
    };
    const before = squirrelBridgeLauncher(running("1.1.0"))!;
    const after = squirrelBridgeLauncher(running("1.2.0"))!;
    expect(await prepareBridgeLauncher(before, io)).toBe(before.path);
    expect(await prepareBridgeLauncher(before, io)).toBe(before.path);
    // Updated, the next start points it at the new folder, before Squirrel removes the old one.
    expect(await prepareBridgeLauncher(after, io)).toBe(after.path);
    expect(written).toEqual([before.content, after.content]);
    // A root it may not write: hooks go on naming the version's own bridge, as before.
    const locked = { read: io.read, write: async () => { throw new Error("EACCES"); } };
    expect(await prepareBridgeLauncher(squirrelBridgeLauncher(running("1.3.0")), locked)).toBeNull();
    expect(await prepareBridgeLauncher(null, io)).toBeNull();
  });

  it("is in place before any hook is looked at", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const prepared = source.indexOf("bridgeLauncher = await prepareBridgeLauncher(");
    expect(prepared).toBeGreaterThan(-1);
    expect(prepared).toBeLessThan(source.indexOf("detectIntegrationStatus(integrationPaths()"));
  });
});

describe("Windows bridge wrappers", () => {
  it.each([
    ["decision-bridge.cmd", "decision-bridge.cmd"],
  ])("%s invokes the shared bridge implementation", async (name, marker) => {
    const source = await readFile(
      new URL(`../../bridge/resources/${name}`, import.meta.url),
      "utf8",
    );

    expect(source).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(source).toContain(`DECISION_BRIDGE_PATH=%bridge_directory%${marker}`);
    // Installed by Squirrel, `install` writes the install root's launcher, found beside Update.exe, never a path
    // taken from the environment (which anyone could set to choose what every hook runs).
    expect(source).toContain('for %%I in ("%bridge_directory%..\\..\\..") do if exist "%%~fI\\Update.exe" if exist "%%~fI\\decision-bridge.cmd" set "DECISION_BRIDGE_PATH=%%~fI\\decision-bridge.cmd"');
    expect(source).not.toContain("if not defined DECISION_BRIDGE_PATH");
    expect(source).toContain("..\\..\\Decision.exe");
    expect(source).toContain("decision-bridge.mjs");
    expect(source).toContain("%*");
  });
});
