import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { mkdtempSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveDecisionUserData } from "../src/main/application-paths.js";

const writeFixture = (
  root: string,
  path: string,
  content: string | Uint8Array,
): void => {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
};

const hashes = (root: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.name !== ".cognelis-migration-v1.json") {
        result[relative(root, path)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  visit(root);
  return result;
};

describe("Cognelis brand migration", () => {
  it("preserves historical knowledge and every pending local state", () => {
    const home = mkdtempSync(join(tmpdir(), "decision-brand-migration-"));
    const applicationSupport = join(
      home,
      "Library",
      "Application Support",
    );
    const legacyData = join(applicationSupport, "Decision Island");
    const currentData = join(applicationSupport, "Decision");
    const legacyVault = join(home, "Documents", "Decision Island Vault");
    mkdirSync(legacyData, { recursive: true });
    mkdirSync(legacyVault, { recursive: true });

    const historicalFiles: Record<string, string | Uint8Array> = {
      "settings.json": JSON.stringify({ vaultPath: legacyVault, theme: "dark" }),
      "index.sqlite": new Uint8Array([0x53, 0x51, 0x4c, 0x01]),
      "semantic-vectors.sqlite": new Uint8Array([0x53, 0x45, 0x4d, 0x01]),
      "practice-asset-history/history.json": '{"asset":"PRA-001"}\n',
      "methodology-history/history.json": '{"methodology":"MET-001"}\n',
      "model-provider-profiles.json": '{"profile":"local"}\n',
      "model-provider-credentials/provider.bin": new Uint8Array([
        0x43, 0x52, 0x45, 0x44,
      ]),
      "models/model.gguf": new Uint8Array([0x47, 0x47, 0x55, 0x46]),
    };
    const pendingFiles: Record<string, string> = {
      "capture-spool/pending-rationale.json": '{"id":"CAP-001"}\n',
      "capture-spool/corrupt-but-preserved.json": "{not-json",
      "candidate-spool/pending-candidate.json": '{"id":"CAN-001"}\n',
      "semantic-pair-spool/pending-pair.json": '{"id":"SEM-001"}\n',
      "text-pending/pending-text.json": '{"id":"TXT-001"}\n',
      "manual-form-drafts.json": '{"draft":"FORM-001"}\n',
      "methodology-suggestion-preferences.json": '{"deferred":"SUG-001"}\n',
      "practice-publications/status.json": '{"pending":"PUB-001"}\n',
    };
    for (const [path, content] of Object.entries({
      ...historicalFiles,
      ...pendingFiles,
    })) {
      writeFixture(legacyData, path, content);
    }

    const vaultFiles: Record<string, string> = {
      "Decisions/DEC-001.md": "# Historical decision\n",
      "Methodologies/MET-001.md": "# Accepted methodology\n",
      "Practice Assets/PRA-001.md": "# Published practice asset\n",
    };
    for (const [path, content] of Object.entries(vaultFiles)) {
      writeFixture(legacyVault, path, content);
    }

    const dataBefore = hashes(legacyData);
    const vaultBefore = hashes(legacyVault);
    const resolution = resolveDecisionUserData(
      {},
      {
        homeDirectory: home,
        platform: "darwin",
        now: () => "2026-08-15T00:00:00.000Z",
      },
    );

    expect(resolution).toEqual({
      environmentSource: "default",
      path: currentData,
      state: "migrated",
    });
    expect(hashes(currentData)).toEqual(dataBefore);
    expect(hashes(legacyVault)).toEqual(vaultBefore);
    expect(existsSync(legacyData)).toBe(false);
    expect(existsSync(currentData)).toBe(true);

    const settings = JSON.parse(
      readFileSync(join(currentData, "settings.json"), "utf8"),
    ) as { vaultPath: string };
    expect(settings.vaultPath).toBe(legacyVault);
    for (const path of Object.keys(historicalFiles)) {
      expect(hashes(currentData)[path]).toBe(dataBefore[path]);
    }
    for (const path of Object.keys(pendingFiles)) {
      expect(hashes(currentData)[path]).toBe(dataBefore[path]);
    }
  });

  it.runIf(process.platform === "win32")(
    "preserves Windows historical and pending state byte-for-byte",
    () => {
      const home = mkdtempSync(join(tmpdir(), "decision-windows-migration-"));
      const applicationData = join(home, "AppData", "Roaming");
      const legacyData = join(applicationData, "Decision Island");
      const currentData = join(applicationData, "Decision");
      const legacyVault = join(home, "Documents", "Decision Island Vault");
      mkdirSync(legacyData, { recursive: true });
      mkdirSync(legacyVault, { recursive: true });

      const files: Record<string, string | Uint8Array> = {
        "settings.json": JSON.stringify({ vaultPath: legacyVault }),
        "index.sqlite": new Uint8Array([0x53, 0x51, 0x4c, 0x02]),
        "semantic-vectors.sqlite": new Uint8Array([0x53, 0x45, 0x4d, 0x02]),
        "practice-asset-history/history.json": '{"asset":"PRA-WIN"}\n',
        "methodology-history/history.json": '{"methodology":"MET-WIN"}\n',
        "model-provider-profiles.json": '{"profile":"windows"}\n',
        "model-provider-credentials/provider.bin": new Uint8Array([
          0x43, 0x52, 0x45, 0x44, 0x02,
        ]),
        "models/model.gguf": new Uint8Array([0x47, 0x47, 0x55, 0x46, 0x02]),
        "capture-spool/pending-rationale.json": '{"id":"CAP-WIN"}\n',
        "capture-spool/corrupt-but-preserved.json": "{not-json",
        "candidate-spool/pending-candidate.json": '{"id":"CAN-WIN"}\n',
        "semantic-pair-spool/pending-pair.json": '{"id":"SEM-WIN"}\n',
        "text-pending/pending-text.json": '{"id":"TXT-WIN"}\n',
        "manual-form-drafts.json": '{"draft":"FORM-WIN"}\n',
        "methodology-suggestion-preferences.json":
          '{"deferred":"SUG-WIN"}\n',
        "practice-publications/status.json": '{"pending":"PUB-WIN"}\n',
      };
      for (const [path, content] of Object.entries(files)) {
        writeFixture(legacyData, path, content);
      }
      writeFixture(
        legacyVault,
        "Decisions/DEC-WIN.md",
        "# Historical Windows decision\n",
      );

      const dataBefore = hashes(legacyData);
      const vaultBefore = hashes(legacyVault);
      const resolution = resolveDecisionUserData(
        { APPDATA: applicationData },
        {
          homeDirectory: home,
          platform: "win32",
          now: () => "2026-08-16T00:00:00.000Z",
        },
      );

      expect(resolution).toEqual({
        environmentSource: "default",
        path: currentData,
        state: "migrated",
      });
      expect(hashes(currentData)).toEqual(dataBefore);
      expect(hashes(legacyVault)).toEqual(vaultBefore);
      expect(existsSync(legacyData)).toBe(false);
      expect(existsSync(currentData)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(currentData, "settings.json"), "utf8")),
      ).toMatchObject({ vaultPath: legacyVault });
    },
  );
});
