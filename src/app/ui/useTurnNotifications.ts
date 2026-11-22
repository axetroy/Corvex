import { useCallback, useEffect, useState } from "react";
import {
  isNotificationEnabled,
  notificationPermission,
  notifyTurnFinished,
  requestNotificationPermission,
  setNotificationEnabled,
  type TurnNotification,
} from "./notifications.js";

/**
 * 桌面通知状态与操作的聚合入口：侧边栏开关与轮次结束提醒共用同一套逻辑，
 * 权限来自浏览器，开关持久化在 localStorage。
 */
export function useTurnNotifications() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [enabled, setEnabled] = useState(false);

  const refresh = useCallback(() => {
    setPermission(notificationPermission());
    setEnabled(isNotificationEnabled());
  }, []);

  useEffect(() => {
    refresh();
    const onVisibility = () => refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [refresh]);

  /** 由用户手势触发：首次申请权限，之后切换开关。 */
  const toggle = useCallback(async (): Promise<void> => {
    const current = notificationPermission();
    if (current === "denied" || current === "unsupported") {
      refresh();
      return;
    }
    if (current === "default") {
      const result = await requestNotificationPermission();
      setPermission(result);
      if (result === "granted") {
        setNotificationEnabled(true);
        setEnabled(true);
      }
      return;
    }
    const next = !isNotificationEnabled();
    setNotificationEnabled(next);
    setEnabled(next);
  }, [refresh]);

  /** 首次发送等用户手势里申请权限并默认开启。 */
  const request = useCallback(async (): Promise<void> => {
    if (notificationPermission() !== "default") {
      refresh();
      return;
    }
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === "granted") {
      setNotificationEnabled(true);
      setEnabled(true);
    }
  }, [refresh]);

  const notify = useCallback((input: TurnNotification): boolean => notifyTurnFinished(input), []);

  return { permission, enabled, refresh, request, toggle, notify };
}
