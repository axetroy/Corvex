import type { ExecutionEvent, JobDetails, JobOperationsSummary, JobStatus, JobTraceEntry, JobTraceKind, JobType, ModelCallMetric, OperationsOverview } from "../../jobs/model.js";

/**
 * 运维台依赖的接口数据结构。字段形状与 `src/jobs/model.ts` 一致，
 * 这里只做 HTTP 边界的重新导出，避免前端重复声明。
 */
export type { ExecutionEvent, JobDetails, JobOperationsSummary, JobStatus, JobTraceEntry, JobTraceKind, JobType, ModelCallMetric };

/** `GET /api/ops/overview` 的响应体。 */
export interface OverviewResponse extends OperationsOverview {
  generatedAt: string;
  oldestQueueAgeSeconds: number | null;
  modelCalls: ModelCallMetric[];
}

/** `GET /api/ops/jobs` 的响应体。 */
export interface JobPageResponse {
  items: JobOperationsSummary[];
  total: number;
}

/** 运维台展示的任务生命周期状态，与服务端 `jobStatuses` 保持同一顺序。 */
export const statuses: readonly JobStatus[] = [
  "queued",
  "preparing",
  "analyzing",
  "fixing",
  "verifying",
  "publishing",
  "completed",
  "failed",
  "stale",
  "cancelled",
];

/** 任务列表筛选使用的任务类型，与服务端 `jobTypes` 保持一致。 */
export const jobTypes: readonly JobType[] = ["review", "fix", "explain", "chat", "implement"];

/** 任务列表筛选条件和分页位置。 */
export interface JobQueue {
  status: string;
  type: string;
  search: string;
  offset: number;
}

/** 任务列表单页大小，与服务端 `limit` 上限以下的默认值一致。 */
export const pageSize = 25;
