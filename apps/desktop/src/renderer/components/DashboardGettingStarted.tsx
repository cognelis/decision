import { useEffect, useState } from "react";

import type {
  AppSnapshot,
  DecisionApi,
  DesktopPrimarySurface,
} from "../../shared/renderer-api.js";
import { modifierKeyLabel } from "../keyboard.js";

type SetupApi = Pick<DecisionApi, "listAssistantModels" | "listPrConnections">;

const CheckIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

/**
 * The home page before anything is recorded: four steps in place of zeros and
 * empty cards, each saying what it is for and leading straight there. The first
 * decision, captured or written by hand, brings the usual home page back.
 */
export const DashboardGettingStarted = ({
  api,
  integrationStatus,
  onNavigate,
  onRecord,
}: {
  api: SetupApi;
  integrationStatus: AppSnapshot["integrationStatus"];
  onNavigate(surface: DesktopPrimarySurface): void;
  onRecord(): void;
}) => {
  const [models, setModels] = useState(0);
  const [connections, setConnections] = useState(0);

  useEffect(() => {
    let active = true;
    // Optional steps only: a failed read just leaves them open.
    void api.listAssistantModels().then(
      (found) => { if (active) setModels(found.length); },
      () => undefined,
    );
    void api.listPrConnections().then(
      (found) => { if (active) setConnections(found.length); },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [api]);

  const clients = [
    integrationStatus.claudeCode === "installed" ? "Claude Code" : null,
    integrationStatus.codex === "installed" ? "Codex" : null,
  ].filter((name) => name !== null);
  const steps = [
    {
      title: "接入 Claude Code 或 Codex",
      body: "安装 Hook 后，对话里做出的选择会自动成为待确认的候选，结束时弹出理由面板。",
      optional: false,
      done: clients.length > 0,
      doneText: `已接入 ${clients.join(" 与 ")}`,
      action: clients.length > 0 ? "管理接入" : "前往接入",
      run: () => onNavigate("clients"),
    },
    {
      title: "记下第一条决策",
      body: `不必等自动捕获：按 ${modifierKeyLabel()}N 写下正在权衡的选择、理由和打算什么时候回看。`,
      optional: false,
      done: false,
      doneText: "",
      action: "主动记录",
      run: onRecord,
    },
    {
      title: "选择回答模型",
      body: "问答、方法论提炼和 PR 评审会用到；可以用本机模型，也可以接入远程服务。",
      optional: true,
      done: models > 0,
      doneText: `${models} 个模型可用`,
      action: models > 0 ? "管理模型" : "查看模型",
      run: () => onNavigate("models"),
    },
    {
      title: "连接代码平台",
      body: "接入 GitHub、GitLab 或 Bitbucket，在“评审”里结合历史决策审 PR。",
      optional: true,
      done: connections > 0,
      doneText: `已连接 ${connections} 个平台`,
      action: connections > 0 ? "管理链接" : "添加链接",
      run: () => onNavigate("connections"),
    },
  ];
  // The one step that moves things forward gets the accent.
  const next = steps.findIndex((step) => !step.done && !step.optional);
  const doneCount = steps.filter((step) => step.done).length;

  return (
    <section
      className="dashboard-start"
      aria-labelledby="dashboard-start-title"
    >
      <div className="dashboard-start-intro">
        <h2 id="dashboard-start-title">开始使用 Decision</h2>
        <p>
          Decision
          从你和 AI 编程助手的对话里捕获做过的选择，帮你补上理由，到期回看结果，再把经验沉淀成可复用的原则。先完成下面两步，第一条决策就会出现在这里。
        </p>
        <div
          className="dashboard-start-progress"
          role="progressbar"
          aria-label="开始使用进度"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={doneCount}
          aria-valuetext={`已完成 ${doneCount} / ${steps.length}`}
        >
          {steps.map((step) => (
            <span key={step.title} data-done={step.done || undefined} />
          ))}
        </div>
      </div>
      <ol className="dashboard-start-steps" aria-label="开始使用的步骤">
        {steps.map((step, index) => (
          <li key={step.title} data-done={step.done || undefined}>
            <span className="dashboard-start-marker">
              {step.done ? (
                <>
                  <CheckIcon />
                  <span className="sr-only">已完成</span>
                </>
              ) : (
                index + 1
              )}
            </span>
            <div className="dashboard-start-copy">
              <strong>
                {step.title}
                {step.optional ? (
                  <span className="dashboard-start-tag">可选</span>
                ) : null}
              </strong>
              <p>{step.body}</p>
            </div>
            <div className="dashboard-start-action">
              {step.done ? (
                <>
                  <span className="dashboard-start-done">{step.doneText}</span>
                  <button type="button" className="text-button" onClick={step.run}>
                    {step.action}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={index === next ? "primary-button" : "secondary-button"}
                  onClick={step.run}
                >
                  {step.action}
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>
      <p className="dashboard-start-foot">
        第一条决策记下后，这里会换成待确认、待补理由、复盘收件箱和最近决策。
      </p>
    </section>
  );
};
