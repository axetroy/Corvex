import { describe, expect, it } from "vitest";
import { calculateJobDurationSeconds } from "../../src/app/ui/time.js";

describe("operations UI task duration", () => {
  const createdAt = "2026-11-03T10:00:00.000Z";

  it("measures active task duration from creation, including queue time", () => {
    expect(calculateJobDurationSeconds({
      createdAt,
      updatedAt: "2026-11-03T10:00:30.000Z",
      status: "preparing",
    }, Date.parse("2026-11-03T10:01:00.000Z"))).toBe(60);
  });

  it("keeps terminal task duration fixed at its completion time", () => {
    expect(calculateJobDurationSeconds({
      createdAt,
      updatedAt: "2026-11-03T10:02:30.000Z",
      status: "completed",
    }, Date.parse("2026-11-03T11:00:00.000Z"))).toBe(150);
  });

  it("returns null for invalid timestamps and clamps clock skew to zero", () => {
    expect(calculateJobDurationSeconds({ createdAt: "invalid", updatedAt: "invalid", status: "queued" }, 0)).toBeNull();
    expect(calculateJobDurationSeconds({
      createdAt: "2026-11-03T10:00:01.000Z",
      updatedAt: "2026-11-03T10:00:00.000Z",
      status: "failed",
    })).toBe(0);
  });
});