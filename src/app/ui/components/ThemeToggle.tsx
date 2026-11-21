import { Dropdown } from "antd";
import type { Copy } from "../i18n.js";
import type { ResolvedTheme, ThemeMode } from "../theme.js";
import { ThemeDarkIcon, ThemeLightIcon, ThemeSystemIcon } from "./icons.js";

interface Props {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  copy: Copy;
  onChange: (mode: ThemeMode) => void;
  /** 附加到触发按钮的类名，供外壳与管理后台分别定位。 */
  className?: string;
}

/** 主题切换按钮：在跟随系统、浅色、深色之间切换，图标显示当前实际生效的主题。 */
export function ThemeToggle({ mode, resolved, copy, onChange, className = "sidebar-theme" }: Props) {
  const items = [
    { key: "system", icon: <ThemeSystemIcon />, label: copy.themeSystem },
    { key: "light", icon: <ThemeLightIcon />, label: copy.themeLight },
    { key: "dark", icon: <ThemeDarkIcon />, label: copy.themeDark },
  ];
  return (
    <Dropdown
      placement="bottomRight"
      trigger={["click"]}
      menu={{
        selectedKeys: [mode],
        items,
        onClick: ({ key }) => onChange(key === "light" || key === "dark" ? key : "system"),
      }}
    >
      <button type="button" className={className} aria-label={copy.themeLabel} title={copy.themeLabel}>
        {resolved === "dark" ? <ThemeDarkIcon /> : <ThemeLightIcon />}
      </button>
    </Dropdown>
  );
}
