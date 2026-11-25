/** 桌面通知：权限由浏览器管理，用户可在侧边栏按钮里开关。 */
export const notificationPreferenceKey = "corvex-ops-notifications";

type NotificationWindow = Window & { Notification?: typeof Notification };

function browserNotification(): typeof Notification | undefined {
  const target = window as NotificationWindow;
  return typeof target.Notification === "function" ? target.Notification : undefined;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return browserNotification()?.permission ?? "unsupported";
}

export function isNotificationEnabled(): boolean {
  if (notificationPermission() !== "granted") return false;
  try {
    return window.localStorage.getItem(notificationPreferenceKey) !== "false";
  } catch {
    return true;
  }
}

export function setNotificationEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(notificationPreferenceKey, enabled ? "true" : "false");
  } catch {
    // 隐私模式下无法持久化，仅保留当前页面内的选择。
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  const notification = browserNotification();
  if (!notification) return "unsupported";
  if (notification.permission === "default") await notification.requestPermission();
  return notification.permission;
}

export interface TurnNotification {
  conversationId: string;
  turnId: string;
  title: string;
  body: string;
}

/** 只在页面不可见或未聚焦时提醒，避免用户正看着回复还被弹通知。 */
export function notifyTurnFinished(input: TurnNotification): boolean {
  if (!isNotificationEnabled()) return false;
  if (!document.hidden && document.hasFocus()) return false;
  const notification = browserNotification();
  if (!notification) return false;
  try {
    const instance = new notification(input.title, {
      body: input.body,
      tag: `corvex-turn-${input.turnId}`,
    });
    instance.onclick = () => {
      window.focus();
      window.location.hash = `#/conversations/${encodeURIComponent(input.conversationId)}`;
      instance.close();
    };
    return true;
  } catch {
    return false;
  }
}
