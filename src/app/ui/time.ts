import type { EventStatus } from "../../events/model.js";

/** 事件进入其中任一状态后，持续时间不再增长。 */
const terminalStatuses = new Set<EventStatus>(["completed", "failed", "stale", "cancelled"]);

/** 计算事件从创建到现在（或终态时刻）的持续秒数；时间戳无效时返回 null。 */
export function calculateEventDurationSeconds(
  event: { createdAt: string; updatedAt: string; status: EventStatus },
  now = Date.now(),
): number | null {
  const startedAt = Date.parse(event.createdAt);
  const endedAt = terminalStatuses.has(event.status) ? Date.parse(event.updatedAt) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  return Math.floor(Math.max(0, endedAt - startedAt) / 1000);
}
