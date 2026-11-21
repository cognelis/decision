import { ACCENT_PRESETS, isAccentPreset, type AccentPreference } from "../shared/appearance.js";

export type ColorScheme = "light" | "dark";

/*
 * Where the accent sits, from styles.css: as text on the window ground (light, its darkest surface) or on a surface
 * (dark), and under the text an accent fill carries (white in light; --surface-raised in dark). The other accent
 * tokens are mixed from the base the way the presets' were.
 */
const SCHEMES = {
  light: { against: ["#eef0f3", "#ffffff"], toward: "#000000", ground: "#ffffff", surface: 0.9, border: 0.72, bright: 0.12, ink: 0.3 },
  dark: { against: ["#1a1d23", "#20242b"], toward: "#ffffff", ground: "#0f1115", surface: 0.84, border: 0.62, bright: 0.2, ink: 0.45 },
} as const;

const channel = (hex: string, index: number): number => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);

export const mix = (from: string, to: string, amount: number): string =>
  `#${[0, 1, 2]
    .map((index) => Math.round(channel(from, index) * (1 - amount) + channel(to, index) * amount).toString(16).padStart(2, "0"))
    .join("")}`;

const luminance = (hex: string): number => {
  const [red, green, blue] = [0, 1, 2].map((index) => {
    const value = channel(hex, index) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
};

export const contrast = (first: string, second: string): number => {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
};

/**
 * The reader's own colour, moved towards black (light) or white (dark) until it reads at 4.5:1 wherever accent sits,
 * its own tint included: a badge sets accent text on --accent-surface.
 */
const readable = (color: string, scheme: ColorScheme): string => {
  const { against, toward, ground, surface } = SCHEMES[scheme];
  for (let step = 0; step < 20; step += 1) {
    const candidate = mix(color, toward, step / 20);
    const backgrounds = [...against, mix(candidate, ground, surface)];
    if (backgrounds.every((background) => contrast(candidate, background) >= 4.5)) return candidate;
  }
  return toward;
};

export const accentTokens = (preference: AccentPreference, scheme: ColorScheme): Record<string, string> => {
  const { ground, surface, border, bright, ink, toward } = SCHEMES[scheme];
  const base = isAccentPreset(preference) ? ACCENT_PRESETS[preference][scheme] : readable(preference, scheme);
  return {
    "--accent": base,
    // Hover and focus: further from the surface than the base, so the text a hovered fill carries reads more strongly.
    "--accent-bright": mix(base, toward, bright),
    // Text on the accent's tint: darker in light, lighter in dark, so it reads more strongly than the base.
    "--accent-ink": mix(base, toward, ink),
    "--accent-surface": mix(base, ground, surface),
    "--accent-border": mix(base, ground, border),
  };
};

// Absent only under jsdom, where the renderer's unit tests run: read as light there, with nothing to follow.
const darkQuery = (): MediaQueryList | undefined =>
  typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;

/** The scheme the stylesheet shows: a preview forces one; otherwise prefers-color-scheme, which follows the theme setting. */
export const currentScheme = (root: HTMLElement = document.documentElement): ColorScheme => {
  const forced = root.dataset.previewTheme;
  if (forced === "light" || forced === "dark") return forced;
  return darkQuery()?.matches === true ? "dark" : "light";
};

/** Applies the accent for the scheme shown now, and again whenever it changes; returns the unsubscribe. */
export const followAccent = (preference: AccentPreference, root: HTMLElement = document.documentElement): (() => void) => {
  const apply = (): void => {
    for (const [name, value] of Object.entries(accentTokens(preference, currentScheme(root)))) {
      root.style.setProperty(name, value);
    }
  };
  apply();
  const query = darkQuery();
  query?.addEventListener("change", apply);
  return () => query?.removeEventListener("change", apply);
};
