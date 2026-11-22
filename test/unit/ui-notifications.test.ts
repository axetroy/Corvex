import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isNotificationEnabled,
  notificationPermission,
  notifyTurnFinished,
  setNotificationEnabled,
} from "../../src/app/ui/notifications.ts";

interface FakeNotification {
  permission: NotificationPermission;
  instances: Array<{ title: string; options?: NotificationOptions; onclick?: () => void; closed: boolean }>;
}

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

function install(permission: NotificationPermission, hidden: boolean, focused: boolean, stored: Record<string, string> = {}): FakeNotification {
  const fake: FakeNotification = { permission, instances: [] };
  const notification = class {
    onclick?: () => void;
    closed = false;
    constructor(public title: string, public options?: NotificationOptions) {
      fake.instances.push(this as unknown as FakeNotification["instances"][number]);
    }
    close() { this.closed = true; }
  } as unknown as typeof Notification;
  const win = {
    Notification: notification,
    localStorage: {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => { stored[key] = value; },
    },
    location: { hash: "" },
    focus: vi.fn(),
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  Object.defineProperty(notification, "permission", { value: permission, configurable: true });
  globalThis.document = { hidden, hasFocus: () => focused } as unknown as Document;
  return fake;
}

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

describe("desktop notifications", () => {
  it("reads browser permission and the local enable flag", () => {
    const stored: Record<string, string> = {};
    install("granted", true, false, stored);
    expect(notificationPermission()).toBe("granted");
    expect(isNotificationEnabled()).toBe(true);
    setNotificationEnabled(false);
    expect(isNotificationEnabled()).toBe(false);
    setNotificationEnabled(true);
    expect(isNotificationEnabled()).toBe(true);
  });

  it("does not notify when permission is not granted", () => {
    const fake = install("denied", true, false);
    expect(notifyTurnFinished({ conversationId: "c1", turnId: "t1", title: "title", body: "body" })).toBe(false);
    expect(fake.instances).toHaveLength(0);
  });

  it("notifies when the page is hidden and links back to the conversation on click", () => {
    const fake = install("granted", true, false);
    expect(notifyTurnFinished({ conversationId: "c 1", turnId: "t1", title: "title", body: "body" })).toBe(true);
    expect(fake.instances).toHaveLength(1);
    expect(fake.instances[0]?.options?.tag).toBe("corvex-turn-t1");
    fake.instances[0]?.onclick?.();
    expect(globalThis.window.location.hash).toBe("#/conversations/c%201");
    expect(fake.instances[0]?.closed).toBe(true);
  });

  it("stays quiet while the user is watching the console", () => {
    const fake = install("granted", false, true);
    expect(notifyTurnFinished({ conversationId: "c1", turnId: "t2", title: "title", body: "body" })).toBe(false);
    expect(fake.instances).toHaveLength(0);
  });
});
