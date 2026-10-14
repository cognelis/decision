import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const THIS_TEST = "scripts/test/release-portability.test.ts";

const candidateFiles = (): string[] =>
  execFileSync(
    "git",
    ["ls-files", "-co", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(path))
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
  it("documents both supported downloads and the unsigned release contract", () => {
    const readme = readFileSync("README.md", "utf8");
    const release = readFileSync("docs/release.md", "utf8");

    for (const document of [readme, release]) {
      expect(document).toContain("Windows x64");
      expect(document).toContain("Apple Silicon");
      expect(document).toContain("1.1.0");
    }
    expect(release).toMatch(/"?schemaVersion"?: 2/u);
    expect(release).toContain('signature: "unsigned"');
    expect(release).toContain('signature: "ad-hoc"');
    expect(release).toContain("macos-26");
    expect(release).toContain("manual");
    expect(release).not.toMatch(/ad-hoc[^\n。]*不能公开/iu);
  });

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
    expect(matches(productionFiles, /\/(?:Users|home)\//u)).toEqual([]);
    // Homebrew's documented default prefix is no one machine's path, but it stays out of source save in the
    // one list of known install folders, the PATH fallback for a login shell that does not answer.
    const knownInstallFolders = "apps/desktop/src/main/login-shell-path.ts";
    expect(
      matches(productionFiles.filter((path) => path !== knownInstallFolders), /\/opt\/homebrew\//u),
    ).toEqual([]);
  });

  it("keeps the shortcut the README gives a page in step with the sidebar", () => {
    // The sidebar order is what ⌘/Ctrl+1…8 follow, so moving an entry silently
    // renumbers every page after it. The README names one of those numbers,
    // and nothing else notices when it stops being true.
    const shell = readFileSync(
      "apps/desktop/src/renderer/components/DesktopShell.tsx",
      "utf8",
    );
    const order = [
      ...shell.matchAll(/surface: "[a-z-]+", label: "([^"]+)"/gu),
    ].map((entry) => entry[1]!);
    const claims = [
      ...readFileSync("README.md", "utf8").matchAll(
        /「([^」]+)」[^（。]*（⌘\/Ctrl\+(\d)）/gu,
      ),
    ];

    expect(order.length).toBeGreaterThan(0);
    expect(claims.length).toBeGreaterThan(0);
    expect(
      claims.map(([, label, digit]) => `${label}=${digit}`),
    ).toEqual(
      claims.map(([, label]) => `${label}=${order.indexOf(label!) + 1}`),
    );
  });

  it("uses the current product name in all shipped code and documentation", () => {
    const retiredTerms = /island|灵动岛|小岛|浮岛|决策岛|理由岛|弹岛/iu;
    const files = candidateFiles();
    expect(files.filter((path) => retiredTerms.test(path))).toEqual([]);
    expect(matches(textFiles(files), retiredTerms)).toEqual([]);
  });
});
