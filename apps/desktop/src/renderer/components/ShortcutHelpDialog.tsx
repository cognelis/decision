import { modifierKeyLabel } from "../keyboard.js";
import { ModalDialog } from "./ModalDialog.js";
import { SHORTCUTS as TODO_SHORTCUTS } from "./pages/todos/TodoShortcuts.js";

interface ShortcutHelpDialogProps {
  onClose(): void;
}

interface ShortcutRow {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

const shortcutGroups = (modifier: string): ShortcutGroup[] => [
  {
    title: "页面",
    rows: [
      // SURFACE_SHORTCUT_ORDER: seven pages, settings as ⌘8, then 提示词 as ⌘9.
      { keys: [`${modifier}1`, "…", `${modifier}9`], description: "切换页面（侧栏按钮上显示各自的快捷键）" },
      { keys: [`${modifier},`], description: "打开设置" },
      { keys: ["?"], description: "打开本速查表" },
      { keys: ["Esc"], description: "关闭弹窗" },
    ],
  },
  {
    title: "记录",
    rows: [
      { keys: [`${modifier}N`], description: "任意页面：主动记录决策、偏好或想法" },
      { keys: [`⇧${modifier}N`], description: "任意页面：快速添加待办事项，如「明天 !p1 写周报 @日常 #本周」" },
      { keys: [`${modifier}↩`], description: "理由面板：完成并保存理由" },
      { keys: [`${modifier}↩`], description: "待处理面板：记录并补充理由" },
      { keys: [`${modifier}L`], description: "待处理与理由面板：跳过，继续下一条" },
      { keys: [`${modifier}P`], description: "待处理与理由面板：记为偏好" },
      { keys: [`${modifier}D`], description: `待处理与理由面板、补充理由弹窗：忽略 / 不保留，先确认：Esc 取消，${modifier}↩ 确认` },
      { keys: [`${modifier}↩`], description: "补充理由 / 主动记录弹窗：保存" },
      { keys: [`${modifier}↩`], description: "发布为 PR 评论弹窗：发布" },
    ],
  },
  {
    title: "待办事项列表",
    rows: [
      // With focus on the items of a list or a view; not in a field, a menu or a dialog.
      ...TODO_SHORTCUTS.map((shortcut) => ({ keys: shortcut.keys.split(" "), description: shortcut.does })),
    ],
  },
  {
    title: "搜索",
    rows: [
      { keys: [`${modifier}K`], description: "快速跳转：决策、想法、笔记、原则、问答与评审一起搜，也可直达回顾与待处理，↩ 打开" },
      { keys: [`${modifier}F`], description: "在当前页面或弹窗中查找文字，↩ / ⇧↩ 切换，Esc 关闭" },
      { keys: ["/"], description: "知识、待办：聚焦搜索框" },
      { keys: ["Esc"], description: "搜索框内：清空关键词" },
      { keys: ["↓"], description: "搜索框：进入结果列表（决策搜索框也可按 ↩）" },
      { keys: ["↑", "↓"], description: "结果列表：移动到上/下一条，首条按 ↑ 回到搜索框" },
      { keys: ["←", "→"], description: "决策详情：逐条查看上一条/下一条（编辑中暂停）" },
      { keys: ["⌥↑", "⌥↓"], description: "待办清单：上移/下移选中的事项" },
      { keys: ["N", "P"], description: "PR 详情：跳到下一个/上一个评审问题（在搜索框里输入时不触发）" },
    ],
  },
];

export const ShortcutHelpDialog = ({ onClose }: ShortcutHelpDialogProps) => (
  <ModalDialog
    title="键盘快捷键"
    description="快捷键只在当前窗口内生效；在输入框中键入时不会误触发。"
    size="compact"
    onClose={onClose}
  >
    <div className="shortcut-help">
      {shortcutGroups(modifierKeyLabel()).map((group) => (
        <section
          key={group.title}
          className="shortcut-help-group"
          aria-label={group.title}
        >
          <h3>{group.title}</h3>
          <ul>
            {group.rows.map((row) => (
              <li key={`${group.title}-${row.description}`}>
                <span>{row.description}</span>
                <span className="shortcut-help-keys">
                  {row.keys.map((key, index) =>
                    key === "…" ? (
                      <em key={`${key}-${index}`} aria-hidden="true">
                        …
                      </em>
                    ) : (
                      <kbd key={`${key}-${index}`}>{key}</kbd>
                    ),
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  </ModalDialog>
);
