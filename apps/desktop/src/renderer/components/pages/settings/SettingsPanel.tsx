import { useEffect, useRef, useState, type CSSProperties } from "react";

import {
  ACCENT_PRESET_IDS,
  ACCENT_PRESETS,
  THEME_PREFERENCES,
  isAccentPreset,
  type AccentPreference,
  type ThemePreference,
} from "../../../../shared/appearance.js";
import type {
  AppSnapshot,
  DecisionApi,
} from "../../../../shared/renderer-api.js";
import { DesktopPageHeader } from "../DesktopPageHeader.js";
import { SettingsSubnav } from "../SettingsSubnav.js";
import { keepSwitchFocus } from "../../../keyboard.js";

interface SettingsPanelProps {
  snapshot: AppSnapshot;
  api: DecisionApi;
}

const themeLabel: Record<ThemePreference, string> = {
  auto: "自动",
  light: "浅色",
  dark: "深色",
};

/** The card an action was taken in: its outcome is said there, under it, not in a corner of the page. */
type SettingsSection = "appearance" | "reminders" | "credentials" | "storage";
type SettingsAction = SettingsSection | "theme" | "accent" | "reveal" | "vault" | "index";

export const SettingsPanel = ({ snapshot, api }: SettingsPanelProps) => {
  const [messages, setMessages] = useState<Partial<Record<SettingsAction, { section: SettingsSection; text: string; error: boolean }>>>({});
  const [busy, setBusy] = useState<Partial<Record<SettingsAction, boolean>>>({});
  const pending = useRef(new Set<SettingsAction>());
  const customAccent = !isAccentPreset(snapshot.accent);
  const [customColor, setCustomColor] = useState(customAccent ? snapshot.accent : "#4d7c0f");
  // The custom colour waiting for the picker to settle: a preset chosen meanwhile drops it; leaving the page saves it.
  const pendingCustom = useRef<{ timer: ReturnType<typeof setTimeout>; color: AccentPreference } | null>(null);
  const dropPendingCustom = (): void => {
    if (pendingCustom.current !== null) clearTimeout(pendingCustom.current.timer);
    pendingCustom.current = null;
  };
  useEffect(() => () => {
    const pending = pendingCustom.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    void api.setAccent(pending.color).catch(() => undefined);
  }, [api]);

  const run = async <T,>(
    section: SettingsSection,
    operation: () => Promise<T>,
    success: string | ((result: T) => string),
    action: SettingsAction = section,
  ): Promise<void> => {
    if (pending.current.has(action)) return;
    pending.current.add(action);
    setBusy((current) => ({ ...current, [action]: true }));
    setMessages(({ [action]: _previous, ...rest }) => rest);
    try {
      // null is a choice cancelled (a folder not picked): nothing happened, so nothing is said.
      const result = await operation();
      if (result !== null) setMessages((current) => ({ ...current, [action]: { section, text: typeof success === "string" ? success : success(result), error: false } }));
    } catch (error) {
      setMessages((current) => ({ ...current, [action]: { section, text: error instanceof Error ? error.message : String(error), error: true } }));
    } finally {
      pending.current.delete(action);
      setBusy(({ [action]: _finished, ...rest }) => rest);
    }
  };
  const status = (section: SettingsSection) => Object.entries(messages).map(([action, message]) =>
    message.section !== section ? null : <p key={action} className={message.error ? "settings-status error" : "settings-status"} role="status">{message.text}</p>,
  );

  return (
    <section
      className="desktop-view settings-panel"
      role="region"
      aria-label="通用设置"
    >
      <DesktopPageHeader
        eyebrow="应用偏好"
        title="通用设置"
        description="外观、复盘提醒、密钥存储与数据索引。"
        meta="本机"
        metaLabel="数据存储"
      />
      <SettingsSubnav active="settings" api={api} />

      <div className="desktop-page-scroll general-settings-content">
        <section
          className="settings-card general-card"
          aria-labelledby="appearance-title"
        >
          <header className="settings-card-header">
            <div>
              <h2 id="appearance-title">外观</h2>
              <span>主题会立即应用到整个应用</span>
            </div>
          </header>
          <div className="general-setting-block appearance-setting-block">
            <div>
              <strong>颜色主题</strong>
              <p>跟随系统，或固定使用浅色、深色外观。</p>
            </div>
            <div className="theme-segment" role="group" aria-label="外观">
              {THEME_PREFERENCES.map((theme) => (
                <button
                  key={theme}
                  aria-pressed={snapshot.theme === theme}
                  disabled={busy.theme}
                  onClick={(event) =>
                    keepSwitchFocus(event.currentTarget, run("appearance", () => api.setTheme(theme), "主题已更新。", "theme"))
                  }
                >
                  {themeLabel[theme]}
                </button>
              ))}
            </div>
          </div>
          <div className="general-setting-block appearance-setting-block accent-setting-block">
            <div>
              <strong>主题色</strong>
              <p>只用在需要你处理的地方：待处理计数、当前的主要操作。浅色、深色各有一档配好对比度的色值；自定义的颜色会自动调深或调浅，保证文字看得清。</p>
            </div>
            <div className="accent-swatches" role="group" aria-label="主题色">
              {ACCENT_PRESET_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className="accent-swatch"
                  aria-pressed={snapshot.accent === id}
                  disabled={busy.accent}
                  style={{ "--swatch-light": ACCENT_PRESETS[id].light, "--swatch-dark": ACCENT_PRESETS[id].dark } as CSSProperties}
                  onClick={(event) => {
                    dropPendingCustom();
                    keepSwitchFocus(event.currentTarget, run("appearance", () => api.setAccent(id), "主题色已更新。", "accent"));
                  }}
                >
                  <i aria-hidden="true" />
                  <span>{ACCENT_PRESETS[id].label}</span>
                </button>
              ))}
              <label
                className="accent-swatch accent-swatch-custom"
                data-pressed={customAccent ? "true" : undefined}
                style={{ "--swatch-light": customColor, "--swatch-dark": customColor } as CSSProperties}
              >
                {/* Saved once the colour stops changing: the picker reports every step of a drag. */}
                <input
                  type="color"
                  aria-label="自定义主题色"
                  disabled={busy.accent}
                  value={customColor}
                  onChange={(event) => {
                    const color = event.currentTarget.value.toLowerCase() as AccentPreference;
                    setCustomColor(color);
                    dropPendingCustom();
                    pendingCustom.current = {
                      color,
                      timer: setTimeout(() => {
                        pendingCustom.current = null;
                        void run("appearance", () => api.setAccent(color), "主题色已更新。", "accent");
                      }, 250),
                    };
                  }}
                />
                <i aria-hidden="true" />
                <span>自定义</span>
              </label>
            </div>
          </div>
          {status("appearance")}
        </section>

        <section
          className="settings-card general-card"
          aria-labelledby="reminders-title"
        >
          <header className="settings-card-header">
            <div>
              <h2 id="reminders-title">复盘提醒</h2>
              <span>到期的决策会在本机发出一条系统通知</span>
            </div>
          </header>
          <div className="general-setting-block">
            <div>
              <strong>到期通知</strong>
              <p>
                同一条决策的同一个到期日只提醒一次。关闭后不再发出通知，托盘仍会显示几条需复盘。
              </p>
            </div>
            <label className="provider-switch">
              <input type="checkbox" role="switch" aria-label="复盘提醒"
                checked={snapshot.reviewRemindersEnabled ?? true}
                disabled={busy.reminders}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  keepSwitchFocus(event.currentTarget, run(
                    "reminders",
                    () => api.setReviewRemindersEnabled(enabled),
                    enabled ? "已开启复盘提醒。" : "已关闭复盘提醒。",
                  ));
                }}
              />
            </label>
          </div>
          {status("reminders")}
        </section>

        <section className="settings-card general-card" aria-labelledby="credentials-title">
          <header className="settings-card-header">
            <div><h2 id="credentials-title">密钥存储</h2><span>模型 API 密钥与 PR 访问令牌共用此设置</span></div>
          </header>
          <div className="general-setting-block">
            <div>
              <strong>本地密钥模式</strong>
              <p id="local-credentials-description">开启后，密钥经混淆保存在本机应用目录，文件里看不到原文，扫描工具也认不出；这不是加密，能读到这个文件和本应用的人可以还原。文件仅限当前用户读写，不再调用系统钥匙串。切换会迁移已有密钥，首次迁移可能需要系统密码；关闭后恢复系统加密。</p>
            </div>
            <label className="provider-switch">
              <input type="checkbox" role="switch" aria-label="本地密钥模式"
                aria-describedby="local-credentials-description"
                checked={snapshot.localCredentialsEnabled ?? false}
                aria-checked={snapshot.localCredentialsEnabled ?? false}
                disabled={busy.credentials}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  keepSwitchFocus(event.currentTarget, run(
                    "credentials",
                    () => api.setLocalCredentialsEnabled(enabled),
                    enabled ? "已开启本地密钥模式。" : "已恢复系统加密。",
                  ));
                }}
              />
            </label>
          </div>
          {status("credentials")}
        </section>

        <section
          className="settings-card general-card"
          aria-labelledby="storage-title"
        >
          <header className="settings-card-header">
            <div>
              <h2 id="storage-title">数据与索引</h2>
              <span>Markdown 是事实源，索引可以随时重建</span>
            </div>
          </header>
          <div className="general-setting-block storage-setting-block">
            <div>
              <strong>Obsidian 仓库</strong>
              <p>决策 Markdown 的保存位置</p>
            </div>
            <code className="path-value">
              {snapshot.vaultPath ?? "尚未选择仓库"}
            </code>
            <div className="storage-setting-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy.reveal || snapshot.vaultPath === null}
                onClick={(event) =>
                  keepSwitchFocus(event.currentTarget, run("storage", async () => {
                    // A path printed on screen is not a path you can reach;
                    // this is the one folder worth backing up by hand.
                    if (!(await api.revealVault())) {
                      throw new Error("没有找到这个仓库目录，它可能已被移动。");
                    }
                  }, "已在文件管理器中显示仓库。", "reveal"))
                }
              >
                在文件管理器中显示
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy.vault}
                onClick={(event) =>
                  keepSwitchFocus(event.currentTarget, run("storage", () => api.chooseVault(), "仓库已更新，重启后生效。", "vault"))
                }
              >
                更换仓库
              </button>
            </div>
          </div>
          <div className="general-setting-block index-setting-block">
            <div>
              <strong>决策索引</strong>
              <p>用于搜索和统计决策 Markdown，可以从 Markdown 恢复</p>
              {snapshot.health.indexMessage === undefined ? null : (
                <p className="error-message">{snapshot.health.indexMessage}</p>
              )}
            </div>
            <span className={`inline-health ${snapshot.health.index}`}>
              {snapshot.health.index === "healthy" ? "索引正常" : "需要关注"}
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={busy.index}
              onClick={(event) =>
                keepSwitchFocus(event.currentTarget, run(
                  "storage",
                  () => api.rebuildIndex(),
                  (report) => report.diagnostics.length === 0
                    ? `已从 Markdown 重建决策索引，共 ${report.indexedCount} 条。`
                    : `已从 Markdown 重建决策索引，共 ${report.indexedCount} 条；${report.diagnostics.length} 处需要处理，见上方说明。`,
                  "index",
                ))
              }
            >
              重建决策索引
            </button>
          </div>
          {status("storage")}
        </section>
      </div>
    </section>
  );
};
