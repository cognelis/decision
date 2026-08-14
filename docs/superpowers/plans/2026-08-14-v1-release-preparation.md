# Decision v1.0.0 Release Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the complete current Decision worktree into an audited, portable,
verified, committed `v1.0.0` release candidate without publishing or tagging it.

**Architecture:** Treat `origin/main` plus the current uncommitted worktree as the
review surface. Keep credentials environment-derived, keep user and build paths
runtime-derived, align every workspace package at version `1.0.0`, and require
the existing quality, runtime-security, package-smoke, and release-artifact
gates before creating one release-preparation commit.

**Tech Stack:** Git, Node.js 22+, npm workspaces, TypeScript, Vitest, Electron
Forge, macOS codesign/notary tooling.

---

### Task 1: Freeze the release review surface

**Files:**
- Review: all files returned by `git status --short`
- Review: `docs/superpowers/specs/2026-08-13-priority-iteration-audit.md`
- Review: `docs/superpowers/specs/2026-08-13-release-readiness-design.md`

- [x] **Step 1: Resolve the fixed point and commit list**

Run:

```bash
git rev-parse origin/main
git log origin/main..HEAD --oneline
git diff --stat origin/main
```

Expected: `origin/main` resolves, the two engineering-baseline documentation
commits are listed, and the worktree diff is non-empty.

- [x] **Step 2: Verify the current branch is isolated from `main`**

Run:

```bash
git branch --show-current
git rev-parse --git-dir
git rev-parse --git-common-dir
```

Expected: branch `codex/engineering-baseline`; normal-repository `.git` paths.

### Task 2: Audit secrets and machine-specific paths

**Files:**
- Review: every tracked and untracked release-candidate source file
- Create: `scripts/test/release-portability.test.ts`
- Modify only if a finding is real: the file containing that finding

- [x] **Step 1: Add a failing repository portability test**

The test enumerates tracked and non-ignored candidate files and rejects private
key/token formats, credential-bearing filenames, the current user's private
home path, and user-machine paths in production source. It allows environment
variable names, documented placeholders, and synthetic `/Users/demo` test
fixtures.

Run:

```bash
npx vitest run scripts/test/release-portability.test.ts
```

Expected: FAIL on the current personal paths in preview data and historical
documents.

- [x] **Step 2: Scan candidate filenames for credential material**

Run:

```bash
git status --porcelain=v1
rg --files -g '!node_modules/**' -g '!out/**' -g '!dist/**' -g '!.git/**'
```

Expected: no `.env`, `.pem`, `.p8`, `.p12`, `.key`, keychain, credentials, or
private model file is part of the release candidate.

- [x] **Step 3: Scan content without printing possible secret values**

Run repository searches with `rg --files-with-matches` for private-key headers,
well-known provider token prefixes, credential-bearing URLs, passwords, signing
material, and high-risk literal assignments. Inspect each matching file at the
smallest useful line range and classify it as runtime environment lookup,
redacted documentation, synthetic test fixture, or a real credential.

Expected: zero real credentials. Any real credential must be removed and
rotated before continuing; environment variable names and obvious test values
are allowed.

- [x] **Step 4: Scan portability boundaries**

Search source, scripts, manifests, and current documentation for `/Users/`,
`/home/`, Windows user profiles, `file://`, the current repository path, the
current username, localhost ports, and absolute executable paths.

Expected: production paths come from `app.getPath`, the repository location,
the executable location, settings, or environment variables. Absolute paths
may remain only as explicit documentation examples, platform system locations,
or synthetic tests whose assertions prove they are not runtime defaults.

- [x] **Step 5: Remove real findings and verify GREEN**

Replace personal fixture paths with explicit `/Users/demo` examples, make
historical shell commands use `$HOME`, sanitize personal trace/design paths,
and rerun the portability test.

Expected: PASS with no real credential or private-machine path match.

- [x] **Step 6: Record the audit boundary**

Add the dated result and remaining external signing requirements to the release
documentation without embedding local paths, account identifiers, or secrets.

### Task 3: Align the v1.0.0 version contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `apps/bridge/package.json`
- Modify: `apps/desktop/package.json`
- Modify: `packages/core/package.json`
- Modify: `packages/integrations/package.json`
- Modify: `packages/protocol/package.json`
- Modify: `packages/storage/package.json`
- Modify: `apps/bridge/src/mcp-server.ts`
- Modify: `apps/bridge/test/mcp-server.test.ts`
- Modify: `docs/release.md`

- [x] **Step 1: Write the failing release-version assertions**

