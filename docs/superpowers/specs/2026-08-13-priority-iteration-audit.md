# Priority Iteration Audit

**Date:** 2026-08-13
**Scope:** Engineering baseline, methodology boundaries, semantic recall,
package size, release readiness, dependency risk, and product feedback.

## Outcome

The priority program is implemented through the point that can be completed
without the product owner's Apple credentials, protected macOS runner, or real
labelled product corpus.

| Priority | Outcome | Verification |
| --- | --- | --- |
| P0 engineering baseline | Startup retry and stale-result protection, renderer recovery boundary, accessibility checks, and one daily quality command | Full typecheck and automated suite |
| P1 methodology boundaries | Narrow renderer APIs and pure relationship/merge models without changing persisted facts | Contract and model tests |
| P1 semantic recall | Conservative bilingual and mixed-turn routing with candidate review retained for ambiguity | 64-case deterministic gate: 100% high precision, 100% high+medium recall, 84.4% relationship extraction |
| P1 package size | DuckDB removed in favour of one-pass local aggregation over the existing SQLite snapshot | App bundle reduced from 463,988 KiB to 347,800 KiB; analytics and packaged smoke pass |
| P1 release readiness | Local and distribution modes, strict signing/notarization checks, ZIP checksum/manifest, manual-update boundary, and release runbook | Fresh local package and smoke pass; distribution verifier rejects an ad-hoc package |
| P1 dependency risk | Safe in-range build dependency updates and a zero-tolerance runtime audit in the formal release path | Runtime audit reports 0 vulnerabilities |
| P2 product feedback | Existing explicit anonymous consultation ratings remain the only quality signal; ambiguous review actions are not relabelled as accuracy | Feedback contract, bounded receipt, aggregate store, UI, and privacy tests already cover the loop |

## Dependency Risk Boundary

The release gate now fails on any known vulnerability in dependencies shipped
with the application. The 2026-08-13 runtime result is zero.

The full development-tree audit still reports 25 build-time findings: 1
critical, 21 high, and 3 low. They are inherited through Electron Forge,
Packager, Rebuild, and Inquirer. Six vulnerable leaves were upgraded within
their existing compatible ranges. The remaining paths are constrained mainly
by `tar@6`, `extract-zip@2.0.1`, and `tmp@0.0.33`; forcing unrelated major
versions with npm overrides would replace upstream compatibility decisions and
is not an acceptable release fix.

Until upstream-compatible releases exist, builds must run on protected,
single-purpose macOS runners, accept only trusted repository input and official
Electron artefacts, and publish only after the repository quality, smoke,
signing, notarization, and checksum gates pass.

## Product Feedback Boundary

The application already supports explicit `helpful`, `notHelpful`, and
`misleading` ratings through a short-lived in-memory receipt. Persistent data is
limited to aggregate counters and contains no query, decision text, principle
identifier, token, or per-event record.

Candidate `confirm` and `ignore` actions are not classifier labels. A user may
ignore a valid but unimportant decision, or confirm an ambiguous candidate only
after editing and adding rationale. Treating these actions as false/true labels
would produce selection-biased accuracy and silently expand behavioural
telemetry. They therefore remain workflow actions only.

Feedback can reveal obvious threshold problems but cannot activate semantic
automation. Activation still requires at least 500 independently labelled,
stratified, redacted real turns, with thresholds evaluated on an untouched
holdout.

## Remaining Ordered Work

1. **P0 external activation:** connect a protected macOS arm64 Gitee runner,
   inject the owner's Developer ID/notarization credentials, and retain the
   first successful distribution evidence.
2. **P1 product validation:** build the 500-turn privacy-safe labelled corpus
   and independent holdout; keep ambiguous cases in candidate review until it
   passes.
3. **P1 supply-chain maintenance:** upgrade Forge/Packager/Rebuild as soon as an
   upstream-compatible release removes the remaining audit paths, then rerun
   quality, packaging, smoke, and distribution checks.
4. **P2 updates:** choose an immutable HTTPS feed and rollback/retention policy
   before adding automatic update checks.
5. **P2 feedback expansion:** add a new explicit, revocable labelling contract
   only if product research needs candidate-level labels; never infer it from
   existing workflow actions.
