import { describe, expect, it } from "vitest";
import {
  compactionGrowthSampleLimit,
  resolveAdaptiveCompactionThreshold,
} from "../../src/agent/adaptive-compaction.ts";

const window = 131_072;
const baseThreshold = 111_411; // 85% of the window
const capThreshold = 126_000;

describe("adaptive compaction threshold", () => {
  it("lowers the threshold when context grows fast", () => {
    const result = resolveAdaptiveCompactionThreshold({
      window,
      baseThreshold,
      capThreshold,
      growth: window * 0.35,
    });
    expect(result.threshold).toBeLessThan(baseThreshold);
    expect(result.threshold).toBeGreaterThanOrEqual(window * 0.5);
    expect(result.samples).toEqual([Math.floor(window * 0.35)]);
  });

  it("raises the threshold when context grows slowly", () => {
    const result = resolveAdaptiveCompactionThreshold({
      window,
      baseThreshold,
      capThreshold,
      growth: window * 0.02,
    });
    expect(result.threshold).toBeGreaterThan(baseThreshold);
    expect(result.threshold).toBeLessThanOrEqual(capThreshold);
  });

  it("keeps the static threshold when growth matches the target", () => {
    const result = resolveAdaptiveCompactionThreshold({
      window,
      baseThreshold,
      capThreshold,
      growth: window * 0.15,
    });
    expect(result.threshold).toBe(baseThreshold);
  });

  it("smooths growth over a bounded number of recent turns", () => {
    const previous = Array.from({ length: 10 }, () => window * 0.35);
    const result = resolveAdaptiveCompactionThreshold({
      window,
      baseThreshold,
      capThreshold,
      growth: 0,
      previous,
    });
    expect(result.samples.length).toBe(compactionGrowthSampleLimit);
    // 最近一次为 0，但历史高增长仍把平均值拉到目标以上，阈值低于静态值。
    expect(result.threshold).toBeLessThan(baseThreshold);
  });

  it("bounds downward adjustment to a tenth of the window per turn", () => {
    const smallWindow = 32_768;
    const result = resolveAdaptiveCompactionThreshold({
      window: smallWindow,
      baseThreshold: 27_854,
      capThreshold: 30_000,
      growth: 1_000_000,
    });
    expect(result.threshold).toBe(Math.round(27_854 - smallWindow * 0.1));
    expect(result.threshold).toBeGreaterThanOrEqual(smallWindow * 0.5);
  });

  it("never exceeds the hard cap even with zero growth", () => {
    const result = resolveAdaptiveCompactionThreshold({
      window,
      baseThreshold,
      capThreshold,
      growth: 0,
    });
    expect(result.threshold).toBeLessThanOrEqual(capThreshold);
  });
});
