/**
 * 轮次导航滑轨的滚轮处理。
 *
 * 浏览器的 WheelEvent.deltaY 已规范化为跨平台一致语义：正值=向下滚动，负值=向上滚动。
 * 系统「自然滚动」由浏览器转换进 deltaY，因此不能再按平台反转符号（旧实现导致 macOS 反向）。
 *
 * 节流策略要同时照顾两类输入：
 * - 触控板：一次轻扫产生大量小 deltaY 的连续事件（含惯性，可持续数百毫秒），
 *   若每个事件跳一轮就会连跳。用「手势静止间隔」检测：一段连续事件只认第一次。
 * - 鼠标滚轮：每次刻度是一个大 deltaY 的独立事件，用户快速连滚希望逐刻度跳轮，
 *   因此用很短的冷却，避免把快速连滚压成一步。
 */

/** 触控板手势的静止间隔：超过该时间没有 wheel 事件即视为新手势。 */
export const turnWheelGestureGapMs = 300;
/** 鼠标滚轮刻度的最短冷却（毫秒）。 */
export const turnWheelNotchCooldownMs = 80;
/** deltaY 绝对值达到该值视为鼠标滚轮的一个刻度，而非触控板的连续滑动。 */
export const turnWheelNotchDelta = 50;

export interface TurnWheelState {
  /** 当前手势是否已经跳转过。 */
  stepped: boolean;
  /** 最近一个 wheel 事件的时间戳。 */
  lastEventAt: number;
  /** 最近一次有效跳转的时间戳。 */
  lastStepAt: number;
}

export function createTurnWheelState(): TurnWheelState {
  return { stepped: false, lastEventAt: 0, lastStepAt: 0 };
}

/**
 * 把 wheel 的 deltaY 转成轮次步数（+1 前进到更新轮次，-1 回退）。
 * 跨平台统一按 deltaY 符号，不按 navigator.platform 反转。
 */
export function turnWheelStep(deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  return Math.sign(deltaY);
}

/**
 * 判断是否允许本次跳转并更新状态。
 * 触控板连续手势只认第一次；鼠标滚轮刻度允许快速连续跳转。
 */
export function shouldStepTurnWheel(
  state: TurnWheelState,
  now: number,
  deltaY: number,
): boolean {
  // 鼠标滚轮：大 deltaY 的独立刻度事件，用短冷却保留快速连滚的逐轮手感。
  if (Math.abs(deltaY) >= turnWheelNotchDelta) {
    if (now - state.lastStepAt < turnWheelNotchCooldownMs) return false;
    state.lastStepAt = now;
    state.stepped = false;
    state.lastEventAt = now;
    return true;
  }
  // 触控板：小 deltaY 的连续事件；手势静止超过间隔后重置，一次手势只跳一步。
  if (now - state.lastEventAt >= turnWheelGestureGapMs) state.stepped = false;
  state.lastEventAt = now;
  if (state.stepped) return false;
  state.stepped = true;
  state.lastStepAt = now;
  return true;
}
