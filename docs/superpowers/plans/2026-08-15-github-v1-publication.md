# GitHub v1.0.0 Publication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the verified Cognelis / Decision source as a public MIT-licensed GitHub v1.0.0 release without exposing old history or an unsigned binary.

**Architecture:** Create Cognelis and its empty Decision repository through the user's authenticated browser, construct a clean parentless public commit from the verified source tree in a separate worktree/branch, push it as `main`, then create a source-only `v1.0.0` release. Keep the existing Gitee history and remote unchanged.

**Tech Stack:** Git, GitHub web UI, authenticated browser session, MIT License, existing release/portability verification scripts.

---

### Task 1: Reconfirm the public source boundary

**Files:**
- Read: `docs/superpowers/specs/2026-08-15-cognelis-migration-and-github-publication-design.md`
- Read: `LICENSE`, `README.md`, `package.json`

- [ ] **Step 1: Verify the migration commit is the only unpublished source state**

Run: `git status --short`
Expected: no output.

Run: `npm run quality`
Expected: PASS.

Run: `npx vitest run scripts/test/release-portability.test.ts`
Expected: PASS.

- [ ] **Step 2: Record the exact source tree**

Run: `git rev-parse HEAD`
Expected: a 40-character commit ID for the verified migration commit.

Run: `git ls-files -z | shasum -a 256`
Expected: a stable checksum recorded in release notes for the local source listing.

### Task 2: Create the Cognelis organization and empty public repository

**External state:** GitHub organization and repository.

- [ ] **Step 1: Recheck exact-name availability in the browser**

Open `https://github.com/cognelis`; expected before creation: GitHub not-found page. If it is no longer available, stop because choosing a materially different organization name is a core brand decision.

- [ ] **Step 2: Create the free organization**

Use the authenticated account as initial owner, organization name `cognelis`, free plan, and no additional member invitations until usernames are supplied. Do not create teams or grant organization admin access.

- [ ] **Step 3: Create `cognelis/decision` as public and empty**

Description:

```text
Local-first macOS platform for capturing, reviewing, and evolving decision rationale.
```

Do not initialize README, `.gitignore`, License, tag, Release, Discussions, or templates in the web form.

### Task 3: Build a clean public root commit

**Files:**
- Create local branch/worktree: `github-main`
- Preserve: current branch, `origin`, and existing Gitee refs

- [ ] **Step 1: Create an isolated orphan public branch**

Use a temporary worktree or index so the active migration branch is not rewritten. Populate it from the exact verified tree, remove `.git`-local state and ignored build output, and create one parentless commit with the GitHub no-reply address for the authenticated account.

Verification:

```bash
git rev-list --parents -n 1 github-main
```

Expected: one commit ID and no parent IDs.

- [ ] **Step 2: Verify the clean public tree independently**

Run the portability and metadata tests from the clean branch, then compare:

```bash
git diff --stat <migration-commit> github-main
```

Expected: no source-tree differences; only Git parent/author metadata differs.

### Task 4: Push main, tag v1.0.0, and create source Release

**External state:** GitHub refs and Release.

- [ ] **Step 1: Add a distinct GitHub remote**

Add `github` pointing to the new `cognelis/decision` repository. Confirm `origin` still points to the existing Gitee repository.

- [ ] **Step 2: Push the clean branch as GitHub main**

Push `github-main:main`, then confirm in the browser that the repository is public, `main` is default, the README renders, and GitHub detects MIT License.

- [ ] **Step 3: Create and push the exact source tag**

Create annotated tag `v1.0.0` on `github-main` and push only that tag to `github`. Confirm the tag and `main` resolve to the same commit.

- [ ] **Step 4: Create a source-only GitHub Release**

Title: `Decision v1.0.0`.

Release notes state that this is the initial MIT-licensed source release, requires macOS Apple Silicon and Node.js 22.13+, documents `npm ci --ignore-scripts` plus `npm run make`, and explicitly says no prebuilt binary is attached because public macOS binaries require Developer ID signing and notarization.

Do not upload `out/` ZIP, `.sha256`, JSON manifests, keys, certificates, or local screenshots.

### Task 5: Post-publication verification

**External state:** GitHub organization, repository, tag, and Release.

- [ ] **Step 1: Verify access and metadata in a logged-out/public view**

Confirm organization, repository, source files, license, tag, and Release are publicly readable. Confirm no organization member or private email is exposed by the root commit.

- [ ] **Step 2: Verify local repository safety**

Run: `git remote -v`
Expected: unchanged Gitee `origin` and distinct GitHub `github`.

Run: `git status --short`
Expected: no output.

Run: `git log --oneline --decorate -3`
Expected: the original migration branch/history remains present; no reset or destructive rewrite occurred.

- [ ] **Step 3: Defer member grants until identities are known**

Record that repository-level `Write` or `Maintain` invitations remain pending GitHub usernames. Public read access already works for the group and the wider community.
