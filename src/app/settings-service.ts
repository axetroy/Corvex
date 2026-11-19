import { validateConfig, type CorvexConfig } from "../config/config.js";
import {
  applyActiveModel,
  applyRuntimeSettingRows,
  applyRuntimeSettings,
  copyRuntimeSettings,
  isRuntimeSettingKey,
  runtimeSettingsEffective,
  runtimeSettingsView,
  secretRuntimeSettingKeys,
  validateRuntimeSettings,
  type DerivedContextMetrics,
  type RuntimeSettingValue,
} from "../config/settings.js";
import type { EventStore } from "../events/store.js";
import { errorMessage } from "../errors.js";
import { redactSettingValues, secretSettingPlaceholder } from "./http/respond.js";

/** `GET/PUT /api/ops/settings` 的响应体。 */
export interface SettingsPayload {
  settings: Record<string, RuntimeSettingValue>;
  effective: Record<string, RuntimeSettingValue>;
  adjusted: string[];
  derived: DerivedContextMetrics;
  overrides: Record<string, string>;
  overrideMeta: Record<string, { updatedAt: string; updatedBy: string }>;
  editable: boolean;
  configPath: string | null;
}

/** 保存设置的结果；路由据此决定状态码与响应体。 */
export type SettingsSaveResult =
  | { status: 200; body: SettingsPayload }
  | { status: number; body: { error: string } };

/**
 * 运行时设置的读写。设置以 SQLite 为准，配置文件只在首次启动时提供初始值；
 * Server 启动时重新应用已保存的项，控制台保存时提交全部可编辑键。
 */
export class SettingsService {
  constructor(
    private readonly config: CorvexConfig,
    private readonly store: EventStore,
    /** 启动时的配置快照：写入设置时以它为基准重新计算，避免旧覆盖项残留。 */
    private readonly baseline: CorvexConfig,
    private readonly configPath?: string,
  ) {}

  /**
   * 启动时应用数据库中的设置。界面回显的是当前值与生效值，
   * 如果进程启动时不应用，重启后会出现「显示已保存、实际仍用初始值」的假象。
   */
  applyStored(): void {
    try {
      const migrated = this.store.migrateLegacyModelSettings(
        {
          contextWindow: this.config.agent.contextWindow,
          maxOutputTokens: this.config.agent.maxOutputTokens,
        },
        0,
      );
      if (migrated) {
        console.info("migrated legacy model settings", {
          provider: migrated.provider.name,
          model: migrated.model.name,
        });
      }
      const applied = applyRuntimeSettingRows(this.config, this.store.listRuntimeSettings());
      if (applied.length > 0) {
        console.info("applied stored runtime settings", { keys: applied });
      }
      this.applyActiveModel();
    } catch (error) {
      console.error("apply stored runtime settings failed", { error: errorMessage(error) });
    }
  }

  /** 把当前选中的模型写回内存配置；目录为空时保持配置文件的值。 */
  applyActiveModel(): void {
    const active = this.store.getActiveModel();
    if (active) applyActiveModel(this.config, active);
  }

  /**
   * 读取 Agent 控制台可编辑的设置。这些值以 SQLite 为准，配置文件只在首次启动时
   * 充当初始值；同时返回自动推导后的生效值，界面据此解释「填写的值为何与运行值不同」。
   */
  read(): SettingsPayload {
    const rows = this.store.listRuntimeSettings().filter((row) => isRuntimeSettingKey(row.key));
    const overrides = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const overrideMeta = Object.fromEntries(
      rows.map((row) => [row.key, { updatedAt: row.updatedAt, updatedBy: row.updatedBy }]),
    );
    const view = runtimeSettingsEffective(this.config);
    const redactedOverrides = Object.fromEntries(
      Object.entries(overrides).map(([key, value]) => [
        key,
        secretRuntimeSettingKeys.has(key) ? secretSettingPlaceholder : value,
      ]),
    );
    return {
      settings: redactSettingValues(runtimeSettingsView(this.config)),
      effective: redactSettingValues(view.effective),
      adjusted: view.adjusted,
      derived: view.derived,
      overrides: redactedOverrides,
      overrideMeta,
      // 设置保存在 SQLite，配置文件只提供初始值，因此始终可编辑。
      editable: true,
      configPath: this.configPath ?? null,
    };
  }

