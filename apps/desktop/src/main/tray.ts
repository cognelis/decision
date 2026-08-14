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
  pendingCount: number;
  openDashboard(): void;
  openSettings(): void;
  quit(): void;
}

export const configureTray = <Menu>(
  options: ConfigureTrayOptions<Menu>,
): Menu => {
  const workload =
    options.pendingCount === 0
      ? "暂无待办"
      : `${options.pendingCount} 项待办`;
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
