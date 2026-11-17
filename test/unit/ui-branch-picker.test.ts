import { describe, expect, it } from "vitest";
import {
  branchShortSha,
  branchSubtitle,
  mergeBranches,
  toBranchSelectOption,
  type BranchOption,
} from "../../src/app/ui/branchPicker.ts";

function branch(name: string, commit: Partial<BranchOption["commit"]> = {}): BranchOption {
  return { name, commit: { id: "a".repeat(40), ...commit } };
}

describe("operations UI branch picker", () => {
  it("prefers the GitLab short id and falls back to the SHA prefix", () => {
    expect(branchShortSha({ id: "a".repeat(40), short_id: "abcdef12" })).toBe("abcdef12");
    expect(branchShortSha({ id: "1234567890abcdef" })).toBe("12345678");
  });

  it("builds a two-line subtitle from the short SHA and commit title", () => {
    expect(branchSubtitle(branch("main", { short_id: "abcdef12", title: "Fix lease renewal" })))
      .toBe("abcdef12 · Fix lease renewal");
  });

  it("keeps the short SHA when the commit has no title", () => {
    expect(branchSubtitle(branch("main", { short_id: "abcdef12" }))).toBe("abcdef12");
    expect(branchSubtitle(branch("main", { short_id: "abcdef12", title: "   " }))).toBe("abcdef12");
  });

  it("collapses multi-line commit titles into a single line", () => {
    expect(branchSubtitle(branch("main", { short_id: "abc", title: "  first\n\nsecond  " })))
      .toBe("abc · first second");
  });

  it("truncates an over-long commit title", () => {
    const subtitle = branchSubtitle(branch("main", { short_id: "abc", title: "x".repeat(500) }));
    expect(subtitle.startsWith("abc · ")).toBe(true);
    expect(subtitle.endsWith("…")).toBe(true);
    expect(subtitle.length).toBeLessThan(500);
  });

  it("assembles a select option carrying the formatted commit time", () => {
    expect(toBranchSelectOption(branch("develop", { short_id: "abc", title: "Ship it" }), "3 天前")).toEqual({
      value: "develop",
      title: "develop",
      subtitle: "abc · Ship it",
      meta: "3 天前",
      branch: branch("develop", { short_id: "abc", title: "Ship it" }),
    });
  });

  it("appends a page without duplicating branches that already exist", () => {
    const first = [branch("main"), branch("develop")];
    const second = [branch("develop", { title: "new" }), branch("release/1.0")];
    expect(mergeBranches(first, second).map((item) => item.name)).toEqual(["main", "develop", "release/1.0"]);
  });

  it("keeps the first occurrence when a branch appears twice", () => {
    const merged = mergeBranches([branch("main", { title: "original" })], [branch("main", { title: "duplicate" })]);
    expect(merged[0].commit.title).toBe("original");
  });

  it("returns an empty list when both pages are empty", () => {
    expect(mergeBranches([], [])).toEqual([]);
  });
});
