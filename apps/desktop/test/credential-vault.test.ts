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


describe("local credential mode", () => {
  it("says in words how many keys the keychain would not give up, and switches once they are filled in again", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-unreadable-"));
    const encryption = codec();
    const vault = new CredentialVault(path, encryption);
    await vault.set("provider:one", "model-secret");
    await vault.set("provider:two", "other-secret");
    // Access refused, or the app signed anew: one key will not come out of the keychain.
    vi.mocked(encryption.decryptString).mockImplementation((value: Buffer) => {
      const text = value.toString("utf8");
      if (text.includes("other-secret")) throw new Error("Credential decryption failed");
      return text.replace(/^encrypted:/u, "");
    });
    const persist = vi.fn(async () => undefined);

    await expect(vault.setLocalMode(true, persist)).rejects.toThrow("有 1 条已保存的密钥无法从系统钥匙串读出");
    expect(persist).not.toHaveBeenCalled();

    // Filled in again, it is saved as the mode now is, and the switch goes through.
    await vault.set("provider:two", "renewed-key");
    await vault.setLocalMode(true, persist);
    expect(persist).toHaveBeenCalledOnce();
    expect(await vault.get("provider:two")).toBe("renewed-key");
  });

  it("migrates both ways and reads local credentials after restart without the codec", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-local-"));
    const encryption = codec();
    const vault = new CredentialVault(path, encryption);
    await vault.set("provider:one", "model-secret");
    await vault.set("pr-one", "pr-secret");
    await vault.setLocalMode(true, async () => undefined);
    vi.clearAllMocks();
    vi.mocked(encryption.isEncryptionAvailable).mockReturnValue(false);
    const restarted = new CredentialVault(path, encryption, true);
    await restarted.setLocalMode(true, async () => undefined);
    expect(await restarted.get("provider:one")).toBe("model-secret");
    expect(await restarted.get("pr-one")).toBe("pr-secret");
    await restarted.set("pr-one", "updated-secret");
    expect(await restarted.has("pr-one")).toBe(true);
    expect(encryption.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(encryption.encryptString).not.toHaveBeenCalled();
    expect(encryption.decryptString).not.toHaveBeenCalled();
    for (const name of await readdir(path)) {
      expect((await readFile(join(path, name), "utf8")).startsWith("local:")).toBe(true);
      expect((await stat(join(path, name))).mode & 0o777).toBe(0o600);
    }
    const persist = vi.fn(async () => undefined);
    await expect(restarted.setLocalMode(false, persist)).rejects.toMatchObject({ code: "credential_unavailable" });
    expect(persist).not.toHaveBeenCalled();
    expect(await restarted.get("pr-one")).toBe("updated-secret");
    vi.mocked(encryption.isEncryptionAvailable).mockReturnValue(true);
    await restarted.setLocalMode(false, persist);
    const secured = new CredentialVault(path, encryption);
    expect(await secured.get("pr-one")).toBe("updated-secret");
    for (const name of await readdir(path)) {
      expect(await readFile(join(path, name), "utf8")).not.toContain("local:");
    }
    expect(await secured.delete("pr-one")).toBe(true);
  });

  it("says from its files where the keys are kept, for a start whose setting could not be read or was not saved", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-holds-"));
    const encryption = codec();
    const vault = new CredentialVault(path, encryption);
    // No keys: the setting says.
    expect(await vault.keptMode()).toBeNull();
    await vault.set("provider:one", "model-secret");
    // In the keychain: a setting read as on after a switch to off cut short before it was saved is not the mode,
    // and the keys stay in the keychain rather than coming back out in plain text.
    expect(await vault.keptMode()).toBe(false);
    await vault.setLocalMode(true, async () => undefined);
    // Kept here: one read as off (the file beside the settings set aside) is not, and the keys stay where they are.
    expect(await new CredentialVault(path, encryption).keptMode()).toBe(true);
  });

  it("marks a switch until its setting is saved, for a start after one cut short to ask the keys", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-switch-"));
    const encryption = codec();
    const vault = new CredentialVault(path, encryption);
    await vault.set("provider:one", "model-secret");
    // Keys filled in again elsewhere (1.1.0, into the keychain) with no switch under way: the setting says the mode.
    expect(await vault.switchCutShort()).toBe(false);

    // Cut short as its setting was being saved (a quit): the keys have moved, the setting not yet.
    let saved = (): void => undefined;
    const switching = vault.setLocalMode(true, () => new Promise<void>((resolve) => {
      saved = resolve;
    }));
    await vi.waitFor(async () => expect(await new CredentialVault(path, encryption).switchCutShort()).toBe(true));
    expect(await new CredentialVault(path, encryption).keptMode()).toBe(true);
    saved();
    await switching;
    expect(await vault.switchCutShort()).toBe(false);
  });

  it("keeps the mode the keys are in when only saving that mode as the setting fails", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-unsaved-"));
    const encryption = codec();
    // Every key kept here already (the file beside the settings set aside, read as off): a start corrects the setting.
    const vault = new CredentialVault(path, encryption, true);
    await vault.set("provider:one", "model-secret");
    const corrected = new CredentialVault(path, encryption, false);
    await expect(corrected.setLocalMode(true, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");

    // Kept in the old mode, a key added now went to the keychain and each key read was moved back there.
    await corrected.set("provider:two", "second-secret");
    expect(await corrected.get("provider:one")).toBe("model-secret");
    expect(await new CredentialVault(path, encryption).keptMode()).toBe(true);
  });

  it("rolls back files and mode when saving settings fails, then accepts subsequent writes", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-rollback-"));
    const vault = new CredentialVault(path, codec());
    await vault.set("provider:one", "original");
    const [name] = await readdir(path);
    const before = await readFile(join(path, name!), "utf8");
    await expect(vault.setLocalMode(true, async () => { throw new Error("save failed"); })).rejects.toThrow("save failed");
    expect(await readFile(join(path, name!), "utf8")).toBe(before);
    await vault.set("provider:one", "new-secret");
    expect(await vault.get("provider:one")).toBe("new-secret");
    expect(await readFile(join(path, name!), "utf8")).not.toContain("local:");
  });

  it("does not modify any files if one credential cannot be decrypted", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-migration-"));
    const encryption = codec();
    const vault = new CredentialVault(path, encryption);
    await vault.set("one", "first");
    await vault.set("two", "second");
    const names = await readdir(path);
    const before = await Promise.all(names.map(name => readFile(join(path, name), "utf8")));
    vi.mocked(encryption.decryptString).mockImplementationOnce(() => "first").mockImplementationOnce(() => { throw new Error("locked"); });
    const persist = vi.fn(async () => undefined);
    await expect(vault.setLocalMode(true, persist)).rejects.toMatchObject({ code: "credential_decryption_failed" });
    expect(persist).not.toHaveBeenCalled();
    expect(await Promise.all(names.map(name => readFile(join(path, name), "utf8")))).toEqual(before);
  });

  it("serializes writes during migration and recovers the persisted mode after interruption", async () => {
    const path = await mkdtemp(join(tmpdir(), "credentials-concurrent-"));
    const encryption = codec();
    const vault = new CredentialVault(path, encryption);
    await vault.set("one", "original");
    await Promise.all([
      vault.setLocalMode(true, async () => undefined),
      vault.set("one", "latest"),
    ]);
    expect(await vault.get("one")).toBe("latest");
    // Simulate a restart with the old setting after files were migrated.
    const restarted = new CredentialVault(path, encryption);
    await restarted.setLocalMode(false, async () => undefined);
    expect(await restarted.get("one")).toBe("latest");
    for (const name of await readdir(path)) {
      expect(await readFile(join(path, name), "utf8")).not.toContain("local:");
    }
  });
});
