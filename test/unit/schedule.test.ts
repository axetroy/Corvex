import { describe, expect, it } from "vitest";
import { isValidTimeZone, nextRunAt, nextRunAtInZone, parseCron, parseRunAt } from "../../src/app/schedule.js";

describe("cron parsing", () => {
  it("parses the standard 5-field subset", () => {
    expect(parseCron("*/5 * * * *")).toMatchObject({ minute: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55] });
    expect(parseCron("0 9 * * 1-5")).toMatchObject({ hour: [9], dayOfWeek: [1, 2, 3, 4, 5] });
    expect(parseCron("30 14 15 3 *")).toMatchObject({ dayOfMonth: [15], month: [3] });
    expect(parseCron("0,15,30,45 * * * *")?.minute).toEqual([0, 15, 30, 45]);
  });

  it("rejects invalid expressions", () => {
    for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "0 0 0 * *", "L * * * *", "* * ? * *", "MON * * * *", "*/0 * * * *", "5-1 * * * *"]) {
      expect(parseCron(bad)).toBeUndefined();
    }
  });

  it("treats day-of-week 7 as Sunday 0", () => {
    expect(parseCron("0 0 * * 7")?.dayOfWeek).toEqual([0]);
  });
});

describe("nextRunAt", () => {
  it("computes the next strictly-future minute", () => {
    const schedule = parseCron("*/15 * * * *")!;
    const after = new Date("2026-11-26T09:07:30Z");
    expect(nextRunAt(schedule, after)?.toISOString()).toBe("2026-11-26T09:15:00.000Z");
  });

  it("computes a weekday schedule", () => {
    // 2026-11-26 是周四；下一个周一 9 点是 11-30。
    const schedule = parseCron("0 9 * * 1")!;
    const after = new Date("2026-11-26T10:00:00Z");
    expect(nextRunAt(schedule, after)?.toISOString()).toBe("2026-11-30T09:00:00.000Z");
  });

  it("returns undefined for impossible dates", () => {
    expect(nextRunAt(parseCron("0 0 30 2 *")!, new Date("2026-01-01T00:00:00Z"))).toBeUndefined();
  });
});

describe("timezone-aware scheduling", () => {
  it("validates IANA timezones", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });

  it("interprets cron in the task's wall-clock timezone", () => {
    // 上海 UTC+8：本地 9:00 = UTC 1:00。
    const schedule = parseCron("0 9 * * *")!;
    const after = new Date("2026-11-26T02:00:00.000Z");
    expect(nextRunAtInZone(schedule, after, "Asia/Shanghai")?.toISOString())
      .toBe("2026-11-27T01:00:00.000Z");
    // UTC 下同样是 9:00 UTC，验证两者不同。
    expect(nextRunAt(schedule, after)?.toISOString()).toBe("2026-11-26T09:00:00.000Z");
  });

  it("handles a negative-offset timezone", () => {
    // 纽约 UTC-5（11 月为 EST）：本地 9:00 = UTC 14:00。
    const schedule = parseCron("0 9 * * 1-5")!;
    const after = new Date("2026-11-26T02:00:00.000Z");
    expect(nextRunAtInZone(schedule, after, "America/New_York")?.toISOString())
      .toBe("2026-11-26T14:00:00.000Z");
  });
});

describe("parseRunAt", () => {
  it("handles relative and absolute times", () => {
    const now = new Date("2026-11-26T09:00:00Z");
    expect(parseRunAt("in 45m", now)?.toISOString()).toBe("2026-11-26T09:45:00.000Z");
    expect(parseRunAt("in 2h", now)?.toISOString()).toBe("2026-11-26T11:00:00.000Z");
    expect(parseRunAt("2026-11-26T10:00:00Z", now)?.toISOString()).toBe("2026-11-26T10:00:00.000Z");
    expect(parseRunAt("nonsense", now)).toBeUndefined();
  });
});
