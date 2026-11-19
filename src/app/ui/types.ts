import type {
  Conversation,
  ConversationDetail,
  ConversationMessage,
  ConversationPage,
  ConversationProcessEntry,
  ConversationStats,
  ConversationStreamEvent,
  ConversationStreamTool,
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
  RepositoryDetails,
  StorageCleanupRecord,
} from "../../events/model.js";

/**
 * Agent 控制台依赖的接口数据结构。字段形状与 `src/events/model.ts` 一致，
 * 这里只做 HTTP 边界的重新导出，避免前端重复声明。
 */
export type {
  Conversation,
  ConversationDetail,
  ConversationMessage,
  ConversationPage,
  ConversationProcessEntry,
  ConversationStats,
  ConversationStreamEvent,
  ConversationStreamTool,
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
  RepositoryDetails,
  StorageCleanupRecord,
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

/** Agent 控制台展示的事件生命周期状态，与服务端 `eventStatuses` 保持同一顺序。 */
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

/** `GET/PUT /api/ops/settings` 的响应体：当前值、生效值、覆盖项与是否可写。 */
export interface SettingsResponse {
  settings: Record<string, number | boolean | string>;
  /** 自动推导后的实际生效值；与 `settings` 不同时以这里为准。 */
  effective: Record<string, number | boolean | string>;
  /** 被运行时自动调整的键，界面据此提示「已自动调整」。 */
  adjusted: string[];
  /** 由窗口与工具预算推导出的只读指标。 */
  derived: DerivedContextMetrics;
  /** 配置文件中的原始值，用于「恢复默认」；无法读盘时为空。 */
  base: Record<string, number | boolean | string> | null;
  /** 仅包含被运行时覆盖的键，值以字符串形式存储。 */
  overrides: Record<string, string>;
  /** 每个覆盖项的修改时间与操作者。 */
  overrideMeta: Record<string, { updatedAt: string; updatedBy: string }>;
  editable: boolean;
  configPath: string | null;
}

/** 服务端推导出的上下文指标；字段与 `src/config/settings.ts` 保持一致。 */
export interface DerivedContextMetrics {
  maxInputTokens: number;
  toolCallBytes: number;
  toolRoundBytes: number;
  compactionTriggerTokens: number;
  compactionKeepRecentTokens: number;
  turnToolResultBytes: number;
}

/** 设置项的输入类型；布尔项渲染为开关，数字项渲染为输入框，字符串项渲染为文本框或下拉。 */
export type SettingKind = "number" | "boolean" | "string";

/** Agent 控制台展示的上下文设置元数据，键名与 `src/config/settings.ts` 一致。 */
export interface SettingField {
  key: string;
  kind: SettingKind;
  min?: number;
  max?: number;
  step?: number;
  /** 字符串项的枚举候选；提供时渲染为下拉选择。 */
  values?: readonly string[];
  /** 字符串项的最大长度。 */
  maxLength?: number;
  /** 输入单位提示，例如 token。 */
  unit?: string;
  /** 文案键：字段标签与说明。 */
  labelKey: string;
  hintKey: string;
}

/**
 * 可编辑的设置清单。常用项平铺，改动会立即作用于对话与工件的参数；
 * 窗口推导类参数放在最后的折叠「高级」分组，避免把部署事实当成日常调优项。
 * 键必须与 `runtimeSettingDefinitions` 对应，否则写入会被服务端拒绝。
 */
export interface SettingGroup {
  titleKey: string;
  hintKey: string;
  /** 折叠显示；用于推导量或部署事实。 */
  advanced?: boolean;
  fields: readonly SettingField[];
}

export const settingGroups: readonly SettingGroup[] = [
  {
    titleKey: "settingsGroupModel",
    hintKey: "settingsGroupModelHint",
    fields: [
      { key: "model", kind: "string", maxLength: 200, labelKey: "settingsModel", hintKey: "settingsModelHint" },
      { key: "response_language", kind: "string", values: ["en", "zh-CN"], labelKey: "settingsResponseLanguage", hintKey: "settingsResponseLanguageHint" },
    ],
  },
  {
    titleKey: "settingsGroupBudget",
    hintKey: "settingsGroupBudgetHint",
    fields: [
      { key: "history_token_budget", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsHistoryTokenBudget", hintKey: "settingsHistoryTokenBudgetHint" },
      { key: "turn_tool_result_bytes", kind: "number", min: 0, max: 64 << 20, step: 1024, unit: "byte", labelKey: "settingsTurnToolResultBytes", hintKey: "settingsTurnToolResultBytesHint" },
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
  {
    titleKey: "settingsGroupTools",
    hintKey: "settingsGroupToolsHint",
    fields: [
      { key: "web_enabled", kind: "boolean", labelKey: "settingsWebEnabled", hintKey: "settingsWebEnabledHint" },
      { key: "mcp_enabled", kind: "boolean", labelKey: "settingsMcpEnabled", hintKey: "settingsMcpEnabledHint" },
    ],
  },
  {
    titleKey: "settingsGroupStorage",
    hintKey: "settingsGroupStorageHint",
    fields: [
      { key: "conversation_workspace_ttl_minutes", kind: "number", min: 1, max: 14_400, step: 10, labelKey: "settingsWorkspaceTtl", hintKey: "settingsWorkspaceTtlHint" },
      { key: "conversation_workspace_max", kind: "number", min: 1, max: 200, step: 1, labelKey: "settingsWorkspaceMax", hintKey: "settingsWorkspaceMaxHint" },
      { key: "storage_retention_days", kind: "number", min: 1, max: 36_500, step: 30, labelKey: "settingsRetentionDays", hintKey: "settingsRetentionDaysHint" },
      { key: "storage_audit_retention_days", kind: "number", min: 1, max: 36_500, step: 30, labelKey: "settingsAuditRetentionDays", hintKey: "settingsAuditRetentionDaysHint" },
    ],
  },
  {
    titleKey: "settingsGroupReview",
    hintKey: "settingsGroupReviewHint",
    fields: [
      { key: "review_max_files", kind: "number", min: 1, max: 1000, step: 10, labelKey: "settingsReviewMaxFiles", hintKey: "settingsReviewMaxFilesHint" },
      { key: "review_max_findings", kind: "number", min: 1, max: 100, step: 5, labelKey: "settingsReviewMaxFindings", hintKey: "settingsReviewMaxFindingsHint" },
      { key: "review_max_context_bytes", kind: "number", min: 1, max: 8 << 20, step: 4096, unit: "byte", labelKey: "settingsReviewMaxContextBytes", hintKey: "settingsReviewMaxContextBytesHint" },
      { key: "review_batch_concurrency", kind: "number", min: 1, max: 4, step: 1, labelKey: "settingsReviewBatchConcurrency", hintKey: "settingsReviewBatchConcurrencyHint" },
      { key: "chat_history_comments", kind: "number", min: 0, max: 50, step: 5, labelKey: "settingsChatHistoryComments", hintKey: "settingsChatHistoryCommentsHint" },
      { key: "issue_history_comments", kind: "number", min: 0, max: 50, step: 5, labelKey: "settingsIssueHistoryComments", hintKey: "settingsIssueHistoryCommentsHint" },
    ],
  },
  {
    titleKey: "settingsGroupWorkflow",
    hintKey: "settingsGroupWorkflowHint",
    fields: [
      { key: "fix_enabled", kind: "boolean", labelKey: "settingsFixEnabled", hintKey: "settingsFixEnabledHint" },
      { key: "fix_max_patch_bytes", kind: "number", min: 1, max: 256 << 10, step: 1024, unit: "byte", labelKey: "settingsFixMaxPatchBytes", hintKey: "settingsFixMaxPatchBytesHint" },
      { key: "issue_implement_enabled", kind: "boolean", labelKey: "settingsIssueImplementEnabled", hintKey: "settingsIssueImplementEnabledHint" },
    ],
  },
  {
    titleKey: "settingsGroupAdvanced",
    hintKey: "settingsGroupAdvancedHint",
    advanced: true,
    fields: [
      { key: "context_window", kind: "number", min: 1024, max: 10_000_000, step: 1024, unit: "token", labelKey: "settingsContextWindow", hintKey: "settingsContextWindowHint" },
      { key: "max_input_tokens", kind: "number", min: 0, max: 10_000_000, step: 1024, unit: "token", labelKey: "settingsMaxInputTokens", hintKey: "settingsMaxInputTokensHint" },
      { key: "compaction_reserve_tokens", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsCompactionReserveTokens", hintKey: "settingsCompactionReserveTokensHint" },
      { key: "compaction_keep_recent_tokens", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsCompactionKeepRecentTokens", hintKey: "settingsCompactionKeepRecentTokensHint" },
    ],
  },
];
