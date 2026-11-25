import { describe, expect, it } from "vitest";
import { splitForMiddleEllipsis } from "../../src/app/ui/lib/truncate";

describe("operations UI middle ellipsis", () => {
  it("keeps short text whole", () => {
    expect(splitForMiddleEllipsis("Read file src/main.ts (lines 1-200)")).toEqual({
      head: "Read file src/main.ts (lines 1-200)",
      tail: "",
    });
  });

  it("splits long text into a head and a short tail", () => {
    const text = `Search "needle" in ${"very/long/path/".repeat(6)}end.ts`;
    const { head, tail } = splitForMiddleEllipsis(text, 10);
    expect(tail).toBe("path/end.ts".slice(-10));
    expect(head + tail).toBe(text);
    expect(head.length).toBeGreaterThan(tail.length);
  });

  it("ignores an invalid tail size", () => {
    expect(splitForMiddleEllipsis("abcdef", 0)).toEqual({ head: "abcdef", tail: "" });
  });
});
