import { describe, expect, it } from "vitest";
import { verifyAnswerClaims } from "../../src/agent/claim-verification.js";

describe("claim verification", () => {
  it("flags a comment claim when no note tool was called", () => {
    const result = verifyAnswerClaims(
      "审核报告已发布到 MR 评论中（note #2263）。",
      ["create_merge_request", "git_publish"],
      "zh-CN",
    );
    expect(result.unverified).toContain("comment");
    expect(result.detail).toContain("评论");
  });

  it("accepts a claim backed by a real tool call", () => {
    const result = verifyAnswerClaims(
      "审核报告已发布到 MR 评论中（note #2263），MR 已合并。",
      ["post_mr_note", "merge_merge_request"],
      "zh-CN",
    );
    expect(result.unverified).toEqual([]);
  });

  it("honors verified actions performed by the system outside Pi tools", () => {
    const result = verifyAnswerClaims(
      "I published the change and created the MR.",
      ["git_publish"],
      "en",
      new Set(["publish"]),
    );
    expect(result.unverified).toEqual([]);
  });

  it("does not flag speculative or neutral statements", () => {
    expect(verifyAnswerClaims("我建议先合并再发布。", [], "zh-CN").unverified).toEqual([]);
    expect(verifyAnswerClaims("This should be merged eventually.", [], "en").unverified).toEqual([]);
  });

  it("requires a read-back before accepting fixed/completed claims", () => {
    expect(verifyAnswerClaims("已修复这个 BUG。", ["edit_file"], "zh-CN").unverified).toContain("fixed");
    expect(verifyAnswerClaims("已修复这个 BUG。", ["edit_file", "read_file"], "zh-CN").unverified).not.toContain("fixed");
    expect(verifyAnswerClaims("任务已完成。", ["write_file"], "zh-CN").unverified).toContain("done");
    expect(verifyAnswerClaims("任务已完成。", ["write_file", "git_diff"], "zh-CN").unverified).not.toContain("done");
  });

  it("requires a successful run_command for verification claims", () => {
    // 只有调用过、且成功，才算验证通过。
    expect(verifyAnswerClaims("测试已通过。", ["run_command"], "zh-CN").unverified).toContain("verified");
    expect(verifyAnswerClaims(
      "测试已通过。", ["run_command"], "zh-CN", new Set(), new Set(["run_command"]),
    ).unverified).not.toContain("verified");
  });

  it("detects English claims without matching tools", () => {
    const result = verifyAnswerClaims("I approved and deleted the issue.", [], "en");
    expect(result.unverified).toContain("approve");
    expect(result.unverified).toContain("delete");
  });
});
