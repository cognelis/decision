import { createRequire } from "node:module";

import type { DecisionWindowMode } from "../shared/decision-layout.js";

interface LiquidGlassResult {
  applied: boolean;
  reason: string;
}

interface LiquidGlassOptions {
  cornerRadius: number;
  corners: "all" | "bottom";
  style: "regular";
}

interface LiquidGlassAddon {
  applyGlass(
    nativeHandle: Buffer,
    options: LiquidGlassOptions,
  ): LiquidGlassResult;
}

export interface LiquidGlassSurface {
  update(mode: DecisionWindowMode): void;
}

interface LoadLiquidGlassRuntimeOptions {
  addonPath: string;
  platform?: NodeJS.Platform;
  darwinRelease?: string;
  loadAddon?: (path: string) => LiquidGlassAddon;
}

export interface LiquidGlassRuntime {
  attach(
    nativeHandle: Buffer,
    mode: DecisionWindowMode,
  ): LiquidGlassSurface | null;
}

const optionsForMode = (
  _mode: DecisionWindowMode,
): LiquidGlassOptions => {
  return {
    cornerRadius: 14,
    corners: "all",
    style: "regular",
  };
};

export const isMacOSLiquidGlassAvailable = (
  platform: NodeJS.Platform,
  darwinRelease: string,
): boolean => {
  if (platform !== "darwin") {
    return false;
  }
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major >= 25;
};

const defaultLoadAddon = (path: string): LiquidGlassAddon => {
  const loaded = createRequire(path)(path) as Partial<LiquidGlassAddon>;
  if (typeof loaded.applyGlass !== "function") {
    throw new Error("Liquid Glass addon has no applyGlass export");
  }
  return loaded as LiquidGlassAddon;
};

export const loadLiquidGlassRuntime = ({
  addonPath,
  platform = process.platform,
  darwinRelease = "",
  loadAddon = defaultLoadAddon,
}: LoadLiquidGlassRuntimeOptions): LiquidGlassRuntime | null => {
  if (!isMacOSLiquidGlassAvailable(platform, darwinRelease)) {
    return null;
  }

  let addon: LiquidGlassAddon;
  try {
    addon = loadAddon(addonPath);
  } catch {
    return null;
  }

  return {
    attach: (nativeHandle, mode) => {
      try {
        const result = addon.applyGlass(
          nativeHandle,
          optionsForMode(mode),
        );
        if (!result.applied) {
          return null;
        }
      } catch {
        return null;
      }

      return {
        update: (nextMode) => {
          try {
            addon.applyGlass(
              nativeHandle,
              optionsForMode(nextMode),
            );
          } catch {
            // The already-applied native surface remains usable.
          }
        },
      };
    },
  };
};
