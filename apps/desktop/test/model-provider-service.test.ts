import type {
  ModelProviderProfile,
} from "@cognelis/decision-protocol";
import { describe, expect, it, vi } from "vitest";

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
