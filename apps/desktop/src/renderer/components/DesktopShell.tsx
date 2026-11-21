import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  pendingWorkTotal,
  rationalesToGive,
  type AppSnapshot,
  type DecisionApi,
  type DesktopPrimarySurface,
} from "../../shared/renderer-api.js";
import { modifierKeyLabel } from "../keyboard.js";
import { ActionIcon, IconButton } from "./IconButton.js";
import { focusPageHeading, pageFocusLost } from "./ModalDialog.js";
import {
  QuickJumpDialog,
  type QuickJumpApi,
  type QuickJumpPage,
} from "./QuickJumpDialog.js";
import {
  ActiveRecordDialog,
  type ActiveRecordApi,
  type ActiveRecordSaved,
} from "./pages/decisions/ActiveRecordDialog.js";
import { TodoQuickAddDialog } from "./pages/todos/TodoQuickAddDialog.js";
import { getTodoViewContext } from "./pages/todos/todo-quick-add-context.js";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog.js";
import { FindBar } from "./FindBar.js";

export type DesktopSurface = DesktopPrimarySurface | "task";

interface DesktopShellProps {
  snapshot: AppSnapshot;
  activeSurface: DesktopSurface;
  children: ReactNode;
  quickJumpApi: QuickJumpApi;
  recordApi: ActiveRecordApi;
  todoApi: Pick<DecisionApi, "listTodoLists" | "recordTodoList" | "updateTodoList">;
  /** Raised by a page that wants the manual record dialog, as ⌘N opens it. */
  recordRequest?: number;
  /** A PR review running, or finished while the reader was on another page. */
  reviewActivity?: "running" | "done" | null;
  /** Which step of a capture has the window (its review, a question's rationale, its save): each takes the last's place. */
  taskKey?: string | null;
  onNavigate(surface: DesktopPrimarySurface): void;
  onRecorded(result: ActiveRecordSaved): void;
  onOpenDecision(id: string): void;
  onOpenJournalEntry(id: string): void;
  onOpenPrinciple(id: string): void;
  onOpenPage?(page: QuickJumpPage): void;
  onOpenReview?(id: string): void;
  onOpenConversation?(id: string): void;
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

const PromptIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4 4.5h12v8.5H9l-3.5 3v-3H4Z" />
    <path d="M7 8l1.8 1.5L7 11M10.5 11H13" />
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

const AssistantIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 2.8a7.2 7.2 0 1 0 3.6 13.4L17 17l-.8-3.3A7.2 7.2 0 0 0 10 2.8Z" />
    <path d="M7.4 9.2h5.2M7.4 12h3.2" />
  </svg>
);

const ClientsIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="3" y="3.5" width="14" height="9.5" rx="2" />
    <path d="M7 16.5h6M10 13v3.5" />
  </svg>
);

const LinksIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m8 12 4-4M7 13l-1 1a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0M13 7l1-1a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0" />
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

const CodeIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m7 5-5 5 5 5m6-10 5 5-5 5" />
  </svg>
);

/** 待办: a list whose first line is ticked, the rest still to do. */
const TodoIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m3 5.3 1.4 1.4 2.5-2.7" />
    <path d="M9.5 5.5H17M9.5 10.5H17M9.5 15.5H17" />
    <rect x="3.2" y="9" width="3.2" height="3.2" rx="0.8" />
    <rect x="3.2" y="14" width="3.2" height="3.2" rx="0.8" />
  </svg>
);

const PlusIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M10 5v10M5 10h10" />
  </svg>
);

const SearchIcon = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="9" cy="9" r="5.2" />
    <path d="m12.9 12.9 3.4 3.4" />
  </svg>
);

const REVIEW_ACTIVITY = { running: "评审进行中", done: "有新的评审结果" } as const;

interface NavigationItem {
  surface: DesktopPrimarySurface;
  label: string;
  Icon: () => ReactNode;
}

const WORKSPACE_NAVIGATION: readonly NavigationItem[] = [
  { surface: "dashboard", label: "首页", Icon: DashboardIcon },
  { surface: "assistant", label: "问答", Icon: AssistantIcon },
  { surface: "decisions", label: "知识", Icon: DecisionLibraryIcon },
  // 页头仍叫「PR 评审」，侧栏只留「评审」：最长的一条标签原本一个人撑着整条
  // 导航的宽度，而那些像素每一页都要还回去。
  { surface: "pr-review", label: "评审", Icon: TaskIcon },
  { surface: "local-review", label: "本地审阅", Icon: CodeIcon },
  // agent 存下的调研结果与自己记下的事项，逐项跟进；不是首页的「待处理」（Paraself 自己的确认、补理由、复盘）。
  { surface: "todos", label: "待办", Icon: TodoIcon },
  { surface: "methodology", label: "方法论", Icon: MethodologyIcon },
  // 存着备用、随时复制给 agent 的提示词；只在这台电脑上，不进 Vault，也不被当作笔记召回。
  { surface: "prompts", label: "提示词", Icon: PromptIcon },
];

