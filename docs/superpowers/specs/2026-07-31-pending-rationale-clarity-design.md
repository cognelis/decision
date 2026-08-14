# Pending Rationale Clarity Design

**Date:** 2026-07-31

## Goal

Make “待补理由” understandable and safely dismissible. A pending
rationale is an already-recorded decision whose rationale was deferred; it
is not a new decision awaiting confirmation.

The user must be able to recover enough context to decide whether to add a
rationale, or explicitly finish the item without adding one.

## Current problem

The Decision Center currently lists every deferred rationale from the
rebuildable SQLite index and the current local spool. It sorts them oldest
first and exposes only the question and creation time.

This creates three ambiguities:

- historical items appear first without being identified as historical;
- the selected answer, project, source, and captured context are hidden;
- the only available action is “补充理由”, even though the persisted
  decision model already supports a skipped rationale state.

## Approaches considered

### 1. Add only a skip button

This is the smallest implementation, but it leaves the user unable to judge
whether an old item deserves a rationale.

### 2. Add a separate decision-detail surface

This could expose the complete note, but it adds navigation and lifecycle
complexity for a compact triage task.

### 3. Enrich the inline row and add an explicit resolution

This is the chosen approach. It keeps triage inside the Decision Center,
adds the missing evidence, and offers a safe “不再补充” resolution without
deleting the decision.

## User experience

The card keeps the title “待补理由” and adds the explanation:

> 已记录决策，理由尚未补充

Items are ordered newest first. Items at least 30 days old receive a
“历史” badge; the application does not automatically skip or hide them.

Each item shows:

- decision question;
- selected answer;
- project and source client;
- full creation date and time;
- a bounded context excerpt when captured context exists.

When old data has no captured context, the row says “当时未保存上下文”
instead of leaving an unexplained blank area.

Each item offers:

- **补充理由** — opens the existing inline editor;
- **不再补充** — opens an inline confirmation:
  “保留这条决策，并标记为未补理由？”

Confirming “不再补充” changes the rationale state from `deferred` to
`skipped`, removes the item from the pending count, and retains the decision
note. Canceling leaves the item unchanged.

The first version deliberately has no automatic expiry or batch skip.

## Data contract

`PendingRationaleSummary` gains renderer-safe fields:

- `project`;
- `sourceClient`;
- `selectedAnswer`;
- `contextSummary`.

For indexed decisions these fields come from the existing SQLite columns.
For a locally deferred item they come from the captured candidate. No file
path is exposed to the renderer.

The renderer derives the historical badge from `created` using a pinned
30-day threshold. It truncates context visually without mutating the stored
text.

## Resolution and persistence

The existing rationale IPC path remains the public renderer seam. It is
extended so a non-current decision ID may resolve a deferred rationale with
either:

- `captured`, including rationale text and optional reason factors; or
- `skipped`, with no rationale text.

For a locally spooled deferred decision, the runtime replaces its deferred
disposition with `skipped` and uses the existing finalization path.

For an already-persisted decision, the Markdown repository atomically
updates:

- `status` to `rationale_skipped`;
- `rationale_status` to `skipped`;
- the rationale body marker to `（已跳过）`.

The decision store then upserts the changed note into SQLite. It never
deletes the Markdown note.

## Error handling

- A failed skip keeps the item visible and shows an inline error.
- A failed rationale save preserves the typed rationale, as it does today.
- An SQLite upsert failure reports degraded index health after the Markdown
  write succeeds.
- Missing legacy metadata uses explicit fallback labels and never blocks
  resolution.

## Verification

1. Markdown and decision-store tests prove skipped deferred records are
   retained and reindexed.
2. Runtime and IPC tests prove both local-spool and persisted-history skip
   paths.
3. Renderer tests prove rich context, the 30-day historical badge, newest
   ordering, confirmation, cancellation, success, and visible errors.
4. Real Electron layout tests prove the richer rows and confirmation fit
   the Decision Center without horizontal overflow.
5. Full tests, packaged build, smoke test, production push, and in-place app
   replacement remain the release gate.

## Non-goals

- Deleting decision notes.
- Automatically resolving old items.
- Batch skip.
- A separate decision-detail window.
- Editing other historical decision fields.
