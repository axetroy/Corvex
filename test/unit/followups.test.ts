import { describe, expect, it } from "vitest";
import { parseFollowups } from "../../src/agent/followups.ts";

describe("parseFollowups", () => {
  it("strips a JSON follow-up block and keeps the clean answer", () => {
    const result = parseFollowups(
      "Here is the answer.\n\n<corvex_followups>\n[\"为什么这样改?\",\"能补充测试吗?\"]\n</corvex_followups>",
      3,
    );
    expect(result.content).toBe("Here is the answer.");
    expect(result.suggestions).toEqual(["为什么这样改?", "能补充测试吗?"]);
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

  it("does not leak credentials from suggestions", () => {
    const result = parseFollowups(
      "答案\n<corvex_followups>\n[\"token=abc123 这个是什么\"]\n</corvex_followups>",
      3,
    );
    expect(result.suggestions[0]).not.toContain("abc123");
  });
});