/**
 * 接入、模型、日志和通用偏好都是「把这台机器配好」，不是每天要去的地方。
 * 它们原本和五个工作区页面平起平坐地排在侧栏里，把常用入口挤到半屏以下。
 * 现在收进「设置」一个入口，进去之后由页内的次级导航分栏。
 */
export const SETTINGS_SECTIONS: readonly NavigationItem[] = [
  { surface: "settings", label: "通用", Icon: SettingsIcon },
  { surface: "clients", label: "接入", Icon: ClientsIcon },
  { surface: "connections", label: "链接", Icon: LinksIcon },
  { surface: "models", label: "模型", Icon: ModelsIcon },
  { surface: "activity", label: "日志", Icon: ActivityIcon },
];

const SETTINGS_ENTRY: NavigationItem = {
  surface: "settings",
  label: "设置",
  Icon: SettingsIcon,
};

/** 设置入口在侧栏里代表这些页面，所以其中任何一个都让它高亮。 */
export const SETTINGS_SURFACES: ReadonlySet<DesktopPrimarySurface> = new Set(
  SETTINGS_SECTIONS.map((item) => item.surface),
);

/**
 * Cmd/Ctrl+1 … Cmd/Ctrl+9. The first eight are what they were before 提示词 was added (the seven pages above it, then
 * 设置 as ⌘8), so no one's ⌘8 moved; 提示词, added later, takes ⌘9 although it sits above 设置 in the sidebar.
 */
export const SURFACE_SHORTCUT_ORDER: readonly DesktopPrimarySurface[] = [
  ...WORKSPACE_NAVIGATION.map((item) => item.surface).filter((surface) => surface !== "prompts"),
  SETTINGS_ENTRY.surface,
  "prompts",
];

/** The shell's own dialogs. Exactly one of them is on screen, or none. */
type ShellOverlay = "help" | "quick-jump" | "record" | "todo-quick-add";

/** A plain modifier chord, which is what makes it safe to use while typing. */
const isChord = (event: KeyboardEvent, key: string): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.shiftKey &&
  !event.altKey &&
  !event.isComposing &&
  event.key.toLowerCase() === key;

/** ⇧⌘N: 快速添加 a todo; ⌘N alone stays 主动记录. */
const isTodoQuickAddChord = (event: KeyboardEvent): boolean =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && !event.isComposing && event.key.toLowerCase() === "n";

const surfaceForShortcut = (
  event: KeyboardEvent,
): DesktopPrimarySurface | undefined => {
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.shiftKey ||
    event.altKey ||
    event.isComposing
  ) {
    return undefined;
  }
  if (event.key === ",") return "settings";
  if (!/^[1-9]$/u.test(event.key)) return undefined;
  return SURFACE_SHORTCUT_ORDER[Number(event.key) - 1];
};

