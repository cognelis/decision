import { modelProxySchema } from "@cognelis/decision-protocol";
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
  DEFAULT_CAPTURE_CLASSIFIER,
  type CaptureClassifier,
} from "../shared/capture-classifier.js";
import {
  ACCENT_PRESET_IDS,
  DEFAULT_ACCENT,
  THEME_PREFERENCES,
  type AccentPreference,
  type ThemePreference,
} from "../shared/appearance.js";

/** A preset's id, or a colour of the reader's own as #rrggbb, kept lower-case (IMP-140). */
export const accentPreferenceSchema = z.union([
  z.enum(ACCENT_PRESET_IDS),
  z.string().regex(/^#[0-9a-f]{6}$/iu).transform((value) => value.toLowerCase() as `#${string}`),
]);

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

export const modelProxyUrlSchema = modelProxySchema.shape.url.unwrap().nullable();

export const appSettingsSchema = z
  .object({
    version: z.literal(3),
    vaultPath: z.string().min(1).nullable(),
    // A choice a later build added reads as the default here, not as a file this build cannot start with.
    theme: z.enum(THEME_PREFERENCES).catch("auto"),
    modelTraceContentEnabled: z.boolean(),
    modelProxyUrl: modelProxyUrlSchema.optional(),
    /**
     * Additive, so a v3 file written before reminders existed still parses and
     * gains the field on its next save. A version bump is for changes that
     * break reading, which this is not.
     */
    reviewRemindersEnabled: z.boolean().default(true),
    localCredentialsEnabled: z.boolean().default(false),
    /**
     * Which engine reads a captured turn. Additive like the field above, and
     * defaulted to the rules plus this machine's Qwen 4B (IMP-153): on the R11
     * blind set the rules alone took 92 of 104 decisions and wrote 5 that were
     * not; with 4B, 104 of 104 and 2. Only 4B, and only on this machine: it is
     * the one caller that runs unattended on every turn the reader never asked
     * about, and 2B scored below the rules alone on every measure. A `rules`
     * stored before is moved once (SettingsRepository.moveCaptureClassifier).
     */
    captureClassifier: z.enum(CAPTURE_CLASSIFIERS).default(DEFAULT_CAPTURE_CLASSIFIER).catch(DEFAULT_CAPTURE_CLASSIFIER),
    accent: accentPreferenceSchema.default(DEFAULT_ACCENT).catch(DEFAULT_ACCENT),
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
const ADDED_SINCE_1_1 = ["reviewRemindersEnabled", "localCredentialsEnabled", "captureClassifier", "accent", "modelProxyUrl"] as const;

const addedSettingsSchema = z.object({
  modelProxyUrl: modelProxyUrlSchema.optional().catch(undefined),
  reviewRemindersEnabled: z.boolean().optional().catch(undefined),
  localCredentialsEnabled: z.boolean().optional().catch(undefined),
  captureClassifier: z.enum(CAPTURE_CLASSIFIERS).optional().catch(undefined),
  accent: accentPreferenceSchema.optional().catch(undefined),
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
  captureClassifier: DEFAULT_CAPTURE_CLASSIFIER,
  accent: DEFAULT_ACCENT,
};

export const withVaultPath = (
  settings: AppSettings,
  vaultPath: string | null,
): AppSettings => ({ ...settings, vaultPath });

export const withTheme = (
  settings: AppSettings,
  theme: ThemePreference,
): AppSettings => ({ ...settings, theme });

export const withAccent = (
  settings: AppSettings,
  accent: AccentPreference,
): AppSettings => ({ ...settings, accent });

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

/**
 * Settings changed one at a time, each made to the settings the change before left (IMP-140). Built from the
 * settings as they were while an earlier save was still running, a change to one setting put back the setting that
 * save had just changed: the theme colour, saved while the picker settles, came back over a theme chosen meanwhile.
 */
export const serializeSettingsChanges = (
  read: () => AppSettings,
  save: (next: AppSettings) => Promise<void>,
): ((change: (current: AppSettings) => AppSettings) => Promise<AppSettings>) => {
  let last: Promise<unknown> = Promise.resolve();
  return (change) => {
    const run = last.then(async () => {
      const next = change(read());
      await save(next);
      return next;
    });
    last = run.catch(() => undefined);
    return run;
  };
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Why a start could not move the capture classifier off the old default; `retried` when the next start tries again. */
export interface CaptureClassifierMoveFailure {
  reason: string;
  retried: boolean;
}

const CAPTURE_CLASSIFIER_NAMES: Record<CaptureClassifier, string> = {
  local: "规则加本机模型",
  rules: "只用规则",
  models: "规则加模型",
};

/** The failure as the reader is told it, naming the classifier kept as it is (IMP-154). */
export const captureClassifierMoveFailedMessage = (kept: CaptureClassifier, failure: CaptureClassifierMoveFailure): string =>
  `设置保存不了（${failure.reason}），采集分类这次仍按「${CAPTURE_CLASSIFIER_NAMES[kept]}」` +
  (kept === "models" ? "：每一轮对话都会按模型页的后端顺序发给所选后端，可能是命令行或远程服务" : "") +
  "。" +
  (failure.retried
    ? "请检查设置所在文件夹的写入权限，下次启动会再试一次；也可以在模型页手动选择。"
    : "设置只写下了一部分，下次启动以已写下的为准，之后不会再自动更改；需要时请在模型页手动选择。");

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
  /**
   * Beside the settings, the record that the capture classifier was decided (IMP-154): moved off the old default,
   * or chosen by the reader. A file of its own, which no earlier build reads or writes over.
   */
  readonly #decidedPath: string;
  /** Why the capture classifier could not be moved off the old default at this start; null when it was. */
  captureClassifierMoveFailed: CaptureClassifierMoveFailure | null = null;

  constructor(path: string) {
    this.#path = path;
    this.#addedPath = path.replace(/(\.json)?$/u, "-extra.json");
    this.#decidedPath = path.replace(/(\.json)?$/u, "-migrations.json");
  }

  /**
   * The old default `rules` moved to the new one once (IMP-154): the settings to use. Every save before wrote the
   * field, so a `rules` there cannot be told from one the reader chose. The record first, then the classifier: no
   * failure at any step leaves the new default used with no record of the move. The record not written, nothing
   * changes and the next start tries again; written but the classifier not saved, the settings stay as they were
   * (`rules`) and are not moved again, for the reader to change by hand. `captureClassifierMoveFailed` says which.
   */
  async moveCaptureClassifier(settings: AppSettings): Promise<AppSettings> {
    this.captureClassifierMoveFailed = null;
    if (await this.#captureClassifierDecided()) return settings;
    try {
      await this.recordCaptureClassifierDecided();
    } catch (error) {
      this.captureClassifierMoveFailed = { reason: errorMessage(error), retried: true };
      return settings;
    }
    if (settings.captureClassifier !== "rules") return settings;
    const moved: AppSettings = { ...settings, captureClassifier: DEFAULT_CAPTURE_CLASSIFIER };
    try {
      await this.save(moved);
    } catch (error) {
      this.captureClassifierMoveFailed = { reason: errorMessage(error), retried: false };
      return settings;
    }
    return moved;
  }

  /**
   * Said before a classifier the reader chose is saved: that `rules` is then a choice, kept at every start, even
   * after a move that failed. Throws when it cannot be written, and the choice is not saved either.
   */
  async recordCaptureClassifierDecided(): Promise<void> {
    await this.#write(this.#decidedPath, { captureClassifier: "decided" });
  }

  async #captureClassifierDecided(): Promise<boolean> {
    try {
      await stat(this.#decidedPath);
      return true;
    } catch (error) {
      // Not known to be absent: left as it is rather than a `rules` the reader chose moved a second time.
      return !isMissing(error);
    }
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
        `读不出设置文件 ${this.#path}（${error instanceof Error ? error.message : String(error)}），请检查它的访问权限后重新打开 Paraself。`,
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
      throw new Error(`设置文件 ${this.#path} 是更新版本的 Paraself 写下的，这个版本读不了，请用更新的版本打开。`);
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
        throw new Error(`设置文件 ${this.#path} 读不出来，也没能把它移到一边，请把它移走后重新打开 Paraself。`);
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
        accent: DEFAULT_ACCENT,
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
        accent: DEFAULT_ACCENT,
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
        `读不出设置文件 ${this.#addedPath}（${error instanceof Error ? error.message : String(error)}），请检查它的访问权限后重新打开 Paraself。`,
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
