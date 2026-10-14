import { useState } from "react";

import type { CaptureClassifier } from "../../../../shared/capture-classifier.js";
import type {
  AppSnapshot,
  DecisionApi,
} from "../../../../shared/renderer-api.js";
import { ModelProviderPanel } from "../../ModelProviderPanel.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { SettingsSubnav } from "../SettingsSubnav.js";

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
  rules_only: "只用规则",
};

export const ModelsPanel = ({ snapshot, api }: ModelsPanelProps) => {
  const [classifierError, setClassifierError] = useState<string | null>(null);
  const recognition = snapshot.semanticRecognition;
  const unavailableModels = recognition.unavailableModels;
  const available = recognition.availability === "available" && unavailableModels === undefined;
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
      <SettingsSubnav active="models" api={api} />

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
          {unavailableModels === undefined ? null : (
            <p className="recognition-unavailable">
              没有可用的模型，正在只用规则
              {unavailableModels.length === 0
                ? "。"
                : `：${unavailableModels
                    .map((model) => `${model.providerLabel}（${availabilityLabel[model.availability]}）`)
                    .join("、")}。`}
            </p>
          )}
          <label className="recognition-classifier">
            <span>采集分类</span>
            <select
              aria-label="采集分类使用的引擎"
              value={snapshot.captureClassifier ?? "rules"}
              onChange={(event) => {
                setClassifierError(null);
                // Not saved, the choice went back to what it was with nothing said.
                api
                  .setCaptureClassifier(event.target.value as CaptureClassifier)
                  .catch((caught: unknown) =>
                    setClassifierError(caught instanceof Error ? caught.message : String(caught)),
                  );
              }}
            >
              <option value="rules">只用规则，不调用模型</option>
              <option value="models">规则加模型，按下方后端顺序</option>
            </select>
            <small>
              每一轮对话都会走这里，无需你发起。模型只在选择第二项时参与，其余用途（问答、方法论提炼、草案）始终按下方顺序调用。
            </small>
            {classifierError === null ? null : (
              <p className="error-message" role="alert">
                采集分类没能保存：{classifierError}
              </p>
            )}
          </label>
        </section>

        <ModelProviderPanel api={api} />
      </div>
    </section>
  );
};
