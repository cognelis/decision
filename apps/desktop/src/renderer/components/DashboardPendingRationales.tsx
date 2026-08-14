import { useState } from "react";

import type { PendingRationaleSummary } from "../../shared/renderer-api.js";
import { ModalDialog } from "./ModalDialog.js";

interface DashboardPendingRationalesProps {
  decisions: PendingRationaleSummary[];
  onComplete(id: string, rationale: string): Promise<void>;
  onSkip(id: string): Promise<void>;
  onDiscard(id: string): Promise<void>;
}

const HISTORICAL_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

const sourceLabels: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  test: "Test",
};

const isHistorical = (created: string): boolean =>
  Date.now() - new Date(created).getTime() >= HISTORICAL_AGE_MS;

export const DashboardPendingRationales = ({
  decisions,
  onComplete,
  onSkip,
  onDiscard,
}: DashboardPendingRationalesProps) => {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [skipId, setSkipId] = useState<string | null>(null);
  const [rationale, setRationale] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeDecision = decisions.find((decision) => decision.id === activeId);
  const skipDecision = decisions.find((decision) => decision.id === skipId);

  const save = async (): Promise<void> => {
    if (activeId === null || rationale.trim().length === 0) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onComplete(activeId, rationale);
      setActiveId(null);
      setRationale("");
    } catch (caught) {
      setError(
        `理由暂时无法保存：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  const skip = async (id: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onSkip(id);
      setSkipId(null);
    } catch (caught) {
      setError(
        `暂时无法标记为未补理由：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  const discard = async (id: string): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await onDiscard(id);
      setSkipId(null);
    } catch (caught) {
      setError(
        `暂时无法移除这条决策：${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section
        className="dashboard-card dashboard-rationale-card"
        aria-labelledby="dashboard-rationale-title"
      >
        <header className="dashboard-card-header">
          <div>
            <span>待办</span>
            <h2 id="dashboard-rationale-title">待补理由</h2>
            <p className="dashboard-rationale-description">
              已记录决策，理由尚未补充
            </p>
          </div>
          <strong>{decisions.length}</strong>
        </header>
        {decisions.length === 0 ? (
          <p className="dashboard-empty-copy">目前没有待补充的决策。</p>
        ) : (
          <ul className="dashboard-rationale-list">
            {decisions.map((decision) => (
              <li key={decision.id}>
                <div className="dashboard-rationale-row">
                  <div className="dashboard-rationale-copy">
                    <div className="dashboard-rationale-title-line">
                      <strong>{decision.question}</strong>
                      {isHistorical(decision.created) ? (
                        <span className="dashboard-history-badge">历史</span>
                      ) : null}
                    </div>
                    <div className="dashboard-rationale-meta">
                      <span className="dashboard-rationale-answer">
                        选择：{decision.selectedAnswer}
                      </span>
                      <span>{decision.project}</span>
                      <span>
                        {sourceLabels[decision.sourceClient] ??
                          decision.sourceClient}
                      </span>
                      <time dateTime={decision.created}>
                        {new Intl.DateTimeFormat("zh-CN", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(new Date(decision.created))}
                      </time>
                    </div>
                    {decision.contextSummary === null ? null : (
                      <p className="dashboard-rationale-context">
                        {decision.contextSummary}
                      </p>
                    )}
                  </div>
                  <div className="dashboard-rationale-actions">
                    <button
                      className="text-button"
                      type="button"
                      aria-haspopup="dialog"
                      disabled={saving}
                      onClick={() => {
                        setActiveId(decision.id);
                        setSkipId(null);
                        setRationale("");
                        setError(null);
                      }}
                    >
                      补充理由
                    </button>
                    <button
                      className="text-button dashboard-rationale-discard"
                      type="button"
                      aria-haspopup="dialog"
                      disabled={saving}
                      onClick={() => {
                        setActiveId(null);
                        setSkipId(decision.id);
                        setRationale("");
                        setError(null);
                      }}
                    >
                      不记录
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeDecision === undefined ? null : (
        <ModalDialog
          title="补充决策理由"
          description="保存后会更新这条已记录决策"
          dismissible={!saving}
          onClose={() => {
            setActiveId(null);
            setRationale("");
            setError(null);
          }}
        >
          <form
            className="dashboard-rationale-dialog-form"
            aria-label="补充决策理由表单"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="modal-decision-summary">
              <strong>{activeDecision.question}</strong>
              <span>选择：{activeDecision.selectedAnswer}</span>
              <p>{activeDecision.contextSummary ?? "当时未保存上下文"}</p>
            </div>
            <label htmlFor={`pending-${activeDecision.id}`}>决策理由</label>
            <textarea
              autoFocus
              aria-label={`补充${activeDecision.question}的理由`}
              className="glass-input"
              id={`pending-${activeDecision.id}`}
              rows={5}
              value={rationale}
              onChange={(event) => setRationale(event.currentTarget.value)}
            />
            {error === null ? null : (
              <p className="dashboard-rationale-error" role="alert">
                {error}
              </p>
            )}
            <div className="modal-form-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  setActiveId(null);
                  setRationale("");
                  setError(null);
                }}
              >
                取消
              </button>
              <button
                className="primary-button"
                type="submit"
                disabled={saving || rationale.trim().length === 0}
              >
                保存补充理由
              </button>
            </div>
          </form>
        </ModalDialog>
      )}

      {skipDecision === undefined ? null : (
        <ModalDialog
          title="不记录这条决策？"
          description="确认后会从决策库与 Obsidian 中移除"
          dismissible={!saving}
          onClose={() => {
            setSkipId(null);
            setError(null);
          }}
          size="compact"
        >
          <div className="modal-decision-summary">
            <strong>{skipDecision.question}</strong>
            <span>选择：{skipDecision.selectedAnswer}</span>
          </div>
          <p className="dashboard-rationale-confirm-copy">
            如果只是无需补充理由，也可以保留决策并结束这项待办。
          </p>
          {error === null ? null : (
            <p className="dashboard-rationale-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-form-actions">
            <button
              className="secondary-button"
              type="button"
              aria-label="取消不记录决策"
              disabled={saving}
              onClick={() => {
                setSkipId(null);
                setError(null);
              }}
            >
              取消
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={saving}
              onClick={() => void skip(skipDecision.id)}
            >
              保留但不补
            </button>
            <button
              className="primary-button dashboard-rationale-discard-confirm"
              type="button"
              disabled={saving}
              onClick={() => void discard(skipDecision.id)}
            >
              确认不记录
            </button>
          </div>
        </ModalDialog>
      )}
    </>
  );
};
