import {
  mkdtemp,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CredentialVault,
  type CredentialCodec,
} from "../src/main/model/credential-vault.js";

const codec = (): CredentialCodec => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) =>
    Buffer.from(`encrypted:${value}`, "utf8"),
  ),
  decryptString: vi.fn((value: Buffer) =>
    value.toString("utf8").replace(/^encrypted:/u, ""),
  ),
});

describe("CredentialVault", () => {
  it("stores only encrypted private files and supports get, has, and delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "credentials-"));
    const path = join(root, "vault");
    const vault = new CredentialVault(path, codec());

    await vault.set("credential-1", "sk-private");

    expect(await vault.get("credential-1")).toBe("sk-private");
    expect(await vault.has("credential-1")).toBe(true);
    const [filename] = await readdir(path);
    expect(filename).toMatch(/^[a-f0-9]{64}\.credential$/u);
    expect(await readFile(join(path, filename!), "utf8")).not.toContain(
      "sk-private",
    );
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    expect((await stat(join(path, filename!))).mode & 0o777).toBe(
      0o600,
    );

    await expect(vault.delete("credential-1")).resolves.toBe(true);
    await expect(vault.delete("credential-1")).resolves.toBe(false);
    await expect(vault.get("credential-1")).resolves.toBeNull();
  });

  it("rejects empty secrets and unsafe references", async () => {
    const root = await mkdtemp(join(tmpdir(), "credentials-input-"));
    const vault = new CredentialVault(root, codec());

    await expect(vault.set("credential-1", "   ")).rejects.toMatchObject({
      code: "credential_unavailable",
    });
    await expect(vault.set("../escape", "secret")).rejects.toMatchObject(
      { code: "credential_unavailable" },
    );
    expect(await readdir(root)).toEqual([]);
  });

  it("maps unavailable encryption and decrypt failures to stable errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "credentials-errors-"));
    const unavailable = codec();
    vi.mocked(unavailable.isEncryptionAvailable).mockReturnValue(false);
    const unavailableVault = new CredentialVault(
      join(root, "unavailable"),
      unavailable,
    );

    await expect(
      unavailableVault.set("credential-1", "private-secret"),
    ).rejects.toMatchObject({
      code: "credential_unavailable",
    });

    const broken = codec();
    const brokenVault = new CredentialVault(
      join(root, "broken"),
      broken,
    );
    await brokenVault.set("credential-1", "private-secret");
    vi.mocked(broken.decryptString).mockImplementation(() => {
      throw new Error("private-secret should not escape");
    });

    const failure = await brokenVault
      .get("credential-1")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "credential_decryption_failed",
    });
    expect(String(failure)).not.toContain("private-secret");
  });
});
