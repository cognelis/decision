# Curating the review benchmark

Read this before calling `record_review_benchmark_cases` or `update_review_benchmark_case`. Curate only when the user asks you to.

The benchmark scores a PR review against history. The **defect set** holds PRs later found to have a problem, recorded at the version that still had it: does a review find the problem? The **clean set** holds PRs found to have none: does a review raise comments that would do harm if acted on? Paraself keeps each case as references and labels only, in the App's local data, one file per repository. It is neither a note in the Vault nor a file in the repository.

## One case

- One PR per case. `headSha` is the PR's head as it was reviewed; for a defect, a version that still had the problem. `targetSha` is the target branch's commit before the merge. Use full commit ids. The local repository must already have the objects, so run `git fetch` first.
- `title` is the PR's own title. A replay shows it to the reviewer, so never describe the problem in it.
- `scope` (optional) limits the review to some of the changed files, for a PR too large to replay whole. Issue locations must be inside it.
- `provenance` says where the case came from, with an id that `list_review_benchmark_cases` can find it by: the revert's or fix's full commit id, the task id, the incident review.
- Evidence is one paragraph. Never copy source code beyond a few words, secrets or whole discussions into it.

## Finding defect cases

1. Start from something that says a change was wrong:
   - a revert commit;
   - a commit whose message or linked task says it fixes a bug;
   - a bug in the task tracker linked to its fix;
   - an incident or escape review;
   - an author's 「修了」 answer to a review comment.
2. For a fix commit, find the change that introduced the problem. Run `git blame` at the fix's parent on the lines the fix changed (`git blame <fix>^ -- <file>`). Then map the blamed commit to its PR: the merge commit, the PR number in the message, or the platform's commit-to-PR lookup.
3. Record that PR at its head before the fix (`headSha`). The App refuses a case whose `headSha` already contains one of the fix commits. For a squash merge, use the PR's own head commit if the repository still has it. Otherwise use the squash commit, with its first parent as `targetSha`.
4. Give each issue:
   - what is wrong, in one line;
   - a priority: P1 for correctness, data loss or security; P2 for a real defect of lesser impact; P3 for minor ones;
   - its locations: the lines its fix changed, as they read in `headSha` (`side: "old"` for lines the PR removed);
   - one paragraph of evidence;
   - the fix commits.

   A problem the author knowingly accepted is an issue with `tradeoff: true`. A review that raises it is not wrong, but it does not count toward recall.
5. A blame may land on several PRs, or a fix may touch unrelated lines. Record only what you can show and say what is uncertain in the evidence, or leave the case out.

## Finding clean cases

1. Pick PRs merged more than 60 days ago, spread across risk levels and modules.
2. Check each one:
   - it was not reverted;
   - no later fix changed the lines it added (`git log -L`, or blame on today's version of those lines);
   - no bug in the task tracker names it.

   Say in `cleanEvidence` which of these checks you made.
3. When you have them, record review comments on it that did not hold as `knownFalsePositives`: what was said and why it did not hold. An example is an author's 「说错了」 that a person agreed with.

## Recording and confirming

- Before recording a case, look for it with `list_review_benchmark_cases`, by `headSha` or by `provenance` (the fix commit or task id).
- Record in batches of up to 20.
  - A case sent again returns the one already kept (`duplicate`).
  - A refused case comes back with its reasons. Fix it and send it again; the others need no resending.
  - One input that fails the tool's own checks stops the whole batch from being sent. The text says which case and field.
- Every case starts as a **candidate**. Show the user what you recorded (the case ids, issues and evidence) and ask them to check it. Only after they say they have checked a case, confirm it with `update_review_benchmark_case`: `status: "confirmed"`, with their words quoted in `userConfirmation`. Never confirm a case on your own judgement.
- The App puts each case in the dev or the holdout split; you cannot choose. A holdout case comes back without its labels and notes. Do not try to recover them, and do not tune a review against them.
- Changing a confirmed case's labels (issues, cleanEvidence, knownFalsePositives, mergedAt) takes it back to a candidate, unless the same call confirms it again.
- Withdraw a case that does not belong, with `status: "withdrawn"` and a `reason`. Nothing is deleted.
- The set, the versions and the scope cannot change. To change them, withdraw the case and record a new one.

Exporting confirmed cases for a replay is done in the Paraself source repository (`npm run replay:pr -- export-benchmark`), not through these tools.

To see whether a change to the review prompt, model or rules helps, `run_review_benchmark` reviews the repository's confirmed cases again in the App, as it reviews now, and `get_review_benchmark_run` compares the run with the one before it: recall first, then harmful findings. Start a run only when the user asks: it spends model calls on every case. Run on the holdout split to decide, on the dev split to tune; a holdout run shows only totals. Judging a clean finding harmful and adopting the change are the user's, in the App.
