import { describe, expect, it } from "vitest";
import { branchNamePatternSource, isValidBranchName } from "../../src/git/refs.js";

/** 工具 schema 与实际执行共用同一个分支名规则，中文分支必须两处都放行。 */
describe("git branch name validation", () => {
  it("accepts Unicode branch names used by real projects", () => {
    for (const name of [
      "user_小米_20261030",
      "修复语言检测",
      "feature/用户中心-优化",
      "fix/security",
      "main",
    ]) {
      expect(isValidBranchName(name)).toBe(true);
      expect(new RegExp(branchNamePatternSource).test(name)).toBe(true);
    }
  });

  it("still rejects unsafe or invalid git ref names", () => {
    for (const name of [
      "",
      "-force",
      ".hidden",
      "../escape",
      "fix/a..b",
      "fix//double",
      "fix/a.lock",
      "fix/a@{1}",
      "feature/名字 with space",
      "HEAD@{0}",
      "@",
    ]) {
      expect(isValidBranchName(name)).toBe(false);
    }
  });

  it("honors an explicit shorter max length", () => {
    expect(isValidBranchName("feature/中文分支", 8)).toBe(false);
    expect(isValidBranchName("fix/abc", 8)).toBe(true);
  });
});
