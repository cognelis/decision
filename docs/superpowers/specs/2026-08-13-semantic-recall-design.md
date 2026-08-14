# Deterministic Semantic Recall Design

## Status

Selected as the third sub-project in the prioritized Decision improvement
program. The engineering baseline and methodology-boundary slices have passed
their acceptance checks.

## Context

The deterministic 64-sample semantic regression corpus currently reports:

- high precision: 100%;
- high + medium recall: 59.5% against a 90% target;
- relation accuracy: 56.3%;
- English recall: 40.0%;
- Chinese recall: 77.3%.

The confusion matrix contains no high-confidence false positive. The recall
failure is therefore not evidence that the activation threshold should be
lowered. A sample-by-sample trace identifies four structural rule gaps:

1. English inline alternatives joined by `or` are not treated like Chinese
   alternatives joined by `还是`.
2. Any declarative sentence after a question mark is treated as proof that the
   assistant continued, so valid endings such as “请确认”, “由你决定”, and
   “Both are viable” are rejected.
3. Short approvals followed by ordinary punctuation (`Yes.`, `继续。`,
   `Approved.`) lose their approval signal.
4. Approval framing covers only a few confirmation phrases and misses common
   English and Chinese forms such as “please confirm”, “wait for your
   confirmation”, “final call is yours”, and “确认后我再执行”.

The existing rules also identify mixed answers as a relation in the evaluator
but leave their score at high. Product behavior is safer when deterministic
mixed answers enter the review queue at medium confidence.

## Goals

- Reach the existing high + medium recall threshold without reducing the high
  precision threshold.
- Close the English/Chinese recall gap using language structure, not
  sample-specific phrases.
- Keep information requests, quoted content, logs, self-resolved questions,
  and unrelated new tasks at low confidence.
- Route deterministic mixed answers to medium while preserving the complete
  user input.
- Keep the analyzer local, synchronous, bounded, and dependency-free.

## Non-goals

- Lowering the 95% precision or 90% recall thresholds.
- Enabling a remote or local generation model by default.
- Treating the 64 synthetic samples as a product activation study.
- Adding telemetry or retaining ordinary conversation text for tuning.
- Replacing the deterministic analyzer with a general natural-language parser.

## Options considered

### 1. Lower the score thresholds

This would convert more existing partial matches to medium or high, but it
would not recover samples rejected before scoring and would weaken the current
precision guarantee. It is rejected.

### 2. Add bounded structural signals and safety tests

Extend the existing bilingual grammar for alternatives, waiting-for-approval,
answer normalization, and mixed answers. Replace the blanket post-question
sentence rejection with explicit self-resolution/continuation detection.

This is the selected approach. Every change maps to an observed failure class,
can be tested directly, and preserves the existing architecture and privacy
boundary.

### 3. Depend on the semantic model for recall

The hybrid router already benefits from an available model, but model weights
may be missing and configured providers may fail. Rule fallback is a documented
operating mode, so the deterministic baseline must remain useful on its own.

## Detection changes

### English alternatives

An English `or` is considered an inline alternative only when the same request
contains a question mark. This recovers direct choices while avoiding ordinary
declarative uses of “or”. The existing Chinese concessive guard remains
unchanged.

English explicit prompts additionally recognize bounded approval/decision
forms such as “do you approve” and “please decide”.

### Post-question tails

Remove the rule that rejects every non-empty sentence after the last question
mark. Replace it with an explicit self-resolution/continuation guard covering:

- the assistant stating that it decided on an option;
- the assistant stating that it is starting, continuing, executing, or
  implementing the work;
- a completion statement after a quoted/diff question.

Neutral framing and an explicit request for confirmation remain eligible. The
existing code-fence, quote, log-line, information-request, rhetorical-answer,
and status-output stripping remains in front of detection.

### Approval answers

Normalize only trailing sentence punctuation for exact short-answer matching;
the stored user text remains untouched.

Use two bounded answer signals:

- exact approval/rejection phrases (`Yes`, `No`, `Go ahead`, `Approved`,
  `可以`, `继续`, and their existing equivalents) provide a strong answer
  relation;
- explicit directional approval prefixes (`同意…`, `不要…`, `Do not…`) provide
  a smaller weight, allowing stronger decision framing to reach high while the
  weaker “final call is yours” case remains medium.

These signals count as a relation to the pending decision. New-task detection
continues to win when the answer contains no choice, approval, or lexical
relation. When the assistant only implied that it was waiting for confirmation
and did not ask an explicit choice question, the completed rule score is capped
at 74. This preserves candidate review for recommendations such as “I prefer
this approach; waiting for your confirmation” even when the user replies with
a clear approval.

### Mixed answers

When the user both answers and continues with another request, add an explicit
`answer_is_mixed` signal and cap the deterministic score at 74. The result is
therefore medium, not high, and remains eligible for candidate review. The
complete original answer remains the captured value.

## Safety boundaries

- English new-task verbs use word boundaries so substrings such as `Address`
  cannot be mistaken for `add`.
- A repository-path information question is explicitly kept out of the Chinese
  choice grammar.
- Self-resolved and completed-work tails receive focused negative coverage.
- The analyzer continues to cap input, context, option labels, and processing
  time exactly as before.
- No raw sample or new user data is logged or persisted.

## Testing strategy

Implementation follows red-green-refactor:

1. Add focused analyzer tests for English alternatives, neutral post-question
   tails, punctuated approvals, approval framing, mixed capping, information
   requests, self-resolution, and unrelated tasks.
2. Run those tests and confirm failures against the current analyzer.
3. Implement the smallest grammar and scoring changes needed for the new
   behavior.
4. Run the focused analyzer and semantic coordinator/router tests.
5. Run the complete 64-sample report and strict semantic gate.
6. Run the full repository quality gate and inspect the diff.

The corpus remains unchanged in this slice so before/after metrics are directly
comparable. New safety scenarios live in unit tests and do not inflate the
activation report.

## Acceptance criteria

- High precision remains at or above 95%.
- High + medium recall reaches at least 90% on the unchanged 64-sample corpus.
- English and Chinese positive slices both reach at least 90% recall.
- Deterministic mixed answers are medium and retain the full user response.
- Existing negative categories remain low in both corpus and focused tests.
- Question and answer extractability remain 100%.
- `npm run check:semantic` exits successfully.
- `npm run check` passes in the normal Electron-capable environment.

## Follow-up

The synthetic corpus remains an implementation regression baseline. Product
activation still requires the documented, privacy-safe, stratified holdout of
at least 500 labeled examples. The next engineering priority after this slice
is package-size analysis, especially the DuckDB runtime cost.
