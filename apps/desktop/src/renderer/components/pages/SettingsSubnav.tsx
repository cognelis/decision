import type {
  DecisionApi,
  DesktopPrimarySurface,
} from "../../../shared/renderer-api.js";
import { SETTINGS_SECTIONS } from "../DesktopShell.js";

interface SettingsSubnavProps {
  active: DesktopPrimarySurface;
  api: Pick<DecisionApi, "openSurface">;
}

/** 设置各分区共用的页内导航。 */
export const SettingsSubnav = ({ active, api }: SettingsSubnavProps) => (
  <nav className="settings-subnav" aria-label="设置分区">
    {SETTINGS_SECTIONS.map(({ surface, label, Icon }) => {
      const current = surface === active;
      return (
        <button
          key={surface}
          type="button"
          className="settings-subnav-item"
          aria-current={current ? "page" : undefined}
          onClick={() => {
            if (current) return;
            void api.openSurface(surface);
          }}
        >
          <Icon />
          <span>{label}</span>
        </button>
      );
    })}
  </nav>
);
