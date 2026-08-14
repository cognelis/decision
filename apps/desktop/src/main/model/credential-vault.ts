import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
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

const isMissing = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

export class CredentialVault {
  readonly #path: string;
  readonly #codec: CredentialCodec;

  constructor(path: string, codec: CredentialCodec) {
    this.#path = path;
    this.#codec = codec;
  }

  async set(reference: string, secret: string): Promise<void> {
    this.#validateReference(reference);
    if (secret.trim().length === 0) {
      throw new CredentialVaultError(
        "credential_unavailable",
        "Credential secret cannot be empty",
      );
    }
    this.#requireEncryption();
    let encrypted: Buffer;
    try {
      encrypted = this.#codec.encryptString(secret);
    } catch {
      throw new CredentialVaultError(
        "credential_unavailable",
        "Credential encryption failed",
      );
    }
    await this.#secureDirectory();
    const target = this.#credentialPath(reference);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted.toString("base64"), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      encrypted.fill(0);
      await unlink(temporary).catch(() => undefined);
    }
  }

  async get(reference: string): Promise<string | null> {
    this.#validateReference(reference);
    let serialized: string;
    try {
      serialized = await readFile(
        this.#credentialPath(reference),
        "utf8",
      );
    } catch (error) {
      if (isMissing(error)) {
        return null;
      }
      throw new CredentialVaultError(
        "credential_decryption_failed",
        "Credential could not be read",
      );
    }
    this.#requireEncryption();
    if (
      serialized.length === 0 ||
      !BASE64_PATTERN.test(serialized)
    ) {
      throw new CredentialVaultError(
        "credential_decryption_failed",
        "Credential ciphertext is invalid",
      );
    }
    const encrypted = Buffer.from(serialized, "base64");
    try {
      return this.#codec.decryptString(encrypted);
    } catch {
      throw new CredentialVaultError(
        "credential_decryption_failed",
        "Credential decryption failed",
      );
    } finally {
      encrypted.fill(0);
    }
  }

  async has(reference: string): Promise<boolean> {
    this.#validateReference(reference);
    try {
      await access(this.#credentialPath(reference));
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
  }

  async delete(reference: string): Promise<boolean> {
    this.#validateReference(reference);
    try {
      await unlink(this.#credentialPath(reference));
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw error;
    }
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
