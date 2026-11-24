import type { CorvexConfig } from "./config.js";
import type { ActiveModel } from "../model.js";
import { isIP } from "node:net";
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
 * 这些值影响模型上下文、工具边界与存储策略，改错会直接导致请求失败或
 * 行为异常，因此每个键都带类型与范围约束；写入前逐项校验，写入后立即作用于后续请求。
 * 只有启动必需项不在其中：监听地址、数据库与存储路径、控制台凭据、GitLab 令牌等，
 * 这些仍从配置文件或环境变量读取。
 */
export type RuntimeSettingSection = "agent" | "storage" | "gitlab" | "operations";

export interface RuntimeSettingDefinition {
  key: string;
  section: RuntimeSettingSection;
  field: string;
  type: "number" | "boolean" | "string" | "list";
  min?: number;
  max?: number;
  /** 字符串类型允许的枚举候选值；省略表示任意非空文本。 */
  values?: readonly string[];
  /** 字符串类型允许的最大长度。 */
  maxLength?: number;
  /** 输入单位换算：配置值 = 输入值 × scale（例如界面秒、配置毫秒）。 */
  scale?: number;
  /** 列表项的校验规则。 */
  item?: "integer" | "hostname" | "path";
  /** 允许提交空字符串（例如 bot 用户名留空）。 */
  allowEmpty?: boolean;
  /**
   * 不在运维台展示的旧键。模型名、地址、密钥、上下文窗口与输出上限已由
   * 「模型 > 供应商与模型」管理，这里保留读取是为了升级后旧覆盖项仍能生效。
   */
  hidden?: boolean;
}

