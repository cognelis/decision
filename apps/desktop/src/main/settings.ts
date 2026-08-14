import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import {
  THEME_PREFERENCES,
  type ThemePreference,
} from "../shared/appearance.js";

const appSettingsV1Schema = z
  .object({
    version: z.literal(1),
    vaultPath: z.string().min(1).nullable(),
  })
  .strict();

const appSettingsV2Schema = z
  .object({
    version: z.literal(2),
    vaultPath: z.string().min(1).nullable(),
    theme: z.enum(THEME_PREFERENCES),
  })
  .strict();

export const appSettingsSchema = z
  .object({
    version: z.literal(3),
    vaultPath: z.string().min(1).nullable(),
    theme: z.enum(THEME_PREFERENCES),
    modelTraceContentEnabled: z.boolean(),
  })
  .strict();

export type AppSettings = z.infer<typeof appSettingsSchema>;

const storedSettingsSchema = z.union([
  appSettingsV1Schema,
  appSettingsV2Schema,
  appSettingsSchema,
]);

const DEFAULT_SETTINGS: AppSettings = {
  version: 3,
  vaultPath: null,
  theme: "auto",
  modelTraceContentEnabled: true,
};

export const withVaultPath = (
  settings: AppSettings,
  vaultPath: string | null,
): AppSettings => ({ ...settings, vaultPath });

export const withTheme = (
  settings: AppSettings,
  theme: ThemePreference,
): AppSettings => ({ ...settings, theme });

export const withModelTraceContentEnabled = (
  settings: AppSettings,
  modelTraceContentEnabled: boolean,
): AppSettings => ({ ...settings, modelTraceContentEnabled });

const isMissing = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

export class SettingsRepository {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<AppSettings> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return { ...DEFAULT_SETTINGS };
      }
      throw error;
    }
    try {
      const settings = storedSettingsSchema.parse(JSON.parse(raw));
      if (settings.version === 1) {
        return {
          version: 3,
          vaultPath: settings.vaultPath,
          theme: "auto",
          modelTraceContentEnabled: true,
        };
      }
      if (settings.version === 2) {
        return {
          version: 3,
          vaultPath: settings.vaultPath,
          theme: settings.theme,
          modelTraceContentEnabled: true,
        };
      }
      return settings;
    } catch (error) {
      throw new Error(
        `Decision settings are invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async save(input: AppSettings): Promise<void> {
    const settings = appSettingsSchema.parse(input);
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.#path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

const obsidianConfigurationSchema = z
  .object({
    vaults: z.record(
      z.string(),
      z
        .object({
          path: z.string().min(1),
          ts: z.number().optional(),
          open: z.boolean().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const discoverObsidianVaults = async (
  configurationPath: string,
): Promise<string[]> => {
  let raw: string;
  try {
    raw = await readFile(configurationPath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  const configuration = obsidianConfigurationSchema.parse(JSON.parse(raw));
  const candidates = Object.values(configuration.vaults).sort(
    (left, right) =>
      Number(right.open === true) - Number(left.open === true) ||
      (right.ts ?? 0) - (left.ts ?? 0),
  );
  return [...new Set(candidates.map((vault) => vault.path))];
};
