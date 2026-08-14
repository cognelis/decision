# Methodology Workspace Boundaries Design

## Status

Selected as the second sub-project in the prioritized Decision improvement
program, after the engineering baseline and startup recovery work passed its
acceptance checks.

## Context

The methodology workspace has accumulated several complete product flows in a
single renderer component. `MethodologyPanel.tsx` is more than 7,000 lines and
currently owns record browsing, manual creation, evidence selection,
suggestions, validation, revision history, evolution drafts, relation review,
merge lifecycle, analytics, graph navigation, and practice-asset navigation.

The file size is a symptom rather than the primary problem. Two boundaries are
currently shallow:

- methodology children accept the complete `DecisionApi`, even when a
  child uses only a handful of its roughly 79 methods;
- pairwise-relation and merge rules are private helpers inside the React
  component, so business behavior can only be exercised indirectly through a
  large application fixture.

This sub-project establishes enforceable seams without changing IPC channels,
preload behavior, persistence, or the visible workflow.

## Goals

- Make the renderer dependencies of methodology records, analytics, and
  practice assets explicit and capability-based.
- Move relation and merge policy into small pure modules with direct tests.
- Reduce the amount of business reasoning owned by `MethodologyPanel`.
- Preserve every current user interaction and IPC call.
- Create a safe seam for later extraction of complete vertical flows.

## Non-goals

- A big-bang rewrite of `MethodologyPanel`.
- Moving JSX into presentational files solely to reduce line count.
- Renaming IPC channels or changing the runtime `window.decision`
  object.
- Introducing a state library, dependency-injection framework, or new package.
- Redesigning methodology, analytics, graph, or practice-asset screens.

## Options considered

### 1. Mechanical component splitting

Move large JSX sections into child files while continuing to pass the complete
API and large bags of state/callbacks.

This lowers the headline line count but leaves policy and dependency boundaries
unchanged. It is therefore not the first move.

### 2. Capability seams plus pure domain models

Define narrow renderer capability types and extract the existing relation and
merge rules into cohesive pure modules. Keep orchestration and UI in the
current component for this slice.

This is the selected approach. It creates compile-time dependency boundaries,
supports focused tests, and is behavior-preserving and reversible.

### 3. Full methodology workspace rewrite

Replace the component with a new store and independently mounted feature
modules in one migration.

This could produce the cleanest end state, but it combines many state machines
and recovery paths in one high-risk change. The existing behavior is valuable
and already well covered, so an incremental migration is safer.

## Renderer capability boundaries

`DecisionApi` remains the complete preload contract. The shared renderer
API module additionally exports canonical method-name lists and structural
capability types derived from those lists:

- `MethodologyRecordsApi`: methodology records, drafts, suggestions,
  validation, evidence, relations, merge lifecycle, graph loading, and
  navigation needed by the records workbench;
- `DecisionAnalyticsApi`: analytics snapshots, consultation metrics, preview,
  and explicit feedback submission;
- `PracticeAssetsApi`: practice-asset records, drafts, versions, publication,
  and source-principle listing;
- `MethodologyWorkspaceApi`: the intersection accepted by the workspace shell.

Each child receives only its capability. The runtime object is still the same
preload API, so no adapter, IPC, or serialization layer changes. Adding an
unrelated renderer method can no longer silently become a dependency of a
methodology child without widening its declared capability.

## Pure relation model

Create `methodology-relation-model.ts` for policy that answers questions about
relationships among methodology records:

- normalize an unordered pair into a stable key;
- choose the explicit relationship between two records, including precedence
  when mirrored facts disagree;
- decide whether every source pair is a confirmed duplicate;
- build and order the unresolved relation-review queue;
- count unresolved pairs without double counting;
- assess whether another principle is eligible to join an in-progress merge;
- derive the relation-quality badge shown by the records list.

The module accepts immutable record values and returns values. It performs no
React state updates and calls no API. Tests cover conflict/unrelated exclusion,
duplicate precedence, symmetric pair handling, queue ordering, merge-candidate
assessment, and badge selection.

## Pure merge model

Create `methodology-merge-model.ts` for the state transformations used by the
merge editor:

- deduplicate source evidence in source order;
- build the bounded automatic evidence summary;
- compare identifier sets;
- update merge sources while preserving still-valid user evidence choices;
- append newly available evidence up to the existing five-record limit;
- update an untouched automatic summary while preserving a user-edited
  summary.

The exported draft type contains the complete data needed for that
transformation. Direct tests make the retention and user-edit rules explicit.

## Migration sequence

1. Add type-level tests for the three narrow capabilities and watch them fail
   before the types exist.
2. Add focused behavior tests for the relation and merge models and watch them
   fail before the modules exist.
3. Implement the capability aliases as views of the existing full API.
4. Implement the pure models by moving the current behavior without semantic
   changes.
5. Change methodology component props and imports to use the new seams.
6. Delete the duplicated local helper implementations.
7. Run focused methodology application tests, type checking, and the complete
   quality gate.

## Error handling and privacy

This slice does not add new errors or persist new data. Existing API rejection
handling remains at the initiating UI operation. Pure models receive already
loaded local records and do not log, transmit, or persist their content.

The model functions avoid mutating caller-owned arrays and records. This keeps
React update behavior predictable and prevents draft state from changing
outside an explicit state transition.

## Testing strategy

Implementation follows red-green-refactor:

- capability tests use TypeScript's type system to prove that each slice has
  the intended keys and excludes unrelated APIs;
- relation-model tests use compact methodology fixtures and assert externally
  meaningful policy outcomes;
- merge-model tests assert evidence ordering, bounding, retention, and manual
  summary preservation;
- existing application tests remain the integration contract for all visible
  workflows;
- root type checking proves the full preload API is structurally compatible
  with the narrower component props.

## Acceptance criteria

- `DecisionAnalyticsView` cannot access APIs outside analytics and
  consultation calibration.
- `PracticeAssetsView` cannot access APIs outside practice-asset management,
  its draft storage, and source-principle listing.
- `MethodologyPanel` accepts a named methodology-workspace capability rather
  than the complete renderer API.
- Relation and merge rules are exported from pure modules and have focused
  unit coverage.
- The original helper implementations no longer remain in
  `MethodologyPanel.tsx`.
- No IPC channel, preload method, visible copy, or user workflow changes.
- Focused model tests, methodology application coverage, type checking, and
  `npm run check` all pass.

## Follow-up sequence

Once these seams are stable, later structural slices can extract one complete
vertical flow at a time (merge, evolution, then acquisition) without passing
the full workspace state through presentational components. The next product
priority after this structural sub-project remains semantic recall.
