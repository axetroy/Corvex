import type {
  Conversation,
  ConversationDetail,
  ConversationMessage,
  ConversationPage,
  ConversationProcessEntry,
  ConversationStats,
  ConversationStreamContext,
  ConversationStreamEvent,
  ConversationStreamTool,
  ConversationSummary,
  ContextMetric,
  ConversationToolCall,
  ConversationTurn,
  ConversationTurnSegment,
  ConversationTurnStats,
  ConversationTurns,
  ExecutionStep,
  TraceEntry,
  TraceKind,
  TraceStatus,
  ModelCallMetric,
  ModelProviderDetails,
  ProviderModel,
  OperationsOverview,
  RepositoryDetails,
  StorageCleanupRecord,
} from "../../model.js";

/**
 * Agent 控制台依赖的接口数据结构。字段形状与 `src/model.ts` 一致，
 * 这里只做 HTTP 边界的重新导出，避免前端重复声明。
 */
export type {
  Conversation,
  ConversationDetail,
  ConversationMessage,
  ConversationPage,
  ConversationProcessEntry,
  ConversationStats,
  ConversationStreamContext,
  ConversationStreamEvent,
  ConversationStreamTool,
  ConversationSummary,
  ContextMetric,
  ConversationToolCall,
  ConversationTurn,
  ConversationTurnSegment,
  ConversationTurnStats,
  ConversationTurns,
  ExecutionStep,
  TraceEntry,
  TraceKind,
  TraceStatus,
  ModelCallMetric,
  ModelProviderDetails,
  ProviderModel,
  RepositoryDetails,
  StorageCleanupRecord,
};

/** `GET /api/ops/overview` 的响应体。 */
export interface OverviewResponse extends OperationsOverview {
  generatedAt: string;
  oldestQueueAgeSeconds: number | null;
  modelCalls: ModelCallMetric[];
  contextMetrics: ContextMetric[];
}

/** 分页默认单页大小。 */
export const pageSize = 25;

/** 运行时设置值：列表项以字符串数组回显，数字项以秒或毫秒为单位。 */
export type SettingValue = number | boolean | string | string[];

