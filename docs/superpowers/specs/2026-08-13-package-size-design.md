# Local Analytics Package-Size Design

## Status

Selected as the fourth sub-project in the prioritized Decision improvement
program. The engineering baseline, methodology-boundary, and deterministic
semantic-recall slices have passed their acceptance checks.

## Context

The current macOS arm64 application directory is approximately 472 MB. Its
largest application-owned native dependency is DuckDB:

- `libduckdb.dylib`: 117,005,056 bytes;
- packaged `@duckdb` directory: approximately 112 MiB;
- root `@duckdb/node-api` installation: approximately 114 MiB.

Decision analytics first materializes every indexed decision as an
`IndexedDecision[]`, then copies that same snapshot into a temporary in-memory
DuckDB table. Five queries calculate totals, verdict counts, project groups,
source groups, and monthly trends. The database is then closed and discarded.

This workload does not need joins, persistence, ad-hoc SQL, or columnar scans.
Every requested metric can be calculated in one bounded pass over the snapshot
that is already in memory. Keeping a second query engine therefore adds a
large installation and loading cost without providing a product capability.

## Goals

- Remove DuckDB and its native library from the packaged application.
- Preserve the complete analytics contract and visible metric semantics.
- Keep analytics local, read-only, deterministic, and derived from the
  rebuildable SQLite snapshot.
- Calculate all metrics in linear time with memory bounded by the number of
  projects, sources, verdicts, and months.
- Prove the real packaged-size reduction from a fresh application build.

## Non-goals

- Removing `node-llama-cpp`; it backs the optional local semantic model and is
  a separate product capability.
- Replacing SQLite or changing the decision index schema.
- Adding telemetry, a persistent analytics database, or remote analytics.
- Changing the analytics UI layout or introducing new metrics.
- Optimizing for datasets whose measured snapshot aggregation becomes slow;
  no such bottleneck has been observed.

## Options considered

### 1. Keep DuckDB and compress the final archive

ZIP compression reduces download size but not the installed application,
native loading surface, or dependency maintenance cost. It also preserves the
redundant snapshot import. This option is rejected.

### 2. Query SQLite directly

This removes DuckDB, but it would widen the storage interface with five new
analytics queries even though the caller already requests a full snapshot for
this operation. It is a reasonable future seam if snapshot materialization
becomes a measured bottleneck, but it adds unnecessary coupling now.

### 3. Aggregate the existing snapshot in process

Use one deterministic TypeScript reducer to calculate totals, verdicts,
project/source groups, and UTC monthly trends. This is the selected option. It
removes the native dependency, keeps the storage boundary unchanged, and makes
every aggregation rule directly testable.

## Aggregation contract

### Totals and rates

- A project key is `project.trim()` or `未命名项目` when blank.
- `rationaleCaptured` counts `rationaleStatus === "captured"`.
- `outcomesRecorded` counts a non-null `outcome`.
- `outcomesReviewed` counts a non-null `outcomeVerdict`.
- Percentages retain the current one-decimal rounding and zero-denominator
  behavior.

### Verdicts

Always return the five known verdicts in the existing order. Unknown runtime
values do not create new output categories.

### Project and source groups

For every group, preserve decision, rationale, outcome, reviewed, favorable,
attention, and latest-created metrics. Favorable means `better` or
`as_expected`; attention means `mixed` or `worse`.

Projects sort by decision count descending, latest-created descending, then
label ascending, and are limited to 12. Sources sort by decision count
descending, then label ascending, without a limit. String ordering uses a
stable binary comparison so results do not depend on the operating-system
locale.

### Trends

Only valid timestamps participate. Convert them to UTC `YYYY-MM`, select the
latest 12 periods, and return those periods in ascending order for display.

### Engine metadata

The snapshot reports `Local aggregation` version `1` with source
`SQLite snapshot`. The renderer translates these internal identifiers into
clear Chinese copy instead of exposing a removed database product name.

## Safety and performance boundaries

- The input array and its records are never mutated.
- No filesystem, network, SQL, or model call occurs in the aggregator.
- The public method remains asynchronous so IPC and renderer contracts do not
  need to change.
- Invalid dates are ignored only for trends; their decisions still contribute
  to all other metrics, matching the existing DuckDB query behavior.
- The package allowlist continues to retain only the native runtime required
  by active features and explicitly rejects a future accidental `@duckdb`
  inclusion.

## Testing strategy

Implementation follows red-green-refactor:

1. Change service tests to require local engine metadata and add edge cases for
   blank projects, ordering, the 12-project/month limits, invalid dates, and
   input immutability.
2. Change packaging tests to reject the DuckDB dependency, external import,
   and packaged namespace; verify those tests fail against the current code.
3. Replace the service with the smallest single-pass aggregation model.
4. Update the shared type, renderer copy, fixtures, docs, build configuration,
   and lockfile; remove `@duckdb/node-api`.
5. Run focused tests, type checking, and the full repository quality gate.
6. Build a fresh packaged application, inspect it for DuckDB artifacts, measure
   the application directory, and run the packaged smoke test.

## Acceptance criteria

- Analytics service tests prove the existing totals, rates, verdict, group,
  ordering, limiting, trend, invalid-date, empty-snapshot, and immutability
  behavior.
- No production import or package dependency on `@duckdb/node-api` remains.
- The fresh packaged application contains no DuckDB file or namespace.
- The application directory is at least 100 MB smaller than the measured
  472 MB baseline.
- Renderer copy truthfully describes local snapshot aggregation.
- `npm run check` passes.
- A fresh package build and packaged smoke test pass in the normal Electron
  environment.

## Follow-up

After this slice, the next priority is a release-readiness pass covering
signing, update strategy, release automation, and the quality pipeline. Further
analytics optimization should be driven by measured snapshot latency rather
than by adding a database pre-emptively.
