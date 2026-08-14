import {
  redactedModelProviderProfileSchema,
  type ModelProviderProfile,
  type RedactedModelProviderProfile,
} from "@cognelis/decision-protocol";

import type {
  ModelProviderMutationInput,
  ModelProviderTestResult,
} from "../../shared/renderer-api.js";
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
        "Local model providers do not accept API credentials",
      );
    }
    if (
      input.secret !== undefined &&
      input.secret.trim().length === 0
    ) {
      throw new ModelProviderError(
        "credential_unavailable",
        "Model provider credential cannot be empty",
      );
    }

    const credentialReference = remote
      ? existing?.credentialRef ??
        this.#credentialReferenceFactory()
      : undefined;
    if (
      remote &&
      input.secret === undefined &&
      (credentialReference === undefined ||
        !(await this.#credentials.has(
          credentialReference,
        )))
    ) {
      throw new ModelProviderError(
        "credential_unavailable",
        "A credential is required for this model provider",
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
      previousSecret = await this.#credentials.get(
        credentialReference,
      );
      await this.#credentials.set(
        credentialReference,
        input.secret,
      );
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
