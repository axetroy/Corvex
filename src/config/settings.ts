import type { CorvexConfig } from "./config.js";
import { resolveMaxInputTokens } from "../agent/budget.js";
import {
  resolveCompactionKeepRecentTokens,
  resolveCompactionReserveTokens,
  resolveToolCallBytes,
  resolveToolRoundBytes,
  resolveTurnToolResultBytes,
} from "../agent/tool-budget.js";

/**
 * Agent 控制台可在运行时覆盖的设置。
 *
 * 这些值影响模型上下文、审查流程与发布策略，改错会直接导致请求失败或行为异常，
 * 因此每个键都带类型与范围约束；写入前逐项校验，写入后立即作用于后续请求。
 * 凭据、地址、令牌与工作进程轮询参数不在此列，它们只从配置文件或环境变量读取，
 * 修改需要重启进程。
 */
export type RuntimeSettingSection = "agent" | "review" | "chat" | "issue" | "fix" | "storage";

export interface RuntimeSettingDefinition {
  key: string;
  section: RuntimeSettingSection;
  field: string;
  type: "number" | "boolean" | "string";
  min?: number;
  max?: number;
  /** 字符串类型允许的枚举候选值；省略表示任意非空文本。 */
  values?: readonly string[];
  /** 字符串类型允许的最大长度。 */
  maxLength?: number;
  /**
   * 该键被 Worker 在构造阶段读取（例如审查文件上限）。变更后 Worker 需要重建
   * 依赖这些参数的组件，仅改内存配置不会生效。
   */
  workerScoped?: boolean;
}

export const runtimeSettingDefinitions: readonly RuntimeSettingDefinition[] = [
  // 模型与输出语言：PiAgent 与工作流在每次请求/轮次读取，覆盖后立即生效。
  { key: "model", section: "agent", field: "model", type: "string", maxLength: 200 },
  { key: "model_base_url", section: "agent", field: "baseUrl", type: "string", maxLength: 500 },
  { key: "model_api_key", section: "agent", field: "apiKey", type: "string", maxLength: 2_000 },
  { key: "response_language", section: "agent", field: "responseLanguage", type: "string", values: ["en", "zh-CN"] },
  // 上下文预算
  { key: "context_window", section: "agent", field: "contextWindow", type: "number", min: 1_024, max: 10_000_000 },
  { key: "max_input_tokens", section: "agent", field: "maxInputTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "history_token_budget", section: "agent", field: "historyTokenBudget", type: "number", min: 0, max: 10_000_000 },
  { key: "turn_tool_result_bytes", section: "agent", field: "turnToolResultBytes", type: "number", min: 0, max: 64 << 20 },
  { key: "compaction_reserve_tokens", section: "agent", field: "compactionReserveTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "compaction_keep_recent_tokens", section: "agent", field: "compactionKeepRecentTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "max_output_tokens", section: "agent", field: "maxOutputTokens", type: "number", min: 1, max: 8_192 },
  { key: "daily_token_budget", section: "agent", field: "dailyTokenBudget", type: "number", min: 0, max: 1_000_000_000 },
  { key: "summary_enabled", section: "agent", field: "summaryEnabled", type: "boolean" },
  // 工具开关
  { key: "web_enabled", section: "agent", field: "webEnabled", type: "boolean" },
  { key: "mcp_enabled", section: "agent", field: "mcpEnabled", type: "boolean" },
  // 审查与历史评论
  { key: "review_max_files", section: "review", field: "maxFiles", type: "number", min: 1, max: 1_000, workerScoped: true },
  { key: "review_max_findings", section: "review", field: "maxFindings", type: "number", min: 1, max: 100, workerScoped: true },
  { key: "review_max_context_bytes", section: "review", field: "maxContextBytes", type: "number", min: 1, max: 8 << 20, workerScoped: true },
  { key: "review_batch_concurrency", section: "review", field: "batchConcurrency", type: "number", min: 1, max: 4, workerScoped: true },
  { key: "chat_history_comments", section: "chat", field: "historyComments", type: "number", min: 0, max: 50 },
  { key: "issue_history_comments", section: "issue", field: "historyComments", type: "number", min: 0, max: 50 },
  // 修复与 Issue 实现
  { key: "fix_enabled", section: "fix", field: "enabled", type: "boolean" },
  { key: "fix_max_patch_bytes", section: "fix", field: "maxPatchBytes", type: "number", min: 1, max: 256 << 10, workerScoped: true },
  { key: "issue_implement_enabled", section: "issue", field: "implementEnabled", type: "boolean" },
  // 存储与对话工作区：Server 每次回收工作区/执行保留任务时读取，改后无需重启。
  { key: "storage_retention_days", section: "storage", field: "retentionDays", type: "number", min: 1, max: 36_500 },
  { key: "storage_audit_retention_days", section: "storage", field: "auditRetentionDays", type: "number", min: 1, max: 36_500 },
  { key: "conversation_workspace_ttl_minutes", section: "storage", field: "conversationWorkspaceTtlMinutes", type: "number", min: 1, max: 14_400 },
  { key: "conversation_workspace_max", section: "storage", field: "conversationWorkspaceMax", type: "number", min: 1, max: 200 },
];

const definitionsByKey = new Map(runtimeSettingDefinitions.map((definition) => [definition.key, definition]));

/** 写入 SQLite 但绝不回显或写入审计日志的设置键。 */
export const secretRuntimeSettingKeys = new Set(["model_api_key"]);

export interface RuntimeSettingValues {
  [key: string]: number | boolean | string;
}

type MutableSection = Record<string, unknown>;

/** 按设置定义定位到配置对象里的段；各段字段互不重叠。 */
function sectionOf(config: CorvexConfig, section: RuntimeSettingSection): MutableSection {
  return config[section] as unknown as MutableSection;
}

/** 把字符串形式的覆盖值解析为对应的数字、布尔或字符串值；类型非法时抛错。 */
function parseSettingValue(definition: RuntimeSettingDefinition, raw: string): number | boolean | string {
  if (definition.type === "string") {
    const value = raw.trim();
    if (!value) throw new Error(`${definition.key} must not be empty`);
    if (definition.maxLength !== undefined && value.length > definition.maxLength) {
      throw new Error(`${definition.key} must be at most ${definition.maxLength} characters`);
    }
    if (definition.values && !definition.values.includes(value)) {
      throw new Error(`${definition.key} must be one of ${definition.values.join(", ")}`);
    }
    return value;
  }
  if (definition.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`${definition.key} must be "true" or "false"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${definition.key} must be an integer`);
  }
  if (definition.min !== undefined && value < definition.min) {
    throw new Error(`${definition.key} must be at least ${definition.min}`);
  }
  if (definition.max !== undefined && value > definition.max) {
    throw new Error(`${definition.key} must be at most ${definition.max}`);
  }
  return value;
}

