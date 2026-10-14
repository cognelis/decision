import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { readDecisionEnvironment } from "./config/decision-environment.mjs";
import packageJson from "./package.json";

type MacDistributionConfig = Pick<
  NonNullable<ForgeConfig["packagerConfig"]>,
  "osxNotarize" | "osxSign"
>;

const environmentValue = (
  environment: NodeJS.ProcessEnv,
  suffix: string,
): string | undefined => {
  const value = readDecisionEnvironment(environment, suffix)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
};

export const createMacDistributionConfig = (
  environment: NodeJS.ProcessEnv,
): MacDistributionConfig => {
  if (environmentValue(environment, "RELEASE") !== "1") {
    return {
      osxSign: {
        identity: "-",
        identityValidation: false,
        optionsForFile: () => ({
          hardenedRuntime: false,
          timestamp: "none",
        }),
      },
    };
  }

  const identity = environmentValue(
    environment,
    "SIGNING_IDENTITY",
  );
  if (identity === undefined) {
    throw new Error(
      "DECISION_SIGNING_IDENTITY is required for a distribution build",
    );
  }
  if (!identity.startsWith("Developer ID Application:")) {
    throw new Error(
      "Distribution signing requires a Developer ID Application identity",
    );
  }

  const keychainProfile = environmentValue(
    environment,
    "NOTARY_KEYCHAIN_PROFILE",
  );
  const keychain = environmentValue(
    environment,
    "NOTARY_KEYCHAIN",
  );
  const appleApiKey = environmentValue(
    environment,
    "APPLE_API_KEY",
  );
  const appleApiKeyId = environmentValue(
    environment,
    "APPLE_API_KEY_ID",
  );
  const appleApiIssuer = environmentValue(
    environment,
    "APPLE_API_ISSUER",
  );
  const hasAnyApiKeyValue =
    appleApiKey !== undefined ||
    appleApiKeyId !== undefined ||
    appleApiIssuer !== undefined;

  if (keychain !== undefined && keychainProfile === undefined) {
    throw new Error(
      "DECISION_NOTARY_KEYCHAIN requires a keychain profile",
    );
  }

  if (keychainProfile !== undefined && hasAnyApiKeyValue) {
    throw new Error(
      "Configure exactly one notarization strategy: keychain profile or API key",
    );
  }

  let osxNotarize: NonNullable<MacDistributionConfig["osxNotarize"]>;
  if (keychainProfile !== undefined) {
    osxNotarize = {
      keychainProfile,
      ...(keychain === undefined ? {} : { keychain }),
    };
  } else {
    const missing = [
      ["DECISION_APPLE_API_KEY", appleApiKey],
      ["DECISION_APPLE_API_KEY_ID", appleApiKeyId],
      ["DECISION_APPLE_API_ISSUER", appleApiIssuer],
    ]
      .filter(([, value]) => value === undefined)
      .map(([key]) => key);
    if (missing.length > 0) {
      throw new Error(
        `Distribution notarization is incomplete; missing ${missing.join(", ")}`,
      );
    }
    osxNotarize = {
      appleApiKey: appleApiKey!,
      appleApiKeyId: appleApiKeyId!,
      appleApiIssuer: appleApiIssuer!,
    };
  }

  return {
    osxSign: {
      identity,
      identityValidation: true,
      optionsForFile: () => ({ hardenedRuntime: true }),
    },
    osxNotarize,
  };
};

const localElectronZipDir =
  readDecisionEnvironment(process.env, "ELECTRON_ZIP_DIR");

const ignorePackagedSource = (file: string): boolean => {
  if (file.length === 0) {
    return false;
  }
  if (file === "/node_modules/.bin" || file.startsWith("/node_modules/.bin/")) {
    return true;
  }
  if (
    file === "/node_modules/@duckdb" ||
    file.startsWith("/node_modules/@duckdb/")
  ) {
    return true;
  }
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  const components = normalized.split("/").filter(Boolean);
  const dependencyCache =
    normalized.startsWith("/node_modules/") &&
    components.some((component) =>
      [".vite", ".vite-temp"].includes(component),
    );
  const dependencyDocumentation =
    normalized.startsWith("/node_modules/") &&
    /\.(?:markdown|md)$/u.test(normalized);
  if (
    normalized.endsWith(".map") ||
    normalized.endsWith("/.package-lock.json") ||
    dependencyCache ||
    dependencyDocumentation ||
    components.some((component) =>
      ["__tests__", "fixture", "fixtures", "test", "tests"].includes(
        component,
      ),
    )
  ) {
    return true;
  }
  return !(
    file === "/.vite" ||
    file.startsWith("/.vite/") ||
    file === "/node_modules" ||
    file.startsWith("/node_modules/")
  );
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // The libraries a native addon loads beside it as well: on Windows llama.dll and ggml*.dll, which left
      // in the archive Windows could not load, and local recognition and vector search had no model.
      unpack: "**/*.{node,dylib,so,dll}",
    },
    ignore: ignorePackagedSource,
    name: "Decision",
    executableName: "Decision",
    appBundleId: "com.cognelis.decision",
    appCategoryType: "public.app-category.developer-tools",
    icon: "apps/desktop/assets/app-icon",
    extraResource: [
      "dist/bridge",
      "dist/semantic",
      "dist/native",
      "apps/desktop/assets",
      "skills",
    ],
    ...(localElectronZipDir === undefined
      ? {}
      : { electronZipDir: localElectronZipDir }),
    ...createMacDistributionConfig(process.env),
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerSquirrel({
      name: "Decision",
      authors: "Cognelis contributors",
      description: "Local-first decision capture and review platform",
      setupExe: `Decision-${packageJson.version}-win-x64-Setup.exe`,
      setupIcon: "apps/desktop/assets/app-icon.ico",
      noMsi: true,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "apps/desktop/src/main/index.ts",
          config: "apps/desktop/vite.main.config.ts",
          target: "main",
        },
        {
          entry: "apps/desktop/src/preload/index.ts",
          config: "apps/desktop/vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "apps/desktop/vite.renderer.config.ts",
        },
      ],
    }),
    // Set in the packaged binary itself. Running as Node stays on: the bridge's launchers start this binary
    // with ELECTRON_RUN_AS_NODE=1, and run so it still takes --inspect. Off: NODE_OPTIONS, through which an
    // environment variable ran its own code in the app and in every bridge, and --inspect on the app's own
    // process. The app loads only from app.asar, checked against the hash the build wrote beside it. Cookie
    // encryption is left alone: the app keeps no cookies (its requests go through Node), so it would only
    // add a keychain read.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    }),
  ],
};

export default config;
