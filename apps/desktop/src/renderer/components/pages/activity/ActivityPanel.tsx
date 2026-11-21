import type { AssistantFeedbackSummary } from "@cognelis/decision-protocol";
import { useEffect, useState } from "react";

import type {
  AppSnapshot,
  DecisionApi,
} from "../../../../shared/renderer-api.js";
import type { MisrecognitionSummary } from "../../../../shared/decision-deletion.js";
import { ModelTracePanel } from "../../ModelTracePanel.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { SettingsSubnav } from "../SettingsSubnav.js";

interface ActivityPanelProps {
  snapshot: AppSnapshot;
  api: DecisionApi;
}

export const ActivityPanel = ({ snapshot, api }: ActivityPanelProps) => {
  // Ratings accumulate whether or not anyone looks at them; a count nobody can
  // see is the same as no count at all, and this is the number the roadmap's
  // "持续积累" is actually about.
  const [feedback, setFeedback] = useState<AssistantFeedbackSummary | null>(
    null,
  );
  // Not read this time (the read failed), as opposed to none given: told as none, the zeros said nothing was rated.
  const [unread, setUnread] = useState(false);

  // Decisions deleted as 识别错误: read with the page, as the ratings are.
  const [misrecognized, setMisrecognized] = useState<MisrecognitionSummary | null>(null);
  useEffect(() => {
    let active = true;
    void api.getMisrecognitionSummary().then((summary) => { if (active) setMisrecognized(summary); }, () => undefined);
    return () => { active = false; };
  }, [api]);
  const ranked = (counts: Record<string, number>) => Object.entries(counts).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));

  useEffect(() => {
    let active = true;
    void api
      .getAssistantFeedbackSummary()
      .then((summary) => {
        if (active) { setFeedback(summary); setUnread(false); }
      })
      .catch(() => {
        if (active) { setFeedback(null); setUnread(true); }
      });
    return () => {
      active = false;
    };
  }, [api]);

  return (
  <section
    className="desktop-view activity-panel"
    role="region"
    aria-label="日志"
  >
    <DesktopPageHeader
      eyebrow="诊断"
      title="日志"
      description="集中查看识别概览、模型调用、耗时与错误。"
      meta={snapshot.modelTraceContentEnabled === false ? "关闭" : "开启"}
      metaLabel="内容记录"
    />
    <SettingsSubnav active="activity" api={api} />
    <div className="desktop-page-scroll activity-page-content">
      {/* The two small summaries share a row, one as wide as the other. */}
      <div className="activity-summary-row">
      <section
        className="settings-card activity-recognition-card"
        aria-labelledby="activity-recognition-title"
      >
        <header className="settings-card-header">
          <div>
            <h2 id="activity-recognition-title">识别概览</h2>
          </div>
          <span>近 7 天</span>
        </header>
        <dl className="activity-figures">
          <div>
            <dt>处理轮次</dt>
            <dd>{snapshot.semanticRecognition.processed7d}</dd>
          </div>
          <div>
            <dt>直接捕获</dt>
            <dd>{snapshot.semanticRecognition.high7d}</dd>
          </div>
          <div>
            <dt>候选</dt>
            <dd>{snapshot.semanticRecognition.medium7d}</dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd>{snapshot.semanticRecognition.failures7d}</dd>
          </div>
        </dl>
      </section>

      <section
        className="settings-card activity-feedback-card"
        aria-labelledby="activity-feedback-title"
      >
        <header className="settings-card-header">
          <div>
            <h2 id="activity-feedback-title">问答评分</h2>
          </div>
          <span>累计</span>
        </header>
        <dl className="activity-figures">
          <div>
            <dt>有用</dt>
            <dd>{unread || feedback?.unavailable === true ? "—" : feedback?.helpful ?? 0}</dd>
          </div>
          <div>
            <dt>没用</dt>
            <dd>{unread || feedback?.unavailable === true ? "—" : feedback?.notHelpful ?? 0}</dd>
          </div>
        </dl>
        <p className="activity-feedback-note">
          {unread
            ? "评分记录这次没能读取，请稍后重新打开这一页。"
            : feedback?.unavailable === true
            ? "评分记录读不出来：可能已损坏，或是更新版本的 Paraself 写下的。原文件保持不动，新的评分在它能读取之前也存不进去。"
            : feedback === null || feedback.helpful + feedback.notHelpful === 0
              ? "还没有评分。在问答页给回答打分后，这里会积累出可以回看的样本。"
              : "评分只记问题、引用路径和可选说明，不记回答正文。"}
        </p>
      </section>
      </div>

      <section className="settings-card activity-misrecognition-card" aria-labelledby="activity-misrecognition-title">
        <header className="settings-card-header">
          <div>
            <h2 id="activity-misrecognition-title">识别错误</h2>
          </div>
          <span>近 {misrecognized?.days ?? 30} 天</span>
        </header>
        {misrecognized === null || misrecognized.unavailable === true ? (
          <p className="activity-feedback-note">识别错误回执这次没能读取，请稍后重新打开这一页。</p>
        ) : misrecognized.total === 0 ? (
          <p className="activity-feedback-note">没有标为识别错误的删除。删除自动识别的决策时选「识别错误，删除」，这里会按档位和信号汇总。</p>
        ) : <>
          <div className="activity-misrecognition-body">
            <p className="activity-misrecognition-total"><strong>{misrecognized.total}</strong> 条删除标为识别错误</p>
            <dl className="activity-misrecognition-lines">
              <dt>来源</dt>
              <dd>对话识别 {misrecognized.byMode.transcript} · 结构化提问 {misrecognized.byMode.structured_tool}</dd>
              <dt>档位</dt>
              <dd>直接捕获 {misrecognized.byBand.high} · 候选 {misrecognized.byBand.medium}{misrecognized.byBand.unknown ? ` · 无档位 ${misrecognized.byBand.unknown}` : ""}</dd>
              <dt>信号</dt>
              <dd>{ranked(misrecognized.bySignal).map(([signal, count]) => `${signal} ${count}`).join(" · ") || "无"}</dd>
              <dt>规则版本</dt>
              <dd>{ranked(misrecognized.byDetector).map(([version, count]) => `${version === "unknown" ? "无" : version} ${count}`).join(" · ")}</dd>
            </dl>
          </div>
          <p className="activity-feedback-note">回执只记规则版本、档位、分数、信号、来源、选项数和时间，不记问题、选项、回答或项目。</p>
        </>}
      </section>

      <ModelTracePanel
        api={api}
        contentEnabled={snapshot.modelTraceContentEnabled ?? true}
        refreshKey={[
          snapshot.semanticRecognition.processed7d,
          snapshot.semanticRecognition.high7d,
          snapshot.semanticRecognition.medium7d,
          snapshot.semanticRecognition.failures7d,
        ].join("/")}
      />
    </div>
  </section>
  );
};
