import { describe, expect, it } from "vitest";

// @ts-expect-error The production helper is an executable ESM module.
import {
  bridgeProcessInvocation,
  resolvePackagedSmokeTarget,
} from "../smoke-support.mjs";

describe("packaged bridge invocation", () => {
  it("uses cmd for a Windows wrapper path with spaces", () => {
    expect(
      bridgeProcessInvocation({
        platform: "win32",
        bridge:
          "C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd",
        args: ["hook", "stop", "codex"],
        commandInterpreter: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '"C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd" "hook" "stop" "codex"',
      ],
    });
  });

  it("executes the extensionless macOS wrapper directly", () => {
    expect(
      bridgeProcessInvocation({
        platform: "darwin",
        bridge: "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge",
        args: ["mcp", "codex"],
      }),
    ).toEqual({
      command:
        "/Applications/Decision.app/Contents/Resources/bridge/decision-bridge",
      args: ["mcp", "codex"],
    });
  });

  it("redirects Windows smoke checks to the installed Squirrel directory", () => {
    expect(
      resolvePackagedSmokeTarget({
        target: {
          packageRoot: "C:\\source\\out\\Decision-win32-x64",
          packagedExecutable:
            "C:\\source\\out\\Decision-win32-x64\\Decision.exe",
          bridgePath:
            "C:\\source\\out\\Decision-win32-x64\\resources\\bridge\\decision-bridge.cmd",
          legacyBridgePath:
            "C:\\source\\out\\Decision-win32-x64\\resources\\bridge\\decision-island-bridge.cmd",
        },
        platform: "win32",
        productName: "Decision",
        packageRoot: "C:\\Users\\runner\\AppData\\Local\\Decision\\app-1.1.0",
      }),
    ).toMatchObject({
      packageRoot:
        "C:\\Users\\runner\\AppData\\Local\\Decision\\app-1.1.0",
      packagedExecutable:
        "C:\\Users\\runner\\AppData\\Local\\Decision\\app-1.1.0\\Decision.exe",
      bridgePath:
        "C:\\Users\\runner\\AppData\\Local\\Decision\\app-1.1.0\\resources\\bridge\\decision-bridge.cmd",
      legacyBridgePath:
        "C:\\Users\\runner\\AppData\\Local\\Decision\\app-1.1.0\\resources\\bridge\\decision-island-bridge.cmd",
    });
  });
});
