import { describe, expect, it } from "vitest";
import {
  createTurnWheelState,
  shouldStepTurnWheel,
  turnWheelCooldownMs,
  turnWheelStep,
} from "../../src/app/ui/turnWheel.js";

describe("turn navigation wheel", () => {
  it("uses a single cross-platform direction rule (no platform inversion)", () => {
    // deltaY 已在浏览器层规范化：正=向下滚动→前进到更新轮次。
    expect(turnWheelStep(120)).toBe(1);
    expect(turnWheelStep(-120)).toBe(-1);
    expect(turnWheelStep(0)).toBe(0);
    expect(turnWheelStep(Number.NaN)).toBe(0);
  });

  it("collapses a trackpad gesture into one step", () => {
    const state = createTurnWheelState();
    const start = 1_000;
    // 一次手势的连续事件（间隔远小于冷却时间）只认第一次。
    expect(shouldStepTurnWheel(state, start)).toBe(true);
    expect(shouldStepTurnWheel(state, start + 16)).toBe(false);
    expect(shouldStepTurnWheel(state, start + 60)).toBe(false);
    // 手势结束后再次滚动才允许下一步。
    expect(shouldStepTurnWheel(state, start + turnWheelCooldownMs + 1)).toBe(true);
  });

  it("does not consume the cooldown at the boundaries", () => {
    // 边界判定在调用 shouldStep 之前完成，因此反向滚动不被冷却吞掉——
    // 这里仅验证节流状态本身在冷却结束后恢复。
    const state = createTurnWheelState();
    expect(shouldStepTurnWheel(state, 1_000)).toBe(true);
    expect(shouldStepTurnWheel(state, 1_050)).toBe(false);
    expect(shouldStepTurnWheel(state, 1_000 + turnWheelCooldownMs)).toBe(true);
  });
});
