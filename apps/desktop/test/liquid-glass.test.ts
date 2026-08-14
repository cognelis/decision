import { describe, expect, it, vi } from "vitest";

import {
  isMacOSLiquidGlassAvailable,
  loadLiquidGlassRuntime,
} from "../src/main/liquid-glass.js";

describe("macOS Liquid Glass", () => {
  it.each([
    {
      platform: "darwin" as const,
      release: "25.0.0",
      expected: true,
    },
    {
      platform: "darwin" as const,
      release: "26.1.0",
      expected: true,
    },
    {
      platform: "darwin" as const,
      release: "24.6.0",
      expected: false,
    },
    {
      platform: "win32" as const,
      release: "25.0.0",
      expected: false,
    },
  ])(
    "reports $platform $release availability as $expected",
    ({ platform, release, expected }) => {
      expect(
        isMacOSLiquidGlassAvailable(platform, release),
      ).toBe(expected);
    },
  );

  it("applies one regular glass surface for the desktop window", () => {
    const applyGlass = vi.fn(() => ({
      applied: true,
      reason: "liquid_glass_regular",
    }));
    const loadAddon = vi.fn(() => ({ applyGlass }));
    const runtime = loadLiquidGlassRuntime({
      platform: "darwin",
      darwinRelease: "25.5.0",
      addonPath: "/app/liquid-glass.node",
      loadAddon,
    });
    const handle = Buffer.alloc(8);

    const surface = runtime?.attach(handle, "desktop");

    expect(loadAddon).toHaveBeenCalledWith(
      "/app/liquid-glass.node",
    );
    expect(applyGlass).toHaveBeenCalledWith(handle, {
      cornerRadius: 14,
      corners: "all",
      style: "regular",
    });
    expect(surface).not.toBeNull();

    surface?.update("desktop");

    expect(applyGlass).toHaveBeenLastCalledWith(handle, {
      cornerRadius: 14,
      corners: "all",
      style: "regular",
    });
  });

  it("falls back safely when the addon cannot load or apply", () => {
    const loadFailure = loadLiquidGlassRuntime({
      platform: "darwin",
      darwinRelease: "25.5.0",
      addonPath: "/missing/liquid-glass.node",
      loadAddon: () => {
        throw new Error("missing");
      },
    });
    expect(loadFailure).toBeNull();

    const applyFailure = loadLiquidGlassRuntime({
      platform: "darwin",
      darwinRelease: "25.5.0",
      addonPath: "/app/liquid-glass.node",
      loadAddon: () => ({
        applyGlass: () => ({
          applied: false,
          reason: "native_view_missing",
        }),
      }),
    });
    expect(
      applyFailure?.attach(Buffer.alloc(8), "desktop"),
    ).toBeNull();
  });

  it("does not load the addon on unsupported systems", () => {
    const loadAddon = vi.fn();

    expect(
      loadLiquidGlassRuntime({
        platform: "darwin",
        darwinRelease: "24.6.0",
        addonPath: "/app/liquid-glass.node",
        loadAddon,
      }),
    ).toBeNull();
    expect(loadAddon).not.toHaveBeenCalled();
  });
});
