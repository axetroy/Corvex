import { describe, expect, it } from "vitest";
import { parseFollowups } from "../../src/agent/followups.ts";

describe("parseFollowups", () => {
  it("strips a JSON follow-up block and keeps the clean answer", () => {
    const result = parseFollowups(
      "Here is the answer.\n\n<corvex_followups>\n[\"查看改动\",\"补充测试\"]\n</corvex_followups>",
      3,
    );
    expect(result.content).toBe("Here is the answer.");
    expect(result.suggestions).toEqual(["查看改动", "补充测试"]);
  });

  it("supports one-per-line plain text and trims markdown bullets", () => {
    const result = parseFollowups(
      "答案\n<corvex_followups>\n- 第一种方案\n- 第二种方案\n</corvex_followups>",
      3,
    );
    expect(result.suggestions).toEqual(["第一种方案", "第二种方案"]);
  });

  it("caps count and deduplicates", () => {
    const result = parseFollowups(
      "答案\n<corvex_followups>\n- 一\n- 一\n- 二\n- 三\n- 四\n</corvex_followups>",
      2,
    );
    expect(result.suggestions).toEqual(["一", "二"]);
  });

  it("leaves content untouched when no valid block is present", () => {
    const answer = "普通回答，没有建议。";
    expect(parseFollowups(answer, 3)).toEqual({ content: answer, suggestions: [] });
  });

  it("filters out service-tone questions (agent asking the user for permission)", () => {
    const result = parseFollowups(
      "答案\n<corvex_followups>\n[\"需要我运行测试吗？\",\"要不要查看 MR？\",\"帮你检查 Git 状态吗？\",\"Would you like me to commit?\",\"运行测试验证\"]\n</corvex_followups>",
      5,
    );
    expect(result.suggestions).toEqual(["运行测试验证"]);
  });

  it("does not leak credentials from suggestions", () => {
    const result = parseFollowups(
      "答案\n<corvex_followups>\n[\"token=abc123 这个是什么\"]\n</corvex_followups>",
      3,
    );
    expect(result.suggestions[0]).not.toContain("abc123");
  });
});
