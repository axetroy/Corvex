/** 系统可入队并由 Worker 处理的任务类型集合。 */
export const jobTypes = ["review", "fix", "explain", "chat", "implement", "session"] as const;
export type JobType = (typeof jobTypes)[number];
export type JobTargetType = "merge_request" | "issue" | "repository";
export type ChatSessionMessageStatus = "queued" | "running" | "completed" | "failed";

/** SQLite、Worker 和运维界面共同使用的任务生命周期状态集合。 */
export const jobStatuses = [
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
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  projectId: number;
  mrIid: number;
  targetType: JobTargetType;
  targetIid: number;
  targetBranch: string;
  headSha: string;
  sessionId: string | null;
  sessionResponseId: string | null;
  actorId: number;
  request: string;
  createdAt: string;
  attemptCount: number;
  lastError: string;
  cancellationRequested: boolean;
  leaseToken: string;
  failureStage: JobStatus | "";
}

export interface JobSummary extends Omit<Job, "leaseToken"> {
  updatedAt: string;
}

export interface JobListQuery {
  status?: JobStatus;
  type?: JobType;
  projectId?: number;
  mrIid?: number;
  search?: string;
  limit: number;
  offset: number;
}

export interface JobPage {
  items: JobOperationsSummary[];
  total: number;
}

export interface ChatSessionSummary {
  id: string;
  projectId: number;
  projectName: string;
  targetType: JobTargetType;
  targetIid: number;
  targetBranch: string;
  targetTitle: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ChatSessionMessageStatus;
  jobId: string | null;
  headSha: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatSessionMessage[];
}

export interface ChatSessionPage {
  items: ChatSessionSummary[];
  total: number;
}

export interface CreateChatSessionInput {
  projectId: number;
  projectName: string;
  targetType: JobTargetType;
  targetIid: number;
  targetBranch: string;
  targetTitle: string;
  headSha: string;
  actorId: number;
  request: string;
}

export interface JobOperationsSummary extends JobSummary {
  activityStartedAt: string;
}

export interface JobAttemptSummary {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  error: string;
}

export interface JobStatusTransition {
  from: JobStatus;
  to: JobStatus;
  at: string;
}

export type JobTraceKind = "tool" | "llm";
export type JobTraceStatus = "running" | "succeeded" | "failed";

export interface JobTraceEntry {
  id: number;
  attempt: number;
  round: number | null;
  kind: JobTraceKind;
  name: string;
  status: JobTraceStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  requestStartedAt: string | null;
  responseHeadersMs: number | null;
  firstTokenMs: number | null;
  generationDurationMs: number | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  input: string | null;
  output: string | null;
  schema: string | null;
  rawContent: string | null;
  errorDetail: string | null;
}

/**
 * 执行步骤的持久化状态。`unknown` 表示副作用可能已生效但未收到回执；
 * `interrupted` 表示步骤因 Worker 租约过期而未能正常收尾。
 */
export type ExecutionEventStatus = "running" | "succeeded" | "failed" | "ignored" | "unknown" | "interrupted";

/** 单个 webhook 或 Worker 执行步骤的脱敏追踪记录。 */
export interface ExecutionEvent {
  id: number;
  /** Webhook 投递关联 ID；纯 Worker 步骤为空。 */
  deliveryId: string | null;
  /** GitLab webhook 事件 ID；尚未关联到 webhook 时为空。 */
  eventId: string | null;
  /** 任务 ID；任务创建前记录的 webhook 步骤可能为空。 */
  jobId: string | null;
  /** Worker 尝试序号；webhook 步骤为空。 */
  attempt: number | null;
  step: string;
  status: ExecutionEventStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** 脱敏且有大小上限的 JSON 文本；超限时会截断。 */
  input: string | null;
  /** 脱敏且有大小上限的 JSON 文本；超限时会截断。 */
  output: string | null;
  errorDetail: string | null;
}

export interface JobDetails extends JobSummary {
  actorUsername: string | null;
  triggerComment: string | null;
  attempts: JobAttemptSummary[];
  timeline: JobStatusTransition[];
  trajectory: JobTraceEntry[];
  /** 执行事件按开始时间倒序排列，包含已关联到此任务的 webhook 与 Worker 步骤。 */
  events: ExecutionEvent[];
}

export interface OperationsOverview {
  counts: Record<JobStatus, number>;
  oldestQueuedAt: string | null;
  workers: {
    onlineCount: number;
    lastSeenAt: string | null;
  };
}

export interface EventResult {
  response: string;
  delivered: boolean;
  job?: {
    id: string;
    created: boolean;
  };
}

export interface ModelCallMetric {
  taskType: JobType;
  outcome: "success" | "failure";
  calls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}
