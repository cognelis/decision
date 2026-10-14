import { renameReplacing } from "@cognelis/decision-storage";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export interface CredentialCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class CredentialVaultError extends Error {
  readonly code:
    | "credential_unavailable"
    | "credential_decryption_failed";

  constructor(
    code: CredentialVaultError["code"],
    message: string,
  ) {
    super(message);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

const REFERENCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const SWITCH_MARK = "mode-switch";

const isMissing = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

export class CredentialVault {
  readonly #path: string;
  readonly #codec: CredentialCodec;
  #localMode: boolean;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(path: string, codec: CredentialCodec, localMode = false) {
    this.#path = path;
    this.#codec = codec;
    this.#localMode = localMode;
  }

  // Serialize mode changes with writes so migration cannot overwrite a new secret.
  #run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#pending.then(operation);
    this.#pending = next.catch(() => undefined);
    return next;
  }

  setLocalMode(enabled: boolean, persist: () => Promise<void>): Promise<void> {
    return this.#run(async () => {
      await this.#secureDirectory();
      const changes: { path: string; before: string; after: string }[] = [];
      let unmovable = 0;
      for (const name of await readdir(this.#path)) {
        if (!/^[a-f0-9]{64}\.credential$/u.test(name)) continue;
        const path = join(this.#path, name);
        const before = await readFile(path, "utf8");
        if (before.startsWith("local:") === enabled) continue;
        try {
          changes.push({ path, before, after: this.#encode(this.#decode(before), enabled) });
        } catch {
          unmovable += 1;
        }
      }
      // Said, with the way through: one key the keychain would not give up (access refused, or the app
      // signed anew) failed every attempt with "Credential decryption failed", and the switch could never
      // be made. A key filled in again is saved in the present mode, and then moves.
      if (unmovable > 0) {
        throw enabled
          ? new CredentialVaultError(
            "credential_decryption_failed",
            `有 ${unmovable} 条已保存的密钥无法从系统钥匙串读出（可能拒绝了授权，或应用签名已变），这次没有切换。请在“模型”里重新填写这些后端的密钥，或删除不再使用的后端，然后再试。`,
          )
          : new CredentialVaultError(
            "credential_unavailable",
            `有 ${unmovable} 条密钥无法写回系统钥匙串（可能拒绝了授权），这次没有切换。允许授权后再试。`,
          );
      }
      const written: typeof changes = [];
      // Marked before a key moves and cleared once the setting is saved: cut short between the two (a quit, a crash),
      // the keys say the mode at the next start (keptMode), where the setting still names the one left. A switch that
      // failed and put the keys back leaves the mark beside keys that agree with the setting.
      await writeFile(join(this.#path, SWITCH_MARK), enabled ? "local" : "keychain", { encoding: "utf8", mode: 0o600 });
      try {
        for (const change of changes) {
          written.push(change);
          await this.#write(change.path, change.after);
        }
        await persist();
        this.#localMode = enabled;
      } catch (error) {
        for (const change of written.reverse()) {
          await this.#write(change.path, change.before);
        }
        // No key had to move, so every key already is in this mode: its setting not saved (a start correcting it) does
        // not make them otherwise. Kept in the old mode, keys added meanwhile went the other way, and each key read was
        // moved back out of the mode the keys say.
        if (changes.length === 0) this.#localMode = enabled;
        throw error;
      }
      await unlink(join(this.#path, SWITCH_MARK)).catch(() => undefined);
    });
  }

  /** Whether a switch of modes was cut short before its setting was saved: its mark is still there. */
  switchCutShort(): Promise<boolean> {
    return access(join(this.#path, SWITCH_MARK)).then(() => true, () => false);
  }

  /**
   * Where the keys are kept, as the files say: true when every one is kept here (local-credential mode), false when
   * every one is in the keychain, null when there are none or both (a switch cut short as it moved them). A switch
   * moves every key before its setting is saved: cut short between the two, the setting still names the mode left.
   */
  async keptMode(): Promise<boolean | null> {
    let local = false;
    let keychain = false;
    for (const name of await readdir(this.#path).catch(() => [] as string[])) {
      if (!/^[a-f0-9]{64}\.credential$/u.test(name)) continue;
      const content = await readFile(join(this.#path, name), "utf8").catch(() => null);
      if (content === null) continue;
      if (content.startsWith("local:")) local = true;
      else keychain = true;
    }
    return local === keychain ? null : local;
  }

  set(reference: string, secret: string): Promise<void> {
    return this.#run(async () => {
      this.#validateReference(reference);
      if (secret.trim().length === 0) {
        throw new CredentialVaultError("credential_unavailable", "Credential secret cannot be empty");
      }
      const serialized = this.#encode(secret, this.#localMode);
      await this.#secureDirectory();
      await this.#write(this.#credentialPath(reference), serialized);
    });
  }

  #encode(secret: string, localMode: boolean): string {
    if (localMode) return `local:${JSON.stringify(secret)}`;
    this.#requireEncryption();
    let encrypted: Buffer | undefined;
    try {
      encrypted = this.#codec.encryptString(secret);
      return encrypted.toString("base64");
    } catch {
      throw new CredentialVaultError("credential_unavailable", "Credential encryption failed");
    } finally {
      encrypted?.fill(0);
    }
  }

  async #write(target: string, serialized: string): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await renameReplacing(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  get(reference: string): Promise<string | null> {
    return this.#run(async () => {
      this.#validateReference(reference);
      let serialized: string;
      try {
        serialized = await readFile(this.#credentialPath(reference), "utf8");
      } catch (error) {
        if (isMissing(error)) return null;
        throw new CredentialVaultError("credential_decryption_failed", "Credential could not be read");
      }
      const secret = this.#decode(serialized);
      // Finish an interrupted migration using the persisted mode.
      if (serialized.startsWith("local:") !== this.#localMode) {
        await this.#secureDirectory();
        await this.#write(this.#credentialPath(reference), this.#encode(secret, this.#localMode));
      }
      return secret;
    });
  }

  #decode(serialized: string): string {
    if (serialized.startsWith("local:")) {
      try {
        const secret: unknown = JSON.parse(serialized.slice(6));
        if (typeof secret === "string" && secret.trim()) return secret;
      } catch { /* Report a sanitized error below. */ }
      throw new CredentialVaultError("credential_decryption_failed", "Local credential is invalid");
    }
    this.#requireEncryption();
    if (serialized.length === 0 || !BASE64_PATTERN.test(serialized)) {
      throw new CredentialVaultError("credential_decryption_failed", "Credential ciphertext is invalid");
    }
    const encrypted = Buffer.from(serialized, "base64");
    try {
      return this.#codec.decryptString(encrypted);
    } catch {
      throw new CredentialVaultError("credential_decryption_failed", "Credential decryption failed");
    } finally {
      encrypted.fill(0);
    }
  }

  has(reference: string): Promise<boolean> {
    return this.#run(async () => {
      this.#validateReference(reference);
      try {
        await access(this.#credentialPath(reference));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
  }

  delete(reference: string): Promise<boolean> {
    return this.#run(async () => {
      this.#validateReference(reference);
      try {
        await unlink(this.#credentialPath(reference));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    });
  }

  #validateReference(reference: string): void {
    if (!REFERENCE_PATTERN.test(reference)) {
      throw new CredentialVaultError(
        "credential_unavailable",
        "Credential reference is invalid",
      );
    }
  }

  #requireEncryption(): void {
    if (!this.#codec.isEncryptionAvailable()) {
      throw new CredentialVaultError(
        "credential_unavailable",
        "System credential encryption is unavailable",
      );
    }
  }

  #credentialPath(reference: string): string {
    const digest = createHash("sha256")
      .update(reference, "utf8")
      .digest("hex");
    return join(this.#path, `${digest}.credential`);
  }

  async #secureDirectory(): Promise<void> {
    await mkdir(this.#path, { recursive: true, mode: 0o700 });
    await chmod(this.#path, 0o700);
  }
}
