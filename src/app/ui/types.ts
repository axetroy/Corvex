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

/** `GET/PUT /api/ops/settings` 的响应体：当前生效值、覆盖项与是否可写。 */
export interface SettingsResponse {
  settings: Record<string, number | boolean>;
  /** 配置文件中的原始值，用于「恢复默认」；无法读盘时为空。 */
  base: Record<string, number | boolean> | null;
  /** 仅包含被运行时覆盖的键，值以字符串形式存储。 */
  overrides: Record<string, string>;
  editable: boolean;
  configPath: string | null;
}

/** 设置项的输入类型；布尔项渲染为开关，数字项渲染为输入框。 */
export type SettingKind = "number" | "boolean";

/** 运维台展示的上下文设置元数据，键名与 `src/config/settings.ts` 一致。 */
export interface SettingField {
  key: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  step?: number;
  /** 输入单位提示，例如 token。 */
  unit?: string;
  /** 文案键：字段标签与说明。 */
  labelKey: string;
  hintKey: string;
}

/**
 * 可编辑的上下文设置清单。分三组呈现：窗口与预算、压缩阈值、输出与配额。
 * 键必须与 `runtimeSettingDefinitions` 对应，否则写入会被服务端拒绝。
 */
export const settingGroups: readonly { titleKey: string; hintKey: string; fields: readonly SettingField[] }[] = [
  {
    titleKey: "settingsGroupWindow",
    hintKey: "settingsGroupWindowHint",
    fields: [
      { key: "context_window", kind: "number", min: 1024, max: 10_000_000, step: 1024, unit: "token", labelKey: "settingsContextWindow", hintKey: "settingsContextWindowHint" },
      { key: "max_input_tokens", kind: "number", min: 0, max: 10_000_000, step: 1024, unit: "token", labelKey: "settingsMaxInputTokens", hintKey: "settingsMaxInputTokensHint" },
      { key: "history_token_budget", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsHistoryTokenBudget", hintKey: "settingsHistoryTokenBudgetHint" },
      { key: "turn_tool_result_bytes", kind: "number", min: 0, max: 64 << 20, step: 1024, unit: "byte", labelKey: "settingsTurnToolResultBytes", hintKey: "settingsTurnToolResultBytesHint" },
    ],
  },
  {
    titleKey: "settingsGroupCompaction",
    hintKey: "settingsGroupCompactionHint",
    fields: [
      { key: "compaction_reserve_tokens", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsCompactionReserveTokens", hintKey: "settingsCompactionReserveTokensHint" },
      { key: "compaction_keep_recent_tokens", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsCompactionKeepRecentTokens", hintKey: "settingsCompactionKeepRecentTokensHint" },
      { key: "summary_enabled", kind: "boolean", labelKey: "settingsSummaryEnabled", hintKey: "settingsSummaryEnabledHint" },
    ],
  },
  {
    titleKey: "settingsGroupQuota",
    hintKey: "settingsGroupQuotaHint",
    fields: [
      { key: "max_output_tokens", kind: "number", min: 1, max: 8192, step: 256, unit: "token", labelKey: "settingsMaxOutputTokens", hintKey: "settingsMaxOutputTokensHint" },
      { key: "daily_token_budget", kind: "number", min: 0, max: 1_000_000_000, step: 100_000, unit: "token", labelKey: "settingsDailyTokenBudget", hintKey: "settingsDailyTokenBudgetHint" },
    ],
  },
];
