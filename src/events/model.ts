/** 系统可入队并由 Worker 处理的事件类型集合；对话轮次不再进入该队列。 */
export const eventTypes = ["review", "fix", "explain", "chat", "implement"] as const;
export type EventType = (typeof eventTypes)[number];

/** 在边界处校验外部字符串是否为已知事件类型。 */
export function isEventType(value: string): value is EventType {
  return eventTypes.some((type) => type === value);
}

/** 需要模型调用的任务类型：事件类型加由 Server 内联执行的对话轮次。 */
export const modelTaskTypes = [...eventTypes, "conversation"] as const;
export type ModelTaskType = (typeof modelTaskTypes)[number];

/** 在边界处校验外部字符串是否为已知模型任务类型。 */
export function isModelTaskType(value: string): value is ModelTaskType {
  return modelTaskTypes.some((type) => type === value);
}

export type EventTargetType = "merge_request" | "issue" | "repository";
export type ConversationMessageStatus = "queued" | "running" | "completed" | "failed";

/** 对话轮次的执行状态；由 Server 内联执行，不经过 Worker 队列。 */
export const conversationTurnStatuses = [
  "queued",
  "running",
  "completed",
  "failed",
  "stale",
  "cancelled",
] as const;
export type ConversationTurnStatus = (typeof conversationTurnStatuses)[number];

/** 在边界处校验外部字符串是否为已知对话轮次状态。 */
export function isConversationTurnStatus(value: string): value is ConversationTurnStatus {
  return conversationTurnStatuses.some((status) => status === value);
}

/** 轨迹归属：事件轨迹写入事件表，对话轨迹写入对话表。 */
export type TraceScope =
  | { kind: "event"; eventId: string }
  | { kind: "conversation"; turnId: string };