Update the MCP server test to require advertised version `1.0.0`, and add a
package-script test assertion that the root and every workspace package version
is `1.0.0` with exact internal dependency versions aligned to `1.0.0`.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npx vitest run apps/bridge/test/mcp-server.test.ts scripts/test/package-scripts.test.ts
```

Expected: failure because package manifests and the MCP server still advertise
`0.1.0`.

- [x] **Step 3: Apply the minimum version changes**

Set the root and six workspace package versions to `1.0.0`, set exact internal
workspace dependencies to `1.0.0`, update the MCP server version, synchronize
the lockfile without lifecycle scripts, and change current release examples
from `v0.1.0` to `v1.0.0`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx vitest run apps/bridge/test/mcp-server.test.ts scripts/test/package-scripts.test.ts scripts/test/release-artifact.test.ts
```

Expected: all focused tests pass.

### Task 4: Run the two-axis release review

**Files:**
- Review: `git diff origin/main`
- Standards: repository configuration plus the Fowler smell baseline
- Spec: the 2026-08-13 engineering, methodology, semantic, package-size,
  release-readiness, and priority-audit documents

- [x] **Step 1: Dispatch standards and spec reviews in parallel**

The standards review checks portability/security findings in addition to code
quality. The spec review checks missing requirements, scope creep, and incorrect
implementations against the release program documents.

- [x] **Step 2: Resolve every release-blocking finding**

Use test-first fixes for runtime behaviour. Documentation/configuration-only
corrections may be applied directly, then re-run their focused validation.

Resolved findings: the verifier now extracts and validates the sole App from
the actual ZIP, rejects update metadata and unsafe archive entries, verifies a
required tag against `HEAD`, rejects conflicting tag sources, uses the stable
`com.decisionisland.app` Bundle ID, and scans candidate text independently of
file extension with broader credential filename/token coverage. The apparent
methodology-slice scope conflict was not a release defect: that design governs
one behavior-preserving refactor, while the complete candidate is the broader
priority program recorded in the priority audit and covered by the full 941-test
gate.

### Task 5: Produce fresh v1.0.0 verification evidence

**Files:**
- Generated and ignored: `out/Decision-darwin-arm64/Decision.app`
- Generated and ignored: `out/make/zip/darwin/arm64/Decision-darwin-arm64-1.0.0.zip`
- Generated and ignored: `out/release/decision-darwin-arm64.json`

- [x] **Step 1: Run static and repository checks**

Run:

```bash
git diff --check
node --check scripts/release-artifact.mjs
npm run audit:runtime
```

Expected: no whitespace/syntax errors and zero runtime vulnerabilities.

- [x] **Step 2: Run the complete quality gate**

Run:

```bash
npm run quality
```

Expected: all tests pass and the strict semantic thresholds pass.

- [x] **Step 3: Rebuild and smoke the v1.0.0 package**

Run:

```bash
npm run make
npm run smoke
npm run release:verify
```

Expected: the packaged App passes isolated smoke; verifier emits a `1.0.0` ZIP,
SHA-256 file, and redacted JSON manifest.

- [x] **Step 4: Prove formal verification fails closed locally**

Run the distribution verifier with `DECISION_RELEASE=1` and tag
`v1.0.0` against the local ad-hoc package.

Expected: non-zero exit before publication because the exact `v1.0.0` tag does
not yet point to `HEAD`. After the release commit is explicitly tagged, the
same gate must also require Developer ID signing, Gatekeeper acceptance, and a
valid notarization staple.

Fresh evidence on 2026-08-14: runtime audit reported zero vulnerabilities; 113
test files and 941 tests passed; semantic high precision and high+medium recall
were both 100%; packaged smoke passed; the extracted ZIP App reported version
`1.0.0`, Bundle ID `com.decisionisland.app`, ad-hoc local signing, no prohibited
archive filenames, and SHA-256
`374c00b4b82dd4776b0cb6c122ba95e5d6d751caa94c479ae849101bd8f2ef2d`.

### Task 6: Commit the release candidate

**Files:**
- Stage: the complete audited release-candidate worktree

- [x] **Step 1: Review the exact staged set**

Run:

```bash
git add -A
git diff --cached --check
git diff --cached --stat
git status --short
```

Expected: source, tests, assets, documentation, manifests, and intentional
deletions are staged; ignored build output and credentials are absent.

- [x] **Step 2: Create the release-preparation commit**

Run:

```bash
git commit -m "feat: prepare Decision 1.0.0"
```

Expected: commit succeeds on `codex/engineering-baseline`.

- [x] **Step 3: Verify the committed state**

Run:

```bash
git status --short --branch
git show --stat --oneline --decorate HEAD
```

Expected: worktree clean and the new commit contains the complete audited
release candidate. Do not tag or push without a separate user instruction.
