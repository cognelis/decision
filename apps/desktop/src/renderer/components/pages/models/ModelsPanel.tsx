import type {
  AppSnapshot,
  DecisionApi,
} from "../../../../shared/renderer-api.js";
import { ModelProviderPanel } from "../../ModelProviderPanel.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";

interface ModelsPanelProps {
  snapshot: AppSnapshot;
  api: DecisionApi;
}

const availabilityLabel: Record<
  AppSnapshot["semanticRecognition"]["availability"],
  string
> = {
  available: "可用",
  loading: "正在检查",
  device_not_eligible: "Apple 智能当前不可用",
  apple_intelligence_disabled: "Apple Intelligence 未开启",
  assets_unavailable: "模型资源未就绪",
  model_missing: "模型未准备",
  checksum_failed: "模型校验失败",
  runtime_unavailable: "暂时不可用，将自动重试",
  helper_missing: "本地组件缺失",
  unavailable: "不可用",
};

const modeLabel: Record<AppSnapshot["semanticRecognition"]["mode"], string> = {
  trace: "跟踪模式",
  shadow: "影子模式",
  disagreement_review: "分歧审查",
  hybrid: "混合模式",
};

export const ModelsPanel = ({ snapshot, api }: ModelsPanelProps) => {
  const recognition = snapshot.semanticRecognition;
  const available = recognition.availability === "available";
  return (
    <section
      className="desktop-view models-panel"
      role="region"
      aria-label="模型"
    >
      <DesktopPageHeader
        eyebrow="智能能力"
        title="模型"
        description="查看当前识别引擎，并按优先级管理本地客户端与远程后端。"
        meta={available ? "在线" : "注意"}
        metaLabel="当前状态"
      />

      <div className="desktop-page-scroll model-page-content">
        <section
          className="recognition-overview"
          aria-labelledby="recognition-title"
        >
          <div className="recognition-overview-heading">
            <span className={`health-dot ${available ? "healthy" : ""}`} />
            <div>
              <span>当前识别引擎</span>
              <h2 id="recognition-title">{recognition.providerLabel}</h2>
            </div>
          </div>
          <dl>
            <div>
              <dt>可用性</dt>
              <dd>{availabilityLabel[recognition.availability]}</dd>
            </div>
            <div>
              <dt>运行模式</dt>
              <dd>{modeLabel[recognition.mode]}</dd>
            </div>
            <div>
              <dt>近 7 天处理</dt>
              <dd>{recognition.processed7d}</dd>
            </div>
          </dl>
        </section>

        <ModelProviderPanel api={api} />
      </div>
    </section>
  );
};
