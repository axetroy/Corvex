import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/app/ui/lib/diff";

describe("unified diff parsing for Monaco", () => {
  it("reconstructs original and modified sides from a hunk", () => {
    const patch = [
      "diff --git a/a.js b/a.js",
      "index 111..222 100644",
      "--- a/a.js",
      "+++ b/a.js",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " tail",
    ].join("\n");
    expect(parseUnifiedDiff(patch)).toEqual({
      original: "keep\nold\ntail",
      modified: "keep\nnew\ntail",
    });
  });

  it("ignores metadata and no-newline markers", () => {
    const patch = [
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+b",
      "\\ No newline at end of file",
    ].join("\n");
    const result = parseUnifiedDiff(patch);
    expect(result.original).toBe("a");
    expect(result.modified).toBe("b");
  });

  it("returns empty sides for an empty patch", () => {
    expect(parseUnifiedDiff("")).toEqual({ original: "", modified: "" });
  });
});
