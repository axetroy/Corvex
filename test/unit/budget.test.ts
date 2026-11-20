import { describe, expect, it } from "vitest";
import {
  buildConversationPrompt,
  chunkForSummary,
  estimateConservativeTokens,
  estimateTokens,
  isContextOverflowError,
  resolveHistoryBudgetTokens,
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

describe("estimateConservativeTokens", () => {
  it("英文按字符数估算", () => {
    expect(estimateConservativeTokens("hello")).toBe(2);
  });

  it("中文按字节上界估算，明显高于 chars/4", () => {
    const text = "中".repeat(30);
    expect(estimateTokens(text)).toBe(8);
    expect(estimateConservativeTokens(text)).toBe(30);
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

describe("resolveHistoryBudgetTokens", () => {
  it("按扣除固定提示开销后的剩余额度裁剪历史预算", () => {
    expect(resolveHistoryBudgetTokens(
      { maxInputTokens: 0, contextWindow: 131_072, maxOutputTokens: 4_096, historyTokenBudget: 24_000 },
      6_000,
    )).toBe(24_000);
  });

  it("max_input_tokens 收紧时历史预算随之下降", () => {
    expect(resolveHistoryBudgetTokens(
      { maxInputTokens: 20_000, contextWindow: 131_072, maxOutputTokens: 4_096, historyTokenBudget: 24_000 },
      6_000,
    )).toBe(14_000);
  });

  it("剩余额度为负时返回 0", () => {
    expect(resolveHistoryBudgetTokens(
      { maxInputTokens: 5_000, contextWindow: 131_072, maxOutputTokens: 4_096, historyTokenBudget: 24_000 },
      9_000,
    )).toBe(0);
  });
});

describe("chunkForSummary", () => {
  const messages = Array.from({ length: 6 }, (_, index) => ({
    id: String(index + 1),
    role: "user" as const,
    content: "a".repeat(3_000),
  }));

  it("按预算分块且不丢失消息", () => {
    const chunks = chunkForSummary(null, messages, 1_500);
    expect(chunks.flat().map((message) => message.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const tokens = chunk.reduce((sum, message) => sum + estimateConservativeTokens(message.content) + 4, 0);
      expect(tokens).toBeLessThanOrEqual(1_500);
    }
  });

  it("滚动摘要占用首块的预算", () => {
    const withSummary = chunkForSummary("中".repeat(400), messages, 2_000);
    const withoutSummary = chunkForSummary(null, messages, 2_000);
    expect(withSummary[0]!.length).toBeLessThanOrEqual(withoutSummary[0]!.length);
  });

  it("单条超预算消息独占一块，保证循环推进", () => {
    const chunks = chunkForSummary(null, [{ id: "big", role: "user" as const, content: "a".repeat(20_000) }], 1_024);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(1);
  });

  it("空历史返回空数组", () => {
    expect(chunkForSummary("summary", [], 1_000)).toEqual([]);
  });
});

describe("isContextOverflowError", () => {
  it("识别 OpenAI 兼容的超窗措辞", () => {
    expect(isContextOverflowError("This model's maximum context length is 131072 tokens")).toBe(true);
    expect(isContextOverflowError("exceed_context_size_error: 195482 tokens > 131072 ctx")).toBe(true);
    expect(isContextOverflowError("prompt is too long: 200000 tokens")).toBe(true);
    expect(isContextOverflowError("Please reduce the length of the messages.")).toBe(true);
    expect(isContextOverflowError("Context size has been exceeded.")).toBe(true);
    expect(isContextOverflowError("context window is exceeded")).toBe(true);
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

  it("中文历史按字节上界裁剪，不留超窗余量", () => {
    const history = [
      { id: "1", role: "user" as const, content: "中".repeat(2_000) },
      { id: "2", role: "assistant" as const, content: "文".repeat(2_000) },
      { id: "3", role: "user" as const, content: "好".repeat(100) },
    ];
    const result = trimHistory(history, 1_500);
    expect(result.messages.map((message) => message.id)).toEqual(["3"]);
    expect(result.dropped.map((message) => message.id)).toEqual(["1", "2"]);
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
