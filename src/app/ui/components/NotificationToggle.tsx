import type { Copy } from "../lib/i18n.js";
import { useTurnNotifications } from "../lib/useTurnNotifications.js";
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
      className={`notification-toggle${enabled ? " is-enabled" : ""}${permission === "denied" || permission === "unsupported" ? " is-blocked" : ""}${className ? ` ${className}` : ""}`}
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
