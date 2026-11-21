# Recording with Paraself

Read this before calling any Paraself write tool. Every write needs the user's explicit request or authorization for that specific change.

## Record an explicit scope

When the user explicitly defines or revises the scope of a specific decision, use `record_decision_scope`. Read the exact source first, then pass its source name, record ID, `sourceRef.contentHash`, `scopeRevision` as `expectedRevision`, the requested scope and a concise `changeReason`. Supported scope dimensions are `projects`, `repositoryIds`, `modules`, `layers`, `paths`, `excludedPaths` and textual `exceptions`. Set only what the user actually specified; unmentioned dimensions are not permission to guess. A revision replaces the scope object, so preserve existing dimensions the user did not ask to change.

The tool stores separate Markdown scope metadata and bounded revision history, leaving the original decision unchanged. If the source or scope revision changed, reread and reconcile before retrying. If transport status is uncertain, first check the current revision and content; do not submit an unconditional duplicate. Do not create scope records merely because a query suggests a match, and do not bulk-label past decisions from observed behavior.

## Record a confirmed relationship

Use `record_decision_relation` only when the user explicitly confirms a relationship between two decisions in `summarize` or `decisions`. Principle relationships retain the existing methodology workflow. Retrieve both source records and pass `first` and `second` with their source, record ID and current content hash. A new pair uses `expectedRevision: 0`; otherwise use the returned relation revision. The pair has one current judgment regardless of endpoint order.

- `conflict` records a confirmed conflict; `unrelated` records the user's conclusion that the compared decisions are not related. Neither may have a successor.
- `supersedes` requires `successor: first` or `second`, explicitly identifying the newer decision. This is a whole-record successor relationship; do not turn a narrow task-specific exception into global replacement.
- `revoked` withdraws this tool's judgment while preserving its history. It restores the original note's relationships, if any; it does not delete or rewrite source-note fields. Use the returned first/second anchors to withdraw a stale or dangling relation. Set successor to null and provide the withdrawal reason.

Every change requires a reason. Current explicit relationship judgments override older inline relationships for that pair. If either source changes, the judgment is marked stale and no longer overrides the current source facts. Cyclic replacement chains are rejected. Reread source and relation revisions after a conflict or uncertain transport response rather than blindly retrying.

For the current coding task, assess conflicts against the user's current explicit requirements and confirmed scope; ask for a choice only when it blocks safe progress. That task-specific choice does not itself authorize recording a permanent replacement or rewriting past decisions.


## Record an actual outcome or review

When the user asks to record an observed result, review or next review date for an existing App decision, use `record_decision_outcome`. Retrieve the exact `source: decisions` and `recordId` first. Use `sourceRef.contentHash` as `expectedContentHash`; `outcomeState` contains the full expectation, actual outcome, review and review date. This tool does not edit historical `summarize` notes or principles. Do not create a duplicate App decision to bypass that boundary.

Only record observations and judgments the user supplied or explicitly authorized. Tests passing, a merge, or deployment completion do not establish that a decision achieved its expected business outcome. A tentative result can be recorded as tentative; do not manufacture a verdict. An outcome can be saved without a review.

- `outcome` replaces the complete result text. Preserve previous observations when adding new ones unless the user corrects them. Omit it to keep the current result. The replaced text is not kept anywhere, so when the call would drop or reword existing outcome text, or replace or clear an existing review, show the user the complete new text beside the old and wait for their yes first. Appending the user's new observation needs no extra confirmation.
- `review` supplies `verdict` (`better`, `as_expected`, `mixed`, `worse` or `unclear`) and `lesson` (text or null). The App stamps the recording time. It requires a recorded outcome, which may be included in the same call. `review: null` explicitly clears the current review; omit the field to retain it.
- When changing an outcome that already has a review, the tool requires an explicit review update or null. Do not discard the old judgment just to satisfy validation; retain the request as pending if the user's intended treatment is unclear.
- `reviewDueDate` is a valid `YYYY-MM-DD` date or null to clear it. Omitted dates remain unchanged, including after a review. Do not infer a schedule.

The supplied fields save in one Markdown replacement through the App's existing lifecycle storage. `saved` means the note changed; `unchanged` means no content change was necessary. `indexed: false` still means Markdown was saved, with a rebuildable index failure. Source conflicts or uncertain transport require rereading the state and version before retrying; never claim a save from a timeout. Internal note delimiters in supplied evidence are rejected.

A changed note invalidates independent scope and relationship judgments bound to its old content hash. Their prior revisions and reasons are retained for review; this tool never silently reaffirms them. Desktop editing shares the atomic writer and still retains its existing separate-field editing behavior. This iteration does not add outcome history or a new desktop combined editor.


## Record task-specific usage feedback

When the user explicitly asks to record how a retrieved decision helped or failed to help in a concrete task, use `record_decision_context_feedback`. Choose the user's expressed judgment: `helpful`, `not_applicable`, `insufficient_context` or `irrelevant`. Preserve the actual task and reason; optional project/taskScope describe that task. Do not infer feedback from search results, passing tests, or a completed implementation. This feedback is separate from an outcome of the original decision, permanent applicability scope and principle-consultation feedback.

