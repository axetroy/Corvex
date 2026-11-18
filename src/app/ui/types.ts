import type {
  Conversation,
  ConversationMessage,
  ConversationPage,
  ConversationStats,
  ConversationSummary,
  ConversationToolCall,
  ConversationTurn,
  ConversationTurnSegment,
  ConversationTurnStats,
  ConversationTurns,
  ExecutionStep,
  EventDetails,
  EventOperationsSummary,
  EventStatus,
  EventTraceEntry,
  EventTraceKind,
  EventTraceStatus,
  EventType,
  ModelCallMetric,
  OperationsOverview,
} from "../../events/model.js";

/**
 * 运维台依赖的接口数据结构。字段形状与 `src/events/model.ts` 一致，
 * 这里只做 HTTP 边界的重新导出，避免前端重复声明。
 */
export type {
  Conversation,
  ConversationMessage,
  ConversationPage,
  ConversationStats,
  ConversationSummary,
  ConversationToolCall,
  ConversationTurn,
  ConversationTurnSegment,
  ConversationTurnStats,
  ConversationTurns,
  ExecutionStep,
  EventDetails,
  EventOperationsSummary,
  EventStatus,
  EventTraceEntry,
  EventTraceKind,
  EventTraceStatus,
  EventType,
  ModelCallMetric,
};

/** `GET /api/ops/overview` 的响应体。 */
export interface OverviewResponse extends OperationsOverview {
  generatedAt: string;
  oldestQueueAgeSeconds: number | null;
  modelCalls: ModelCallMetric[];
}

/** `GET /api/ops/events` 的响应体。 */
export interface EventPageResponse {
  items: EventOperationsSummary[];
  total: number;
}

/** 运维台展示的事件生命周期状态，与服务端 `eventStatuses` 保持同一顺序。 */
export const statuses: readonly EventStatus[] = [
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

/** 事件列表筛选使用的事件类型，与服务端 `eventTypes` 保持一致。 */
export const eventTypes: readonly EventType[] = ["review", "fix", "explain", "chat", "implement"];

/** 事件列表筛选条件和分页位置。 */
export interface EventQueue {
  status: string;
  type: string;
  search: string;
  offset: number;
}

/** 事件列表单页大小，与服务端 `limit` 上限以下的默认值一致。 */
export const pageSize = 25;
