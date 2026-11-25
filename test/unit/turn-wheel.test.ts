import { describe, expect, it } from "vitest";
import {
  createTurnWheelState,
  shouldStepTurnWheel,
  turnWheelGestureGapMs,
  turnWheelNotchCooldownMs,
  turnWheelNotchDelta,
  turnWheelStep,
} from "../../src/app/ui/lib/turnWheel.js";

describe("turn navigation wheel", () => {
  it("uses a single cross-platform direction rule (no platform inversion)", () => {
    expect(turnWheelStep(120)).toBe(1);
    expect(turnWheelStep(-120)).toBe(-1);
    expect(turnWheelStep(0)).toBe(0);
    expect(turnWheelStep(Number.NaN)).toBe(0);
  });

  it("collapses a whole trackpad gesture (including inertia) into one step", () => {
    const state = createTurnWheelState();
    const start = 1_000;
    // 一次轻扫的连续小 deltaY 事件可跨越很长惯性时间（>旧冷却 150ms）。
    expect(shouldStepTurnWheel(state, start, 2)).toBe(true);
    for (let t = start + 16; t < start + 500; t += 16) {
      expect(shouldStepTurnWheel(state, t, 2)).toBe(false);
    }
    // 手势静止超过间隔后，下一次滚动才算新手势。
    expect(shouldStepTurnWheel(state, start + 500 + turnWheelGestureGapMs + 1, 2)).toBe(true);
  });

  it("allows fast repeated mouse-wheel notches to step each time", () => {
    const state = createTurnWheelState();
    const start = 1_000;
    expect(shouldStepTurnWheel(state, start, turnWheelNotchDelta + 50)).toBe(true);
    expect(shouldStepTurnWheel(state, start + turnWheelNotchCooldownMs + 1, turnWheelNotchDelta + 50)).toBe(true);
  });

  it("a notch resets the gesture state", () => {
    const state = createTurnWheelState();
    expect(shouldStepTurnWheel(state, 1_000, 2)).toBe(true);
    expect(shouldStepTurnWheel(state, 1_016, 2)).toBe(false);
    // 冷却结束后的刻度事件被允许；大 deltaY 走刻度分支并重置手势状态。
    expect(shouldStepTurnWheel(state, 1_000 + turnWheelNotchCooldownMs + 1, 120)).toBe(true);
    expect(state.stepped).toBe(false);
  });
});
