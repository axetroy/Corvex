import { describe, expect, it } from "vitest";
import { conversationCommitPrefix, isAutoConversationCommit, needsCommitMessageRewrite } from "../../src/git/commit-message.js";

describe("conversation commit message rewrite", () => {
  const auto = `${conversationCommitPrefix}0ab10175-258d-48b7-a708-1510dc4cbcd0`;
  const real = "fix(link): 归一化外链页面语言检测\n\n浏览器返回 zh 时不再回退英文";

  it("recognizes only placeholder commits", () => {
    expect(isAutoConversationCommit(auto)).toBe(true);
    expect(isAutoConversationCommit(real)).toBe(false);
  });

  it("rewrites placeholder commits with an explicit message", () => {
    expect(needsCommitMessageRewrite(auto, real)).toBe(true);
  });

  it("never rewrites when no message, same message, or a real commit", () => {
    expect(needsCommitMessageRewrite(auto, undefined)).toBe(false);
    expect(needsCommitMessageRewrite(auto, "  ")).toBe(false);
    expect(needsCommitMessageRewrite(auto, auto)).toBe(false);
    expect(needsCommitMessageRewrite(real, "another message")).toBe(false);
  });
});