export const DesktopShell = ({
  snapshot,
  activeSurface,
  children,
  quickJumpApi,
  recordApi,
  todoApi,
  recordRequest = 0,
  reviewActivity = null,
  taskKey = null,
  onNavigate,
  onRecorded,
  onOpenDecision,
  onOpenJournalEntry,
  onOpenPrinciple,
  onOpenPage,
  onOpenReview,
  onOpenConversation,
}: DesktopShellProps) => {
  const pendingRationales = rationalesToGive(snapshot);
  const pendingCount = pendingWorkTotal(snapshot);
  const navigationLocked = activeSurface === "task";
  const modifier = modifierKeyLabel();
  const pendingBreakdown =
    pendingCount === 0
      ? ""
      : snapshot.dashboard.organizationAutomatic ? ` · ${pendingCount} 项需要判断` : ` · ${pendingCount} 项待处理：待确认 ${snapshot.decisionCandidates.count} · 待补理由 ${pendingRationales} · 需复盘 ${snapshot.dashboard.reviewAttention}`;
  /**
   * One at a time, by construction. Three booleans could all be true, and a
   * shortcut fired while focus sat outside an open dialog would have done it.
   */
  const [collapsed, setCollapsed] = useState(true);
  const toggleSidebar = () => setCollapsed(previous => !previous);
  const [overlay, setOverlay] = useState<ShellOverlay | null>(null);
  const closeOverlay = (): void => setOverlay(null);
  // A short line after 快速添加 from a page that shows nothing of it; gone after a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  const announce = setNotice;
  useEffect(() => {
    if (recordRequest > 0) setOverlay("record");
  }, [recordRequest]);

  // A page reached by a jump (a recent decision, a first-run step, a settings section) took the place of the one
  // whose control was pressed, and focus went with it: the new page's title takes it, where Tab goes on from and
  // where a dialog opened next returns. Chosen in the sidebar, focus stays on the sidebar. So does each step of a
  // capture (the next question, the rationale after its review): left on the page, Tab started over at the sidebar
  // and a screen reader said nothing of the new question.
  const shownSurface = useRef(activeSurface);
  const shownTask = useRef(taskKey);
  useEffect(() => {
    if (shownSurface.current === activeSurface && shownTask.current === taskKey) return;
    shownSurface.current = activeSurface;
    shownTask.current = taskKey;
    if (pageFocusLost()) focusPageHeading();
  }, [activeSurface, taskKey]);

  // "?" opens the shortcut cheat sheet unless the user is typing somewhere.
  useEffect(() => {
    const handleHelpKey = (event: KeyboardEvent): void => {
      if (
        event.key !== "?" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return;
      }
      if (
        event.target instanceof HTMLElement &&
        event.target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]',
        ) !== null
      ) {
        return;
      }
      event.preventDefault();
      setOverlay("help");
    };
    window.addEventListener("keydown", handleHelpKey);
    return () => {
      window.removeEventListener("keydown", handleHelpKey);
    };
  }, []);

  useEffect(() => {
    if (navigationLocked) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      const surface = surfaceForShortcut(event);
      if (surface === undefined) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]') !== null
      ) {
        return;
      }
      event.preventDefault();
      if (surface !== activeSurface) onNavigate(surface);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeSurface, navigationLocked, onNavigate]);

  // Same lock as the sidebar: while a capture is waiting for an answer there is
  // nowhere to jump to, and nothing new to record, without abandoning it.
  useEffect(() => {
    if (navigationLocked) return;
    const handleWorkspaceKey = (event: KeyboardEvent): void => {
      const opening: ShellOverlay | null = isChord(event, "k")
        ? "quick-jump"
        : isChord(event, "n")
          ? "record"
          : isTodoQuickAddChord(event)
            ? "todo-quick-add"
            : null;
      if (opening === null) return;
      if (
        event.target instanceof Element &&
        event.target.closest('[role="dialog"]') !== null
      ) {
        return;
      }
      event.preventDefault();
      setOverlay(opening);
    };
    window.addEventListener("keydown", handleWorkspaceKey);
    return () => {
      window.removeEventListener("keydown", handleWorkspaceKey);
    };
  }, [navigationLocked]);

  const renderNavigationItem = ({ surface, label, Icon }: NavigationItem) => {
    const shortcut = SURFACE_SHORTCUT_ORDER.indexOf(surface) + 1;
    // 设置这一项代表这些页面，所以站在其中任何一个上它都算当前位置。
    const active =
      surface === "settings"
        ? SETTINGS_SURFACES.has(activeSurface as DesktopPrimarySurface)
        : activeSurface === surface;
    return (
      <IconButton tooltipSide="right"
        key={surface}
        aria-label={label}
        aria-description={surface === "dashboard" ? pendingBreakdown || undefined : surface === "pr-review" && reviewActivity ? REVIEW_ACTIVITY[reviewActivity] : undefined}
        type="button"
        className={`desktop-nav-item${active ? " active" : ""}`}
        aria-current={active ? "page" : undefined}
        aria-keyshortcuts={`Meta+${shortcut} Control+${shortcut}`}
        title={`${label}（${modifier}${shortcut}）${
          surface === "dashboard" ? pendingBreakdown : surface === "pr-review" && reviewActivity ? ` · ${REVIEW_ACTIVITY[reviewActivity]}` : ""
        }`}
        disabled={navigationLocked}
        onClick={() => onNavigate(surface)}
      >
        <Icon />
        <span>{label}</span>
        {surface === "dashboard" && pendingCount > 0 ? (
          <small>{pendingCount}</small>
        ) : null}
        {surface === "pr-review" && reviewActivity ? (
          <i className="desktop-nav-activity" data-state={reviewActivity} aria-hidden="true" />
        ) : null}
      </IconButton>
    );
  };

  return (
    <main className="desktop-app app-shell" data-sidebar-collapsed={collapsed}>
      <aside id="desktop-sidebar" className="desktop-sidebar drag-region">
        {/*
          两个全局命令原本压在侧栏最底下，长得跟「键盘快捷键」一样，是两行灰字。
          它们其实是这个 app 仅有的两个随时可用的动作，所以提到品牌下方、给上
          图标和边框——你第一眼看的地方，就是它们该在的地方。
        */}
        <div className="desktop-commands no-drag">
          <IconButton tooltipSide="right"
            type="button"
            className="desktop-shortcut-help desktop-new-record"
            aria-label="主动记录"
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+N Control+N"
            disabled={navigationLocked}
            title={`记录一条决策、偏好或想法（${modifier}N）`}
            onClick={() => setOverlay("record")}
          >
            <PlusIcon />
            <span>主动记录</span>
            <kbd aria-hidden="true">{`${modifier}N`}</kbd>
          </IconButton>

          <IconButton tooltipSide="right"
            type="button"
            className="desktop-shortcut-help desktop-quick-jump"
            aria-label="快速跳转"
            aria-haspopup="dialog"
            aria-keyshortcuts="Meta+K Control+K"
            disabled={navigationLocked}
            title={`同时搜索决策、笔记与原则（${modifier}K）`}
            onClick={() => setOverlay("quick-jump")}
          >
            <SearchIcon />
            <span>快速跳转</span>
            <kbd aria-hidden="true">{`${modifier}K`}</kbd>
          </IconButton>
        </div>

        <nav className="desktop-navigation no-drag" aria-label="主导航">
          {activeSurface === "task" ? (
            <div className="desktop-nav-item active task-item">
              <TaskIcon />
              <span>当前决策</span>
              <small>处理中</small>
            </div>
          ) : null}
          {WORKSPACE_NAVIGATION.map(renderNavigationItem)}
          {/* 配置和日常工作分开：一条线，而不是两个分组标题。 */}
          <span className="desktop-nav-divider" aria-hidden="true" />
          {renderNavigationItem(SETTINGS_ENTRY)}
        </nav>

        <div className="desktop-sidebar-actions no-drag">
          <IconButton tooltipSide="right" className="desktop-shortcut-help desktop-sidebar-toggle" aria-label={collapsed ? "展开菜单栏" : "收起菜单栏"} aria-expanded={!collapsed} aria-controls="desktop-sidebar" onClick={toggleSidebar}><ActionIcon name="panel" /><span>收起菜单栏</span></IconButton>
          <IconButton tooltipSide="right"
            type="button"
            className="desktop-shortcut-help desktop-help-sheet"
            aria-label="键盘快捷键"
            aria-haspopup="dialog"
            title="键盘快捷键（?）"
            onClick={() => setOverlay("help")}
          >
            <ActionIcon name="help" /><span>键盘快捷键</span>
          </IconButton>
        </div>

      </aside>

      <section className="desktop-stage">{children}</section>
      <FindBar />
      {overlay === "help" ? (
        <ShortcutHelpDialog onClose={closeOverlay} />
      ) : null}
      {overlay === "record" ? (
        <ActiveRecordDialog
          api={recordApi}
          onClose={closeOverlay}
          onSaved={(result) => {
            closeOverlay();
            // Saved from a page that shows none of this, so the only way to
            // confirm it landed is to arrive on the record.
            onRecorded(result);
          }}
        />
      ) : null}
      {overlay === "todo-quick-add" ? (
        <TodoQuickAddDialog
          api={todoApi}
          currentListId={getTodoViewContext()}
          onClose={closeOverlay}
          onAdded={(result) => announce(`已添加到「${result.list?.title ?? "待办"}」。`)}
        />
      ) : null}
      {notice === null ? null : <p className="todo-quick-add-notice" role="status">{notice}</p>}
      {overlay === "quick-jump" ? (
        <QuickJumpDialog
          api={quickJumpApi}
          vault={snapshot.vaultPath}
          onClose={closeOverlay}
          onOpenDecision={onOpenDecision}
          onOpenJournalEntry={onOpenJournalEntry}
          onOpenPrinciple={onOpenPrinciple}
          {...(onOpenPage === undefined ? {} : { onOpenPage })}
          {...(onOpenReview === undefined ? {} : { onOpenReview })}
          {...(onOpenConversation === undefined ? {} : { onOpenConversation })}
        />
      ) : null}
    </main>
  );
};
