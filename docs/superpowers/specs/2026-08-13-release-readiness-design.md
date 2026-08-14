# Signed Release Boundary and Update Contract Design

## Status

Selected as the fifth sub-project in the prioritized Decision improvement
program. The package-size slice produced a fresh 367,300 KiB macOS arm64
artifact and passed its packaged smoke test.

## Context

The project can build and ZIP an Apple Silicon application, but the current
Forge configuration always applies an ad-hoc signature with hardened runtime
disabled and timestamping disabled. That is useful for local smoke tests, but
it is not a distributable macOS release. The repository also lacks:

- a fail-closed distinction between local and public packaging;
- notarization configuration;
- a single CI quality command that includes the semantic regression gate;
- version/tag validation;
- a machine-readable artifact checksum and update manifest;
- an explicit update policy.

macOS public distribution requires both code signing and notarization. Forge
performs both during packaging and supports either App Store Connect API-key or
keychain-profile authentication. Automatic updates additionally require a
signed application and a stable update server/feed. The current Gitee project
has neither committed Apple credentials nor an approved HTTPS update origin.

## Goals

- Keep local builds and smoke tests frictionless with an explicit ad-hoc mode.
- Make distribution mode fail closed unless a Developer ID identity and one
  complete notarization credential strategy are present.
- Enable Forge hardened-runtime signing and Apple notarization without storing
  secrets in the repository.
- Add one provider-neutral quality command for pull-request and branch CI.
- Verify the built App and ZIP, enforce package version/tag consistency, reject
  forbidden bundled content, and emit SHA-256 release metadata.
- Define a stable versioned manifest that can become the input to a later
  signed automatic-update feed.
- Document the exact Gitee/macOS runner boundary and release checklist.

## Non-goals

- Publishing an artifact or changing a Gitee Release without explicit user
  authorization.
- Creating, importing, or rotating Apple certificates and API keys.
- Enabling an automatic updater before a production Developer ID build and a
  stable HTTPS feed exist.
- Adding Windows, Intel macOS, Mac App Store, or cross-platform installers.
- Replacing Electron Forge.

## Options considered

### 1. Keep ad-hoc ZIP releases

This preserves the existing development workflow, but users must bypass macOS
security checks and cannot safely use automatic updates. It is rejected for
public distribution.

### 2. Always require Apple credentials

This makes every build release-like, but breaks ordinary development, offline
tests, and contributors without access to signing material. It also increases
the chance that secrets are copied into local configuration. It is rejected.

### 3. Explicit local and distribution modes

Local mode keeps the current ad-hoc signature. Setting
`DECISION_RELEASE=1` selects distribution mode, which validates a
Developer ID identity and either a notarization keychain profile or a complete
App Store Connect API-key triple before Forge starts.

This is the selected approach. The unsafe state is explicit and local-only;
the public state is fail-closed and uses Forge's supported signing boundary.

## Signing and notarization contract

### Local mode

- Ad-hoc identity `-`.
- Identity validation disabled.
- Hardened runtime disabled and timestamping set to `none`.
- Suitable only for development and packaged smoke tests.

### Distribution mode

- `DECISION_SIGNING_IDENTITY` is mandatory and must not be `-`.
- Hardened runtime is enabled; timestamp behavior uses the signing tool's
  distribution default.
- Notarization uses exactly one of:
  - `DECISION_NOTARY_KEYCHAIN_PROFILE`, with an optional keychain path;
  - `DECISION_APPLE_API_KEY`, `..._ID`, and `..._ISSUER` together.
- Partial or mixed credential configuration fails before packaging.
- Secrets remain environment variables or keychain entries and are never
  printed into release metadata.

## Quality and artifact contract

`npm run quality` runs the normal type/test gate followed by the strict
semantic-recognition gate. It is the provider-neutral command for Gitee Go,
Jenkins, or another runner.

The release artifact verifier checks:

- root SemVer and an optional/required `v<version>` release tag;
- App `CFBundleShortVersionString` and `CFBundleVersion`;
- strict code-signature validity;
- Developer ID authority, Gatekeeper assessment, and notarization staple in
  distribution mode;
- ZIP integrity and the Forge artifact filename;
- absence of DuckDB, `.gguf` weights, and unexpected update metadata inside
  the App;
- artifact byte size and SHA-256.

It writes a checksum file and a versioned JSON manifest under `out/release/`.
The manifest contains no credentials or local absolute paths.

## Update strategy

Version 0.1 uses explicit manual updates only. Each release publishes the
notarized ZIP plus its checksum and JSON manifest. This gives users and future
automation a verifiable immutable artifact without adding background network
traffic to a local-first app.

Automatic update installation remains disabled until all of these are true:

1. a Developer ID signed and notarized production release has passed the
   distribution verifier;
2. a stable HTTPS origin and retention policy are approved;
3. the feed serves immutable ZIPs and a platform-compatible signed update
   response;
4. rollback, failed-download behavior, user notification, and privacy copy
   have integration coverage.

The JSON schema introduced here is intentionally small and versioned. It can
be used to build that feed later, but the application does not contact it in
this slice.

## CI boundary

The canonical repository is hosted on Gitee. Gitee Go stores its YAML under
`.workflow/`, but public distribution requires a macOS arm64 host with the
signing certificate and notarization credentials installed. The repository
therefore supplies provider-neutral commands and a documented stage mapping:

- ordinary PR/branch runner: install dependencies, then `npm run quality`;
- trusted macOS release runner: run the same quality gate, distribution make,
  packaged smoke, and distribution artifact verification;
- publish/upload remains a separate protected action after verification.

No provider-specific workflow is committed until the actual runner type and
secret names are configured in the Gitee project, avoiding a pipeline that
looks active but cannot build macOS artifacts.

## Testing strategy

Implementation follows red-green-refactor:

1. Add Forge tests for local mode, missing distribution inputs, keychain
   notarization, and API-key notarization.
2. Add pure artifact-contract tests for version/tag validation, filename,
   checksum document, and redacted manifest output.
3. Update package-script tests to require the unified quality and explicit
   release commands; verify RED.
4. Implement the smallest configuration and release artifact modules.
5. Run focused tests and the full quality gate.
6. Run a local `make`, packaged smoke, and local artifact verification; inspect
   the emitted metadata.
7. Exercise distribution validation without secrets and prove it fails before
   packaging. Actual notarization remains an external credential-dependent
   acceptance item.

## Acceptance criteria

- Local packaging retains its tested ad-hoc behavior.
- Distribution mode cannot resolve Forge configuration with missing, partial,
  mixed, or ad-hoc signing credentials.
- Both keychain-profile and API-key notarization configurations are covered.
- `npm run quality` passes.
- A fresh local ZIP passes integrity, version, content, and ad-hoc signature
  checks and produces deterministic checksum/manifest fields.
- Distribution verification rejects the local ad-hoc artifact.
- README and release documentation no longer describe the project as lacking a
  release path; they clearly distinguish local builds from public releases and
  state why automatic updates remain off.
- No credential, private key, password, absolute local path, or user data is
  written to tracked files or release metadata.

## Follow-up

Once the Apple credentials and trusted macOS runner are available, run the
distribution path and record the notarization evidence. Only after a stable
HTTPS feed is selected should the next update slice add in-app checking and
installation. The final priority in the current program is the product-feedback
and operational audit.
