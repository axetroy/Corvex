import { describe, expect, it } from "vitest";
import { replaceTextExactly, maxReplaceBytes } from "../../src/agent/repo-write.ts";

describe("exact text replacement", () => {
  it("replaces one exact match", () => {
    expect(replaceTextExactly("const a = 1;\nconst b = 2;", "const a = 1;", "const a = 3;", false)).toEqual({
      updated: "const a = 3;\nconst b = 2;",
      replaced: 1,
    });
  });

  it("replaces all matches when requested", () => {
    expect(replaceTextExactly("a\na\nb", "a", "x", true)).toEqual({ updated: "x\nx\nb", replaced: 2 });
  });

  it("rejects missing or ambiguous matches", () => {
    expect(() => replaceTextExactly("hello", "nope", "x", false)).toThrow("not found");
    expect(() => replaceTextExactly("a a", "a", "x", false)).toThrow("matched 2 times");
  });

  it("caps replacement fragment size", () => {
    expect(() => replaceTextExactly("x", "x", "y".repeat(maxReplaceBytes + 1), false)).toThrow("new_string exceeds");
  });
});
