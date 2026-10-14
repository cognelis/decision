import {
  redactedModelProviderProfileSchema,
  type ModelProviderProfile,
  type RedactedModelProviderProfile,
} from "@cognelis/decision-protocol";
import { isDeepStrictEqual } from "node:util";

import type {
  ModelProviderMutationInput,
  ModelProviderTestResult,
} from "../../shared/renderer-api.js";
import { CredentialVaultError } from "./credential-vault.js";
import { ModelProviderError } from "./http-model-transport.js";

interface ProviderProfileRepositoryLike {
  load(): Promise<ModelProviderProfile[]>;
  save(
    profile: ModelProviderProfile,
  ): Promise<ModelProviderProfile>;
  delete(profileId: string): Promise<boolean>;
  reorder(
    profileIds: string[],
  ): Promise<ModelProviderProfile[]>;
}

interface CredentialVaultLike {
  get(reference: string): Promise<string | null>;
  has(reference: string): Promise<boolean>;
  set(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<boolean>;
}

export interface ModelProviderServiceOptions {
  repository: ProviderProfileRepositoryLike;
  credentials: CredentialVaultLike;
  refresh(): void;
  credentialReferenceFactory(): string;
  testProfile?(
    profileId: string,
  ): Promise<ModelProviderTestResult>;
}

const remoteKinds = new Set<ModelProviderProfile["kind"]>([
  "openai",
  "anthropic",
  "openai-compatible",
]);

const SWITCHES = new Set(["enabled", "fallbackOnFailure", "credentialRef", "credentialConfigured"]);

/** A profile's settings, without its switches or its key's reference, in one order. */
const settingsOf = (profile: object): Array<[string, unknown]> =>
  Object.entries(profile)
    .filter(([key, value]) => !SWITCHES.has(key) && value !== undefined)
    .sort(([first], [second]) => first.localeCompare(second));

export class ModelProviderService {
  readonly #repository: ProviderProfileRepositoryLike;
  readonly #credentials: CredentialVaultLike;
  readonly #refresh: () => void;
  readonly #credentialReferenceFactory: () => string;
  readonly #testProfile:
    | ((
        profileId: string,
      ) => Promise<ModelProviderTestResult>)
    | undefined;

  constructor(options: ModelProviderServiceOptions) {
    this.#repository = options.repository;
    this.#credentials = options.credentials;
    this.#refresh = options.refresh;
    this.#credentialReferenceFactory =
      options.credentialReferenceFactory;
    this.#testProfile = options.testProfile;
  }

  async list(): Promise<RedactedModelProviderProfile[]> {
    return Promise.all(
      (await this.#repository.load()).map((profile) =>
        this.#redact(profile),
      ),
    );
  }

  async save(
    input: ModelProviderMutationInput,
  ): Promise<RedactedModelProviderProfile> {
    const redacted = redactedModelProviderProfileSchema.parse(
      input.profile,
    );
    const profiles = await this.#repository.load();
    const existing = profiles.find(
      (profile) =>
        profile.profileId === redacted.profileId,
    );
    const remote = remoteKinds.has(redacted.kind);
    if (!remote && input.secret !== undefined) {
      throw new ModelProviderError(
        "invalid_configuration",
        "本机运行的模型后端不需要 API 密钥。",
      );
    }
    if (
      input.secret !== undefined &&
      input.secret.trim().length === 0
    ) {
      throw new ModelProviderError(
        "credential_unavailable",
        "API 密钥不能只有空格；不换密钥请留空。",
      );
    }

    // A key given for one service goes to no other: moved to another address (a preset, a relay's URL) with
    // the key left blank, every request carried the old service's key to the new host.
    const origin = (url: string | undefined): string | null => (url === undefined ? null : new URL(url).origin);
    if (
      remote &&
      input.secret === undefined &&
      existing?.credentialRef !== undefined &&
      origin(existing.baseUrl) !== origin(redacted.baseUrl)
    ) {
      throw new ModelProviderError(
        "credential_unavailable",
        "服务地址换到了另一个站点，请重新填写这个站点的 API 密钥；原来的密钥不会发往新地址。",
      );
    }

    const credentialReference = remote
      ? existing?.credentialRef ??
        this.#credentialReferenceFactory()
      : undefined;
    // Switched on or off, or to fail over or not, and nothing else: with its key gone from this Mac (another
    // Mac's keychain, a reset entry) a backend could not even be switched off.
    const switchedOnly =
      existing !== undefined &&
      isDeepStrictEqual(settingsOf(existing), settingsOf(redacted));
    if (
      remote &&
      !switchedOnly &&
      input.secret === undefined &&
      (credentialReference === undefined ||
        !(await this.#credentials.has(
          credentialReference,
        )))
    ) {
      throw new ModelProviderError(
        "credential_unavailable",
        "本机没有这个后端的 API 密钥（可能换了电脑，或钥匙串里的条目被重置），请填写后再保存。",
      );
    }

