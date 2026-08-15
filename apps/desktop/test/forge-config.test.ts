import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import forgeConfig, {
  createMacDistributionConfig,
} from "../../../forge.config";
import packageJson from "../../../package.json";

describe("macOS packaging", () => {
  it("ad-hoc signs the final app without mutating it after signing", () => {
    const signing = forgeConfig.packagerConfig?.osxSign;

    expect(signing).toMatchObject({
      identity: "-",
      identityValidation: false,
    });
    expect(
      typeof signing === "object"
        ? signing.optionsForFile?.("Decision")
        : undefined,
    ).toMatchObject({
      hardenedRuntime: false,
      timestamp: "none",
    });
    expect(forgeConfig.hooks?.postPackage).toBeUndefined();
  });

  it("fails closed when distribution signing inputs are missing or unsafe", () => {
    expect(() =>
      createMacDistributionConfig({ DECISION_RELEASE: "1" }),
    ).toThrow(/DECISION_SIGNING_IDENTITY/u);
    expect(() =>
      createMacDistributionConfig({
        DECISION_RELEASE: "1",
        DECISION_SIGNING_IDENTITY: "-",
        DECISION_NOTARY_KEYCHAIN_PROFILE: "decision-release",
      }),
    ).toThrow(/Developer ID/u);
    expect(() =>
      createMacDistributionConfig({
        DECISION_RELEASE: "1",
        DECISION_SIGNING_IDENTITY: "Developer ID Application: Decision",
        DECISION_APPLE_API_KEY: "/private/key.p8",
        DECISION_APPLE_API_KEY_ID: "KEY1234567",
      }),
    ).toThrow(/DECISION_APPLE_API_ISSUER/u);
    expect(() =>
      createMacDistributionConfig({
        DECISION_RELEASE: "1",
        DECISION_SIGNING_IDENTITY: "Developer ID Application: Decision",
        DECISION_NOTARY_KEYCHAIN: "/private/release.keychain-db",
        DECISION_APPLE_API_KEY: "/private/key.p8",
        DECISION_APPLE_API_KEY_ID: "KEY1234567",
        DECISION_APPLE_API_ISSUER:
          "00000000-0000-0000-0000-000000000000",
      }),
    ).toThrow(/keychain profile/u);
  });

  it("configures hardened signing and keychain notarization for distribution", () => {
    const distribution = createMacDistributionConfig({
      DECISION_RELEASE: "1",
      DECISION_SIGNING_IDENTITY:
        "Developer ID Application: Decision Team (ABCDE12345)",
      DECISION_NOTARY_KEYCHAIN_PROFILE: "decision-release",
      DECISION_NOTARY_KEYCHAIN: "/private/release.keychain-db",
    });
    const signing = distribution.osxSign;

    expect(signing).toMatchObject({
      identity: "Developer ID Application: Decision Team (ABCDE12345)",
      identityValidation: true,
    });
    expect(
      typeof signing === "object"
        ? signing.optionsForFile?.("Decision")
        : undefined,
    ).toMatchObject({ hardenedRuntime: true });
    expect(distribution.osxNotarize).toEqual({
      keychainProfile: "decision-release",
      keychain: "/private/release.keychain-db",
    });
  });

  it("supports one complete App Store Connect API key for notarization", () => {
    const distribution = createMacDistributionConfig({
      DECISION_RELEASE: "1",
      DECISION_SIGNING_IDENTITY:
        "Developer ID Application: Decision Team (ABCDE12345)",
      DECISION_APPLE_API_KEY: "/private/AuthKey_KEY1234567.p8",
      DECISION_APPLE_API_KEY_ID: "KEY1234567",
      DECISION_APPLE_API_ISSUER:
        "00000000-0000-0000-0000-000000000000",
    });

    expect(distribution.osxNotarize).toEqual({
      appleApiKey: "/private/AuthKey_KEY1234567.p8",
      appleApiKeyId: "KEY1234567",
      appleApiIssuer: "00000000-0000-0000-0000-000000000000",
    });
  });

  it("supports legacy release variables while preferring current values", () => {
    const distribution = createMacDistributionConfig({
      DECISION_RELEASE: "1",
      DECISION_SIGNING_IDENTITY:
        "Developer ID Application: Current Team (ABCDE12345)",
      DECISION_ISLAND_SIGNING_IDENTITY:
        "Developer ID Application: Legacy Team (FGHIJ67890)",
      DECISION_ISLAND_NOTARY_KEYCHAIN_PROFILE: "legacy-profile",
    });

    expect(distribution.osxSign).toMatchObject({
      identity: "Developer ID Application: Current Team (ABCDE12345)",
    });
    expect(distribution.osxNotarize).toEqual({
      keychainProfile: "legacy-profile",
    });
  });

  it("rejects mixed notarization strategies", () => {
    expect(() =>
      createMacDistributionConfig({
        DECISION_RELEASE: "1",
        DECISION_SIGNING_IDENTITY:
          "Developer ID Application: Decision Team (ABCDE12345)",
        DECISION_NOTARY_KEYCHAIN_PROFILE: "decision-release",
        DECISION_APPLE_API_KEY: "/private/key.p8",
        DECISION_APPLE_API_KEY_ID: "KEY1234567",
        DECISION_APPLE_API_ISSUER:
          "00000000-0000-0000-0000-000000000000",
      }),
    ).toThrow(/exactly one notarization strategy/u);
  });

  it("uses the concise product and executable name", () => {
    expect(packageJson).toMatchObject({
      author: "Cognelis contributors",
      description: expect.stringContaining("decision"),
    });
    expect(packageJson.productName).toBe("Decision");
    expect(forgeConfig.packagerConfig).toMatchObject({
      name: "Decision",
      executableName: "Decision",
      appBundleId: "com.cognelis.decision",
      icon: "apps/desktop/assets/app-icon",
    });
  });

  it("builds a deterministic Windows x64 Squirrel installer", () => {
    expect(packageJson.dependencies).toHaveProperty(
      "electron-squirrel-startup",
    );
    expect(packageJson.devDependencies).toHaveProperty(
      "@electron-forge/maker-squirrel",
      "7.11.2",
    );
    expect(
      (forgeConfig.makers ?? []).map((maker) =>
        typeof maker === "object" && maker !== null && "name" in maker
          ? maker.name
          : undefined,
      ),
    ).toEqual([
      "zip",
      "squirrel",
    ]);
    expect(JSON.stringify(forgeConfig.makers)).toContain(
      `Decision-${packageJson.version}-win-x64-Setup.exe`,
    );
    expect(JSON.stringify(forgeConfig.makers)).toContain(
      "apps/desktop/assets/app-icon.ico",
    );
  });

  it("exits before configuring user data for Squirrel lifecycle events", () => {
    const source = readFileSync(
      new URL("../src/main/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain('from "electron-squirrel-startup"');
    expect(source).toMatch(
      /if \(squirrelStartup\) \{\s*app\.quit\(\);\s*\} else \{[\s\S]*configureElectronUserDataPath\(app\)/u,
    );
  });

  it("packages semantic helper metadata but never model weights", () => {
    const resources =
      forgeConfig.packagerConfig?.extraResource ?? [];

    expect(resources).toContain("dist/semantic");
    expect(resources).toContain("dist/native");
    expect(resources).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.gguf$/u),
      ]),
    );
  });

  it("keeps only active local inference native artifacts outside ASAR", () => {
    const asar = forgeConfig.packagerConfig?.asar;
    const ignore = forgeConfig.packagerConfig?.ignore;

    expect(asar).toEqual(
      expect.objectContaining({
        unpack: expect.stringMatching(
          /node.*dylib.*so|node.*so.*dylib/u,
        ),
      }),
    );
    expect(packageJson.dependencies).toMatchObject({
      "node-llama-cpp": "3.19.1",
    });
    expect(packageJson.dependencies).not.toHaveProperty("@duckdb/node-api");
    expect(ignore).toBeTypeOf("function");
    if (typeof ignore !== "function") {
      throw new Error("Expected a packaging ignore function");
    }
    expect(ignore("")).toBe(false);
    expect(ignore("/.vite/build/main.cjs")).toBe(false);
    expect(ignore("/node_modules")).toBe(false);
    expect(ignore("/node_modules/node-llama-cpp")).toBe(false);
    expect(ignore("/node_modules/@node-llama-cpp")).toBe(false);
    expect(ignore("/node_modules/@duckdb")).toBe(true);
    expect(ignore("/node_modules/.bin")).toBe(true);
    expect(ignore("/node_modules/.vite/cache.json")).toBe(true);
    expect(ignore("/node_modules/a/dist/index.js.map")).toBe(true);
    expect(ignore("/node_modules/a/README.md")).toBe(true);
    expect(ignore("/node_modules/a/fixtures/secret.json")).toBe(true);
    expect(ignore("/node_modules/a/test/runtime.test.js")).toBe(true);
    expect(ignore("/node_modules/.package-lock.json")).toBe(true);
    expect(ignore("/apps")).toBe(true);
  });

  it.each(["build", "make"] as const)(
    "dispatches native helpers before Forge in %s",
    (script) => {
      const command = packageJson.scripts[script];
      expect(command).toContain("npm run build:native");
      expect(command.indexOf("build:native")).toBeLessThan(
        command.indexOf("electron-forge"),
      );
    },
  );
});
