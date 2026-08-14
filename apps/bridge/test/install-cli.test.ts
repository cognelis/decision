import type { InstallReport } from "@cognelis/decision-integrations";
import { describe, expect, it, vi } from "vitest";

import { main, type CliDependencies } from "../src/cli.js";

const report: InstallReport = {
  mode: "dry-run",
  targets: [
    {
      client: "claude-code",
      path: "/Users/demo/.claude/settings.json",
      changed: true,
    },
    {
      client: "codex",
      path: "/Users/demo/.codex/hooks.json",
      changed: true,
    },
  ],
  commands: [],
  restartRequired: true,
};

describe("decision-bridge install command", () => {
  it("starts the read-only MCP server for a supported client", async () => {
    const serveMcp = vi.fn();

    const exitCode = await main(["mcp", "codex"], { serveMcp });

    expect(exitCode).toBe(0);
    expect(serveMcp).toHaveBeenCalledWith({ sourceClient: "codex" });
  });

  it("rejects an unsupported MCP client", async () => {
    const serveMcp = vi.fn();
    const errors: string[] = [];

    const exitCode = await main(["mcp", "other"], {
      serveMcp,
      printError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(2);
    expect(serveMcp).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("claude-code|codex");
  });

  it("runs a dry-run with user-level config paths", async () => {
    const installer = vi.fn(async () => report);
    const output: unknown[] = [];
    const dependencies: CliDependencies = {
      installer,
      bridgePath: "/Applications/Decision.app/bridge",
      userHome: "/Users/demo",
      printJson: (value) => output.push(value),
    };

    const exitCode = await main(["install", "--dry-run"], dependencies);

    expect(exitCode).toBe(0);
    expect(installer).toHaveBeenCalledWith({
      mode: "dry-run",
      bridgePath: "/Applications/Decision.app/bridge",
      claudeSettingsPath: "/Users/demo/.claude/settings.json",
      codexHooksPath: "/Users/demo/.codex/hooks.json",
    });
    expect(output).toEqual([report]);
  });

  it("prefers the current bridge environment path and supports the legacy name", async () => {
    for (const environment of [
      {
        DECISION_BRIDGE_PATH: "/current/decision-bridge",
        DECISION_ISLAND_BRIDGE_PATH: "/legacy/decision-island-bridge",
      },
      {
        DECISION_ISLAND_BRIDGE_PATH: "/legacy/decision-island-bridge",
      },
    ]) {
      const installer = vi.fn(async () => report);
      await main(["install", "--dry-run"], {
        installer,
        environment,
        userHome: "/Users/demo",
        printJson: () => undefined,
      });

      expect(installer).toHaveBeenCalledWith(
        expect.objectContaining({
          bridgePath:
            environment.DECISION_BRIDGE_PATH ??
            environment.DECISION_ISLAND_BRIDGE_PATH,
        }),
      );
    }
  });

  it("rejects an unknown install mode without writing", async () => {
    const installer = vi.fn();
    const errors: string[] = [];

    const exitCode = await main(["install", "--unknown"], {
      installer,
      printError: (value) => errors.push(value),
    });

    expect(exitCode).toBe(2);
    expect(installer).not.toHaveBeenCalled();
    expect(errors.join("")).toContain("--dry-run");
  });
});
