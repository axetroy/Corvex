import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../../src/app/ui/format.ts";
import { en, zhCN } from "../../src/app/ui/i18n.ts";

const now = Date.parse("2026-11-17T12:00:00.000Z");

function ago(ms: number): string {
  return new Date(now - ms).toISOString();
}

describe("operations UI relative time", () => {
  it("formats recent commit times across every bucket", () => {
    expect(formatRelativeTime(ago(10_000), en, now)).toBe("just now");
    expect(formatRelativeTime(ago(5 * 60_000), en, now)).toBe("5m ago");
    expect(formatRelativeTime(ago(3 * 3_600_000), en, now)).toBe("3h ago");
    expect(formatRelativeTime(ago(4 * 86_400_000), en, now)).toBe("4d ago");
    expect(formatRelativeTime(ago(90 * 86_400_000), en, now)).toBe("3mo ago");
    expect(formatRelativeTime(ago(800 * 86_400_000), en, now)).toBe("2y ago");
  });

  it("uses the Simplified Chinese catalog", () => {
    expect(formatRelativeTime(ago(10_000), zhCN, now)).toBe("刚刚");
    expect(formatRelativeTime(ago(5 * 60_000), zhCN, now)).toBe("5 分钟前");
    expect(formatRelativeTime(ago(3 * 3_600_000), zhCN, now)).toBe("3 小时前");
  });

  it("clamps clock skew so future commits read as just now", () => {
    expect(formatRelativeTime(new Date(now + 60_000).toISOString(), en, now)).toBe("just now");
  });

  it("falls back to placeholders for missing or invalid timestamps", () => {
    expect(formatRelativeTime(undefined, en, now)).toBe(en.none);
    expect(formatRelativeTime("not-a-date", en, now)).toBe(en.invalidDate);
  });
});
