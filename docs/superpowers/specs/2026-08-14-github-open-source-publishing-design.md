# GitHub Open-Source Publishing Design

**Date:** 2026-08-14
**Status:** Superseded by
`2026-08-15-cognelis-migration-and-github-publication-design.md`

This document records the earlier publication direction and is not the active
specification. The Cognelis migration specification replaces its organization,
repository, licensing attribution, compatibility, tag, and release decisions.

## Goal

Publish the current Decision 1.0.0 source as a public GitHub project that can
be maintained by a small internal group without exposing obsolete private path
strings, a corporate author email, credentials, or an unsigned binary release.

## Organization and repository

Create the free GitHub organization `decision-island`. The name currently
returns GitHub's not-found page and is therefore the preferred candidate; the
creation form remains the final authority on availability. If GitHub rejects
the name, use `decision-island-labs` rather than an unrelated existing
organization.

Create the public repository `decision-island/decision-island` with:

- description: `Local-first macOS decision platform for capturing, reviewing, and evolving decision rationale.`
- default branch: `main`;
- MIT license from the source tree;
- no generated README, `.gitignore`, license, release, tag, or binary from the
  GitHub creation flow.

The organization is preferable to the maintainer's personal account because
the project is intended for a group. The authenticated `dnvyrn` account remains
the initial organization owner. Additional members receive repository-scoped
`Write` or `Maintain` access after their GitHub usernames are supplied; no
organization-wide administrative access is granted by default.

## Public source boundary

Publish a clean initial Git history containing the current audited source tree
and the MIT licensing metadata. Do not push the existing Gitee history because
old commits retain obsolete maintainer paths and a corporate author email. The
Gitee repository and its history remain untouched.

The public initial commit uses a GitHub no-reply author address and contains no
tags. A separate local `github-main` branch tracks GitHub `main`; the existing
`codex/engineering-baseline`, local `main`, and Gitee `origin` references are
preserved. Add the GitHub repository as a distinct `github` remote.

## Licensing and project metadata

Add the standard MIT License with copyright attributed to `Decision Island
contributors`. Add `"license": "MIT"` to the root package and lock metadata,
and add a short license section to the README. Workspace packages remain
private implementation units and inherit the repository license.

## Release boundary

This publication exposes source code only. Do not create `v1.0.0`, a GitHub
Release, or upload the local ZIP. The current ZIP is ad-hoc signed and is not a
public distribution artifact. A later release requires an exact tag on the
public commit plus Developer ID signing, Gatekeeper assessment, and Apple
notarization.

## Verification and failure handling

Before publication:

1. verify the working tree has no unstaged user changes;
2. run the portability/secret guard, package metadata tests, and whitespace
   checks;
3. verify the clean public tree contains no credential filenames or generated
   artifacts;
4. verify the clean root commit has no parent and uses a no-reply author.

After publication, confirm the repository is public, `main` is the default
branch, GitHub detects the MIT license, the source commit is present, and the
local `github` remote points to the created repository. If organization or
repository creation reports a collision, stop before choosing a materially
different owner or name. If SSH authentication fails, leave the empty public
repository in place and request the user's authentication action rather than
uploading through an unsafe workaround.
