/** 距滚动容器底部多少像素内仍视为「在底部」。 */
export const bottomFollowThresholdPx = 24;

/** 用户是否停留在滚动容器底部；流式内容借此判断要不要继续自动跟随。 */
export function isAtScrollBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = bottomFollowThresholdPx,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - threshold;
}
