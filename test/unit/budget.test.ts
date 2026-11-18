import { describe, expect, it } from "vitest";
import {
  buildConversationPrompt,
  estimateTokens,
  isContextOverflowError,
  resolveMaxInputTokens,
  trimHistory,
} from "../../src/agent/budget.js";

describe("estimateTokens", () => {
  it("按 chars/4 向上取整估算", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("resolveMaxInputTokens", () => {
  it("配置了上限时直接采用", () => {
    expect(resolveMaxInputTokens({ maxInputTokens: 50_000, contextWindow: 131_072, maxOutputTokens: 4_096 })).toBe(50_000);
  });

  it("未配置时由窗口扣除输出与固定开销推导", () => {
    const value = resolveMaxInputTokens({ maxInputTokens: 0, contextWindow: 131_072, maxOutputTokens: 4_096 });
    expect(value).toBe(131_072 - 4_096 - 2_000);
  });

  it("窗口很小时保底 1024", () => {
    expect(resolveMaxInputTokens({ maxInputTokens: 0, contextWindow: 2_000, maxOutputTokens: 1_900 })).toBe(1_024);
  });
});

describe("isContextOverflowError", () => {
  it("识别 OpenAI 兼容的超窗措辞", () => {
    expect(isContextOverflowError("This model's maximum context length is 131072 tokens")).toBe(true);
    expect(isContextOverflowError("exceed_context_size_error: 195482 tokens > 131072 ctx")).toBe(true);
    expect(isContextOverflowError("prompt is too long: 200000 tokens")).toBe(true);
    expect(isContextOverflowError("Please reduce the length of the messages.")).toBe(true);
  });

  it("普通错误不误判", () => {
    expect(isContextOverflowError("rate limit exceeded")).toBe(false);
    expect(isContextOverflowError("invalid api key")).toBe(false);
  });
});

describe("trimHistory", () => {
  it("预算充足时保留全部历史", () => {
    const history = [
      { id: "1", role: "user" as const, content: "hello" },
      { id: "2", role: "assistant" as const, content: "hi" },
    ];
    const result = trimHistory(history, 10_000);
    expect(result.messages).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it("预算不足时从最旧开始丢弃，并返回被丢弃项", () => {
    const history = [
      { id: "1", role: "user" as const, content: "a".repeat(4_000) },
      { id: "2", role: "assistant" as const, content: "b".repeat(4_000) },
      { id: "3", role: "user" as const, content: "c".repeat(400) },
    ];
    const result = trimHistory(history, 500);
    expect(result.messages.map((message) => message.id)).toEqual(["3"]);
    expect(result.dropped.map((message) => message.id)).toEqual(["1", "2"]);
  });

  it("单条超长历史先截断再计入预算", () => {
    const history = [{ id: "1", role: "user" as const, content: "x".repeat(100_000) }];
    const result = trimHistory(history, 100);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toContain("[truncated]");
    expect(result.messages[0]!.content.length).toBeLessThan(21_000);
  });

  it("最近一条即使超预算也保留，保证对话可继续", () => {
    const history = [
      { id: "1", role: "user" as const, content: "old" },
      { id: "2", role: "user" as const, content: "y".repeat(4_000) },
    ];
    const result = trimHistory(history, 10);
    expect(result.messages.map((message) => message.id)).toEqual(["2"]);
    expect(result.dropped.map((message) => message.id)).toEqual(["1"]);
  });
});

describe("buildConversationPrompt", () => {
  it("把仓库、摘要与当前请求组装为 JSON", () => {
    const prompt = buildConversationPrompt({
      repository: { project: "group/project", branch: "main", headSha: "a".repeat(40) },
      summary: "earlier turns discussed the parser",
      currentRequest: "where is it assigned?",
    });
    expect(JSON.parse(prompt)).toEqual({
      repository: { project: "group/project", branch: "main", headSha: "a".repeat(40) },
      summary: "earlier turns discussed the parser",
      currentRequest: "where is it assigned?",
    });
  });

  it("无摘要时不输出 summary 字段", () => {
    const prompt = buildConversationPrompt({
      repository: { project: "group/project", branch: "main", headSha: "a".repeat(40) },
      summary: null,
      currentRequest: "hi",
    });
    expect(JSON.parse(prompt)).not.toHaveProperty("summary");
  });
});
