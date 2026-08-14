# Engineering Baseline and Startup Recovery Design

## Status

Approved for implementation as the first sub-project in the prioritized
Decision improvement program.

## Context

Decision currently has a strong automated test baseline, but the renderer
bootstrap has one unrecoverable state: if the initial `getSnapshot()` call
rejects, the application remains on the loading surface indefinitely. A render
exception can also replace the entire desktop surface with a blank window.

At the same time, the repository exposes separate verification commands but no
single local quality-gate command. Semantic evaluation is intentionally not yet
eligible for that gate: its current deterministic corpus misses the documented
recall threshold, and improving that classifier is a later, independently
measurable sub-project.

This design establishes a reliable engineering baseline before module
decomposition and classifier tuning. It does not change decision capture,
routing, persistence, or methodology behavior.

## Goals

- Replace the indefinite initial-loading state with an actionable error state.
- Allow the initial snapshot request to be retried without reloading the app.
- Isolate unexpected renderer exceptions behind a recoverable fallback surface.
- Provide one deterministic local command for the checks that are currently
  expected to pass on every change.
- Preserve all existing application behavior and test coverage.

## Non-goals

- Changing semantic recognition rules or thresholds.
- Adding hosted CI, Developer ID signing, notarization, or automatic updates.
- Refactoring `MethodologyPanel` or the renderer IPC interface.
- Introducing a new state-management or data-fetching dependency.
- Treating the current semantic report as a passing release gate.

## Chosen approach

Implement a small bootstrap hook and a top-level React error boundary, then add
explicit quality-gate scripts to the root package.

The alternatives were rejected as follows:

- Scripts only would leave the user-visible startup and render failure modes
  unchanged.
- A full release pipeline would mix local reliability work with certificate,
  distribution, and external-service concerns.
- A new application-wide state library would add a large interface for one
  focused lifecycle problem.

## Renderer architecture

### Bootstrap module

A focused `useAppSnapshot` hook owns the initial snapshot lifecycle and the
existing snapshot subscription. Its interface is intentionally small:

```ts
interface AppSnapshotState {
  snapshot: AppSnapshot | null;
  loading: boolean;
  error: string | null;
  retry(): void;
}
```

The hook subscribes immediately so a pushed snapshot can recover the UI even
if the initial request failed. Every initial or retried request receives a
monotonic request identifier. A late response from an older request cannot
replace a newer result. Unmounting prevents all subsequent state updates.

A successful request or pushed snapshot clears the bootstrap error. A failed
request preserves any already-rendered snapshot; the full startup error surface
is therefore used only when no snapshot has ever been obtained.

### Startup failure surface

When no snapshot is available and the latest request failed, `App` renders a
compact status surface containing:

- a stable accessible error role;
- a non-sensitive explanation that application state could not be loaded;
- a retry button disabled while a retry is in progress.

Raw exception details are not displayed because IPC failures may contain local
paths or implementation information. Retrying calls the same bootstrap module;
it does not reload Electron or recreate the window.

### Render error boundary

An `AppErrorBoundary` wraps `App` at the renderer entry point. It catches
unexpected render and lifecycle exceptions below the entry point and replaces
the failed tree with a compact fallback containing a reload action.

Reload is appropriate here because React error boundaries cannot safely reset
unknown state throughout the failed tree. The fallback does not display raw
exception text. Errors remain visible to the renderer console for local
diagnosis.

The boundary does not attempt to catch event-handler or IPC promise failures;
those remain the responsibility of the operation that initiated them.

## Quality gates

The root package adds the following scripts:

- `check`: runs type checking followed by the complete automated test suite.
- `check:semantic`: runs semantic evaluation in strict mode and therefore
  remains an explicit, currently failing readiness signal until classifier work
  reaches the documented thresholds.
- `report:semantic`: produces the non-blocking semantic baseline report.

`build`, `make`, and smoke verification remain separate because they are slower,
platform-specific release checks. A later release-engineering sub-project may
compose them into hosted CI after signing and distribution requirements are
defined.

## Error handling and privacy

- Initial snapshot rejection becomes a bounded UI state rather than an
  unhandled promise rejection.
- Retry failures remain retryable and never duplicate snapshot subscriptions.
- Stale async responses are ignored.
- User-facing fallbacks contain fixed copy, not exception messages.
- Existing sandbox, context isolation, navigation denial, and IPC validation
  remain unchanged.

## Testing strategy

Implementation follows red-green-refactor:

1. Add hook-level behavior tests for initial success, rejection, retry recovery,
   pushed-snapshot recovery, stale response ordering, and unmount cleanup.
2. Add `App` behavior coverage proving an initial rejection presents a retry
   action instead of an indefinite loader.
3. Add error-boundary coverage proving a child render failure produces the
   fixed fallback and invokes reload only after explicit user action.
4. Add package-script assertions so the quality-gate names and semantics remain
   stable.
5. Run the focused tests, root type check, root `check`, and non-blocking
   semantic report.

Tests exercise public behavior at each module interface. They do not assert on
hook internals or implementation-specific state transitions.

## Acceptance criteria

- A rejected initial `getSnapshot()` call displays a fixed, accessible failure
  message and an enabled retry action.
- Retrying can transition the same mounted application to its normal desktop
  surface.
- A snapshot event can recover the same application after initial failure.
- Older async results cannot overwrite a newer snapshot.
- An unexpected child render exception displays the application recovery
  surface without exposing exception content.
- `npm run check` exits successfully when type checking and all automated tests
  pass.
- `npm run report:semantic` reports the current corpus without failing solely
  because the activation threshold has not yet been reached.
- `npm run check:semantic` remains strict and returns non-zero until the
  documented semantic thresholds are met.

## Follow-up sequence

After this sub-project is verified, implementation proceeds in the previously
established priority order:

1. Decompose the methodology workbench and narrow renderer interfaces.
2. Improve semantic recall using stratified, privacy-safe evaluation data.
3. Re-evaluate DuckDB packaging cost against direct SQLite aggregation.
4. Add the signed, notarized, update-capable macOS release pipeline.
5. Continue product feedback-loop and additional-client work.
