import type { CorvexConfig } from "./config.js";

/**
 * 运维台可在运行时覆盖的模型上下文设置。
 *
 * 这些值影响提示词预算与压缩阈值，改错会直接导致请求失败，因此每个键都带类型与
 * 范围约束；写入前逐项校验，写入后立即作用于后续请求。凭据与网络类配置不在此列，
 * 它们只从配置文件或环境变量读取。
 */
export interface RuntimeSettingDefinition {
  key: string;
  field: keyof CorvexConfig["agent"];
  type: "number" | "boolean";
  min?: number;
  max?: number;
}

export const runtimeSettingDefinitions: readonly RuntimeSettingDefinition[] = [
  { key: "context_window", field: "contextWindow", type: "number", min: 1_024, max: 10_000_000 },
  { key: "max_input_tokens", field: "maxInputTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "history_token_budget", field: "historyTokenBudget", type: "number", min: 0, max: 10_000_000 },
  { key: "turn_tool_result_bytes", field: "turnToolResultBytes", type: "number", min: 0, max: 64 << 20 },
  { key: "compaction_reserve_tokens", field: "compactionReserveTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "compaction_keep_recent_tokens", field: "compactionKeepRecentTokens", type: "number", min: 0, max: 10_000_000 },
  { key: "max_output_tokens", field: "maxOutputTokens", type: "number", min: 1, max: 8_192 },
  { key: "daily_token_budget", field: "dailyTokenBudget", type: "number", min: 0, max: 1_000_000_000 },
  { key: "summary_enabled", field: "summaryEnabled", type: "boolean" },
];

const definitionsByKey = new Map(runtimeSettingDefinitions.map((definition) => [definition.key, definition]));

export interface RuntimeSettingValues {
  [key: string]: number | boolean;
}

/** 把字符串形式的覆盖值解析为对应的数字或布尔值；类型非法时抛错。 */
function parseSettingValue(definition: RuntimeSettingDefinition, raw: string): number | boolean {
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
 * 把覆盖项应用到配置对象。就地修改 `config.agent`，让已经持有该对象引用的
 * Runner 与 PiAgent 立即看到新值。
 */
export function applyRuntimeSettings(config: CorvexConfig, overrides: Record<string, string>): void {
  const values: RuntimeSettingValues = {};
  for (const [key, raw] of Object.entries(overrides)) {
    const definition = definitionsByKey.get(key);
    if (!definition) continue;
    values[key] = parseSettingValue(definition, raw);
  }
  for (const definition of runtimeSettingDefinitions) {
    const value = values[definition.key];
    if (value === undefined) continue;
    (config.agent as Record<string, unknown>)[definition.field] = value;
  }
}

/** 当前生效的设置值，供运维台回显；键与覆盖项一致。 */
export function runtimeSettingsView(agent: CorvexConfig["agent"]): RuntimeSettingValues {
  const view: RuntimeSettingValues = {};
  for (const definition of runtimeSettingDefinitions) {
    view[definition.key] = agent[definition.field] as number | boolean;
  }
  return view;
}

/** 把可编辑字段从源配置复制到目标配置，使删除覆盖项后能立即回退到文件值。 */
export function copyRuntimeSettings(from: CorvexConfig["agent"], to: CorvexConfig["agent"]): void {
  for (const definition of runtimeSettingDefinitions) {
    (to as Record<string, unknown>)[definition.field] = from[definition.field];
  }
}

/** 运维台可覆盖的配置键集合，用于把存储中的覆盖项过滤为已知键。 */
export function isRuntimeSettingKey(key: string): boolean {
  return definitionsByKey.has(key);
}
