export const THEME_PREFERENCES = ["auto", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/**
 * The colour of what asks for the reader: the counts to act on and the one primary action, never what is merely
 * selected (IMP-140). Each preset has a light and a dark value, both checked for contrast: on the light one white text, on
 * the dark one dark text, and either one as text on its own theme's surfaces, at 4.5:1 or more.
 */
export const ACCENT_PRESET_IDS = [
  "blue",
  "indigo",
  "purple",
  "teal",
  "green",
  "amber",
  "sienna",
  "rose",
  "graphite",
] as const;

export type AccentPresetId = (typeof ACCENT_PRESET_IDS)[number];

/** A preset's id, or a colour of the reader's own as lower-case #rrggbb. */
export type AccentPreference = AccentPresetId | `#${string}`;

export const DEFAULT_ACCENT: AccentPresetId = "blue";

export const ACCENT_PRESETS: Readonly<Record<AccentPresetId, { label: string; light: string; dark: string }>> = {
  blue: { label: "蓝", light: "#2563d9", dark: "#7aa7ff" },
  indigo: { label: "靛", light: "#4f46c8", dark: "#a49dff" },
  purple: { label: "紫", light: "#8b2fc9", dark: "#cf9cff" },
  teal: { label: "青", light: "#0b7471", dark: "#4cc5bd" },
  green: { label: "绿", light: "#2b7a3d", dark: "#76c488" },
  amber: { label: "琥珀", light: "#9a5600", dark: "#f2aa4c" },
  sienna: { label: "赭", light: "#a8431c", dark: "#e9875a" },
  rose: { label: "玫", light: "#b92b57", dark: "#ff8fb1" },
  graphite: { label: "石墨", light: "#3b4250", dark: "#c3c8d1" },
};

export const isAccentPreset = (value: string): value is AccentPresetId =>
  (ACCENT_PRESET_IDS as readonly string[]).includes(value);
