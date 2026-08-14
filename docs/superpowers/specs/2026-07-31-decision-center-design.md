# Decision Center Design

**Date:** 2026-07-31

## Goal

Move decision work out of Settings into a dedicated “决策中心”.
The center must contain the complete business view:

- decisions waiting for confirmation;
- recorded decisions waiting for rationale;
- recent recorded decisions;
- current workload and recent recognition statistics.

Settings becomes configuration-only. Markdown remains the source of truth
and SQLite remains a rebuildable read model.

## Approaches considered

### 1. Keep business cards in Settings and restyle them

This is the smallest visual change, but it preserves the wrong information
architecture. The cramped four-column summary caused the current vertical
button, and future business actions would keep competing with configuration.

### 2. Create a second Electron window

A separate dashboard window could coexist with Settings, but Decision
currently uses one carefully managed transient window. A second window would
duplicate lifecycle, glass surface, snapshot synchronization, positioning,
shutdown, and test logic without enabling a required workflow.

### 3. Add a Decision Center mode to the existing window

This is the chosen approach. The existing window manager already changes
size and surface by semantic mode. A new primary surface adds the business
workspace while retaining one lifecycle, one renderer, and one snapshot
stream.

## Information architecture

### Decision Center

The Decision Center uses a 760 × 760 regular glass window.

1. **Toolbar**
   - Close button on the left.
   - “决策中心” title.
   - Settings shortcut on the right.

2. **Workload summary**
   - 待确认: candidate queue count.
   - 待补理由: deferred rationale count.
   - 近 7 天记录: decisions created in the last seven rolling days.
   - 全部决策: indexed decision count.

3. **待办**
   - A candidate card previews the current candidate and starts the existing
     candidate-review flow.
   - A rationale card lists every deferred rationale and supports inline
     completion using the existing safe write path.
   - Empty states remain visible and compact.

4. **最近决策**
   - Up to 12 decisions, newest first.
   - Each row shows question, selected answer, project, source, time, and
     rationale state.
   - This is read-only in the first version; opening files or adding search
     is outside scope.

5. **近 7 天识别**
   - Processing rounds, direct captures, candidates, and failures from the
     existing semantic-recognition summary.

### Settings

Settings retains only:

- appearance;
- Obsidian vault and SQLite maintenance;
- developer-tool integration;
- semantic provider status and mode;
- model backends;
- model invocation trace controls.

The settings summary strip, candidate action, deferred-rationale list, and
semantic business metrics are removed. Index and integration health remain
inside their owning settings cards.

### Tray

The tray menu becomes:

1. `决策中心 · N 项待办`
2. `设置`
3. separator
4. `退出 Decision`

`N` is candidates plus deferred rationales. Opening the tray business entry
never starts review immediately; it first opens the Decision Center.

## State and window model

Replace the independent `settingsOpen` boolean with one explicit primary
surface:

```ts
type PrimarySurface = "hidden" | "dashboard" | "settings";
```

This interface prevents contradictory dashboard/settings states. Candidate
review and the rationale island remain transient flows with higher priority.

When review starts from the Decision Center, the controller remembers the
Decision Center as its return surface:

- “稍后” returns to the Decision Center;
- ignoring the final candidate returns to the Decision Center;
- after the final promoted candidate’s rationale is disposed, the Decision
  Center returns;
- while rationale entry is active, the rationale surface still takes
  priority.

Opening Settings from the Decision Center changes the primary surface rather
than opening another window. Closing either primary surface reveals any
active rationale; otherwise the window hides.

## Data seam

The renderer receives a small `DashboardSnapshot` read model:

```ts
interface DashboardSnapshot {
  totalDecisions: number;
  recorded7d: number;
  recentDecisions: RecentDecisionSummary[];
}
```

The AppController depends on a `dashboard()` provider rather than on SQLite.
The production adapter maps `SqliteIndex` rows into renderer-safe summaries.
Tests supply an in-memory adapter. This keeps storage details and file paths
out of the renderer interface.

`SqliteIndex` adds two read operations:

- `listRecent(limit)` ordered by `created DESC`;
- `countSince(created)` using ISO timestamps.

Both operate on the rebuildable index. No dashboard-only persistence is
introduced.

## UI modules

- `DecisionCenter` owns layout and navigation.
- `DashboardPendingRationales` owns inline rationale completion.
- `RecentDecisionList` owns recent-decision presentation.
- Existing `CandidateReview` remains the detailed confirmation surface.
- `SettingsPanel` no longer imports or knows about business queues.

Business display formatting stays in the renderer modules. Queue mutations
continue through the existing validated IPC methods.

## Error handling

- A dashboard read failure returns an empty dashboard read model and leaves
  the existing index-health signal degraded; it must not prevent Settings or
  rationale capture from opening.
- Deferred rationale failures remain visible in the Decision Center and keep
  the editor content.
- Candidate persistence failures continue to use the existing retry surface.
- Recent-decision rows never expose local file paths.

## Verification

1. Storage tests prove recent ordering, limiting, and rolling-seven-day
   counts.
2. Controller tests prove primary-surface exclusivity and return behavior
   around candidate review and rationale entry.
3. Window-manager tests prove the new size and priority rules.
4. IPC and preload tests prove the new dashboard navigation methods and
   reject unknown input.
5. Renderer tests prove:
   - all four dashboard areas render real snapshot data;
   - candidate review starts from the dashboard;
   - deferred rationale completion still works;
   - Settings contains no candidate or rationale business controls.
6. Tray tests prove the combined workload count and new labels.
7. A real Electron layout test at 760 × 760 proves no hidden horizontal
   overflow, visible primary actions, and a usable scroll region.
8. Full tests, typecheck, packaged build, smoke test, production push, and
   in-place application replacement complete the release gate.

## Non-goals

- Full-text search in the Decision Center.
- Opening or editing historical Markdown notes.
- Charts or trend visualization beyond the existing seven-day counts.
- A second Electron window.
- Changing Markdown schemas or capture semantics.
