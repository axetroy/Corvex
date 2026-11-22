import type { Copy } from "../i18n.js";
import { useTurnNotifications } from "../useTurnNotifications.js";
import { BellIcon } from "./icons.js";

interface Props {
  copy: Copy;
  className?: string;
}

/** 侧边栏桌面通知开关：点击申请浏览器权限，之后可随时开关。 */
export function NotificationToggle({ copy, className }: Props) {
  const { permission, enabled, toggle } = useTurnNotifications();
  const label = permission === "denied" ? copy.notificationDenied
    : enabled ? copy.notificationEnabled
    : permission === "unsupported" ? copy.notificationUnsupported
    : copy.notificationEnable;

  return (
    <button
      type="button"
      className={`notification-toggle${enabled ? " is-enabled" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
      disabled={permission === "denied" || permission === "unsupported"}
      onClick={() => void toggle()}
    >
      <BellIcon />
    </button>
  );
}
