import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { resolveBridgeExecutablePath } from "../src/main/bridge-path.js";

describe("bridge executable path", () => {
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

describe("Windows bridge wrappers", () => {
  it.each([
    ["decision-bridge.cmd", "decision-bridge.cmd"],
    ["decision-island-bridge.cmd", "decision-island-bridge.cmd"],
  ])("%s invokes the shared bridge implementation", async (name, marker) => {
    const source = await readFile(
      new URL(`../../bridge/resources/${name}`, import.meta.url),
      "utf8",
    );

    expect(source).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(source).toContain(`DECISION_BRIDGE_PATH=%bridge_directory%${marker}`);
    expect(source).toContain("..\\..\\Decision.exe");
    expect(source).toContain("decision-bridge.mjs");
    expect(source).toContain("%*");
  });
});