  /**
   * 写入运行时设置：先校验，再以启动快照为基准应用全部覆盖项，
   * 用配置的原生校验器验证最终结果。只有校验通过才落库并生效。
   */
  save(incoming: unknown): SettingsSaveResult {
    if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
      return { status: 400, body: { error: "settings must be a JSON object" } };
    }
    const overrides: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
        overrides[key] = String(value);
      } else if (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string" || typeof item === "number")
      ) {
        // 列表设置（域名、路径、用户 ID）以 JSON 数组存库，读回时再按定义解析。
        overrides[key] = JSON.stringify(value);
      } else {
        return {
          status: 400,
          body: { error: `setting "${key}" must be a number, boolean, string or array` },
        };
      }
    }
    // 密钥字段单独处理：留空表示沿用已保存的值，只有明确提交新值才覆盖。
    // 这样界面上不回显原文也不会误清除它。
    if (!("model_api_key" in overrides)) {
      const stored = this.store.listRuntimeSettings().find((row) => row.key === "model_api_key");
      if (stored) overrides.model_api_key = stored.value;
    }
    const problems = validateRuntimeSettings(overrides);
    if (problems.length > 0) {
      return { status: 400, body: { error: problems.join("; ") } };
    }
    // 以启动快照为基准叠加本次覆盖项；未提交的键回到配置文件的初始值。
    const candidate = structuredClone(this.baseline);
    applyRuntimeSettings(candidate, overrides);
    try {
      // 按 Server 角色校验：Server 不调用模型，模型密钥与地址来自供应商目录，
      // 用全量校验会把合法配置误判为缺少密钥，导致任何保存都被拒绝。
      validateConfig(candidate, "server");
    } catch (error) {
      return { status: 400, body: { error: errorMessage(error) } };
    }
    const now = new Date().toISOString();
    const actor = this.config.operations.username.trim() || "ops-console";
    const previousRows = this.store
      .listRuntimeSettings()
      .filter((row) => isRuntimeSettingKey(row.key));
    const previous = new Map(previousRows.map((row) => [row.key, row.value]));
    // 审计只记录真正变化的键：省略表示该键回到配置文件的初始值。
    const changes: Record<string, string> = {};
    for (const key of new Set([...previous.keys(), ...Object.keys(overrides)])) {
      const before = previous.get(key);
      const after = overrides[key];
      if (before === after) continue;
      const secret = secretRuntimeSettingKeys.has(key);
      const describe = (value: string | undefined) => secret
        ? (value ? "[REDACTED]" : "(initial)")
        : value ?? "(initial)";
      changes[key] = `${describe(before)} -> ${describe(after)}`;
    }
    try {
      for (const key of previous.keys()) {
        if (!(key in overrides)) this.store.setRuntimeSetting(key, null, actor);
      }
      for (const [key, value] of Object.entries(overrides)) {
        this.store.setRuntimeSetting(key, value, actor);
      }
    } catch (error) {
      return { status: 500, body: { error: errorMessage(error) } };
    }
    try {
      this.store.recordSettingsAudit(actor, changes);
    } catch (error) {
      // 设置已生效，审计失败不回滚，只记录日志避免掩盖真实结果。
      console.error("record runtime settings audit failed", { error: errorMessage(error) });
    }
    // 内存配置以「配置文件 + 覆盖项」重建：先复位可编辑字段再应用覆盖，避免残留旧值。
    copyRuntimeSettings(candidate, this.config);
    // 模型连接参数由模型目录管理，复位后必须重新应用选中项，否则保存任何设置都会退回文件值。
    this.applyActiveModel();
    console.info("runtime settings updated", { keys: Object.keys(overrides), actor, updatedAt: now });
    return { status: 200, body: this.read() };
  }
}
