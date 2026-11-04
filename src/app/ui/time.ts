import type { JobStatus } from "../../jobs/model.js";

/** 任务进入其中任一状态后，持续时间不再增长。 */
const terminalStatuses = new Set<JobStatus>(["completed", "failed", "stale", "cancelled"]);

/** 计算任务从创建到现在（或终态时刻）的持续秒数；时间戳无效时返回 null。 */
export function calculateJobDurationSeconds(
  job: { createdAt: string; updatedAt: string; status: JobStatus },
  now = Date.now(),
): number | null {
  const startedAt = Date.parse(job.createdAt);
  const endedAt = terminalStatuses.has(job.status) ? Date.parse(job.updatedAt) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  return Math.floor(Math.max(0, endedAt - startedAt) / 1000);
}
