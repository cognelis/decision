import type {
  AppSnapshot,
  DecisionApi,
} from "../../../../shared/renderer-api.js";
import { ModelTracePanel } from "../../ModelTracePanel.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";

interface ActivityPanelProps {
  snapshot: AppSnapshot;
  api: DecisionApi;
}

export const ActivityPanel = ({ snapshot, api }: ActivityPanelProps) => (
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
    <div className="desktop-page-scroll activity-page-content">
      <section
        className="settings-card activity-recognition-card"
        aria-labelledby="activity-recognition-title"
      >
        <header className="settings-card-header">
          <div>
            <span>近 7 天</span>
            <h2 id="activity-recognition-title">识别概览</h2>
          </div>
        </header>
        <dl className="activity-recognition-metrics">
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

      <ModelTracePanel
        api={api}
        contentEnabled={snapshot.modelTraceContentEnabled ?? true}
      />
    </div>
  </section>
);
