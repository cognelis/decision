import type {
  ModelProviderProfile,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

import { CredentialVaultError } from "../src/main/model/credential-vault.js";
import {
  ModelProviderService,
} from "../src/main/model/model-provider-service.js";
import type {
  ModelProviderMutationInput,
} from "../src/shared/renderer-api.js";

const remoteProfile = (
  overrides: Partial<ModelProviderProfile> = {},
): ModelProviderProfile => ({
  version: 1,
  profileId: "remote-openai",
  kind: "openai",
  label: "OpenAI",
  enabled: true,
  priority: 40,
  model: "gpt-5-mini",
  timeoutMs: 30_000,
  baseUrl: "https://api.openai.com",
  apiProtocol: "responses",
  credentialRef: "existing-reference",
  ...overrides,
});

const mutation = (
  secret?: string,
): ModelProviderMutationInput => ({
  profile: {
    version: 1,
    profileId: "remote-openai",
    kind: "openai",
    label: "OpenAI",
    enabled: true,
    priority: 40,
    model: "gpt-5-mini",
    timeoutMs: 30_000,
    baseUrl: "https://api.openai.com",
    apiProtocol: "responses",
    credentialConfigured: false,
  },
  ...(secret === undefined ? {} : { secret }),
});

const setup = (
  initialProfiles: ModelProviderProfile[] = [],
) => {
  let profiles = [...initialProfiles];
  const secrets = new Map<string, string>();
  for (const profile of profiles) {
    if (profile.credentialRef !== undefined) {
      secrets.set(profile.credentialRef, "stored-secret");
    }
  }
  const repository = {
    load: vi.fn(async () => [...profiles]),
    save: vi.fn(async (profile: ModelProviderProfile) => {
      profiles = [
        ...profiles.filter(
          (candidate) =>
            candidate.profileId !== profile.profileId,
        ),
        profile,
      ];
      return profile;
    }),
    delete: vi.fn(async (profileId: string) => {
      const before = profiles.length;
      profiles = profiles.filter(
        (profile) => profile.profileId !== profileId,
      );
      return profiles.length < before;
    }),
    reorder: vi.fn(async (profileIds: string[]) => {
      profiles = profileIds.map((profileId, index) => ({
        ...profiles.find(
          (profile) => profile.profileId === profileId,
        )!,
        priority: index * 10,
      }));
      return [...profiles];
    }),
  };
  const credentials = {
    get: vi.fn(async (reference: string) =>
      secrets.get(reference) ?? null,
    ),
    has: vi.fn(async (reference: string) =>
      secrets.has(reference),
    ),
    set: vi.fn(async (reference: string, secret: string) => {
      secrets.set(reference, secret);
    }),
    delete: vi.fn(async (reference: string) =>
      secrets.delete(reference),
    ),
  };
  const refresh = vi.fn();
  const service = new ModelProviderService({
    repository,
    credentials,
    refresh,
    credentialReferenceFactory: () => "generated-reference",
  });
  return {
    credentials,
    profiles: () => profiles,
    refresh,
    repository,
    secrets,
    service,
  };
};

describe("ModelProviderService", () => {
  it("lists redacted profiles without credential references or secrets", async () => {
    const { service } = setup([remoteProfile()]);

    const result = await service.list();

    expect(result).toEqual([
      {
        version: 1,
        profileId: "remote-openai",
        kind: "openai",
        label: "OpenAI",
        enabled: true,
        priority: 40,
        model: "gpt-5-mini",
        timeoutMs: 30_000,
        baseUrl: "https://api.openai.com",
        apiProtocol: "responses",
        credentialConfigured: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(
      "existing-reference",
    );
    expect(JSON.stringify(result)).not.toContain(
      "stored-secret",
    );
  });

  it("saves a new one-time secret and returns only a redacted profile", async () => {
    const { profiles, secrets, service, refresh } = setup();

    const result = await service.save(
      mutation("sk-one-time"),
    );

    expect(profiles()[0]).toMatchObject({
      profileId: "remote-openai",
      credentialRef: "generated-reference",
    });
    expect(secrets.get("generated-reference")).toBe(
      "sk-one-time",
    );
    expect(result).toMatchObject({
      profileId: "remote-openai",
      credentialConfigured: true,
    });
    expect(result).not.toHaveProperty("credentialRef");
    expect(JSON.stringify(result)).not.toContain("sk-one-time");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("says what to do when the keychain will not take a new key", async () => {
    const { credentials, profiles, service } = setup();
    // Refused at the keychain prompt: the dialog showed "Credential encryption failed".
    credentials.set.mockRejectedValueOnce(
      new CredentialVaultError("credential_unavailable", "Credential encryption failed"),
    );

    await expect(service.save(mutation("sk-one-time"))).rejects.toThrow(/本地密钥模式/u);
    expect(profiles()).toEqual([]);
  });

  it("keeps a configured credential when editing without a replacement secret", async () => {
    const existing = remoteProfile();
    const { credentials, profiles, service } = setup([existing]);
    const input = mutation();
    input.profile.label = "OpenAI edited";
    input.profile.credentialConfigured = true;

    await service.save(input);

    expect(credentials.set).not.toHaveBeenCalled();
    expect(profiles()[0]).toMatchObject({
      label: "OpenAI edited",
      credentialRef: "existing-reference",
    });
  });

  it("switches a backend whose key is gone from this Mac on or off, and asks for the key, in words, for any other change", async () => {
    const { profiles, secrets, service } = setup([remoteProfile()]);
    // Another Mac's keychain, or a reset entry: the switch itself was refused, in English.
    secrets.clear();
    const off = mutation();
    off.profile.enabled = false;
    await expect(service.save(off)).resolves.toMatchObject({ enabled: false, credentialConfigured: false });
    const noFallback = mutation();
    noFallback.profile.fallbackOnFailure = false;
    await expect(service.save(noFallback)).resolves.toMatchObject({ enabled: true, fallbackOnFailure: false });

    const renamed = mutation();
    renamed.profile.label = "OpenAI edited";
    await expect(service.save(renamed)).rejects.toThrow("本机没有这个后端的 API 密钥（可能换了电脑，或钥匙串里的条目被重置），请填写后再保存。");
    await expect(service.save(mutation("   "))).rejects.toThrow("API 密钥不能只有空格；不换密钥请留空。");
    expect(profiles()[0]).toMatchObject({ label: "OpenAI", credentialRef: "existing-reference" });
  });

  it("asks for the key again when the address moves to another site, and never sends the old one there", async () => {
    const { credentials, profiles, service } = setup([remoteProfile()]);
    // A preset or a relay's URL put in, the key left blank: every request went out with the old site's key.
    const moved = mutation();
    moved.profile.baseUrl = "https://api.deepseek.com";
    moved.profile.credentialConfigured = true;

    await expect(service.save(moved)).rejects.toThrow(/重新填写/u);
    expect(profiles()[0]).toMatchObject({ baseUrl: "https://api.openai.com", credentialRef: "existing-reference" });

    // With that site's own key it saves; another path on the same site keeps the key it has.
    await service.save({ ...moved, secret: "sk-deepseek" });
    expect(credentials.set).toHaveBeenCalledWith("existing-reference", "sk-deepseek");
    const samePlace = mutation();
    samePlace.profile.baseUrl = "https://api.deepseek.com/v1";
    samePlace.profile.credentialConfigured = true;
    await expect(service.save(samePlace)).resolves.toMatchObject({ baseUrl: "https://api.deepseek.com/v1" });
  });

  it("replaces a stored key that can no longer be read, rather than refusing to save", async () => {
    const existing = remoteProfile();
    const { credentials, secrets, service } = setup([existing]);
    // Another machine's keychain, or a reset entry: the old key is there but cannot be decrypted.
    credentials.get.mockRejectedValueOnce(
      new CredentialVaultError("credential_decryption_failed", "Credential decryption failed"),
    );
    const input = mutation("sk-new-key");
    input.profile.credentialConfigured = true;

    await expect(service.save(input)).resolves.toMatchObject({ credentialConfigured: true });
    expect(secrets.get("existing-reference")).toBe("sk-new-key");
  });

  it("takes the new key out again when a save that replaced an unreadable one fails", async () => {
    const existing = remoteProfile();
    const { credentials, repository, secrets, service } = setup([existing]);
    credentials.get.mockRejectedValueOnce(
      new CredentialVaultError("credential_decryption_failed", "Credential decryption failed"),
    );
    repository.save.mockRejectedValueOnce(new Error("profile write failed"));
    const input = mutation("sk-new-key");
    input.profile.credentialConfigured = true;

    await expect(service.save(input)).rejects.toThrow(/profile write failed/u);
    expect(secrets.has("existing-reference")).toBe(false);
  });

  it("rolls back a newly stored credential when profile persistence fails", async () => {
    const { credentials, repository, secrets, service } =
      setup();
    repository.save.mockRejectedValueOnce(
      new Error("profile write failed"),
    );

    await expect(
      service.save(mutation("sk-rollback")),
    ).rejects.toThrow(/profile write failed/u);

    expect(
      secrets.has("generated-reference"),
    ).toBe(false);
    expect(credentials.delete).toHaveBeenCalledWith(
      "generated-reference",
    );
  });

  it("deletes a remote profile and its credential together", async () => {
    const { credentials, service } = setup([
      remoteProfile(),
    ]);

    await expect(
      service.delete("remote-openai"),
    ).resolves.toBe(true);

    expect(credentials.delete).toHaveBeenCalledWith(
      "existing-reference",
    );
  });

  it("delegates exact reordering and refreshes future routing", async () => {
    const first = remoteProfile({
      profileId: "remote-first",
      credentialRef: "first-reference",
      priority: 40,
    });
    const second = remoteProfile({
      profileId: "remote-second",
      credentialRef: "second-reference",
      priority: 50,
    });
    const { refresh, repository, service } = setup([
      first,
      second,
    ]);

    await service.reorder([
      "remote-second",
      "remote-first",
    ]);

    expect(repository.reorder).toHaveBeenCalledWith([
      "remote-second",
      "remote-first",
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
