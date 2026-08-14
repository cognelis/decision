import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const THIS_TEST = "scripts/test/release-portability.test.ts";

const LEGACY_BRAND_ALLOWLIST = new Set([
  "apps/bridge/resources/decision-island-bridge",
  "apps/bridge/src/runtime-client.ts",
  "apps/bridge/test/hooks-cli.test.ts",
  "apps/bridge/test/install-cli.test.ts",
  "apps/bridge/test/runtime-client.test.ts",
  "apps/bridge/vite.config.ts",
  "apps/desktop/src/main/application-paths.ts",
  "apps/desktop/src/main/integration-status.ts",
  "apps/desktop/test/application-paths.test.ts",
  "apps/desktop/test/brand-migration.test.ts",
  "apps/desktop/test/forge-config.test.ts",
  "apps/desktop/test/integration-status.test.ts",
  "config/decision-environment.mjs",
  "docs/superpowers/plans/2026-08-15-cognelis-brand-migration.md",
  "docs/superpowers/specs/2026-08-14-github-open-source-publishing-design.md",
  "docs/superpowers/specs/2026-08-15-cognelis-migration-and-github-publication-design.md",
  "packages/integrations/src/claude.ts",
  "packages/integrations/src/codex.ts",
  "packages/integrations/src/hooks.ts",
  "packages/integrations/test/claude.test.ts",
  "packages/integrations/test/codex.test.ts",
  "packages/integrations/test/install.test.ts",
  "packages/storage/src/legacy-markers.ts",
  "packages/storage/test/markdown.test.ts",
  "packages/storage/test/methodology-relation.test.ts",
  "packages/storage/test/methodology.test.ts",
  "scripts/test/decision-environment.test.ts",
  "scripts/build-foundation-model-helper.sh",
  "scripts/build-liquid-glass-addon.sh",
]);

const candidateFiles = (): string[] =>
  execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path.length > 0)
    .sort();

const textFiles = (files: readonly string[]): string[] =>
  files.filter((path) => {
    if (path === THIS_TEST || !existsSync(path)) {
      return false;
    }
    return !readFileSync(path).includes(0);
  });

const matches = (
  files: readonly string[],
  pattern: RegExp,
): string[] =>
  files.filter((path) => pattern.test(readFileSync(path, "utf8")));

describe("release candidate portability", () => {
  it("keeps common local credential files out of version control", () => {
    const ignored = new Set(
      readFileSync(".gitignore", "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );
    const requiredPatterns = [
      ".env",
      ".env.*",
      ".netrc",
      ".npmrc",
      ".pypirc",
      "*.key",
      "*.keychain",
      "*.keychain-db",
      "*.p8",
      "*.p12",
      "*.pem",
      "*.pfx",
      "credentials.json",
      "credentials.yaml",
      "credentials.yml",
      "id_ed25519",
      "id_rsa",
      "secret.txt",
      "secrets.json",
      "secrets.yaml",
      "secrets.yml",
    ];

    expect(requiredPatterns.filter((pattern) => !ignored.has(pattern))).toEqual(
      [],
    );
  });

  it("does not include credential-bearing files or recognizable secrets", () => {
    const files = candidateFiles();
    const prohibitedFiles = files.filter((path) =>
      /(?:^|\/)(?:\.env(?:\..*)?|\.(?:netrc|npmrc|pypirc)|id_(?:ed25519|rsa)|credentials?\.(?:json|ya?ml)|secrets?\.(?:json|txt|ya?ml)|[^/]+\.(?:key|keychain|keychain-db|p8|p12|pem|pfx))$/iu.test(path),
    );
    expect(prohibitedFiles).toEqual([]);

    const candidates = textFiles(files);
    const secretPatterns = [
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
      /AKIA[0-9A-Z]{16}/u,
      /gh(?:p|o|u|s|r)_[A-Za-z0-9]{30,}/u,
      /github_pat_[A-Za-z0-9_]{40,}/u,
      /xox(?:b|a|p|r|s)-[A-Za-z0-9-]{10,}/u,
      /sk_live_[A-Za-z0-9]{16,}/u,
      /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/u,
      /sk-ant-[A-Za-z0-9_-]{20,}/u,
      /npm_[A-Za-z0-9]{36,}/u,
      /glpat-[A-Za-z0-9_-]{20,}/u,
      /(?:gitee|access)[_-]?token\s*[:=]\s*["']?[a-f0-9]{32}["']?/iu,
      /AIza[0-9A-Za-z_-]{30,}/u,
      /https?:\/\/[^/:\s]+:[^/@\s]+@/u,
    ];
    const findings = secretPatterns.flatMap((pattern) =>
      matches(candidates, pattern),
    );
    expect([...new Set(findings)].sort()).toEqual([]);
  });

  it("does not retain the maintainer's private paths", () => {
    const maintainer = ["cas", "pian"].join("");
    const privatePath = new RegExp(`/Users/${maintainer}`, "iu");
    expect(matches(textFiles(candidateFiles()), privatePath)).toEqual([]);
  });

  it("keeps user-machine paths out of production source", () => {
    const productionFiles = textFiles(candidateFiles()).filter(
      (path) =>
        ((path.startsWith("apps/") || path.startsWith("packages/")) &&
          !path.includes("/test/")) ||
        (path.startsWith("scripts/") && !path.startsWith("scripts/test/")),
    );
    expect(
      matches(productionFiles, /\/(?:Users|home)\/|\/opt\/homebrew\//u),
    ).toEqual([]);
  });

  it("keeps the legacy brand inside explicit 1.x compatibility files", () => {
    const legacyBrand =
      /Decision Island|decision-island|DECISION_ISLAND|DecisionIsland|decisionIsland/u;
    const findings = matches(textFiles(candidateFiles()), legacyBrand);

    expect(
      findings.filter((path) => !LEGACY_BRAND_ALLOWLIST.has(path)),
    ).toEqual([]);
    expect(
      [...LEGACY_BRAND_ALLOWLIST].filter(
        (path) => !existsSync(path) || !legacyBrand.test(readFileSync(path, "utf8")),
      ),
    ).toEqual([]);
  });
});