    const {
      credentialConfigured: _credentialConfigured,
      ...profileFields
    } = redacted;
    const profile: ModelProviderProfile = {
      ...profileFields,
      ...(credentialReference === undefined
        ? {}
        : { credentialRef: credentialReference }),
    };

    let previousSecret: string | null | undefined;
    let storedReplacement = false;
    if (
      credentialReference !== undefined &&
      input.secret !== undefined
    ) {
      // Kept to put back if the save fails. A key that can no longer be read (another machine's
      // keychain, a reset entry) could not be put back either, and must not stand in the way of
      // the key that replaces it: it counts as none, so a failed save takes the new key out again.
      previousSecret = await this.#credentials
        .get(credentialReference)
        .catch((error: unknown) => {
          if (error instanceof CredentialVaultError && error.code === "credential_decryption_failed") {
            return null;
          }
          throw error;
        });
      await this.#credentials.set(
        credentialReference,
        input.secret,
      ).catch((error: unknown) => {
        // Refused at the keychain prompt, or no system encryption at all: said in English, with no way on.
        if (error instanceof CredentialVaultError && error.code === "credential_unavailable") {
          throw new Error("没能把密钥存进系统钥匙串（可能在提示时拒绝了授权，或系统加密不可用）。可以重试并在提示时允许，或在设置里开启“本地密钥模式”后再添加。");
        }
        throw error;
      });
      storedReplacement = true;
    }
    try {
      const saved = await this.#repository.save(profile);
      this.#refresh();
      return this.#redact(saved);
    } catch (error) {
      if (
        storedReplacement &&
        credentialReference !== undefined
      ) {
        if (previousSecret === null) {
          await this.#credentials
            .delete(credentialReference)
            .catch(() => undefined);
        } else if (previousSecret !== undefined) {
          await this.#credentials
            .set(credentialReference, previousSecret)
            .catch(() => undefined);
        }
      }
      throw error;
    }
  }

  async delete(profileId: string): Promise<boolean> {
    const profile = (await this.#repository.load()).find(
      (candidate) => candidate.profileId === profileId,
    );
    if (profile === undefined) {
      return false;
    }
    const deleted = await this.#repository.delete(profileId);
    if (!deleted) {
      return false;
    }
    if (profile.credentialRef !== undefined) {
      await this.#credentials.delete(profile.credentialRef);
    }
    this.#refresh();
    return true;
  }

  async reorder(profileIds: string[]): Promise<void> {
    await this.#repository.reorder(profileIds);
    this.#refresh();
  }

  async test(
    profileId: string,
  ): Promise<ModelProviderTestResult> {
    if (this.#testProfile === undefined) {
      throw new ModelProviderError(
        "invalid_configuration",
        "Model provider testing is unavailable",
      );
    }
    return this.#testProfile(profileId);
  }

  async #redact(
    profile: ModelProviderProfile,
  ): Promise<RedactedModelProviderProfile> {
    const {
      credentialRef,
      ...visible
    } = profile;
    return redactedModelProviderProfileSchema.parse({
      ...visible,
      credentialConfigured:
        credentialRef === undefined
          ? false
          : await this.#credentials.has(credentialRef),
    });
  }
}
