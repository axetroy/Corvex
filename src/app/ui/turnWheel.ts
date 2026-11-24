/**
 * 轮次导航滑轨的滚轮处理。
 *
 * 浏览器的 WheelEvent.deltaY 已经规范化为跨平台一致的语义：正值表示向下滚动，
 * 负值表示向上滚动。系统「自然滚动」设置由浏览器转换进 deltaY，因此**不能**再按
 * 平台反转符号——旧实现正是这样做，导致 macOS 上方向相反。
 *
 * 另：macOS 触控板一次手势会发出大量小 deltaY 的连续事件（含惯性衰减），
 * 若每个事件都跳一轮，一次轻扫就会连跳十几轮。用时间节流把一次连续手势压成一步。
 */

/** 一次连续滚动手势内，两次有效跳转的最小间隔（毫秒）。 */
export const turnWheelCooldownMs = 150;

export interface TurnWheelState {
  /** 上一次有效跳转的时间戳；0 表示尚未跳转。 */
  lastStepAt: number;
}

export function createTurnWheelState(): TurnWheelState {
  return { lastStepAt: 0 };
}

/**
 * 把 wheel 的 deltaY 转成轮次步数（+1 前进到更新轮次，-1 回退）。
 * 跨平台统一按 deltaY 符号，不再按 navigator.platform 反转。
 */
export function turnWheelStep(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return Math.sign(deltaY);
}

/**
 * 判断是否允许本次跳转并更新节流状态。
 * 连续手势（间隔小于冷却时间）只认第一次，避免触控板惯性连跳。
 */
export function shouldStepTurnWheel(
  state: TurnWheelState,
  now: number,
  cooldownMs = turnWheelCooldownMs,
): boolean {
  if (now - state.lastStepAt < cooldownMs) return false;
  state.lastStepAt = now;
  return true;
}