/** `GET/PUT /api/ops/settings` 的响应体：当前值、生效值、覆盖项与是否可写。 */
export interface SettingsResponse {
  settings: Record<string, SettingValue>;
  /** 自动推导后的实际生效值；与 `settings` 不同时以这里为准。 */
  effective: Record<string, SettingValue>;
  /** 被运行时自动调整的键，界面据此提示「已自动调整」。 */
  adjusted: string[];
  /** 由窗口与工具预算推导出的只读指标。 */
  derived: DerivedContextMetrics;
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

/** 设置项的输入类型；列表项渲染为可增删的标签输入框。 */
export type SettingKind = "number" | "boolean" | "string" | "list";

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
  /** 列表项的元素类型：用户 ID 为整数，其余按文本处理。 */
  item?: "integer" | "hostname" | "path";
  /** 密钥字段用密码框展示，允许留空表示沿用已保存值。 */
  secret?: boolean;
  /** 字符串字段允许留空（例如可选的用户名）。 */
  allowEmpty?: boolean;
  /** 输入单位提示，例如 token。 */
  unit?: string;
  /** 服务端尚未报告该键时展示的默认值（例如前端比服务端新），不参与脏检查。 */
  defaultValue?: SettingValue;
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
      { key: "context_inspect_enabled", kind: "boolean", labelKey: "settingsContextInspectEnabled", hintKey: "settingsContextInspectEnabledHint" },
      { key: "context_inspect_max_items", kind: "number", min: 1, max: 500, step: 1, labelKey: "settingsContextInspectMaxItems", hintKey: "settingsContextInspectMaxItemsHint" },
      { key: "context_inspect_max_preview_chars", kind: "number", min: 128, max: 16384, step: 128, unit: "byte", labelKey: "settingsContextInspectMaxPreviewChars", hintKey: "settingsContextInspectMaxPreviewCharsHint" },
    ],
  },
  {
    titleKey: "settingsGroupQuota",
    hintKey: "settingsGroupQuotaHint",
    fields: [
      { key: "daily_token_budget", kind: "number", min: 0, max: 1_000_000_000, step: 100_000, unit: "token", labelKey: "settingsDailyTokenBudget", hintKey: "settingsDailyTokenBudgetHint" },
    ],
  },
  {
    titleKey: "settingsGroupTools",
    hintKey: "settingsGroupToolsHint",
    fields: [
      { key: "web_enabled", kind: "boolean", labelKey: "settingsWebEnabled", hintKey: "settingsWebEnabledHint" },
      { key: "web_blocked_hosts", kind: "list", item: "hostname", labelKey: "settingsWebBlockedHosts", hintKey: "settingsWebBlockedHostsHint" },
      { key: "web_search_enabled", kind: "boolean", labelKey: "settingsWebSearchEnabled", hintKey: "settingsWebSearchEnabledHint" },
      { key: "web_search_max_queries", kind: "number", min: 1, max: 50, step: 1, labelKey: "settingsWebSearchMaxQueries", hintKey: "settingsWebSearchMaxQueriesHint" },
      { key: "skill_paths", kind: "list", item: "path", labelKey: "settingsSkillPaths", hintKey: "settingsSkillPathsHint" },
      { key: "project_agents_md", kind: "boolean", defaultValue: true, labelKey: "settingsProjectAgentsMd", hintKey: "settingsProjectAgentsMdHint" },
      { key: "project_agents_md_max_bytes", kind: "number", min: 1024, max: 262144, step: 1024, unit: "byte", defaultValue: 32 * 1024, labelKey: "settingsProjectAgentsMdMaxBytes", hintKey: "settingsProjectAgentsMdMaxBytesHint" },
    ],
  },
  {
    titleKey: "settingsGroupRuntime",
    hintKey: "settingsGroupRuntimeHint",
    advanced: true,
    fields: [
      { key: "agent_request_timeout", kind: "number", min: 1, max: 3_600, step: 10, unit: "second", labelKey: "settingsAgentRequestTimeout", hintKey: "settingsAgentRequestTimeoutHint" },
      { key: "agent_session_timeout", kind: "number", min: 1, max: 86_400, step: 300, unit: "second", labelKey: "settingsAgentSessionTimeout", hintKey: "settingsAgentSessionTimeoutHint" },
      { key: "agent_response_stall_timeout", kind: "number", min: 0, max: 3_600, step: 30, unit: "second", labelKey: "settingsResponseStallTimeout", hintKey: "settingsResponseStallTimeoutHint" },
    ],
  },
  {
    titleKey: "settingsGroupGitLab",
    hintKey: "settingsGroupGitLabHint",
    fields: [
      { key: "gitlab_base_url", kind: "string", maxLength: 500, allowEmpty: true, labelKey: "settingsGitLabBaseUrl", hintKey: "settingsGitLabBaseUrlHint" },
      { key: "gitlab_oauth_client_id", kind: "string", maxLength: 500, allowEmpty: true, labelKey: "settingsOAuthClientId", hintKey: "settingsOAuthClientIdHint" },
      { key: "gitlab_oauth_client_secret", kind: "string", maxLength: 2000, secret: true, labelKey: "settingsOAuthClientSecret", hintKey: "settingsOAuthClientSecretHint" },
      { key: "gitlab_oauth_redirect_uri", kind: "string", maxLength: 500, allowEmpty: true, labelKey: "settingsOAuthRedirectUri", hintKey: "settingsOAuthRedirectUriHint" },
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
    titleKey: "settingsGroupAdvanced",
    hintKey: "settingsGroupAdvancedHint",
    advanced: true,
    fields: [
      { key: "max_input_tokens", kind: "number", min: 0, max: 10_000_000, step: 1024, unit: "token", labelKey: "settingsMaxInputTokens", hintKey: "settingsMaxInputTokensHint" },
      { key: "auto_context_tune", kind: "boolean", labelKey: "settingsAutoContextTune", hintKey: "settingsAutoContextTuneHint" },
      { key: "compaction_reserve_tokens", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsCompactionReserveTokens", hintKey: "settingsCompactionReserveTokensHint" },
      { key: "compaction_keep_recent_tokens", kind: "number", min: 0, max: 10_000_000, step: 1000, unit: "token", labelKey: "settingsCompactionKeepRecentTokens", hintKey: "settingsCompactionKeepRecentTokensHint" },
      { key: "compaction_trigger_percent", kind: "number", min: 50, max: 95, step: 5, unit: "%", labelKey: "settingsCompactionTriggerPercent", hintKey: "settingsCompactionTriggerPercentHint" },
      { key: "compaction_dynamic_threshold", kind: "boolean", labelKey: "settingsCompactionDynamicThreshold", hintKey: "settingsCompactionDynamicThresholdHint" },
    ],
  },
];
