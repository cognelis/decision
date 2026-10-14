export interface TrayImageLike {
  setTemplateImage(template: boolean): void;
}

export interface TrayLike<Menu> {
  setTitle(title: string): void;
  setToolTip(toolTip: string): void;
  setContextMenu(menu: Menu): void;
}

export interface TrayMenuItem {
  accessibilityLabel?: string;
  accelerator?: string;
  label?: string;
  sublabel?: string;
  type?: "separator";
  click?: () => void;
}

export interface DisposableTray {
  destroy(): void;
}

export class TrayLifecycle<TrayType extends DisposableTray> {
  #tray: TrayType | null = null;

  attach(tray: TrayType): TrayType {
    this.dispose();
    this.#tray = tray;
    return tray;
  }

  dispose(): void {
    this.#tray?.destroy();
    this.#tray = null;
  }
}

interface ConfigureTrayOptions<Menu> {
  tray: TrayLike<Menu>;
  image: TrayImageLike;
  buildMenu(template: TrayMenuItem[]): Menu;
  /** The home page's 待办 (pendingWorkTotal), reviews included. */
  pendingCount: number;
  /** Those of them that are reviews, named so the tooltip can say one came due. */
  reviewDueCount?: number;
  openDashboard(): void;
  openSettings(): void;
  quit(): void;
}

export const configureTray = <Menu>(
  options: ConfigureTrayOptions<Menu>,
): Menu => {
  // Due reviews are named separately: a merged count cannot tell the reader
  // that a decision they scheduled has come due, which is the one thing the
  // tray is in a position to say before the app is even open. Named within the home page's total, as the home
  // page names them: counted on top of a smaller one as 待复盘, the two said different things of one moment.
  const reviews = options.reviewDueCount ?? 0;
  const workload =
    options.pendingCount === 0
      ? "暂无待办"
      : `${options.pendingCount} 项待办${reviews > 0 ? `，其中 ${reviews} 条需复盘` : ""}`;
  options.image.setTemplateImage(true);
  options.tray.setTitle("");
  options.tray.setToolTip(`Decision · ${workload}`);
  const menu = options.buildMenu([
    {
      label: "首页",
      sublabel: workload,
      accessibilityLabel: `打开首页，${workload}`,
      click: options.openDashboard,
    },
    {
      label: "设置…",
      accessibilityLabel: "打开设置",
      accelerator: "CommandOrControl+,",
      click: options.openSettings,
    },
    { type: "separator" },
    {
      label: "退出",
      accelerator: "CommandOrControl+Q",
      click: options.quit,
    },
  ]);
  options.tray.setContextMenu(menu);
  return menu;
};