export const runtimeSettingDefinitions: readonly RuntimeSettingDefinition[] = [
  // 模型与输出语言：PiAgent 与工作流在每次请求/轮次读取，覆盖后立即生效。
  // 前五项是模型列表出现之前的旧键，保留只为升级兼容，控制台不再展示；
  // 供应商下的模型（见 applyActiveModel）选中时优先级更高。
  { key: "model", section: "agent", field: "model", type: "string", maxLength: 200, hidden: true },
  { key: "model_base_url", section: "agent", field: "baseUrl", type: "string", maxLength: 500, hidden: true },
  // 本地模型服务可以没有密钥，因此允许留空。
  { key: "model_api_key", section: "agent", field: "apiKey", type: "string", maxLength: 2_000, allowEmpty: true, hidden: true },
  { key: "response_language", section: "agent", field: "responseLanguage", type: "string", values: ["en", "zh-CN"] },
  // 上下文预算
  { key: "context_window", section: "agent", field: "contextWindow", type: "number", min: 1_024, max: 10_000_000, hidden: true },
  { key: "auto_context_tune", section: "agent", field: "autoContextTune", type: "boolean" },
  { key: "max_input_tokens", section: "agent", field: "maxInputTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "history_token_budget", section: "agent", field: "historyTokenBudget", type: "number", min: 0, max: 10_000_000 },
  { key: "turn_tool_result_bytes", section: "agent", field: "turnToolResultBytes", type: "number", min: 0, max: 64 << 20 },
  { key: "compaction_reserve_tokens", section: "agent", field: "compactionReserveTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "compaction_keep_recent_tokens", section: "agent", field: "compactionKeepRecentTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "compaction_trigger_percent", section: "agent", field: "compactionTriggerPercent", type: "number", min: 50, max: 95 },
  { key: "compaction_dynamic_threshold", section: "agent", field: "compactionDynamicThreshold", type: "boolean" },
  { key: "max_output_tokens", section: "agent", field: "maxOutputTokens", type: "number", min: 1, max: 8_192, hidden: true },
  { key: "daily_token_budget", section: "agent", field: "dailyTokenBudget", type: "number", min: 0, max: 1_000_000_000 },
  { key: "summary_enabled", section: "agent", field: "summaryEnabled", type: "boolean" },
  { key: "project_agents_md", section: "agent", field: "projectAgentsMd", type: "boolean" },
  { key: "project_agents_md_max_bytes", section: "agent", field: "projectAgentsMdMaxBytes", type: "number", min: 1_024, max: 262_144 },
  // 上下文洞察：每次模型请求前采集有界快照，默认开启；关闭后不增加请求延迟。
  { key: "context_inspect_enabled", section: "agent", field: "contextInspectEnabled", type: "boolean" },
  { key: "context_inspect_max_items", section: "agent", field: "contextInspectMaxItems", type: "number", min: 1, max: 500 },
  { key: "context_inspect_max_preview_chars", section: "agent", field: "contextInspectMaxPreviewChars", type: "number", min: 128, max: 16_384 },
  // 工具开关与联网白名单
  { key: "web_enabled", section: "agent", field: "webEnabled", type: "boolean" },
  { key: "web_blocked_hosts", section: "agent", field: "webBlockedHosts", type: "list", item: "hostname" },
  { key: "web_search_enabled", section: "agent", field: "webSearchEnabled", type: "boolean" },
  { key: "web_search_max_queries", section: "agent", field: "webSearchMaxQueries", type: "number", min: 1, max: 50 },
  { key: "git_tool_call_limit", section: "agent", field: "gitToolCallLimit", type: "number", min: 0, max: 200 },
  { key: "auto_create_merge_request", section: "agent", field: "autoCreateMergeRequest", type: "boolean" },
  { key: "reasoning_enabled", section: "agent", field: "reasoningEnabled", type: "boolean" },
  // 运行时长：秒为界面单位，配置内部仍用毫秒。
  { key: "agent_request_timeout", section: "agent", field: "requestTimeout", type: "number", min: 1, max: 3_600, scale: 1_000 },
  { key: "agent_session_timeout", section: "agent", field: "sessionTimeout", type: "number", min: 1, max: 86_400, scale: 1_000 },
  { key: "agent_response_stall_timeout", section: "agent", field: "responseStallTimeout", type: "number", min: 0, max: 3_600, scale: 1_000 },
  // Skill 根目录：影响 read_file 的允许根，仅在下一轮 Session 创建时读取。
  { key: "skill_paths", section: "agent", field: "skillPaths", type: "list", item: "path" },
  // GitLab 连接：Server 每次请求时读取。
  // 留空表示尚未配置 GitLab；与 config 层一致，只在非空时校验 URL。
  { key: "gitlab_base_url", section: "gitlab", field: "baseUrl", type: "string", maxLength: 500, allowEmpty: true },
  // GitLab OAuth：由安装页面写入，三者必须同时配置。
  { key: "gitlab_oauth_client_id", section: "gitlab", field: "oauthClientId", type: "string", maxLength: 500, allowEmpty: true },
  { key: "gitlab_oauth_client_secret", section: "gitlab", field: "oauthClientSecret", type: "string", maxLength: 2_000, allowEmpty: true },
  { key: "gitlab_oauth_redirect_uri", section: "gitlab", field: "oauthRedirectUri", type: "string", maxLength: 500, allowEmpty: true },
  // 存储与对话工作区：Server 每次回收工作区/执行保留任务时读取，改后无需重启。
  { key: "storage_retention_days", section: "storage", field: "retentionDays", type: "number", min: 1, max: 36_500 },
  { key: "storage_audit_retention_days", section: "storage", field: "auditRetentionDays", type: "number", min: 1, max: 36_500 },
  { key: "conversation_workspace_ttl_minutes", section: "storage", field: "conversationWorkspaceTtlMinutes", type: "number", min: 1, max: 14_400 },
  { key: "conversation_workspace_max", section: "storage", field: "conversationWorkspaceMax", type: "number", min: 1, max: 200 },
];

const definitionsByKey = new Map(runtimeSettingDefinitions.map((definition) => [definition.key, definition]));

/** 写入 SQLite 但绝不回显或写入审计日志的设置键。 */
export const secretRuntimeSettingKeys = new Set([
  "model_api_key",
  "gitlab_oauth_client_secret",
]);

/** 运行时设置值；列表项统一以字符串数组回显，写入时按定义转换。 */
export type RuntimeSettingValue = number | boolean | string | string[];

export interface RuntimeSettingValues {
  [key: string]: RuntimeSettingValue;
}

type MutableSection = Record<string, unknown>;

/** 按设置定义定位到配置对象里的段；各段字段互不重叠。 */
function sectionOf(config: CorvexConfig, section: RuntimeSettingSection): MutableSection {
  return config[section] as unknown as MutableSection;
}

/** 校验列表项；返回统一为字符串，整型项在写回配置时再转成数字。 */
function parseListItem(definition: RuntimeSettingDefinition, item: unknown): string {
  if (definition.item === "integer") {
    const value = typeof item === "number" ? item : typeof item === "string" ? Number(item.trim()) : Number.NaN;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${definition.key} items must be positive integers`);
    }
    return String(value);
  }
  if (typeof item !== "string") throw new Error(`${definition.key} items must be strings`);
  const value = item.trim();
  if (!value) throw new Error(`${definition.key} items must not be empty`);
  if (definition.item === "hostname") {
    if (value.length > 253 || value.includes("/") || value.includes(":") || /\s/.test(value)) {
      throw new Error(`${definition.key} items must be bare hostnames`);
    }
    if (!isIP(value) && !value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) {
      throw new Error(`${definition.key} items must be bare hostnames`);
    }
  }
  if (definition.item === "path" && value.length > 1_024) {
    throw new Error(`${definition.key} items must be at most 1024 characters`);
  }
  return value;
}

/** 把字符串形式的覆盖值解析为对应的数字、布尔、字符串或列表；类型非法时抛错。 */
function parseSettingValue(definition: RuntimeSettingDefinition, raw: string): RuntimeSettingValue {
  if (definition.type === "list") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${definition.key} must be a JSON array`);
    }
    if (!Array.isArray(parsed)) throw new Error(`${definition.key} must be a JSON array`);
    return parsed.map((item) => parseListItem(definition, item));
  }
  if (definition.type === "string") {
    const value = raw.trim();
    if (!value && !definition.allowEmpty) throw new Error(`${definition.key} must not be empty`);
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
  // 带 scale 的字段（秒 → 毫秒）允许小数，其余整型设置必须是安全整数。
  if (!Number.isFinite(value) || (definition.scale === undefined && !Number.isSafeInteger(value))) {
    throw new Error(`${definition.key} must be ${definition.scale === undefined ? "an integer" : "a number"}`);
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
  const oauth = [
    values.gitlab_oauth_client_id,
    values.gitlab_oauth_client_secret,
    values.gitlab_oauth_redirect_uri,
  ];
  if (oauth.some(Boolean) && oauth.some((value) => !value)) {
    problems.push("GitLab OAuth requires client ID, client secret and redirect URI together");
  }
  if (typeof values.gitlab_oauth_redirect_uri === "string" && values.gitlab_oauth_redirect_uri) {
    try {
      const url = new URL(values.gitlab_oauth_redirect_uri);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        problems.push("gitlab_oauth_redirect_uri must be a valid HTTP(S) URL");
      }
    } catch {
      problems.push("gitlab_oauth_redirect_uri must be a valid HTTP(S) URL");
    }
  }
  const gitlabBaseUrl = values.gitlab_base_url;
  if (typeof gitlabBaseUrl === "string" && gitlabBaseUrl) {
    try {
      const url = new URL(gitlabBaseUrl);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        url.username || url.password || url.search || url.hash
      ) {
        problems.push("gitlab_base_url must be a valid HTTP(S) URL without credentials, query or fragment");
      }
    } catch {
      problems.push("gitlab_base_url must be a valid HTTP(S) URL without credentials, query or fragment");
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
 * 把选中的模型应用到运行时配置。连接参数来自供应商，窗口与输出上限来自模型；
 * 控制台的供应商/模型目录是这些字段的唯一来源。
 */
export function applyActiveModel(config: CorvexConfig, active: ActiveModel): void {
  config.agent.model = active.model.name;
  config.agent.providerName = active.provider.name;
  config.agent.baseUrl = active.provider.baseUrl;
  config.agent.apiKey = active.provider.apiKey;
  config.agent.contextWindow = active.model.contextWindow;
  config.agent.maxOutputTokens = active.model.maxOutputTokens;
  if (config.agent.maxInputTokens >= active.model.contextWindow) config.agent.maxInputTokens = 0;
  if (config.agent.historyTokenBudget > active.model.contextWindow) {
    config.agent.historyTokenBudget = active.model.contextWindow;
  }
}

/**
 * 把覆盖项应用到配置对象。就地修改对应段，让已经持有该对象引用的 Runner 与
 * PiAgent 立即看到新值；事件执行器需要自行决定何时重建构造期读取参数的组件。
 */
export function applyRuntimeSettings(config: CorvexConfig, overrides: Record<string, string>): void {
  for (const [key, raw] of Object.entries(overrides)) {
    const definition = definitionsByKey.get(key);
    if (!definition) continue;
    const value = parseSettingValue(definition, raw);
    const target = sectionOf(config, definition.section);
    if (definition.type === "list") {
      target[definition.field] = definition.item === "integer"
        ? (value as string[]).map(Number)
        : value;
    } else if (definition.scale !== undefined && typeof value === "number") {
      target[definition.field] = value * definition.scale;
    } else {
      target[definition.field] = value;
    }
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
      const value = parseSettingValue(definition, row.value);
      const target = sectionOf(config, definition.section);
      // 与 applyRuntimeSettings 保持一致：列表项要转回原生类型，带 scale 的
      // 秒值要换算成毫秒，否则启动/热加载后配置里会留下未换算的值。
      if (definition.type === "list") {
        target[definition.field] = definition.item === "integer"
          ? (value as string[]).map(Number)
          : value;
      } else if (definition.scale !== undefined && typeof value === "number") {
        target[definition.field] = value * definition.scale;
      } else {
        target[definition.field] = value;
      }
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
    const raw = sectionOf(config, definition.section)[definition.field];
    if (definition.type === "list") {
      view[definition.key] = Array.isArray(raw) ? raw.map(String) : [];
    } else if (definition.scale !== undefined && typeof raw === "number") {
      // 配置内部用毫秒，界面按秒展示。
      view[definition.key] = raw / definition.scale;
    } else {
      view[definition.key] = raw as number | boolean | string;
    }
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