/** 跨字段约束：与配置校验保持一致，避免运行时可写入配置文件不允许的组合。 */
function checkRelations(values: RuntimeSettingValues): string[] {
  const problems: string[] = [];
  const contextWindow = values.context_window;
  const maxInputTokens = values.max_input_tokens;
  const historyTokenBudget = values.history_token_budget;
  const reserve = values.compaction_reserve_tokens;
  const keepRecent = values.compaction_keep_recent_tokens;
  if (typeof contextWindow === "number") {
    if (typeof maxInputTokens === "number" && maxInputTokens !== 0 && maxInputTokens >= contextWindow) {
      problems.push("max_input_tokens must be 0 or less than context_window");
    }
    if (typeof historyTokenBudget === "number" && historyTokenBudget > contextWindow) {
      problems.push("history_token_budget must not exceed context_window");
    }
    if (typeof reserve === "number" && reserve >= contextWindow) {
      problems.push("compaction_reserve_tokens must be less than context_window");
    }
    if (typeof keepRecent === "number" && keepRecent > contextWindow) {
      problems.push("compaction_keep_recent_tokens must not exceed context_window");
    }
  }
  const modelBaseUrl = values.model_base_url;
  if (typeof modelBaseUrl === "string") {
    try {
      const url = new URL(modelBaseUrl);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username || url.password || url.search || url.hash
      ) {
        problems.push("model_base_url must be a valid HTTP(S) URL without credentials, query or fragment");
      }
    } catch {
      problems.push("model_base_url must be a valid HTTP(S) URL without credentials, query or fragment");
    }
  }
  return problems;
}

