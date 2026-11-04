import { describe, expect, it } from "vitest";
import { clampPageOffset, pageRange } from "../../src/app/ui/pagination.ts";

describe("operations UI pagination", () => {
  it("keeps a valid offset unchanged", () => {
    expect(clampPageOffset(120, 50)).toBe(50);
  });

  it("falls back to the last page when the offset is out of range", () => {
    expect(clampPageOffset(50, 75)).toBe(25);
    expect(clampPageOffset(50, 25)).toBe(25);
    expect(clampPageOffset(1, 100)).toBe(0);
  });

  it("clears the offset when no job remains", () => {
    expect(clampPageOffset(0, 75)).toBe(0);
  });

  it("reports a bounded range for the current page", () => {
    expect(pageRange(120, 0, 25)).toEqual({ start: 1, end: 25 });
    expect(pageRange(120, 100, 20)).toEqual({ start: 101, end: 120 });
    expect(pageRange(50, 25, 25)).toEqual({ start: 26, end: 50 });
  });

  it("reports an empty range for an empty or clamped page", () => {
    expect(pageRange(0, 0, 0)).toEqual({ start: 0, end: 0 });
    expect(pageRange(50, 75, 0)).toEqual({ start: 0, end: 0 });
  });
});
