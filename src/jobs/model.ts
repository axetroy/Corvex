/** 系统可入队并由 Worker 处理的任务类型集合。 */
export const jobTypes = ["review", "fix", "explain", "chat", "implement", "conversation"] as const;
export type JobType = (typeof jobTypes)[number];

/** 在边界处校验外部字符串是否为已知任务类型。 */
export function isJobType(value: string): value is JobType {
  return jobTypes.some((type) => type === value);
}

export type JobTargetType = "merge_request" | "issue" | "repository";
export type ConversationMessageStatus = "queued" | "running" | "completed" | "failed";

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

/** 在边界处校验外部字符串是否为已知任务状态。 */
export function isJobStatus(value: string): value is JobStatus {
  return jobStatuses.some((status) => status === value);
}

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
  conversationId: string | null;
  conversationResponseId: string | null;
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

export interface ConversationSummary {
  id: string;
  projectId: number;
  projectName: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string;
  /** 该对话已入队的轮次总数（每条助手回复对应一轮）。 */
  turnCount: number;
  /** 最近一轮助手回复的状态；尚无轮次时为空。 */
  lastTurnStatus: ConversationMessageStatus | null;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ConversationMessageStatus;
  jobId: string | null;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  /** 助手回复所对应任务的终态；用户消息与未执行回复为空。 */
  jobStatus: JobStatus | null;
  /** 助手回复对应任务已记录的轨迹条目数，供界面提示「有轨迹可看」。 */
  traceCount: number;
  /** 助手回复对应任务已记录的执行步骤数。 */
  eventCount: number;
}

export interface Conversation extends ConversationSummary {
  messages: ConversationMessage[];
}

/**
 * 单轮对话的完整记录：把一轮助手回复背后的任务状态、生命周期、轨迹与执行步骤
 * 汇总到一起，使运维台可以直接在对话内查看该轮的轨迹，而无需跳到任务详情页。
 */
export interface ConversationTurn {
  conversationId: string;
  /** 该轮助手回复的消息 ID。 */
  messageId: string;
  jobId: string;
  status: JobStatus;
  /** 该轮用户提问的原文。 */
  request: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError: string;
  failureStage: JobStatus | "";
  timeline: JobStatusTransition[];
  attempts: JobAttemptSummary[];
  trajectory: JobTraceEntry[];
  events: ExecutionEvent[];
}

export interface ConversationPage {
  items: ConversationSummary[];
  total: number;
}

/**
 * 单轮对话的用量与耗时汇总，供对话页「统计」标签展示。
 * 时间与用量来自该轮任务的轨迹记录；缺失字段按未记录处理。
 */
export interface ConversationTurnStats {
  /** 该轮助手回复的消息 ID。 */
  messageId: string;
  jobId: string;
  status: JobStatus;
  /** 该轮用户提问原文，用于统计表定位。 */
  request: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  /** 该轮记录的模型调用次数（`job_trace` 中 `kind='llm'`）。 */
  modelCalls: number;
  /** 该轮记录的工具调用次数（`job_trace` 中 `kind='tool'`）。 */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** 整个对话的用量与耗时汇总，以及逐轮明细。 */
export interface ConversationStats {
  conversationId: string;
  /** 助手回复轮次总数。 */
  turnCount: number;
  /** 各终态轮次数量。 */
  completedTurns: number;
  failedTurns: number;
  /** 仍在排队或执行的轮次数量。 */
  activeTurns: number;
  /** 已完成轮次的耗时之和（毫秒）。 */
  totalDurationMs: number;
  /** 已记录耗时的轮次数量，用于计算平均值。 */
  measuredTurns: number;
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  turns: ConversationTurnStats[];
}

export interface CreateConversationInput {
  projectId: number;
  projectName: string;
  targetBranch: string;
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