/** 校验覆盖项集合；返回错误列表，空数组表示可写入。 */
export function validateRuntimeSettings(overrides: Record<string, string>): string[] {
  const problems: string[] = [];
  const values: RuntimeSettingValues = {};
  for (const [key, raw] of Object.entries(overrides)) {
    const definition = definitionsByKey.get(key);
    if (!definition) {
      problems.push(`unknown setting "${key}"`);
      continue;
    }
    try {
      values[key] = parseSettingValue(definition, raw);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  problems.push(...checkRelations(values));
  return problems;
}

/**
 * 把覆盖项应用到配置对象。就地修改对应段，让已经持有该对象引用的 Runner 与
 * PiAgent 立即看到新值；Worker 需要自行决定何时重建构造期读取参数的组件。
 */
export function applyRuntimeSettings(config: CorvexConfig, overrides: Record<string, string>): void {
  for (const [key, raw] of Object.entries(overrides)) {
    const definition = definitionsByKey.get(key);
    if (!definition) continue;
    sectionOf(config, definition.section)[definition.field] = parseSettingValue(definition, raw);
  }
}

/**
 * 把存储中的覆盖项应用到配置；单行损坏时跳过并告警，避免旧数据拖垮整个进程。
 * 返回实际应用的键，供启动与热加载日志记录。
 */
export function applyRuntimeSettingRows(
  config: CorvexConfig,
  rows: readonly { key: string; value: string }[],
): string[] {
  const applied: string[] = [];
  for (const row of rows) {
    const definition = definitionsByKey.get(row.key);
    if (!definition) continue;
    try {
      sectionOf(config, definition.section)[definition.field] = parseSettingValue(definition, row.value);
      applied.push(row.key);
    } catch (error) {
      console.warn("ignored invalid runtime setting", {
        key: row.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return applied;
}

/** 当前配置中的设置值，供 Agent 控制台回显；键与覆盖项一致。 */
export function runtimeSettingsView(config: CorvexConfig): RuntimeSettingValues {
  const view: RuntimeSettingValues = {};
  for (const definition of runtimeSettingDefinitions) {
    view[definition.key] = sectionOf(config, definition.section)[definition.field] as number | boolean | string;
  }
  return view;
}

/** 把可覆盖字段从源配置复制到目标配置，使删除覆盖项后能立即回退到文件值。 */
export function copyRuntimeSettings(from: CorvexConfig, to: CorvexConfig): void {
  for (const definition of runtimeSettingDefinitions) {
    sectionOf(to, definition.section)[definition.field] =
      sectionOf(from, definition.section)[definition.field];
  }
}

/** Agent 控制台可覆盖的配置键集合，用于把存储中的覆盖项过滤为已知键。 */
export function isRuntimeSettingKey(key: string): boolean {
  return definitionsByKey.has(key);
}

/** 由窗口与工具预算推导出的只读指标，界面用来解释「配置值 ≠ 生效值」。 */
export interface DerivedContextMetrics {
  /** 单次请求输入上限（由窗口、输出预留推导）。 */
  maxInputTokens: number;
  /** 单个工具结果的硬上限（字节）。 */
  toolCallBytes: number;
  /** 每个助手轮次的工具输出硬上限（字节）。 */
  toolRoundBytes: number;
  /** 实际触发压缩的估算 token 数 = 窗口 − 预留。 */
  compactionTriggerTokens: number;
  /** 压缩后保留的最近 token 数。 */
  compactionKeepRecentTokens: number;
  /** 单轮软检查点阈值（字节）；0 表示关闭提醒。 */
  turnToolResultBytes: number;
}

export interface EffectiveSettings {
  /** 每个键的实际生效值：配置值叠加运行时的自动推导与上下限。 */
  effective: RuntimeSettingValues;
  /** 生效值与配置值不一致的键；界面据此提示「已自动调整」。 */
  adjusted: string[];
  derived: DerivedContextMetrics;
}

/**
 * 计算实际生效值。运行时会根据窗口推导输入上限、工具输出预算与压缩阈值，
 * 因此界面必须展示推导结果，否则用户会以为填写的值没有保存。
 */
export function runtimeSettingsEffective(config: CorvexConfig): EffectiveSettings {
  const agent = config.agent;
  const configured = runtimeSettingsView(config);
  const effective = { ...configured };
  const maxInputTokens = resolveMaxInputTokens(agent);
  const toolRoundBytes = resolveToolRoundBytes(agent.contextWindow);
  const compactionReserveTokens = resolveCompactionReserveTokens(
    agent.contextWindow,
    agent.maxOutputTokens,
    agent.compactionReserveTokens,
  );
  const compactionKeepRecentTokens = resolveCompactionKeepRecentTokens(
    agent.contextWindow,
    agent.compactionKeepRecentTokens,
    compactionReserveTokens,
  );
  const turnToolResultBytes = resolveTurnToolResultBytes(agent.contextWindow, agent.turnToolResultBytes);
  effective.max_input_tokens = maxInputTokens;
  effective.turn_tool_result_bytes = turnToolResultBytes;
  effective.compaction_reserve_tokens = compactionReserveTokens;
  effective.compaction_keep_recent_tokens = compactionKeepRecentTokens;
  const adjusted = ["max_input_tokens", "turn_tool_result_bytes", "compaction_reserve_tokens", "compaction_keep_recent_tokens"]
    .filter((key) => effective[key] !== configured[key]);
  return {
    effective,
    adjusted,
    derived: {
      maxInputTokens,
      toolCallBytes: resolveToolCallBytes(toolRoundBytes),
      toolRoundBytes,
      compactionTriggerTokens: Math.max(0, agent.contextWindow - compactionReserveTokens),
      compactionKeepRecentTokens,
      turnToolResultBytes,
    },
  };
}
