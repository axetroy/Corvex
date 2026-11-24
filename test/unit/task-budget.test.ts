import { describe, expect, it } from "vitest";
import { createTaskBudgetState, observeTaskBudget, wrapUpNotice } from "../../src/agent/task-budget.js";

describe("task budget", () => {
  it("wraps up at the round ceiling and only once", () => {
    const state = createTaskBudgetState();
    const limits = { maxRounds: 3 };
    expect(observeTaskBudget(state, limits, 100)).toBe(false);
    expect(observeTaskBudget(state, limits, 100)).toBe(false);
    expect(observeTaskBudget(state, limits, 100)).toBe(true);
    expect(observeTaskBudget(state, limits, 100)).toBe(false);
  });

  it("wraps up at the output token ceiling", () => {
    const state = createTaskBudgetState();
    const limits = { maxOutputTokens: 1_000 };
    expect(observeTaskBudget(state, limits, 600)).toBe(false);
    expect(observeTaskBudget(state, limits, 500)).toBe(true);
    expect(state.outputTokens).toBe(1_100);
  });

  it("disabled when limits are zero", () => {
    const state = createTaskBudgetState();
    for (let i = 0; i < 20; i += 1) expect(observeTaskBudget(state, { maxRounds: 0, maxOutputTokens: 0 }, 999)).toBe(false);
  });

  it("localizes the notice", () => {
    expect(wrapUpNotice("zh-CN", "rounds", 5)).toContain("最终汇报");
    expect(wrapUpNotice("en", "tokens", 100)).toContain("final report");
  });
});
