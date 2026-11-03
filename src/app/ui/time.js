const terminalStatuses = new Set(["completed", "failed", "stale", "cancelled"]);

export function calculateJobDurationSeconds(job, now = Date.now()) {
  const startedAt = Date.parse(job.createdAt);
  const endedAt = terminalStatuses.has(job.status) ? Date.parse(job.updatedAt) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return null;
  return Math.floor(Math.max(0, endedAt - startedAt) / 1000);
}