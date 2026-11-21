import { describe, expect, it } from "vitest";
import { conversationCapabilities, isConversationMode, normalizeConversationTitle } from "../../src/events/model.ts";

describe("conversation modes", () => {
  it("recognizes the GitLab collaboration mode", () => {
    expect(isConversationMode("read_only")).toBe(true);
    expect(isConversationMode("gitlab")).toBe(true);
    expect(isConversationMode("unknown")).toBe(false);
  });

  it("grants GitLab writes only in collaboration mode", () => {
    expect(conversationCapabilities("read_only")).toMatchObject({ repositoryWrite: false, gitlabWrite: false });
    expect(conversationCapabilities("gitlab")).toMatchObject({ repositoryWrite: false, gitlabWrite: true });
  });
});

describe("conversation titles", () => {
  it("keeps LLM-generated titles short and single-line", () => {
    const raw = "这个仓库是一个单包结构，核心文件很少：\n- 根目录入口是 index.js。其余说明省略。";
    expect(normalizeConversationTitle(raw, "zh-CN")).toBe("这个仓库是一个单包结构，核心文件很少");
    expect(normalizeConversationTitle("  **Review the input validation** and then some more words. ", "en"))
      .toBe("Review the input validation and then some more");
  });
});
