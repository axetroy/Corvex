import { describe, expect, it } from "vitest";
import { isSameTerminalJobSnapshot } from "../../src/app/ui/snapshot.ts";
import type { JobSnapshot } from "../../src/app/ui/snapshot.ts";

/** 构造一个字段完整的详情快照，按需覆盖。 */
function snapshot(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    status: "completed",
    updatedAt: "2026-11-04T10:00:00.000Z",
    attemptCount: 1,
    lastError: "",
    attempts: [{}],
    timeline: [{}],
    trajectory: [{}],
    events: [{}],
    ...overrides,
  };
}

describe("operations UI job snapshot", () => {
  it("treats identical terminal snapshots as equal so polling can skip a re-render", () => {
    expect(isSameTerminalJobSnapshot(snapshot(), snapshot())).toBe(true);
  });

  it("keeps polling for running jobs even when the shape is identical", () => {
    expect(isSameTerminalJobSnapshot(snapshot({ status: "analyzing" }), snapshot({ status: "analyzing" }))).toBe(false);
  });

  it("detects a changed terminal snapshot", () => {
    expect(isSameTerminalJobSnapshot(snapshot(), snapshot({ updatedAt: "2026-11-04T10:01:00.000Z" }))).toBe(false);
    expect(isSameTerminalJobSnapshot(snapshot(), snapshot({ trajectory: [{}, {}] }))).toBe(false);
    expect(isSameTerminalJobSnapshot(snapshot({ status: "failed" }), snapshot({ status: "completed" }))).toBe(false);
  });
});
