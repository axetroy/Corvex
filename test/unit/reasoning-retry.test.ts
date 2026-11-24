import { describe, expect, it } from "vitest";
import { EmptyCompletionError, lowerThinkingLevel, resolveThinkingBudgets } from "../../src/agent/pi.js";

describe("reasoning retry", () => {
  it("lowers the thinking level one step at a time until off", () => {
    expect(lowerThinkingLevel("max")).toBe("xhigh");
    expect(lowerThinkingLevel("xhigh")).toBe("high");
    expect(lowerThinkingLevel("high")).toBe("medium");
    expect(lowerThinkingLevel("medium")).toBe("low");
    expect(lowerThinkingLevel("low")).toBe("minimal");
    expect(lowerThinkingLevel("minimal")).toBe("off");
    expect(lowerThinkingLevel("off")).toBeUndefined();
    expect(lowerThinkingLevel("unknown")).toBeUndefined();
  });

  it("caps thinking budgets below the output ceiling", () => {
    const budgets = resolveThinkingBudgets(8_192);
    for (const value of Object.values(budgets)) expect(value).toBeLessThan(8_192);
    expect(budgets.medium).toBe(4_096);
    // 输出预算不足以给答案留空间时不返回任何思考预算。
    expect(resolveThinkingBudgets(512)).toEqual({});
    expect(resolveThinkingBudgets(2_048).medium).toBe(1_024);
  });

  it("marks empty completions with a dedicated error", () => {
    const error = new EmptyCompletionError();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("Pi returned an empty completion");
  });
});