Retrieve the source and current hash, then provide `reference` with source, recordId and expectedContentHash. Generate a fresh UUID `feedbackId` for a new observation and set `expectedRevision: 0`. Keep the same ID and exact request when a save is uncertain; read `list_decision_context_feedback` to check first. An exact retry of the just-saved revision returns `unchanged` and does not inflate counts. Correct an existing observation using its ID and current revision; its source collection and record ID cannot be changed.

To withdraw, preserve the existing reference, task, project, taskScope and rating; set withdrawn=true, provide a withdrawal reason and the current expectedRevision. Withdrawal works even when the original source disappeared. It keeps revision history and removes the observation from active rating counts. Do not change the target or task as part of withdrawal.

`list_decision_context_feedback` reads records, bounded history and aggregate counts. A record filter requires both source and recordId; includeWithdrawn exposes withdrawn observations. Follow nextOffset with the same filters. `ratings` counts active observations across source versions; `currentSourceRatings` only counts current readable source versions. Respect partial/unavailable coverage. Counts are observations, not accuracy, recall, proof of benefit or representative usage rates. Never automatically revise scope, relationships, ranking or decisions from feedback.

The desktop decision details contain a 使用反馈 section for the same workflow. Recording or reviewing feedback does not authorize automatic collection of conversations or bulk annotation of historical records.


## Save and work through todo lists

When the user asks to keep the findings of an investigation (for example 「把调研结果存到 Paraself 待办」), or a standing instruction of theirs says to, use `record_todo_list`: one list per investigation, a one-line `title`, an optional `summary` of the conclusion, and one item per concrete finding that can be handled and checked on its own, with its evidence, location and suggested action in `detail`. Pass `project` when the work concerns another repository than the one the MCP server started in. Do not save a list for a casual answer, and never include secrets or full transcripts. Sending the same list again returns the one already saved (`duplicate`), so an uncertain save can be retried; to add findings later, pass `listId` with only the new items.

The user may also ask for a list to collect todos in as they come, such as 日常 or 学习: make it with `record_todo_list` and no `items`. A list made without items is long-term (`longTerm`): it stays among the unfinished lists however many of its items are done, while a list of findings is done with once every item is done or dropped. Set `longTerm` only when the user said which kind they want. Such a list gets no project unless you pass one, and making an empty list whose name the project already has returns that list (`duplicate`). To put a new todo on it, find it with `list_todo_lists` (by `query`, or `listId`) and call `record_todo_list` with its `listId`; listing a long-term list shows only its unfinished items, and `listId` reads it whole.

To work through a list, read it with `list_todo_lists`: by default only lists with items still open; `listId` returns one list in full even when it is closed; `query` and `project` narrow the search. Handle one item at a time. Mark it `in_progress` with `update_todo_item` when you start, then `done` with a `note` saying what was changed and how it was verified (commit, PR, test run), or `dropped` with the reason. Only mark done what was actually done and checked in this session or confirmed by the user; passing tests settle a finding only when they cover it. A note without a status records progress. Items can also change outside your session: ticked in Obsidian (`changedInObsidian`) or set by the user in the App. Reread before acting on an old reading, and do not change an item back unless asked. Every change stays in the list's history, and the user can undo any of them.

A choice made while handling an item is still a decision: record it with `record_decision_journal_entry` only under the usual explicit-request rule.

## Keep and trace historical decisions

Use `record_historical_decision` only when the user asks to keep a choice on record without tracking it (for example 「把这个记成历史决定」「记一笔，我们定了用 zip 分发」). Only `title` (the matter decided, one line) and `decision` (what was decided) are required; `decidedOn` defaults to today, so pass the real day when recording something decided earlier. Add what the user actually said and nothing inferred: `options` considered, `context` (circumstances, not an argument), `scope`, `participants`, `reversibility` (`easy`, `costly`, `irreversible`), `references` (HTTPS links), `relatedNotes`, `tags`, `notes`, `revisitCondition` (a note to oneself; nothing is scheduled). Do not write a rationale into `notes` to make the record look complete. `project` defaults to the repository the MCP server started in; pass it when the decision belongs elsewhere. The same matter, decision, project and day sent again returns the record already kept (`duplicate`), so an uncertain save can be retried.

Pick the tool by what the user wants later, not by how much they said: a decision whose reasons and outcome should be found, reviewed and learned from goes to `record_decision_journal_entry`; one that only needs to be on the ledger goes here. When unsure which, ask.

When a new record replaces an earlier one, pass the earlier record's id as `supersedesId`: the App marks that one 已替代 and links the two. A replacement that would loop back on itself is refused.

To change a record, read it first with `get_historical_decision` and pass its `revision` as `expectedRevision`; with a `status` change also pass the status you read as `expectedStatus`. A refusal means it changed meanwhile: read again before retrying. Lists (`options`, `participants`, `references`, `relatedNotes`, `tags`) are replaced as a whole; `null` clears an optional text. Statuses are `active`, `superseded`, `ended` and `withdrawn`. There is no delete: `withdrawn` takes a record back, keeps its note and history, and makes it read-only until it is given another status. Setting `active` on a superseded record also releases the records that replaced it; tell the user that this happens before doing it. Withdraw, restore or re-date a record only when the user says so, never to tidy the ledger.

`promote: true` makes a formal decision record from a historical decision, once. From then on that decision takes part in `search_decision_context`, the rationale queue and reviews, while the historical decision stays as it is and links to it. Use it only when the user asks to turn the record into a tracked decision.
