import type { JobStatus } from "./types.js";

/** 进入终态后任务轨迹不再变化，可安全跳过等价的轮询结果。 */
const terminalStatuses: ReadonlySet<JobStatus> = new Set<JobStatus>(["completed", "failed", "stale", "cancelled"]);

/** 详情轮询比较所需的最小字段集合。 */
export interface JobSnapshot {
  status: JobStatus;
  updatedAt: string;
  attemptCount: number;
  lastError: string;
  attempts: readonly unknown[];
  timeline: readonly unknown[];
  trajectory: readonly unknown[];
  events: readonly unknown[];
}

/**
 * 判断两次详情快照是否等价。仅对终态任务返回 true：执行中的任务即使长度不变，
 * 轨迹条目的耗时与状态也可能在两次轮询之间变化，必须继续渲染。
 */
export function isSameTerminalJobSnapshot(previous: JobSnapshot, next: JobSnapshot): boolean {
  if (!terminalStatuses.has(next.status) || previous.status !== next.status) return false;
  return previous.updatedAt === next.updatedAt
    && previous.attemptCount === next.attemptCount
    && previous.lastError === next.lastError
    && previous.attempts.length === next.attempts.length
    && previous.timeline.length === next.timeline.length
    && previous.trajectory.length === next.trajectory.length
    && previous.events.length === next.events.length;
}
