import type { CapturedDecisionCandidate } from "@cognelis/decision-protocol";
import { useState } from "react";

import {
  DEFER_SHORTCUT_KEYS,
  deferShortcutLabel,
  PREFERENCE_SHORTCUT_KEYS,
  preferenceShortcutLabel,
  SUBMIT_SHORTCUT_KEYS,
  submitShortcutLabel,
} from "../keyboard.js";
import { relativeTime } from "../relative-time.js";
import { AnswerLabel, answerOptionIndex, answerReply, OptionDescription } from "./DecisionAnswerSummary.js";
import { CapturedText, DecisionContext } from "./DecisionContext.js";
import { renderMarkdown } from "./pages/assistant/markdown.js";
import { ActiveRecordDialog, type ActiveRecordApi } from "./pages/decisions/ActiveRecordDialog.js";
import { SourceBadge } from "./SourceBadge.js";
import { preferenceDraft, TaskAction, TaskActionBar, TaskDismissAction, TaskDismissDialog, useTaskShortcuts } from "./TaskActions.js";

interface CandidateReviewProps {
  candidate: CapturedDecisionCandidate;
  position: number;
  total: number;
  /** How many wait, this one included: alone, there is nothing to skip to. */
  remaining: number;
  busy: boolean;
  persistenceStatus: "saving" | "failed" | undefined;
  error: string | null;
  recordApi: ActiveRecordApi;
  onClose(): void;
  onConfirm(): Promise<void>;
  onIgnore(): Promise<void>;
  onSkip(): Promise<void>;
  onRetry(): Promise<void>;
}

