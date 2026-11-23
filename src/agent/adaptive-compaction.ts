/** 每轮 token 增长占上下文窗口的参考比例：超过则提前压缩，低于则延后。 */
export const compactionGrowthTargetRatio = 0.15;

/** 参与平滑的最近轮次 token 增长样本上限。 */
export const compactionGrowthSampleLimit = 4;

/** 增长过快时最多把阈值下调的窗口占比。 */
const maxDownwardRatio = 0.1;

/** 增长过慢时最多把阈值上调的窗口占比。 */
const maxUpwardRatio = 0.05;

/** 阈值下限：窗口的一半，避免小窗口下过早压缩到无用。 */
const minThresholdRatio = 0.5;

export interface AdaptiveCompactionInput {
  /** 上下文窗口 token 数。 */
  window: number;
  /** 静态阈值（compaction_trigger_percent 推导出的值）。 */
  baseThreshold: number;
  /** 硬上限（窗口扣除输出预留与余量）。 */
  capThreshold: number;
  /** 本轮新增的 token 数。 */
  growth: number;
  /** 之前轮次的增长样本，按时间升序。 */
  previous?: readonly number[];
}

export interface AdaptiveCompactionResult {
  /** 调整后的主动压缩阈值。 */
  threshold: number;
  /** 加上本轮后参与平滑的样本，调用方据此更新持久化状态。 */
  samples: number[];
}

/**
 * 按每轮实际 token 增长调整主动压缩阈值。
 *
 * 增长快（单轮吃掉超过参考比例的窗口）时下调阈值提前压缩，避免下一轮被工具结果顶爆；
 * 增长慢时上调阈值延后压缩，减少不必要的压缩次数与缓存失效。调整幅度对窗口取百分比并
 * 限制在 [窗口一半, 硬上限] 内，因此不会把阈值推到无法容纳回答或过度压缩的位置。
 */
export function resolveAdaptiveCompactionThreshold({
  window,
  baseThreshold,
  capThreshold,
  growth,
  previous = [],
}: AdaptiveCompactionInput): AdaptiveCompactionResult {
  const sample = Math.max(0, Math.floor(growth));
  const samples = [...previous.map((value) => Math.max(0, Math.floor(value))), sample]
    .slice(-compactionGrowthSampleLimit);
  const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const target = window * compactionGrowthTargetRatio;
  const lowerBound = Math.max(1_024, Math.floor(window * minThresholdRatio));
  const upperBound = Math.max(baseThreshold, capThreshold);

  let threshold: number;
  if (average > target) {
    const reduction = Math.min(window * maxDownwardRatio, (average - target) * 1.5);
    threshold = baseThreshold - reduction;
  } else {
    const increase = Math.min(upperBound - baseThreshold, window * maxUpwardRatio, (target - average) * 0.5);
    threshold = baseThreshold + increase;
  }

  return {
    threshold: Math.round(Math.max(lowerBound, Math.min(upperBound, threshold))),
    samples,
  };
}
