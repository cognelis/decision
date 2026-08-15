import { describe, expect, it } from "vitest";

// @ts-expect-error The production helper is an executable ESM module.
import {
  bridgeProcessInvocation,
  createMcpRequestManager,
  MCP_REQUEST_TIMEOUT_MS,
  resolvePackagedSmokeTarget,
} from "../smoke-support.mjs";

describe("packaged bridge invocation", () => {
  it("allows a bounded Windows cold start and reports early bridge exit", async () => {
    expect(MCP_REQUEST_TIMEOUT_MS).toBe(20_000);
    const writes: string[] = [];
    const client = createMcpRequestManager({
      write: (line: string) => writes.push(line),
      timeoutMs: MCP_REQUEST_TIMEOUT_MS,
    });
    const response = client.request(1, "initialize", {
      protocolVersion: "2025-11-25",
    });

    expect(JSON.parse(writes[0] ?? "null")).toMatchObject({
      id: 1,
      method: "initialize",
    });
    expect(client.accept({ id: 1, result: { ready: true } })).toBe(true);
    await expect(response).resolves.toMatchObject({
      result: { ready: true },
    });

    const closed = client.request(2, "tools/list");
    client.rejectAll(new Error("packaged MCP exited with code 1"));
    await expect(closed).rejects.toThrow(/exited with code 1/iu);
  });

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
