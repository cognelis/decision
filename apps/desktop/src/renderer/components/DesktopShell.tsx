import type { ReactNode } from "react";

import type {
  AppSnapshot,
  DesktopPrimarySurface,
} from "../../shared/renderer-api.js";
import { BrandIcon } from "./BrandIcon.js";

export type DesktopSurface = DesktopPrimarySurface | "task";

interface DesktopShellProps {
  snapshot: AppSnapshot;
  activeSurface: DesktopSurface;
  children: ReactNode;
  onNavigate(surface: DesktopPrimarySurface): void;
}

const DashboardIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="2.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="2.5" width="6" height="6" rx="1.5" />
    <rect x="2.5" y="11.5" width="6" height="6" rx="1.5" />
    <rect x="11.5" y="11.5" width="6" height="6" rx="1.5" />
  </svg>
);

const DecisionLibraryIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4 3.5h12v13H4z" />
    <path d="M7 7h6M7 10h6M7 13h4" />
  </svg>
);

const MethodologyIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 17V9" />
    <path d="M10 11c-3.8 0-6-2.1-6-5.5 3.8 0 6 1.7 6 5.5Z" />
    <path d="M10 9.5c3.8 0 6-2.1 6-5.5-3.8 0-6 1.7-6 5.5Z" />
  </svg>
);

const SettingsIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 5.5h14M6.5 10h7M4.5 14.5h11" />
    <circle cx="7" cy="5.5" r="1.6" />
    <circle cx="12.5" cy="10" r="1.6" />
    <circle cx="9" cy="14.5" r="1.6" />
  </svg>
);

const ClientsIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="3" y="3.5" width="14" height="9.5" rx="2" />
    <path d="M7 16.5h6M10 13v3.5" />
  </svg>
);

const ModelsIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 2.7 16.3 6v8L10 17.3 3.7 14V6L10 2.7Z" />
    <circle cx="10" cy="10" r="2.4" />
    <path d="M10 2.7V7.5M16.3 6l-4.2 2.3M3.7 6l4.2 2.3" />
  </svg>
);

const ActivityIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 10h3l1.7-4 3.1 8 1.8-4H17" />
  </svg>
);

const TaskIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M5 3.5h10a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5Z" />
    <path d="m6.5 10 2.1 2.1 4.9-5" />
  </svg>
);

export const DesktopShell = ({
  snapshot,
  activeSurface,
  children,
  onNavigate,
}: DesktopShellProps) => {
  const pendingCount =
    snapshot.decisionCandidates.count +
    snapshot.pendingRationales.length +
    snapshot.dashboard.reviewAttention;
  const navigationLocked = activeSurface === "task";
  const healthy =
    snapshot.health.index === "healthy" &&
    snapshot.health.recovery === "healthy";

  return (
    <main className="desktop-app app-shell">
      <aside className="desktop-sidebar drag-region">
        <div className="desktop-brand">
          <BrandIcon className="desktop-brand-icon" />
          <div>
            <strong>Decision</strong>
            <span>决策平台</span>
          </div>
        </div>

        <nav className="desktop-navigation no-drag" aria-label="主导航">
          {activeSurface === "task" ? (
            <div className="desktop-nav-item active task-item">
              <TaskIcon />
              <span>当前决策</span>
              <small>处理中</small>
            </div>
          ) : null}
          <span className="desktop-nav-section-label">工作区</span>
          <button
            type="button"
            className={`desktop-nav-item${
              activeSurface === "dashboard" ? " active" : ""
            }`}
            aria-current={activeSurface === "dashboard" ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => onNavigate("dashboard")}
          >
            <DashboardIcon />
            <span>首页</span>
            {pendingCount > 0 ? <small>{pendingCount}</small> : null}
          </button>
          <button
            type="button"
            className={`desktop-nav-item${
              activeSurface === "decisions" ? " active" : ""
            }`}
            aria-current={activeSurface === "decisions" ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => onNavigate("decisions")}
          >
            <DecisionLibraryIcon />
            <span>决策库</span>
          </button>
          <button
            type="button"
            className={`desktop-nav-item${
              activeSurface === "methodology" ? " active" : ""
            }`}
            aria-current={activeSurface === "methodology" ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => onNavigate("methodology")}
          >
            <MethodologyIcon />
            <span>方法论</span>
          </button>
          <span className="desktop-nav-section-label">管理</span>
          <button
            type="button"
            className={`desktop-nav-item${
              activeSurface === "clients" ? " active" : ""
            }`}
            aria-current={activeSurface === "clients" ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => onNavigate("clients")}
          >
            <ClientsIcon />
            <span>接入</span>
          </button>
          <button
            type="button"
            className={`desktop-nav-item${
              activeSurface === "models" ? " active" : ""
            }`}
            aria-current={activeSurface === "models" ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => onNavigate("models")}
          >
            <ModelsIcon />
            <span>模型</span>
          </button>
          <button
            type="button"
            className={`desktop-nav-item${
              activeSurface === "activity" ? " active" : ""
            }`}
            aria-current={activeSurface === "activity" ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => onNavigate("activity")}
          >
            <ActivityIcon />
            <span>日志</span>
          </button>
          <button
            type="button"
            className={`desktop-nav-item${
              activeSurface === "settings" ? " active" : ""
            }`}
            aria-current={activeSurface === "settings" ? "page" : undefined}
            disabled={navigationLocked}
            onClick={() => onNavigate("settings")}
          >
            <SettingsIcon />
            <span>设置</span>
          </button>
        </nav>

        <div className="desktop-runtime-status">
          <span
            className={`health-dot ${healthy ? "healthy" : "attention"}`}
            aria-hidden="true"
          />
          <div>
            <strong>{snapshot.semanticRecognition.providerLabel}</strong>
            <span>{healthy ? "本地服务正常" : "需要关注"}</span>
          </div>
        </div>
      </aside>

      <section className="desktop-stage">{children}</section>
    </main>
  );
};