export const CandidateReview = ({
  candidate,
  position,
  total,
  remaining,
  busy,
  persistenceStatus,
  error,
  recordApi,
  onClose,
  onConfirm,
  onIgnore,
  onSkip,
  onRetry,
}: CandidateReviewProps) => {
  const question = candidate.event.questions[0]!;
  const indexOf = answerOptionIndex(question);
  const chosenOptions = new Set(
    question.answer.values
      .map(indexOf)
      .filter((index): index is number => index !== undefined),
  );
  const saving = busy || persistenceStatus === "saving";
  const decisionActionUnavailable = saving || persistenceStatus === "failed";
  const reply = answerReply(question);
  const context = candidate.event.context;
  const taskContext =
    context?.taskBackground === undefined
      ? undefined
      : {
          taskBackground: context.taskBackground,
          ...(context.truncated === undefined
            ? {}
            : { truncated: context.truncated }),
        };

  // By candidate: one older arriving takes this one's place, and what is saved settles only the one it was opened for.
  const [preferenceFor, setPreferenceFor] = useState<string | null>(null);
  const [ignoreFor, setIgnoreFor] = useState<string | null>(null);
  const canSkip = !decisionActionUnavailable && remaining > 1;
  const skip = (): void => {
    if (canSkip) void onSkip();
  };
  const recordPreference = (): void => {
    if (!decisionActionUnavailable) setPreferenceFor(candidate.candidateId);
  };
  const askToIgnore = (): void => {
    if (!decisionActionUnavailable) setIgnoreFor(candidate.candidateId);
  };
  useTaskShortcuts({
    submit: () => {
      if (!decisionActionUnavailable) void onConfirm();
    },
    skip,
    preference: recordPreference,
    dismiss: askToIgnore,
    close: onClose,
  });

  return (
    <section
      className="desktop-view candidate-review"
      role="region"
      aria-label="待处理决策"
    >
      {/* The page's name, as every page has, with where this one came from and what it asks under it. The question is
          what the page is about, so it is the card's first thing: as the title, an assistant's whole message stood
          there as two lines of large bold text. */}
      <header className="desktop-view-header candidate-review-header drag-region">
        <div>
          {/* Focused when the next candidate takes this one's place: it names the page, and says the question now asked. */}
          <h1 aria-describedby="candidate-question-text">待处理</h1>
          <p className="origin-line">
            <SourceBadge source={candidate.event.sourceClient} />
            <span className="project-name">
              {[candidate.event.project, relativeTime(candidate.event.capturedAt)].filter(Boolean).join(" · ")}
            </span>
            <span>需要你判断：是决策就记录并补上理由，不是就忽略。</span>
          </p>
        </div>
        <div className="desktop-view-meta">
          <strong>{position} / {total}</strong>
          <span>条待处理</span>
        </div>
      </header>

      <div className="candidate-review-content">
        <div className="candidate-review-cards">
          <div className="candidate-card">
            <section
              className="candidate-question"
              aria-labelledby="candidate-question-title"
            >
              <h2 id="candidate-question-title">问题</h2>
              <div className="assistant-answer" id="candidate-question-text">{renderMarkdown(question.question)}</div>
            </section>
            {context?.decisionFraming === undefined ? null : (
              <section
                className="candidate-source"
                aria-labelledby="candidate-source-title"
              >
                <h2 id="candidate-source-title">原文</h2>
                <CapturedText text={context.decisionFraming} />
              </section>
            )}

            <div className="candidate-answer-area">
              <section
                className="candidate-answer"
                aria-labelledby="candidate-answer-title"
              >
                <h2 id="candidate-answer-title">你的回答</h2>
                <strong><AnswerLabel text={question.answer.values.join("、")} /></strong>
                {reply === undefined ? null : (
                  <span className="candidate-answer-reply">原话：{reply}</span>
                )}
              </section>
              {question.options.length === 0 ? null : (
                <ul className="candidate-options" aria-label="相关选项">
                  {question.options.map((option, index) => (
                    <li
                      key={option.id ?? index}
                      className={chosenOptions.has(index) ? "chosen" : undefined}
                    >
                      <strong>
                        <AnswerLabel text={option.label} />
                        {chosenOptions.has(index) ? (
                          <em>
                            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg>
                            已选
                          </em>
                        ) : null}
                      </strong>
                      {option.description === undefined ? null : (
                        <OptionDescription text={option.description} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <DecisionContext context={taskContext} />
        </div>

        {/* What failed, and the way to try again right after it: the retry was pushed to the far end of the row. */}
        {persistenceStatus === "failed" ? (
          <div className="load-failure candidate-persistence-error" role="alert">
            <p>
              候选状态暂时无法保存。可以重试，或点“稍后”退出，内容仍会保留。
            </p>
            <button
              type="button"
              className="secondary-button"
              disabled={saving}
              onClick={() => void onRetry()}
            >
              重试
            </button>
          </div>
        ) : null}
        {error === null ? null : (
          <p className="form-error candidate-review-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {/* Every answer to the page in one bar pinned to the bottom, the main one first, as on the rationale panel. */}
      <TaskActionBar>
        <TaskAction
          primary
          label="记录并补充理由"
          disabled={decisionActionUnavailable}
          title={`${submitShortcutLabel()} 记录并补充理由`}
          shortcut={{ keys: SUBMIT_SHORTCUT_KEYS, label: submitShortcutLabel() }}
          onAct={() => void onConfirm()}
        />
        <TaskAction
          label="记为偏好"
          disabled={decisionActionUnavailable}
          title="这不是一次决策，而是你的偏好：确认内容后保存为偏好记录"
          shortcut={{ keys: PREFERENCE_SHORTCUT_KEYS, label: preferenceShortcutLabel() }}
          onAct={recordPreference}
        />
        <TaskAction
          label="跳过"
          disabled={!canSkip}
          title={remaining > 1 ? "先看下一条，这条排到最后" : "没有下一条了"}
          shortcut={{ keys: DEFER_SHORTCUT_KEYS, label: deferShortcutLabel() }}
          onAct={skip}
        />
        <TaskAction
          label="稍后"
          disabled={saving}
          shortcut={{ keys: "Escape", label: "Esc" }}
          onAct={onClose}
        />
        <TaskDismissAction label="忽略" disabled={decisionActionUnavailable} onAct={askToIgnore} />
      </TaskActionBar>
      {ignoreFor === candidate.candidateId ? (
        <TaskDismissDialog
          title="忽略这条？"
          description="它不是决策：不会记录，也不会再出现。"
          question={question.question}
          confirmLabel="忽略"
          onCancel={() => setIgnoreFor(null)}
          onConfirm={() => {
            setIgnoreFor(null);
            void onIgnore();
          }}
        />
      ) : null}
      {preferenceFor === candidate.candidateId ? (
        <ActiveRecordDialog
          api={recordApi}
          draft={preferenceDraft({
            question: question.question,
            answer: question.answer.values.join("、"),
            project: candidate.event.project,
            context: context?.decisionFraming ?? context?.taskBackground,
          })}
          onClose={() => setPreferenceFor(null)}
          onSaved={() => {
            setPreferenceFor(null);
            // Written as a preference, it has been answered: it leaves the queue as one that is no decision.
            void onIgnore();
          }}
        />
      ) : null}
    </section>
  );
};