/** SQLite、Worker 和运维界面共同使用的事件生命周期状态集合。 */
export const eventStatuses = [
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
export type EventStatus = (typeof eventStatuses)[number];

/** 在边界处校验外部字符串是否为已知事件状态。 */
export function isEventStatus(value: string): value is EventStatus {
  return eventStatuses.some((status) => status === value);
}

export interface Event {
  id: string;
  type: EventType;
  status: EventStatus;
  projectId: number;
  mrIid: number;
  targetType: EventTargetType;
  targetIid: number;
  targetBranch: string;
  headSha: string;
  actorId: number;
  request: string;
  createdAt: string;
  attemptCount: number;
  lastError: string;
  cancellationRequested: boolean;
  leaseToken: string;
  failureStage: EventStatus | "";
}

export interface EventSummary extends Omit<Event, "leaseToken"> {
  updatedAt: string;
}

export interface EventListQuery {
  status?: EventStatus;
  type?: EventType;
  projectId?: number;
  mrIid?: number;
  search?: string;
  limit: number;
  offset: number;
}

export interface EventPage {
  items: EventOperationsSummary[];
  total: number;
}

export interface ConversationSummary {
  id: string;
  projectId: number;
  projectName: string;
  targetBranch: string;
  createdAt: string;
  updatedAt: string;
  /** 该对话的轮次总数（每条助手回复对应一轮）。 */
  turnCount: number;
  /** 最近一轮的状态；尚无轮次时为空。 */
  lastTurnStatus: ConversationTurnStatus | null;
}

/**
 * 助手回复期间的一次工具调用摘要，供对话列表直接展示该轮读过哪些文件、
 * 调用是否成功以及耗时，无需再跳到轨迹标签。参数沿用轨迹的脱敏与限长结果。
 */
export interface ConversationToolCall {
  name: string;
  status: EventTraceStatus;
  /** 工具调用参数（脱敏后的 JSON 文本）；未记录时为空。 */
  input: string | null;
  durationMs: number | null;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: ConversationMessageStatus;
  /** 助手回复对应的轮次 ID；用户消息为空。 */
  turnId: string | null;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  /** 助手回复所对应轮次的终态；用户消息与未执行回复为空。 */
  turnStatus: ConversationTurnStatus | null;
  /** 助手回复对应轮次已记录的轨迹条目数，供界面提示「有轨迹可看」。 */
  traceCount: number;
  /** 助手回复对应轮次已记录的执行步骤数。 */
  stepCount: number;
  /** 助手回复已记录的工具调用摘要，按调用时间排序；用户消息为空数组。 */
  toolCalls: ConversationToolCall[];
}

export interface Conversation extends ConversationSummary {
  messages: ConversationMessage[];
}

/**
 * 单轮对话的完整记录：把一轮助手回复背后的轮次状态、轨迹与执行步骤汇总到一起，
 * 使运维台可以直接在对话内查看该轮的轨迹，而无需跳到事件详情页。
 */
export interface ConversationTurn {
  conversationId: string;
  /** 该轮助手回复的消息 ID。 */
  messageId: string;
  /** 该轮的独立记录 ID。 */
  turnId: string;
  status: ConversationTurnStatus;
  /** 该轮用户提问的原文。 */
  request: string;
  headSha: string;
  /** 该轮已被领取执行的次数；由 Server 内联执行时累加。 */
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastError: string;
  timeline: ConversationTurnTransition[];
  trajectory: EventTraceEntry[];
  events: ExecutionStep[];
}

export interface ConversationPage {
  items: ConversationSummary[];
  total: number;
}

/**
 * 合并轨迹里的一段轮次边界：只保留在一条轨迹中划分轮次所需的字段，
 * 轨迹与执行步骤通过各自的 `turnId` 归属到对应分段。
 */
export interface ConversationTurnSegment {
  turnId: string;
  status: ConversationTurnStatus;
  /** 该轮用户提问原文，作为轨迹中的用户消息。 */
  request: string;
  headSha: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastError: string;
}

/**
 * 整段对话的轨迹：把该对话全部轮次的轨迹与执行步骤合并成一条时间线，
 * 并带上按轮分组的边界，供运维台默认在一条轨迹里展示所有轮次。
 */
export interface ConversationTurns {
  conversationId: string;
  /** 合并后的轮次分段，按轮次创建时间升序。 */
  turns: ConversationTurnSegment[];
  /** 全部轮次合并后的轨迹，按开始时间升序。 */
  trajectory: EventTraceEntry[];
  /** 全部轮次合并后的执行步骤，按开始时间升序。 */
  events: ExecutionStep[];
}

/**
 * 单轮对话的用量与耗时汇总，供对话页「统计」标签展示。
 * 时间与用量来自该轮对话的轨迹记录；缺失字段按未记录处理。
 */
export interface ConversationTurnStats {
  /** 该轮助手回复的消息 ID。 */
  messageId: string;
  turnId: string;
  status: ConversationTurnStatus;
  /** 该轮用户提问原文，用于统计表定位。 */
  request: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  /** 该轮记录的模型调用次数（对话轨迹中 `kind='llm'`）。 */
  modelCalls: number;
  /** 该轮记录的工具调用次数（对话轨迹中 `kind='tool'`）。 */
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

export interface EventOperationsSummary extends EventSummary {
  activityStartedAt: string;
}

export interface EventAttemptSummary {
  attempt: number;
  startedAt: string;
  finishedAt: string | null;
  error: string;
}

export interface StatusTransition<S extends string = EventStatus> {
  from: S;
  to: S;
  at: string;
}

export type EventStatusTransition = StatusTransition<EventStatus>;
export type ConversationTurnTransition = StatusTransition<ConversationTurnStatus>;

export type EventTraceKind = "tool" | "llm";
export type EventTraceStatus = "running" | "succeeded" | "failed";

export interface EventTraceEntry {
  id: number;
  /** 对话轨迹所属轮次 ID；事件轨迹为空。 */
  turnId: string | null;
  attempt: number;
  round: number | null;
  kind: EventTraceKind;
  name: string;
  status: EventTraceStatus;
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
export type ExecutionStepStatus = "running" | "succeeded" | "failed" | "ignored" | "unknown" | "interrupted";

/** 单个 webhook 或 Worker 执行步骤的脱敏追踪记录。 */
export interface ExecutionStep {
  id: number;
  /** Webhook 投递关联 ID；纯 Worker 步骤为空。 */
  deliveryId: string | null;
  /** GitLab webhook 事件 ID；尚未关联到 webhook 时为空。 */
  webhookEventId: string | null;
  /** 事件 ID；事件创建前记录的 webhook 步骤可能为空。 */
  eventId: string | null;
  /** 对话轨迹所属轮次 ID；事件与 webhook 步骤为空。 */
  turnId: string | null;
  /** Worker 尝试序号；webhook 步骤为空。 */
  attempt: number | null;
  step: string;
  status: ExecutionStepStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  /** 脱敏且有大小上限的 JSON 文本；超限时会截断。 */
  input: string | null;
  /** 脱敏且有大小上限的 JSON 文本；超限时会截断。 */
  output: string | null;
  errorDetail: string | null;
}

export interface EventDetails extends EventSummary {
  actorUsername: string | null;
  triggerComment: string | null;
  attempts: EventAttemptSummary[];
  timeline: EventStatusTransition[];
  trajectory: EventTraceEntry[];
  /** 执行事件按开始时间倒序排列，包含已关联到此事件的 webhook 与 Worker 步骤。 */
  events: ExecutionStep[];
}

export interface OperationsOverview {
  counts: Record<EventStatus, number>;
  oldestQueuedAt: string | null;
  workers: {
    onlineCount: number;
    lastSeenAt: string | null;
  };
}

export interface EventResult {
  response: string;
  delivered: boolean;
  event?: {
    id: string;
    created: boolean;
  };
}

export interface ModelCallMetric {
  taskType: ModelTaskType;
  outcome: "success" | "failure";
  calls: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

/** 对话轮次创建后返回给调用方的标识。 */
export interface CreatedConversationTurn {
  conversationId: string;
  turnId: string;
}

/** 对话轮次执行所需的只读上下文快照。 */
export interface ConversationTurnContext {
  turnId: string;
  conversationId: string;
  projectId: number;
  projectName: string;
  targetBranch: string;
  headSha: string;
  actorId: number;
  request: string;
  attempt: number;
  /** 该轮之前已完成的历史消息，按时间升序。 */
  history: { role: "user" | "assistant"; content: string }[];
}
