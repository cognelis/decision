import { win32 } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error The production helper is an executable ESM module.
import {
  bridgeProcessInvocation,
  createMcpRequestManager,
  MCP_REQUEST_TIMEOUT_MS,
  isObsidianSearchShutdownMarker,
  obsidianSearchDatabaseFiles,
  obsidianVaultIdentity,
  obsidianSearchIndexPath,
  resolveObsidianSearchDatabasePath,
  resolvePackagedSmokeTarget,
  waitForShutdownMarkerBeforeExit,
} from "../smoke-support.mjs";

describe("packaged bridge invocation", () => {
  it("derives the same private per-vault smoke index paths", () => {
    const identity = obsidianVaultIdentity("C:\\Users\\Ada\\VAULT", "win32");
    expect(identity).toBe(
      obsidianVaultIdentity("C:/Users/Ada/VAULT", "win32"),
    );
    expect(identity).not.toBe(
      obsidianVaultIdentity("C:/Users/Ada/Vault", "win32"),
    );
    const composedIdentity = obsidianVaultIdentity(
      "/Users/Ada/Caf\u00e9",
      "darwin",
    );
    const decomposedIdentity = obsidianVaultIdentity(
      "/Users/Ada/Cafe\u0301",
      "darwin",
    );
    expect(composedIdentity).not.toBe(decomposedIdentity);
    expect(
      obsidianSearchIndexPath("/user-data/obsidian-search", composedIdentity),
    ).not.toBe(
      obsidianSearchIndexPath(
        "/user-data/obsidian-search",
        decomposedIdentity,
      ),
    );
    expect(obsidianVaultIdentity("/vault/a\\b", "linux")).not.toBe(
      obsidianVaultIdentity("/vault/a/b", "linux"),
    );
    expect(identity).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      obsidianSearchIndexPath("C:\\UserData\\obsidian-search", identity, "win32"),
    ).toBe(
      win32.join(
        "C:\\UserData\\obsidian-search",
        "vaults",
        identity,
        "index.sqlite",
      ),
    );
  });

  it("canonicalizes the Vault before resolving its smoke database", async () => {
    const indexRoot = "/user-data/obsidian-search";
    const canonicalVault = "/private/var/vault";
    const realpath = async () => canonicalVault;

    await expect(
      resolveObsidianSearchDatabasePath({
        indexRoot,
        vaultPath: "/var/vault-link",
        platform: "darwin",
        realpath,
      }),
    ).resolves.toBe(
      obsidianSearchIndexPath(
        indexRoot,
        obsidianVaultIdentity(canonicalVault, "darwin"),
        "darwin",
      ),
    );
  });

  it("validates only the content-free Obsidian shutdown marker contract", () => {
    expect(
      isObsidianSearchShutdownMarker(
        { closed: true, pid: 4_242, version: 1 },
        4_242,
      ),
    ).toBe(true);
    expect(
      isObsidianSearchShutdownMarker(
        { closed: true, pid: 4_241, version: 1 },
        4_242,
      ),
    ).toBe(false);
    expect(
      isObsidianSearchShutdownMarker(
        { closed: true, pid: 4_242, version: 1, path: "/private/vault" },
        4_242,
      ),
    ).toBe(false);
  });

  it("rejects a stale marker when the process exits before a fresh one", async () => {
    const applicationProcess = { exitCode: null as number | null };
    let polls = 0;

    await expect(
      waitForShutdownMarkerBeforeExit({
        applicationProcess,
        readMarker: async () => ({ closed: true, pid: 100, version: 1 }),
        validateMarker: (marker) =>
          isObsidianSearchShutdownMarker(marker, 200),
        poll: async () => {
          polls += 1;
          applicationProcess.exitCode = 0;
        },
      }),
    ).rejects.toThrow("before a valid Obsidian shutdown marker");
    expect(polls).toBe(1);
  });

  it("accepts a fresh marker only while the process is still running", async () => {
    const applicationProcess = { exitCode: null as number | null };

    await expect(
      waitForShutdownMarkerBeforeExit({
        applicationProcess,
        readMarker: async () => ({ closed: true, pid: 200, version: 1 }),
        validateMarker: (marker) =>
          isObsidianSearchShutdownMarker(marker, 200),
        poll: async () => undefined,
      }),
    ).resolves.toBe(true);
    expect(applicationProcess.exitCode).toBeNull();
  });

  it("accepts when the process exits while a fresh marker is being read", async () => {
    const applicationProcess = { exitCode: null as number | null };

    await expect(
      waitForShutdownMarkerBeforeExit({
        applicationProcess,
        readMarker: async () => {
          applicationProcess.exitCode = 0;
          return { closed: true, pid: 200, version: 1 };
        },
        validateMarker: (marker) =>
          isObsidianSearchShutdownMarker(marker, 200),
        poll: async () => undefined,
      }),
    ).resolves.toBe(true);
  });

  it("accepts a fresh marker that appears during the final poll before exit", async () => {
    const applicationProcess = { exitCode: null as number | null };
    let marker: unknown = undefined;

    await expect(
      waitForShutdownMarkerBeforeExit({
        applicationProcess,
        readMarker: async () => marker,
        validateMarker: (value) =>
          isObsidianSearchShutdownMarker(value, 200),
        poll: async () => {
          marker = { closed: true, pid: 200, version: 1 };
          applicationProcess.exitCode = 0;
        },
      }),
    ).resolves.toBe(true);
  });

  it("rejects exit when the final marker is missing", async () => {
    const applicationProcess = { exitCode: 0 as number | null };

    await expect(
      waitForShutdownMarkerBeforeExit({
        applicationProcess,
        readMarker: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
        validateMarker: (value) =>
          isObsidianSearchShutdownMarker(value, 200),
        poll: async () => undefined,
      }),
    ).rejects.toThrow("before a valid Obsidian shutdown marker");
  });

  it("limits Obsidian search cleanup to its dedicated database and sidecars", () => {
    expect(
      obsidianSearchDatabaseFiles("/user-data/obsidian-search/index.sqlite"),
    ).toEqual([
      "/user-data/obsidian-search/index.sqlite",
      "/user-data/obsidian-search/index.sqlite-wal",
      "/user-data/obsidian-search/index.sqlite-shm",
    ]);
  });

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
      windowsVerbatimArguments: true,
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '""C:\\Program Files\\Decision\\resources\\bridge\\decision-bridge.cmd" "hook" "stop" "codex""',
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
      windowsVerbatimArguments: false,
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
    });
  });
});
