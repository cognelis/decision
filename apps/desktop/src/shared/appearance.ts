export const THEME_PREFERENCES = ["auto", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
