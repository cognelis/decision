import { renameReplacing } from "@cognelis/decision-storage";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

import {
  CAPTURE_CLASSIFIERS,
  type CaptureClassifier,
} from "../shared/capture-classifier.js";
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
    theme: z.enum(THEME_PREFERENCES).catch("auto"),
  })
  .strict();

export const appSettingsSchema = z
  .object({
    version: z.literal(3),
    vaultPath: z.string().min(1).nullable(),
    // A choice a later build added reads as the default here, not as a file this build cannot start with.
    theme: z.enum(THEME_PREFERENCES).catch("auto"),
    modelTraceContentEnabled: z.boolean(),
    /**
     * Additive, so a v3 file written before reminders existed still parses and
     * gains the field on its next save. A version bump is for changes that
     * break reading, which this is not.
     */
    reviewRemindersEnabled: z.boolean().default(true),
    localCredentialsEnabled: z.boolean().default(false),
    /**
     * Which engine reads a captured turn. Additive like the field above, and
     * defaulted to `rules` — on the fixed evaluation corpus the bundled 2B
     * model scored below the rules alone on every measure, and it is the one
     * caller that runs unattended on every turn the reader never asked about.
     */
    captureClassifier: z.enum(CAPTURE_CLASSIFIERS).default("rules").catch("rules"),
  });
// Not strict: a field a later build added, the way fields are added above, is left out here rather
// than keeping this build from starting at all.

export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * Fields version 3 gained after 1.1.0, kept in a file beside the settings (save). A reader going back to 1.1.0
 * with local credentials on starts, but its remote backends cannot read a key kept here as `local:`: they say the
 * key cannot be decrypted until it is filled in again there, in the keychain, and this build moves it back to
 * local when it next reads it (CredentialVault.get).
 */
const ADDED_SINCE_1_1 = ["reviewRemindersEnabled", "localCredentialsEnabled", "captureClassifier"] as const;

const addedSettingsSchema = z.object({
  reviewRemindersEnabled: z.boolean().optional().catch(undefined),
  localCredentialsEnabled: z.boolean().optional().catch(undefined),
  captureClassifier: z.enum(CAPTURE_CLASSIFIERS).optional().catch(undefined),
});

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
  reviewRemindersEnabled: true,
  localCredentialsEnabled: false,
  captureClassifier: "rules",
};

export const withVaultPath = (
  settings: AppSettings,
  vaultPath: string | null,
): AppSettings => ({ ...settings, vaultPath });

export const withTheme = (
  settings: AppSettings,
  theme: ThemePreference,
): AppSettings => ({ ...settings, theme });

export const withReviewRemindersEnabled = (
  settings: AppSettings,
  reviewRemindersEnabled: boolean,
): AppSettings => ({ ...settings, reviewRemindersEnabled });

