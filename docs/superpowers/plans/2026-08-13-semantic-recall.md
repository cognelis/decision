# Deterministic Semantic Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise deterministic semantic recall above the existing 90% gate while preserving high-confidence precision and conservative negative handling.

**Architecture:** Keep `TextDecisionAnalyzer` as the bounded local rule engine. Extend its bilingual structural grammar, distinguish explicit approval strength, replace blanket post-question rejection with an explicit self-resolution guard, and cap rule-detected mixed answers at medium. Do not change routing thresholds, persistence, IPC, or provider configuration.

**Tech Stack:** TypeScript, Vitest, Vite SSR test loader, npm workspaces

---

## File map

- Modify `packages/core/test/text-decision-analyzer.test.ts`: focused recall and
  precision regression cases.
- Modify `packages/core/src/text-decision-analyzer.ts`: bounded bilingual
  signals and scoring behavior.
- Modify `scripts/evaluate-semantic-classifier.mjs`: reuse the analyzer's mixed
  signal when deriving rule relation.
- Modify `scripts/test/evaluate-semantic-classifier.test.ts`: rule predictor
  coverage for mixed behavior if required.
- Modify `docs/semantic-recognition.md`: record the corrected deterministic
  baseline and unchanged activation limitation.

### Task 1: Failing prompt-detection cases

**Files:**
- Modify: `packages/core/test/text-decision-analyzer.test.ts`

- [x] **Step 1: Add positive prompt tests**

Cover English `or` alternatives, a neutral sentence after a question, Chinese
confirmation after a question, `please decide`, and the expanded bilingual
approval framing.

- [x] **Step 2: Add adversarial negative tests**

Cover a self-resolved question followed by implementation, a completed patch
after a diff question, and the Chinese repository-path information request.

- [x] **Step 3: Run focused tests and verify RED**

Run the new cases. Expected: the positive cases fail with no pending analysis;
existing negative behavior remains visible.

### Task 2: Failing answer-completion cases

**Files:**
- Modify: `packages/core/test/text-decision-analyzer.test.ts`

- [x] **Step 1: Add punctuated approval tests**

Prove exact punctuated approvals can move explicit approval framing to high and
that directional approvals use framing strength rather than a blanket high.

- [x] **Step 2: Add mixed-answer tests**

Prove Chinese and English mixed answers add `answer_is_mixed`, remain medium,
and return the unchanged input through the calling flow.

- [x] **Step 3: Run focused tests and verify RED**

Expected: punctuated approvals remain low/medium and mixed answers remain high
before implementation.

### Task 3: Implement bounded rule changes

**Files:**
- Modify: `packages/core/src/text-decision-analyzer.ts`

- [x] **Step 1: Extend prompt grammar**

Add English question-bound `or` alternatives, bounded decision/approval
phrases, corrected Chinese confirmation forms, and the repository-path
information guard.

- [x] **Step 2: Replace blanket tail rejection**

Reject only explicit assistant self-resolution, continuation, execution, or
completion after the last question. Preserve neutral/waiting tails.

- [x] **Step 3: Normalize and score decision answers**

Strip trailing sentence punctuation only for exact short matching. Add strong
exact approval and weaker directional approval signals. Use English word
boundaries in new-task detection.

- [x] **Step 4: Cap deterministic mixed answers**

Add the mixed signal only when the response already has an answer relation and
cap the score at 74.

- [x] **Step 5: Preserve candidate review for implicit confirmation**

An integration regression showed that a stronger approval weight could promote
an implicit recommendation directly to high confidence. Add a failing analyzer
case, cap implicit-only confirmation at 74, and re-run the two candidate-spool
integration scenarios.

- [x] **Step 6: Run analyzer tests and verify GREEN**

Run the complete core analyzer test file, including the existing performance
budget.

### Task 4: Align rule evaluation and integration

**Files:**
- Modify: `scripts/evaluate-semantic-classifier.mjs`
- Modify: `scripts/test/evaluate-semantic-classifier.test.ts` if needed

- [x] **Step 1: Prefer the analyzer mixed signal in rule relation**

Keep the existing safe fallback regex for compatibility, but treat
`answer_is_mixed` as the canonical deterministic result.

- [x] **Step 2: Run evaluator, coordinator, and router tests**

Expected: mixed behavior and fallback routing remain medium and preserve the
complete answer.

### Task 5: Verify semantic acceptance

**Files:**
- Modify: `docs/semantic-recognition.md`
- Modify: `docs/superpowers/plans/2026-08-13-semantic-recall.md`

- [x] **Step 1: Run the non-blocking report**

Record summary, confusion matrix, locale slices, relation accuracy, and
extractability for the unchanged 64 samples.

- [x] **Step 2: Run the strict semantic gate**

Run `npm run check:semantic`. Expected: exit 0 with precision and recall gates
met.

- [x] **Step 3: Run the full repository quality gate**

Run `npm run check` in the normal Electron-capable environment. Expected: all
type checks and tests pass.

- [x] **Step 4: Audit the diff and record package-size work next**

Run `git diff --check`, review every scoped hunk, update verification evidence,
then begin the package-size/DuckDB analysis.

## Verification evidence

- Analyzer RED: 11 focused positive, safety, approval, and mixed cases failed
  before the grammar/scoring changes.
- Analyzer GREEN: 39 tests passed, including the bounded 64 KiB performance
  check.
- Full semantic integration: evaluator, router, and coordinator passed 40
  tests.
- Initial full regression exposed two candidate-review failures. Root-cause
  tracing showed that strong approval scoring promoted an implicit
  recommendation from medium to high, bypassing the candidate spool.
- The new implicit-confirmation regression failed before the cap, then the two
  affected decision-flow integration tests passed after the source-level fix.
- Strict semantic gate: high precision 100%, high + medium recall 100%,
  relation accuracy 84.4%, question/answer extractability 100%, with both
  locale recall slices at 100%.
- Conservative confusion: 25 high labels route high, 6 implicit-confirmation
  high labels route medium, all 11 medium labels route medium, and all 22 low
  labels route low.
- Complete `npm run check`: 111 test files and 921 tests passed.
- `git diff --check` passed and the scoped audit found no persistence, IPC,
  provider, or threshold changes.
