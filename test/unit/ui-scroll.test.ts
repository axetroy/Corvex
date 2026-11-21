import { describe, expect, it } from "vitest";
import { isAtScrollBottom } from "../../src/app/ui/scroll.ts";

describe("operations UI scroll following", () => {
  it("treats a container at the bottom as pinned", () => {
    expect(isAtScrollBottom(76, 24, 100)).toBe(true);
    expect(isAtScrollBottom(0, 24, 24)).toBe(true);
  });

  it("stops following once the user scrolls up beyond the threshold", () => {
    expect(isAtScrollBottom(40, 24, 100)).toBe(false);
    expect(isAtScrollBottom(70, 24, 100)).toBe(true);
  });
});