export const withCaptureClassifier = (
  settings: AppSettings,
  captureClassifier: CaptureClassifier,
): AppSettings => ({ ...settings, captureClassifier });

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
  /** Beside the settings, where the fields added since 1.1.0 are kept: 1.1.0 never reads it. */
  readonly #addedPath: string;
  /** Where the last load set an unreadable file aside, for the app to say so; null when it did not. */
  setAside: string | null = null;
  /** Where a load set the file beside the settings aside, unreadable: the settings it held are back at their defaults. */
  addedSetAside: string | null = null;

  constructor(path: string) {
    this.#path = path;
    this.#addedPath = path.replace(/(\.json)?$/u, "-extra.json");
  }

  async load(): Promise<AppSettings> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if (isMissing(error)) {
        return { ...DEFAULT_SETTINGS };
      }
      throw new Error(
        `读不出设置文件 ${this.#path}（${error instanceof Error ? error.message : String(error)}），请检查它的访问权限后重新打开 Decision。`,
      );
    }
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      stored = undefined;
    }
    const version = typeof stored === "object" && stored !== null && "version" in stored ? stored.version : undefined;
    // Written by a later build: set aside here, that build would find its settings gone.
    if (typeof version === "number" && version > 3) {
      throw new Error(`设置文件 ${this.#path} 是更新版本的 Decision 写下的，这个版本读不了，请用更新的版本打开。`);
    }
    const parsed = storedSettingsSchema.safeParse(stored);
    if (!parsed.success) {
      // Empty or cut short (the power went during a save), or not settings at all: kept aside where it can
      // be looked at, and the app starts from the defaults (the vault is chosen again) rather than not at all.
      const aside = `${this.#path}.unreadable-${Date.now()}`;
      try {
        await rename(this.#path, aside);
      } catch {
        // Not set aside, the next save would write over it.
        throw new Error(`设置文件 ${this.#path} 读不出来，也没能把它移到一边，请把它移走后重新打开 Decision。`);
      }
      this.setAside = aside;
      return { ...DEFAULT_SETTINGS };
    }
    const settings = parsed.data;
    // Kept beside the file since (save); one an earlier build wrote into the file itself is the later word.
    const added = Object.fromEntries(
      Object.entries(await this.#loadAdded()).filter(([key, value]) => value !== undefined && !(key in (stored as object))),
    );
    if (settings.version === 1) {
      return {
        version: 3,
        vaultPath: settings.vaultPath,
        theme: "auto",
        modelTraceContentEnabled: true,
        reviewRemindersEnabled: true,
        localCredentialsEnabled: false,
        captureClassifier: "rules",
        ...added,
      };
    }
    if (settings.version === 2) {
      return {
        version: 3,
        vaultPath: settings.vaultPath,
        theme: settings.theme,
        modelTraceContentEnabled: true,
        reviewRemindersEnabled: true,
        localCredentialsEnabled: false,
        captureClassifier: "rules",
        ...added,
      };
    }
    return { ...settings, ...added };
  }

  /** The fields added since 1.1.0 as the file beside the settings holds them: none it cannot read. */
  async #loadAdded(): Promise<z.infer<typeof addedSettingsSchema>> {
    let raw: string;
    try {
      raw = await readFile(this.#addedPath, "utf8");
    } catch (error) {
      if (isMissing(error)) return {};
      throw new Error(
        `读不出设置文件 ${this.#addedPath}（${error instanceof Error ? error.message : String(error)}），请检查它的访问权限后重新打开 Decision。`,
      );
    }
    try {
      return addedSettingsSchema.parse(JSON.parse(raw));
    } catch {
      // Kept aside where it can be looked at, as the settings file is, and said: read as nothing and left in place,
      // the next save wrote over it for good; set aside without a word, local-credential mode went off and the
      // other settings it held back to their defaults with nothing to tell the reader why.
      const aside = `${this.#addedPath}.unreadable-${Date.now()}`;
      await rename(this.#addedPath, aside).then(() => {
        this.addedSetAside = aside;
      }, () => undefined);
      return {};
    }
  }

  #saving: Promise<unknown> = Promise.resolve();

  /** One at a time: two at once could leave the settings from one and the file beside them from the other. */
  save(input: AppSettings): Promise<void> {
    const run = this.#saving.then(() => this.#save(input));
    this.#saving = run.catch(() => undefined);
    return run;
  }

  async #save(input: AppSettings): Promise<void> {
    const settings = appSettingsSchema.parse(input);
    // The fields added since 1.1.0 go beside the file, which 1.1.0 never reads: in it, 1.1.0's strict settings
    // refused the whole file, and a reader going back to it found the app quit at once without a word. Beside it
    // first: an earlier build's file holds them itself until the second write, where they are the later word, so a
    // save cut short between the two loses this save's change to them at most. The file first, a failed second
    // write left them nowhere: local-credential mode off, its keys moved to the keychain at the next start.
    await this.#write(this.#addedPath, Object.fromEntries(ADDED_SINCE_1_1.map((key) => [key, settings[key]])));
    await this.#write(
      this.#path,
      Object.fromEntries(Object.entries(settings).filter(([key]) => !(ADDED_SINCE_1_1 as readonly string[]).includes(key))),
    );
  }

  async #write(path: string, value: Record<string, unknown>): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await renameReplacing(temporary, path);
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
  const paths = [...new Set(candidates.map((vault) => vault.path))];
  // Obsidian keeps a vault moved or deleted since, often still marked open: chosen, an empty folder was made where it
  // had been, the decisions went there, and the vault that is there (listed second) was passed over.
  const present = await Promise.all(paths.map((path) => stat(path).then((status) => status.isDirectory(), () => false)));
  return paths.filter((_path, index) => present[index]);
};
