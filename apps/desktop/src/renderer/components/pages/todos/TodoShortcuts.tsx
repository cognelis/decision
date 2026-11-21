/** The keys that work with focus on the items, as the footer line and the keyboard cheat sheet (「?」) list them. */
export const SHORTCUTS: readonly { keys: string; does: string; short?: string }[] = [
  { keys: "↑ ↓", does: "移动焦点到上一项 / 下一项", short: "移动" },
  { keys: "⇧↑ ⇧↓", does: "扩展选择", short: "扩选" },
  { keys: "空格", does: "选中 / 取消选中焦点项", short: "选中" },
  { keys: "↩", does: "打开详情", short: "详情" },
  { keys: "E", does: "弹出状态菜单", short: "状态" },
  { keys: "P", does: "弹出优先级菜单", short: "优先级" },
  { keys: "M", does: "移到其它清单…（已选中的一并移）", short: "移到…" },
  { keys: "⌫", does: "删除（先确认；已选中的一并删）", short: "删除" },
  { keys: "Esc", does: "取消选择，或关闭弹层、详情" },
  { keys: "⌘A", does: "选中当前列表的全部事项" },
];

/** The footer line under the items: the keys that matter most. */
export const ShortcutHints = () => (
  <p className="todo-keys" aria-label="快捷键">
    {SHORTCUTS.filter((shortcut) => shortcut.short !== undefined).map((shortcut) => (
      <span key={shortcut.keys}><kbd>{shortcut.keys}</kbd> {shortcut.short}</span>
    ))}
    <span><kbd>?</kbd> 全部快捷键</span>
  </p>
);
